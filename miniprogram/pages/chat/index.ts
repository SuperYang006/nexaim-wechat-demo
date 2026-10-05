import { getBusinessSession } from '../../store/session';
import { getIMSession, recoverSession, refreshConversations, type LiveSession } from '../../services/im/client';
import { sendDraft, markRead } from '../../services/im/messages';
import { chooseImage, uploadImage, type ImageUploadTask } from '../../services/im/media';
import { newId } from '../../utils/device';
import { ForegroundTask } from '../../services/im/lifecycle';
import type { LocalMessage } from '../../store/chat';
type Row = LocalMessage & {
    mine: boolean;
    imageUrl: string;
    imageFailed: boolean;
    statusText: string;
};
type Download = {
    url: string;
    expiresAt: string;
};
Page({
    data: { peer: '', state: 'disconnected', rows: [] as Row[], busy: false, reading: false, error: '', uploadStage: '', hasUploadTask: false },
    _session: null as LiveSession | null, _unsubscribe: null as (() => unknown) | null, _visible: false, _epoch: 0,
    _conversationId: '', _imageTask: null as ImageUploadTask | null,
    _imageRun: null as ForegroundTask | null,
    _images: new Map<string, Download>(), _fetching: new Set<string>(), _failed: new Set<string>(), _imageRetries: new Map<string, number>(),
    onLoad(options: Record<string, string | undefined>) { this._imageRun?.cancel(); this._imageRun = null; this._images = new Map(); this._fetching = new Set(); this._failed = new Set(); this._imageRetries = new Map(); this._imageTask = null; this.setData({ peer: decodeURIComponent(options.peer ?? '') }); this._conversationId = options.conversationId ? decodeURIComponent(options.conversationId) : ''; },
    onShow() {
        if (!getBusinessSession()) {
            this._imageRun?.cancel();
            this._imageRun = null;
            this.cleanup();
            wx.reLaunch({ url: '/pages/login/index' });
            return;
        }
        const s = getIMSession();
        if (this._session !== s) {
            this._imageRun?.cancel();
            this._imageRun = null;
            this._imageTask = null;
            this._images = new Map();
            this._fetching = new Set();
            this._failed = new Set();
            this._imageRetries = new Map();
            this.setData({ hasUploadTask: false, uploadStage: '' });
        }
        this._fetching = new Set();
        this._session = s;
        this._visible = true;
        this._imageRun?.show();
        this._epoch++;
        this._unsubscribe?.();
        s.activePeer = this.data.peer;
        s.activeConversationId = this._conversationId || undefined;
        this._unsubscribe = s.store.subscribe(() => this.render());
        this.setData({ busy: !!this._imageRun, reading: false });
        this.render();
        void this.refresh();
    },
    onHide() { this._imageRun?.hide(); this.cleanup(); },
    onUnload() { this._imageRun?.cancel(); this._imageRun = null; this.cleanup(); },
    cleanup() { this._visible = false; this._epoch++; this._unsubscribe?.(); this._unsubscribe = null; if (this._session?.activePeer === this.data.peer) {
        this._session.activePeer = undefined;
        this._session.activeConversationId = undefined;
    } },
    isCurrent(s: LiveSession, epoch: number) { return this._visible && s.gate.active && s === this._session && epoch === this._epoch; },
    render() {
        const s = this._session;
        if (!s?.gate.active || !this._visible)
            return;
        const messages = s.store.forPeer(this.data.peer, this._conversationId || undefined);
        const labels = { sending: '发送中', sent: '已发送', unconfirmed: '结果未确认', failed: '发送失败' };
        const rows = messages.map(m => { const cached = m.mediaAssetId ? this._images.get(m.mediaAssetId) : undefined; const valid = cached && Date.parse(cached.expiresAt) > Date.now() + 5000; return { ...m, mine: m.senderUserId === s.store.userId, imageUrl: valid ? cached.url : '', imageFailed: !!m.mediaAssetId && this._failed.has(m.mediaAssetId), statusText: labels[m.status] + (m.errorCode ? ` (${m.errorCode})` : '') }; });
        this.setData({ rows, state: s.store.connection });
        for (const row of rows)
            if (row.messageType === 'image' && row.mediaAssetId && !row.imageUrl && !row.imageFailed && !this._fetching.has(row.mediaAssetId))
                void this.fetchImage(row.mediaAssetId);
    },
    async refresh() { const s = this._session, e = this._epoch; if (!s)
        return; try {
        await recoverSession(s);
    }
    catch (error) {
        if (this.isCurrent(s, e))
            this.setData({ error: error instanceof Error ? error.message : '同步失败，请重试' });
    } },
    async onSendText(event: {
        detail: {
            text: string;
        };
    }) {
        const s = this._session, e = this._epoch;
        if (!s || this.data.busy)
            return;
        this.setData({ busy: true, error: '' });
        try {
            await sendDraft(s, { recipientUserId: this.data.peer, clientMessageId: newId(), messageType: 'text', text: event.detail.text });
            if (this.isCurrent(s, e))
                await refreshConversations(s);
        }
        catch {
            if (this.isCurrent(s, e))
                this.setData({ error: '会话刷新失败，可点击重新同步' });
        }
        finally {
            if (this.isCurrent(s, e))
                this.setData({ busy: false });
        }
    },
    async onRetry(event: {
        detail: {
            id: string;
        };
    }) {
        const s = this._session, e = this._epoch;
        if (!s || this.data.busy)
            return;
        const message = s.store.messages.find(m => m.clientMessageId === event.detail.id);
        if (!message?.draft || message.status !== 'unconfirmed')
            return;
        this.setData({ busy: true });
        try {
            await sendDraft(s, message.draft);
            if (this.isCurrent(s, e))
                await refreshConversations(s);
        }
        catch {
            if (this.isCurrent(s, e))
                this.setData({ error: '刷新失败，请重试' });
        }
        finally {
            if (this.isCurrent(s, e))
                this.setData({ busy: false });
        }
    },
    async onSendImage() {
        const s = this._session, peer = this.data.peer;
        if (!s || this.data.busy || this._imageRun)
            return;
        const run = new ForegroundTask();
        this._imageRun = run;
        const canContinue = () => this._imageRun === run &&
            this._session === s && s.gate.active && this._visible && this.data.peer === peer;
        this.setData({ busy: true, error: '', uploadStage: '准备图片…' });
        try {
            if (!this._imageTask) {
                const task = await chooseImage();
                await run.ready();
                if (!canContinue())
                    return;
                this._imageTask = task;
            }
            this.setData({ hasUploadTask: true, uploadStage: this._imageTask.putDone ? '确认上传…' : '上传图片…' });
            const mediaAssetId = await uploadImage(s, this._imageTask);
            await run.ready();
            if (!canContinue())
                return;
            const draft = { recipientUserId: peer, clientMessageId: newId(), messageType: 'image' as const, mediaAssetId };
            this._imageTask = null;
            this.setData({ hasUploadTask: false, uploadStage: '' });
            await sendDraft(s, draft);
            await run.ready();
            if (canContinue())
                await refreshConversations(s);
        }
        catch (error) {
            await run.ready();
            if (!canContinue())
                return;
            const native = error as {
                errMsg?: string;
            };
            if (native?.errMsg?.includes('cancel'))
                this.setData({ uploadStage: '' });
            else
                this.setData({ error: error instanceof Error ? error.message : '图片操作失败', uploadStage: this._imageTask ? '上传未完成，可重试或重新选图' : '' });
        }
        finally {
            await run.ready();
            if (canContinue()) {
                run.cancel();
                this._imageRun = null;
                this.setData({ busy: false, hasUploadTask: !!this._imageTask });
            }
        }
    },
    onDiscardImage() { if (this.data.busy)
        return; this._imageTask = null; this.setData({ hasUploadTask: false, uploadStage: '', error: '' }); },
    async fetchImage(id: string) {
        const s = this._session, e = this._epoch;
        if (!s || this._fetching.has(id))
            return;
        this._fetching.add(id);
        try {
            const { download } = await s.client.getMediaDownloadUrl(id);
            if (this.isCurrent(s, e)) {
                this._images.set(id, download);
                this._failed.delete(id);
            }
        }
        catch {
            if (this.isCurrent(s, e))
                this._failed.add(id);
        }
        finally {
            if (this.isCurrent(s, e)) {
                this._fetching.delete(id);
                this.render();
            }
        }
    },
    onImageError(event: {
        detail: {
            id: string;
        };
    }) { const id = event.detail.id; const tried = this._imageRetries.get(id) ?? 0; this._images.delete(id); if (tried >= 1)
        this._failed.add(id);
    else
        this._imageRetries.set(id, tried + 1); this.render(); },
    onReloadImage(event: {
        detail: {
            id: string;
        };
    }) { const id = event.detail.id; this._images.delete(id); this._failed.delete(id); this._imageRetries.delete(id); this.render(); },
    async onPreview(event: {
        detail: {
            id: string;
        };
    }) { const s = this._session, e = this._epoch; if (!s)
        return; try {
        const { download } = await s.client.getMediaDownloadUrl(event.detail.id);
        if (this.isCurrent(s, e))
            wx.previewImage({ current: download.url, urls: [download.url] });
    }
    catch {
        if (this.isCurrent(s, e))
            wx.showToast({ title: '图片暂时不可用', icon: 'none' });
    } },
    async onMarkRead() {
        const s = this._session, e = this._epoch;
        if (!s || this.data.reading)
            return;
        const row = [...this.data.rows].reverse().find(m => m.conversationId && m.conversationSeq);
        if (!row?.conversationId || !row.conversationSeq)
            return;
        this.setData({ reading: true });
        try {
            await markRead(s, row.conversationId, row.conversationSeq);
            if (this.isCurrent(s, e))
                await refreshConversations(s);
        }
        catch {
            if (this.isCurrent(s, e))
                this.setData({ error: '已读上报失败，请重试' });
        }
        finally {
            if (this.isCurrent(s, e))
                this.setData({ reading: false });
        }
    }
});
