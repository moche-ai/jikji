// jikji/plans.mjs — 요금제·쿼터 정본 (★품질 단일 등급: 차등은 품질이 아닌 **양(기억 수·월 콜 캡)만**)
//
// 정본: the internal design spec §11 · §2(품질 단일). Free 도 풀 스택(8B 임베더+리랭커) — 차등은 캡뿐.
// 결제 연동·가격 최종 확정은 유저 게이트. 여기 캡은 운영 기본값(운영자가 policy.plan 으로 지정).

export const PLANS = Object.freeze({
  free:  { label: 'Free',  price_krw: 0,     price_usd: 0,     max_memories: 2000,   max_calls_per_month: 2000 },
  basic: { label: 'Basic', price_krw: 4900,  price_usd: 4.99,  max_memories: 20000,  max_calls_per_month: 50000 },
  pro:   { label: 'Pro',   price_krw: 19900, price_usd: 14.99, max_memories: 200000, max_calls_per_month: 500000 },
  // 베타 테스터: Pro 급 캡, 무료(베타 기간). 운영자가 부여.
  beta:  { label: 'Beta',  price_krw: 0,     price_usd: 0,     max_memories: 200000, max_calls_per_month: 500000 },
});

export const DEFAULT_PLAN = 'free';

export function planFor(name) {
  return PLANS[name] || PLANS[DEFAULT_PLAN];
}

/** YYYY-MM (UTC) — 월 콜 캡 집계 기간 키. nowMs 주입(결정성). */
export function periodKey(nowMs) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
