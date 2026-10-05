import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'wechat-customer-deploy-'));
const envFile = join(scratch, 'fixture.env');
writeFileSync(envFile, 'WECHAT_APP_ID=wx1111111111111111\nWECHAT_APP_SECRET=fixture-only\nNEXAIM_API_BASE_URL=https://api.example.invalid\nNEXAIM_WS_BASE_URL=wss://ws.example.invalid/ws\nNEXAIM_APP_ID=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa\nNEXAIM_APP_KEY=fixture-key\nNEXAIM_APP_SECRET=fixture-only\nBUSINESS_HTTP_PORT=3210\n');
const safeEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
it('deploys independently without the platform Docker network, behind a local HTTPS proxy', () => {
  const model = JSON.parse(execFileSync('docker', ['compose', '--env-file', envFile, '-f', 'infra/docker-compose.standalone.yml', 'config', '--format', 'json'], { cwd: root, env: safeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(Object.keys(model.services)).toEqual(['business-api']);
  const service = model.services['business-api'];
  expect(service.ports).toMatchObject([{ host_ip: '127.0.0.1', published: '3210', target: 3100 }]);
  expect(Object.values(model.networks).some((network: any) => network.external)).toBe(false);
  expect(service.environment.HOST).toBe('0.0.0.0');
  expect(service.environment.NEXAIM_API_BASE_URL).toBe('https://api.example.invalid');
  expect(service.environment.NEXAIM_DOCKER_NETWORK).toBeUndefined();
  expect(service.environment.POSTGRES_URL).toBeUndefined();
  expect(service.read_only).toBe(true); expect(service.healthcheck.test).toBeDefined();
});
