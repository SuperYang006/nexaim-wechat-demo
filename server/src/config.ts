import { z } from 'zod';
const schema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3100), HOST: z.string().default('127.0.0.1'),
    WECHAT_APP_ID: z.string().regex(/^wx[a-z0-9]+$/), WECHAT_APP_SECRET: z.string().min(1),
    NEXAIM_API_BASE_URL: z.string().url(), NEXAIM_WS_BASE_URL: z.string().url().refine(x => /^wss?:\/\//.test(x) && new URL(x).pathname.endsWith('/ws')),
    NEXAIM_APP_ID: z.string().uuid(), NEXAIM_APP_KEY: z.string().min(1), NEXAIM_APP_SECRET: z.string().min(1)
});
export type Config = {
    port: number;
    host: string;
    wechatAppId: string;
    wechatAppSecret: string;
    apiBaseUrl: string;
    wsBaseUrl: string;
    appId: string;
    appKey: string;
    appSecret: string;
};
export function readConfig(env: NodeJS.ProcessEnv): Config {
    const parsed = schema.safeParse(env);
    if (!parsed.success)
        throw new Error(`请填写 .env 配置项：${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
    const v = parsed.data;
    return { port: v.PORT, host: v.HOST, wechatAppId: v.WECHAT_APP_ID, wechatAppSecret: v.WECHAT_APP_SECRET, apiBaseUrl: v.NEXAIM_API_BASE_URL.replace(/\/+$/, ''), wsBaseUrl: v.NEXAIM_WS_BASE_URL, appId: v.NEXAIM_APP_ID, appKey: v.NEXAIM_APP_KEY, appSecret: v.NEXAIM_APP_SECRET };
}
