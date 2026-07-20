// jikji/search.mjs — 하이브리드 검색: BM25(lexical) + dense(임베딩) → RRF 융합 → (선택) 리랭커 계층
//
// 정본: the internal design spec §2·§3 (4단 파이프라인). 순수 함수 — store/embedder 접근은 core 가 소유.
//  ① 구조 필터/스코프는 core 가 후보(searchableRevisions)로 전달
//  ② dense(cosine, 기존 벡터) ∥ BM25(on-the-fly, per-namespace 소규모) → RRF 융합
//  ③ 그래프 확장 = P1.5 (여기선 자리만)
//  ④ 대형 리랭커 = 쿼리 분류기가 '어려운 질의' 판정 시만(feature flag) — rerank.mjs
//
// RRF·BM25·리랭커 로짓은 확률이 아니다 → retrieval_score 로만 부른다(fact_confidence 와 분리).

/** ★케이스별 임베딩: 쿼리 의도에 맞는 instruction 선택(Qwen3-Embedding instruction-tuned 활용).
 *  실 임베더는 "Instruct: {task}\nQuery: {q}"로 검색 정확도↑, 스캐폴드는 무시. 문서(색인)엔 instruction 미적용(관례). */
export function pickInstruction(need = '', taskContext = '') {
  const s = `${need} ${taskContext}`.toLowerCase();
  if (/실패|교훈|실수|lesson|mistake|버그|bug|오류|안티패턴|anti-?pattern|하지\s*말/.test(s))
    return 'Retrieve past lessons, mistakes, and failure cases relevant to the task, to avoid repeating them.';
  if (/선호|좋아|싫어|preference|favorite|취향|습관|prefer/.test(s))
    return "Retrieve the user's stated preferences and habits relevant to the query.";
  if (/누구|이름|관계|연락처|who|name|relation|contact|사람/.test(s))
    return 'Retrieve facts about people, names, and relationships relevant to the query.';
  if (/언제|일정|날짜|when|date|schedule|deadline|마감/.test(s))
    return 'Retrieve time- and schedule-related facts relevant to the query.';
  return 'Retrieve the most relevant personal memory for the query.';
}

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

/** 시계열 스코어링(Curator 단순 decay 초월): recency 부스트 + confirm 부스트 + stale 감쇠.
 *  eval 은 동시각·미confirm 이라 배수 균일 → 회귀 없음. 실사용에선 최신·확인된 기억이 상위로.
 *  최종 = fused * (1 + wR*recency + wC*confirmed - wS*staleness). 가중치는 작게(강한 관련도 우선, 타이 재정렬).
 */
// 기본 = confirm 부스트 + stale 감쇠(평가 중립: 동시각·미confirm 사실엔 배수 균일 → 회귀 없음).
// 연속 recency 항은 기본 OFF(wRecency 0) — 동시각 사실 사이 미세 tie-breaking 이 하드셋을 회귀시켜(0.71→0.64),
// confirm 행동으로 학습되는 per-user opt-in 으로만 켠다(tuneOnConfirm). 순수 시간-순 재정렬은 노이즈가 큼.
export function temporalWeight(meta, nowMs, opts = {}) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const wRecency = Math.max(0, Math.min(1, num(opts.wRecency, 0)));
  const wConfirm = Math.max(0, Math.min(1, num(opts.wConfirm, 0.3)));
  const wStale = Math.max(0, Math.min(1, num(opts.wStale, 0.2)));
  const halflifeDays = Math.max(1, num(opts.halflifeDays, 180));
  const ageDays = Math.max(0, (nowMs - (meta.recorded_at || nowMs)) / 86400000);
  const recency = wRecency ? Math.exp(-ageDays / halflifeDays) : 0;   // 1(방금)~0(오래됨), 기본 미사용
  const confirmed = meta.confirms > 0 ? 1 : 0;
  // stale = 오래됐고 한 번도 confirm 안 된 것(잘못/방치 가능성) → 감쇠(잘못된 정보 CRUD 정합).
  const staleness = (!meta.confirms && ageDays > halflifeDays) ? Math.min(1, ageDays / halflifeDays - 1) : 0;
  return Math.max(0.1, 1 + wRecency * recency + wConfirm * confirmed - wStale * staleness);
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
export function buildGraph(docs, { minShared = 2, maxEdges = 500, maxNodes = 250 } = {}) {
  // O(n^2) 쌍 비교 — 노드 수를 상한(계산 예산). 초과분은 지도에서 제외(정직 라벨).
  if (docs.length > maxNodes) docs = docs.slice(0, maxNodes);
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
