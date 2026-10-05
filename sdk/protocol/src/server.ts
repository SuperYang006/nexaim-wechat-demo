/**
 * Server API (HMAC-authenticated) Zod schemas for M3.
 *
 * Scope: business-server-to-NexaIM Server API for IM user / device
 * upsert and IM Token issuance. WebSocket-only schemas live in `./ws`.
 *
 * Conventions (mirror `console.ts`):
 * - All field names use `camelCase`; DB columns stay `snake_case`.
 * - All timestamps are ISO 8601 UTC strings.
 * - Path params exposed as small composable schemas.
 * - Response schemas MUST NOT expose internal `im_users.id` /
 *   `conversations.id` to business callers. Callers identify users by
 *   `userId` (their `externalUserId`) and messages by `serverMessageId`.
 * - REQUEST schemas use `.strict()` on purpose: extra fields (e.g. a
 *   caller attempting to set `tenantId` or an internal `imUserId`)
 *   must fail Zod parsing with a hard error instead of being silently
 *   stripped. The route layer maps the ZodError to a 422
 *   `VALIDATION_FAILED` response. See M3 plan § 11 security checklist
 *   item 1 ("Server API 不信任 body/path 中的 tenantId").
 * - RESPONSE schemas do NOT use `.strict()` so the API layer can add
 *   future additive fields without breaking old callers (per
 *   docs/API接口设计规范.md § 7).
 */

import { z } from "zod";
import { externalUserIdSchema, uuidStringSchema } from "./ids";

// ---------------------------------------------------------------------------
// Common enums
// ---------------------------------------------------------------------------

export const imUserStatusSchema = z.enum(["active", "disabled"]);
export type ImUserStatus = z.infer<typeof imUserStatusSchema>;

/**
 * Device platform enum. MUST stay in lock-step with
 * `packages/db` `devices.platform` enum — see
 * `packages/db/src/schema/identity.ts` line 81 + the
 * `devices_platform_check` check constraint (M1 migration
 * `0002_devices`). The DB enum currently is
 * `ios | android | harmonyos | web | desktop`:
 * - `harmonyos` was added in M1 (architecture § 6.1) to cover Huawei
 *   devices.
 * - `desktop` was added alongside `harmonyos` for Electron-style
 *   native shells that behave like a desktop client but still talk the
 *   WebSocket protocol.
 */
export const devicePlatformSchema = z.enum([
  "ios",
  "android",
  "harmonyos",
  "web",
  "desktop"
]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/**
 * M3 protocol version. M3 only ships `1.0`; the field MUST be present
 * so future versions can branch explicitly. Update in lock-step with
 * `webSocketConnectQuerySchema.protocolVersion` in `./ws`.
 */
export const protocolVersionSchema = z.literal("1.0");
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

/**
 * `/api/server/apps/:appId/...` path param. The `:appId` here MUST
 * match the app resolved from the HMAC signature (M3 plan § 6.1
 * behaviour note + § 11 security checklist item 2); a mismatch returns
 * 404 `APP_NOT_FOUND`. Routes must compose this with their own
 * additional params when needed.
 */
export const serverAppPathParamSchema = z.object({
  appId: uuidStringSchema
});

/**
 * `/api/server/apps/:appId/groups/:groupId` path params. The
 * `:groupId` is the *business-side* `groups.id` UUID (server-issued
 * via `POST /groups`), NOT `conversations.id` — the public surface
 * of M5 groups is `groupId`-keyed. Composed with
 * `serverAppPathParamSchema` (which the preHandler validates
 * separately for HMAC).
 */
export const groupPathParamSchema = z.object({
  appId: uuidStringSchema,
  groupId: uuidStringSchema
});

/**
 * `/api/server/apps/:appId/groups/:groupId/members/:userId` path
 * params. The `:userId` here is the business `externalUserId`
 * (NOT the internal `im_users.id`) — same convention as M3
 * `im-users:upsert`. The route layer resolves it to an internal id
 * via the `im_users` lookup; an unknown user is surface as 404
 * `USER_NOT_FOUND` (per M5 plan §3.2).
 */
export const groupMemberPathParamSchema = z.object({
  appId: uuidStringSchema,
  groupId: uuidStringSchema,
  userId: externalUserIdSchema
});

// ---------------------------------------------------------------------------
// IM user upsert
// ---------------------------------------------------------------------------

/**
 * `POST /api/server/apps/:appId/im-users:upsert`
 *
 * `userId` is the business-side external user identifier and is stored
 * as `im_users.external_user_id`. Display fields are optional on
 * update so a later call can patch name / avatar without resending
 * every field.
 *
 * `tenantId` is intentionally NOT part of the request body: the route
 * resolves `tenantId` from the HMAC-signed app (M3 plan § 6.1
 * "不允许业务服务端指定 tenantId"). Cross-app isolation is enforced at
 * the repository layer (`packages/db` `AppScope`).
 */
export const upsertImUserRequestSchema = z
  .object({
    userId: externalUserIdSchema,
    displayName: z.string().trim().min(1).max(128).optional(),
    avatarUrl: z.string().url().max(2048).optional()
  })
  .strict();
export type UpsertImUserRequest = z.infer<typeof upsertImUserRequestSchema>;

export const imUserResponseSchema = z.object({
  userId: externalUserIdSchema,
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  status: imUserStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ImUserResponse = z.infer<typeof imUserResponseSchema>;

export const upsertImUserResponseDataSchema = z.object({
  user: imUserResponseSchema
});
export type UpsertImUserResponseData = z.infer<
  typeof upsertImUserResponseDataSchema
>;

// ---------------------------------------------------------------------------
// Device upsert
// ---------------------------------------------------------------------------

/**
 * `POST /api/server/apps/:appId/devices:upsert`
 *
 * If the IM user does not yet exist, M3 plan § 6.2 lets the Server
 * API create a minimal `active` user: the request itself is HMAC
 * signed by the app, which counts as business-side authorization to
 * onboard the user. This is explicit and asymmetric with
 * `message.send`, which MUST NOT auto-create the recipient (M3 plan
 * § 3.0 + § 7.3 step 1).
 *
 * `pushToken` may be null when the client hasn't obtained an APNs /
 * FCM / HMS token yet. M8 will wire it into notification channels.
 */
export const upsertDeviceRequestSchema = z
  .object({
    userId: externalUserIdSchema,
    deviceId: z.string().trim().min(1).max(128),
    platform: devicePlatformSchema,
    pushToken: z.string().min(1).max(4096).nullable().optional()
  })
  .strict();
export type UpsertDeviceRequest = z.infer<typeof upsertDeviceRequestSchema>;

export const deviceResponseSchema = z.object({
  userId: externalUserIdSchema,
  deviceId: z.string(),
  platform: devicePlatformSchema,
  online: z.boolean(),
  lastConnectedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type DeviceResponse = z.infer<typeof deviceResponseSchema>;

export const upsertDeviceResponseDataSchema = z.object({
  device: deviceResponseSchema
});
export type UpsertDeviceResponseData = z.infer<
  typeof upsertDeviceResponseDataSchema
>;

// ---------------------------------------------------------------------------
// IM Token issuance
// ---------------------------------------------------------------------------

/**
 * `POST /api/server/apps/:appId/im-token`
 *
 * Resolves user + device (creating minimal ones per M3 plan § 6.3),
 * checks both are `active`, and signs an IM Token JWT whose claims
 * include `appKey / appId / userId / deviceId / protocolVersion`
 * (M3 plan § 3 + § 7.1). `expiresIn` mirrors the JWT `exp - iat`
 * window so the client knows when to refresh.
 *
 * `protocolVersion` is required so future versions can branch
 * explicitly. M3 only ships `1.0`.
 */
export const issueImTokenRequestSchema = z
  .object({
    userId: externalUserIdSchema,
    deviceId: z.string().trim().min(1).max(128),
    platform: devicePlatformSchema,
    protocolVersion: protocolVersionSchema
  })
  .strict();
export type IssueImTokenRequest = z.infer<typeof issueImTokenRequestSchema>;

export const imTokenResponseDataSchema = z.object({
  token: z.string().min(1),
  expiresIn: z.number().int().positive(),
  user: z.object({
    userId: externalUserIdSchema,
    status: imUserStatusSchema
  }),
  device: z.object({
    deviceId: z.string(),
    platform: devicePlatformSchema
  })
});
export type ImTokenResponse = z.infer<typeof imTokenResponseDataSchema>;

// ---------------------------------------------------------------------------
// M5: groups + broadcasts (Server API)
// ---------------------------------------------------------------------------
//
// Server API additions for M5 (`docs/milestones/M5-group与broadcast开发计划.md`
// §3.2 + §3.3). Conventions:
// - All request schemas use `.strict()` per the M3 convention above;
//   the route layer maps ZodError to 422 `VALIDATION_FAILED`.
// - Response schemas do NOT use `.strict()` so additive fields can be
//   added without breaking callers (docs/API接口设计规范.md §7).
// - `userId` is always business-side `externalUserId`; internal
//   `im_users.id` is NEVER exposed in response data (mirrors the M3
//   invariant for `imUserResponseSchema`).
// - Group / broadcast rows are server-driven (Server API only); the
//   WebSocket wire never sends a broadcast frame. Owner is the only
//   broadcast sender role in M5 (M5 plan §2.8).

/**
 * Group conversation role. Distinct from
 * `conversation_members.role` (which also has `"receiver"` for
 * broadcast receiver roles). For group / broadcast owner-only M5,
 * only `owner` matters for send permission, but `admin` is kept here
 * for PATCH member role API symmetry; the repository layer enforces
 * the actual last-owner guard.
 */
export const groupRoleSchema = z.enum(["owner", "admin", "member"]);
export type GroupRole = z.infer<typeof groupRoleSchema>;

/**
 * Group status. `disabled` freezes the group (no new sends, no
 * member add/remove, no PATCH except `status` itself) but historical
 * messages remain syncable for members still in
 * `conversation_members` (M5 plan §3.2).
 */
export const groupStatusSchema = z.enum(["active", "disabled"]);
export type GroupStatus = z.infer<typeof groupStatusSchema>;

/**
 * Broadcast receiver visibility. M5 only ships `"hidden"` — receivers
 * never see each other. Future values (e.g. `"manager_visible"`) land
 * in a later milestone; the schema is intentionally `.literal`-bound
 * here so accidental new values fail parsing at the route boundary.
 */
export const broadcastReceiverVisibilitySchema = z.literal("hidden");
export type BroadcastReceiverVisibility = z.infer<
  typeof broadcastReceiverVisibilitySchema
>;

/**
 * `message_dispatch_tasks.status` — Worker-side DB truth.
 *
 * This enum is the raw status of the dispatch row in PostgreSQL
 * (mirrors the `message_dispatch_tasks_status_check` constraint,
 * M1 schema). It is exposed in the broadcast send response
 * `dispatchTask.status` snapshot (M5 plan §3.3) and any internal
 * Worker log/audit context, but the `GET /broadcasts/:messageId/progress`
 * public endpoint does NOT surface this enum — the public progress
 * shape uses `broadcastProgressStatusSchema` below (pending-first
 * lifecycle for caller ergonomics).
 *
 * `queued`   — task row inserted by the Server API; Worker has not
 *              yet claimed it.
 * `running`  — Worker claimed the row via SKIP LOCKED and is actively
 *              draining receivers.
 * `success`  — terminal: processed_count == total_count, no failures.
 * `failed`   — terminal: at least one receiver failed; partial progress
 *              preserved; retry path TBD (M5 does not expose a recovery
 *              endpoint).
 * `dead`     — terminal: exhausted `max_retries` without success.
 */
export const dispatchTaskStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "failed",
  "dead"
]);
export type DispatchTaskStatus = z.infer<typeof dispatchTaskStatusSchema>;

/**
 * Public `GET /broadcasts/:messageId/progress` status — caller-facing
 * lifecycle of `broadcast_delivery_stats.status`, the source of truth
 * for progress (M5 plan §2.9 + §3.4 step 5).
 *
 * Distinct from `dispatchTaskStatusSchema`:
 *  - `pending` here vs `queued` there: progress is "pending" until
 *    the Worker first writes stats; dispatch tasks are "queued" from
 *    the moment the API creates the row.
 *  - No `dead` here: progress row always reaches a `success` / `failed`
 *    terminal — the dispatch task row is what tracks retry exhaustion.
 *  - This enum is the ONLY status set the public progress endpoint
 *    returns; callers must not assume the dispatch task row mirrors it
 *    1:1 (the Worker keeps both rows in sync, M5 plan §3.4).
 */
export const broadcastProgressStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed"
]);
export type BroadcastProgressStatus = z.infer<
  typeof broadcastProgressStatusSchema
>;

// ---------------------------------------------------------------------------
// M5: groups CRUD
// ---------------------------------------------------------------------------

/**
 * `POST /api/server/apps/:appId/groups`
 *
 * M5 plan §3.2. `name` is required; `description` and `maxMembers`
 * are optional. `ownerUserId` MUST be included in `memberUserIds`
 * (enforced at the route layer; the schema does NOT enforce it
 * because the two fields are sourced independently and the route
 * layer raises `VALIDATION_FAILED` with a stable message). The
 * repository layer must create `conversations / groups / group_members /
 * conversation_members` in one transaction; the schema intentionally
 * does not model the `groups` table internal columns (`id`,
 * `conversation_id`, timestamps, `status`) since those are
 * server-generated.
 */
export const createGroupRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ownerUserId: externalUserIdSchema,
    // `memberUserIds` MUST contain the owner (asserted at the domain
    // layer via `assertOwnerIncluded`) and MUST NOT contain duplicates
    // — duplicates bypass the repository's `Set` dedupe and would
    // duplicate INSERT into `group_members` / `conversation_members`,
    // violating the `(group_id, im_user_id)` unique constraint and
    // surfacing as a 500 / `unique_violation`. Pre-reject at the wire
    // boundary so callers get a stable 422 `VALIDATION_FAILED` instead
    // (Task 4 review Bug-2).
    memberUserIds: z
      .array(externalUserIdSchema)
      .min(1)
      .max(500)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "memberUserIds must not contain duplicates"
      ),
    description: z.string().trim().min(1).max(2048).optional(),
    maxMembers: z.number().int().positive().max(10000).optional()
  })
  .strict();
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

/**
 * `PATCH /api/server/apps/:appId/groups/:groupId`
 *
 * M5 plan §3.2. All fields optional; the route layer enforces
 * `maxMembers >= current member_count` (otherwise 422
 * `VALIDATION_FAILED`). `status` flips the group between `active` and
 * `disabled`; disabled groups reject new sends + new member changes
 * but remain syncable for current members.
 */
export const updateGroupRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(2048).optional(),
    status: groupStatusSchema.optional(),
    maxMembers: z.number().int().positive().max(10000).optional()
  })
  .strict();
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

/**
 * `POST /api/server/apps/:appId/groups/:groupId/members` — add-only.
 *
 * M5 plan §3.2 D1 split: POST is add-only; existing members MUST be
 * updated via PATCH `.../members/:userId` (returns 409
 * `GROUP_MEMBER_ALREADY_EXISTS` here if any requested `userId` is
 * already a member, regardless of role). **Atomic batch**: when ANY
 * conflict is detected, NO members are inserted (all-or-nothing).
 * Partial insert + 409 would leave the DB dirty while the API says
 * nothing happened — the repository pre-checks via SELECT existing
 * and only INSERTs when zero conflicts; race window closes via the
 * unique constraint on `(group_id, im_user_id)` with rollback on
 * `unique_violation`. The route layer validates that all `userIds`
 * resolve to active IM users (else 404 `USER_NOT_FOUND`) and that
 * the post-add `member_count <= groups.max_members` when
 * `maxMembers` is set (else 422 `VALIDATION_FAILED`).
 */
export const addGroupMembersRequestSchema = z
  .object({
    // Same dedupe guard as `createGroupRequestSchema.memberUserIds`:
    // duplicate `members[].userId` in a single request would
    // otherwise bypass the in-DB conflict precheck (Task 4 review
    // Bug-3) and the second INSERT would hit `(group_id, im_user_id)`
    // unique constraint → `unique_violation` → 500. Pre-reject 422 at
    // the wire boundary.
    members: z
      .array(
        z
          .object({
            userId: externalUserIdSchema,
            role: groupRoleSchema
          })
          .strict()
      )
      .min(1)
      .max(500)
      .refine(
        (ms) => new Set(ms.map((m) => m.userId)).size === ms.length,
        "members[].userId must not contain duplicates"
      )
  })
  .strict();
export type AddGroupMembersRequest = z.infer<
  typeof addGroupMembersRequestSchema
>;

/**
 * `PATCH /api/server/apps/:appId/groups/:groupId/members/:userId`
 *
 * M5 plan §3.2. Path `:userId` is the business-side `externalUserId`
 * (NOT the internal `im_users.id`). The route layer enforces the
 * last-owner guard: downgrading the final owner returns 409
 * `GROUP_LAST_OWNER_REQUIRED`.
 */
export const updateGroupMemberRequestSchema = z
  .object({
    role: groupRoleSchema
  })
  .strict();
export type UpdateGroupMemberRequest = z.infer<
  typeof updateGroupMemberRequestSchema
>;

// ---------------------------------------------------------------------------
// M5: broadcasts
// ---------------------------------------------------------------------------

/**
 * `POST /api/server/apps/:appId/broadcasts`
 *
 * M5 plan §3.3. Creates a `conversations(type='broadcast')` row plus
 * an owner `conversation_members(role='owner')` row in one transaction.
 * `conversations.member_count` starts at 1; receivers:import bumps it.
 * `receiverVisibility` is fixed to `"hidden"` in M5 to guarantee
 * receivers cannot see each other (M5 plan §2.2 + architecture §6.6).
 */
export const createBroadcastRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    ownerUserId: externalUserIdSchema,
    settings: z
      .object({
        receiverVisibility: broadcastReceiverVisibilitySchema
      })
      .strict()
  })
  .strict();
export type CreateBroadcastRequest = z.infer<
  typeof createBroadcastRequestSchema
>;

/**
 * `POST /api/server/apps/:appId/broadcasts/:conversationId/receivers:import`
 *
 * M5 plan §3.3. Single import capped at 1000 userIds (constant
 * `BROADCAST_MAX_IMPORT_USERS` in `packages/domain/src/broadcast.ts`).
 * Upsert is idempotent — re-importing the same `userId` is a no-op
 * (the route returns `skippedCount > 0`). The full receiver list is
 * NEVER returned in any response to avoid accidental misuse as a
 * "broadcast member list" endpoint.
 */
export const importBroadcastReceiversRequestSchema = z
  .object({
    userIds: z.array(externalUserIdSchema).min(1).max(1000)
  })
  .strict();
export type ImportBroadcastReceiversRequest = z.infer<
  typeof importBroadcastReceiversRequestSchema
>;

/**
 * `POST /api/server/apps/:appId/broadcasts/:conversationId/messages`
 *
 * M5 plan §3.3。`ownerUserId` 必须是 conversation owner；路由层
 * 在不是的情况下返回 403 `PERMISSION_DENIED`。`messageType` 在
 * M6 仍是 `.literal("text")` —— broadcast 不接收 image / file
 * （M6 plan §1 + §3.3）。`clientMessageId` 是幂等键：同一
 * `(appId, ownerImUserId,
 * clientMessageId)` 重新 POST 时返回已存在的 message 行，不再
 * 重建 dispatch task。`messages.senderType` 是 `"system"`
 * （M5 plan §3.3），参见 architecture §7.4 的约定。
 *
 * `batchSize` defaults to `BROADCAST_DEFAULT_BATCH_SIZE = 100` and is
 * capped at `BROADCAST_MAX_BATCH_SIZE = 1000`. The route layer passes
 * the resolved value to `message_dispatch_tasks.batch_size`.
 */
export const sendBroadcastMessageRequestSchema = z
  .object({
    clientMessageId: z.string().trim().min(1).max(128),
    ownerUserId: externalUserIdSchema,
    messageType: z.literal("text"),
    content: z
      .object({
        text: z.string().trim().min(1).max(8192)
      })
      .strict(),
    batchSize: z.number().int().min(1).max(1000).optional()
  })
  .strict();
export type SendBroadcastMessageRequest = z.infer<
  typeof sendBroadcastMessageRequestSchema
>;

/**
 * `GET /api/server/apps/:appId/broadcasts/:messageId/progress`
 *
 * M5 plan §3.3. `messageId` in path is the internal `messages.id`
 * UUID (NOT a wire-level `serverMessageId` alias — the wire concept
 * and the DB concept happen to coincide today, but the API contract
 * ties progress to the DB row). `ownerUserId` is REQUIRED as a
 * query param and must be the broadcast conversation owner (else
 * 403 `PERMISSION_DENIED`). The response source of truth is
 * `broadcast_delivery_stats`, NOT `message_dispatch_tasks` (the
 * latter is a Worker-internal snapshot, see M5 plan §2.9).
 *
 * `.strict()` per the M3 Server API request convention: callers must
 * NOT be able to smuggle `tenantId` / `imUserId` / etc. through the
 * query string (M3 plan § 11 security checklist item 1).
 */
export const broadcastProgressQuerySchema = z
  .object({
    ownerUserId: externalUserIdSchema
  })
  .strict();
export type BroadcastProgressQuery = z.infer<
  typeof broadcastProgressQuerySchema
>;

/**
 * `/api/server/apps/:appId/broadcasts/:conversationId/...` path
 * params (used by `receivers:import` + `messages` POSTs). The
 * `:conversationId` is the `conversations.id` UUID; M5 confines
 * `conversations.type='broadcast'` to this route sub-tree (group
 * routes use `conversations.id` via `:groupId` + a JOIN at the
 * repository layer — different convention, different path).
 *
 * Composed with `serverAppPathParamSchema` for HMAC; the
 * `requireServerApp` preHandler already enforces `path :appId
 * equals ctx.appId`.
 */
export const broadcastConversationPathParamSchema = z.object({
  appId: uuidStringSchema,
  conversationId: uuidStringSchema
});

/**
 * `/api/server/apps/:appId/broadcasts/:messageId/progress` path
 * params. `:messageId` is the *internal* `messages.id` UUID (NOT
 * the wire-level `serverMessageId`). The Progress endpoint
 * projects progress against the DB row, so the wire/DB alias
 * distinction matters for future-back-compat reasons.
 */
export const broadcastProgressPathParamSchema = z.object({
  appId: uuidStringSchema,
  messageId: uuidStringSchema
});

// ---------------------------------------------------------------------------
// M5: response data shapes
// ---------------------------------------------------------------------------

/**
 * Group row returned by `POST /groups` + `PATCH /groups/:groupId`.
 * No `.strict()` so additive columns (e.g. `settings` echo) can land
 * later without breaking callers.
 *
 * `memberCount` mirrors `conversations.member_count` (NOT a
 * `groups` column). `description` / `maxMembers` may be null when the
 * caller did not set them.
 */
export const groupResponseSchema = z.object({
  id: uuidStringSchema,
  conversationId: uuidStringSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  ownerUserId: externalUserIdSchema,
  maxMembers: z.number().int().positive().nullable().optional(),
  memberCount: z.number().int().nonnegative(),
  status: groupStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type GroupResponse = z.infer<typeof groupResponseSchema>;

export const createGroupResponseDataSchema = z.object({
  group: groupResponseSchema
});
export type CreateGroupResponseData = z.infer<
  typeof createGroupResponseDataSchema
>;

export const updateGroupResponseDataSchema = z.object({
  group: groupResponseSchema
});
export type UpdateGroupResponseData = z.infer<
  typeof updateGroupResponseDataSchema
>;

/**
 * Group member row returned by `POST /groups/:groupId/members` (the
 * newly added rows) + `PATCH .../members/:userId`. `joinedAt` is the
 * `group_members.joined_at`; `updatedAt` is only present on PATCH
 * responses since POST rows have `updated_at = created_at`.
 */
export const groupMemberResponseSchema = z.object({
  userId: externalUserIdSchema,
  role: groupRoleSchema,
  joinedAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional()
});
export type GroupMemberResponse = z.infer<typeof groupMemberResponseSchema>;

export const addGroupMembersResponseDataSchema = z.object({
  members: z.array(groupMemberResponseSchema)
});
export type AddGroupMembersResponseData = z.infer<
  typeof addGroupMembersResponseDataSchema
>;

export const updateGroupMemberResponseDataSchema = z.object({
  member: groupMemberResponseSchema
});
export type UpdateGroupMemberResponseData = z.infer<
  typeof updateGroupMemberResponseDataSchema
>;

/**
 * `POST /broadcasts` response.
 */
export const broadcastResponseSchema = z.object({
  conversationId: uuidStringSchema,
  title: z.string(),
  ownerUserId: externalUserIdSchema,
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type BroadcastResponse = z.infer<typeof broadcastResponseSchema>;

export const createBroadcastResponseDataSchema = z.object({
  broadcast: broadcastResponseSchema
});
export type CreateBroadcastResponseData = z.infer<
  typeof createBroadcastResponseDataSchema
>;

/**
 * `POST /broadcasts/:conversationId/receivers:import` response.
 *
 * `importedCount` = newly inserted members this call.
 * `skippedCount` = already-existing members (idempotent upsert).
 * `memberCount` = `conversations.member_count` after the transaction.
 */
export const importBroadcastReceiversResponseDataSchema = z.object({
  importedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative()
});
export type ImportBroadcastReceiversResponseData = z.infer<
  typeof importBroadcastReceiversResponseDataSchema
>;

/**
 * `POST /broadcasts/:conversationId/messages` response.
 *
 * `message` mirrors the M3 `messageSendAckPayloadSchema` shape
 * (serverMessageId, conversationSeq, etc.) so broadcast senders can
 * reuse the same client-side ack handler.
 * `dispatchTask` is a snapshot of the freshly created
 * `message_dispatch_tasks` row at creation time — Worker progress
 * updates land in `broadcast_delivery_stats`, NOT here (M5 plan §2.9).
 */
export const sendBroadcastMessageResponseDataSchema = z.object({
  message: z.object({
    conversationId: uuidStringSchema,
    /**
     * Internal `messages.id` UUID — the dispatch + progress key.
     * Per M5 plan §3.3 the `GET /broadcasts/:messageId/progress`
     * path uses this internal id (NOT the public `serverMessageId`
     * alias). Surfacing it on the send response lets callers fetch
     * progress without an extra lookup. Pair with `serverMessageId`
     * (the public-facing stable alias used by sync / receipts).
     */
    messageId: uuidStringSchema,
    serverMessageId: uuidStringSchema,
    clientMessageId: z.string(),
    conversationSeq: z.number().int().positive(),
    status: z.literal("sent"),
    createdAt: z.string().datetime()
  }),
  dispatchTask: z.object({
    id: uuidStringSchema,
    status: dispatchTaskStatusSchema,
    totalCount: z.number().int().nonnegative(),
    processedCount: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative()
  })
});
export type SendBroadcastMessageResponseData = z.infer<
  typeof sendBroadcastMessageResponseDataSchema
>;

/**
 * `GET /broadcasts/:messageId/progress` response.
 *
 * Source of truth: `broadcast_delivery_stats` row updated by the
 * Worker in the same transaction as `message_dispatch_tasks`
 * counters (M5 plan §3.4 step 5). `pendingCount` is the derived
 * `totalCount - processedCount` invariant — the DB check constraint
 * `processed_count + pending_count == total_count` is enforced at
 * write time but the API projects both so callers do not have to
 * recompute.
 */
export const broadcastProgressResponseDataSchema = z.object({
  messageId: uuidStringSchema,
  status: broadcastProgressStatusSchema,
  totalCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});
export type BroadcastProgressResponseData = z.infer<
  typeof broadcastProgressResponseDataSchema
>;

// ---------------------------------------------------------------------------
// M6: Client Media API
// ---------------------------------------------------------------------------
//
// `/api/client/...` Bearer IM Token authenticated schemas (M6 plan
// §3.1). Conventions follow the M3 Server API rules:
//  - REQUEST schemas use `.strict()` so a caller cannot smuggle
//    `tenantId` / `appId` / `imUserId` etc. through the body.
//  - RESPONSE schemas do NOT use `.strict()` so additive fields can
//    land later without breaking callers (docs/API接口设计规范.md §7).
//  - All timestamps are ISO 8601 UTC strings.
//  - Field names use `camelCase`; DB columns stay `snake_case`.
//  - `mediaAssetId` is the internal `media_assets.id` UUID — the
//    same identifier the WebSocket Gateway's `message.send` media
//    content references (plan §3.2). M6 deliberately exposes this
//    internal id on the Client API surface so the WebSocket client
//    can pass it directly to `message.send` after `complete`.

/**
 * M6 media `kind` enum. M6 only ships `image` and `file`. `audio`
 * / `video` are reserved in DB but blocked at the protocol layer
 * (M6 plan §2.4 — needs duration + player UX).
 */
export const mediaKindSchema = z.enum(["image", "file"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/**
 * M6 media lifecycle enum. Mirrors `media_assets.status` check
 * constraint (`media_assets_status_check`). Public surface so the
 * `GET .../download-url` response can return the current state
 * without exposing the DB literal to API callers — already kept
 * in lock-step with `packages/db/src/schema/media.ts`.
 */
export const mediaAssetStatusSchema = z.enum([
  "pending",
  "uploaded",
  "failed",
  "deleted"
]);
export type MediaAssetStatus = z.infer<typeof mediaAssetStatusSchema>;

/**
 * `POST /api/client/apps/:appId/media/uploads` body.
 *
 * `kind` selects which MIME / size policy applies (image 10 MiB /
 * file 50 MiB, plan §2.4). `width` / `height` are image-only and
 * optional — they end up in `media_assets.width` / `height` (text
 * columns) and surface in `message.received` canonical content
 * (plan §3.2). `sha256` is the **client-claimed** 64-char lowercase
 * hex digest; M6 does not recompute SHA from object content (plan
 * §2.6 / §3.3 — server-side HeadObject only checks size + the
 * declared `x-amz-meta-sha256` against this field).
 */
export const createMediaUploadRequestSchema = z
  .object({
    kind: mediaKindSchema,
    fileName: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(256),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional()
  })
  .strict();
export type CreateMediaUploadRequest = z.infer<
  typeof createMediaUploadRequestSchema
>;

/**
 * `POST /api/client/apps/:appId/media/:mediaAssetId/complete` body.
 *
 * `sha256` is an optional echo of the value originally written by
 * `POST .../uploads`. It is NOT the source of truth for the integrity
 * check — that is `HeadObject.metadata.sha256` matched against the
 * `media_assets.sha256` row. The route layer checks both:
 *   - **required**: `head.metadata.sha256 === row.sha256` (else
 *     409 `MEDIA_OBJECT_METADATA_MISMATCH`).
 *   - **optional echo**: if `body.sha256` is provided, it must equal
 *     `row.sha256`; a mismatch is also `MEDIA_OBJECT_METADATA_MISMATCH`.
 *
 * This two-tier design prevents callers from passing a "correct" sha
 * in body to bypass a missing/wrong head metadata (M6 plan §3.3
 * "校验对象存储 Metadata.sha256 与 DB 记录一致").
 */
export const completeMediaUploadRequestSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
export type CompleteMediaUploadRequest = z.infer<
  typeof completeMediaUploadRequestSchema
>;

/**
 * `/api/client/apps/:appId/media/:mediaAssetId/...` path params.
 * `:mediaAssetId` is the internal `media_assets.id` UUID.
 */
export const clientMediaPathParamSchema = z.object({
  appId: uuidStringSchema,
  mediaAssetId: uuidStringSchema
});

/**
 * Canonical `mediaAsset` row returned in every M6 Client API
 * response. `fileName` is the **client-claimed** display name
 * (preserved verbatim — the server uses a sanitized version for the
 * S3 object key per `domain/media/policy.buildMediaObjectKey`).
 * `createdAt` / `updatedAt` are ISO 8601 UTC strings.
 */
export const mediaAssetResponseSchema = z.object({
  id: uuidStringSchema,
  kind: mediaKindSchema,
  fileName: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  status: mediaAssetStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MediaAssetResponse = z.infer<typeof mediaAssetResponseSchema>;

/**
 * Presigned PUT shape returned by `POST /api/client/.../media/uploads`.
 * `headers` 是建议 caller 在 PUT 时带的请求头，但 **caller 必须
 * filter 到 SigV4 `X-Amz-SignedHeaders` 列表**再回写 —— AWS SDK v3
 * 的 `PutObjectCommand.serialize` 在 presign 阶段不 hoist `Metadata`
 * 到 request header，所以 advisory 字段（如 `x-amz-meta-sha256`）
 * 不在签名里，MinIO 严格 SigV4 verifier 会拒收任何没在
 * SignedHeaders 列表里的 header（"There were headers present in
 * the request which were not signed"）。filter 实现见
 * `apps/api-service/src/modules/media/object-storage.ts` 的
 * `signableHeaders` 集合 + reference-client 的
 * `NexaIMClient.m6.integration.test.ts` `filterSignedHeaders`。
 * `expiresAt` 是 URL 过期的 ISO 时间戳 —— clients MUST NOT retry
 * past it without calling `uploads` again to mint a fresh URL。
 */
export const mediaUploadInstructionSchema = z.object({
  method: z.literal("PUT"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().datetime()
});
export type MediaUploadInstruction = z.infer<
  typeof mediaUploadInstructionSchema
>;

/**
 * Presigned GET shape returned by `GET .../media/:id/download-url`.
 * `method` is intentionally NOT included — every download URL is a
 * GET (the field is for symmetry with `mediaUploadInstructionSchema`,
 * where the verb is part of the contract). Clients SHOULD call this
 * endpoint right before initiating the GET to minimise the time the
 * URL is valid (M6 plan §2.6 short-TTL semantics).
 */
export const mediaDownloadInstructionSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime()
});
export type MediaDownloadInstruction = z.infer<
  typeof mediaDownloadInstructionSchema
>;

/**
 * `POST .../media/uploads` response.
 */
export const createMediaUploadResponseDataSchema = z.object({
  mediaAsset: mediaAssetResponseSchema,
  upload: mediaUploadInstructionSchema
});
export type CreateMediaUploadResponseData = z.infer<
  typeof createMediaUploadResponseDataSchema
>;

/**
 * `POST .../media/:mediaAssetId/complete` response.
 */
export const completeMediaUploadResponseDataSchema = z.object({
  mediaAsset: mediaAssetResponseSchema
});
export type CompleteMediaUploadResponseData = z.infer<
  typeof completeMediaUploadResponseDataSchema
>;

/**
 * `GET .../media/:mediaAssetId/download-url` response.
 */
export const getMediaDownloadUrlResponseDataSchema = z.object({
  mediaAsset: mediaAssetResponseSchema,
  download: mediaDownloadInstructionSchema
});
export type GetMediaDownloadUrlResponseData = z.infer<
  typeof getMediaDownloadUrlResponseDataSchema
>;
