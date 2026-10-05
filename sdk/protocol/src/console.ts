/**
 * Console API request/response Zod schemas for M2.
 *
 * Scope: console user registration / login / session, tenant management,
 * tenant member management, app management, app secret management.
 *
 * Conventions:
 * - All field names use `camelCase`; DB columns stay `snake_case` (Drizzle
 *   maps the conversion at the repository boundary).
 * - All timestamps are ISO 8601 UTC strings.
 * - Money/IDs/counts are strings or integers, never floats.
 * - Reusable primitives (email, password, IDs, pagination) come from the
 *   sibling files in this package.
 *
 * Path-level params (`tenantId`, `appId`, `secretId`, `userId`) are
 * exposed as separate small schemas so routes can compose them.
 */

import { z } from "zod";
import { uuidStringSchema, externalUserIdSchema } from "./ids";

// ---------------------------------------------------------------------------
// Console user (platform admin) — auth & session
// ---------------------------------------------------------------------------

/**
 * Email is normalized via `trim()` + `toLowerCase()` before any further
 * validation. This matches the behavior in `packages/domain` so the same
 * email string reaches the DB layer regardless of caller casing.
 */
export const consoleEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

/**
 * Password policy for console users (M2).
 * - Minimum 12 characters (defended against credential stuffing).
 * - Maximum 128 characters (defended against bcrypt / argon2 DoS).
 * No composition rules (uppercase / digit / symbol) in M2 — kept simple
 * and revieweable. Revisit if incident data justifies it.
 */
export const consolePasswordSchema = z
  .string()
  .min(12, "password must be at least 12 characters")
  .max(128, "password must be at most 128 characters");

export const consoleUserStatusSchema = z.enum(["active", "disabled"]);

export const registerConsoleUserRequestSchema = z.object({
  email: consoleEmailSchema,
  password: consolePasswordSchema
});

export const loginConsoleUserRequestSchema = z.object({
  email: consoleEmailSchema,
  password: z.string().min(1).max(128) // do not apply length rule on login
});

export const consoleUserResponseSchema = z.object({
  id: uuidStringSchema,
  email: consoleEmailSchema,
  status: consoleUserStatusSchema,
  createdAt: z.string().datetime()
});

export const registerConsoleUserResponseSchema = z.object({
  user: consoleUserResponseSchema
});

export const loginConsoleUserResponseSchema = z.object({
  user: consoleUserResponseSchema
});

export const logoutConsoleUserResponseSchema = z.object({
  data: z.null()
});

// ---------------------------------------------------------------------------
// Tenants & memberships
// ---------------------------------------------------------------------------

/**
 * Role in a tenant. Matches `tenant_members.role` text values. M1 did
 * not add a CHECK constraint (kept flexible). M2 introduces the 4-value
 * catalog including `viewer` as a read-only role; `packages/domain`
 * must validate at runtime and the API layer rejects other values.
 */
export const tenantRoleSchema = z.enum([
  "owner",
  "admin",
  "developer",
  "viewer"
]);

export const tenantStatusSchema = z.enum(["active", "disabled"]);

export const createTenantRequestSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const tenantResponseSchema = z.object({
  id: uuidStringSchema,
  name: z.string(),
  status: tenantStatusSchema,
  createdAt: z.string().datetime()
});

export const tenantMembershipSchema = z.object({
  tenantId: uuidStringSchema,
  tenantName: z.string(),
  role: tenantRoleSchema,
  createdAt: z.string().datetime()
});

/**
 * Response of `GET /api/console/auth/me`. Includes a computed
 * `defaultTenantId` so the frontend can land on a known tenant without
 * the user having to pick one. The server picks the earliest membership
 * (`createdAt asc`); `null` when the user has no memberships.
 */
export const meResponseSchema = z.object({
  user: consoleUserResponseSchema,
  memberships: z.array(tenantMembershipSchema),
  defaultTenantId: uuidStringSchema.nullable()
});

export const tenantMemberResponseSchema = z.object({
  userId: uuidStringSchema,
  email: consoleEmailSchema,
  role: tenantRoleSchema,
  createdAt: z.string().datetime()
});

export const addTenantMemberRequestSchema = z.object({
  email: consoleEmailSchema,
  role: tenantRoleSchema
});

export const updateTenantMemberRequestSchema = z.object({
  role: tenantRoleSchema
});

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export const appStatusSchema = z.enum(["active", "disabled"]);

/**
 * Public app key format generated server-side: `app_` + URL-safe id.
 * Validated here so request bodies and outbound errors use the same shape.
 */
export const appKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^app_[A-Za-z0-9_-]+$/, "invalid appKey format");

export const notificationContentPolicySchema = z.enum(["summary", "content"]);

/**
 * M2 business range: 1-365 days. The M1 DB CHECK allows `>= 0` to
 * preserve schema stability; this is the business rule we enforce at
 * the API/domain layer. See M2 plan § 6.3 + § 8.3.
 */
export const messageRetentionDaysSchema = z
  .number()
  .int()
  .min(1, "messageRetentionDays must be >= 1")
  .max(365, "messageRetentionDays must be <= 365");

export const createAppRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  messageRetentionDays: messageRetentionDaysSchema.optional(),
  notificationContentPolicy: notificationContentPolicySchema.optional()
});

export const updateAppRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    messageRetentionDays: messageRetentionDaysSchema.optional(),
    notificationContentPolicy: notificationContentPolicySchema.optional(),
    status: appStatusSchema.optional()
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.messageRetentionDays !== undefined ||
      value.notificationContentPolicy !== undefined ||
      value.status !== undefined,
    { message: "at least one field must be provided" }
  );

export const appResponseSchema = z.object({
  id: uuidStringSchema,
  tenantId: uuidStringSchema,
  name: z.string(),
  appKey: appKeySchema,
  status: appStatusSchema,
  messageRetentionDays: z.number().int(),
  notificationContentPolicy: notificationContentPolicySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const appListItemSchema = appResponseSchema;

// ---------------------------------------------------------------------------
// App secrets
// ---------------------------------------------------------------------------

export const appSecretStatusSchema = z.enum(["active", "disabled"]);

export const secretPrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^nxs_[A-Za-z0-9_-]+$/, "invalid secret prefix format");

export const createAppSecretRequestSchema = z.object({
  expiresAt: z.string().datetime().nullable().optional()
});

export const rotateAppSecretRequestSchema = z.object({
  disableOldSecretId: uuidStringSchema.optional()
});

/**
 * Listed / replayed secret metadata. **Must never include `secretHash`
 * or `plainText`**. Use `appSecretCreatedResponseSchema` for the
 * one-shot creation / rotation response that legitimately returns
 * `plainText`.
 */
/**
 * `.strict()` on purpose: the schema must REJECT (not silently strip) any
 * `secretHash` or `plainText` field a caller might accidentally include.
 * Stripping the hash would still let it reach the response layer. See
 * M2 plan § 6.4 + § 9.4 for the security rules this enforces.
 */
export const appSecretListItemSchema = z
  .object({
    id: uuidStringSchema,
    secretPrefix: secretPrefixSchema,
    status: appSecretStatusSchema,
    expiresAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime()
  })
  .strict();

export const appSecretListResponseSchema = z.array(appSecretListItemSchema);

/**
 * Response shape for `POST .../secrets` and `POST .../secrets:rotate`.
 * Carries the `plainText` exactly once; the client must display it
 * inside a "one-time" panel and never persist it.
 */
export const appSecretCreatedResponseSchema = z.object({
  secret: appSecretListItemSchema.extend({
    plainText: z.string().min(1).max(128)
  })
});

// ---------------------------------------------------------------------------
// Path param schemas
// ---------------------------------------------------------------------------

export const tenantIdParamSchema = z.object({
  tenantId: uuidStringSchema
});

export const tenantMemberPathSchema = z.object({
  tenantId: uuidStringSchema,
  userId: uuidStringSchema
});

export const appIdParamSchema = z.object({
  tenantId: uuidStringSchema,
  appId: uuidStringSchema
});

export const appSecretIdParamSchema = z.object({
  tenantId: uuidStringSchema,
  appId: uuidStringSchema,
  secretId: uuidStringSchema
});

// ---------------------------------------------------------------------------
// Inferred types (for service / repository layers that don't want to
// re-derive shapes via z.infer locally).
// ---------------------------------------------------------------------------

export type ConsoleUserStatus = z.infer<typeof consoleUserStatusSchema>;
export type TenantRole = z.infer<typeof tenantRoleSchema>;
export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type AppStatus = z.infer<typeof appStatusSchema>;
export type AppSecretStatus = z.infer<typeof appSecretStatusSchema>;
export type NotificationContentPolicy = z.infer<
  typeof notificationContentPolicySchema
>;

export type RegisterConsoleUserRequest = z.infer<
  typeof registerConsoleUserRequestSchema
>;
export type LoginConsoleUserRequest = z.infer<
  typeof loginConsoleUserRequestSchema
>;
export type ConsoleUserResponse = z.infer<typeof consoleUserResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;

export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;
export type TenantResponse = z.infer<typeof tenantResponseSchema>;
export type TenantMembership = z.infer<typeof tenantMembershipSchema>;
export type TenantMemberResponse = z.infer<typeof tenantMemberResponseSchema>;
export type AddTenantMemberRequest = z.infer<
  typeof addTenantMemberRequestSchema
>;
export type UpdateTenantMemberRequest = z.infer<
  typeof updateTenantMemberRequestSchema
>;

export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;
export type UpdateAppRequest = z.infer<typeof updateAppRequestSchema>;
export type AppResponse = z.infer<typeof appResponseSchema>;
export type AppListItem = z.infer<typeof appListItemSchema>;

export type CreateAppSecretRequest = z.infer<
  typeof createAppSecretRequestSchema
>;
export type RotateAppSecretRequest = z.infer<
  typeof rotateAppSecretRequestSchema
>;
export type AppSecretListItem = z.infer<typeof appSecretListItemSchema>;
export type AppSecretCreatedResponse = z.infer<
  typeof appSecretCreatedResponseSchema
>;

// External user ID is the same primitive used by IM (M3+). Re-exported
// for service code that wants to type a single identifier consistently.
export { externalUserIdSchema };

// ---------------------------------------------------------------------------
// Audit Logs list (M10 Task 10) — read-only Console API
// ---------------------------------------------------------------------------

/**
 * GET /tenants/:tenantId/audit-logs query.
 * Offset cursor; limit [1, 50] default 20. Strict: unknown fields rejected.
 */
export const auditLogListQuerySchema = z
  .object({
    appId: uuidStringSchema.optional(),
    action: z.string().min(1).max(256).optional(),
    targetType: z.string().min(1).max(128).optional(),
    actorType: z.enum(["console_user", "app", "system"]).optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict();

export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

/**
 * List item. `metadata` is whatever the write path already filtered via
 * `buildAuditMetadata` — list schema does NOT re-whitelist fields.
 */
export const auditLogListItemSchema = z
  .object({
    id: uuidStringSchema,
    tenantId: uuidStringSchema,
    appId: uuidStringSchema.nullable(),
    actorType: z.enum(["console_user", "app", "system"]),
    actorId: uuidStringSchema.nullable(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string().datetime()
  })
  .strict();

export type AuditLogListItem = z.infer<typeof auditLogListItemSchema>;

/**
 * Response `data` is the items array; envelope uses shared Console
 * `{ requestId, data, page: { limit, nextCursor, hasMore } }`.
 */
export const auditLogListResponseSchema = z
  .object({
    items: z.array(auditLogListItemSchema),
    page: z
      .object({
        limit: z.number().int().min(1).max(50),
        nextCursor: z.string().nullable(),
        hasMore: z.boolean()
      })
      .strict()
  })
  .strict();

export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;
