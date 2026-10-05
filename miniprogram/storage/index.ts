export function accountKey(appId: string, userId: string, key: string) {
    return `nexaim-demo:${encodeURIComponent(appId)}:${encodeURIComponent(userId)}:${encodeURIComponent(key)}`;
}
// 持久化会话数据时，消息与连续 sync 游标必须在同一份快照中提交。
// 当前 Demo 的消息与游标仅保存在内存，重启后从 0 补漏。
