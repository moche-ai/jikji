// jikji/test/increment4.test.mjs — 증분4(M4): 대시보드 API · KPI · invite 수명주기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { makeEmbedder } from '../embed.mjs';
import { MemoryCore } from '../core.mjs';
import { createDashboard } from '../dashboard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

function tmpDb() { return join(tmpdir(), `jikji-i4-${crypto.randomBytes(6).toString('hex')}.db`); }
function cleanupDb(p) { try { rmSync(p); rmSync(p + '-wal'); rmSync(p + '-shm'); } catch {} }

test('core.kpis: 활성/대기/삭제/절감추정 집계', () => {
  const dbPath = tmpDb(); const store = openStore(dbPath); const core = new MemoryCore(store, makeEmbedder());
  try {
    core.ensureTenant('nsK', 'owner:k');
    const w = core.write(ctxOf('nsK'), { text: '기억 하나' });
    core.write(ctxOf('nsK', 'assistant') && { namespaceId: 'nsK', scopes: ['write', 'retrieve'], authorType: 'assistant', actorPseudonym: null }, { text: '대기 기억' });
    core.confirm(ctxOf('nsK'), { revision_id: w.revision_id });
    const k = core.kpis(ctxOf('nsK'));
    assert.equal(k.active, 1);
    assert.equal(k.pending, 1);
    assert.ok(k.confirms >= 1);
    assert.equal(k.saved_tokens_estimate, k.confirms * 60);
  } finally { store.close(); cleanupDb(dbPath); }
});

async function req(port, path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
}

test('dashboard: 무인증 /api 401, HTML 루트 200, 인증 후 list/search/forget/kpi', async () => {
  const dbPath = tmpDb();
  const { httpServer, store } = createDashboard({ dbPath, apiSecret: 'test-secret' });
  store.ensureNamespace('nsD', 'owner:d', { auto_approve: true, default_no_train: true });
  const token = `jk_${crypto.randomBytes(12).toString('base64url')}`;
  store.insertApiKey({ keyId: 'key_d', keyPrefix: token.slice(0, 10), keyHash: crypto.createHmac('sha256', 'test-secret').update(token).digest('hex'), namespaceId: 'nsD', scopes: ['retrieve', 'write'] });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    assert.equal((await req(port, '/api/kpi')).status, 401);                 // 무인증
    const root = await req(port, '/');
    assert.equal(root.status, 200); assert.match(root.body, /Jikji/);
    // write via import, then list/search/forget
    const imp = await req(port, '/api/import', { method: 'POST', token, body: { markdown: '- 대시보드로 저장한 기억\n- 커피는 라떼' } });
    assert.ok(imp.body.imported >= 2);
    const list = await req(port, '/api/memories', { token });
    assert.ok(list.body.items.length >= 2);
    const s = await req(port, '/api/search', { method: 'POST', token, body: { need: '커피' } });
    assert.ok(s.body.results.some((r) => r.fact.includes('라떼')));
    const k = await req(port, '/api/kpi', { token });
    assert.ok(k.body.active >= 2);
    const del = await req(port, '/api/forget', { method: 'POST', token, body: { fact_id: list.body.items[0].fact_id } });
    assert.ok(del.body.active_verified);
  } finally { await new Promise((r) => httpServer.close(r)); store.close(); cleanupDb(dbPath); }
});

test('dashboard: 타 namespace 토큰은 IDOR 격리(빈 목록)', async () => {
  const dbPath = tmpDb();
  const { httpServer, store, core } = createDashboard({ dbPath, apiSecret: 'test-secret' });
  store.ensureNamespace('nsX', 'owner:x', { auto_approve: true, default_no_train: true });
  store.ensureNamespace('nsY', 'owner:y', { auto_approve: true, default_no_train: true });
  core.write({ namespaceId: 'nsX', scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null }, { text: 'nsX 비밀' });
  const tokY = `jk_${crypto.randomBytes(12).toString('base64url')}`;
  store.insertApiKey({ keyId: 'key_y', keyPrefix: tokY.slice(0, 10), keyHash: crypto.createHmac('sha256', 'test-secret').update(tokY).digest('hex'), namespaceId: 'nsY', scopes: ['retrieve'] });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const list = await req(port, '/api/memories', { token: tokY });
    assert.equal(list.body.items.length, 0);
    const s = await req(port, '/api/search', { method: 'POST', token: tokY, body: { need: 'nsX 비밀' } });
    assert.equal(s.body.results.length, 0);
  } finally { await new Promise((r) => httpServer.close(r)); store.close(); cleanupDb(dbPath); }
});

test('dashboard: retrieve-only 토큰은 forget/review 못함(403) + 보안 헤더', async () => {
  const dbPath = tmpDb();
  const { httpServer, store, core } = createDashboard({ dbPath, apiSecret: 'test-secret' });
  store.ensureNamespace('nsR', 'owner:r', { auto_approve: true, default_no_train: true });
  const w = core.write({ namespaceId: 'nsR', scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null }, { text: '지울 수 없어야' });
  const roTok = `jk_${crypto.randomBytes(12).toString('base64url')}`;
  store.insertApiKey({ keyId: 'key_ro', keyPrefix: roTok.slice(0, 10), keyHash: crypto.createHmac('sha256', 'test-secret').update(roTok).digest('hex'), namespaceId: 'nsR', scopes: ['retrieve'] });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const del = await req(port, '/api/forget', { method: 'POST', token: roTok, body: { fact_id: w.fact_id } });
    assert.equal(del.status, 403);
    // 보안 헤더 확인
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('cache-control') || '', /no-store/);
  } finally { await new Promise((r) => httpServer.close(r)); store.close(); cleanupDb(dbPath); }
});

test('invite CLI: create → redeem(키 발급) → 재리딤 소진 거부', () => {
  const dbPath = tmpDb();
  const env = { ...process.env, JIKJI_DB: dbPath, JIKJI_API_HMAC_SECRET: 'test-secret', INFRA_TELEMETRY: 'off' };
  try {
    const inv = JSON.parse(execFileSync('node', [join(root, 'bin/invite.mjs'), '--create', '--namespace', 'ns_beta', '--scopes', 'retrieve', '--max-uses', '1'], { env, encoding: 'utf8' }));
    assert.match(inv.code, /^jikji-/);
    const red = JSON.parse(execFileSync('node', [join(root, 'bin/invite.mjs'), '--redeem', inv.code], { env, encoding: 'utf8' }));
    assert.match(red.token, /^jk_/);
    assert.deepEqual(red.scopes, ['retrieve']);
    // 발급된 키가 유효
    const store = openStore(dbPath);
    assert.ok(store.resolveKey(crypto.createHmac('sha256', 'test-secret').update(red.token).digest('hex')));
    store.close();
    // 재리딤(1회 소진) → 실패
    assert.throws(() => execFileSync('node', [join(root, 'bin/invite.mjs'), '--redeem', inv.code], { env, stdio: 'pipe' }));
  } finally { cleanupDb(dbPath); }
});
