// jikji/test/increment10-internal.test.mjs — 내부 대시보드 엔드포인트(loopback + 서버간 토큰)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { createJikjiServer } from '../server.mjs';

const DEV_TOKEN = 'dev-jikji-internal-token';

async function withServer(fn) {
  const dbPath = join(tmpdir(), `jikji-internal-${crypto.randomBytes(6).toString('hex')}.db`);
  const { httpServer, store, core } = createJikjiServer({ dbPath }); // prod=false → dev internal token
  store.ensureNamespace('nsD', 'owner:d', { auto_approve: true, default_no_train: true });
  core.write({ namespaceId: 'nsD', scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null }, { text: '내 커피는 아메리카노' });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try { await fn(port); } finally {
    await new Promise((r) => httpServer.close(r));
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
  }
}

test('internal/dashboard: 토큰+namespace 정상 → usage/kpi/memories', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/dashboard?namespace=nsD`, {
      headers: { authorization: `Bearer ${DEV_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.usage && typeof j.usage.memories === 'number');
    assert.equal(j.usage.memories, 1);
    assert.ok(j.kpi && typeof j.kpi.active === 'number');
    assert.ok(Array.isArray(j.memories) && j.memories.length === 1);
    assert.match(j.memories[0].text, /아메리카노/);
  });
});

test('internal/dashboard: 토큰 없음/오류 → 401', async () => {
  await withServer(async (port) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/dashboard?namespace=nsD`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/dashboard?namespace=nsD`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  });
});

test('internal/dashboard: namespace 누락 → 422', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/dashboard`, { headers: { authorization: `Bearer ${DEV_TOKEN}` } });
    assert.equal(res.status, 422);
  });
});

test('internal/dashboard: 격리 — 다른 namespace 는 비어있음', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/dashboard?namespace=nsOther`, { headers: { authorization: `Bearer ${DEV_TOKEN}` } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.usage.memories, 0);
    assert.equal(j.memories.length, 0);
  });
});
