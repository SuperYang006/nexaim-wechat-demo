import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../server/src/app';
import { signRequest } from '../server/src/nexaim';
const config = { port: 3100, host: '127.0.0.1', wechatAppId: 'wx1111111111111111', wechatAppSecret: 'test-wechat-secret', apiBaseUrl: 'https://api.nexaims.com', wsBaseUrl: 'wss://ws.nexaims.com/ws', appId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', appKey: 'test-key', appSecret: 'test-im-secret' };
function fixture() { const im = { ensureIdentity: vi.fn().mockResolvedValue(undefined), issueToken: vi.fn().mockResolvedValue({ token: 'synthetic-im-token', expiresIn: 3600 }) }; const exchange = vi.fn().mockResolvedValue('verified-openid'); const app = createApp(config, { im, exchange }); return { app, im, exchange }; }
describe('business auth boundary', () => {
    it('refuses arbitrary userId during login', async () => { const { app, exchange } = fixture(); try {
        const r = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code: 'test-code', deviceId: 'device-a', userId: 'victim' } });
        expect(r.statusCode).toBe(400);
        expect(exchange).not.toHaveBeenCalled();
    }
    finally {
        await app.close();
    } });
    it('requires business authentication before IM ticketing', async () => { const { app, im } = fixture(); try {
        const r = await app.inject({ method: 'POST', url: '/api/im/token', payload: {} });
        expect(r.statusCode).toBe(401);
        expect(im.issueToken).not.toHaveBeenCalled();
    }
    finally {
        await app.close();
    } });
    it('binds IM identity and device to the authenticated login, never returns secrets', async () => { const { app, im } = fixture(); try {
        const login = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code: 'code', deviceId: 'device-a' } });
        expect(login.statusCode).toBe(200);
        const data = login.json().data;
        expect(data.userId).toMatch(/^wx_/);
        expect(login.body).not.toContain('verified-openid');
        expect(login.body).not.toContain('test-wechat-secret');
        expect(login.body).not.toContain('test-im-secret');
        const r = await app.inject({ method: 'POST', url: '/api/im/token', headers: { authorization: `Bearer ${data.businessToken}` }, payload: {} });
        expect(r.statusCode).toBe(200);
        expect(im.issueToken).toHaveBeenCalledWith(data.userId, 'device-a');
    }
    finally {
        await app.close();
    } });
    it('rejects ticket request identity overrides', async () => { const { app, im } = fixture(); try {
        const login = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code: 'code', deviceId: 'device-a' } });
        const r = await app.inject({ method: 'POST', url: '/api/im/token', headers: { authorization: `Bearer ${login.json().data.businessToken}` }, payload: { userId: 'victim', deviceId: 'other' } });
        expect(r.statusCode).toBe(400);
        expect(im.issueToken).not.toHaveBeenCalled();
    }
    finally {
        await app.close();
    } });
    it('revokes business session on logout', async () => { const { app } = fixture(); try {
        const login = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code: 'code', deviceId: 'device-a' } });
        const headers = { authorization: `Bearer ${login.json().data.businessToken}` };
        expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers, payload: {} })).statusCode).toBe(204);
        expect((await app.inject({ method: 'POST', url: '/api/im/token', headers, payload: {} })).statusCode).toBe(401);
    }
    finally {
        await app.close();
    } });
});
it('matches the fixed HMAC-SHA256 reference vector', () => {
    const input = { method: 'POST', path: '/api/server/apps/id/im-token', body: '{"userId":"wx_test","deviceId":"device-a"}', timestamp: '1780000000000', nonce: 'nonce' };
    expect(signRequest(input, 'test-secret')).toBe('57db1e32ecb73cc3b8c8bb2a2794e043db8007058d5683f37340996626c3ed41');
});
