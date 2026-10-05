/**
 * `NexaIMClient` — the runtime-agnostic NexaIM WebSocket client.
 *
 * Scope (M4 Task 8):
 *  - connect()  — resolve when `connection.ready` arrives
 *  - disconnect() — close socket, reject all pending requests
 *  - request() — match requestId to the matching response frame
 *  - Event API: on("message" | "error" | "state", handler)
 *  - Optional automatic reconnect (exponential backoff, configurable)
 *
 * Scope (M4 Task 9):
 *  - sendMessage / syncConversation / markRead
 *  - Automatic delivery ack on `message.received` push
 *  - Cross-channel dedupe between `message.received` and sync results
 *
 * Security notes (M4 plan § 7):
 *  - The client never holds the app secret. `tokenProvider` is the
 *    caller's responsibility (Server API HMAC signing is server-side).
 *  - Tokens are stripped from any URL the client logs (M4 plan § 7).
 *  - Pending requests MUST have a timeout so disconnects don't leak
 *    promises.
 */

import {
  clientConversationListResponseSchema,
  clientWsMessageSchema,
  serverWsMessageSchema,
  type ClientWsMessage,
  type ClientConversationListResponse,
  type CompleteMediaUploadRequest,
  type CompleteMediaUploadResponseData,
  type CreateMediaUploadRequest,
  type CreateMediaUploadResponseData,
  type GetMediaDownloadUrlResponseData,
  type MediaKind,
  type MessageReceivedPayload,
  type MessageSendAckPayload,
  type MessageSyncResultPayload,
  type ServerWsMessage,
  type AckPayload
} from "@nexaim/protocol";
import { createRequestId } from "./request-id";
import { createReconnectDelay } from "./reconnect";
import { MessageDedupe } from "./dedupe";
import { NexaIMClientError } from "./errors";
import {
  appendQueryParams,
  buildWebSocketConnectUrl,
  READY_STATE,
  resolveWebSocketCtor,
  type WebSocketCtor,
  type WebSocketLike
} from "./ws-runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export type NexaIMClientReconnectOptions = {
  enabled?: boolean;
  baseMs?: number;
  maxMs?: number;
  maxAttempts?: number;
  factor?: number;
  jitterRatio?: number;
};

export type NexaIMClientOptions = {
  wsBaseUrl: string;
  appId: string;
  userId: string;
  deviceId: string;
  protocolVersion?: "1.0";
  tokenProvider: () => string | Promise<string>;
  WebSocketCtor?: WebSocketCtor;
  reconnect?: NexaIMClientReconnectOptions;
  clientType?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  /**
   * M6：client media helpers（`requestMediaUpload` /
   * `completeMediaUpload` / `getMediaDownloadUrl`）打到 API
   * Service 的 HTTPS base URL，例如 `https://api.example.com`。
   * 不传时三个 helper 抛 `INVALID_INPUT`（plan §5 Task 6 Step 1）。
   * 同 client 跨 ws/http 两套端点 — token provider 共享一份。
   */
  apiBaseUrl?: string;
  /**
   * M6：HTTP 实现注入点。production 用 global `fetch` 即可
   * （Node 18+ / 浏览器原生可用），测试可通过这个注入 vi.fn()。
   * 不传时落到 `globalThis.fetch` —— 注入比 polyfill 简单。
   */
  fetchImpl?: typeof fetch;
};

export type NexaIMClientEventMap = {
  message: ServerWsMessage;
  error: NexaIMClientError;
  state: ConnectionState;
};

export type NexaIMClientEventName = keyof NexaIMClientEventMap;

export type SendMessageInput = {
  recipientUserId: string;
  text: string;
  clientMessageId?: string;
};

export type SendGroupMessageInput = {
  conversationId: string;
  text: string;
  clientMessageId?: string;
};

/**
 * M6：`requestMediaUpload` 入参 —— 与 `createMediaUploadRequestSchema`
 * 字段一一对应（plan §3.1）。`width` / `height` 仅 `kind=image` 时
 * 有意义，但 schema 允许两者都是 `optional()`，SDK 不在这里按 kind
 * 二次约束，直接透传给服务端再校验。
 */
export type RequestMediaUploadInput = {
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width?: number;
  height?: number;
};

/**
 * M6：`sendMediaMessage` 入参 —— discriminated union by
 * `conversationType`。
 *  - direct 分支要 `recipientUserId`（recipient route）。
 *  - group 分支要 `conversationId`（已有 conversation route）。
 *
 * 两侧都强制 `messageType: "image" | "file"`（text 走
 * `sendMessage` / `sendGroupMessage`），并强制
 * `mediaAssetId` —— 这是客户端在 media 消息里的唯一 client-side
 * claim。`caption` 复用了 `receivedMediaContentSchema.caption`
 * (trimmed, min 1, max 1024) 的语义，由服务端在写入 messages
 * 前再 validate。
 */
export type SendMediaMessageInput =
  | {
      conversationType: "direct";
      recipientUserId: string;
      messageType: "image" | "file";
      mediaAssetId: string;
      caption?: string;
      clientMessageId?: string;
    }
  | {
      conversationType: "group";
      conversationId: string;
      messageType: "image" | "file";
      mediaAssetId: string;
      caption?: string;
      clientMessageId?: string;
    };

export type SyncConversationOptions = {
  limit?: number;
};

/**
 * WECHAT-ACCESS-LOGIC-1（contract `WECHAT-ACCESS-1/v1`）：
 * `listConversations` 的入参。只有 `cursor` / `limit` 两个可选字段 ——
 * 身份永远来自 `tokenProvider` 换取的 IM Token，请求不接受任何
 * caller 传入的 userId / tenantId。
 */
export type ListConversationsOptions = {
  /** 不透明游标：原样回传上一次响应的 `page.nextCursor`，不要自己构造。 */
  cursor?: string;
  /** 1..100，默认由服务端按 20 处理；这里显式校验是为了早点失败。 */
  limit?: number;
};

type Listener<E extends NexaIMClientEventName> = (
  value: NexaIMClientEventMap[E]
) => void;

type RequestResolver = {
  resolve: (value: ServerWsMessage) => void;
  reject: (reason: NexaIMClientError) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS_DEFAULT = 10;
const CLIENT_TYPE = "reference-client";
const CLIENT_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Client class
// ---------------------------------------------------------------------------

export class NexaIMClient {
  private readonly options: Required<
    Omit<NexaIMClientOptions, "WebSocketCtor" | "reconnect" | "clientType" | "clientVersion" | "protocolVersion" | "requestTimeoutMs" | "apiBaseUrl" | "fetchImpl">
  > & {
    protocolVersion: "1.0";
    WebSocketCtor: WebSocketCtor;
    reconnect: Required<NexaIMClientReconnectOptions>;
    clientType: string;
    clientVersion: string;
    requestTimeoutMs: number;
    // M6 media HTTP helpers：`apiBaseUrl` 仍允许 undefined —— 调用
    // `requestMediaUpload` 等方法时才在运行时抛 `INVALID_INPUT`。
    // `fetchImpl` 默认落到 global fetch，避免每个 HTTP 调用都
    // 重新解析 global。
    apiBaseUrl: string | undefined;
    /**
     * 可能为 `undefined`：微信等运行时没有 `globalThis.fetch`，必须由
     * 调用方注入（`createWeChatFetch(wx)`）。因此"缺 fetch 实现"是**调用
     * 时**的错误（`INVALID_INPUT`），不是构造时错误。
     */
    fetchImpl: typeof fetch | undefined;
  };

  private socket: WebSocketLike | null = null;
  private state: ConnectionState = "disconnected";
  private readonly pending = new Map<string, RequestResolver>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private readyWaiter: {
    resolve: () => void;
    reject: (reason: NexaIMClientError) => void;
  } | null = null;

  private readonly listeners: {
    [E in NexaIMClientEventName]: Set<Listener<E>>;
  } = {
    message: new Set(),
    error: new Set(),
    state: new Set()
  };

  // Reused across the lifetime of the client so reconnects don't replay
  // already-seen serverMessageIds. Exposed as `dedupe` for advanced
  // callers (e.g. tests + chat-client demo).
  readonly dedupe = new MessageDedupe();

  constructor(options: NexaIMClientOptions) {
    if (!options.wsBaseUrl) {
      throw new NexaIMClientError("wsBaseUrl is required", {
        code: "INVALID_OPTIONS"
      });
    }
    if (!options.appId) {
      throw new NexaIMClientError("appId is required", { code: "INVALID_OPTIONS" });
    }
    if (!options.userId) {
      throw new NexaIMClientError("userId is required", { code: "INVALID_OPTIONS" });
    }
    if (!options.deviceId) {
      throw new NexaIMClientError("deviceId is required", { code: "INVALID_OPTIONS" });
    }
    if (typeof options.tokenProvider !== "function") {
      throw new NexaIMClientError("tokenProvider must be a function", {
        code: "INVALID_OPTIONS"
      });
    }

    const reconnectOptions = options.reconnect ?? {};
    this.options = {
      wsBaseUrl: options.wsBaseUrl,
      appId: options.appId,
      userId: options.userId,
      deviceId: options.deviceId,
      protocolVersion: options.protocolVersion ?? "1.0",
      tokenProvider: options.tokenProvider,
      WebSocketCtor: resolveWebSocketCtor(options.WebSocketCtor),
      reconnect: {
        enabled: reconnectOptions.enabled ?? false,
        baseMs: reconnectOptions.baseMs ?? 500,
        maxMs: reconnectOptions.maxMs ?? 10_000,
        maxAttempts: reconnectOptions.maxAttempts ?? RECONNECT_MAX_ATTEMPTS_DEFAULT,
        factor: reconnectOptions.factor ?? 2,
        jitterRatio: reconnectOptions.jitterRatio ?? 0.2
      },
      clientType: options.clientType ?? CLIENT_TYPE,
      clientVersion: options.clientVersion ?? CLIENT_VERSION,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      // M6：保留 `apiBaseUrl` 为 undefined 以支持"未配就抛
      // INVALID_INPUT"，`fetchImpl` 默认落到 global fetch（生产
      // 环境 Node 18+ / 浏览器都自带；测试通过 options 注入）。
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl ?? globalThis.fetch
    };
  }

  // -------------------------------------------------------------------------
  // Public API: events
  // -------------------------------------------------------------------------

  on<E extends NexaIMClientEventName>(
    event: E,
    listener: Listener<E>
  ): () => void {
    const set = this.listeners[event] as unknown as Set<Listener<E>>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit<E extends NexaIMClientEventName>(
    event: E,
    value: NexaIMClientEventMap[E]
  ): void {
    const set = this.listeners[event] as unknown as Set<Listener<E>>;
    for (const listener of set) {
      try {
        listener(value);
      } catch {
        // listener errors must not break the client; surface via
        // `error` event instead, but only if it's not already an
        // error event to avoid infinite loops.
        if (event !== "error") {
          this.emitError(
            new NexaIMClientError("listener threw", {
              code: "LISTENER_ERROR",
              cause: value
            })
          );
        }
      }
    }
  }

  private emitError(error: NexaIMClientError): void {
    this.emit("error", error);
  }

  // -------------------------------------------------------------------------
  // Public API: connection
  // -------------------------------------------------------------------------

  /**
   * Open the WebSocket connection. Resolves once the server confirms
   * the session with a `connection.ready` frame. Rejects on socket
   * error / close before ready.
   */
  async connect(): Promise<void> {
    if (this.state === "connected") {
      return;
    }
    if (this.state === "connecting" || this.state === "reconnecting") {
      return new Promise<void>((resolve, reject) => {
        const onState: Listener<"state"> = (next) => {
          if (next === "connected") {
            this.listeners.state.delete(onState);
            resolve();
          } else if (next === "disconnected") {
            this.listeners.state.delete(onState);
            reject(
              new NexaIMClientError("connect failed", { code: "CONNECT_FAILED" })
            );
          }
        };
        this.listeners.state.add(onState);
      });
    }

    this.intentionalClose = false;
    return this.attemptConnect();
  }

  /**
   * Close the WebSocket and reject all pending requests with a
   * `DISCONNECTED` error. Reconnect attempts are cancelled.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.teardownSocket(new NexaIMClientError("client disconnected", {
      code: "DISCONNECTED"
    }));
  }

  /**
   * Send a `ClientWsMessage` and resolve with the matching
   * server response frame.
   */
  async request(input: ClientWsMessage): Promise<ServerWsMessage> {
    if (this.state !== "connected" || !this.socket) {
      throw new NexaIMClientError("not connected", { code: "NOT_CONNECTED" });
    }

    const parsed = clientWsMessageSchema.parse(input);
    const requestId = parsed.requestId;

    return new Promise<ServerWsMessage>((resolve, reject) => {
      const timer =
        this.options.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(requestId);
              reject(
                new NexaIMClientError(
                  `request ${requestId} timed out after ${this.options.requestTimeoutMs}ms`,
                  { code: "REQUEST_TIMEOUT" }
                )
              );
            }, this.options.requestTimeoutMs)
          : null;

      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify(parsed));
      } catch (err) {
        this.pending.delete(requestId);
        if (timer) clearTimeout(timer);
        reject(
          new NexaIMClientError("failed to send request", {
            code: "SEND_FAILED",
            cause: err
          })
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Public API: high-level message operations (M4 Task 9)
  // -------------------------------------------------------------------------

  /**
   * Send a direct text message. Auto-generates a `clientMessageId`
   * when the caller doesn't supply one (used as the de-dup key on
   * retry). Returns the server-issued `message.send_ack.payload`
   * (the `serverMessageId` is what subsequent delivery/read acks
   * reference).
   */
  async sendMessage(input: SendMessageInput): Promise<MessageSendAckPayload> {
    if (!input.recipientUserId) {
      throw new NexaIMClientError("recipientUserId is required", {
        code: "INVALID_INPUT"
      });
    }
    if (!input.text) {
      throw new NexaIMClientError("text is required", { code: "INVALID_INPUT" });
    }

    const result = await this.request({
      requestId: createRequestId("send"),
      type: "message.send",
      payload: {
        conversationType: "direct",
        recipientUserId: input.recipientUserId,
        clientMessageId: input.clientMessageId ?? createRequestId("msg"),
        messageType: "text",
        content: { text: input.text }
      }
    });
    if (result.type !== "message.send_ack") {
      throw new NexaIMClientError(
        `expected message.send_ack, got ${result.type}`,
        { code: "UNEXPECTED_RESPONSE" }
      );
    }
    return result.payload;
  }

  /**
   * Send a text message to an existing group conversation. Auto-generates
   * a `clientMessageId` when the caller doesn't supply one (used as the
   * de-dup key on retry). Returns the `message.send_ack` payload.
   *
   * The Gateway requires `conversationType="group"` + `conversationId`
   * routing; see `packages/protocol/src/ws.ts:148-156`. Group
   * `message.received` push and `syncConversation` reuse existing
   * handlers — no extra wiring needed here.
   */
  async sendGroupMessage(
    input: SendGroupMessageInput
  ): Promise<MessageSendAckPayload> {
    if (!input.conversationId) {
      throw new NexaIMClientError("conversationId is required", {
        code: "INVALID_INPUT"
      });
    }
    if (!input.text) {
      throw new NexaIMClientError("text is required", {
        code: "INVALID_INPUT"
      });
    }

    const result = await this.request({
      requestId: createRequestId("send"),
      type: "message.send",
      payload: {
        conversationType: "group",
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId ?? createRequestId("msg"),
        messageType: "text",
        content: { text: input.text }
      }
    });
    if (result.type !== "message.send_ack") {
      throw new NexaIMClientError(
        `expected message.send_ack, got ${result.type}`,
        { code: "UNEXPECTED_RESPONSE" }
      );
    }
    return result.payload;
  }

  // -------------------------------------------------------------------------
  // Public API: M6 media helpers (M6 plan §5 Task 6)
  //
  // 与上面的 ws-based sendMessage / sendGroupMessage 不同，media
  // helpers 走 API Service 的 HTTPS HTTP endpoints，需要在
  // constructor 里配 `apiBaseUrl`。token 通过同一个 `tokenProvider`
  // 注入（M3 IM Token HTTP 鉴权带 `Authorization: Bearer <imToken>`，
  // 见 `apps/api-service/src/modules/client-auth/index.ts`）。
  //
  // design 关键点：
  //  - `apiBaseUrl` 缺失即抛 `INVALID_INPUT` —— 防止 SDK 调用方
  //    误以为该功能能用，但实际不会发请求。
  //  - 错误响应从 `errorResponse` envelope 解析 `code` + `message`，
  //    抛 `NexaIMClientError`，让上层能按业务码 retry；非 2xx 但
  //    body 解析失败时降级到通用 `MEDIA_HTTP_ERROR`，保留 status。
  //  - fetch impl 默认 `globalThis.fetch`（Node 18+ / 浏览器原生），
  //    测试可在 constructor 里注入 mock（`NexaIMClient.test.ts`）。
  // -------------------------------------------------------------------------

  /**
   * `POST /api/client/apps/:appId/media/uploads`。Mint 一个 presigned
   * PUT URL，让 caller 把 binary 上传到 S3/MinIO。返回 asset row +
   * 上传指令；SDK 不自动 PUT —— 上传本身由 caller 用任意 HTTP
   * client 完成（浏览器 `fetch(upload.url, { method: "PUT", body })`，
   * Node 用同一 `fetch` 即可）。
   */
  async requestMediaUpload(
    input: RequestMediaUploadInput
  ): Promise<CreateMediaUploadResponseData> {
    return this.mediaHttp<CreateMediaUploadResponseData>(
      "POST",
      "/uploads",
      input satisfies CreateMediaUploadRequest
    );
  }

  /**
   * `POST /api/client/apps/:appId/media/:mediaAssetId/complete`。
   * 通知 server HeadObject 已对齐，让 `media_assets.status` 从
   * `pending` 翻到 `uploaded`。`input.sha256` 可选 —— server 把它
   * 当作 echo 与 row.sha256 对齐做防回放（route 层 `routes.ts`
   * 的"可选 echo"分支），不传只靠 HeadObject 校 `x-amz-meta-sha256`。
   */
  async completeMediaUpload(
    mediaAssetId: string,
    input: CompleteMediaUploadRequest = {}
  ): Promise<CompleteMediaUploadResponseData> {
    if (!mediaAssetId) {
      throw new NexaIMClientError("mediaAssetId is required", {
        code: "INVALID_INPUT"
      });
    }
    return this.mediaHttp<CompleteMediaUploadResponseData>(
      "POST",
      `/${encodeURIComponent(mediaAssetId)}/complete`,
      input
    );
  }

  /**
   * `GET /api/client/apps/:appId/media/:mediaAssetId/download-url`。
   * 返回短 TTL presigned GET URL（route 层 `downloadUrlTtlSeconds`，
   * 默认 5 分钟）；caller 应当即用即取。S3-side 鉴权由 route 处理，
   * 不暴露给客户端 access key。
   */
  async getMediaDownloadUrl(
    mediaAssetId: string
  ): Promise<GetMediaDownloadUrlResponseData> {
    if (!mediaAssetId) {
      throw new NexaIMClientError("mediaAssetId is required", {
        code: "INVALID_INPUT"
      });
    }
    return this.mediaHttp<GetMediaDownloadUrlResponseData>(
      "GET",
      `/${encodeURIComponent(mediaAssetId)}/download-url`
    );
  }

  /**
   * Send a media message (`image` or `file`) over the established
   * WebSocket. Discriminated union on `conversationType`：direct
   * 分支要 `recipientUserId`，group 分支要 `conversationId`。payload
   * 由服务端在 `message.send` handler 里用
   * `findMediaAssetForSend` 反查 `media_assets` 行组装 canonical
   * content（client 只 claim `mediaAssetId` + 可选 `caption`，不
   * 走私 `fileName` / `sizeBytes` / `sha256` 之类服务端权威字段，
   * 见 `sendMediaContentSchema.strict()`）。
   */
  async sendMediaMessage(
    input: SendMediaMessageInput
  ): Promise<MessageSendAckPayload> {
    if (!input.mediaAssetId) {
      throw new NexaIMClientError("mediaAssetId is required", {
        code: "INVALID_INPUT"
      });
    }
    // 分支必填字段校验 —— 与 `sendMessage` / `sendGroupMessage` 同款
    // 提前抛 `INVALID_INPUT` 风格。如果只校验 `mediaAssetId` 就把
    // 空 `recipientUserId` / `conversationId` 透传给底层
    // `clientWsMessageSchema.parse()`，它会抛原始 `ZodError`，
    // 与 SDK 现有错误风格不一致（caller 期望 `INVALID_INPUT`）。
    if (input.conversationType === "direct" && !input.recipientUserId) {
      throw new NexaIMClientError("recipientUserId is required", {
        code: "INVALID_INPUT"
      });
    }
    if (input.conversationType === "group" && !input.conversationId) {
      throw new NexaIMClientError("conversationId is required", {
        code: "INVALID_INPUT"
      });
    }

    // 构造 payload —— discriminated union 让 TypeScript 在两侧分支
    // 各推出完整的字段集。`content` 只携带 `mediaAssetId` +
    // `caption`，服务端会追加服务端权威字段（`fileName` /
    // `mimeType` / `sizeBytes` / `sha256` / `width` / `height`）
    // 写入 messages.content，参考
    // `apps/websocket-gateway/src/messages/send-direct.ts`
    // `buildMediaCanonicalContent` 调用点。
    const messageContent: { mediaAssetId: string; caption?: string } = {
      mediaAssetId: input.mediaAssetId
    };
    if (input.caption !== undefined) {
      messageContent.caption = input.caption;
    }

    const requestPayload =
      input.conversationType === "direct"
        ? {
            conversationType: "direct" as const,
            recipientUserId: input.recipientUserId,
            clientMessageId: input.clientMessageId ?? createRequestId("msg"),
            messageType: input.messageType,
            content: messageContent
          }
        : {
            conversationType: "group" as const,
            conversationId: input.conversationId,
            clientMessageId: input.clientMessageId ?? createRequestId("msg"),
            messageType: input.messageType,
            content: messageContent
          };

    const result = await this.request({
      requestId: createRequestId("send"),
      type: "message.send",
      payload: requestPayload
    });
    if (result.type !== "message.send_ack") {
      throw new NexaIMClientError(
        `expected message.send_ack, got ${result.type}`,
        { code: "UNEXPECTED_RESPONSE" }
      );
    }
    return result.payload;
  }

  // -------------------------------------------------------------------------
  // WECHAT-ACCESS-LOGIC-1: Client 会话列表（GET /api/client/apps/:appId/conversations）
  // -------------------------------------------------------------------------

  /**
   * 列出**我参与的** direct 会话（含最近消息、服务端已读游标与准确未读
   * 数）。这是冷启动 / 离线期间新建会话的发现入口：客户端不需要事先知道
   * conversationId 就能拿到列表，再对每条会话从 `afterSeq = 0` 开始
   * `syncConversation` 补历史。
   *
   * 返回**完整 envelope**（`{ requestId, data, page }`），与 media helper
   * 只返回 `data` 不同 —— 分页策略（何时拉下一页、怎么按 conversationId
   * 合并）由调用方决定。
   *
   * 注意：这个调用是**纯读** —— 不发 delivery ack、不发 read_ack、
   * 不动本地消息去重集合、不推进 sync 游标。
   */
  async listConversations(
    options: ListConversationsOptions = {}
  ): Promise<ClientConversationListResponse> {
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > 100)
    ) {
      throw new NexaIMClientError(
        "limit must be an integer between 1 and 100",
        { code: "INVALID_INPUT" }
      );
    }
    if (options.cursor !== undefined && options.cursor.length === 0) {
      throw new NexaIMClientError("cursor must be a non-empty string", {
        code: "INVALID_INPUT"
      });
    }

    // trim trailing slashes on base —— 否则 `https://api.example/` 会拼出
    // `//api/client/...`（双斜杠），Fastify 默认路由匹配下直接 404。
    // 部署路径前缀（`https://api.example.com/gateway/`）保持不变。
    const base = this.requireApiBaseUrl("listConversations").replace(/\/+$/, "");
    const url = appendQueryParams(
      `${base}/api/client/apps/${this.options.appId}/conversations`,
      { limit: options.limit?.toString(), cursor: options.cursor }
    );

    const response = await this.callFetch(url, "listConversations", {
      transportErrorCode: "CONVERSATIONS_HTTP_ERROR"
    });
    if (!response.ok) {
      throw await this.toHttpError(response, "listConversations");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new NexaIMClientError(
        "conversations response is not valid JSON",
        { code: "INVALID_SERVER_RESPONSE", cause: err }
      );
    }

    const parsed = clientConversationListResponseSchema.safeParse(body);
    if (!parsed.success) {
      // 畸形成功响应（缺 page / item 多余字段 / 内部 id 泄漏）不能当作
      // 可用数据返回 —— 调用方会照着渲染出一个错误的会话列表。
      throw new NexaIMClientError("conversations response shape is invalid", {
        code: "INVALID_SERVER_RESPONSE",
        details: parsed.error.issues
      });
    }
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // M6 media HTTP transport helper
  // -------------------------------------------------------------------------

  /**
   * 私有 transport：所有 media HTTP helper 都走这里。
   *
   * 串起：apiBaseUrl 校验 → token 拉取 → URL 拼接 → fetch → 解析
   * `{ requestId, data }` envelope → 出错时按 server `error.code`
   * 抛 `NexaIMClientError`。
   *
   * `path` 是相对路径（开头是 `/`），函数负责拼出 M6 client media
   * scope：`{apiBaseUrl}/api/client/apps/{appId}/media{path}`。例如
   *   `path = "/uploads"` → `/api/client/apps/{appId}/media/uploads`
   *   `path = "/{id}/complete"` → `/api/client/apps/{appId}/media/{id}/complete`
   * `body` 是任意 JSON-serializable 对象，传 undefined 时不发 body（GET
   * 路径）。
   */
  private async mediaHttp<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    // trim trailing slash on base, ensure leading slash on path —— 避免
    // base 带 `/` 与 path 不带 `/` 时拼出 `host//uploads` 之类。
    const base = this.requireApiBaseUrl("media HTTP helpers").replace(
      /\/+$/,
      ""
    );
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${base}/api/client/apps/${this.options.appId}/media${normalizedPath}`;

    const response = await this.callFetch(url, path, {
      method,
      body,
      transportErrorCode: "MEDIA_HTTP_ERROR"
    });
    if (!response.ok) {
      throw await this.toHttpError(
        response,
        `media HTTP ${method} ${path} failed with status ${response.status}`,
        "MEDIA_HTTP_ERROR"
      );
    }

    const envelope = (await response.json()) as { data: T };
    return envelope.data;
  }

  /**
   * 取出 `apiBaseUrl`，缺失时抛 `INVALID_INPUT` —— 防止 SDK 调用方误以为
   * HTTP 功能能用，实际却不会发请求。
   */
  private requireApiBaseUrl(feature: string): string {
    if (!this.options.apiBaseUrl) {
      throw new NexaIMClientError(`apiBaseUrl is required for ${feature}`, {
        code: "INVALID_INPUT"
      });
    }
    return this.options.apiBaseUrl;
  }

  /**
   * 所有 HTTP helper 的统一出口：解析 fetch 实现 → 拉 token → 带
   * `Authorization: Bearer` 发请求 → 把 transport 异常包成
   * `NexaIMClientError`。
   *
   * `fetchImpl` 缺失（例如微信运行时没有 `globalThis.fetch` 又没注入
   * `createWeChatFetch(wx)`）时抛 `INVALID_INPUT`，错误信息直接告诉调用方
   * 该注入什么。
   */
  private async callFetch(
    url: string,
    feature: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      transportErrorCode: string;
    }
  ): Promise<Response> {
    const method = options.method ?? "GET";
    const body = options.body;
    const fetchImpl = this.options.fetchImpl;
    if (typeof fetchImpl !== "function") {
      throw new NexaIMClientError(
        `fetchImpl is required for ${feature} in runtimes without global fetch (e.g. pass createWeChatFetch(wx))`,
        { code: "INVALID_INPUT" }
      );
    }

    const token = await this.options.tokenProvider();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`
    };
    // GET 请求不应该带 Content-Type（fetch 不会自动加），但 body
    // 存在时 JSON 序列化必须声明。
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    try {
      return await fetchImpl(url, init);
    } catch (err) {
      // fetch 适配器（`createWeChatFetch`）已经把网络失败 / 超时 / 主动
      // abort 映射成语义化 code —— 不要用通用码盖掉调用方需要的区分。
      if (err instanceof NexaIMClientError) {
        throw err;
      }
      throw new NexaIMClientError(`${feature} transport failed`, {
        code: options.transportErrorCode,
        cause: err
      });
    }
  }

  /**
   * 非 2xx → `NexaIMClientError`。优先从 `{ requestId, error: { code,
   * message } }` envelope 取业务码（调用方可以按 `AUTH_TOKEN_INVALID`
   * 之类做重登录），body 不是 JSON 时退回 `fallbackCode` + status 信息。
   */
  private async toHttpError(
    response: Response,
    fallbackMessage: string,
    fallbackCode = "CONVERSATIONS_HTTP_ERROR"
  ): Promise<NexaIMClientError> {
    let errorCode = fallbackCode;
    let errorMessage = fallbackMessage;
    try {
      const errorBody = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (
        errorBody &&
        typeof errorBody === "object" &&
        errorBody.error &&
        typeof errorBody.error.code === "string"
      ) {
        errorCode = errorBody.error.code;
        if (typeof errorBody.error.message === "string") {
          errorMessage = errorBody.error.message;
        }
      }
    } catch {
      // body 不是 JSON 或解析失败 —— 保留默认码，调用方只能
      // 看到 status 而定到通用错误。
    }
    return new NexaIMClientError(errorMessage, { code: errorCode });
  }

  /**
   * Pull messages with `conversationSeq > afterSeq` for the given
   * conversation. Each item that has not been seen before is
   * re-emitted on the `message` event (synthesized as a
   * `message.received` payload) and an automatic `message.delivery_ack`
   * is sent. Returns the raw sync result payload so the caller can
   * advance its cursor.
   */
  async syncConversation(
    conversationId: string,
    afterSeq: number,
    options: SyncConversationOptions = {}
  ): Promise<MessageSyncResultPayload> {
    if (!conversationId) {
      throw new NexaIMClientError("conversationId is required", {
        code: "INVALID_INPUT"
      });
    }
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new NexaIMClientError("afterSeq must be a non-negative integer", {
        code: "INVALID_INPUT"
      });
    }

    const requestPayload: {
      conversationId: string;
      afterSeq: number;
      limit?: number;
    } = { conversationId, afterSeq };
    if (options.limit !== undefined) {
      requestPayload.limit = options.limit;
    }

    const result = await this.request({
      requestId: createRequestId("sync"),
      type: "message.sync",
      payload: requestPayload
    });
    if (result.type !== "message.sync_result") {
      throw new NexaIMClientError(
        `expected message.sync_result, got ${result.type}`,
        { code: "UNEXPECTED_RESPONSE" }
      );
    }

    for (const item of result.payload.items) {
      if (this.dedupe.seen(item.serverMessageId)) {
        continue;
      }
      // M6 起 `MessageReceivedPayload` 是按 `messageType` 区分的
      // discriminated union —— 这里分支一下，让 union 的 `text` /
      // `image|file` 形状与线上 item 匹配。emit wrapper 还需要
      // `conversationId`（由 `messageSyncResultPayloadSchema` 携带，
      // 不在 item 自身上）。
      if (item.messageType === "text") {
        this.emitReceived({
          conversationId,
          serverMessageId: item.serverMessageId,
          senderUserId: item.senderUserId,
          conversationSeq: item.conversationSeq,
          messageType: "text",
          content: item.content,
          createdAt: item.createdAt
        });
      } else {
        this.emitReceived({
          conversationId,
          serverMessageId: item.serverMessageId,
          senderUserId: item.senderUserId,
          conversationSeq: item.conversationSeq,
          messageType: item.messageType,
          content: item.content,
          createdAt: item.createdAt
        });
      }
      void this.sendDeliveryAck(item.serverMessageId).catch((err) => {
        this.emitError(
          err instanceof NexaIMClientError
            ? err
            : new NexaIMClientError("auto delivery ack failed", {
                code: "AUTO_DELIVERY_ACK_FAILED",
                cause: err
              })
        );
      });
    }

    return result.payload;
  }

  /**
   * Advance the per-conversation read cursor. The Gateway updates
   * `conversation_members.last_read_seq` and flips pending receipts
   * (M4 plan § 3.2). Returns the `ack` payload (`message.read_ack`).
   */
  async markRead(
    conversationId: string,
    readSeq: number
  ): Promise<Extract<AckPayload, { ackType: "message.read_ack" }>> {
    if (!conversationId) {
      throw new NexaIMClientError("conversationId is required", {
        code: "INVALID_INPUT"
      });
    }
    if (!Number.isInteger(readSeq) || readSeq < 0) {
      throw new NexaIMClientError("readSeq must be a non-negative integer", {
        code: "INVALID_INPUT"
      });
    }

    const result = await this.request({
      requestId: createRequestId("read"),
      type: "message.read_ack",
      payload: { conversationId, readSeq }
    });
    if (result.type !== "ack") {
      throw new NexaIMClientError(
        `expected ack, got ${result.type}`,
        { code: "UNEXPECTED_RESPONSE" }
      );
    }
    if (result.payload.ackType !== "message.read_ack") {
      throw new NexaIMClientError(
        `expected message.read_ack, got ${result.payload.ackType}`,
        { code: "UNEXPECTED_RESPONSE" }
      );
    }
    return result.payload;
  }

  // -------------------------------------------------------------------------
  // Public API: introspection
  // -------------------------------------------------------------------------

  getState(): ConnectionState {
    return this.state;
  }

  getPendingRequestCount(): number {
    return this.pending.size;
  }

  // -------------------------------------------------------------------------
  // Connect internals
  // -------------------------------------------------------------------------

  private async attemptConnect(): Promise<void> {
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    let token: string;
    try {
      token = await this.options.tokenProvider();
    } catch (err) {
      this.setState("disconnected");
      const error = new NexaIMClientError("tokenProvider rejected", {
        code: "TOKEN_PROVIDER_FAILED",
        cause: err
      });
      this.emitError(error);
      throw error;
    }

    if (this.intentionalClose) {
      this.setState("disconnected");
      throw new NexaIMClientError("connect aborted by disconnect", {
        code: "DISCONNECTED"
      });
    }

    const url = buildWebSocketConnectUrl({
      wsBaseUrl: this.options.wsBaseUrl,
      appId: this.options.appId,
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      token,
      protocolVersion: this.options.protocolVersion,
      clientType: this.options.clientType,
      clientVersion: this.options.clientVersion
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });

    let socket: WebSocketLike;
    try {
      socket = new this.options.WebSocketCtor(url);
    } catch (err) {
      this.readyWaiter = null;
      this.setState("disconnected");
      const error = new NexaIMClientError("WebSocket constructor threw", {
        code: "SOCKET_CONSTRUCTOR_FAILED",
        cause: err
      });
      this.emitError(error);
      throw error;
    }

    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => this.handleSocketError();
    socket.onclose = (event) => this.handleClose(event);

    return readyPromise;
  }

  private handleOpen(): void {
    // The WebSocket `open` event fires before the server has confirmed
    // the session. We hold the `connected` state transition until
    // `connection.ready` arrives so request() callers can't fire
    // messages the server hasn't authenticated yet.
  }

  private handleMessage(event: { data: unknown }): void {
    if (typeof event.data !== "string") {
      this.emitError(
        new NexaIMClientError("unsupported frame type (only text JSON)", {
          code: "UNSUPPORTED_FRAME"
        })
      );
      return;
    }
    let parsed: ServerWsMessage;
    try {
      parsed = serverWsMessageSchema.parse(JSON.parse(event.data));
    } catch (err) {
      this.emitError(
        new NexaIMClientError("failed to parse server frame", {
          code: "INVALID_SERVER_FRAME",
          cause: err
        })
      );
      return;
    }

    if (parsed.type === "connection.ready") {
      if (this.readyWaiter) {
        const waiter = this.readyWaiter;
        this.readyWaiter = null;
        this.setState("connected");
        this.reconnectAttempt = 0;
        waiter.resolve();
      }
      this.emit("message", parsed);
      return;
    }

    if (parsed.type === "error") {
      // M#3 review fix：业务错误 frame（M3 plan §5.1 + M6 plan §3.3
      // Medium #3）现在带 optional `requestId` —— server 把它当作某个
      // 具体 client 请求的失败响应发回，让 SDK reject 对应 pending
      // promise 而不是 timeout 到 `requestTimeoutMs`。没有 requestId
      // 的错误 frame 是 server-initiated 推送（rate limit、auth
      // failure、connection setup error 等），保持原有 `on("error")`
      // 事件风格，不 reject 任何 pending request。
      const errorInstance = new NexaIMClientError(parsed.payload.message, {
        code: parsed.payload.code,
        details: parsed.payload.details
      });
      if (typeof parsed.requestId === "string" && parsed.requestId.length > 0) {
        const resolver = this.pending.get(parsed.requestId);
        if (resolver) {
          this.pending.delete(parsed.requestId);
          if (resolver.timer) clearTimeout(resolver.timer);
          resolver.reject(errorInstance);
          // 仍 emit message event —— caller 可能想观察业务错误
          // 走线（比如 analytics），但不重复 emit error 事件避免
          // 重复日志。
          this.emit("message", parsed);
          return;
        }
        // requestId 存在但 pending map 里找不到 —— 可能因为：
        //  (a) 这个 request 已经被 timeout / disconnect 清理掉
        //  (b) client 用了 server 不识别的 requestId（不应该发生）
        //  两种情况都当作 server-initiated 推送走 on("error")
        //  路径，caller 能拿到错误码做后续处理。
      }
      this.emitError(errorInstance);
      this.emit("message", parsed);
      return;
    }

    // Live `message.received` push: dedupe against anything already
    // surfaced by `syncConversation`. First sighting emits a
    // `message` event AND auto-acks delivery.
    if (parsed.type === "message.received") {
      if (this.dedupe.seen(parsed.payload.serverMessageId)) {
        return;
      }
      this.emit("message", parsed);
      void this.sendDeliveryAck(parsed.payload.serverMessageId).catch(
        (err) => {
          this.emitError(
            err instanceof NexaIMClientError
              ? err
              : new NexaIMClientError("auto delivery ack failed", {
                  code: "AUTO_DELIVERY_ACK_FAILED",
                  cause: err
                })
          );
        }
      );
      return;
    }

    // Request/response: must carry requestId.
    if (
      "requestId" in parsed &&
      typeof parsed.requestId === "string" &&
      parsed.requestId.length > 0
    ) {
      const resolver = this.pending.get(parsed.requestId);
      if (resolver) {
        this.pending.delete(parsed.requestId);
        if (resolver.timer) clearTimeout(resolver.timer);
        resolver.resolve(parsed);
        return;
      }
    }

    this.emit("message", parsed);
  }

  private handleSocketError(): void {
    this.emitError(
      new NexaIMClientError("WebSocket error event", { code: "SOCKET_ERROR" })
    );
  }

  private handleClose(event: { code: number; reason: string }): void {
    const reason = `socket closed code=${event.code} reason=${event.reason || ""}`;
    const error = new NexaIMClientError(reason, {
      code: "SOCKET_CLOSED",
      details: { code: event.code, reason: event.reason }
    });
    this.teardownSocket(error);
  }

  private teardownSocket(reason: NexaIMClientError): void {
    // Reject pending requests + ready waiter BEFORE closing the socket
    // so the rejection carries the original `reason` (e.g. "client
    // disconnected" with code DISCONNECTED) rather than the
    // synthetic "socket closed code=1000" error that would be built
    // by `handleClose` when the socket's `onclose` fires synchronously
    // from inside `socket.close()`.
    if (this.readyWaiter) {
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      waiter.reject(reason);
    }

    for (const [requestId, resolver] of this.pending) {
      if (resolver.timer) clearTimeout(resolver.timer);
      resolver.reject(reason);
      this.pending.delete(requestId);
    }

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== READY_STATE.CLOSED) {
      try {
        socket.close(1000, "client teardown");
      } catch {
        // best-effort
      }
    }

    const wasConnected = this.state === "connected";
    this.setState("disconnected");

    if (
      !this.intentionalClose &&
      wasConnected &&
      this.options.reconnect.enabled
    ) {
      this.scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.options.reconnect.enabled) return;
    if (this.reconnectAttempt >= this.options.reconnect.maxAttempts) {
      this.emitError(
        new NexaIMClientError(
          `reconnect attempts exhausted (max=${this.options.reconnect.maxAttempts})`,
          { code: "RECONNECT_EXHAUSTED" }
        )
      );
      return;
    }
    const delay = createReconnectDelay(this.reconnectAttempt, {
      baseMs: this.options.reconnect.baseMs,
      maxMs: this.options.reconnect.maxMs,
      factor: this.options.reconnect.factor,
      jitterRatio: this.options.reconnect.jitterRatio
    });
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptConnect().catch(() => {
        // attemptConnect already emits an error event and resets
        // state on failure; nothing more to do here.
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Auto delivery ack
  // -------------------------------------------------------------------------

  private async sendDeliveryAck(serverMessageId: string): Promise<void> {
    await this.request({
      requestId: createRequestId("dack"),
      type: "message.delivery_ack",
      payload: { serverMessageId }
    });
  }

  private emitReceived(payload: MessageReceivedPayload): void {
    this.emit("message", {
      type: "message.received",
      payload
    } as ServerWsMessage);
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);
  }
}
