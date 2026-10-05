/**
 * @nexaim/reference-client —— NexaIM 官方 JS/TS Reference Client
 * (M4 plan § 8 - § 9).
 *
 * Runtime-agnostic SDK: browser-native `WebSocket` and Node-injected
 * `WebSocketCtor` both supported. The client never holds the app
 * secret and never signs Server API HMAC requests — the caller is
 * responsible for supplying a `tokenProvider`.
 *
 * Layering:
 *   - Task 6: scaffold
 *   - Task 7: utility primitives (request-id, reconnect, dedupe, errors)
 *   - Task 8: `NexaIMClient` core + `ws-runtime` (connect / disconnect /
 *             request / event API)
 *   - Task 9: sendMessage / markDelivered / markRead / syncConversation
 *   - M6 Task 6: media HTTP helpers (`requestMediaUpload` /
 *             `completeMediaUpload` / `getMediaDownloadUrl`) +
 *             `sendMediaMessage`
 */

export { createRequestId, REQUEST_ID_MAX_LENGTH } from "./request-id";
export {
  createReconnectDelay,
  type CreateReconnectDelayOptions
} from "./reconnect";
export { MessageDedupe, DEFAULT_DEDUPE_MAX_SIZE } from "./dedupe";
export { NexaIMClientError, type NexaIMClientErrorOptions } from "./errors";
export {
  NexaIMClient,
  type ConnectionState,
  type NexaIMClientOptions,
  type NexaIMClientReconnectOptions,
  type NexaIMClientEventMap,
  type NexaIMClientEventName,
  type SendMessageInput,
  type SendGroupMessageInput,
  // M6 Task 6：SDK caller 用来声明参数类型。
  type RequestMediaUploadInput,
  type SendMediaMessageInput,
  // WECHAT-ACCESS-LOGIC-1：客户端会话列表（冷启动 / 离线新建会话的发现入口）。
  type ListConversationsOptions
} from "./NexaIMClient";
// M6 Task 6：media helpers 的 response data shapes 也是 caller
// 拿到的类型 —— 一起从 protocol barrel 转出去，让 caller 一行
// `import type { CreateMediaUploadResponseData } from "@nexaim/reference-client"`
// 就能拿到手。
export type {
  CreateMediaUploadResponseData,
  CompleteMediaUploadResponseData,
  GetMediaDownloadUrlResponseData,
  MediaAssetResponse,
  // WECHAT-ACCESS-LOGIC-1：会话列表 item + 完整 envelope。
  ClientConversationItem,
  ClientConversationListResponse,
  ClientConversationListPage
} from "@nexaim/protocol";
export {
  READY_STATE,
  appendQueryParams,
  buildWebSocketConnectUrl,
  resolveWebSocketCtor,
  type WebSocketLike,
  type WebSocketCtor,
  type BuildWebSocketConnectUrlInput
} from "./ws-runtime";
// WECHAT-ACCESS-LOGIC-1：微信小程序运行时适配（注入式，不改全局对象）。
export {
  createWeChatFetch,
  createWeChatWebSocketCtor,
  type CreateWeChatFetchOptions,
  type WeChatConnectSocketOptions,
  type WeChatRequestOptions,
  type WeChatRequestTask,
  type WeChatRuntime,
  type WeChatSocketCloseOptions,
  type WeChatSocketSendOptions,
  type WeChatSocketTask
} from "./wechat-runtime";