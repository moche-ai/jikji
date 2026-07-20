// jikji/test/increment5.test.mjs — 증분5(M5): 기억 지도(graph)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { makeEmbedder } from '../embed.mjs';
import { MemoryCore } from '../core.mjs';
import { buildGraph } from '../search.mjs';

function freshCore() {
  const dbPath = join(tmpdir(), `jikji-i5-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder());
  return { store, core, cleanup: () => { store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} } };
}
const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

test('buildGraph: 공유 유의미 토큰 ≥2 인 노드끼리 엣지', () => {
  const g = buildGraph([
    { id: 'a', label: '장주는 아메리카노 커피를 좋아한다' },
    { id: 'b', label: '장주는 아침에 커피를 마신다' },
    { id: 'c', label: '오늘 날씨가 맑다' },
  ]);
  assert.equal(g.nodes.length, 3);
  const ab = g.edges.find((e) => (e.src === 'a' && e.dst === 'b') || (e.src === 'b' && e.dst === 'a'));
  assert.ok(ab, 'a·b 공유(장주/커피) → 엣지');
  assert.ok(!g.edges.some((e) => e.src === 'c' || e.dst === 'c'), 'c 는 무관 → 엣지 없음');
});

test('core.graph: 활성 기억 지도 + need 초점 + degree', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsG', 'owner:g');
    core.write(ctxOf('nsG'), { text: '프로젝트 알파는 백엔드 API 를 담당한다' });
    core.write(ctxOf('nsG'), { text: '프로젝트 알파의 API 는 인증을 포함한다' });
    core.write(ctxOf('nsG'), { text: '점심으로 파스타를 먹었다' });
    const g = core.graph(ctxOf('nsG'), { need: '알파 API' });
    assert.equal(g.nodes.length, 3);
    assert.ok(g.edges.length >= 1, '알파/API 공유 엣지');
    assert.ok(g.nodes.every((n) => 'degree' in n));
  } finally { cleanup(); }
});

test('graph: 타 namespace 격리(빈 그래프)', () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a'); core.ensureTenant('nsB', 'owner:b');
    core.write(ctxOf('nsA'), { text: 'nsA 전용 기억' });
    assert.equal(core.graph(ctxOf('nsB')).nodes.length, 0);
  } finally { cleanup(); }
});
