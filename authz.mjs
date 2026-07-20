// jikji/authz.mjs — 통합 ID(unified account) read-path + 공통 Bearer 리졸버.
//
// 통합 계정을 발급하는 중앙 identity 앱이 공유 authz projection 의 유일 writer이고,
// jikji 는 여기서 **read-only** 룩업만 한다(Option D). 계약: 통합키(jku_)=SHA-256 projection,
// 네이티브키(jk_)=자체 store HMAC. 아래 로직은 projection reader의 참조 구현을 이식·하드닝한 것.
//
// 키 라우팅(세 진입점 = server·gateway·dashboard 공통):
//   Bearer 'jku_…' → 공유 projection SHA-256 룩업(read-only, fail-closed)     → namespace = jikji_subject
//   그 외 'jk_…'   → jikji 자체 store HMAC 룩업(운영자/invite 키, 현행 유지)
//   ★'jku_'(index2='u')는 native 'jk_'+base64url(index2='_')와 구조적 disjoint → 오분기 0.
//
// ★불변: projection 에 절대 write 하지 않는다. 해시 = SHA-256(token). 전부 fail-closed.
// Codex 검토 반영: (P0) unified namespace ownership 검증(native 충돌 시 거부) · (P1) JIT 실패=fail-closed ·
//   (P1) unified actor 식별자 반환 · (P1) projection 연결·prepared statement 재사용(요청마다 open 금지,
//   ensure 는 최초 1회) · (P2) account_status allowlist(active/행부재만 허용).

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;
const ALLOWED_SCOPES = new Set(['retrieve', 'write']); // admin 은 projection 발급 없음

function sha256(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const LOOKUP_SQL =
  `SELECT k.jikji_subject AS jikji_subject, k.scopes AS scopes, k.status AS status, k.expires_at AS expires_at,
          s.status AS acct_status
     FROM authz_keys k LEFT JOIN account_status s ON s.jikji_subject = k.jikji_subject
    WHERE k.key_hash = ?`;

/** projection row → {jikjiSubject, scopes} | null. 전부 fail-closed(계약 §11 + Codex allowlist). */
function interpretRow(row) {
  if (!row) return null;                                     // 미스
  if (row.status !== 'active') return null;                  // revoked/미지원
  // account_status: allowlist — 행 부재(null)=active, 정확히 'active'만 통과. disabled/suspended/unknown 거부.
  if (row.acct_status != null && row.acct_status !== 'active') return null;
  if (row.expires_at != null) {                              // 만료: 정수 검증 + expires_at <= now
    if (!Number.isInteger(row.expires_at) || row.expires_at <= Date.now()) return null;
  }
  if (typeof row.jikji_subject !== 'string' || !row.jikji_subject) return null;
  const scopes = [];
  for (const p of String(row.scopes ?? '').split(',')) {     // 하나라도 unknown/빈값/중복 → 전체 거부
    if (!ALLOWED_SCOPES.has(p) || scopes.includes(p)) return null;
    scopes.push(p);
  }
  if (!scopes.length) return null;
  return { jikjiSubject: row.jikji_subject, scopes };
}

function validTokenShape(token) {
  return typeof token === 'string' && token.startsWith('jku_') && token.length >= 8 && token.length <= 128;
}

/** 부팅 시 projection 가용성 probe. 실패 = 통합키 인증만 fail-closed(자체 store 정상). */
export function probeAuthzProjection(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    if ((db.prepare('PRAGMA user_version').get()?.user_version ?? 0) !== SCHEMA_VERSION) return false;
    db.prepare('SELECT 1 FROM authz_keys LIMIT 1').get();
    db.prepare('SELECT 1 FROM account_status LIMIT 1').get();
    return true;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

/**
 * 단발 룩업(테스트·레퍼런스 패리티용). 매 호출 open/close — hot path 는 makeResolveBearer 의 재사용 연결을 쓴다.
 * @returns {{ jikjiSubject: string, scopes: string[] } | null}
 */
export function readAuthzProjection(dbPath, token) {
  if (!validTokenShape(token)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    if ((db.prepare('PRAGMA user_version').get()?.user_version ?? 0) !== SCHEMA_VERSION) return null;
    return interpretRow(db.prepare(LOOKUP_SQL).get(sha256(token)));
  } catch {
    return null;                                             // 열기 실패·busy/locked·WAL/SHM 실패 → fail-closed
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

/**
 * 공통 Bearer 리졸버 팩토리 — 세 진입점 공통. projection 연결·prepared statement 재사용(요청마다 open 금지).
 * @returns {(token:string|null)=>({namespaceId:string,scopes:string[],keyId:string}|null)}
 */
export function makeResolveBearer({ store, hashToken, authzDbPath, ensurePolicy = { auto_approve: true, default_no_train: true } }) {
  const ensured = new Set();          // subject 최초 provisioning 만 write(요청마다 write 금지)
  let db = null;
  let stmt = null;

  function openDb() {
    if (db) return true;
    try {
      db = new DatabaseSync(authzDbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 2000');
      if ((db.prepare('PRAGMA user_version').get()?.user_version ?? 0) !== SCHEMA_VERSION) { closeDb(); return false; }
      stmt = db.prepare(LOOKUP_SQL);
      return true;
    } catch { closeDb(); return false; }
  }
  function closeDb() { try { db?.close(); } catch { /* noop */ } db = null; stmt = null; }

  // 재사용 연결로 룩업(실패 시 1회 재오픈 — 파일 교체/체크포인트 대응). 전부 fail-closed.
  function projectionLookup(token) {
    if (!validTokenShape(token)) return null;
    const h = sha256(token);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!openDb()) return null;
      try { return interpretRow(stmt.get(h)); }
      catch { closeDb(); /* 재오픈 후 1회 재시도 */ }
    }
    return null;
  }

  return function resolveBearer(token) {
    if (!token) return null;
    if (token.startsWith('jku_')) {                          // 통합계정 키 → 공유 projection(read-only)
      const r = projectionLookup(token);
      if (!r) return null;                                   // fail-closed (miss 후 HMAC fallback 금지)
      const ownerScope = `unified:${r.jikjiSubject}`;
      // JIT provisioning — 최초 1회만 write. 실패 = 보안경계 미생성 → fail-closed(P1).
      if (!ensured.has(r.jikjiSubject)) {
        try { store.ensureNamespace(r.jikjiSubject, ownerScope, ensurePolicy); }
        catch { return null; }
        ensured.add(r.jikjiSubject);
      }
      // ownership 검증(P0) — 같은 id 의 native namespace 가 이미 있으면(owner_scope 불일치) 하이재킹 거부.
      const ns = store.getNamespace(r.jikjiSubject);
      if (!ns || ns.owner_scope !== ownerScope) return null;
      // actor 식별자(P1) — unified 유저 안정 가명 소스(감사/이상탐지 귀속 회귀 방지).
      return { namespaceId: r.jikjiSubject, scopes: r.scopes, keyId: `u:${r.jikjiSubject}` };
    }
    return store.resolveKey(hashToken(token));               // native jk_… (HMAC) — 현행 유지
  };
}
