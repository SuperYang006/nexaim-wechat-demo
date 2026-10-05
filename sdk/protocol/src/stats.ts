/**
 * Console API Stats contracts for M9 (see `docs/milestones/M9-Stats开发计划.md` §5).
 *
 * Scope of this file:
 * - Query schemas for the 7 stats endpoints (overview, messages,
 *   notifications, notifications/failures, webhooks, broadcasts, online).
 * - Reusable primitive schemas (date string, limit, dimension filters) that
 *   the routes compose.
 * - Response item schemas that need to be defined alongside queries so the
 *   same file owns every M9 §5 contract. Each schema enforces `.strict()` —
 *   M9 §9 Step 1 forbids `...` or undeclared fields on the wire.
 *
 * Conventions inherited from siblings (`console.ts`, `notification.ts`):
 * - camelCase on the wire, UTC `YYYY-MM-DD` for dates, ISO datetime for ts.
 * - Dimensions validated via `z.enum([...] as const)` so the inferred
 *   union is the single source of truth for allowed values.
 * - `limit` accepts only string-from-URL coerced ints and clamps to the
 *   documented range.
 *
 * Default range / default limit / Top N sorting / pagination cursor
 * encoding live in `packages/domain/src/stats/*` — protocol deliberately
 * only describes the *shape* of the wire input.
 */

import { z } from "zod";

import { notificationProviderNameSchema } from "./notification";
import { webhookEventTypeSchema } from "./webhook";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default `limit` for stats list endpoints per M9 plan §5. */
export const STATS_LIST_DEFAULT_LIMIT = 20;
/** Hard minimum for any stats list `limit`. */
export const STATS_LIST_LIMIT_MIN = 1;
/** Hard maximum for any stats list `limit` per M9 plan §5. */
export const STATS_LIST_LIMIT_MAX = 50;
/** Broadcasts endpoint uses the same default; isolated so future divergence stays cheap. */
export const STATS_BROADCASTS_DEFAULT_LIMIT = 20;

/**
 * Notification failure Top N — DIFFERENT default from the generic list.
 * Per M9 plan §4.3 + §5.4 the failure leaderboard defaults to 10 (not 20)
 * and the wire caps at 50 like every other list endpoint. Reusing
 * `statsLimitParamSchema` would silently surface 20 as default and tempt
 * Console pages to render noisy 20-row tables.
 */
export const STATS_NOTIFICATION_FAILURE_DEFAULT_LIMIT = 10;
export const STATS_NOTIFICATION_FAILURE_LIMIT_MIN = STATS_LIST_LIMIT_MIN;
export const STATS_NOTIFICATION_FAILURE_LIMIT_MAX = STATS_LIST_LIMIT_MAX;

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` UTC day literal. Both a regex check AND a real-calendar
 * round-trip: the regex alone lets `2026-02-31` through, and JS `Date.UTC`
 * will silently roll it over to `2026-03-03`. The `superRefine` below
 * rewrites the value through `Date.UTC` and compares it back to the
 * original; any day-rollover yields a mismatch and rejects the input so
 * the route layer can surface `STATS_INVALID_DATE_RANGE`.
 */
export const statsDateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "stats date must be YYYY-MM-DD" })
  .superRefine((value, ctx) => {
    const [yStr, mStr, dStr] = value.split("-");
    const y = Number.parseInt(yStr!, 10);
    const m = Number.parseInt(mStr!, 10);
    const d = Number.parseInt(dStr!, 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stats date is not a valid calendar date"
      });
      return;
    }
    const utc = new Date(Date.UTC(y, m - 1, d));
    // detect overflow rollover: e.g. Feb 31 -> JS Mar 3
    if (
      utc.getUTCFullYear() !== y ||
      utc.getUTCMonth() !== m - 1 ||
      utc.getUTCDate() !== d
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stats date is not a valid calendar date"
      });
    }
  });

/**
 * Branded `YYYY-MM-DD` UTC day string so domain / repository callers get
 * a typed guarantee that the value was either: (a) produced by the
 * schema's `.parse()`, or (b) explicitly cast via `asStatsDateString`.
 */
export type StatsDateString = string & { readonly __statsDateBrand?: never };

/**
 * Helper for callers that need to claim "this string really is a
 * protocol-validated YYYY-MM-DD" without paying the parse cost again.
 * Prefer routing the value through `statsDateStringSchema.parse(...)`
 * whenever possible.
 */
export function asStatsDateString(value: string): StatsDateString {
  return value as StatsDateString;
}

/**
 * List limit. Coerced from string (Fastify query params arrive as strings)
 * and clamped to the documented range. Empty string falls back to default
 * so the wire shape `{ limit: "" }` is tolerated.
 */
export const statsLimitParamSchema = z
  .preprocess((value) => (value === "" ? undefined : value), z.coerce
    .number()
    .int()
    .min(STATS_LIST_LIMIT_MIN)
    .max(STATS_LIST_LIMIT_MAX)
    .default(STATS_LIST_DEFAULT_LIMIT));

/**
 * Notification-failure Top N limit. Same [1, 50] clamp as the generic
 * schema but a DIFFERENT default (10) per M9 plan §4.3 / §5.4. Kept as a
 * dedicated schema so a future move to a different default (or per-app
 * override) doesn't regress the failure leaderboard.
 */
export const statsNotificationFailureLimitParamSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce
    .number()
    .int()
    .min(STATS_NOTIFICATION_FAILURE_LIMIT_MIN)
    .max(STATS_NOTIFICATION_FAILURE_LIMIT_MAX)
    .default(STATS_NOTIFICATION_FAILURE_DEFAULT_LIMIT)
);

/** Optional inclusive date range; defaults are filled by `normalizeStatsDateRange`. */
export const statsDateRangeQuerySchema = z
  .object({
    from: statsDateStringSchema.optional(),
    to: statsDateStringSchema.optional()
  })
  .strict();

/** Conversation type filter for `/stats/messages`. */
export const statsConversationTypeSchema = z.enum([
  "direct",
  "group",
  "broadcast"
]);

/** Message type filter for `/stats/messages`. M9 §5.2: `all` rollup, plus typed rows. */
export const statsMessageTypeSchema = z.enum(["all", "text", "image", "file"]);

/**
 * Filter alias for `/stats/webhooks`. Currently the underlying enum is
 * shared with `webhookEventTypeSchema`; the alias documents the intent
 * and shields callers from future webhook schema renames.
 */
export const statsWebhookEventTypeFilterSchema = webhookEventTypeSchema;

// ---------------------------------------------------------------------------
// Per-endpoint query schemas
// ---------------------------------------------------------------------------

export const statsMessagesQuerySchema = statsDateRangeQuerySchema.extend({
  conversationType: statsConversationTypeSchema.optional(),
  messageType: statsMessageTypeSchema.optional()
});

export const statsNotificationsQuerySchema = statsDateRangeQuerySchema.extend({
  provider: notificationProviderNameSchema.optional()
});

export const statsNotificationFailuresQuerySchema =
  statsNotificationsQuerySchema.extend({
    limit: statsNotificationFailureLimitParamSchema
  });

export const statsWebhooksQuerySchema = statsDateRangeQuerySchema.extend({
  eventType: statsWebhookEventTypeFilterSchema.optional()
});

export const statsBroadcastsQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: statsLimitParamSchema
  })
  .strict();

export const statsOnlineQuerySchema = statsDateRangeQuerySchema;

// ---------------------------------------------------------------------------
// Response item schemas (M9 §5)
// ---------------------------------------------------------------------------

/**
 * Overview trend day item (M9 §5.1). The full overview response wraps an
 * array of these; the summary block is a flat object whose keys overlap
 * with this schema, so the trend item stays the canonical day shape.
 */
export const statsOverviewTrendItemSchema = z
  .object({
    date: statsDateStringSchema,
    sentCount: z.number().int().min(0),
    deliveryAckCount: z.number().int().min(0),
    readAckCount: z.number().int().min(0),
    notificationSuccessCount: z.number().int().min(0),
    notificationFailedCount: z.number().int().min(0),
    webhookSuccessCount: z.number().int().min(0),
    webhookFailedCount: z.number().int().min(0),
    webhookTimeoutCount: z.number().int().min(0),
    peakOnlineCount: z.number().int().min(0),
    avgOnlineCount: z.number().int().min(0).nullable()
  })
  .strict();

/**
 * Failure Top N row (M9 §5.4). `ratio` is derived by the API layer (count
 * over the selected provider/date range failure total); storing it on the
 * wire keeps the row self-explanatory and avoids forcing the client to
 * recompute.
 */
export const statsFailureItemBaseSchema = z
  .object({
    date: statsDateStringSchema,
    provider: notificationProviderNameSchema,
    errorCode: z.string().min(1).max(128),
    errorMessage: z.string().nullable(),
    count: z.number().int().min(0),
    ratio: z.number().min(0).max(1)
  })
  .strict();

/**
 * Closed YYYY-MM-DD range envelope (`/stats/overview` range block).
 * Length / order / defaulting enforced by domain helper, not here.
 */
export const statsRangeEnvelopeSchema = z
  .object({
    from: statsDateStringSchema,
    to: statsDateStringSchema
  })
  .strict();

/**
 * Overview summary block (M9 §5.1). `deliveryRate` / `readRate` /
 * `*SuccessRate` are domain-derived ratios; protocol only enforces
 * numeric range, not rounding policy.
 */
export const statsOverviewSummarySchema = z
  .object({
    sentCount: z.number().int().min(0),
    deliveryAckCount: z.number().int().min(0),
    readAckCount: z.number().int().min(0),
    deliveryRate: z.number().min(0).max(1),
    readRate: z.number().min(0).max(1),
    notificationTaskCount: z.number().int().min(0),
    notificationSuccessCount: z.number().int().min(0),
    notificationFailedCount: z.number().int().min(0),
    notificationSuccessRate: z.number().min(0).max(1),
    webhookSuccessCount: z.number().int().min(0),
    webhookFailedCount: z.number().int().min(0),
    webhookTimeoutCount: z.number().int().min(0),
    webhookSuccessRate: z.number().min(0).max(1),
    peakOnlineCount: z.number().int().min(0),
    avgOnlineCount: z.number().int().min(0).nullable()
  })
  .strict();

/** M9 §5.1 overview envelope: range + summary + per-day trends. */
export const statsOverviewResponseSchema = z
  .object({
    range: statsRangeEnvelopeSchema,
    summary: statsOverviewSummarySchema,
    trends: z.array(statsOverviewTrendItemSchema)
  })
  .strict();

/**
 * M9 §5.2 message daily row. `deliveryRate` / `readRate` are derived at
 * the route layer via `domain/stats/metrics.ts` before wire serialization.
 */
export const statsMessageListItemSchema = z
  .object({
    date: statsDateStringSchema,
    conversationType: statsConversationTypeSchema,
    messageType: statsMessageTypeSchema,
    sentCount: z.number().int().min(0),
    receivedCount: z.number().int().min(0),
    sendAckCount: z.number().int().min(0),
    deliveryAckCount: z.number().int().min(0),
    readAckCount: z.number().int().min(0),
    deliveryRate: z.number().min(0).max(1),
    readRate: z.number().min(0).max(1)
  })
  .strict();

export const statsMessagesResponseSchema = z.array(statsMessageListItemSchema);

/** M9 §5.3 notification daily row by provider. */
export const statsNotificationListItemSchema = z
  .object({
    date: statsDateStringSchema,
    provider: notificationProviderNameSchema,
    taskCount: z.number().int().min(0),
    successCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    deadCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    retryCount: z.number().int().min(0),
    successRate: z.number().min(0).max(1)
  })
  .strict();

export const statsNotificationsResponseSchema = z.array(
  statsNotificationListItemSchema
);

/** M9 §5.4 failures response (array form; `statsFailureItemBaseSchema`). */
export const statsNotificationFailuresResponseSchema = z.array(
  statsFailureItemBaseSchema
);

/** M9 §5.5 webhook daily row by event type. */
export const statsWebhookListItemSchema = z
  .object({
    date: statsDateStringSchema,
    eventType: statsWebhookEventTypeFilterSchema,
    successCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    timeoutCount: z.number().int().min(0),
    avgLatencyMs: z.number().int().min(0).nullable(),
    successRate: z.number().min(0).max(1)
  })
  .strict();

export const statsWebhooksResponseSchema = z.array(statsWebhookListItemSchema);

/**
 * Broadcast delivery status enum. Mirrors the `broadcast_delivery_stats`
 * CHECK constraint in `packages/db/src/schema/stats.ts`:
 * `(pending, running, success, failed)`. Drift between protocol and DB
 * would let Console surface states the DB can never produce.
 */
export const statsBroadcastStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed"
]);

/**
 * M9 §5.6 broadcast progress row. `serverMessageId` is nullable because
 * the underlying `broadcast_delivery_stats` row may not have a joined
 * `messages` row (orphaned / race window).
 */
export const statsBroadcastListItemSchema = z
  .object({
    messageId: z.string().uuid(),
    serverMessageId: z.string().nullable(),
    conversationId: z.string().uuid(),
    status: statsBroadcastStatusSchema,
    totalCount: z.number().int().min(0),
    processedCount: z.number().int().min(0),
    successCount: z.number().int().min(0),
    failureCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

/**
 * Broadcast list cursor page envelope (M9 §5.6).
 *
 * `nextCursor` is an opaque non-empty token when `hasMore` is true;
 * routes can compute `hasMore = page.nextCursor !== null` and the schema
 * refuses mismatched values:
 *   - empty-string cursor → rejected (would round-trip fail the query schema).
 *   - `hasMore: true` + `nextCursor: null` → rejected (Console would show
 *     a "下一页" button with no usable cursor).
 *   - `hasMore: false` + `nextCursor: <non-null>` → rejected (terminal
 *     page must clear the cursor so the next request doesn't reuse it).
 *
 * The exact `updatedAt + messageId` encoding of the cursor lives in
 * `packages/domain`; protocol here just guards the shape.
 *
 * The HTTP envelope (`{ requestId, data, page }`) is composed by
 * `successResponse()` in `@nexaim/protocol/http`; protocol here describes
 * only the `data` payload + the page payload, NOT the wrapping. See the
 * project's `docs/API接口设计规范.md` § 7.
 */
export const statsBroadcastPageSchema = z
  .object({
    limit: z.number().int().min(1).max(50),
    nextCursor: z.string().min(1).nullable(),
    hasMore: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.hasMore && value.nextCursor === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "nextCursor must be a non-empty string when hasMore is true (§5.6 invariant)",
        path: ["nextCursor"]
      });
    }
    if (!value.hasMore && value.nextCursor !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "nextCursor must be null when hasMore is false (§5.6 invariant)",
        path: ["nextCursor"]
      });
    }
  });

/**
 * `/stats/broadcasts` `data` payload — array of broadcast progress rows.
 * The route handler is responsible for wrapping with `successResponse()`
 * to produce `{ requestId, data, page }`.
 */
export const statsBroadcastsResponseSchema = z.array(
  statsBroadcastListItemSchema
);

/**
 * M9 §5.7 online daily row.
 *
 * `avgOnlineCount` is null when sampleCount=0 (no samples -> no average),
 * and a non-negative integer when sampleCount>0. The cross-field rule
 * is enforced via `superRefine` so a route layer cannot drift the
 * relationship by accident.
 */
export const statsOnlineListItemSchema = z
  .object({
    date: statsDateStringSchema,
    peakOnlineCount: z.number().int().min(0),
    avgOnlineCount: z.number().int().min(0).nullable(),
    sampleCount: z.number().int().min(0)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sampleCount === 0 && value.avgOnlineCount !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "avgOnlineCount must be null when sampleCount is 0 (§5.7 contract)",
        path: ["avgOnlineCount"]
      });
      return;
    }
    if (value.sampleCount > 0 && value.avgOnlineCount === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "avgOnlineCount must be a non-negative integer when sampleCount > 0 (§5.7 contract)",
        path: ["avgOnlineCount"]
      });
    }
  });

export const statsOnlineResponseSchema = z.array(statsOnlineListItemSchema);

// ---------------------------------------------------------------------------
// Type aliases (z.infer)
// ---------------------------------------------------------------------------

export type StatsOverviewTrendItem = z.infer<typeof statsOverviewTrendItemSchema>;
export type StatsOverviewSummary = z.infer<typeof statsOverviewSummarySchema>;
export type StatsOverviewResponse = z.infer<typeof statsOverviewResponseSchema>;
export type StatsMessageListItem = z.infer<typeof statsMessageListItemSchema>;
export type StatsMessagesResponse = z.infer<typeof statsMessagesResponseSchema>;
export type StatsNotificationListItem = z.infer<
  typeof statsNotificationListItemSchema
>;
export type StatsNotificationsResponse = z.infer<
  typeof statsNotificationsResponseSchema
>;
export type StatsFailureItemBase = z.infer<typeof statsFailureItemBaseSchema>;
export type StatsNotificationFailuresResponse = z.infer<
  typeof statsNotificationFailuresResponseSchema
>;
export type StatsWebhookListItem = z.infer<typeof statsWebhookListItemSchema>;
export type StatsWebhooksResponse = z.infer<typeof statsWebhooksResponseSchema>;
export type StatsBroadcastListItem = z.infer<typeof statsBroadcastListItemSchema>;
export type StatsBroadcastsResponse = z.infer<typeof statsBroadcastsResponseSchema>;
export type StatsBroadcastPage = z.infer<typeof statsBroadcastPageSchema>;
export type StatsOnlineListItem = z.infer<typeof statsOnlineListItemSchema>;
export type StatsOnlineResponse = z.infer<typeof statsOnlineResponseSchema>;
export type StatsRangeEnvelope = z.infer<typeof statsRangeEnvelopeSchema>;
