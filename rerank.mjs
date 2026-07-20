// jikji/rerank.mjs — 2차 리랭커 계층 (어려운 질의만, feature flag)
//
// 정본: the internal design spec §3. 인터페이스 = rerank(query, docs) → number[] (docs 순서대로 관련도).
//  - ScaffoldReranker: 토큰 교집합 기반(GPU 무필요, **품질 낮음 — 정직 라벨**). 실제 배치 전 파이프라인 증명용.
//  - HttpReranker(1b): jikji-rerank(Qwen3-Reranker-8B, Apache-2.0) 호출 — 같은 인터페이스, GPU admission 게이트 뒤.
//
// 리랭커 로짓/점수는 확률이 아니다. retrieval_reasons 에 'reranked' 로 표기.

import { tokenize } from './search.mjs';

/** 스캐폴드: 질의·문서 토큰 교집합 가중(자카드 유사) — 실 cross-encoder 대체 자리. */
export class ScaffoldReranker {
  constructor() { this.id = 'scaffold-overlap'; this.ver = 'scaffold-1'; this.tier = 'scaffold'; }
  rerank(query, docs) {
    const q = new Set(tokenize(query));
    if (q.size === 0) return docs.map(() => 0);
    return docs.map((d) => {
      const t = new Set(tokenize(d.text));
      let inter = 0; for (const x of t) if (q.has(x)) inter++;
      return inter / (q.size + t.size - inter || 1);   // Jaccard
    });
  }
}

/** 실 리랭커(GPU admission 게이트 뒤). JIKJI_RERANK_URL 로 POST. 실패/타임아웃 = 폴백(호출자가 처리). */
export class HttpReranker {
  constructor(url, { model = 'qwen3-reranker-8b', timeoutMs = 4000 } = {}) {
    this.url = url; this.model = model; this.timeoutMs = timeoutMs;
    this.id = `http:${model}`; this.ver = model; this.tier = 'reranker';
  }
  async rerank(query, docs) {
    const res = await fetch(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, query, documents: docs.map((d) => d.text) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`rerank_http_${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.scores) || j.scores.length !== docs.length) throw new Error('rerank_bad_shape');
    return j.scores.map(Number);
  }
}

/** env 기반 리랭커 팩토리. JIKJI_RERANK_URL 있으면 Http, 아니면 스캐폴드. */
export function makeReranker(env = process.env) {
  if (env.JIKJI_RERANK_URL) return new HttpReranker(env.JIKJI_RERANK_URL);
  return new ScaffoldReranker();
}
