import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const scratch: string[] = [];
const safeEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
const fixtureAppId = 'wx1111111111111111';
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'nexaim-customer-'));
  scratch.push(base);
  const dir = path.join(base, 'demo'); mkdirSync(dir);
  for (const rel of ['AGENTS.md', 'README.md', 'package.json', 'pnpm-lock.yaml', 'project.config.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore', '.dockerignore', '.env.example', 'sdk-source.json', 'scripts', 'sdk', 'server', 'miniprogram', 'infra', 'docs', 'tests']) {
    if (existsSync(path.join(root, rel))) cpSync(path.join(root, rel), path.join(dir, rel), { recursive: true, filter: source => !source.includes(`${path.sep}vendor${path.sep}`) && !/project\.private\.config\.json$/.test(source) });
  }
  // Unit fixtures share installed tools only; no SDK/source checkout is linked.
  symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
function run(dir: string, script: string, args: string[] = []) { return spawnSync(process.execPath, [script, ...args], { cwd: dir, env: safeEnv, encoding: 'utf8', timeout: 30000 }); }
function builtFixture() { const dir = fixture(); cpSync(path.join(root, 'dist'), path.join(dir, 'dist'), { recursive: true, filter: p => !p.includes(`${path.sep}releases${path.sep}`) }); return dir; }
function setBuiltIdentity(dir: string, projectId: string, clientId = projectId) {
  const file = path.join(dir, 'project.config.json'); const project = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...project, appid: projectId }));
  writeFileSync(path.join(dir, 'dist/miniprogram/config/env.js'), `exports.config = ${JSON.stringify({ wechatAppId: clientId, businessBaseUrl: 'https://business.example.invalid' })};`);
}
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('builds and typechecks with its pinned SDK without a NexaIM checkout', () => {
  const dir = fixture();
  expect(existsSync(path.resolve(dir, '../NexaIM'))).toBe(false);
  const build = run(dir, 'scripts/build.mjs');
  expect(build.status, build.stderr).toBe(0);
  const types = run(dir, 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json', '--noEmit']);
  expect(types.status, types.stdout + types.stderr).toBe(0);
  const declarations = readFileSync(path.join(dir, 'miniprogram/vendor/nexaim-client.d.ts'), 'utf8');
  expect(declarations).not.toContain('../NexaIM');
  expect(declarations).not.toContain('/Users/');
}, 40000);

it('accepts another customer AppID in the built miniapp', () => {
  const dir = builtFixture(); setBuiltIdentity(dir, fixtureAppId);
  const result = run(dir, 'scripts/check-miniapp.mjs');
  expect(result.status, result.stderr).toBe(0);
});
it('rejects a project/client AppID mismatch with a clear error', () => {
  const dir = builtFixture(); setBuiltIdentity(dir, fixtureAppId, 'wx2222222222222222');
  const result = run(dir, 'scripts/check-miniapp.mjs');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('CLIENT_APP_ID_MISMATCH');
});
it('configures both public AppID locations without touching server credentials', () => {
  const dir = fixture(); const secretFile = path.join(dir, '.env'); writeFileSync(secretFile, 'WECHAT_APP_SECRET=fixture-only\n');
  const result = run(dir, 'scripts/configure.mjs', ['--appid', fixtureAppId, '--business-url', 'https://business.example.invalid']);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(path.join(dir, 'project.config.json'), 'utf8')).appid).toBe(fixtureAppId);
  expect(readFileSync(path.join(dir, 'miniprogram/config/env.ts'), 'utf8')).toContain(fixtureAppId);
  expect(readFileSync(path.join(dir, 'miniprogram/config/env.ts'), 'utf8')).toContain('https://business.example.invalid');
  expect(readFileSync(secretFile, 'utf8')).toBe('WECHAT_APP_SECRET=fixture-only\n');
});
it('rejects invalid AppIDs before modifying public configuration', () => {
  const dir = fixture(); const original = readFileSync(path.join(dir, 'project.config.json'), 'utf8');
  const result = run(dir, 'scripts/configure.mjs', ['--appid', 'invalid', '--business-url', 'https://business.example.invalid']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('WECHAT_APP_ID_INVALID');
  expect(readFileSync(path.join(dir, 'project.config.json'), 'utf8')).toBe(original);
});
it('fails a build when the pinned SDK snapshot was modified', () => {
  const dir = fixture();
  const source = JSON.parse(readFileSync(path.join(dir, 'sdk-source.json'), 'utf8'));
  const entry = path.join(dir, source.entry);
  writeFileSync(entry, readFileSync(entry, 'utf8') + '\n// tampered fixture\n');
  const result = run(dir, 'scripts/build.mjs');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('SDK_SNAPSHOT_MISMATCH');
});
it('exports a usable customer source archive with neutral configuration and no local files', () => {
  const dir = fixture();
  writeFileSync(path.join(dir, '.env.production'), 'SECRET=fixture-only\n');
  writeFileSync(path.join(dir, 'project.private.config.json'), '{}');
  mkdirSync(path.join(dir, '.deploy')); writeFileSync(path.join(dir, '.deploy', 'runtime.log'), 'fixture');
  const out = path.join(path.dirname(dir), 'customer.tar.gz');
  const result = run(dir, 'scripts/package-demo.mjs', ['--output', out]);
  expect(result.status, result.stderr).toBe(0);
  const files = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n');
  expect(files.some(f => f.endsWith('/sdk/manifest.json'))).toBe(true);
  expect(files.some(f => /(?:\.env\.production|project\.private|\.deploy\/|node_modules\/|vendor\/|docs\/deployment\.md)/.test(f))).toBe(false);
  const dest = path.join(path.dirname(dir), 'unpacked'); mkdirSync(dest);
  execFileSync('tar', ['-xzf', out, '-C', dest]);
  const exported = path.join(dest, 'nexaim-wechat-demo');
  expect(JSON.parse(readFileSync(path.join(exported, 'project.config.json'), 'utf8')).appid).toBe('wx0000000000000000');
  expect(readFileSync(path.join(exported, 'miniprogram/config/env.ts'), 'utf8')).not.toContain('demo-api.nexaims.com');
  expect(readFileSync(path.join(exported, 'docs/getting-started.md'), 'utf8')).toContain('businessBaseUrl');
  expect(existsSync(path.join(exported, 'miniprogram/project.config.json'))).toBe(false);
});
