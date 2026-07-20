// jikji/ratelimit.mjs — 초당 rate-limit + 동시 in-flight 백프레셔.
//
// 왜: 검색 1회 = 8B 임베더+8B 리랭커(공유 GPU) 호출이라 폭주 시 GPU/지연이 무너진다(실측: 동시 32 → p95 ~3s).
// 두 겹으로 보호한다: ①글로벌 in-flight 세마포어(전체 GPU 부하 상한) ②키별 토큰버킷(한 에이전트 독점 방지).
// 순수 함수형·의존성 없음(테스트 가능). 시각은 주입 가능(결정적 테스트).

/**
 * @param {object} o
 * @param {number} o.maxInflight  전체 동시 처리 상한(넘으면 429·백프레셔). 기본 16.
 * @param {number} o.ratePerMin   키당 분당 허용 요청. 기본 120.
 * @param {number} o.burst        키당 버킷 용량(순간 버스트 허용). 기본 30.
 * @param {number} o.idleSweepMs  유휴 버킷 정리 주기(메모리 누수 방지). 기본 5분.
 * @param {() => number} o.now     시각 주입(테스트용).
 */
export function makeRateLimiter({ maxInflight = 16, ratePerMin = 120, burst = 30, idleSweepMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  let inflight = 0;
  const buckets = new Map();                 // key -> { tokens, last }
  const refillPerMs = ratePerMin / 60000;    // 토큰/ms
  let lastSweep = now();

  function sweep(t) {
    if (t - lastSweep < idleSweepMs) return;
    lastSweep = t;
    for (const [k, b] of buckets) if (t - b.last > idleSweepMs) buckets.delete(k);
  }

  /**
   * 요청 1건 획득 시도. 성공 시 토큰 1개 소비 + inflight++ (반드시 release() 로 반환).
   * @returns {{ok:true} | {ok:false, reason:'rate'|'inflight', retryAfter:number}}
   */
  function take(key) {
    const t = now();
    sweep(t);
    // ① 키별 토큰버킷(리필 후 잔량 확인) — 실패해도 토큰 소비/inflight 증가 없음.
    let b = buckets.get(key);
    if (!b) { b = { tokens: burst, last: t }; buckets.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + (t - b.last) * refillPerMs);
    b.last = t;
    if (b.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
      return { ok: false, reason: 'rate', retryAfter };
    }
    // ② 글로벌 in-flight 상한(GPU 보호) — 토큰은 아직 소비하지 않음(거부 시 낭비 방지).
    if (inflight >= maxInflight) return { ok: false, reason: 'inflight', retryAfter: 1 };
    b.tokens -= 1;
    inflight += 1;
    return { ok: true };
  }

  function release() { if (inflight > 0) inflight -= 1; }
  function stats() { return { inflight, maxInflight, keys: buckets.size }; }

  return { take, release, stats };
}
