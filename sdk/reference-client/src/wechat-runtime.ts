/**
 * 微信小程序运行时适配（`@nexaim/reference-client`）。
 *
 * 小程序 JS 运行时**没有**浏览器那套全局对象：`WebSocket`、`fetch`、
 * `URL`、`URLSearchParams`、`Headers`、`Response`、`Request`、
 * `AbortController`、`crypto`（部分基础库版本）。本模块提供两个注入式
 * 适配器，把它们映射到 Reference Client 已经在用的两个注入点上：
 *
 *   createWeChatWebSocketCtor(wx) → `NexaIMClient({ WebSocketCtor })`
 *   createWeChatFetch(wx)          → `NexaIMClient({ fetchImpl })`
 *
 * 设计边界：
 *  - **不覆盖全局对象**。业务方在自己的入口显式调用两个工厂并注入，
 *    库不修改 `globalThis`。
 *  - **不是完整 polyfill**。`wx.request` 只实现 Reference Client 实际
 *    用到的能力：GET / POST + JSON body + `Authorization` 头 + 超时 +
 *    abort。它不假装支持 `FormData`、stream、`Response.headers` 等
 *    fetch 特性 —— 需要那些能力的业务方自己选 HTTP 库。
 *  - **`wx` 用结构类型描述**，不要求业务方安装 `miniprogram-api-typings`
 *    之类的类型包：只要传入的 `wx` 满足下面两个函数签名即可。
 *
 * 事件映射（WebSocket）：
 *   SocketTask.onOpen   → readyState = OPEN,   onopen
 *   SocketTask.onMessage→ onmessage({ data })（原样透传，SDK 层拒绝非字符串帧）
 *   SocketTask.onError  → onerror
 *   SocketTask.onClose  → readyState = CLOSED, onclose({ code, reason })
 *
 * `close()` 之后会**摘掉** SocketTask 上的回调：断线重连时旧
 * SocketTask 的迟到事件不能污染当前状态机。
 */

import { NexaIMClientError } from "./errors";
import {
  READY_STATE,
  type WebSocketCtor,
  type WebSocketLike
} from "./ws-runtime";

// ---------------------------------------------------------------------------
// wx 结构类型（最小 API 面）
// ---------------------------------------------------------------------------

export type WeChatSocketSendOptions = {
  data: string;
  success?: (res: unknown) => void;
  fail?: (err: unknown) => void;
};

export type WeChatSocketCloseOptions = {
  code?: number;
  reason?: string;
};

export type WeChatSocketTask = {
  onOpen(callback: (res: unknown) => void): void;
  onMessage(callback: (res: { data: unknown }) => void): void;
  onError(callback: (err: unknown) => void): void;
  onClose(callback: (res: { code: number; reason: string }) => void): void;
  send(options: WeChatSocketSendOptions): void;
  close(options?: WeChatSocketCloseOptions): void;
};

export type WeChatConnectSocketOptions = {
  url: string;
  /** 握手头 —— Reference Client 不需要（IM Token 走 query），保留字段以便对接。 */
  header?: Record<string, string>;
  protocols?: string[];
  method?: "GET" | "POST";
};

export type WeChatRequestOptions = {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
  timeout?: number;
  success?: (res: { statusCode: number; data: unknown; header?: unknown }) => void;
  fail?: (err: unknown) => void;
};

export type WeChatRequestTask = {
  abort(): void;
};

export type WeChatRuntime = {
  connectSocket(options: WeChatConnectSocketOptions): WeChatSocketTask;
  request(options: WeChatRequestOptions): WeChatRequestTask;
};

export type CreateWeChatFetchOptions = {
  /** 传给 `wx.request` 的超时（毫秒）。不传则由微信默认（60s）。 */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// WebSocket 适配
// ---------------------------------------------------------------------------

/**
 * 把 `wx.connectSocket` 返回的 SocketTask 包装成 `WebSocketLike`，供
 * `NexaIMClient({ WebSocketCtor })` 使用。
 *
 * 返回值是一个**类**（`WebSocketCtor` 要求 `new (url) => WebSocketLike`），
 * 每次 `new` 都会调用一次 `wx.connectSocket` —— 与浏览器 / `ws` 的
 * "每次连接一个独立 socket" 语义一致，重连不会复用已关闭的 task。
 */
export function createWeChatWebSocketCtor(wx: WeChatRuntime): WebSocketCtor {
  class WeChatWebSocket implements WebSocketLike {
    readyState: number = READY_STATE.CONNECTING;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;

    /**
     * 当前活跃的 SocketTask。`close()` / `error` 之后置 null —— 所有
     * 回调都先比对 `this.task === task`，因此**旧 task 的迟到事件会被
     * 静默丢弃**（断线重连场景必需）。
     */
    private task: WeChatSocketTask | null;

    constructor(url: string) {
      const task = wx.connectSocket({ url });
      this.task = task;

      task.onOpen(() => {
        if (this.task !== task) return;
        this.readyState = READY_STATE.OPEN;
        this.onopen?.({});
      });

      task.onMessage((res) => {
        if (this.task !== task) return;
        // 原样透传 `data`：非字符串帧由 SDK 层
        // （`UNSUPPORTED_FRAME`）统一报错，适配器不重复判断。
        this.onmessage?.({ data: res?.data });
      });

      task.onError((err) => {
        // 微信的错误事件**不保证**后面跟 onClose，也可能 error → close
        // 成对到达。SDK 的连接收尾（reject ready waiter、清理 pending
        // 请求、自动重连）全部挂在 `onclose` 上，所以这里必须自己把
        // 连接终结掉并补一次 close —— 否则连接会永远停在 connecting /
        // connected，pending 请求也不会被清理。
        this.finishOnce(task, err);
      });

      task.onClose((res) => {
        this.finishOnce(task, undefined, {
          code: typeof res?.code === "number" ? res.code : 1006,
          reason: typeof res?.reason === "string" ? res.reason : ""
        });
      });
    }

    /**
     * 幂等终结路径。error / close 两条事件流都汇到这里：
     *  - `this.task !== task` → 该 task 已经不是当前连接（已close 过、
     *    或属于上一条连接），事件丢弃 —— 断线重连时旧 SocketTask 的迟到
     *    事件不会污染新连接。
     *  - 只终结一次：error 先到时补一次 close（让 SDK 走完收尾与重连），
     *    随后的真实 close 被上面的身份检查丢弃，不会二次重连。
     *  - 先置 CLOSED 再回调，保证回调里读到的 `readyState` 已是终态。
     */
    private finishOnce(
      task: WeChatSocketTask,
      error?: unknown,
      closeInfo?: { code: number; reason: string }
    ): void {
      if (this.task !== task) return;
      this.task = null;
      this.readyState = READY_STATE.CLOSED;
      if (error !== undefined) {
        this.onerror?.(error);
      }
      this.onclose?.({
        code: closeInfo?.code ?? 1006,
        reason: closeInfo?.reason ?? ""
      });
    }

    send(data: string): void {
      const task = this.task;
      if (!task || this.readyState !== READY_STATE.OPEN) {
        // 同步抛错：SDK 的 `request()` 会把它包成 `SEND_FAILED` reject。
        throw new NexaIMClientError("wechat socket is not open", {
          code: "SOCKET_NOT_OPEN"
        });
      }
      task.send({
        data,
        // wx.send 的失败是**异步回调**，无法同步抛。映射到 onerror，
        // 同时 request() 的超时仍然兜底（pending 一定会被清理）。
        fail: (err) => {
          if (this.task !== task) return;
          this.onerror?.(
            new NexaIMClientError("wechat socket send failed", {
              code: "SOCKET_SEND_FAILED",
              cause: err
            })
          );
        }
      });
    }

    close(code?: number, reason?: string): void {
      const task = this.task;
      if (!task) {
        // 幂等：重复 close / close-before-open 都不会二次调用 wx。
        this.readyState = READY_STATE.CLOSED;
        return;
      }
      // 先摘引用再关，确保 close 触发的 onClose 被当作"迟到事件"丢弃，
      // 由调用方（SDK teardown）自己决定要不要 emit。
      this.task = null;
      this.readyState = READY_STATE.CLOSED;
      try {
        task.close({ code: code ?? 1000, reason: reason ?? "" });
      } catch {
        // best-effort：底层 task 可能已经死了
      }
    }
  }

  return WeChatWebSocket as unknown as WebSocketCtor;
}

// ---------------------------------------------------------------------------
// fetch 适配
// ---------------------------------------------------------------------------

/**
 * 基于 `wx.request` 的最小 fetch 实现，供
 * `NexaIMClient({ fetchImpl })` 注入。
 *
 * 只实现 Reference Client 用到的部分：
 *  - `method` + `headers`（普通对象 → `header`）+ JSON `body`；
 *  - 返回 `{ ok, status, json(), text() }` —— SDK 只读这四个成员；
 *  - 非 2xx **不**抛错，由 SDK 按 `error` envelope 映射业务码；
 *  - `fail` 回调（网络失败 / 超时）→ reject `WECHAT_REQUEST_FAILED`；
 *  - `init.signal` 已 abort → 立即 reject；运行中 abort → `task.abort()`。
 *
 * `Response` / `Headers` / `Request` 全局对象一律不需要。
 */
export function createWeChatFetch(
  wx: WeChatRuntime,
  options: CreateWeChatFetchOptions = {}
): typeof fetch {
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const signal = init?.signal;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          new NexaIMClientError("request aborted before dispatch", {
            code: "REQUEST_ABORTED"
          })
        );
        return;
      }

      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        fn();
      };

      const onAbort = (): void => {
        // 先落定 promise 再 `task.abort()`：真实 wx 的 abort 会同步/异步
        // 触发 `fail`，如果顺序反过来，调用方看到的会是
        // `WECHAT_REQUEST_FAILED` 而不是"主动取消"。
        if (settled) return;
        settled = true;
        reject(
          new NexaIMClientError("request aborted", { code: "REQUEST_ABORTED" })
        );
        try {
          task.abort();
        } catch {
          // best-effort
        }
      };

      const task = wx.request({
        url,
        method,
        header: headers,
        data: body,
        ...(options.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        success: (res) => {
          finish(() => resolve(toResponse(res.statusCode, res.data)));
        },
        fail: (err) => {
          finish(() =>
            reject(
              new NexaIMClientError("wechat request failed", {
                code: "WECHAT_REQUEST_FAILED",
                cause: err
              })
            )
          );
        }
      });

      signal?.addEventListener?.("abort", onAbort);
    });
  };

  return fetchImpl as unknown as typeof fetch;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (typeof headers === "object" && !Array.isArray(headers)) {
    // 普通对象（SDK 内部就是这么传的）或 `Headers` 实例。
    const entries =
      typeof (headers as Headers).forEach === "function" &&
      typeof (headers as Headers).get === "function"
        ? [...(headers as Headers).entries()]
        : Object.entries(headers as Record<string, string>);
    const out: Record<string, string> = {};
    for (const [key, value] of entries) out[key] = String(value);
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = String(value);
    return out;
  }
  return {};
}

/**
 * `wx.request` 的 success 结果 → Response-like 对象。
 *
 * `statusCode` 缺失（理论上不该发生）按 0 处理，`ok` 为 false，SDK 会
 * 走错误分支而不是把空 body 当成功。
 */
function toResponse(statusCode: number, data: unknown): Response {
  const status = typeof statusCode === "number" ? statusCode : 0;
  const text = typeof data === "string" ? data : safeStringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    // 与真实 `Response.json()` 一致：解析失败是 **rejected promise**，
    // 不是同步 throw（同步 throw 会绕过调用方的 `.catch()`）。
    json: () => {
      if (text.length === 0) {
        return Promise.reject(new SyntaxError("Unexpected end of JSON input"));
      }
      try {
        return Promise.resolve(JSON.parse(text));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    text: () => Promise.resolve(text)
  } as unknown as Response;
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}