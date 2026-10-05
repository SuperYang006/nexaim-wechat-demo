/**
 * WebSocket protocol Zod schemas for M3 + M4 + M6.
 *
 * Scope: `/ws` connect query, client→server messages
 * (request/response), server→client messages (server push + response
 * acknowledgements), and the unified error envelope.
 *
 * M4 additions (see `docs/milestones/M4-增量同步与ReferenceClient开发计划.md` §3):
 * - `message.sync` client→server action + `message.sync_result`
 *   server→client response (incremental sync after reconnect).
 * - `message.read_ack` client→server action + unified `ack` frame
 *   widening `ackType` to a discriminated union of
 *   `message.delivery_ack` | `message.read_ack`.
 * - `messageSyncResultItemSchema.senderUserId` is the business-side
 *   EXTERNAL userId (`im_users.external_user_id`), NOT the internal
 *   `im_users.id` UUID. The repository layer is responsible for the
 *   internal→external mapping before returning rows; the schema is
 *   `.strict()` to prevent accidental leakage of internal IDs.
 *
 * M6 新增内容（参见 `docs/milestones/M6-Media与对象存储开发计划.md` §3.2）：
 * - `messageTypeSchema` 从 `z.literal("text")` 拓宽为
 *   `z.enum(["text", "image", "file"])`。
 * - 发送端 `content` 是按 `messageType` 区分的 discriminated union：
 *   - `text`  → `directTextContentSchema`（M3/M5 既有形状不变）。
 *   - `image` / `file` → `sendMediaContentSchema`，只携带
 *     `mediaAssetId` + 可选 `caption`。Gateway 会忽略客户端可能
 *     塞进来的其他 media 元数据，从 DB 行重建 canonical content。
 * - 接收 / 同步端携带 *canonical* media content
 *   （`receivedMediaContentSchema`）：`mediaAssetId` + `fileName` +
 *   `mimeType` + `sizeBytes` + `sha256` + 可选 `width` / `height` /
 *   `caption`。**不**带 download URL（M6 plan §1 + §2.6：download
 *   走短 TTL 的 presigned GET）。
 *
 * Conventions (mirror M3 plan § 3.2 + § 7; M4 plan § 3):
 * - Server push messages (`connection.ready`, `message.received`,
 *   `error`) DO NOT carry `requestId`. Request/response messages
 *   (`message.send_ack`, `message.sync_result`, `ack`) MUST carry
 *   `requestId` and echo the client-provided value.
 * - `ackPayloadSchema.ackType` is now a discriminated union;
 *   server emits exactly one variant per request.
 * - All timestamps are ISO 8601 UTC strings.
 * - Field names use `camelCase`; DB columns stay `snake_case`
 *   (Drizzle maps the conversion at the repository boundary).
 */

import { z } from "zod";
import {
  clientMessageIdSchema,
  externalUserIdSchema,
  uuidStringSchema
} from "./ids";
import { errorCodes, type ErrorCode } from "./errors";
import { protocolVersionSchema } from "./server";

// ---------------------------------------------------------------------------
// Shared scalar schemas
// ---------------------------------------------------------------------------

/**
 * 客户端发的 requestId 字段统一约束 —— 用在 client→server frames、
 * server→client request/response frames（`message.send_ack` /
 * `message.sync_result` / `ack`）、以及 `wsErrorMessageSchema` 的
 * `requestId` 字段（M6 plan §3.3 review Medium #3：业务错误回填
 * `requestId` 让 SDK 能 reject 对应 pending promise）。Server-initiated
 * 推送（rate limit、auth failure、connection setup error）不传
 * requestId。
 *
 * 约束：
 * - non-empty（`min(1)`）—— 空串语义上等价"没传"，schema 直接拒掉
 *   避免 wire 上出现 `requestId: ""` 干扰 pending map lookup。
 * - 1..128 字符 —— 跟 M3 plan § 5.1 + Gateway 长度限制一致。
 * - 客户端传入时会自动 trim；服务端透传时保留原值。
 */
const clientRequestIdSchema = z.string().trim().min(1).max(128);

// ---------------------------------------------------------------------------
// WebSocket connect query
// ---------------------------------------------------------------------------

/**
 * `/ws` query string parsed at HTTP upgrade time (M3 plan § 7.1).
 *
 * `clientType` / `clientVersion` are optional and NOT persisted in
 * M3; the Gateway may surface them in structured logs only.
 *
 * The Gateway MUST validate this schema BEFORE invoking
 * `verifyImToken` (M3 plan § 7.1 step 1), so missing or malformed
 * query params fail with HTTP close code `1008` instead of leaking
 * through to the JWT verifier.
 */
export const webSocketConnectQuerySchema = z.object({
  appId: uuidStringSchema,
  userId: externalUserIdSchema,
  deviceId: z.string().trim().min(1).max(128),
  token: z.string().min(1),
  protocolVersion: protocolVersionSchema,
  clientType: z.string().min(1).max(64).optional(),
  clientVersion: z.string().min(1).max(64).optional()
});
export type WebSocketConnectQuery = z.infer<
  typeof webSocketConnectQuerySchema
>;

// ---------------------------------------------------------------------------
// Message payloads (shared shapes used by client + server envelopes)
// ---------------------------------------------------------------------------

/**
 * M5 widens `conversationType` to a 2-member enum:
 * - `"direct"` — M3 1x1 single chat.
 * - `"group"`  — M5 group chat (multi-member, each member can send).
 *
 * `"broadcast"` is intentionally NOT here: broadcast is server-driven
 * (Server API only, see `docs/milestones/M5-group与broadcast开发计划.md`
 * §2.2), so a WebSocket client MUST NOT be able to construct a
 * broadcast send frame.
 */
export const conversationTypeSchema = z.enum(["direct", "group"]);

/**
 * M6 把 `messageType` 从 `z.literal("text")` 拓宽为 3 元 enum：
 * `text`（M3/M5）、`image`（M6）、`file`（M6）。Broadcast Server API
 * 仍保持 `z.literal("text")`（见 `server.ts`）；WebSocket 层是
 * 唯一暴露 media 的地方。
 *
 * `audio` / `video` 故意留到 M6 之外 —— 它们需要 duration、
 * player 元数据以及更复杂的客户端 UI 规则。
 */
export const messageTypeSchema = z.enum(["text", "image", "file"]);

/**
 * M3/M5 文本消息 content。`.strict()`：caller 没法在 M6 image /
 * file messageType 上线前走私 `mediaAssetId` / `imageUrl` /
 * `fileId` 等字段 —— parser 会拒掉未知 key，而不是静默剥掉，
 * 否则客户端就能在协议还不支持 media 时假装在发 media。
 *
 * 用在：
 * - `message.send`（direct + group，M5）
 * - `message.received`（服务端推送给接收端）
 * - `messageSyncResultItemSchema` items
 *
 * 这里的 `.strict()` **也**保护 M4 sync：万一某条 sync result
 * item 的 `content` 里带上了 `mediaAssetId`，parse 阶段就会失败，
 * 而不是悄悄转发给客户端。
 */
export const directTextContentSchema = z
  .object({
    text: z.string().trim().min(1).max(8192)
  })
  .strict();
export type DirectTextContent = z.infer<typeof directTextContentSchema>;

/**
 * M6 发送端 media content。只携带客户端被允许 *claim* 的字段：已
 * `uploaded` 的 `media_assets` 行的 `mediaAssetId`，外加可选的
 * `caption`。其它所有元数据（fileName、mimeType、sizeBytes、
 * sha256、dimensions）由服务端从 DB 行重建，避免恶意客户端伪造
 * 一条 media 消息的 canonical content。
 *
 * `.strict()` 拒绝以下字段：
 * - `text` —— 文本消息不走这个 schema。
 * - `fileName` / `sizeBytes` / `mimeType` / `sha256` /
 *   `width` / `height` —— 由服务端解析的字段。走私这些字段会让
 *   调用方发布与上传对象不一致的 content。
 */
export const sendMediaContentSchema = z
  .object({
    mediaAssetId: uuidStringSchema,
    caption: z.string().trim().min(1).max(1024).optional()
  })
  .strict();
export type SendMediaContent = z.infer<typeof sendMediaContentSchema>;

/**
 * 64 字符小写 hex 正则，用来在 canonical media content 上校验
 * 客户端 claim 的 `sha256`。镜像 `packages/domain/src/media/policy.ts`
 * 里的 policy —— 两层用同样的正则，stale 客户端没法推非小写摘要。
 */
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * M6 接收 / 同步端 canonical media content（M6 plan §3.2）。
 * 携带接收端渲染消息所需的完整元数据，**不**依赖 storage URL：
 * download URL 走独立的短 TTL presigned GET endpoint
 * （`GET /api/client/apps/:appId/media/:mediaAssetId/download-url`）。
 *
 * `.strict()`：以后 repository 不小心把 `objectKey` 或
 * `internalOwnerImUserId` 加到 canonical content 上时，会在协议
 * 边界 parse 失败，避免泄漏到客户端。
 */
export const receivedMediaContentSchema = z
  .object({
    mediaAssetId: uuidStringSchema,
    fileName: z.string().trim().min(1).max(512),
    mimeType: z.string().min(1).max(256),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256_HEX_PATTERN),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    caption: z.string().trim().min(1).max(1024).optional()
  })
  .strict();
export type ReceivedMediaContent = z.infer<
  typeof receivedMediaContentSchema
>;

/**
 * `message.send` payload —— M5 + M6 discriminated union。
 *
 * M5 把 schema 拆成两个 `.strict()` 成员（direct / group），让
 * union 能携带不同的路由字段。M6 把每个 conversationType 拓宽为
 * `messageType` 上的 `(text | media)` 子判别字段。实现方式是定义
 * 四个 leaf schema 然后 `z.union` 起来 —— `z.union` 在
 * `conversationType` + `messageType` 判别字段上保留 TypeScript
 * narrowing，并在每个 member 上给出正确的 `.strict()` 语义
 * （`.strict()` 是 member 局部的，不是 union 整体的）。
 *
 * Members：
 *  - `directTextMessageSendPayloadSchema`  — direct + text。
 *  - `directMediaMessageSendPayloadSchema` — direct + image|file。
 *  - `groupTextMessageSendPayloadSchema`   — group + text。
 *  - `groupMediaMessageSendPayloadSchema`  — group + image|file。
 *
 * `senderUserId` 来自 WebSocket 连接上下文，**不**来自 payload
 * （M3 plan §7.3 step 1；M5 plan §3.1）。每个 member 都
 * `.strict()`，与 M3/M5 防止走私字段的考量一致。
 */
const directTextMessageSendPayloadSchema = z
  .object({
    conversationType: z.literal("direct"),
    recipientUserId: externalUserIdSchema,
    clientMessageId: clientMessageIdSchema,
    messageType: z.literal("text"),
    content: directTextContentSchema
  })
  .strict();

const directMediaMessageSendPayloadSchema = z
  .object({
    conversationType: z.literal("direct"),
    recipientUserId: externalUserIdSchema,
    clientMessageId: clientMessageIdSchema,
    messageType: z.enum(["image", "file"]),
    content: sendMediaContentSchema
  })
  .strict();

const groupTextMessageSendPayloadSchema = z
  .object({
    conversationType: z.literal("group"),
    conversationId: uuidStringSchema,
    clientMessageId: clientMessageIdSchema,
    messageType: z.literal("text"),
    content: directTextContentSchema
  })
  .strict();

const groupMediaMessageSendPayloadSchema = z
  .object({
    conversationType: z.literal("group"),
    conversationId: uuidStringSchema,
    clientMessageId: clientMessageIdSchema,
    messageType: z.enum(["image", "file"]),
    content: sendMediaContentSchema
  })
  .strict();

export const messageSendPayloadSchema = z.union([
  directTextMessageSendPayloadSchema,
  directMediaMessageSendPayloadSchema,
  groupTextMessageSendPayloadSchema,
  groupMediaMessageSendPayloadSchema
]);
export type MessageSendPayload = z.infer<typeof messageSendPayloadSchema>;

/**
 * `message.sync` request payload (M4 plan § 3.1).
 *
 * - `conversationId` MUST be the same UUID the client received from
 *   prior `message.received` / `message.send_ack` frames for this
 *   conversation. The Gateway scopes the query by
 *   `(tenantId, appId, conversationId)` AND verifies that the calling
 *   connection's `imUserId` is a member of that conversation
 *   (M4 plan § 7.2).
 * - `afterSeq` is the cursor — server returns messages with
 *   `conversationSeq > afterSeq`. `0` means "from the start".
 * - `limit` is OPTIONAL; the Gateway defaults to 50 when omitted
 *   and validates `1..100` (out-of-range values are rejected by the
 *   Zod schema, NOT clamped — see `limit: z.number().int().min(1)
 *   .max(100).optional()` below). Marked optional at the protocol
 *   level so the caller does not have to send a value when the
 *   default is fine.
 *
 * The server response (`message.sync_result`) carries
 * `nextSeq` and `hasMore` to drive the client's next cursor.
 */
export const messageSyncPayloadSchema = z.object({
  conversationId: uuidStringSchema,
  afterSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100).optional()
});
export type MessageSyncPayload = z.infer<typeof messageSyncPayloadSchema>;

export const messageStatusSchema = z.literal("sent");
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageSendAckPayloadSchema = z.object({
  conversationId: uuidStringSchema,
  serverMessageId: uuidStringSchema,
  clientMessageId: clientMessageIdSchema,
  conversationSeq: z.number().int().positive(),
  status: messageStatusSchema,
  createdAt: z.string().datetime()
});
export type MessageSendAckPayload = z.infer<
  typeof messageSendAckPayloadSchema
>;

/**
 * 服务端推送 `message.received` payload —— M6 discriminated union，
 * 判别字段为 `messageType`。text variant 沿用 M3/M5 既有形状；
 * image / file variant 携带 *canonical* media content（服务端从
 * DB 行重建，不带客户端 claim 字段）。
 *
 * 每个 member 都 `.strict()`，捕获可能把额外字段泄漏给接收端的
 * repository / DTO bug。
 */
const messageReceivedTextPayloadSchema = z
  .object({
    conversationId: uuidStringSchema,
    serverMessageId: uuidStringSchema,
    senderUserId: externalUserIdSchema,
    conversationSeq: z.number().int().positive(),
    messageType: z.literal("text"),
    content: directTextContentSchema,
    createdAt: z.string().datetime()
  })
  .strict();

const messageReceivedMediaPayloadSchema = z
  .object({
    conversationId: uuidStringSchema,
    serverMessageId: uuidStringSchema,
    senderUserId: externalUserIdSchema,
    conversationSeq: z.number().int().positive(),
    messageType: z.enum(["image", "file"]),
    content: receivedMediaContentSchema,
    createdAt: z.string().datetime()
  })
  .strict();

export const messageReceivedPayloadSchema = z.union([
  messageReceivedTextPayloadSchema,
  messageReceivedMediaPayloadSchema
]);
export type MessageReceivedPayload = z.infer<
  typeof messageReceivedPayloadSchema
>;

/**
 * `message.sync_result.items` 里的一条 message（M4 plan §3.1，M6
 * 扩展支持 image / file content）。
 *
 * `.strict()` is intentional: a future implementation that forgets
 * to map the internal `messages.sender_user_id` (a UUID referencing
 * `im_users.id`) into the external `senderUserId` field would
 * otherwise be caught only by integration tests. Strict-parse at
 * the protocol boundary is the early guardrail.
 *
 * `conversationId` is intentionally NOT in the item — the wrapper
 * payload (`messageSyncResultPayloadSchema`) carries it once and
 * applies to every row.
 */
const messageSyncResultTextItemSchema = z
  .object({
    serverMessageId: uuidStringSchema,
    senderUserId: externalUserIdSchema,
    conversationSeq: z.number().int().positive(),
    messageType: z.literal("text"),
    content: directTextContentSchema,
    createdAt: z.string().datetime()
  })
  .strict();

const messageSyncResultMediaItemSchema = z
  .object({
    serverMessageId: uuidStringSchema,
    senderUserId: externalUserIdSchema,
    conversationSeq: z.number().int().positive(),
    messageType: z.enum(["image", "file"]),
    content: receivedMediaContentSchema,
    createdAt: z.string().datetime()
  })
  .strict();

export const messageSyncResultItemSchema = z.union([
  messageSyncResultTextItemSchema,
  messageSyncResultMediaItemSchema
]);
export type MessageSyncResultItem = z.infer<
  typeof messageSyncResultItemSchema
>;

/**
 * `message.sync_result` response payload (M4 plan § 3.1).
 *
 * `nextSeq` semantics (computed by the Gateway, NOT by the client):
 * - Non-empty `items`: `nextSeq = items[last].conversationSeq`.
 * - Empty `items`: `nextSeq = request.afterSeq` (echo).
 * `hasMore = true` iff there exist more rows with
 * `conversationSeq > nextSeq` (computed by the Gateway via
 * `limit + 1` over-fetch).
 *
 * `.strict()` to prevent accidental leakage of internal IDs.
 */
export const messageSyncResultPayloadSchema = z
  .object({
    conversationId: uuidStringSchema,
    items: z.array(messageSyncResultItemSchema),
    nextSeq: z.number().int().nonnegative(),
    hasMore: z.boolean()
  })
  .strict();
export type MessageSyncResultPayload = z.infer<
  typeof messageSyncResultPayloadSchema
>;

export const messageDeliveryAckPayloadSchema = z.object({
  serverMessageId: uuidStringSchema
});
export type MessageDeliveryAckPayload = z.infer<
  typeof messageDeliveryAckPayloadSchema
>;

/**
 * `message.read_ack` request payload (M4 plan § 3.2).
 *
 * Sent by the client after it has finished reading messages up to
 * `readSeq` in the given conversation. The Gateway:
 *  1. verifies the calling connection's `imUserId` is a member of
 *     `(tenantId, appId, conversationId)`;
 *  2. updates `conversation_members.last_read_seq =
 *     GREATEST(current, readSeq)` (SQL-level, see
 *     `packages/db/src/repositories/messages.ts markConversationRead`);
 *  3. flips receipts where
 *     `receiver_user_id = ctx.imUserId AND conversation_seq <= readSeq
 *      AND delivery_status IN ('pending','delivered')` to `read`.
 *
 * Steps 2 + 3 run inside one DB transaction so the read-cursor
 * position and the receipt read-status never disagree on crash or
 * disconnect.
 */
export const messageReadAckPayloadSchema = z.object({
  conversationId: uuidStringSchema,
  readSeq: z.number().int().nonnegative()
});
export type MessageReadAckPayload = z.infer<
  typeof messageReadAckPayloadSchema
>;

/**
 * Unified server ACK envelope (M3 plan § 7.4; M4 plan § 3.2 / § 3.3).
 *
 * M3 ships one client→server ACK action (`message.delivery_ack`).
 * M4 widens the response payload to a discriminated union on
 * `ackType`:
 *  - `message.delivery_ack` — required `serverMessageId` + `deliveryStatus`
 *    so the Gateway cannot emit an ACK that omits the delivery result.
 *  - `message.read_ack`    — required `conversationId` + `readSeq`.
 *
 * Adding a new client→server ACK action means BOTH:
 *  1. extending `clientWsMessageSchema` (request side), AND
 *  2. adding the matching variant here AND in the
 *     `serverWsMessageSchema`'s `ack` wrapper (response side).
 *
 * Each variant is `.strict()` so accidental extra fields (e.g.
 * leaking server internal state) fail the parse instead of being
 * silently forwarded to clients.
 */
export const deliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "read"
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const ackPayloadSchema = z.discriminatedUnion("ackType", [
  z
    .object({
      ackType: z.literal("message.delivery_ack"),
      serverMessageId: uuidStringSchema,
      deliveryStatus: deliveryStatusSchema
    })
    .strict(),
  z
    .object({
      ackType: z.literal("message.read_ack"),
      conversationId: uuidStringSchema,
      readSeq: z.number().int().nonnegative()
    })
    .strict()
]);
export type AckPayload = z.infer<typeof ackPayloadSchema>;

// ---------------------------------------------------------------------------
// Error envelope (server push, no requestId)
// ---------------------------------------------------------------------------

/**
 * WebSocket error codes MUST be drawn from the same `ErrorCode`
 * catalog as HTTP errors (`./errors.ts`). `z.enum` of the keys
 * ensures typos like `NOT_A_REAL_CODE` fail the parse at the
 * Gateway boundary rather than reaching the client. New codes are
 * picked up automatically because the enum is derived from
 * `errorCodes` at module load.
 */
const errorCodeValues = Object.keys(errorCodes) as [
  ErrorCode,
  ...ErrorCode[]
];
export const wsErrorCodeSchema = z.enum(errorCodeValues);

export const wsErrorPayloadSchema = z.object({
  code: wsErrorCodeSchema,
  message: z.string().min(1).max(1024),
  details: z.record(z.unknown()).optional()
});
export type WsErrorPayload = z.infer<typeof wsErrorPayloadSchema>;

/**
 * Full server→client error message (M3 plan § 5.1 names this schema
 * `wsErrorMessageSchema`). Distinct from `wsErrorPayloadSchema` (the
 * inner `{ code, message, details? }` shape) — this wraps the
 * payload under `type: "error"` to match the other
 * `serverWsMessageSchema` variants. The `serverWsMessageSchema`
 * discriminated union still has its own inline `error` variant
 * (required by `z.discriminatedUnion`); they share the same shape.
 *
 * `requestId` 可选：业务错误（schema 校验失败、conversation member
 * 检查失败、media 找不到等）作为某个具体 client 请求的失败响应时，
 * Gateway 回填 client 当初发的 `requestId`，让 SDK 能 reject 对应
 * pending promise（M6 plan §3.3 review Medium #3）。Server-initiated
 * 推送（rate limit、auth failure、connection setup error）不带
 * `requestId` —— 这种情况 SDK 走 `on("error", ...)` 事件。空串跟
 * "没传" 等价，schema 直接拒掉避免 wire 上出现 `requestId: ""` 干扰
 * SDK pending map lookup。
 */
export const wsErrorMessageSchema = z.object({
  requestId: clientRequestIdSchema.optional(),
  type: z.literal("error"),
  payload: wsErrorPayloadSchema
});
export type WsErrorMessage = z.infer<typeof wsErrorMessageSchema>;

// ---------------------------------------------------------------------------
// Server push payloads (no requestId)
// ---------------------------------------------------------------------------

export const connectionReadyPayloadSchema = z.object({
  appId: uuidStringSchema,
  userId: externalUserIdSchema,
  deviceId: z.string(),
  protocolVersion: protocolVersionSchema
});
export type ConnectionReadyPayload = z.infer<
  typeof connectionReadyPayloadSchema
>;

// ---------------------------------------------------------------------------
// Discriminated unions
// ---------------------------------------------------------------------------

/**
 * All messages a client may send to the Gateway.
 *
 * Each variant carries `requestId`; the Gateway MUST echo the same
 * `requestId` in `message.send_ack` / `message.sync_result` / `ack`
 * responses (M3 plan § 3.2 + § 7.4; M4 plan § 3.1 + § 3.2).
 *
 * M4 extends this union with two new actions:
 *  - `message.sync`        — incremental sync after reconnect.
 *  - `message.read_ack`    — session-level read cursor advance.
 *
 * Adding more client→server actions means extending this union AND
 * extending `serverWsMessageSchema` / `ackPayloadSchema` to know
 * about the matching response shape.
 */
export const clientWsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("message.send"),
    payload: messageSendPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("message.delivery_ack"),
    payload: messageDeliveryAckPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("message.sync"),
    payload: messageSyncPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("message.read_ack"),
    payload: messageReadAckPayloadSchema
  })
]);
export type ClientWsMessage = z.infer<typeof clientWsMessageSchema>;

/**
 * All messages the Gateway may send to a client.
 *
 * Server push messages (`connection.ready`, `message.received`)
 * DO NOT carry `requestId`. Request/response messages
 * (`message.send_ack`, `message.sync_result`, `ack`) MUST carry
 * `requestId` and echo the client-provided value.
 *
 * `error` frames may carry an optional `requestId`：业务错误（schema
 * 校验失败、conversation member 检查失败、media 找不到等）作为某个
 * 具体 client 请求的失败响应时，Gateway 会回填 client 当初发的
 * `requestId`，让 SDK 能 reject 对应的 pending promise 而不是 timeout
 * 到 `requestTimeoutMs`（M3 plan §5.1 + M6 plan §3.3 review Medium
 * #3）。Server-initiated 推送（rate limit、auth failure、connection
 * setup error）没有 requestId —— 这种情况 SDK 走 `on("error", ...)`
 * 事件，不 reject 任何 pending request。
 *
 * M4 adds `message.sync_result` (request/response for `message.sync`).
 */
export const serverWsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connection.ready"),
    payload: connectionReadyPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("message.send_ack"),
    payload: messageSendAckPayloadSchema
  }),
  z.object({
    type: z.literal("message.received"),
    payload: messageReceivedPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("message.sync_result"),
    payload: messageSyncResultPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema,
    type: z.literal("ack"),
    payload: ackPayloadSchema
  }),
  z.object({
    requestId: clientRequestIdSchema.optional(),
    type: z.literal("error"),
    payload: wsErrorPayloadSchema
  })
]);
export type ServerWsMessage = z.infer<typeof serverWsMessageSchema>;
