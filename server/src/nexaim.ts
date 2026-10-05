import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config';
export function signRequest(input: {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    body: string;
}, secret: string) {
    const canonical = [input.method.toUpperCase(), input.path, input.timestamp, input.nonce, createHash('sha256').update(input.body).digest('hex')].join('\n');
    return createHmac('sha256', secret).update(canonical).digest('hex');
}
export type IMBackend = {
    ensureIdentity(userId: string, deviceId: string): Promise<void>;
    issueToken(userId: string, deviceId: string): Promise<{
        token: string;
        expiresIn: number;
    }>;
};
export function createIMBackend(config: Config, fetchImpl: typeof fetch = fetch): IMBackend {
    async function post(action: string, payload: unknown) {
        const path = `/api/server/apps/${config.appId}/${action}`;
        const body = JSON.stringify(payload), timestamp = String(Date.now()), nonce = randomUUID();
        const response = await fetchImpl(`${config.apiBaseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Nexa-App-Key': config.appKey, 'X-Nexa-Timestamp': timestamp, 'X-Nexa-Nonce': nonce, 'X-Nexa-Request-Id': randomUUID(), 'X-Nexa-Signature': signRequest({ method: 'POST', path, timestamp, nonce, body }, config.appSecret) } });
        if (!response.ok)
            throw new Error('NEXAIM_REQUEST_FAILED');
        const envelope = z.object({ data: z.unknown() }).parse(await response.json());
        return envelope.data;
    }
    return {
        async ensureIdentity(userId, deviceId) {
            await post('im-users:upsert', { userId });
            await post('devices:upsert', { userId, deviceId, platform: 'web' });
        },
        async issueToken(userId, deviceId) {
            return z.object({ token: z.string().min(1), expiresIn: z.number().positive() }).parse(await post('im-token', { userId, deviceId, platform: 'web', protocolVersion: '1.0' }));
        }
    };
}
