import { z } from "zod";
import { externalUserIdSchema, uuidStringSchema } from "./ids";
import { messageSyncResultItemSchema } from "./ws";

/**
 * Client 会话列表协议（WECHAT-ACCESS-LOGIC-1，contract
 * `WECHAT-ACCESS-1/v1`）。
 *
 * 入口：`GET /api/client/apps/:appId/conversations`。首版只列
 * **direct** 会话：会话项的 `conversationType` 固定为 `"direct"`，
 * query 不接受 `conversationType` 过滤（见
 * `clientConversationListQuerySchema.strict()`）。
 *
 * 身份全部来自 `request.clientContext`（IM Token preHandler 解析），
 * 请求不接受任何 caller 传入的 `userId` / `tenantId` / `imUserId` ——
 * schema 层 `.strict()` 直接拒掉多余 query 字段，而不是"解析后忽略"。
 *
 * 分页是 keyset（`lastMessageAt DESC NULLS LAST, conversationId DESC`）
 * 而不是 offset：会话排序值会随新消息变化，offset 会漏项 / 重项。
 * `encodeClientConversationCursor` / `decodeClientConversationCursor`
 * 是唯一编码点；客户端只透传 `page.nextCursor`，不解码。
 */

/**
 * Cursor 载荷版本号。decode 侧对版本做严格校验：未知版本返回
 * `null`，由 route 层映射成 `422 VALIDATION_FAILED`，而不是静默
 * 当成"第一页"。
 */
export const CLIENT_CONVERSATION_CURSOR_VERSION = 1;

/**
 * `GET /api/client/apps/:appId/conversations` path params。
 * `:appId` 由 preHandler 与 IM Token claims 做过一致性校验，这里
 * 只做形状校验。
 */
export const clientConversationListPathParamsSchema = z.object({
  appId: uuidStringSchema
});

/**
 * Query 白名单：只有 `cursor` + `limit`。
 *
 * `limit` 用 `z.coerce.number()` —— Fastify 的 query parser 给出的
 * 是字符串（`?limit=20`），媒体 / Console 列表接口沿用同一约定。
 *
 * `.strict()` 是隔离的一部分：伪造的 `?userId=` / `?tenantId=` /
 * `?conversationType=group` 会得到 `422 VALIDATION_FAILED`，而不是
 * 被静默丢弃后返回"调用者自己的"列表，让接入方误以为筛选生效。
 */
export const clientConversationListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

export type ClientConversationListQuery = z.infer<
  typeof clientConversationListQuerySchema
>;

/**
 * 会话项。
 *
 * - `peerUserId` 是**外部**业务用户 ID（`im_users.external_user_id`），
 *   不是内部 `im_users.id` UUID —— `.strict()` + `.uuid()` 的
 *   `conversationId` 组合让"内部 id 泄漏"在协议层就失败。
 * - `lastMessageAt` 在会话还没有任何消息时为 `null`（排序上排在所有
 *   非 null 时间之后）。
 * - `lastMessageSeq` / `lastReadSeq` / `unreadCount` 是非负整数；
 *   DB 里 `last_message_seq` / `last_read_seq` 可为 NULL，repository
 *   归一为 0。
 * - `lastReadSeq`（服务端已读游标）、`lastMessageSeq`（最后消息位置）
 *   与客户端本地"已连续处理到的 sync 游标"三者用途不同，不能互相
 *   替代。
 * - `lastMessage` 复用 `messageSyncResultItemSchema`（text / image /
 *   file 三种既有消息形态），因此不重复定义消息 schema；消息已被
 *   保留期清理或对当前用户不可见时为 `null`，此时**不**重置
 *   `lastMessageAt` / `lastMessageSeq`。
 */
export const clientConversationItemSchema = z
  .object({
    conversationId: uuidStringSchema,
    conversationType: z.literal("direct"),
    peerUserId: externalUserIdSchema,
    lastMessageAt: z.string().datetime().nullable(),
    lastMessageSeq: z.number().int().nonnegative(),
    lastReadSeq: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    lastMessage: messageSyncResultItemSchema.nullable()
  })
  .strict();

export type ClientConversationItem = z.infer<typeof clientConversationItemSchema>;

/**
 * `data` 载荷：数组形态（`page` 由统一 envelope 的 `SuccessPage`
 * 承载，见 `apps/api-service/src/context/responses.ts`）。
 */
export const clientConversationListResponseDataSchema = z.array(
  clientConversationItemSchema
);

export type ClientConversationListResponseData = z.infer<
  typeof clientConversationListResponseDataSchema
>;

/**
 * 列表响应的 `page` 段。与 `apps/api-service` 的 `SuccessPage` 同形，
 * 这里给出 Zod schema 供 Reference Client 校验服务端响应
 * （`limit` 与 `nextCursor` / `hasMore` 的组合必须自洽）。
 */
export const clientConversationListPageSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    nextCursor: z.string().min(1).nullable(),
    hasMore: z.boolean()
  })
  .strict();

export type ClientConversationListPage = z.infer<
  typeof clientConversationListPageSchema
>;

/**
 * 完整响应 envelope：`{ requestId, data, page }`。Reference Client 的
 * `listConversations` 返回值就是这个形状（不剥 `data`）—— 调用方需要
 * 自己决定分页与合并策略。
 */
export const clientConversationListResponseSchema = z
  .object({
    requestId: z.string().min(1),
    data: clientConversationListResponseDataSchema,
    page: clientConversationListPageSchema
  })
  .strict();

export type ClientConversationListResponse = z.infer<
  typeof clientConversationListResponseSchema
>;

/**
 * Keyset cursor 解码后的排序键。`lastMessageAt: null` 表示游标落在
 * "没有任何消息"的尾部区间，此时下一页只取 `last_message_at IS NULL`
 * 且 `conversation_id < c` 的行。
 */
export type ClientConversationCursor = {
  lastMessageAt: Date | null;
  conversationId: string;
};

const cursorPayloadSchema = z
  .object({
    v: z.literal(CLIENT_CONVERSATION_CURSOR_VERSION),
    /** ISO 8601 UTC；null = 会话无最后消息时间。 */
    t: z.string().datetime().nullable(),
    /** `conversations.id`（内部 UUID，仅作为排序 tiebreak，不出 wire）。 */
    c: uuidStringSchema
  })
  .strict();

/**
 * 把 keyset 排序键编码成不透明 cursor：`base64url(JSON)`。
 *
 * **Web-safe**：用 `btoa` / `atob` 而不是 Node `Buffer` —— 本包同时被
 * console-web / reference-client 引用（与
 * `encodeOffsetCursor` 同一理由）。
 */
export function encodeClientConversationCursor(
  cursor: ClientConversationCursor
): string {
  const payload = {
    v: CLIENT_CONVERSATION_CURSOR_VERSION,
    t: cursor.lastMessageAt ? cursor.lastMessageAt.toISOString() : null,
    c: cursor.conversationId
  };
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * 解码 cursor。**任何**异常输入（空串、非 base64url、缺字段、版本
 * 不匹配、`conversationId` 不是 uuid、时间戳不可解析）都返回
 * `null`，由调用方映射成 `422 VALIDATION_FAILED`。
 *
 * 与 `decodeOffsetCursor` 的"宽容到第一页"策略**故意不同**：offset
 * 游标错位只会少拿/多拿数据，而 keyset 游标错位如果静默退化成第一页，
 * 会让客户端把整张列表当成增量结果重复渲染。这里宁可 422。
 */
export function decodeClientConversationCursor(
  cursor: string
): ClientConversationCursor | null {
  if (!cursor) return null;
  let raw: string;
  try {
    let s = cursor.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    raw = atob(s);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) return null;
  return {
    lastMessageAt: result.data.t === null ? null : new Date(result.data.t),
    conversationId: result.data.c
  };
}