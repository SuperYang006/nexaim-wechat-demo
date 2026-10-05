/**
 * Webhook Console API 与 delivery schema (M7 plan §1 + §3.2 + §3.6 + §3.7
 * + §12)。所有 schema 都是 public protocol —— client / API 边界共享。
 *
 * 设计原则：
 * - `url` 的 https + localhost(http://127.0.0.1|http://localhost) 允许
 *   规则由 domain 层 (`packages/domain/src/webhook/policy.ts`) 校验；
 *   这里 protocol 层只保证 URL 格式合法。
 * - `webhookEndpointResponseSchema` / `webhookDeliveryListItemSchema` 都不
 *   包含 `signingSecret` / `signingSecretEncrypted`（M7 plan §3.6
 *   anti-probe）。`webhookEndpointCreatedResponseSchema` 是 create 接口
 *   一次性返回明文 secret 的通道，list / detail / patch 都不返。
 * - `webhookDeliveryListItemSchema` 包含 `requestBodySizeBytes` 而不返
 *   `requestBody` 本体；完整 body 走 `webhookDeliveryDetailResponseSchema`。
 */
import { z } from "zod";

/**
 * M7 固定 webhook 事件类型枚举。`notification.failed` 的生产者在 M8
 * 接入 (M7 plan §1 "M7 不做" + §3.1)。
 *
 * 暴露为 `as const` tuple 以便 `domain/src/webhook/policy.ts` 派生
 * `WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]` —— 单一
 * 真源在 protocol，未来加 event type 只改一处。
 */
export const WEBHOOK_EVENT_TYPES = [
  "message.before_send",
  "message.after_send",
  "message.delivered",
  "message.read",
  "user.online",
  "user.offline",
  "notification.failed"
] as const;

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/**
 * `message.before_send` 超时策略。`allow_on_timeout` = 放行，
 * `reject_on_timeout` = 拒绝并返 `WEBHOOK_TIMEOUT`。
 */
export const webhookFailurePolicySchema = z.enum([
  "allow_on_timeout",
  "reject_on_timeout"
]);

export const webhookEndpointStatusSchema = z.enum(["active", "disabled"]);

export const webhookDeliveryStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "failed",
  "dead"
]);

/**
 * Console API `POST /tenants/:tenantId/apps/:appId/webhooks` 请求体。
 * `beforeSendFailurePolicy` / `beforeSendTimeoutMs` 是 endpoint 级
 * 列 (M7 plan §3.3 + migration 0010_m7_webhook_endpoint_policy.sql)，
 * 只在 endpoint 订阅 `message.before_send` 时 runtime 才会读；未订阅
 * 时即便设了值也不会被读到，所以协议层不做关联校验。
 */
export const createWebhookEndpointRequestSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine(
        (u) => u.startsWith("https://") || u.startsWith("http://"),
        { message: "url must use http:// or https:// scheme" }
      ),
    description: z.string().trim().max(500).optional(),
    eventTypes: z.array(webhookEventTypeSchema).min(1).max(20),
    beforeSendFailurePolicy: webhookFailurePolicySchema.optional(),
    beforeSendTimeoutMs: z.number().int().min(100).max(3000).optional(),
    enabled: z.boolean().optional()
  })
  .strict();

/**
 * Console API `PATCH /tenants/:tenantId/apps/:appId/webhooks/:endpointId`
 * 请求体 (M7 plan §7 Task 3)：所有字段 optional，但至少要传一个；
 * 未知字段仍被 strict 拒绝。
 *
 * **不包含 `enabled`** (review fix Medium)：disabled endpoint 是
 * 不可变墓碑，resurrect 走 M8 才会做的专门 reactivate 路径。protocol
 * 与 repository (`UpdateWebhookEndpointInput`) 契约一致 —— create
 * 时仍可传 `enabled`（影响初始 enabled 位），PATCH 不能再改 enabled。
 *
 * `rotateSigningSecret: true` 是 update 内的"轮换 signing secret"信号
 * —— API route 在收到 true 时生成新 secret 写入 DB，并随 PATCH
 * 响应返回一次明文 secret（response shape 与 create 相同）。`false`
 * / 其它值都拒绝，避免业务方误传 `false` 当成"不轮换"。
 */
export const updateWebhookEndpointRequestSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine(
        (u) => u.startsWith("https://") || u.startsWith("http://"),
        { message: "url must use http:// or https:// scheme" }
      )
      .optional(),
    description: z.string().trim().max(500).optional(),
    eventTypes: z.array(webhookEventTypeSchema).min(1).max(20).optional(),
    beforeSendFailurePolicy: webhookFailurePolicySchema.optional(),
    beforeSendTimeoutMs: z.number().int().min(100).max(3000).optional(),
    rotateSigningSecret: z.literal(true).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field is required"
  });

/**
 * `GET /tenants/:tenantId/apps/:appId/webhooks` list response 与
 * `GET .../webhooks/:endpointId` detail response 共享 shape。**绝不**
 * 包含 `signingSecret` / `signingSecretEncrypted`。
 */
export const webhookEndpointResponseSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string(),
    description: z.string().nullable(),
    eventTypes: z.array(webhookEventTypeSchema),
    beforeSendFailurePolicy: webhookFailurePolicySchema,
    beforeSendTimeoutMs: z.number().int().min(100).max(3000),
    enabled: z.boolean(),
    status: webhookEndpointStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

/**
 * `POST .../webhooks` create 与 `PATCH .../webhooks/:id`（传
 * `rotateSigningSecret: true` 时）共同使用的响应 shape —— **一次性**
 * 返回明文 signing secret。后续 list / detail 不再返明文。Console Web
 * 必须把明文 secret 写一次性提示 + 立刻丢弃，不能持久化。
 */
export const webhookEndpointCreatedResponseSchema =
  webhookEndpointResponseSchema
    .extend({
      signingSecret: z.string().min(1)
    })
    .strict();

/**
 * Path-level params for `.../webhooks/:endpointId` routes
 * (M7 plan §7 Task 3)。`:endpointId` 是 webhook endpoint 的 UUID，
 * tenant-scoped — 跨 tenant / cross-app 都会落到 404 (`WEBHOOK_ENDPOINT_NOT_FOUND`)。
 */
export const webhookEndpointIdParamSchema = z.object({
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  endpointId: z.string().uuid()
});

/**
 * Path-level params for `.../webhook-deliveries/:deliveryId` route
 * (M7 plan §12 Task 8)。`:deliveryId` 是 webhook delivery 的 UUID，
 * tenant-scoped — 跨 tenant / cross-app 都会落到 404 (`WEBHOOK_DELIVERY_NOT_FOUND`)。
 */
export const webhookDeliveryIdParamSchema = z.object({
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  deliveryId: z.string().uuid()
});

/**
 * `GET /tenants/:tenantId/apps/:appId/webhook-deliveries?status=...
 * &eventType=...&endpointId=...&cursor=...&limit=...` query 解析。
 * `limit` 范围 [1, 50]，默认 20；`status` / `eventType` / `endpointId`
 * 任意一个组合都可缺省。
 */
export const webhookDeliveryListQuerySchema = z
  .object({
    status: webhookDeliveryStatusSchema.optional(),
    eventType: webhookEventTypeSchema.optional(),
    endpointId: z.string().uuid().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict();

/**
 * Delivery list 单条。**不含** `requestBody` 本体 —— 完整 body 走
 * `webhookDeliveryDetailResponseSchema` 单独查，避免大 payload 撑爆
 * 列表响应 (M7 plan §12 S9)。
 */
export const webhookDeliveryListItemSchema = z
  .object({
    id: z.string().uuid(),
    endpointId: z.string().uuid(),
    eventId: z.string().min(1),
    eventType: webhookEventTypeSchema,
    status: webhookDeliveryStatusSchema,
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(0),
    lastResponseStatus: z.number().int().nullable(),
    lastError: z.string().nullable(),
    requestBodySizeBytes: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const webhookDeliveryListResponseSchema = z
  .object({
    items: z.array(webhookDeliveryListItemSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

/**
 * `GET .../webhook-deliveries/:deliveryId` detail —— 在 list shape
 * 基础上加 `requestBody: unknown`（payload 形状由 eventType 决定，
 * 协议层不限制；具体 shape 由 eventType 对应的 builder 决定）。
 */
export const webhookDeliveryDetailResponseSchema =
  webhookDeliveryListItemSchema.extend({
    requestBody: z.unknown()
  });

// ---------------------------------------------------------------------------
// Inferred types —— routes / repository / test code 复用，避免每处重写
// `z.infer`。
// ---------------------------------------------------------------------------

export type WebhookEndpointResponse = z.infer<typeof webhookEndpointResponseSchema>;
export type WebhookEndpointCreatedResponse = z.infer<
  typeof webhookEndpointCreatedResponseSchema
>;
export type WebhookDeliveryListResponse = z.infer<
  typeof webhookDeliveryListResponseSchema
>;
export type WebhookDeliveryListItem = z.infer<typeof webhookDeliveryListItemSchema>;
export type WebhookDeliveryDetailResponse = z.infer<
  typeof webhookDeliveryDetailResponseSchema
>;
export type CreateWebhookEndpointRequest = z.infer<
  typeof createWebhookEndpointRequestSchema
>;
export type UpdateWebhookEndpointRequest = z.infer<
  typeof updateWebhookEndpointRequestSchema
>;
export type WebhookDeliveryListQuery = z.infer<typeof webhookDeliveryListQuerySchema>;
export type WebhookDeliveryIdParam = z.infer<typeof webhookDeliveryIdParamSchema>;
