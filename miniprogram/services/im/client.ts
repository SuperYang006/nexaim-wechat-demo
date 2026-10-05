import { NexaIMClient, createWeChatFetch, createWeChatWebSocketCtor, type WeChatRuntime } from '../../vendor/nexaim-client';
import { ChatStore, errorCode } from '../../store/chat';
import { SessionGate } from './lifecycle';
import type { IMSession } from './types';
import { loadConversations } from './conversations';
import { syncConversation } from './sync';
import { getBusinessSession, type BusinessSession } from '../../store/session';
import { fetchIMToken } from '../business-api';
import { getDeviceId } from '../../utils/device';
export type LiveSession = IMSession & {
    activePeer?: string;
    activeConversationId?: string;
    nextCursor: string | null;
    hasMore: boolean;
    refreshTimer?: ReturnType<typeof setTimeout>;
};
export function createSession(client: NexaIMClient, userId: string): LiveSession {
    const s: LiveSession = { client, store: new ChatStore(userId), gate: new SessionGate(), tasks: new Map(), nextCursor: null, hasMore: false };
    s.gate.add(client.on('state', state => { if (!s.gate.active)
        return; s.store.setConnection(state); if (state === 'connected')
        void recoverSession(s).catch(e => report(s, e)); }));
    s.gate.add(client.on('error', e => report(s, e)));
    s.gate.add(client.on('message', message => {
        if (!s.gate.active || message.type !== 'message.received')
            return;
        s.store.receive(message.payload);
        // 权威未读由列表接口刷新；实时 / sync 消息不在本地重复累加未读。
        if (s.refreshTimer)
            clearTimeout(s.refreshTimer);
        s.refreshTimer = setTimeout(() => { if (s.gate.active)
            void refreshConversations(s).catch(e => report(s, e)); }, 400);
    }));
    return s;
}
function report(s: LiveSession, error: unknown) { if (s.gate.active) {
    s.store.error = errorCode(error);
    s.store.notify();
} }
export function refreshConversations(s: LiveSession, more = false): Promise<void> {
    const pending = s.tasks.get('list');
    if (pending)
        return pending as Promise<void>;
    const task = Promise.resolve().then(async () => {
        const page = await loadConversations(s, more ? s.nextCursor ?? undefined : undefined);
        s.gate.assert();
        s.nextCursor = page.nextCursor;
        s.hasMore = page.hasMore;
        s.store.error = '';
        s.store.notify();
    }).finally(() => { if (s.tasks.get('list') === task)
        s.tasks.delete('list'); });
    s.tasks.set('list', task);
    return task;
}
export function recoverSession(s: LiveSession): Promise<void> {
    const pending = s.tasks.get('recovery');
    if (pending)
        return pending as Promise<void>;
    const task = Promise.resolve().then(async () => {
        s.gate.assert();
        await s.client.connect();
        s.gate.assert();
        await refreshConversations(s);
        if (s.activePeer)
            s.activeConversationId = s.store.conversationForPeer(s.activePeer)?.conversationId ?? s.activeConversationId;
        if (s.activeConversationId)
            await syncConversation(s, s.activeConversationId);
    }).finally(() => { if (s.tasks.get('recovery') === task)
        s.tasks.delete('recovery'); });
    s.tasks.set('recovery', task);
    return task;
}
export function disposeSession(s: LiveSession) {
    if (!s.gate.active)
        return;
    s.gate.dispose();
    if (s.refreshTimer)
        clearTimeout(s.refreshTimer);
    s.client.disconnect();
    s.tasks.clear();
}
let current: LiveSession | null = null;
let owner: BusinessSession | null = null;
export function getIMSession(): LiveSession {
    const identity = getBusinessSession();
    if (!identity)
        throw new Error('请先登录');
    if (current && owner === identity)
        return current;
    disposeIM();
    owner = identity;
    // SDK 的 request.data 声明为 unknown，比微信官方类型宽；实际 JSON 请求由适配器转换为字符串。
    const runtime = wx as unknown as WeChatRuntime;
    const client = new NexaIMClient({ ...identity.im, userId: identity.userId, deviceId: getDeviceId(), clientType: 'wechat-miniprogram', clientVersion: '0.1.0', protocolVersion: '1.0', tokenProvider: () => fetchIMToken(identity), WebSocketCtor: createWeChatWebSocketCtor(runtime), fetchImpl: createWeChatFetch(runtime), reconnect: { enabled: true, baseMs: 1000, maxMs: 15000, maxAttempts: 10 } });
    current = createSession(client, identity.userId);
    return current;
}
export function currentIM() { return current; }
export function disposeIM() { if (current)
    disposeSession(current); current = null; owner = null; }
