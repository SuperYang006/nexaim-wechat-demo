import { describe, it, expect, vi } from 'vitest';
import { ChatStore } from '../miniprogram/store/chat';
import { SessionGate } from '../miniprogram/services/im/lifecycle';
import { sendDraft } from '../miniprogram/services/im/messages';
import { syncConversation } from '../miniprogram/services/im/sync';
import { putImageBytes } from '../miniprogram/services/im/media';
import { accountKey } from '../miniprogram/storage/index';
import type { IMSession } from '../miniprogram/services/im/types';
const received = (seq: number, id = `message-${seq}`) => ({ conversationId: 'conv-1', serverMessageId: id, senderUserId: 'bob', conversationSeq: seq, messageType: 'text' as const, content: { text: 'hello' }, createdAt: '2026-10-05T00:00:00.000Z' });
const draft = { clientMessageId: 'draft-1', recipientUserId: 'bob', messageType: 'text' as const, text: 'hello' };
const ack = { conversationId: 'conv-1', serverMessageId: 'message-1', clientMessageId: 'draft-1', conversationSeq: 1, status: 'sent' as const, createdAt: '2026-10-05T00:00:00.000Z' };
function session(overrides: Record<string, unknown> = {}) {
    return { store: new ChatStore('alice'), gate: new SessionGate(), tasks: new Map(), client: { connect: vi.fn().mockResolvedValue(undefined), sendMessage: vi.fn().mockResolvedValue(ack), sendMediaMessage: vi.fn().mockResolvedValue(ack), ...overrides } } as unknown as IMSession;
}
function deferred<T>() { let resolve!: (x: T) => void; let reject!: (x: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
describe('chat state', () => {
    it('deduplicates realtime/sync and sorts conversation sequence', () => { const s = new ChatStore('alice'); s.receive(received(3)); s.receive(received(1)); s.receive(received(3)); expect(s.messages.map(m => m.conversationSeq)).toEqual([1, 3]); });
    it('realtime maximum does not advance the continuous sync cursor', () => { const s = new ChatStore('alice'); s.receive(received(50)); expect(s.cursors['conv-1'] ?? 0).toBe(0); });
    it('ACK merges an optimistic draft with a message already received by sync', () => { const s = new ChatStore('alice'); s.addDraft(draft); s.receive({ ...received(1), senderUserId: 'alice' }); s.settleDraft('draft-1', ack); expect(s.messages).toHaveLength(1); expect(s.messages[0]).toMatchObject({ status: 'sent', clientMessageId: 'draft-1', serverMessageId: 'message-1' }); });
    it.each(['REQUEST_TIMEOUT', 'SOCKET_CLOSED', 'DISCONNECTED', 'UNKNOWN'])('keeps %s unconfirmed', code => { const s = new ChatStore('alice'); s.addDraft(draft); s.failDraft('draft-1', { code }); expect(s.messages[0]?.status).toBe('unconfirmed'); });
    it('classifies explicit rejection as failed', () => { const s = new ChatStore('alice'); s.addDraft(draft); s.failDraft('draft-1', { code: 'USER_NOT_FOUND' }); expect(s.messages[0]?.status).toBe('failed'); });
    it('partitions storage keys by app and account', () => { expect(accountKey('app-a', 'alice', 'cursor')).not.toBe(accountKey('app-b', 'alice', 'cursor')); expect(accountKey('app-a', 'alice', 'cursor')).not.toBe(accountKey('app-a', 'bob', 'cursor')); });
});
describe('session and send', () => {
    it('disposes subscriptions once and invalidates late work', () => { const g = new SessionGate(); const off = vi.fn(); g.add(off); g.dispose(); g.dispose(); expect(off).toHaveBeenCalledOnce(); expect(g.active).toBe(false); });
    it('retry reuses the original message and media ids', async () => { const s = session(); const d = { clientMessageId: 'draft-1', recipientUserId: 'bob', messageType: 'image' as const, mediaAssetId: 'asset-1' }; await sendDraft(s, d); await sendDraft(s, d); expect(s.client.sendMediaMessage).toHaveBeenNthCalledWith(1, { ...d, conversationType: 'direct' }); expect(s.client.sendMediaMessage).toHaveBeenNthCalledWith(2, { ...d, conversationType: 'direct' }); });
    it('late ACK after logout cannot settle the old draft', async () => { const d = deferred<typeof ack>(); const s = session({ sendMessage: () => d.promise }); const running = sendDraft(s, draft); await Promise.resolve(); s.gate.dispose(); d.resolve(ack); await running; expect(s.store.messages[0]?.status).toBe('sending'); });
    it('late error after logout cannot update current state', async () => { const d = deferred<never>(); const s = session({ sendMessage: () => d.promise }); const running = sendDraft(s, draft); await Promise.resolve(); s.gate.dispose(); d.reject({ code: 'DISCONNECTED' }); await running; expect(s.store.messages[0]?.status).toBe('sending'); });
    it('switch during connect stops the actual send', async () => { const d = deferred<void>(); const s = session({ connect: () => d.promise }); const p = sendDraft(s, draft); s.gate.dispose(); d.resolve(); await p; expect(s.client.sendMessage).not.toHaveBeenCalled(); });
});
describe('incremental sync', () => {
    it('starts at zero despite realtime seq 50, then follows server nextSeq', async () => { const call = vi.fn().mockResolvedValueOnce({ conversationId: 'conv-1', items: [received(1)], nextSeq: 1, hasMore: true }).mockResolvedValueOnce({ conversationId: 'conv-1', items: [received(2)], nextSeq: 2, hasMore: false }); const s = session({ syncConversation: call }); s.store.receive(received(50)); await syncConversation(s, 'conv-1'); expect(call.mock.calls.map(c => c[1])).toEqual([0, 1]); expect(s.store.cursors['conv-1']).toBe(2); expect(s.store.messages.map(m => m.conversationSeq)).toEqual([1, 2, 50]); });
    it('drops late sync results and cursor after dispose', async () => { const d = deferred<any>(); const s = session({ syncConversation: () => d.promise }); const p = syncConversation(s, 'conv-1'); await Promise.resolve(); s.gate.dispose(); d.resolve({ conversationId: 'conv-1', items: [received(1)], nextSeq: 1, hasMore: false }); await p; expect(s.store.messages).toHaveLength(0); expect(s.store.cursors['conv-1']).toBeUndefined(); });
    it('coalesces overlapping sync calls', async () => { const d = deferred<any>(); const call = vi.fn(() => d.promise); const s = session({ syncConversation: call }); const p = syncConversation(s, 'conv-1'); const q = syncConversation(s, 'conv-1'); await Promise.resolve(); d.resolve({ conversationId: 'conv-1', items: [], nextSeq: 0, hasMore: false }); await Promise.all([p, q]); expect(call).toHaveBeenCalledOnce(); });
});
describe('binary image upload', () => {
    const instruction = { method: 'PUT' as const, url: 'https://storage.nexaims.com/x?X-Amz-SignedHeaders=content-type%3Bcontent-length%3Bhost', headers: { 'Content-Type': 'image/png', 'Content-Length': '4', 'x-amz-meta-sha256': 'a'.repeat(64) }, expiresAt: '2099-01-01T00:00:00.000Z' };
    it('sends original ArrayBuffer and only signed headers', async () => { const data = new ArrayBuffer(4); let request: any; await putImageBytes(instruction, data, ((o: any) => { request = o; o.success({ statusCode: 200 }); return {}; }) as any); expect(request.data).toBe(data); expect(request.url).toBe(instruction.url); expect(request.method).toBe('PUT'); expect(request.header).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '4' }); });
    it('rejects HTTP failure returned in wx success callback', async () => { await expect(putImageBytes(instruction, new ArrayBuffer(4), ((o: any) => o.success({ statusCode: 403 })) as any)).rejects.toThrow('IMAGE_UPLOAD_HTTP_403'); });
    it('rejects wrong size before network', async () => { const request = vi.fn(); await expect(putImageBytes(instruction, new ArrayBuffer(3), request as any)).rejects.toThrow('IMAGE_SIZE_INVALID'); expect(request).not.toHaveBeenCalled(); });
});
describe('conversation list isolation', () => {
    it('does not commit a late list response after account disposal', async () => {
        const { loadConversations } = await import('../miniprogram/services/im/conversations');
        const d = deferred<any>();
        const s = session({ listConversations: () => d.promise });
        const p = loadConversations(s);
        s.gate.dispose();
        d.resolve({ data: [{ conversationId: 'alice-private' }], page: { hasMore: false, nextCursor: null, limit: 20 } });
        await expect(p).rejects.toThrow('SESSION_EXPIRED');
        expect(s.store.conversations).toHaveLength(0);
    });
});
