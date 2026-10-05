/**
 * Stable error codes for NexaIM HTTP API responses.
 *
 * Convention: prefix with the area (e.g. `AUTH_`, `TENANT_`), all UPPER_SNAKE.
 * Prefix catalog is defined in `docs/API接口设计规范.md` § 6. Adding a new
 * code requires adding the matching HTTP status mapping in the M2 plan
 * (`docs/milestones/M2-控制台鉴权租户应用与密钥管理开发计划.md` § 6.0).
 *
 * `AUTH_` errors are reserved for unauthenticated requests or invalid
 * credentials. Once a request is authenticated, role / resource checks
 * must use `PERMISSION_DENIED` so the caller can distinguish "I need to
 * log in" from "I do not have access to this resource".
 */
export const errorCodes = {
  // ---- M1 first batch ----
  AUTH_SIGNATURE_INVALID: "AUTH_SIGNATURE_INVALID",
  AUTH_TIMESTAMP_EXPIRED: "AUTH_TIMESTAMP_EXPIRED",
  AUTH_TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  TENANT_NOT_FOUND: "TENANT_NOT_FOUND",
  APP_NOT_FOUND: "APP_NOT_FOUND",
  SECRET_INVALID: "SECRET_INVALID",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  MESSAGE_DUPLICATE_CLIENT_MESSAGE_ID: "MESSAGE_DUPLICATE_CLIENT_MESSAGE_ID",
  CONVERSATION_MEMBER_REQUIRED: "CONVERSATION_MEMBER_REQUIRED",
  NOTIFICATION_PROVIDER_DISABLED: "NOTIFICATION_PROVIDER_DISABLED",
  WEBHOOK_BEFORE_SEND_REJECTED: "WEBHOOK_BEFORE_SEND_REJECTED",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // ---- M2: Console API ----
  AUTH_SESSION_REQUIRED: "AUTH_SESSION_REQUIRED",
  AUTH_CREDENTIALS_INVALID: "AUTH_CREDENTIALS_INVALID",
  AUTH_EMAIL_ALREADY_EXISTS: "AUTH_EMAIL_ALREADY_EXISTS",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  TENANT_MEMBER_NOT_FOUND: "TENANT_MEMBER_NOT_FOUND",
  TENANT_MEMBER_ALREADY_EXISTS: "TENANT_MEMBER_ALREADY_EXISTS",
  TENANT_LAST_OWNER_REQUIRED: "TENANT_LAST_OWNER_REQUIRED",
  APP_KEY_CONFLICT: "APP_KEY_CONFLICT",
  SECRET_NOT_FOUND: "SECRET_NOT_FOUND",
  SECRET_DISABLED: "SECRET_DISABLED",
  /**
   * Generic 422 for any Zod / business-rule validation failure that is
   * not covered by a more specific code. The `details` field carries
   * the field name and a human-readable message. M2 plan § 6.0 lists
   * `*_VALIDATION_FAILED` as the 422 mapping; we expose one shared code
   * (no prefix) to keep the catalog short. Implementation bias record
   * in M2 plan § 17 captures this decision.
   */
  VALIDATION_FAILED: "VALIDATION_FAILED",

  // ---- M3: Server API (HMAC) + IM identity / devices / messages ----
  // Server API nonce replay: signature passed but the nonce has already
  // been used within the timestamp tolerance window.
  AUTH_NONCE_REPLAYED: "AUTH_NONCE_REPLAYED",
  // Server API signature verified but the resolved app is `disabled`.
  // Returned with HTTP 401 (not 403) on purpose: callers must not be
  // able to distinguish "wrong secret" from "disabled app" via timing
  // or error code, matching M3 plan § 11 security checklist item 6.
  AUTH_APP_DISABLED: "AUTH_APP_DISABLED",
  // IM user exists but `status = disabled`. Distinct from USER_NOT_FOUND
  // so callers can distinguish "needs to upsert profile" from
  // "account suspended".
  USER_DISABLED: "USER_DISABLED",
  // Device not found for the resolved (appId, externalUserId, deviceId).
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
  // `clientMessageId` was reused with a different payload. M3 plan § 7.3
  // step 7: same key + different content -> 409 conflict (do not silently
  // return the previous message).
  MESSAGE_PAYLOAD_CONFLICT: "MESSAGE_PAYLOAD_CONFLICT",

  // ---- M5: groups + broadcasts ----
  // Resolved group row is missing. Note: disabled group sends
  // collapse to this single code to avoid leaking the group's
  // existence to non-members probing (M5 plan §2.7). Member-change
  // routes (POST/PATCH/DELETE .../members) instead surface
  // `GROUP_DISABLED` since the caller already authenticated via
  // HMAC and supplied a known groupId — leaking the disabled state
  // is informative for a legitimate operator.
  GROUP_NOT_FOUND: "GROUP_NOT_FOUND",
  // Group exists but `status='disabled'` and the route does not
  // permit writes to a disabled group (M5 plan §3.2: "disabled
  // group 不允许发送新消息；... 拒绝 new member changes"). New sends
  // surface `GROUP_NOT_FOUND` per §2.7; member-add / patch-role /
  // remove-member surface this code.
  GROUP_DISABLED: "GROUP_DISABLED",
  // Group member not found: PATCH/DELETE .../members/:userId or
  // syncConversation owner permission check.
  GROUP_MEMBER_NOT_FOUND: "GROUP_MEMBER_NOT_FOUND",
  // POST .../groups/:groupId/members with a userId that is already a
  // member (M5 plan §3.2 D1: POST is add-only, role changes go via
  // PATCH .../members/:userId).
  GROUP_MEMBER_ALREADY_EXISTS: "GROUP_MEMBER_ALREADY_EXISTS",
  // Last-owner guard for both DELETE member and PATCH member role
  // (M5 plan §3.2). Caller attempted to remove or downgrade the
  // final `owner` of a group.
  GROUP_LAST_OWNER_REQUIRED: "GROUP_LAST_OWNER_REQUIRED",
  // Resolved broadcast conversation not found for the caller's
  // tenantId + appId. Distinct from `CONVERSATION_NOT_FOUND` because
  // broadcast rows should never leak through the regular conversation
  // lookup path.
  BROADCAST_NOT_FOUND: "BROADCAST_NOT_FOUND",
  // importBroadcastReceivers received an empty `userIds` array AFTER
  // schema validation OR a single-user upsert path that ended up with
  // no eligible active users. Schema-level "empty list" is caught by
  // Zod (`min(1)`); this code is reserved for runtime "everyone in
  // the request was disabled / not found" cases the route layer
  // surfaces.
  BROADCAST_RECEIVER_REQUIRED: "BROADCAST_RECEIVER_REQUIRED",
  // message_dispatch_tasks row not found for the resolved messageId
  // (Worker / progress lookup fallbacks). M5 plan §3.4.
  DISPATCH_TASK_NOT_FOUND: "DISPATCH_TASK_NOT_FOUND",

  // ---- M6：media 上传 + media 消息 ----
  // 找不到 media asset 行 **或**调用方不可见（跨 app、跨 tenant、
  // owner 不匹配、或已绑定到别的 conversation）。M6 plan §3.3：
  // 用单个 `MEDIA_NOT_FOUND` code 作为 anti-probe 信封 —— 调用方
  // 无法区分"不存在"与"存在但看不到"，与 M5 的 `GROUP_NOT_FOUND`
  // 同款设计。
  MEDIA_NOT_FOUND: "MEDIA_NOT_FOUND",
  // `POST .../media/:mediaAssetId/complete` 被调用时，行处在非
  // `pending` 状态（如 `failed`、`deleted`），幂等的 re-completion
  // 不适用。幂等的 `pending -> uploaded` 路径则保持静默（返回已
  // 存在的 `uploaded` 行）。
  MEDIA_UPLOAD_NOT_PENDING: "MEDIA_UPLOAD_NOT_PENDING",
  // 超出大小上限（image 10 MiB，file 50 MiB）。由 API 层映射为
  // HTTP 422。
  MEDIA_SIZE_EXCEEDED: "MEDIA_SIZE_EXCEEDED",
  // MIME 不在该 kind 的白名单内，或 `kind=image` 携带非 image
  // MIME / `kind=file` 携带 image MIME。映射为 HTTP 422。
  MEDIA_MIME_NOT_ALLOWED: "MEDIA_MIME_NOT_ALLOWED",
  // 调用 `complete` 时 `HeadObject` 报告对象在 bucket 中不存在。
  // 视为 404 —— 上传从未完成，或对着别的 key 完成。
  MEDIA_OBJECT_NOT_UPLOADED: "MEDIA_OBJECT_NOT_UPLOADED",
  // 调用 `complete` 时 `HeadObject` 报告的 `ContentLength` 或
  // `x-amz-meta-sha256` 与 DB 行不一致。视为 409（状态冲突）。
  MEDIA_OBJECT_METADATA_MISMATCH: "MEDIA_OBJECT_METADATA_MISMATCH",

  // ---- M7：webhook 拦截 / 异步投递 / Console API ----
  // `message.before_send` 被业务方 reject 或返回非 2xx。客户端 (WebSocket
  // / 移动端) 收到此 code 时，消息不会入库 / 不会 fan-out。M7 plan
  // §3.2。注意：M1 占位的 `WEBHOOK_BEFORE_SEND_REJECTED` 保留在表里
  // 仅为向后兼容，新代码请使用本码。
  MESSAGE_BLOCKED_BY_WEBHOOK: "MESSAGE_BLOCKED_BY_WEBHOOK",
  // `message.before_send` 调用发生网络错误（DNS / connect refused /
  // TLS 失败等），按 reject 处理。M7 plan §3.2。
  WEBHOOK_DELIVERY_FAILED: "WEBHOOK_DELIVERY_FAILED",
  // `message.before_send` 超时，且 endpoint 的 `beforeSendFailurePolicy`
  // 为 `reject_on_timeout`。M7 plan §3.2。
  WEBHOOK_TIMEOUT: "WEBHOOK_TIMEOUT",
  // Console API 操作的 endpoint id 不存在 / 跨 app / 跨 tenant / 已
  // disabled 状态。M7 plan §3.7 + §3.6 anti-probe。
  WEBHOOK_ENDPOINT_NOT_FOUND: "WEBHOOK_ENDPOINT_NOT_FOUND",
  // Console API 操作的 delivery id 不存在 / 跨 app / 跨 tenant。M7 plan
  // §12 S9。
  WEBHOOK_DELIVERY_NOT_FOUND: "WEBHOOK_DELIVERY_NOT_FOUND",
  // domain `buildDeliveryEventId()` 收到缺 parts 的 event type（例如
  // `message.delivered` 没传 `receiverUserId`）。M7 plan §3.5。
  WEBHOOK_EVENT_ID_INVALID: "WEBHOOK_EVENT_ID_INVALID",

  // ---- M9：Console API stats 模块（§5 错误码表）----
  // `from` / `to` 不是 YYYY-MM-DD，或 `from > to`。映射 422。
  // 由 protocol 层 Zod 命中后由 domain `normalizeStatsDateRange` 统一
  // 抛出，routes 层转换为该 code。
  STATS_INVALID_DATE_RANGE: "STATS_INVALID_DATE_RANGE",
  // 闭区间日期跨度超过 31 天。映射 422。
  STATS_DATE_RANGE_TOO_LARGE: "STATS_DATE_RANGE_TOO_LARGE",
  // `provider` / `eventType` / `conversationType` / `messageType`
  // 维度枚举值不合法。映射 422。
  STATS_INVALID_FILTER: "STATS_INVALID_FILTER",
  // broadcast cursor 不能被 base64url 解码、缺字段或格式非法。
  // 映射 422。
  STATS_INVALID_CURSOR: "STATS_INVALID_CURSOR",
  // stats 路径下的 app 不存在 / 跨 app / 跨 tenant / 已 disabled。
  // 复用 anti-probe 信封，禁止泄露跨租户资源存在性。映射 404。
  STATS_APP_NOT_FOUND: "STATS_APP_NOT_FOUND"
} as const;

export type ErrorCode = keyof typeof errorCodes;

export type NexaIMError = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};
