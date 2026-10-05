/**
 * WebSocket runtime abstraction for `@nexaim/reference-client`.
 *
 * The Reference Client is runtime-agnostic: in browsers it uses the
 * native `globalThis.WebSocket`; in Node.js the caller is expected to
 * pass a `WebSocketCtor` (typically the `ws` package's `WebSocket`
 * class, which mirrors the WHATWG interface).
 *
 * `WebSocketLike` is the minimal interface this SDK needs. Both the
 * browser global and `ws` satisfy it, so unit tests can swap in a
 * fake implementation that records `send` / `close` calls and lets
 * the test driver fire synthetic `open` / `message` / `error` /
 * `close` events.
 *
 * URL composition: the WebSocket connect path `/ws` is part of the
 * public protocol and matches `webSocketConnectQuerySchema` in
 * `@nexaim/protocol`. `buildWebSocketConnectUrl` is the single
 * canonical builder; the older M3 `apps/chat-client` copy is
 * deleted in M4 Task 10.
 */

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
};

export type WebSocketCtor = new (url: string) => WebSocketLike;

export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const;

export function resolveWebSocketCtor(
  provided?: WebSocketCtor
): WebSocketCtor {
  if (provided) {
    return provided;
  }
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof candidate === "function") {
    return candidate as unknown as WebSocketCtor;
  }
  throw new Error(
    "No WebSocket constructor available. Pass `WebSocketCtor` (e.g. `ws`'s `WebSocket`) when running in Node.js."
  );
}

export type BuildWebSocketConnectUrlInput = {
  wsBaseUrl: string;
  appId: string;
  userId: string;
  deviceId: string;
  token: string;
  protocolVersion: "1.0";
  clientType?: string;
  clientVersion?: string;
};

/**
 * 把 query 参数拼到 URL 后面，**不使用 `URL` / `URLSearchParams`**。
 *
 * 微信小程序运行时没有 `URL` / `URLSearchParams` 全局对象，而本 SDK
 * 的目标接入场景之一就是小程序（`createWeChatWebSocketCtor`）。用
 * `new URL()` 拼查询串会直接抛 `URL is not defined`，因此这里用
 * `encodeURIComponent` 手拼：
 *  - 值为 `undefined` 的键被跳过（可选参数缺省不落到 query）；
 *  - base 已带 `?` 时用 `&` 续接；
 *  - fragment（`#...`）保持在最后，不被插到 query 中间。
 *
 * token 之类的敏感值仍然只出现在**请求本身**上 —— 调用方负责不要把
 * 完整 URL 写进日志（M4 plan § 7）。
 */
export function appendQueryParams(
  baseUrl: string,
  params: Record<string, string | undefined>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (parts.length === 0) return baseUrl;
  const hashIndex = baseUrl.indexOf("#");
  const hash = hashIndex >= 0 ? baseUrl.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? baseUrl.slice(0, hashIndex) : baseUrl;
  const separator = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${separator}${parts.join("&")}${hash}`;
}

export function buildWebSocketConnectUrl(
  input: BuildWebSocketConnectUrlInput
): string {
  return appendQueryParams(input.wsBaseUrl, {
    appId: input.appId,
    userId: input.userId,
    deviceId: input.deviceId,
    token: input.token,
    protocolVersion: input.protocolVersion,
    clientType: input.clientType,
    clientVersion: input.clientVersion
  });
}
