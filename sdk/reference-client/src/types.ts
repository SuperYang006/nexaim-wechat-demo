/**
 * Reference Client 公开类型占位（M4 plan § 5 Task 6）。
 *
 * Task 7+ 会按顺序补：
 *   - Task 7: MessageDedupe / NexaIMClientError（基础工具的接口）
 *   - Task 8: NexaIMClientOptions / NexaIMClient 类的 state machine 类型
 *             + ClientEvent 联合（"message" | "error" | "state"）
 *   - Task 9: sendMessage / markDelivered / markRead / syncConversation
 *             的 payload 类型
 *
 * 这里不放运行时 export（types.ts 是 type-only），全部走 `export type`
 * + `export interface` —— 这样在 Task 6 阶段 `pnpm typecheck` 通过，
 * 后续 Task 增量补类型不会破坏 import path。
 */

// 任务占位：Task 7+ 会替换为真实类型。当前故意保持空，让 scaffold
// typecheck 通过即可（type-only 文件至少需要 1 个 export 才不算
// "isolatedModules" 报错，但 export 任何具体类型都属于提前泄露）。
//
// export {} 显式占位，让 ts 知道这是 module 文件。
export {};