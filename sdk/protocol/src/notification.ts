import { z } from "zod";
import { externalUserIdSchema, uuidStringSchema } from "./ids";

export const NOTIFICATION_PROVIDER_NAMES = [
  "apns",
  "huawei_push",
  "wechat_miniprogram_subscribe",
  "wechat_official_account_template"
] as const;

export const NOTIFICATION_PROVIDER_RESERVED_NAMES = [
  "fcm",
  "sms",
  "email",
  "webhook"
] as const;

export const notificationProviderNameSchema = z.enum(NOTIFICATION_PROVIDER_NAMES);
export type NotificationProviderName = z.infer<
  typeof notificationProviderNameSchema
>;

export const apnsEnvironmentSchema = z.enum(["sandbox", "production"]);

export const apnsProviderConfigSchema = z
  .object({
    bundleId: z.string().trim().min(1).max(256),
    environment: apnsEnvironmentSchema
  })
  .strict();

export const apnsProviderCredentialsSchema = z
  .object({
    teamId: z.string().trim().min(1).max(32),
    keyId: z.string().trim().min(1).max(32),
    privateKeyPem: z.string().min(1).max(8192)
  })
  .strict();

export const huaweiCategorySchema = z.enum([
  "MARKETING",
  "IM",
  "VOIP",
  "MISS_CALL",
  "SUBSCRIPTION",
  "TRAVEL",
  "HEALTH",
  "WORK",
  "ACCOUNT",
  "EXPRESS",
  "FINANCE",
  "DEVICE_REMINDER",
  "MAIL"
]);

export const huaweiProviderConfigSchema = z
  .object({
    projectId: z.string().trim().min(1).max(64),
    category: huaweiCategorySchema.optional(),
    testMessage: z.boolean().optional(),
    ttlSeconds: z.number().int().min(1).max(1_296_000).optional(),
    foregroundShow: z.boolean().optional()
  })
  .strict();

export const huaweiProviderCredentialsSchema = z
  .object({
    keyId: z.string().trim().min(1).max(64),
    privateKey: z.string().min(1).max(8192),
    subAccount: z.string().trim().min(1).max(128),
    tokenUri: z
      .literal("https://oauth-login.cloud.huawei.com/oauth2/v3/token")
      .optional(),
    pushServerDomain: z.literal("push-api.cloud.huawei.com").optional()
  })
  .strict();

const nonEmptyObjectSchema = z
  .object({})
  .catchall(z.unknown())
  .refine((value) => Object.keys(value).length > 0, {
    message: "must be a non-empty object"
  });

export const wechatProviderConfigSchema = z
  .object({
    appId: z.string().trim().min(1).max(64),
    accessTokenMode: z.literal("stable_access_token").optional()
  })
  .strict();

export const wechatProviderCredentialsSchema = z
  .object({
    appSecret: z.string().min(1).max(512)
  })
  .strict();

const wechatNavigationFieldsSchema = {
  page: z.string().trim().min(1).max(1024).optional(),
  miniprogramState: z.enum(["developer", "trial", "formal"]).optional(),
  lang: z.string().trim().min(1).max(16).optional(),
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => u.startsWith("https://") || u.startsWith("http://"), {
      message: "url must use http:// or https:// scheme"
    })
    .optional(),
  miniprogram: z
    .object({
      appid: z.string().trim().min(1).max(64),
      pagepath: z.string().trim().min(1).max(1024)
    })
    .strict()
    .optional()
} as const;

/**
 * WeChat template keyword mapping entry.
 * `value` is a template string rendered at enqueue time
 * (e.g. `"{{summary}}"`); Worker only consumes the frozen result.
 */
export const wechatTemplateDataEntrySchema = z
  .object({
    value: z.string().min(1).max(1024)
  })
  .strict();

export const wechatTemplateDataMapSchema = z
  .record(z.string().min(1).max(64), wechatTemplateDataEntrySchema)
  .refine((value) => Object.keys(value).length <= 50, {
    message: "data may contain at most 50 keys"
  });

export const wechatTemplatePayloadSchema = z
  .object({
    ...wechatNavigationFieldsSchema,
    data: wechatTemplateDataMapSchema.optional()
  })
  .strict();

export type WechatTemplatePayload = z.infer<typeof wechatTemplatePayloadSchema>;

/**
 * Shared notification_templates.payload schema.
 * Navigation fields stay provider-specific extras; `data` is WeChat keyword mapping.
 */
export const notificationTemplatePayloadSchema = z
  .object({
    ...wechatNavigationFieldsSchema,
    data: wechatTemplateDataMapSchema.optional()
  })
  .strict();

export type NotificationTemplatePayload = z.infer<
  typeof notificationTemplatePayloadSchema
>;

export const notificationTemplateStatusSchema = z.enum(["active", "disabled"]);

export const WECHAT_NOTIFICATION_PROVIDERS = [
  "wechat_miniprogram_subscribe",
  "wechat_official_account_template"
] as const;

export type WechatNotificationProvider =
  (typeof WECHAT_NOTIFICATION_PROVIDERS)[number];

export function isWechatNotificationProvider(
  provider: string
): provider is WechatNotificationProvider {
  return (
    provider === "wechat_miniprogram_subscribe" ||
    provider === "wechat_official_account_template"
  );
}

/**
 * WeChat fixed templates require externalTemplateId (platform template_id)
 * whenever the template is created enabled / remains enabled.
 */
export function requiresWechatExternalTemplateId(
  provider: string,
  enabled: boolean
): boolean {
  return enabled && isWechatNotificationProvider(provider);
}

export const notificationTemplateResponseSchema = z
  .object({
    id: uuidStringSchema,
    provider: notificationProviderNameSchema,
    templateCode: z.string().min(1).max(128),
    externalTemplateId: z.string().nullable(),
    titleTemplate: z.string().nullable(),
    bodyTemplate: z.string(),
    contentSchema: z.unknown().nullable(),
    payload: notificationTemplatePayloadSchema.nullable(),
    enabled: z.boolean(),
    status: notificationTemplateStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type NotificationTemplateResponse = z.infer<
  typeof notificationTemplateResponseSchema
>;

export const createNotificationTemplateRequestSchema = z
  .object({
    provider: notificationProviderNameSchema,
    templateCode: z.string().min(1).max(128),
    externalTemplateId: z.string().trim().min(1).max(256).optional(),
    titleTemplate: z.string().trim().min(1).max(512).optional(),
    bodyTemplate: z.string().min(1).max(8192),
    contentSchema: z.unknown().nullable().optional(),
    payload: notificationTemplatePayloadSchema.nullable().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    // Create defaults to enabled=true (repository / route).
    if (
      requiresWechatExternalTemplateId(value.provider, true) &&
      (value.externalTemplateId === undefined ||
        value.externalTemplateId.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalTemplateId"],
        message:
          "externalTemplateId is required for WeChat providers when template is enabled"
      });
    }
  });

export type CreateNotificationTemplateRequest = z.infer<
  typeof createNotificationTemplateRequestSchema
>;

export const patchNotificationTemplateRequestSchema = z
  .object({
    externalTemplateId: z.string().trim().min(1).max(256).nullable().optional(),
    titleTemplate: z.string().trim().min(1).max(512).nullable().optional(),
    bodyTemplate: z.string().min(1).max(8192).optional(),
    contentSchema: z.unknown().nullable().optional(),
    payload: notificationTemplatePayloadSchema.nullable().optional(),
    enabled: z.boolean().optional()
  })
  .strict()
  .refine(
    (v) =>
      v.externalTemplateId !== undefined ||
      v.titleTemplate !== undefined ||
      v.bodyTemplate !== undefined ||
      v.contentSchema !== undefined ||
      v.payload !== undefined ||
      v.enabled !== undefined,
    { message: "at least one field must be provided" }
  );

export type PatchNotificationTemplateRequest = z.infer<
  typeof patchNotificationTemplateRequestSchema
>;

export const notificationTaskStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "failed",
  "dead"
]);
export type NotificationTaskStatus = z.infer<
  typeof notificationTaskStatusSchema
>;

export const notificationSkippedReasonSchema = z.enum([
  "template_missing",
  "template_missing_variable",
  "provider_config_missing",
  "target_missing"
]);
export type NotificationSkippedReason = z.infer<
  typeof notificationSkippedReasonSchema
>;

export const notificationProviderConfigResponseSchema = z
  .object({
    id: uuidStringSchema,
    provider: notificationProviderNameSchema,
    enabled: z.boolean(),
    config: z.unknown().nullable(),
    hasCredentials: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type NotificationProviderConfigResponse = z.infer<
  typeof notificationProviderConfigResponseSchema
>;

export const putNotificationProviderConfigRequestSchema = z
  .object({
    config: nonEmptyObjectSchema,
    credentials: nonEmptyObjectSchema,
    enabled: z.boolean().optional()
  })
  .strict();

export const patchNotificationProviderConfigRequestSchema = z
  .object({
    config: nonEmptyObjectSchema.optional(),
    enabled: z.boolean().optional()
  })
  .strict()
  .refine(
    (v) => v.config !== undefined || v.enabled !== undefined,
    { message: "at least one field must be provided" }
  );

export const notificationTaskListItemSchema = z
  .object({
    id: uuidStringSchema,
    provider: notificationProviderNameSchema,
    status: notificationTaskStatusSchema,
    receiverUserId: externalUserIdSchema,
    templateCode: z.string().nullable().optional(),
    retryCount: z.number().int().min(0),
    hasLastError: z.boolean(),
    lastErrorSummary: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type NotificationTaskListItem = z.infer<
  typeof notificationTaskListItemSchema
>;

export const notificationTaskListResponseSchema = z
  .object({
    items: z.array(notificationTaskListItemSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

export const listNotificationTasksQuerySchema = z
  .object({
    provider: notificationProviderNameSchema.optional(),
    status: notificationTaskStatusSchema.optional(),
    receiverUserId: externalUserIdSchema.optional(),
    templateCode: z.string().min(1).max(128).optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

export type ListNotificationTasksQuery = z.infer<
  typeof listNotificationTasksQuerySchema
>;

export const notificationTaskProviderResponseSchema = z
  .object({
    requestId: z.string().min(1).max(256).optional(),
    accepted: z.boolean().optional(),
    errorCode: z.string().min(1).max(128).optional(),
    errorMessage: z.string().min(1).max(1024).optional(),
    httpStatus: z.number().int().min(100).max(599).optional()
  })
  .strict();

export const notificationTaskDetailResponseSchema =
  notificationTaskListItemSchema.extend({
    providerResponse: notificationTaskProviderResponseSchema.nullable(),
    templateCode: z.string().min(1).max(128).nullable().optional(),
    deviceId: uuidStringSchema.nullable().optional(),
    channelId: uuidStringSchema.nullable().optional(),
    messageId: uuidStringSchema.nullable().optional(),
    retryCount: z.number().int().min(0),
    lastError: z.string().nullable().optional()
  });

export type NotificationTaskDetailResponse = z.infer<
  typeof notificationTaskDetailResponseSchema
>;

// ---------------------------------------------------------------------------
// Path param schemas
// ---------------------------------------------------------------------------

export const notificationProviderParamSchema = z.object({
  tenantId: uuidStringSchema,
  appId: uuidStringSchema,
  provider: notificationProviderNameSchema
});

export const notificationTemplateIdParamSchema = z.object({
  tenantId: uuidStringSchema,
  appId: uuidStringSchema,
  templateId: uuidStringSchema
});

export const notificationTaskIdParamSchema = z.object({
  tenantId: uuidStringSchema,
  appId: uuidStringSchema,
  taskId: uuidStringSchema
});

// ---------------------------------------------------------------------------
// Server API: notification channel upsert
// ---------------------------------------------------------------------------

// `serverAppPathParamSchema` 已在 server.ts 导出（preHandler 共享），
// notification-channels route 直接引用。

export const upsertNotificationChannelRequestSchema = z
  .object({
    userId: externalUserIdSchema,
    provider: z.enum([
      "wechat_miniprogram_subscribe",
      "wechat_official_account_template"
    ]),
    externalUserId: z.string().trim().min(1).max(128),
    externalUnionId: z.string().trim().min(1).max(128).optional(),
    address: z.string().trim().min(1).max(512).nullable().optional(),
    channelConfig: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .strict();

export type UpsertNotificationChannelRequest = z.infer<
  typeof upsertNotificationChannelRequestSchema
>;

export const notificationChannelUpsertResponseSchema = z
  .object({
    userId: externalUserIdSchema,
    provider: z.enum([
      "wechat_miniprogram_subscribe",
      "wechat_official_account_template"
    ]),
    externalUserId: z.string(),
    externalUnionId: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    channelConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.enum(["active", "disabled"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type NotificationChannelUpsertResponse = z.infer<
  typeof notificationChannelUpsertResponseSchema
>;
