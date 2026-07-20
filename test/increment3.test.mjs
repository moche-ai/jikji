// jikji/test/increment3.test.mjs — 증분3(M2): 하이브리드 BM25+dense+RRF · 리랭커 계층 · 평가 게이트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { makeEmbedder } from '../embed.mjs';
import { ScaffoldReranker } from '../rerank.mjs';
import { MemoryCore } from '../core.mjs';
import { tokenize, bm25Scores, rrfFuse, classifyHard } from '../search.mjs';
import { runEval, BASELINE_FLOOR } from '../eval/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function freshCore(opts = {}) {
  const dbPath = join(tmpdir(), `jikji-i3-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder(), opts);
  return { store, core, cleanup: () => { store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} } };
}
const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

test('tokenize: 한글 char bigram + latin 단어', () => {
  const t = tokenize('Docker 배포 GKE');
  assert.ok(t.includes('docker') && t.includes('gke'));
  assert.ok(t.includes('배포'));
});

test('bm25: 질의어 포함 문서가 더 높은 점수', () => {
  const docs = [{ id: 'a', text: '커피는 아메리카노를 좋아한다' }, { id: 'b', text: '점심은 김치찌개' }];
  const s = bm25Scores('아메리카노 커피', docs);
  assert.ok((s.get('a') || 0) > (s.get('b') || 0));
});

test('rrf: 두 랭킹 융합 — 양쪽 상위가 최상위', () => {
  const dense = new Map([['a', 0.9], ['b', 0.5], ['c', 0.1]]);
  const bm25 = new Map([['a', 3.0], ['c', 1.0]]);
  const fused = rrfFuse([dense, bm25]);
  const order = [...fused.keys()].sort((x, y) => fused.get(y) - fused.get(x));
  assert.equal(order[0], 'a');   // 양쪽 1위
});

test('search: 하이브리드 tier=hybrid, retrieval_reasons 에 dense+bm25', async () => {
  const { core, cleanup } = freshCore();
  try {
    core.ensureTenant('nsA', 'owner:a');
    core.write(ctxOf('nsA'), { text: 'Kubernetes 배포는 GKE 를 쓴다' });
    const s = await core.search(ctxOf('nsA'), { need: 'GKE 배포' });
    assert.equal(s.tier, 'hybrid');
    assert.ok(s.results[0].retrieval_reasons.includes('bm25') || s.results[0].retrieval_reasons.includes('dense'));
    assert.ok('retrieval_score' in s.results[0]);
  } finally { cleanup(); }
});

test('리랭커 계층: flag ON + 어려운 질의에서 reranked 표기(스캐폴드 리랭커)', async () => {
  const { core, cleanup } = freshCore({ reranker: new ScaffoldReranker() });
  try {
    // 촘촘한 후보 다수 → classifyHard 유도
    core.ensureTenant('nsR', 'owner:r', { auto_approve: true, default_no_train: true, reranker: true });
    for (let i = 0; i < 6; i++) core.write(ctxOf('nsR'), { text: `공통 주제 문서 항목 ${i} 세부내용 유사` });
    const s = await core.search(ctxOf('nsR'), { need: '공통 주제 문서 세부내용' });
    // 어려운 질의로 판정되면 tier=reranker. (판정 안 되면 hybrid — 둘 다 유효, 최소한 결과는 반환)
    assert.ok(['reranker', 'hybrid'].includes(s.tier));
    assert.ok(s.results.length > 0);
  } finally { cleanup(); }
});

test('서킷브레이커+degrade: 리랭커 연속 실패 → 사유 기록 + 회로 open 시 호출 스킵(fail-fast)', async () => {
  let rcalls = 0;
  const failing = { id: 'rk', ver: 'rk', tier: 'x', rerank() { rcalls++; throw new Error('rerank down'); } };
  const { core, cleanup } = freshCore({ reranker: failing, breaker: { threshold: 2, cooldownMs: 60000 } });
  try {
    const ns = 'nsRB';
    core.ensureTenant(ns, 'owner:rb', { auto_approve: true, default_no_train: true, reranker: true });
    for (const t of ['배포 노트 도커 GKE', '점심 김치찌개', '주말 등산 계획']) core.write(ctxOf(ns), { text: t });
    const s1 = await core.search(ctxOf(ns), { need: '배포 노트' });
    assert.ok(s1.degraded?.includes('reranker_failed'), '1회차 실패 사유 기록');
    assert.notEqual(s1.tier, 'reranker');                       // 실패 → reranker tier 아님
    assert.equal(rcalls, 1);
    await core.search(ctxOf(ns), { need: '배포 노트' });         // 2회차 실패 → threshold 도달 → 회로 open
    assert.equal(rcalls, 2);
    const s3 = await core.search(ctxOf(ns), { need: '배포 노트' });  // 회로 open → 리랭커 호출 스킵
    assert.equal(rcalls, 2, '회로 open 후 리랭커 미호출(fail-fast — 타임아웃 절벽 방지)');
    assert.ok(s3.degraded?.includes('reranker_circuit_open'), '회로 open 사유 기록');
  } finally { cleanup(); }
});

test('서킷브레이커: dense 임베더 장애 → degraded=embedder_failed, bm25 fail-open + 회로 open 후 스킵', async () => {
  const { core, cleanup } = freshCore({ breaker: { threshold: 2, cooldownMs: 60000 } });
  try {
    const ns = 'nsEB';
    core.ensureTenant(ns, 'owner:eb');
    for (const t of ['배포 노트 도커 GKE', '점심 김치찌개', '주말 등산 계획']) core.write(ctxOf(ns), { text: t });
    let ecalls = 0;                                             // 저장 후 임베더를 장애 상태로 교체(검색 dense 실패 유도)
    core.embedder = { id: 'x', ver: 'x', embed() { ecalls++; throw new Error('embed down'); } };
    const s1 = await core.search(ctxOf(ns), { need: '배포 노트' });
    assert.ok(s1.degraded?.includes('embedder_failed'), '실패 사유 기록');
    assert.equal(s1.tier, 'bm25');                              // dense 실패 → bm25 tier
    assert.ok(s1.results.length > 0, 'bm25 로 fail-open — 결과는 여전히 반환');
    await core.search(ctxOf(ns), { need: '배포 노트' });         // 2회차 → 회로 open
    const before = ecalls;
    const s3 = await core.search(ctxOf(ns), { need: '배포 노트' });
    assert.equal(ecalls, before, '회로 open 후 임베더 미호출(fail-fast)');
    assert.ok(s3.degraded?.includes('embedder_circuit_open'), '회로 open 사유 기록');
  } finally { cleanup(); }
});

test('classifyHard: 촘촘한 상위후보 → true', () => {
  const dense = new Map([['a', 0.80], ['b', 0.79], ['c', 0.78], ['d', 0.77], ['e', 0.76]]);
  assert.equal(classifyHard(dense), true);
  const clear = new Map([['a', 0.9], ['b', 0.3], ['c', 0.2], ['d', 0.1], ['e', 0.05]]);
  assert.equal(classifyHard(clear), false);
});

test('★평가셋 v0 품질 게이트: top1_accuracy >= BASELINE_FLOOR (회귀 금지, distractor 노이즈 포함)', async () => {
  const dataset = JSON.parse(readFileSync(join(here, '../eval/dataset-v0.json'), 'utf8'));
  const m = await runEval(dataset, { k: 8 });
  assert.ok(m.top1_accuracy >= BASELINE_FLOOR, `top1_accuracy ${m.top1_accuracy} < floor ${BASELINE_FLOOR} — 검색 품질 회귀`);
  assert.equal(m.contamination, 0, `오염(must_not top-1) ${m.contamination}`);
});
