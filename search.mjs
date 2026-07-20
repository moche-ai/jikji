// jikji/search.mjs — 하이브리드 검색: BM25(lexical) + dense(임베딩) → RRF 융합 → (선택) 리랭커 계층
//
// 정본: the internal design spec §2·§3 (4단 파이프라인). 순수 함수 — store/embedder 접근은 core 가 소유.
//  ① 구조 필터/스코프는 core 가 후보(searchableRevisions)로 전달
//  ② dense(cosine, 기존 벡터) ∥ BM25(on-the-fly, per-namespace 소규모) → RRF 융합
//  ③ 그래프 확장 = P1.5 (여기선 자리만)
//  ④ 대형 리랭커 = 쿼리 분류기가 '어려운 질의' 판정 시만(feature flag) — rerank.mjs
//
// RRF·BM25·리랭커 로짓은 확률이 아니다 → retrieval_score 로만 부른다(fact_confidence 와 분리).

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const RRF_K = 60;

/** 토크나이저: latin/숫자 단어 + CJK char bigram(형태소기 없이 한국어 recall 확보). */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase().normalize('NFKC');
  const toks = [];
  for (const m of s.matchAll(/[a-z0-9]+/g)) toks.push(m[0]);
  const cjkRuns = s.replace(/[^가-힣぀-ヿ一-鿿]+/g, ' ').split(/\s+/);
  for (const run of cjkRuns) {
    if (!run) continue;
    if (run.length === 1) { toks.push(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) toks.push(run.slice(i, i + 2));
  }
  return toks;
}

/** BM25: 후보 문서집합 안에서 질의 점수. docs = [{id, text}]. 반환 Map(id→score). */
export function bm25Scores(queryText, docs) {
  const N = docs.length;
  const scores = new Map();
  if (N === 0) return scores;
  const docTokens = docs.map((d) => tokenize(d.text));
  const lens = docTokens.map((t) => t.length);
  const avgdl = lens.reduce((a, b) => a + b, 0) / N || 1;
  // df
  const df = new Map();
  docTokens.forEach((toks) => { for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1); });
  const qTerms = new Set(tokenize(queryText));
  docs.forEach((d, i) => {
    const toks = docTokens[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const term of qTerms) {
      const f = tf.get(term); if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * lens[i] / avgdl));
    }
    if (s > 0) scores.set(d.id, s);
  });
  return scores;
}

/** 여러 랭킹(Map id→score)을 RRF 로 융합. 각 랭킹은 점수 내림차순 순위로 변환. */
export function rrfFuse(rankings, { k = RRF_K } = {}) {
  const fused = new Map();
  for (const scoreMap of rankings) {
    const ordered = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]);
    ordered.forEach(([id], rank) => { fused.set(id, (fused.get(id) || 0) + 1 / (k + rank + 1)); });
  }
  return fused;
}

/** 기억 지도(L2 근사, M5): 활성 fact 를 노드로, 공유 유의미 토큰 ≥minShared 를 엣지로 온-디맨드 구성.
 *  docs = [{id, label, scope, status}]. 형태소기 없이 char-bigram 공유로 관계 추정(정직 라벨 — 근사).
 */
export function buildGraph(docs, { minShared = 2, maxEdges = 500 } = {}) {
  const toks = docs.map((d) => new Set(tokenize(d.label).filter((t) => t.length >= 2)));
  const edges = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const shared = [];
      for (const t of toks[i]) if (toks[j].has(t)) shared.push(t);
      if (shared.length >= minShared) edges.push({ src: docs[i].id, dst: docs[j].id, weight: shared.length, shared: shared.slice(0, 6) });
    }
  }
  edges.sort((a, b) => b.weight - a.weight);
  const degree = new Map();
  for (const e of edges.slice(0, maxEdges)) { degree.set(e.src, (degree.get(e.src) || 0) + 1); degree.set(e.dst, (degree.get(e.dst) || 0) + 1); }
  const nodes = docs.map((d) => ({ ...d, degree: degree.get(d.id) || 0 }));
  return { nodes, edges: edges.slice(0, maxEdges) };
}

/** 어려운 질의 판정(소형 라우터, 비용 절감): 후보 다수 + 상위 dense margin 작음 → 리랭커로. */
export function classifyHard(denseScores, { minCandidates = 5, margin = 0.05 } = {}) {
  const vals = [...denseScores.values()].sort((a, b) => b - a);
  if (vals.length < minCandidates) return false;
  const top = vals[0] ?? 0, second = vals[1] ?? 0;
  return (top - second) < margin;   // 상위 후보가 촘촘 = 판별 어려움 → 2차 리랭커
}
