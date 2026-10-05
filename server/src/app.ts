import Fastify from 'fastify';
import { z } from 'zod';
import { businessUserId, exchangeWechatCode, SessionStore } from './auth';
import { createIMBackend, type IMBackend } from './nexaim';
import type { Config } from './config';
export function createApp(config: Config, deps: {
    im?: IMBackend;
    exchange?: (code: string) => Promise<string>;
} = {}) {
    const app = Fastify({ logger: false, bodyLimit: 8192 });
    const im = deps.im ?? createIMBackend(config), exchange = deps.exchange ?? ((code: string) => exchangeWechatCode(config, code));
    const sessions = new SessionStore();
    const fail = (requestId: string, code: string, message: string) => ({ requestId, error: { code, message } });
    const bearer = (value: string | undefined) => value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
    app.get('/healthz', async () => ({ status: 'ok' }));
    app.post('/api/auth/wechat', async (request, reply) => {
        const body = z.object({ code: z.string().min(1).max(256), deviceId: z.string().min(1).max(128) }).strict().safeParse(request.body);
        if (!body.success)
            return reply.code(400).send(fail(request.id, 'INVALID_INPUT', '登录参数不正确'));
        try {
            const openid = await exchange(body.data.code), userId = businessUserId(config.wechatAppId, openid);
            await im.ensureIdentity(userId, body.data.deviceId);
            const session = sessions.create(userId, body.data.deviceId);
            return { requestId: request.id, data: { businessToken: session.token, expiresAt: new Date(session.expiresAt).toISOString(), userId, im: { appId: config.appId, apiBaseUrl: config.apiBaseUrl, wsBaseUrl: config.wsBaseUrl } } };
        }
        catch {
            return reply.code(502).send(fail(request.id, 'LOGIN_FAILED', '登录或 IM 注册失败，请检查服务端配置'));
        }
    });
    app.post('/api/im/token', async (request, reply) => {
        const session = sessions.get(bearer(request.headers.authorization));
        if (!session)
            return reply.code(401).send(fail(request.id, 'UNAUTHORIZED', '请重新登录'));
        if (!z.object({}).strict().safeParse(request.body ?? {}).success)
            return reply.code(400).send(fail(request.id, 'INVALID_INPUT', '此接口不接受身份参数'));
        try {
            return { requestId: request.id, data: await im.issueToken(session.userId, session.deviceId) };
        }
        catch {
            return reply.code(502).send(fail(request.id, 'IM_TOKEN_FAILED', '暂时无法获取 IM 凭据'));
        }
    });
    app.post('/api/auth/logout', async (request, reply) => { sessions.delete(bearer(request.headers.authorization)); return reply.code(204).send(); });
    app.setErrorHandler((error, request, reply) => { const status = (error as {
        statusCode?: number;
    })?.statusCode; reply.code(typeof status === 'number' && status >= 400 && status < 500 ? status : 500).send(fail(request.id, 'REQUEST_FAILED', '请求失败')); });
    return app;
}
