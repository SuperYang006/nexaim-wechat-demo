import { getBusinessSession } from '../../store/session';
import { logout } from '../../services/business-api';
import { getIMSession, disposeIM, recoverSession, refreshConversations, type LiveSession } from '../../services/im/client';
type Row = {
    id: string;
    peer: string;
    summary: string;
    unread: number;
    time: string;
};
Page({
    data: { rows: [] as Row[], state: 'disconnected', userId: '', peer: '', loading: false, hasMore: false, error: '' },
    _session: null as LiveSession | null, _unsubscribe: null as (() => unknown) | null, _epoch: 0, _visible: false,
    onShow() {
        const identity = getBusinessSession();
        if (!identity) {
            wx.reLaunch({ url: '/pages/login/index' });
            return;
        }
        this._visible = true;
        this._epoch++;
        this._unsubscribe?.();
        this._session = getIMSession();
        this.setData({ userId: identity.userId });
        this._unsubscribe = this._session.store.subscribe(() => this.render());
        this.render();
        void this.refresh();
    },
    onHide() { this.cleanup(); }, onUnload() { this.cleanup(); },
    cleanup() { this._visible = false; this._epoch++; this._unsubscribe?.(); this._unsubscribe = null; },
    render() { const s = this._session; if (!s?.gate.active || !this._visible)
        return; this.setData({ rows: s.store.conversations.map(c => ({ id: c.conversationId, peer: c.peerUserId, summary: c.lastMessage === null ? '暂无消息' : c.lastMessage.messageType === 'text' ? ('text' in c.lastMessage.content ? c.lastMessage.content.text : '') : '[图片/文件]', unread: c.unreadCount, time: c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleTimeString() : '' })), state: s.store.connection, hasMore: s.hasMore, error: s.store.error }); },
    async refresh() { const s = this._session, e = this._epoch; if (!s || this.data.loading)
        return; this.setData({ loading: true, error: '' }); try {
        await recoverSession(s);
    }
    catch (error) {
        if (this._visible && e === this._epoch && s.gate.active)
            this.setData({ error: error instanceof Error ? error.message : '加载失败' });
    }
    finally {
        if (this._visible && e === this._epoch)
            this.setData({ loading: false });
    } },
    async onLoadMore() { const s = this._session, e = this._epoch; if (!s || !s.hasMore || this.data.loading)
        return; this.setData({ loading: true }); try {
        await refreshConversations(s, true);
    }
    catch {
        if (e === this._epoch)
            this.setData({ error: '加载失败，请重试' });
    }
    finally {
        if (e === this._epoch)
            this.setData({ loading: false });
    } },
    onPeerInput(e: {
        detail: {
            value: string;
        };
    }) { this.setData({ peer: e.detail.value }); },
    onStartChat() { const peer = this.data.peer.trim(); if (!peer || peer === this.data.userId) {
        wx.showToast({ title: '请输入另一位用户的 ID', icon: 'none' });
        return;
    } wx.navigateTo({ url: `/pages/chat/index?peer=${encodeURIComponent(peer)}` }); },
    onOpenChat(e: {
        currentTarget: {
            dataset: {
                peer: string;
                id: string;
            };
        };
    }) { const { peer, id } = e.currentTarget.dataset; wx.navigateTo({ url: `/pages/chat/index?peer=${encodeURIComponent(peer)}&conversationId=${encodeURIComponent(id)}` }); },
    onCopyId() { wx.setClipboardData({ data: this.data.userId }); },
    async onLogout() { disposeIM(); await logout(); wx.reLaunch({ url: '/pages/login/index' }); }
});
