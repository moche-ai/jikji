// jikji/telemetry.mjs — 계측 (계측 의무 NON-NEGOTIABLE)
//
// 모든 코어 op → 설정 가능한 텔레메트리 sink 로 fire-and-forget forward, source=jikji.
//  - 내용(text/query) 절대 미포함 — 해시·라벨만.
//  - user = actor_pseudonym (telemetry 전용 HMAC 로 생성, **DB 키해시·key ID 미전송** — 유출 시 상관 방지).
//  - 비용 = cost_usd_notional + pricing_version + compute_ms (실 청구비와 혼용 금지, 로컬 GPU notional).
//  - fire-and-forget forward 패턴(설정 가능한 sink, no-PII, 절대 요청 경로를 막지 않음).

import crypto from 'node:crypto';

const SOURCE = 'jikji';
// Telemetry is opt-in: no sink URL → disabled. The deployment injects INFRA_TELEMETRY_URL
// explicitly (no hardcoded default), so the public build ships no internal endpoint.
const ENDPOINT = process.env.INFRA_TELEMETRY_URL || '';
const DISABLED = !ENDPOINT || (process.env.INFRA_TELEMETRY || '').toLowerCase() === 'off';
const ENV = process.env.JIKJI_ENV || 'dev';
const PRICING_VERSION = 'jikji-notional-1';

// telemetry 전용 가명 비밀 — DB 키와 분리. 없으면 프로세스 고정 임의값(dev), 프로덕션은 env 주입 권장.
const PSEUDO_SECRET = process.env.JIKJI_TELEMETRY_SECRET || `dev-${crypto.randomBytes(8).toString('hex')}`;

/** keyId → 안정 가명(키/해시 자체는 절대 전송 안 함). */
export function actorPseudonym(keyId) {
  if (!keyId) return null;
  return crypto.createHmac('sha256', PSEUDO_SECRET).update(`actor:${keyId}`).digest('hex').slice(0, 24);
}

/** 자유 문자열 → 짧은 라벨 해시 (namespace 등, 원문 미전송). */
export function labelHash(s) {
  if (!s) return null;
  return crypto.createHmac('sha256', PSEUDO_SECRET).update(`lbl:${s}`).digest('hex').slice(0, 16);
}

// 전송 허용 필드(P1-6) — 이 외(특히 text/query/content 계열)는 드롭. 값은 primitive 만.
const ALLOWED_FIELDS = new Set([
  'event', 'actor_pseudonym', 'namespace_hash', 'latency_ms', 'result_count', 'tier',
  'input_units', 'cache_hit', 'cost_usd_notional', 'compute_ms', 'gpu_ms', 'model_revision',
  'ok', 'moderation', 'quarantined', 'reason', 'verified',
]);
function sanitize(ev) {
  const out = {};
  if (!ev || typeof ev !== 'object') return out;
  for (const k of Object.keys(ev)) {
    if (!ALLOWED_FIELDS.has(k)) continue;                 // canonical(source/env/ts/pricing) 덮어쓰기·미허용 필드 차단
    const v = ev[k];
    const t = typeof v;
    if (v === null || t === 'boolean' || (t === 'number' && Number.isFinite(v)) || (t === 'string' && v.length <= 128)) out[k] = v;
  }
  return out;
}

/**
 * 타입드 이벤트 전송. content 없음(필드 allowlist). never throws (요청 경로 보호).
 */
export function emit(ev, logger = null) {
  if (DISABLED) return;
  // canonical 필드는 sanitize 뒤에 고정(덮어쓰기 불가).
  const enriched = { ...sanitize(ev), source: SOURCE, env: ENV, pricing_version: PRICING_VERSION, ts: new Date().toISOString() };
  if (logger?.info) logger.info({ telemetry: enriched }, 'jikji-telemetry');
  try {
    const p = fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [enriched] }),
      signal: AbortSignal.timeout(3000),
    });
    if (p?.catch) p.catch(() => {});   // fire-and-forget
  } catch { /* never throw into request path */ }
}

/** 로컬 GPU 연산의 notional 비용(실 청구비 아님). 스캐폴드 = lexical 무비용 → 0. */
export function notionalCost({ tier = 'lexical', inputUnits = 0 } = {}) {
  const rate = tier === 'rerank' ? 5e-7 : tier === 'embed' ? 5e-8 : 0; // notional per unit
  return +(rate * inputUnits).toFixed(9);
}

export const TELEMETRY_SOURCE = SOURCE;
