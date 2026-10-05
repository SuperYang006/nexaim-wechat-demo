import { config } from '../config/env';
import { getDeviceId } from '../utils/device';
import { getBusinessSession, setBusinessSession, type BusinessSession } from '../store/session';
let loginEpoch = 0;
async function request<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
    if (!config.businessBaseUrl)
        throw new Error('请先配置业务服务端地址');
    return new Promise<T>((resolve, reject) => wx.request({ url: config.businessBaseUrl.replace(/\/+$/, '') + path, method: 'POST', data: body, header: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, timeout: 15000, success: r => {
            const envelope = r.data as {
                data: T;
                error?: {
                    code: string;
                    message: string;
                };
            };
            if (r.statusCode >= 200 && r.statusCode < 300)
                resolve(envelope?.data);
            else
                reject(Object.assign(new Error(envelope?.error?.message ?? '业务请求失败'), { code: envelope?.error?.code ?? 'BUSINESS_REQUEST_FAILED' }));
        }, fail: () => reject(new Error('网络请求失败，请检查连接配置')) }));
}
export async function login() {
    const epoch = ++loginEpoch;
    const { code } = await new Promise<WechatMiniprogram.LoginSuccessCallbackResult>((resolve, reject) => wx.login({ success: resolve, fail: reject }));
    const result = await request<BusinessSession>('/api/auth/wechat', { code, deviceId: getDeviceId() });
    if (epoch !== loginEpoch)
        throw new Error('SESSION_EXPIRED');
    setBusinessSession(result);
    return result;
}
export async function fetchIMToken(owner: BusinessSession): Promise<string> {
    if (getBusinessSession() !== owner)
        throw new Error('SESSION_EXPIRED');
    const data = await request<{
        token: string;
    }>('/api/im/token', {}, owner.businessToken);
    if (getBusinessSession() !== owner)
        throw new Error('SESSION_EXPIRED');
    return data.token;
}
export async function logout() {
    ++loginEpoch;
    const old = getBusinessSession();
    setBusinessSession(null);
    if (old)
        await request('/api/auth/logout', {}, old.businessToken).catch(() => { });
}
