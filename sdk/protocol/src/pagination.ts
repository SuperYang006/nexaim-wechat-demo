import { z } from "zod";

export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

export type CursorPage<T = unknown> = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  items: T[];
};

export function createCursorPage<T>(input: CursorPage<T>): CursorPage<T> {
  return input;
}

/**
 * Offset-based opaque cursor。原 `tenants/routes.ts` 的私有 helper
 * 提到此处（M7 Task 8 起 webhook deliveries list 复用）。
 *
 * 编码格式：`base64url("offset:<n>")`。Tag 前缀让以后想加 keyset
 * cursor（`createdAt:<ts>:id:<id>`）时 decode 能区分；现在只识别
 * `offset` 一种格式。生产规模分页是 M10 范围 —— M2 起先 offset，
 * 数据量上来再换 keyset（M7 deliveries 暂时量小，offset 够用）。
 *
 * **opaque to caller**：caller 不应该解码或构造 cursor 字符串，只
 * 把 `nextCursor` 当不透明 token 透传即可。
 *
 * **Web-safe 编码**：用 `btoa` / `atob`（DOM global + Node 16+
 * global）而不是 Node `Buffer` —— `@nexaim/protocol` 同时被
 * console-web / reference-client 引用，浏览器 bundle 不能 require
 * `node:buffer`。`btoa` 输入限 Latin-1（每个 code unit 0–255），
 * 本 cursor payload `offset:<ascii-number>` 永远在 ASCII 范围
 * （M2 起 offset 是非负整数），无 UTF-8 编码需求。
 */
export function encodeOffsetCursor(offset: number): string {
  const raw = `offset:${offset}`;
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 解码失败（malformed / 非 offset tag / 非数字）一律视作 0 —— 这是
 * 故意"宽容到第一页"的行为：用户把伪造的 cursor 发回来，最坏后果是
 * 拿到首页而不是 4xx，让分页 UI 不会因为"瞎填 cursor"而炸掉。
 *
 * 与原 tenants/routes.ts 的实现行为完全一致。
 */
export function decodeOffsetCursor(cursor: string): number {
  try {
    // 反向 base64url → standard base64 + padding，再 atob。try
    // catch 兜所有 malformed 情况。
    let s = cursor.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const raw = atob(s);
    const [tag, value] = raw.split(":");
    if (tag !== "offset" || !value) return 0;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}