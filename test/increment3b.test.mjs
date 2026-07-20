// jikji/test/increment3b.test.mjs — 증분3 M3: mint-key CLI 라운드트립 · 스코프 강제 · 클라이언트 설정 유효성
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { MemoryCore } from '../core.mjs';
import { makeEmbedder } from '../embed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('mint-key CLI: retrieve-only 키 발급 → resolveKey 로 scope 확인', () => {
  const dbPath = join(tmpdir(), `jikji-mk-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    const out = execFileSync('node', [join(root, 'bin/mint-key.mjs'), '--namespace', 'ns_a', '--scopes', 'retrieve'],
      { env: { ...process.env, JIKJI_DB: dbPath, JIKJI_API_HMAC_SECRET: 'test-secret', INFRA_TELEMETRY: 'off' }, encoding: 'utf8' });
    const j = JSON.parse(out);
    assert.match(j.token, /^jk_/);
    assert.deepEqual(j.scopes, ['retrieve']);
    // 같은 시크릿으로 HMAC → resolveKey 가 namespace/scope 도출
    const store = openStore(dbPath);
    const hash = crypto.createHmac('sha256', 'test-secret').update(j.token).digest('hex');
    const resolved = store.resolveKey(hash);
    assert.equal(resolved.namespaceId, 'ns_a');
    assert.deepEqual(resolved.scopes, ['retrieve']);
    store.close();
  } finally { try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} }
});

test('retrieve-only 키: search 허용, write 403 (스코프 강제)', async () => {
  const dbPath = join(tmpdir(), `jikji-scope-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder());
  try {
    core.ensureTenant('ns_a', 'owner:a');
    const roCtx = { namespaceId: 'ns_a', scopes: ['retrieve'], authorType: 'self', actorPseudonym: null };
    assert.throws(() => core.write(roCtx, { text: 'x' }), (e) => e.code === 403);
    // search 는 허용(빈 결과여도 스코프 통과)
    const r = await core.search(roCtx, { need: '무엇' });
    assert.ok(Array.isArray(r.results));
  } finally { store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} }
});

test('mint-key: prod 시크릿 부재 = fail-closed(비정상 종료)', () => {
  const dbPath = join(tmpdir(), `jikji-mk2-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    assert.throws(() => execFileSync('node', [join(root, 'bin/mint-key.mjs'), '--namespace', 'ns_a'],
      { env: { ...process.env, JIKJI_DB: dbPath, JIKJI_ENV: 'production', JIKJI_API_HMAC_SECRET: '', INFRA_TELEMETRY: 'off' }, stdio: 'pipe' }));
  } finally { try { rmSync(dbPath); } catch {} }
});

test('mint-key --revoke: 폐기 후 resolveKey null', () => {
  const dbPath = join(tmpdir(), `jikji-rev-${crypto.randomBytes(6).toString('hex')}.db`);
  const env = { ...process.env, JIKJI_DB: dbPath, JIKJI_API_HMAC_SECRET: 'test-secret', INFRA_TELEMETRY: 'off' };
  try {
    const j = JSON.parse(execFileSync('node', [join(root, 'bin/mint-key.mjs'), '--namespace', 'ns_a', '--scopes', 'retrieve'], { env, encoding: 'utf8' }));
    const store = openStore(dbPath);
    const hash = crypto.createHmac('sha256', 'test-secret').update(j.token).digest('hex');
    assert.ok(store.resolveKey(hash), '폐기 전 유효');
    store.close();
    execFileSync('node', [join(root, 'bin/mint-key.mjs'), '--revoke', j.key_id], { env, encoding: 'utf8' });
    const store2 = openStore(dbPath);
    assert.equal(store2.resolveKey(hash), null, '폐기 후 무효');
    store2.close();
  } finally { try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} }
});

test('mint-key: scope 중복 제거 + 빈 scope 거부', () => {
  const dbPath = join(tmpdir(), `jikji-sc-${crypto.randomBytes(6).toString('hex')}.db`);
  const env = { ...process.env, JIKJI_DB: dbPath, JIKJI_API_HMAC_SECRET: 'test-secret', INFRA_TELEMETRY: 'off' };
  try {
    const j = JSON.parse(execFileSync('node', [join(root, 'bin/mint-key.mjs'), '--namespace', 'ns_a', '--scopes', 'retrieve,retrieve,write'], { env, encoding: 'utf8' }));
    assert.deepEqual(j.scopes, ['retrieve', 'write']);   // 중복 제거
    assert.throws(() => execFileSync('node', [join(root, 'bin/mint-key.mjs'), '--namespace', 'ns_a', '--scopes', ' , '], { env, stdio: 'pipe' }));
  } finally { try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} }
});

test('install.sh: 기존 사용자 훅 보존 + jikji 훅 append + 토큰 미출력', () => {
  const dir = join(tmpdir(), `jikji-inst-${crypto.randomBytes(6).toString('hex')}`);
  try {
    execFileSync('mkdir', ['-p', join(dir, '.claude')]);
    // 사용자 기존 SessionStart 훅
    const pre = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/user/existing.sh' }] }] } };
    execFileSync('bash', ['-c', `cat > '${join(dir, '.claude/settings.json')}'`], { input: JSON.stringify(pre) });
    const out = execFileSync('bash', [join(root, 'clients/claude-code/install.sh'), dir],
      { env: { ...process.env, JIKJI_URL: 'http://127.0.0.1:8107/mcp' }, encoding: 'utf8' });
    assert.ok(!/jk_[A-Za-z0-9_-]{20,}/.test(out), '설치 출력에 실제 토큰 없음');
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
    const ssCmds = settings.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(ssCmds.includes('/user/existing.sh'), '기존 훅 보존');
    assert.ok(ssCmds.some((c) => c.endsWith('session-start.sh')), 'jikji 훅 추가');
    assert.ok(settings.hooks.Stop.length >= 1, 'Stop 훅 추가');
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.jikji.headers.Authorization, 'Bearer ${JIKJI_TOKEN}');   // env 참조(하드코딩 아님)
  } finally { try { rmSync(dir, { recursive: true }); } catch {} }
});

test('클라이언트 설정 파일 유효성 (.mcp.json / settings.hooks.json / cursor rule)', () => {
  JSON.parse(readFileSync(join(root, 'clients/claude-code/.mcp.json'), 'utf8'));
  const hooks = JSON.parse(readFileSync(join(root, 'clients/claude-code/settings.hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.SessionStart && hooks.hooks.Stop);
  const mdc = readFileSync(join(root, 'clients/cursor/jikji.mdc'), 'utf8');
  assert.ok(mdc.includes('memory_search') && mdc.includes('alwaysApply'));
});
