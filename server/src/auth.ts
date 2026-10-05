import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config';
export function businessUserId(appId: string, openid: string) {
    return 'wx_' + createHash('sha256').update(`${appId}:${openid}`).digest('hex').slice(0, 32);
}
export async function exchangeWechatCode(config: Config, code: string): Promise<string> {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', config.wechatAppId);
    url.searchParams.set('secret', config.wechatAppSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok)
        throw new Error('WECHAT_LOGIN_FAILED');
    // session_key / 原始 openid 不下发到客户端，也不记录换码 URL。
    const data = z.object({ openid: z.string().min(1) }).safeParse(await response.json());
    if (!data.success)
        throw new Error('WECHAT_LOGIN_FAILED');
    return data.data.openid;
}
export type BusinessSession = {
    userId: string;
    deviceId: string;
    expiresAt: number;
};
export class SessionStore {
    private entries = new Map<string, BusinessSession>();
    constructor(private now: () => number = Date.now) { }
    create(userId: string, deviceId: string) {
        for (const [key, value] of this.entries)
            if (value.expiresAt <= this.now())
                this.entries.delete(key);
        if (this.entries.size >= 1000)
            throw new Error('SESSION_CAPACITY_REACHED');
        const token = randomBytes(32).toString('hex');
        const session = { userId, deviceId, expiresAt: this.now() + 3600000 };
        this.entries.set(token, session);
        return { token, ...session };
    }
    get(token: string) { const session = this.entries.get(token); if (session && session.expiresAt > this.now())
        return session; this.entries.delete(token); return undefined; }
    delete(token: string) { this.entries.delete(token); }
}
