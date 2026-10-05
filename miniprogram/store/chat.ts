import type { ClientConversationItem, ConnectionState } from '../vendor/nexaim-client';
import type { ReceivedMessage, SendAck, Draft } from '../services/im/types';
export type LocalMessage = {
    key: string;
    clientMessageId?: string;
    serverMessageId?: string;
    conversationId?: string;
    conversationSeq?: number;
    recipientUserId?: string;
    senderUserId: string;
    messageType: 'text' | 'image' | 'file';
    text?: string;
    mediaAssetId?: string;
    createdAt: string;
    status: 'sending' | 'sent' | 'unconfirmed' | 'failed';
    errorCode?: string;
    draft?: Draft;
};
const REJECTED = new Set(['USER_NOT_FOUND', 'USER_DISABLED', 'VALIDATION_FAILED', 'MEDIA_NOT_FOUND', 'MEDIA_NOT_UPLOADED', 'RATE_LIMIT_EXCEEDED', 'AUTH_TOKEN_INVALID', 'INVALID_INPUT']);
export function errorCode(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
}
export class ChatStore {
    messages: LocalMessage[] = [];
    conversations: ClientConversationItem[] = [];
    cursors: Record<string, number> = {};
    connection: ConnectionState = 'disconnected';
    error = '';
    private listeners = new Set<() => void>();
    constructor(readonly userId: string) { }
    subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    notify() { this.messages.sort((a, b) => (a.conversationSeq ?? Number.MAX_SAFE_INTEGER) - (b.conversationSeq ?? Number.MAX_SAFE_INTEGER)); for (const fn of this.listeners)
        fn(); }
    setConnection(state: ConnectionState) { this.connection = state; this.notify(); }
    mergeConversations(items: ClientConversationItem[]) {
        const rows = new Map(this.conversations.map(c => [c.conversationId, c]));
        for (const c of items)
            rows.set(c.conversationId, c);
        this.conversations = [...rows.values()].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || b.conversationId.localeCompare(a.conversationId));
        this.notify();
    }
    conversationForPeer(peer: string) { return this.conversations.find(c => c.peerUserId === peer); }
    receive(message: ReceivedMessage) {
        const old = this.messages.find(m => m.serverMessageId === message.serverMessageId);
        const details = { conversationId: message.conversationId, conversationSeq: message.conversationSeq, serverMessageId: message.serverMessageId, senderUserId: message.senderUserId, messageType: message.messageType, createdAt: message.createdAt, status: 'sent' as const, ...(message.messageType === 'text' ? { text: message.content.text } : { mediaAssetId: message.content.mediaAssetId }) };
        if (old)
            Object.assign(old, details);
        else
            this.messages.push({ key: message.serverMessageId, ...details });
        this.notify();
    }
    addDraft(input: Draft) {
        const old = this.messages.find(m => m.clientMessageId === input.clientMessageId);
        if (old) {
            if (old.status !== 'sent')
                old.status = 'sending';
            this.notify();
            return;
        }
        this.messages.push({ key: input.clientMessageId, clientMessageId: input.clientMessageId, recipientUserId: input.recipientUserId, senderUserId: this.userId, messageType: input.messageType, createdAt: new Date().toISOString(), status: 'sending', draft: input, ...(input.messageType === 'text' ? { text: input.text } : { mediaAssetId: input.mediaAssetId }) });
        this.notify();
    }
    settleDraft(id: string, ack: SendAck) {
        const row = this.messages.find(m => m.clientMessageId === id);
        if (!row)
            return;
        this.messages = this.messages.filter(m => m === row || m.serverMessageId !== ack.serverMessageId);
        Object.assign(row, ack, { status: 'sent', errorCode: undefined });
        this.notify();
    }
    failDraft(id: string, error: unknown) {
        const row = this.messages.find(m => m.clientMessageId === id);
        if (!row || row.status === 'sent')
            return;
        const code = errorCode(error);
        row.status = REJECTED.has(code) ? 'failed' : 'unconfirmed';
        row.errorCode = code;
        this.notify();
    }
    forPeer(peer: string, conversationId?: string) {
        const id = conversationId ?? this.conversationForPeer(peer)?.conversationId;
        return this.messages.filter(m => (id && m.conversationId === id) || m.recipientUserId === peer);
    }
}
