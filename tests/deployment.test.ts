import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, describe, it, expect } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'wechat-deploy-test-'));
const fixture = { WECHAT_APP_ID: 'wx1111111111111111', WECHAT_APP_SECRET: 'fixture-wechat-secret',
  NEXAIM_API_BASE_URL: 'https://api.example.invalid', NEXAIM_WS_BASE_URL: 'wss://ws.example.invalid/ws',
  NEXAIM_APP_ID: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', NEXAIM_APP_KEY: 'fixture-app-key', NEXAIM_APP_SECRET: 'fixture-im-secret' };
const envFile = join(scratch, 'fixture.env');
writeFileSync(envFile, Object.entries(fixture).map(([key, value]) => `${key}=${value}`).join('\n'));
const safeEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('business server deployment', () => {
  it('joins the existing network without exposing a host port and injects only business credentials', () => {
    const model = JSON.parse(execFileSync('docker', ['compose', '--env-file', envFile, '-f', 'infra/docker-compose.yml', 'config', '--format', 'json'], { cwd: root, env: safeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(Object.keys(model.services)).toEqual(['business-api']);
    const api = model.services['business-api'];
    expect(api.ports ?? []).toEqual([]);
    expect(api.environment.HOST).toBe('0.0.0.0'); expect(String(api.environment.PORT)).toBe('3100');
    expect(api.environment.WECHAT_APP_SECRET).toBe(fixture.WECHAT_APP_SECRET);
    expect(api.environment.POSTGRES_URL).toBeUndefined();
    expect(api.networks.nexaim.aliases).toContain('wechat-demo-api');
    expect(model.networks.nexaim).toMatchObject({ external: true, name: 'nexaim_default' });
    expect(api.restart).toBe('unless-stopped'); expect(api.healthcheck.test).toBeDefined();
    expect(api.read_only).toBe(true);
  });
  it('builds a server entry that Node can execute without a TypeScript loader', () => {
    const built = spawnSync(process.execPath, ['scripts/build-server.mjs'], { cwd: root, env: safeEnv, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    expect(existsSync(join(root, 'dist/server/index.mjs'))).toBe(true);
    const invalid = spawnSync(process.execPath, ['dist/server/index.mjs'], { cwd: root, env: safeEnv, encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('WECHAT_APP_SECRET');
    expect(invalid.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });
  it('runs the built entry with environment injection and keeps ticketing authenticated', async () => {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const child = spawn(process.execPath, [join(root, 'dist/server/index.mjs')], { cwd: scratch,
      env: { ...safeEnv, ...fixture, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server did not become ready')), 10000);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited before readiness (${code})`)); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', data => { if (String(data).includes('listening on port')) { clearTimeout(timer); resolve(); } });
      });
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      const response = await fetch(`http://127.0.0.1:${port}/api/im/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(401); expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped;
      }
    }
  }, 15000);
  it('uses an allowlist for the server image context so environment files and miniapp sources stay out', () => {
    const ignore = readFileSync(join(root, '.dockerignore'), 'utf8').trim().split('\n');
    expect(ignore[0]).toBe('**');
    expect(ignore).toContain('!server/src/**');
    expect(ignore.some(line => /^!.*(?:\.env|miniprogram|\.git)/.test(line))).toBe(false);
  });
});
