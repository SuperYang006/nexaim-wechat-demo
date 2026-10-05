import { config } from '../../config/env';
import { login } from '../../services/business-api';
import { getBusinessSession } from '../../store/session';
Page({
    data: { busy: false, configured: !!config.businessBaseUrl, error: '' },
    onShow() { if (getBusinessSession())
        wx.reLaunch({ url: '/pages/conversations/index' }); },
    async onLogin() {
        if (this.data.busy || !config.businessBaseUrl)
            return;
        this.setData({ busy: true, error: '' });
        try {
            await login();
            wx.reLaunch({ url: '/pages/conversations/index' });
        }
        catch (e) {
            this.setData({ error: e instanceof Error ? e.message : '登录失败，请重试' });
        }
        finally {
            this.setData({ busy: false });
        }
    }
});
