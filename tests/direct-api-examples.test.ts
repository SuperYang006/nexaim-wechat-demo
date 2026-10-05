import { readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { clientWsMessageSchema, clientConversationListResponseSchema, createMediaUploadRequestSchema, upsertImUserRequestSchema, upsertDeviceRequestSchema, issueImTokenRequestSchema } from '../sdk/protocol/src/index';
import { signRequest } from '../server/src/nexaim';

const root = path.resolve(import.meta.dirname, '..');
const guide = readFileSync(path.join(root, 'docs/direct-api.md'), 'utf8');
const examples = [...guide.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((match, index) => ({ index: index + 1, value: JSON.parse(match[1]!) }));
it.each(examples)('direct API JSON example $index matches the pinned wire contract', ({ value }) => {
  const schema = value.type ? clientWsMessageSchema : value.kind ? createMediaUploadRequestSchema : clientConversationListResponseSchema;
  expect(schema.safeParse(value).success).toBe(true);
});
it('executes the SDK-free backend example with correct signatures and identity registration order', async () => {
  const source = /```javascript\s*\n([\s\S]*?)\n```/.exec(guide)?.[1];
  expect(source).toBeDefined();
  const calls: string[] = [], nonces = new Set<string>();
  const appId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const context = {
    createHash, createHmac, randomUUID, AbortSignal,
    process: { env: { NEXAIM_API_BASE_URL: 'https://api.example.invalid', NEXAIM_APP_ID: appId, NEXAIM_APP_KEY: 'fixture-key', NEXAIM_APP_SECRET: 'fixture-secret' } },
    fetch: async (url: string, options: { method: string; body: string; headers: Record<string, string> }) => {
      const p = new URL(url); expect(p.origin).toBe('https://api.example.invalid');
      expect(p.pathname).toMatch(new RegExp(`^/api/server/apps/${appId}/`));
      const action = p.pathname.split('/').at(-1)!;
      const headers = options.headers;
      expect(headers['X-Nexa-App-Key']).toBe('fixture-key');
      expect(headers['X-Nexa-Signature']).toBe(signRequest({ method: options.method, path: p.pathname, timestamp: headers['X-Nexa-Timestamp']!, nonce: headers['X-Nexa-Nonce']!, body: options.body }, 'fixture-secret'));
      const schema = action === 'im-users:upsert' ? upsertImUserRequestSchema : action === 'devices:upsert' ? upsertDeviceRequestSchema : issueImTokenRequestSchema;
      const body = schema.parse(JSON.parse(options.body)); expect(body.userId).toBe('alice');
      calls.push(action); nonces.add(headers['X-Nexa-Nonce']!);
      return { ok: true, json: async () => ({ requestId: 'fixture-request', data: { token: 'fixture-token', expiresIn: 3600 } }) };
    }
  };
  const executable = source!.replace(/^import .* from 'node:crypto';\s*$/m, '');
  await vm.runInNewContext(`(async () => {${executable}\n})()`, context);
  expect(calls).toEqual(['im-users:upsert', 'devices:upsert', 'im-token']);
  expect(nonces.size).toBe(3);
});
it('ships documentation with local links that resolve without the platform repository', () => {
  expect(examples.length).toBeGreaterThan(0);
  for (const relative of ['README.md', 'docs/getting-started.md', 'docs/direct-api.md', 'docs/customer-deployment.md', 'docs/acceptance.md', 'sdk/README.md']) {
    const file = path.join(root, relative);
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]!.split('#')[0]!;
      if (!target || /^[a-z]+:\/\//i.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      expect(resolved.startsWith(root + path.sep), `${relative}: link escapes customer package`).toBe(true);
      expect(existsSync(resolved), `${relative}: missing ${target}`).toBe(true);
    }
  }
});
