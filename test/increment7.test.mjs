// jikji/test/increment7.test.mjs — 프로덕트: 요금제·쿼터·사용량·피드백
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { makeEmbedder } from '../embed.mjs';
import { MemoryCore } from '../core.mjs';
import { planFor } from '../plans.mjs';

function freshCore() {
  const dbPath = join(tmpdir(), `jikji-i7-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder());
  return { store, core, cleanup: () => { store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} } };
}
const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

test('usage: 요금제·캡·기억 수·사용량 집계', async () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true, plan: 'basic' });
    core.write(ctxOf('nsA'), { text: '기억 하나' });
    await core.search(ctxOf('nsA'), { need: '기억' });
    const u = core.usage(ctxOf('nsA'));
    assert.equal(u.plan, 'Basic');
    assert.equal(u.memories, 1);
    assert.equal(u.writes, 1);
    assert.equal(u.searches, 1);
    assert.equal(u.calls, 2);
    assert.equal(u.caps.max_memories, planFor('basic').max_memories);
    assert.equal(u.remaining.memories, planFor('basic').max_memories - 1);
  } finally { cleanup(); }
});

test('기억 수 캡: 초과 시 402 (양 차등만)', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true, max_memories: 2 });
    core.write(ctxOf('nsA'), { text: '첫째' });
    core.write(ctxOf('nsA'), { text: '둘째' });
    assert.throws(() => core.write(ctxOf('nsA'), { text: '셋째(캡 초과)' }), (e) => e.code === 402);
  } finally { cleanup(); }
});

test('월 콜 캡: 초과 시 429', async () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true, max_calls_per_month: 2 });
    core.write(ctxOf('nsA'), { text: 'a' });       // call 1
    await core.search(ctxOf('nsA'), { need: 'a' }); // call 2
    assert.throws(() => core.write(ctxOf('nsA'), { text: 'b' }), (e) => e.code === 429);   // call 3 → 초과
  } finally { cleanup(); }
});

test('피드백: 유저 제출 → 저장, 운영자 전체 조회', () => {
  const { store, core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a');
    const r = core.feedback(ctxOf('nsA'), { type: 'bug', text: '검색이 가끔 느려요' });
    assert.ok(r.id);
    assert.equal(store.listFeedback('nsA').length, 1);
    assert.equal(store.listFeedback('nsA')[0].type, 'bug');
    assert.ok(store.listFeedback(null).length >= 1);   // 운영자: 전 namespace
  } finally { cleanup(); }
});

test('피드백 IDOR: 유저는 자기 것만', () => {
  const { store, core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a'); core.ensureTenant('nsB', 'owner:b');
    core.feedback(ctxOf('nsA'), { type: 'feature', text: 'nsA 요청' });
    assert.equal(store.listFeedback('nsB').length, 0);
  } finally { cleanup(); }
});
