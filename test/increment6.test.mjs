// jikji/test/increment6.test.mjs — 고급 사용(Curator 파워유저 대응): lineage · pin · batch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { makeEmbedder } from '../embed.mjs';
import { MemoryCore } from '../core.mjs';

function freshCore() {
  const dbPath = join(tmpdir(), `jikji-i6-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder());
  return { store, core, cleanup: () => { store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} } };
}
const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

test('lineage: 리비전·이벤트·대체 이력', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a');
    const w = core.write(ctxOf('nsA'), { text: '커피는 아메리카노' });
    core.update(ctxOf('nsA'), { fact_id: w.fact_id, text: '커피는 라떼', expectedVersion: 1 });
    const l = core.lineage(ctxOf('nsA'), { fact_id: w.fact_id });
    assert.equal(l.revisions.length, 2);
    assert.ok(l.revisions.some((r) => r.text.includes('아메리카노') && r.status === 'superseded'));
    assert.ok(l.revisions.some((r) => r.text.includes('라떼') && r.status === 'active'));
    assert.ok(l.events.some((e) => e.type === 'write'));
    assert.equal(l.supersedes.length, 1);
  } finally { cleanup(); }
});

test('lineage IDOR: 타 namespace → 404', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a'); core.ensureTenant('nsB', 'owner:b');
    const w = core.write(ctxOf('nsA'), { text: 'nsA 기억' });
    assert.throws(() => core.lineage(ctxOf('nsB'), { fact_id: w.fact_id }), (e) => e.code === 404);
  } finally { cleanup(); }
});

test('pin: 목록 상단 + pinned 플래그, unpin', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a');
    core.write(ctxOf('nsA'), { text: '평범한 기억 1' });
    const imp = core.write(ctxOf('nsA'), { text: '아주 중요한 기억' });
    core.write(ctxOf('nsA'), { text: '평범한 기억 2' });
    assert.equal(core.pin(ctxOf('nsA'), { fact_id: imp.fact_id }).pinned, true);
    const items = core.list(ctxOf('nsA')).items;
    assert.equal(items[0].fact_id, imp.fact_id, 'pin 된 게 상단');
    assert.equal(items[0].pinned, true);
    assert.equal(core.pin(ctxOf('nsA'), { fact_id: imp.fact_id, pinned: false }).pinned, false);
  } finally { cleanup(); }
});

test('pin 보호: 고정 기억은 모순검출 disputed 대상에서 제외', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true, contradiction_detection: true, contradiction_threshold: 0.7 });
    const a = core.write(ctxOf('nsA'), { text: '사무실은 3층 301호이다' });
    core.pin(ctxOf('nsA'), { fact_id: a.fact_id });
    const b = core.write(ctxOf('nsA'), { text: '사무실은 3층 305호이다' });
    assert.notEqual(b.status, 'disputed', 'pin 된 a 는 disputed 로 안 끌려감');
  } finally { cleanup(); }
});

test('writeBatch: 여러 사실 한 번에 + 부분 실패 허용', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a');
    const r = core.writeBatch(ctxOf('nsA'), { items: [
      { text: '첫 번째 사실' }, { text: '두 번째 사실', kind: 'procedural' },
      { text: 'key sk-abcdefghijklmnopqrstuvwx1234' },   // secret → 거부
    ] });
    assert.equal(r.count, 2);
    assert.ok(r.results[2].error && /secret/.test(r.results[2].error));
    assert.equal(core.list(ctxOf('nsA')).items.length, 2);
  } finally { cleanup(); }
});
