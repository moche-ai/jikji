// jikji/worker.mjs — 백그라운드 임베딩 워커 (실 임베더 HttpEmbedder 전용)
//
// 정본: the internal design spec §2·§6. 승인된 write 는 outbox 에 'embedding' 파생을 넣는다(store).
// 스캐폴드(동기 LexicalEmbedder)는 write 시 인라인 드레인하지만, 실 임베더(async KURE-v1)는
// 요청 경로를 막지 않도록 이 워커가 백그라운드로 outbox 를 드레인한다(GPU admission 게이트 뒤).
//
//  - lease/attempt/next_retry/dead_letter 는 store.processEmbeddingsAsync 가 관리(멱등 consumer).
//  - GPU 압력 시 admit=false → 이번 틱은 skip(폴백은 검색 시 lexical). 보호서비스 무간섭.

import { packVector } from './embed.mjs';
import { admit } from './gpu.mjs';

/** 한 틱: admit 통과 시 pending namespace 들의 임베딩 outbox 를 드레인. 반환 처리 건수. */
export async function drainOnce(store, embedder, { gpuGate = true, admitOpts = {} } = {}) {
  if (gpuGate) {
    const a = await admit(admitOpts);
    if (!a.admit) return { processed: 0, skipped: a.reason };
  }
  const embedFn = async (text) => {
    const [v] = await embedder.embed([text]);
    return { dim: v.length, buf: packVector(v), embedderId: embedder.id, embedderVer: embedder.ver };   // 실제 벡터 길이(모델별 dim 무관)
  };
  let total = 0;
  for (const ns of store.namespacesWithPendingEmbeddings()) {
    try { total += (await store.processEmbeddingsAsync(ns, embedFn)).processed; }
    catch { /* 다음 틱 재시도 */ }
  }
  return { processed: total };
}

/** 주기 워커 시작. 재진입 금지(틱이 겹치지 않게). async stop() 반환 — 진행 중 틱을 await 후 종료(Codex #8). */
export function startEmbeddingWorker(store, embedder, { intervalMs = 2000, gpuGate = true, admitOpts = {}, logger = null } = {}) {
  let stopped = false;
  let current = null;   // 진행 중 틱 promise
  const tick = async () => {
    if (current || stopped) return;
    current = (async () => {
      try { const r = await drainOnce(store, embedder, { gpuGate, admitOpts }); if (r.processed && logger?.info) logger.info({ jikji_worker: r }, 'embedding drain'); }
      catch { /* swallow */ }
    })();
    try { await current; } finally { current = null; }
  };
  const h = setInterval(tick, intervalMs);
  if (h.unref) h.unref();
  // 종료: interval 제거 + 진행 중 틱 완료 대기(닫힌 DB 접근 방지).
  return async () => { stopped = true; clearInterval(h); if (current) { try { await current; } catch { /* noop */ } } };
}
