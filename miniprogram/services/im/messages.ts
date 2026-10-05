import type { Draft, IMSession } from './types';
export async function sendDraft(session: IMSession, draft: Draft) {
    if (!session.gate.active)
        return;
    session.store.addDraft(draft);
    try {
        await session.client.connect();
        if (!session.gate.active)
            return;
        const ack = draft.messageType === 'text'
            ? await session.client.sendMessage({ recipientUserId: draft.recipientUserId, text: draft.text, clientMessageId: draft.clientMessageId })
            : await session.client.sendMediaMessage({ ...draft, conversationType: 'direct' });
        if (session.gate.active)
            session.store.settleDraft(draft.clientMessageId, ack);
    }
    catch (error) {
        if (session.gate.active)
            session.store.failDraft(draft.clientMessageId, error);
    }
}
export async function markRead(session: IMSession, conversationId: string, seq: number) {
    session.gate.assert();
    await session.client.connect();
    session.gate.assert();
    return session.client.markRead(conversationId, seq);
}
