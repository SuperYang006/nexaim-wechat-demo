import type { IMSession } from './types';
export async function loadConversations(session: IMSession, cursor?: string) {
    session.gate.assert();
    const page = await session.client.listConversations({ limit: 20, ...(cursor ? { cursor } : {}) });
    session.gate.assert();
    session.store.mergeConversations(page.data);
    return page.page;
}
