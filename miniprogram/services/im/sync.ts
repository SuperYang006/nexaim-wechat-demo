import type { IMSession } from './types';
export function syncConversation(session: IMSession, conversationId: string): Promise<void> {
    const key = `sync:${conversationId}`;
    const pending = session.tasks.get(key);
    if (pending)
        return pending as Promise<void>;
    // 微任务开始后才发请求，确保任务已经登记，避免同步事件重入。
    const task = Promise.resolve().then(async () => {
        session.gate.assert();
        await session.client.connect();
        if (!session.gate.active)
            return;
        let afterSeq = session.store.cursors[conversationId] ?? 0;
        for (;;) {
            const page = await session.client.syncConversation(conversationId, afterSeq, { limit: 100 });
            if (!session.gate.active)
                return;
            for (const item of page.items)
                session.store.receive({ ...item, conversationId });
            if (page.nextSeq < afterSeq || (page.hasMore && page.nextSeq === afterSeq))
                throw new Error('INVALID_SYNC_CURSOR');
            session.store.cursors[conversationId] = page.nextSeq;
            session.store.notify();
            if (!page.hasMore)
                return;
            afterSeq = page.nextSeq;
        }
    }).finally(() => { if (session.tasks.get(key) === task)
        session.tasks.delete(key); });
    session.tasks.set(key, task);
    return task;
}
