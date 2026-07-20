// jikji/eval/harness.mjs — 한국어 장기기억 평가 하네스 (검색 품질 게이트)
//
// 정본: the internal design spec §3·§9-1. 평가셋 = MVP 필수 — 검색 품질 게이트 없이 릴리스 금지.
// 카테고리(경쟁분석 §3): 존칭·상대날짜·관계·동명이인·선호변경·부정문·한영혼용·신구충돌.
//
// 지표: Recall@k(정답 fact 가 top-k 에 있나) · precision-violation(must_not 이 top-k 에 있나=오염) ·
//       supersede-correct(구본이 top-k 상위에 안 나오나) · contradiction-surface(disputed 반환하나).
// 하네스는 임베더/리랭커 교체와 무관 — 스캐폴드→KURE-v1 회귀 비교의 동일 척도.

import { openStore } from '../store.mjs';
import { makeEmbedder } from '../embed.mjs';
import { makeReranker } from '../rerank.mjs';
import { MemoryCore } from '../core.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';

// 현재 스캐폴드(lexical+BM25+RRF) 기준선 = v0 1.0. floor 는 회귀 방지 마진 포함. KURE-v1 승격도 이 위여야.
// (상수는 부작용 없는 이 모듈에 둔다 — run.mjs 를 import 하면 CLI main() 이 실행되는 부작용 회피, Codex #7.)
export const BASELINE_FLOOR = 0.85;

const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

// distractor 노이즈(모든 케이스에 주입) — 정답이 무관 기억을 제치고 top-1 로 랭크돼야 통과(랭킹 난이도 부여, Codex #6).
const NOISE = [
  '어제 점심으로 김밥을 먹었다',
  '주말에 친구와 영화를 봤다',
  '노트북 배터리를 새로 교체했다',
  '회의실 예약 시스템이 조금 느리다',
  '새 무선 키보드를 주문했다',
  '창밖에 비가 내리고 있다',
];

/** 한 케이스 실행 → { hit, violation, ...flags }. */
async function runCase(core, c, k) {
  const ns = `eval_${c.id}`;
  const policy = { auto_approve: true, default_no_train: true, ...(c.policy || {}) };
  core.ensureTenant(ns, `owner:${c.id}`, policy);
  for (const n of NOISE) core.write(ctxOf(ns), { text: n });   // distractor 주입
  const ids = {};
  for (const m of c.setup) {
    if (m.update_of) {
      const prev = ids[m.update_of];
      core.update(ctxOf(ns), { fact_id: prev, text: m.text, expectedVersion: coreVersion(core, ns, prev) });
    } else {
      const r = core.write(ctxOf(ns), { text: m.text, scopeKind: m.scope || 'user', scopeRef: m.scope_ref || null });
      if (m.ref) ids[m.ref] = r.fact_id;
    }
  }
  const res = await core.search(ctxOf(ns), { ...c.query, k });
  // top1_accuracy: 정답이 노이즈·distractor 를 제치고 top-1 로 랭크되는가(must_include ⊆ top-1) + must_not ∉ top-1.
  const top1 = res.results[0]?.fact || '';
  const inc = c.expect.must_include || [];
  const hit = inc.every((sub) => top1.includes(sub));
  const violation = (c.expect.must_not_include || []).some((sub) => top1.includes(sub));
  // recall_at_k: 정답이 top-k 안 어디든 있나(랭킹 무관 회수율 — 별도 리포트).
  const topKJoined = res.results.map((r) => r.fact).join(' \n ');
  const recallHit = inc.length ? inc.every((sub) => topKJoined.includes(sub)) : true;
  const disputedOk = c.expect.expect_disputed ? res.results.some((r) => r.validity_status === 'disputed') : true;
  return { id: c.id, category: c.category, hit, violation, recallHit, disputedOk, pass: hit && !violation && disputedOk, tier: res.tier };
}

function coreVersion(core, ns, factId) {
  const f = core.store.getHead(ns, factId);
  // head revision 의 base_version+1 = 현재 version (승인본). 간단히 facts.version 조회 대신 list 로 근사 불가 →
  // store 에 직접 접근: 현재 version 은 base_version(head)+1.
  return (f?.base_version ?? 0) + 1;
}

/** 데이터셋 실행 → 카테고리별·전체 지표. */
export async function runEval(dataset, { k = 8 } = {}) {
  const dbPath = join(tmpdir(), `jikji-eval-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder(), { reranker: makeReranker() });
  const rows = [];
  try {
    for (const c of dataset.cases) rows.push(await runCase(core, c, k));
  } finally {
    store.close();
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
  }
  const byCat = {};
  for (const r of rows) {
    (byCat[r.category] ||= { total: 0, pass: 0 }).total++;
    if (r.pass) byCat[r.category].pass++;
  }
  const total = rows.length;
  const passed = rows.filter((r) => r.pass).length;
  const violations = rows.filter((r) => r.violation).length;
  const recallHits = rows.filter((r) => r.recallHit).length;
  return {
    k,
    top1_accuracy: +(passed / total).toFixed(4),   // 정답이 노이즈 제치고 top-1(게이트 대상)
    recall_at_k: +(recallHits / total).toFixed(4), // 정답이 top-k 안 어디든(참고)
    contamination: +(violations / total).toFixed(4),
    total, passed, violations,
    by_category: Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, +(v.pass / v.total).toFixed(4)])),
    cases: rows,
  };
}
