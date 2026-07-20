// jikji/store.mjs — Jikji 메모리 스토어 (node:sqlite, 정본 물리 모델)
//
// 정본: the internal design spec + the internal design spec(일관성)·§2(격리).
// Codex 코드검토 r1 반영: 복합 FK CASCADE(P0-5) · expected_version CAS(P0-1) · outbox consumer(P0-3) ·
//   forget cascade + 전 저장소 0참조(P0-4) · 원자 seq/tx(P1-1) · status/moderation CHECK(P1-3).
//
// 불변:
//  - 유효상태(fact_revisions.status) ≠ 검열상태(moderation.state) 분리 축.
//  - 모든 조회/수정/삭제는 (namespace_id, id) 복합키 — namespace 는 인증 키에서만 도출(IDOR).
//  - DB 핸들 미노출 — openStore() 는 repository capability(메서드)만 반환.
//  - 쓰기는 BEGIN IMMEDIATE. 파생(임베딩)은 outbox consumer 만 수행(승인 후, 실패 시 pending 유지).
//  - clean-room: 어떤 내부/독점 메모리 서비스 코드도 미참조(PROVENANCE.md).

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;

function newId(prefix) { return `${prefix}_${crypto.randomBytes(16).toString('hex')}`; }
function contentHash(text) { return crypto.createHash('sha256').update(String(text ?? '')).digest('hex'); }

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS namespaces (
  namespace_id TEXT PRIMARY KEY,
  owner_scope  TEXT NOT NULL,
  policy_json  TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id),
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  rotated_from TEXT,
  revoked_at   INTEGER
);

CREATE TABLE IF NOT EXISTS facts (
  namespace_id     TEXT NOT NULL,
  fact_id          TEXT NOT NULL,
  head_revision_id TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
  kind             TEXT NOT NULL DEFAULT 'semantic',
  scope_kind       TEXT NOT NULL DEFAULT 'user' CHECK (scope_kind IN ('user','workspace','project','session')),
  scope_ref        TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, fact_id)
);

CREATE TABLE IF NOT EXISTS fact_revisions (
  namespace_id  TEXT NOT NULL,
  revision_id   TEXT NOT NULL,
  fact_id       TEXT NOT NULL,
  text          TEXT NOT NULL,
  valid_from    INTEGER,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,
  retracted_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed','superseded','retracted')),
  base_version  INTEGER NOT NULL DEFAULT 0,
  author_type   TEXT NOT NULL CHECK (author_type IN ('self','assistant','third_party','external')),
  provenance    TEXT,
  source_ref    TEXT,
  fact_confidence REAL,
  embedder_ver  TEXT,
  content_hash  TEXT NOT NULL,
  PRIMARY KEY (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, fact_id) REFERENCES facts(namespace_id, fact_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_fact ON fact_revisions(namespace_id, fact_id);
CREATE INDEX IF NOT EXISTS idx_rev_valid ON fact_revisions(namespace_id, fact_id, valid_from, valid_to);

CREATE TABLE IF NOT EXISTS revision_supersedes (
  namespace_id           TEXT NOT NULL,
  revision_id            TEXT NOT NULL,
  superseded_revision_id TEXT NOT NULL,
  PRIMARY KEY (namespace_id, revision_id, superseded_revision_id),
  FOREIGN KEY (namespace_id, revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (namespace_id, superseded_revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conflict_sets (
  namespace_id TEXT NOT NULL, set_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, set_id)
);
CREATE TABLE IF NOT EXISTS conflict_members (
  namespace_id TEXT NOT NULL, set_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  PRIMARY KEY (namespace_id, set_id, revision_id),
  FOREIGN KEY (namespace_id, revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS moderation (
  namespace_id TEXT NOT NULL,
  revision_id  TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review','approved','quarantined','rejected')),
  risk_flags   TEXT,
  reviewed_by  TEXT,
  reviewed_at  INTEGER,
  expires_at   INTEGER,
  PRIMARY KEY (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mod_state ON moderation(namespace_id, state);

-- 이벤트: fact 삭제 시 함께 purge (활성계층). 삭제 감사는 deletion_receipt+audit_log(가명)에.
CREATE TABLE IF NOT EXISTS fact_events (
  namespace_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  fact_id      TEXT NOT NULL,
  revision_id  TEXT,
  type         TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, seq),
  FOREIGN KEY (namespace_id, fact_id) REFERENCES facts(namespace_id, fact_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_rev_type ON fact_events(namespace_id, revision_id, type);

CREATE TABLE IF NOT EXISTS fact_commands (
  namespace_id    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  first_response  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox (
  namespace_id       TEXT NOT NULL,
  outbox_id          TEXT NOT NULL,
  derivation_type    TEXT NOT NULL,
  revision_id        TEXT NOT NULL,
  derivation_version INTEGER NOT NULL DEFAULT 1,
  payload_ref        TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','done','dead')),
  lease_until        INTEGER,
  lease_token        TEXT,
  attempt            INTEGER NOT NULL DEFAULT 0,
  next_retry_at      INTEGER,
  dead_letter        INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, outbox_id),
  UNIQUE (namespace_id, revision_id, derivation_type, derivation_version),
  FOREIGN KEY (namespace_id, revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(namespace_id, status);

CREATE TABLE IF NOT EXISTS fact_vectors (
  namespace_id TEXT NOT NULL,
  revision_id  TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vector       BLOB NOT NULL,
  embedder_id  TEXT NOT NULL,
  embedder_ver TEXT NOT NULL,
  PRIMARY KEY (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE
);

-- 멀티모달: 이미지 메모리의 원본 바이트(캡션=fact_revisions.text, 벡터=이미지 임베딩). 연쇄삭제.
CREATE TABLE IF NOT EXISTS fact_images (
  namespace_id TEXT NOT NULL,
  revision_id  TEXT NOT NULL,
  mime         TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  PRIMARY KEY (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, revision_id) REFERENCES fact_revisions(namespace_id, revision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  namespace_id TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, provenance TEXT,
  PRIMARY KEY (namespace_id, entity_id)
);
CREATE TABLE IF NOT EXISTS edges (
  namespace_id TEXT NOT NULL, src_id TEXT NOT NULL, dst_id TEXT NOT NULL, rel TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (namespace_id, src_id, dst_id, rel)
);

CREATE TABLE IF NOT EXISTS search_params (
  namespace_id TEXT PRIMARY KEY, k INTEGER NOT NULL DEFAULT 8, rerank_threshold REAL NOT NULL DEFAULT 0.5, scope_weights TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS imports (
  namespace_id TEXT NOT NULL, import_id TEXT NOT NULL, source TEXT NOT NULL, mapping TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, import_id)
);
CREATE TABLE IF NOT EXISTS consent_events (
  namespace_id TEXT NOT NULL, seq INTEGER NOT NULL, subject TEXT NOT NULL, purpose TEXT NOT NULL,
  action TEXT NOT NULL, notice_version INTEGER NOT NULL, source TEXT, occurred_at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, seq)
);
CREATE TABLE IF NOT EXISTS raw_snapshots (
  namespace_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, wrapped_dek BLOB, ciphertext BLOB, expires_at INTEGER,
  PRIMARY KEY (namespace_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS deletion_job (
  namespace_id TEXT NOT NULL, job_id TEXT NOT NULL, reason TEXT, fact_ref TEXT, requested_at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, job_id)
);
CREATE TABLE IF NOT EXISTS deletion_target (
  namespace_id TEXT NOT NULL, job_id TEXT NOT NULL, store TEXT NOT NULL, state TEXT NOT NULL, ref TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, job_id, store)
);
CREATE TABLE IF NOT EXISTS deletion_receipt (
  namespace_id TEXT NOT NULL, job_id TEXT NOT NULL, object_versions TEXT, retention_deadline INTEGER, evidence TEXT, finalized_at INTEGER,
  PRIMARY KEY (namespace_id, job_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  namespace_id TEXT NOT NULL, seq INTEGER NOT NULL, action TEXT NOT NULL, actor_pseudonym TEXT, meta TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, seq)
);

-- 사용량 집계(월별 콜 캡·유저별 현황). 결정성 위해 period=YYYY-MM(UTC).
CREATE TABLE IF NOT EXISTS usage (
  namespace_id TEXT NOT NULL,
  period       TEXT NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  searches     INTEGER NOT NULL DEFAULT 0,
  writes       INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (namespace_id, period)
);

-- 베타 피드백/버그 리포트(유저→운영자). 운영자는 전 namespace 조회, 유저는 자기 것만.
CREATE TABLE IF NOT EXISTS feedback (
  namespace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  type         TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL,
  meta         TEXT,
  PRIMARY KEY (namespace_id, id)
);

-- 베타 invite 코드(발급=운영자, 리딤=키 발급). 발송은 유저 게이트 — 여기선 코드 생성/리딤만.
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  max_uses     INTEGER NOT NULL DEFAULT 1,
  used         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  note         TEXT
);
`;

export const STATUS = Object.freeze({ ACTIVE: 'active', DISPUTED: 'disputed', SUPERSEDED: 'superseded', RETRACTED: 'retracted' });
export const MOD = Object.freeze({ PENDING: 'pending_review', APPROVED: 'approved', QUARANTINED: 'quarantined', REJECTED: 'rejected' });

/** 활성계층 삭제 대상 저장소(0참조 검증에 모두 카운트). */
const ACTIVE_STORES = ['facts', 'fact_revisions', 'fact_vectors', 'fact_images', 'outbox', 'moderation', 'revision_supersedes', 'conflict_members', 'fact_events'];

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  const uv = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (uv < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  // 방어적 마이그레이션(pre-deploy dev DB): base_version 컬럼 부재 시 추가(기본 0, 안전).
  // FK 추가는 SQLite ALTER 불가 → fresh DB 에서만 완비. 프로덕션 jikji.db 는 v1 로 신규 생성(README).
  if (!db.prepare('PRAGMA table_info(fact_revisions)').all().some((c) => c.name === 'base_version')) {
    db.exec('ALTER TABLE fact_revisions ADD COLUMN base_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(outbox)').all().some((c) => c.name === 'lease_token')) {
    db.exec('ALTER TABLE outbox ADD COLUMN lease_token TEXT');
  }
  if (!db.prepare('PRAGMA table_info(facts)').all().some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }

  // 모든 논리 쓰기는 BEGIN IMMEDIATE (seq 할당·insert 원자화, P1-1).
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* noop */ } throw e; }
  }
  const seqIn = (table, ns) => (db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM ${table} WHERE namespace_id=?`).get(ns)?.n) ?? 1;

  // ── namespace / keys ──
  function ensureNamespace(namespaceId, ownerScope, policy = {}) {
    db.prepare(`INSERT INTO namespaces(namespace_id,owner_scope,policy_json,created_at) VALUES(?,?,?,?)
                ON CONFLICT(namespace_id) DO NOTHING`).run(namespaceId, ownerScope, JSON.stringify(policy), Date.now());
    return getNamespace(namespaceId);
  }
  function getNamespace(namespaceId) {
    const r = db.prepare('SELECT * FROM namespaces WHERE namespace_id=?').get(namespaceId);
    if (r) r.policy = JSON.parse(r.policy_json || '{}');
    return r || null;
  }
  function insertApiKey({ keyId, keyPrefix, keyHash, namespaceId, scopes, expiresAt = null, rotatedFrom = null }) {
    db.prepare(`INSERT INTO api_keys(key_id,key_prefix,key_hash,namespace_id,scopes,created_at,expires_at,rotated_from)
                VALUES(?,?,?,?,?,?,?,?)`).run(keyId, keyPrefix, keyHash, namespaceId, scopes.join(','), Date.now(), expiresAt, rotatedFrom);
  }
  function resolveKey(keyHash) {
    const r = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(keyHash);
    if (!r || r.revoked_at || (r.expires_at && r.expires_at < Date.now())) return null;
    db.prepare('UPDATE api_keys SET last_used_at=? WHERE key_id=?').run(Date.now(), r.key_id);
    return { keyId: r.key_id, namespaceId: r.namespace_id, scopes: (r.scopes || '').split(',').filter(Boolean) };
  }
  /** 키 폐기(수명주기). 이미 폐기됐거나 없으면 false. */
  function revokeApiKey(keyId) {
    const r = db.prepare('UPDATE api_keys SET revoked_at=? WHERE key_id=? AND revoked_at IS NULL').run(Date.now(), keyId);
    return r.changes === 1;
  }
  function listApiKeys(namespaceId) {
    return db.prepare('SELECT key_id, key_prefix, namespace_id, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE namespace_id=? ORDER BY created_at DESC').all(namespaceId);
  }

  // ── head CAS (expected_version, P0-1) — tx 안에서만 ──
  function setHeadCAS(ns, factId, revisionId, expectedVersion) {
    const upd = db.prepare(
      'UPDATE facts SET head_revision_id=?, version=version+1 WHERE namespace_id=? AND fact_id=? AND version=?',
    ).run(revisionId, ns, factId, expectedVersion);
    if (upd.changes !== 1) { const e = new Error('version_conflict'); e.code = 409; throw e; }
  }
  function enqueueOutbox(ns, revisionId, derivationType, derivationVersion = 1) {
    db.prepare(`INSERT INTO outbox(namespace_id,outbox_id,derivation_type,revision_id,derivation_version,status,created_at)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(namespace_id,revision_id,derivation_type,derivation_version) DO NOTHING`)
      .run(ns, newId('ob'), derivationType, revisionId, derivationVersion, 'pending', Date.now());
  }

  // ── WRITE (멱등 + revision + moderation + event + [승인시 head CAS + outbox], 단일 IMMEDIATE tx) ──
  //  authorType/moderationState 는 core(서버)가 봉인해 전달. create=신규 fact(version 0→1),
  //  update=factId+expectedVersion 필수(낙관적 동시성).
  function writeFact(ns, {
    factId = null, text, kind = 'semantic', scopeKind = 'user', scopeRef = null,
    authorType, provenance = null, sourceRef = null, factConfidence = null,
    validFrom = null, validTo = null, moderationState, riskFlags = null,
    expectedVersion = null, idempotencyKey = null, requestHash = null, noEmbed = false,
  }) {
    return tx(() => {
      if (idempotencyKey) {
        const prev = db.prepare('SELECT request_hash, first_response FROM fact_commands WHERE namespace_id=? AND idempotency_key=?').get(ns, idempotencyKey);
        if (prev) {
          if (prev.request_hash !== requestHash) { const e = new Error('idempotency_conflict'); e.code = 409; throw e; }
          return { ...JSON.parse(prev.first_response), idempotent_replay: true };
        }
      }
      const now = Date.now();
      // factId 제공 = update 의도. 존재하지 않으면 404(클라이언트 지정 id 로 신규 생성 금지 — Codex).
      const existing = factId ? db.prepare('SELECT version FROM facts WHERE namespace_id=? AND fact_id=?').get(ns, factId) : null;
      if (factId && !existing) { const e = new Error('fact_not_found'); e.code = 404; throw e; }
      const isUpdate = Boolean(existing);
      const fid = factId || newId('fact');
      const rid = newId('rev');
      let baseVersion;
      if (isUpdate) {
        if (expectedVersion === null || expectedVersion === undefined) { const e = new Error('expected_version_required'); e.code = 428; throw e; }
        // 제출 시점 검증(P0-1): expectedVersion 이 현재 head version 과 일치해야 — 미래/과거 값 예약 방지.
        if (expectedVersion !== existing.version) { const e = new Error('version_conflict'); e.code = 409; throw e; }
        baseVersion = expectedVersion;
      } else {
        db.prepare(`INSERT INTO facts(namespace_id,fact_id,head_revision_id,version,kind,scope_kind,scope_ref,created_at)
                    VALUES(?,?,?,?,?,?,?,?)`).run(ns, fid, null, 0, kind, scopeKind, scopeRef, now);
        baseVersion = 0;
      }
      db.prepare(`INSERT INTO fact_revisions(namespace_id,revision_id,fact_id,text,valid_from,valid_to,recorded_at,
                    status,base_version,author_type,provenance,source_ref,fact_confidence,content_hash)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ns, rid, fid, text, validFrom, validTo, now, STATUS.ACTIVE, baseVersion, authorType, provenance, sourceRef, factConfidence, contentHash(text));
      db.prepare('INSERT INTO moderation(namespace_id,revision_id,state,risk_flags) VALUES(?,?,?,?)')
        .run(ns, rid, moderationState, riskFlags ? JSON.stringify(riskFlags) : null);

      if (moderationState === MOD.APPROVED) {
        // temporal supersede: 승인 update 는 이전 head 를 superseded 로 내리고 대체관계 기록(자동 LWW 아님 —
        // 명시적 update 호출만 이 경로. 애매 충돌은 core 가 disputed 로 별도 처리).
        const prevHead = isUpdate ? db.prepare('SELECT head_revision_id FROM facts WHERE namespace_id=? AND fact_id=?').get(ns, fid)?.head_revision_id : null;
        setHeadCAS(ns, fid, rid, baseVersion);          // pending/quarantine 은 head 미갱신
        if (prevHead && prevHead !== rid) {
          db.prepare('UPDATE fact_revisions SET status=? WHERE namespace_id=? AND revision_id=? AND status=?').run(STATUS.SUPERSEDED, ns, prevHead, STATUS.ACTIVE);
          db.prepare('INSERT INTO revision_supersedes(namespace_id,revision_id,superseded_revision_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(ns, rid, prevHead);
        }
        enqueueOutbox(ns, rid, 'embedding');            // 임베딩은 outbox consumer 가(P0-3)
      }
      db.prepare('INSERT INTO fact_events(namespace_id,seq,fact_id,revision_id,type,at) VALUES(?,?,?,?,?,?)')
        .run(ns, seqIn('fact_events', ns), fid, rid, 'write', now);

      const res = { fact_id: fid, revision_id: rid, status: STATUS.ACTIVE, moderation: moderationState, version: moderationState === MOD.APPROVED ? baseVersion + 1 : baseVersion };
      if (idempotencyKey) db.prepare('INSERT INTO fact_commands(namespace_id,idempotency_key,request_hash,first_response,created_at) VALUES(?,?,?,?,?)')
        .run(ns, idempotencyKey, requestHash, JSON.stringify(res), now);
      return res;
    });
  }

  // ── outbox 임베딩 consumer (P0-3): lease → embedFn → putVector + done, 단일 tx. 실패 시 pending 유지 ──
  //  embedFn(text) → { dim, buf, embedderId, embedderVer }  (동기; core 가 주입)
  function processEmbeddings(ns, embedFn, { max = 100, leaseMs = 30000 } = {}) {
    const now0 = Date.now();
    // 후보 = pending + **만료된 leased 회수**(crash 복구) + next_retry_at 도달분(P0-3, P1 next_retry).
    const cand = db.prepare(`SELECT outbox_id FROM outbox WHERE namespace_id=? AND derivation_type='embedding'
        AND (status='pending' OR (status='leased' AND lease_until < ?))
        AND (next_retry_at IS NULL OR next_retry_at <= ?) LIMIT ?`).all(ns, now0, now0, max);
    let done = 0;
    for (const { outbox_id } of cand) {
      // 원자적 lease claim(pending 또는 만료 leased). changes!==1 이면 남이 가져감.
      const claim = db.prepare(`UPDATE outbox SET status='leased', lease_until=?, attempt=attempt+1
          WHERE namespace_id=? AND outbox_id=? AND (status='pending' OR (status='leased' AND lease_until < ?))`)
        .run(now0 + leaseMs, ns, outbox_id, now0);
      if (claim.changes !== 1) continue;
      const row = db.prepare(`SELECT o.revision_id, r.text FROM outbox o JOIN fact_revisions r
                                ON r.namespace_id=o.namespace_id AND r.revision_id=o.revision_id
                               WHERE o.namespace_id=? AND o.outbox_id=?`).get(ns, outbox_id);
      try {
        const { dim, buf, embedderId, embedderVer } = embedFn(row.text);
        tx(() => {
          db.prepare(`INSERT INTO fact_vectors(namespace_id,revision_id,dim,vector,embedder_id,embedder_ver)
                      VALUES(?,?,?,?,?,?) ON CONFLICT(namespace_id,revision_id) DO UPDATE SET
                        dim=excluded.dim, vector=excluded.vector, embedder_id=excluded.embedder_id, embedder_ver=excluded.embedder_ver`)
            .run(ns, row.revision_id, dim, buf, embedderId, embedderVer);
          db.prepare("UPDATE outbox SET status='done' WHERE namespace_id=? AND outbox_id=? AND status='leased'").run(ns, outbox_id);
        });
        done++;
      } catch {
        // lease 해제 → pending 복귀(재시도). attempt 상한 초과 시 dead-letter 는 후속.
        db.prepare("UPDATE outbox SET status='pending', next_retry_at=? WHERE namespace_id=? AND outbox_id=? AND status='leased'").run(Date.now() + 5000, ns, outbox_id);
      }
    }
    return { processed: done };
  }

  // ── async 임베딩 consumer (실 임베더 HttpEmbedder 용): lease(tx) → await embed(tx 밖) → commit(tx). ──
  //  asyncEmbedFn(text) → Promise<{dim,buf,embedderId,embedderVer}>. tx 가 await 를 가로지르지 않음(node:sqlite 동기).
  async function processEmbeddingsAsync(ns, asyncEmbedFn, { max = 50, leaseMs = 30000 } = {}) {
    const now0 = Date.now();
    const cand = db.prepare(`SELECT outbox_id FROM outbox WHERE namespace_id=? AND derivation_type='embedding'
        AND (status='pending' OR (status='leased' AND lease_until < ?))
        AND (next_retry_at IS NULL OR next_retry_at <= ?) LIMIT ?`).all(ns, now0, now0, max);
    let done = 0;
    for (const { outbox_id } of cand) {
      // lease token 발급(Codex #3): claim 이 소유권을 잡고, commit/retry 는 **같은 토큰일 때만** 반영.
      // 만료 lease 를 남이 재claim 하면 토큰이 바뀌어 느린 이전 consumer 의 commit/retry 는 0행(무시).
      const token = `lt_${crypto.randomBytes(12).toString('hex')}`;
      const claim = db.prepare(`UPDATE outbox SET status='leased', lease_until=?, lease_token=?, attempt=attempt+1
          WHERE namespace_id=? AND outbox_id=? AND (status='pending' OR (status='leased' AND lease_until < ?))`)
        .run(now0 + leaseMs, token, ns, outbox_id, now0);
      if (claim.changes !== 1) continue;
      const row = db.prepare(`SELECT o.revision_id, r.text FROM outbox o JOIN fact_revisions r
                                ON r.namespace_id=o.namespace_id AND r.revision_id=o.revision_id
                               WHERE o.namespace_id=? AND o.outbox_id=?`).get(ns, outbox_id);
      try {
        const { dim, buf, embedderId, embedderVer } = await asyncEmbedFn(row.text);
        tx(() => {
          // 완료는 lease_token 이 아직 내 것일 때만(정확히 1행). 아니면 벡터도 쓰지 않는다.
          const claimed = db.prepare("UPDATE outbox SET status='done', lease_token=NULL WHERE namespace_id=? AND outbox_id=? AND status='leased' AND lease_token=?").run(ns, outbox_id, token);
          if (claimed.changes !== 1) return;   // 남이 재claim — 내 결과 폐기
          db.prepare(`INSERT INTO fact_vectors(namespace_id,revision_id,dim,vector,embedder_id,embedder_ver)
                      VALUES(?,?,?,?,?,?) ON CONFLICT(namespace_id,revision_id) DO UPDATE SET
                        dim=excluded.dim, vector=excluded.vector, embedder_id=excluded.embedder_id, embedder_ver=excluded.embedder_ver`)
            .run(ns, row.revision_id, dim, buf, embedderId, embedderVer);
        });
        done++;
      } catch {
        // 실패 반환도 내 lease 일 때만(남의 유효 lease 를 pending 으로 되돌리지 않음).
        db.prepare("UPDATE outbox SET status='pending', lease_token=NULL, next_retry_at=? WHERE namespace_id=? AND outbox_id=? AND status='leased' AND lease_token=?").run(Date.now() + 5000, ns, outbox_id, token);
      }
    }
    return { processed: done };
  }

  /** 임베딩 outbox 에 pending 또는 **만료 leased**(crash 회수) 있는 namespace 목록(백그라운드 워커용, Codex #2). */
  function namespacesWithPendingEmbeddings({ limit = 100 } = {}) {
    const now0 = Date.now();
    return db.prepare(`SELECT DISTINCT namespace_id FROM outbox WHERE derivation_type='embedding'
        AND (status='pending' OR (status='leased' AND lease_until < ?)) LIMIT ?`).all(now0, limit).map((r) => r.namespace_id);
  }

  // ── moderation 결정 (전이 제한: pending_review|quarantined 에서만 — approved/rejected 는 종결, Codex #7) ──
  function decideModeration(ns, revisionId, state, reviewedBy = 'policy') {
    return tx(() => {
      // 승인 시 write 시점의 base_version 으로 CAS — 그 사이 fact 가 진행됐으면 stale 로 409(P0-1).
      const rev = db.prepare('SELECT fact_id, base_version FROM fact_revisions WHERE namespace_id=? AND revision_id=?').get(ns, revisionId);
      if (!rev) { const e = new Error('revision_not_found'); e.code = 404; throw e; }
      // 조건부 UPDATE: 현재 state 가 결정 가능 상태일 때만 1행 변경. approved/rejected 재결정 = 차단.
      const upd = db.prepare(`UPDATE moderation SET state=?, reviewed_by=?, reviewed_at=?
                              WHERE namespace_id=? AND revision_id=? AND state IN (?, ?)`)
        .run(state, reviewedBy, Date.now(), ns, revisionId, MOD.PENDING, MOD.QUARANTINED);
      if (upd.changes !== 1) { const e = new Error('moderation_transition_forbidden'); e.code = 409; throw e; }
      if (state === MOD.APPROVED) {
        setHeadCAS(ns, rev.fact_id, revisionId, rev.base_version);
        // 이미지 기억(멀티모달)은 벡터를 write 시점에 직접 저장 → 텍스트 임베딩 outbox 금지(이미지 벡터 덮어쓰기 방지).
        const isImage = db.prepare('SELECT 1 FROM fact_images WHERE namespace_id=? AND revision_id=?').get(ns, revisionId);
        if (!isImage) enqueueOutbox(ns, revisionId, 'embedding');
      }
      return { revision_id: revisionId, moderation: state };
    });
  }

  // ── 무효화(철회) = 새 retracted revision (head CAS) ──
  function retractFact(ns, factId, reason = null) {
    return tx(() => {
      const f = db.prepare('SELECT version, head_revision_id FROM facts WHERE namespace_id=? AND fact_id=?').get(ns, factId);
      if (!f) { const e = new Error('fact_not_found'); e.code = 404; throw e; }
      const now = Date.now(); const rid = newId('rev');
      const prev = f.head_revision_id ? db.prepare('SELECT text, author_type FROM fact_revisions WHERE namespace_id=? AND revision_id=?').get(ns, f.head_revision_id) : null;
      db.prepare(`INSERT INTO fact_revisions(namespace_id,revision_id,fact_id,text,recorded_at,retracted_at,status,author_type,provenance,content_hash)
                  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(ns, rid, factId, prev?.text ?? '', now, now, STATUS.RETRACTED, prev?.author_type ?? 'self', reason, contentHash(prev?.text ?? ''));
      db.prepare('INSERT INTO moderation(namespace_id,revision_id,state) VALUES(?,?,?)').run(ns, rid, MOD.APPROVED);
      setHeadCAS(ns, factId, rid, f.version);
      db.prepare('INSERT INTO fact_events(namespace_id,seq,fact_id,revision_id,type,at) VALUES(?,?,?,?,?,?)').run(ns, seqIn('fact_events', ns), factId, rid, 'retract', now);
      return { fact_id: factId, revision_id: rid, status: STATUS.RETRACTED };
    });
  }

  function confirmRevision(ns, revisionId) {
    return tx(() => {
      // active 승인 head 만 confirm 가능(superseded/retracted/quarantined·비head confirm 차단 — 랭킹 오염 방지, Codex).
      const rev = db.prepare(`SELECT r.fact_id FROM facts f
                                JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                                JOIN moderation m ON m.namespace_id=r.namespace_id AND m.revision_id=r.revision_id
                               WHERE f.namespace_id=? AND r.revision_id=? AND r.status=? AND m.state=?`)
        .get(ns, revisionId, STATUS.ACTIVE, MOD.APPROVED);
      if (!rev) return { ok: false };
      // 멱등: revision 당 confirm 이벤트 1회만(retrieve 권한 반복 confirm 로 튜닝 조작 방지).
      const already = db.prepare("SELECT 1 FROM fact_events WHERE namespace_id=? AND revision_id=? AND type='confirm'").get(ns, revisionId);
      if (already) return { ok: true, already: true };
      db.prepare('INSERT INTO fact_events(namespace_id,seq,fact_id,revision_id,type,at) VALUES(?,?,?,?,?,?)').run(ns, seqIn('fact_events', ns), rev.fact_id, revisionId, 'confirm', Date.now());
      return { ok: true, already: false };
    });
  }

  // ── 조회 (전부 namespace 복합키) ──
  function getHead(ns, factId) {
    return db.prepare(`SELECT r.* FROM facts f JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                       WHERE f.namespace_id=? AND f.fact_id=?`).get(ns, factId) || null;
  }
  function listActive(ns, { limit = 50, offset = 0 } = {}) {
    // pin 된 것 우선 노출(중요 기억 상단), 그 다음 최신순.
    return db.prepare(`SELECT r.fact_id, r.revision_id, r.text, r.status, r.fact_confidence, r.recorded_at, f.pinned
                       FROM facts f JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                       WHERE f.namespace_id=? AND r.status=? ORDER BY f.pinned DESC, r.recorded_at DESC LIMIT ? OFFSET ?`)
      .all(ns, STATUS.ACTIVE, limit, offset).map((r) => ({ ...r, pinned: !!r.pinned }));
  }
  /** 검색 후보 = active head + moderation approved (quarantine/pending 제외). scopeKind 필터 옵션. */
  function activeApprovedRevisions(ns, { scopeKind = null } = {}) {
    const base = `SELECT r.fact_id, r.revision_id, r.text, r.fact_confidence, f.scope_kind, f.scope_ref
                    FROM facts f
                    JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                    JOIN moderation m ON m.namespace_id=r.namespace_id AND m.revision_id=r.revision_id
                   WHERE f.namespace_id=? AND r.status=? AND m.state=?`;
    if (scopeKind) return db.prepare(base + ' AND f.scope_kind=?').all(ns, STATUS.ACTIVE, MOD.APPROVED, scopeKind);
    return db.prepare(base).all(ns, STATUS.ACTIVE, MOD.APPROVED);
  }
  function getVector(ns, revisionId) {
    return db.prepare('SELECT dim, vector FROM fact_vectors WHERE namespace_id=? AND revision_id=?').get(ns, revisionId) || null;
  }
  /** 멀티모달: 벡터 직접 저장(이미지 인라인 임베딩 — outbox 우회) + 이미지 바이트 저장. */
  function putVector(ns, revisionId, { dim, buf, embedderId, embedderVer }) {
    db.prepare(`INSERT INTO fact_vectors(namespace_id,revision_id,dim,vector,embedder_id,embedder_ver)
                VALUES(?,?,?,?,?,?) ON CONFLICT(namespace_id,revision_id) DO UPDATE SET
                  dim=excluded.dim, vector=excluded.vector, embedder_id=excluded.embedder_id, embedder_ver=excluded.embedder_ver`)
      .run(ns, revisionId, dim, buf, embedderId, embedderVer);
  }
  function putImage(ns, revisionId, mime, bytes) {
    db.prepare('INSERT INTO fact_images(namespace_id,revision_id,mime,bytes) VALUES(?,?,?,?) ON CONFLICT(namespace_id,revision_id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes')
      .run(ns, revisionId, mime, bytes);
  }
  function getImage(ns, revisionId) {
    return db.prepare('SELECT mime, bytes FROM fact_images WHERE namespace_id=? AND revision_id=?').get(ns, revisionId) || null;
  }

  // ── 삭제: DELETE facts → FK CASCADE(전 파생) + 전 저장소 0참조 검증(P0-4). 백업 상태 분리 ──
  function forgetFact(ns, factId, reason = null) {
    return tx(() => {
      const exists = db.prepare('SELECT 1 FROM facts WHERE namespace_id=? AND fact_id=?').get(ns, factId);
      if (!exists) { const e = new Error('fact_not_found'); e.code = 404; throw e; }
      const now = Date.now(); const jobId = newId('del');
      // 리비전 ID 고정(receipt lineage — 가명). 본문 미보관.
      const revIds = db.prepare('SELECT revision_id FROM fact_revisions WHERE namespace_id=? AND fact_id=?').all(ns, factId).map(r => r.revision_id);
      db.prepare('INSERT INTO deletion_job(namespace_id,job_id,reason,fact_ref,requested_at) VALUES(?,?,?,?,?)')
        .run(ns, jobId, reason, contentHash(factId).slice(0, 16), now);
      // FK CASCADE 로 fact_revisions→(vectors·outbox·moderation·supersedes·conflict) + fact_events 모두 삭제
      db.prepare('DELETE FROM facts WHERE namespace_id=? AND fact_id=?').run(ns, factId);
      // conflict_set 위생(Codex #9): 멤버 삭제로 <2 남은 묶음 정리. 1명 생존 = disputed 해소(→active 복귀), 빈 묶음 = 제거.
      for (const cs of db.prepare('SELECT set_id FROM conflict_sets WHERE namespace_id=?').all(ns)) {
        const members = db.prepare('SELECT revision_id FROM conflict_members WHERE namespace_id=? AND set_id=?').all(ns, cs.set_id);
        if (members.length >= 2) continue;
        if (members.length === 1) {
          // 남은 disputed head 를 active 로 복귀(상대가 사라져 더는 충돌 아님)
          db.prepare('UPDATE fact_revisions SET status=? WHERE namespace_id=? AND revision_id=? AND status=?').run(STATUS.ACTIVE, ns, members[0].revision_id, STATUS.DISPUTED);
          db.prepare('DELETE FROM conflict_members WHERE namespace_id=? AND set_id=?').run(ns, cs.set_id);
        }
        db.prepare('DELETE FROM conflict_sets WHERE namespace_id=? AND set_id=?').run(ns, cs.set_id);
      }
      const refs = countActiveRefs(ns, factId, revIds);
      const verified = refs === 0;
      for (const store of ACTIVE_STORES) {
        db.prepare('INSERT INTO deletion_target(namespace_id,job_id,store,state,ref,updated_at) VALUES(?,?,?,?,?,?)')
          .run(ns, jobId, store, verified ? 'active_verified' : 'active_purged', contentHash(factId).slice(0, 16), now);
      }
      db.prepare('INSERT INTO deletion_target(namespace_id,job_id,store,state,ref,updated_at) VALUES(?,?,?,?,?,?)')
        .run(ns, jobId, 'backup', 'backup_pending_expiry', contentHash(factId).slice(0, 16), now);
      db.prepare('INSERT INTO deletion_receipt(namespace_id,job_id,object_versions,retention_deadline,evidence) VALUES(?,?,?,?,?)')
        .run(ns, jobId, JSON.stringify({ revision_count: revIds.length }), now + 30 * 86400_000, JSON.stringify({ active_refs: refs }));
      // 감사(가명) — 원본 fact_id 미기록
      db.prepare('INSERT INTO audit_log(namespace_id,seq,action,actor_pseudonym,meta,at) VALUES(?,?,?,?,?,?)')
        .run(ns, seqIn('audit_log', ns), 'memory.forget', null, JSON.stringify({ active_verified: verified }), now);
      return { fact_id: factId, job_id: jobId, active_verified: verified, active_refs: refs };
    });
  }

  /** 활성계층 전 저장소에 factId/그 리비전 참조가 남았나(0 이어야 함). */
  function countActiveRefs(ns, factId, revIds = null) {
    const rids = revIds || db.prepare('SELECT revision_id FROM fact_revisions WHERE namespace_id=? AND fact_id=?').all(ns, factId).map(r => r.revision_id);
    let n = 0;
    n += db.prepare('SELECT COUNT(*) c FROM facts WHERE namespace_id=? AND fact_id=?').get(ns, factId).c;
    n += db.prepare('SELECT COUNT(*) c FROM fact_revisions WHERE namespace_id=? AND fact_id=?').get(ns, factId).c;
    n += db.prepare('SELECT COUNT(*) c FROM fact_events WHERE namespace_id=? AND fact_id=?').get(ns, factId).c;
    for (const rid of rids) {
      for (const t of ['fact_vectors', 'fact_images', 'outbox', 'moderation', 'conflict_members']) {
        n += db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE namespace_id=? AND revision_id=?`).get(ns, rid).c;
      }
      // revision_supersedes: 순방향(revision_id) + 역참조(superseded_revision_id) 둘 다(P0-4)
      n += db.prepare('SELECT COUNT(*) c FROM revision_supersedes WHERE namespace_id=? AND (revision_id=? OR superseded_revision_id=?)').get(ns, rid, rid).c;
    }
    return n;
  }

  // ── 감사 / 동의 (원자 seq) ──
  function audit(ns, action, actorPseudonym = null, meta = null) {
    tx(() => db.prepare('INSERT INTO audit_log(namespace_id,seq,action,actor_pseudonym,meta,at) VALUES(?,?,?,?,?,?)')
      .run(ns, seqIn('audit_log', ns), action, actorPseudonym, meta ? JSON.stringify(meta) : null, Date.now()));
  }
  function recordConsent(ns, subject, purpose, action, noticeVersion, source = null) {
    tx(() => db.prepare('INSERT INTO consent_events(namespace_id,seq,subject,purpose,action,notice_version,source,occurred_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(ns, seqIn('consent_events', ns), subject, purpose, action, noticeVersion, source, Date.now()));
  }

  // ── 증분2: pending inbox / disputed(모순) / import / dedup / 검색후보(active+disputed) ──

  /** 저장 전 리뷰 큐 = moderation pending_review 인 리비전(승인 전 색인 안 됨). */
  function listPending(ns, { limit = 100, offset = 0 } = {}) {
    return db.prepare(`SELECT r.fact_id, r.revision_id, r.text, r.author_type, m.state, m.risk_flags, r.recorded_at
                         FROM fact_revisions r
                         JOIN moderation m ON m.namespace_id=r.namespace_id AND m.revision_id=r.revision_id
                        WHERE r.namespace_id=? AND m.state=? ORDER BY r.recorded_at DESC LIMIT ? OFFSET ?`)
      .all(ns, MOD.PENDING, limit, offset);
  }

  /** 동일 scope 활성 head 중 같은 content_hash — dedup 후보(중복 저장 방지). */
  function findActiveByContentHash(ns, hash, scopeKind = null) {
    const base = `SELECT r.fact_id, r.revision_id FROM facts f
                    JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                   WHERE f.namespace_id=? AND r.status=? AND r.content_hash=?`;
    if (scopeKind) return db.prepare(base + ' AND f.scope_kind=?').get(ns, STATUS.ACTIVE, hash, scopeKind) || null;
    return db.prepare(base).get(ns, STATUS.ACTIVE, hash) || null;
  }

  /** 두 리비전을 disputed 로 양쪽 보존 + conflict_set 묶음(자동 덮어쓰기 금지).
   *  Codex #10: 삽입 전 두 리비전 모두 이 tenant 의 approved **active head** 인지 tx 안에서 검증. 아니면 전체 롤백. */
  function markDisputed(ns, revIdA, revIdB) {
    return tx(() => {
      for (const rid of [revIdA, revIdB]) {
        const ok = db.prepare(`SELECT 1 FROM facts f
                                 JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                                 JOIN moderation m ON m.namespace_id=r.namespace_id AND m.revision_id=r.revision_id
                                WHERE f.namespace_id=? AND r.revision_id=? AND r.status=? AND m.state=?`)
          .get(ns, rid, STATUS.ACTIVE, MOD.APPROVED);
        if (!ok) { const e = new Error('dispute_requires_active_head'); e.code = 409; throw e; }
      }
      const setId = newId('cset'); const now = Date.now();
      db.prepare('INSERT INTO conflict_sets(namespace_id,set_id,created_at) VALUES(?,?,?)').run(ns, setId, now);
      for (const rid of [revIdA, revIdB]) {
        db.prepare('INSERT INTO conflict_members(namespace_id,set_id,revision_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(ns, setId, rid);
        db.prepare('UPDATE fact_revisions SET status=? WHERE namespace_id=? AND revision_id=? AND status=?').run(STATUS.DISPUTED, ns, rid, STATUS.ACTIVE);
      }
      return { set_id: setId };
    });
  }

  /** md 임포트 원장. */
  function recordImport(ns, source, mapping) {
    const id = newId('imp');
    db.prepare('INSERT INTO imports(namespace_id,import_id,source,mapping,at) VALUES(?,?,?,?,?)').run(ns, id, source, JSON.stringify(mapping || {}), Date.now());
    return { import_id: id };
  }

  /** 검색 후보 = active + disputed head (moderation approved). conflict_set_id 동봉(disputed 묶음 반환용). */
  function searchableRevisions(ns, { scopeKind = null } = {}) {
    const base = `SELECT r.fact_id, r.revision_id, r.text, r.fact_confidence, r.status, r.recorded_at, f.scope_kind, f.scope_ref, f.pinned,
                    (SELECT COUNT(*) FROM fact_events e WHERE e.namespace_id=r.namespace_id AND e.revision_id=r.revision_id AND e.type='confirm') AS confirms,
                    (SELECT cm.set_id FROM conflict_members cm WHERE cm.namespace_id=r.namespace_id AND cm.revision_id=r.revision_id LIMIT 1) AS conflict_set_id
                    FROM facts f
                    JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                    JOIN moderation m ON m.namespace_id=r.namespace_id AND m.revision_id=r.revision_id
                   WHERE f.namespace_id=? AND r.status IN ('active','disputed') AND m.state=?`;
    if (scopeKind) return db.prepare(base + ' AND f.scope_kind=?').all(ns, MOD.APPROVED, scopeKind);
    return db.prepare(base).all(ns, MOD.APPROVED);
  }

  // ── M4: KPI 집계(로컬 테이블 — per-namespace 대시보드용, 계측 :5491 과 별개) ──
  function kpis(ns) {
    const actionRows = db.prepare('SELECT action, COUNT(*) c FROM audit_log WHERE namespace_id=? GROUP BY action').all(ns);
    const evRows = db.prepare('SELECT type, COUNT(*) c FROM fact_events WHERE namespace_id=? GROUP BY type').all(ns);
    const actions = Object.fromEntries(actionRows.map((a) => [a.action, a.c]));
    const events = Object.fromEntries(evRows.map((e) => [e.type, e.c]));
    const active = db.prepare(`SELECT COUNT(*) c FROM facts f JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                               WHERE f.namespace_id=? AND r.status=?`).get(ns, STATUS.ACTIVE).c;
    const pending = db.prepare('SELECT COUNT(*) c FROM moderation WHERE namespace_id=? AND state=?').get(ns, MOD.PENDING).c;
    const quarantined = db.prepare('SELECT COUNT(*) c FROM moderation WHERE namespace_id=? AND state=?').get(ns, MOD.QUARANTINED).c;
    const disputed = db.prepare("SELECT COUNT(DISTINCT set_id) c FROM conflict_sets WHERE namespace_id=?").get(ns).c;
    return { active, pending, quarantined, disputed_sets: disputed, actions, events };
  }

  // ── M4: invites ──
  function createInvite({ code, namespaceId, scopes, maxUses = 1, expiresAt = null, note = null }) {
    db.prepare('INSERT INTO invites(code,namespace_id,scopes,max_uses,used,created_at,expires_at,note) VALUES(?,?,?,?,0,?,?,?)')
      .run(code, namespaceId, scopes.join(','), maxUses, Date.now(), expiresAt, note);
  }
  /** 리딤: 유효하면 {namespaceId, scopes} 반환 + used++ (원자적). 무효면 null. */
  function redeemInvite(code) {
    return tx(() => {
      const r = db.prepare('SELECT * FROM invites WHERE code=?').get(code);
      if (!r) return null;
      if (r.expires_at && r.expires_at < Date.now()) return null;
      if (r.used >= r.max_uses) return null;
      const upd = db.prepare('UPDATE invites SET used=used+1 WHERE code=? AND used<max_uses').run(code);
      if (upd.changes !== 1) return null;                 // 경쟁 소진
      return { namespaceId: r.namespace_id, scopes: (r.scopes || '').split(',').filter(Boolean) };
    });
  }
  function listInvites() {
    return db.prepare('SELECT code, namespace_id, scopes, max_uses, used, created_at, expires_at, note FROM invites ORDER BY created_at DESC').all();
  }
  /** 리딤 + 키 발급을 **한 tx** 로(Codex #1 — 소진/발급 원자성). 무효면 null. */
  function redeemInviteWithKey(code, { keyId, keyPrefix, keyHash }) {
    return tx(() => {
      const r = db.prepare('SELECT * FROM invites WHERE code=?').get(code);
      if (!r) return null;
      if (r.expires_at && r.expires_at < Date.now()) return null;
      if (r.used >= r.max_uses) return null;
      const upd = db.prepare('UPDATE invites SET used=used+1 WHERE code=? AND used<max_uses').run(code);
      if (upd.changes !== 1) return null;
      const scopes = (r.scopes || '').split(',').filter(Boolean);
      db.prepare(`INSERT INTO api_keys(key_id,key_prefix,key_hash,namespace_id,scopes,created_at,expires_at,rotated_from)
                  VALUES(?,?,?,?,?,?,?,?)`).run(keyId, keyPrefix, keyHash, r.namespace_id, scopes.join(','), Date.now(), null, null);
      return { namespaceId: r.namespace_id, scopes };
    });
  }

  // ── 고급: 이력(lineage) / pin(고정) — Curator 파워유저 op 대응 ──

  /** 기억 이력: 전 리비전(시간순)·이벤트·대체관계 — 설명가능성/신뢰. 데이터는 이미 저장돼 있음. */
  function lineage(ns, factId) {
    const fact = db.prepare('SELECT fact_id, head_revision_id, version, kind, scope_kind, scope_ref, pinned, created_at FROM facts WHERE namespace_id=? AND fact_id=?').get(ns, factId);
    if (!fact) return null;
    const revisions = db.prepare(`SELECT revision_id, text, status, author_type, recorded_at, retracted_at, fact_confidence
                                    FROM fact_revisions WHERE namespace_id=? AND fact_id=? ORDER BY recorded_at ASC`).all(ns, factId);
    const events = db.prepare('SELECT type, revision_id, at FROM fact_events WHERE namespace_id=? AND fact_id=? ORDER BY seq ASC').all(ns, factId);
    const supersedes = db.prepare(`SELECT rs.revision_id, rs.superseded_revision_id FROM revision_supersedes rs
                                     JOIN fact_revisions r ON r.namespace_id=rs.namespace_id AND r.revision_id=rs.revision_id
                                    WHERE rs.namespace_id=? AND r.fact_id=?`).all(ns, factId);
    return { ...fact, pinned: !!fact.pinned, revisions, events, supersedes };
  }
  // ── ★매번 최적화: 채택 피드백 루프(고신뢰 신호=confirm 만) → 유저별 search_params 자동 튜닝 ──
  function getSearchParams(ns) {
    const r = db.prepare('SELECT k, rerank_threshold, scope_weights FROM search_params WHERE namespace_id=?').get(ns);
    if (!r) return { k: 8, rerank_threshold: 0.5, temporal: {} };
    let blob = {}; try { blob = JSON.parse(r.scope_weights || '{}'); } catch { /* noop */ }
    return { k: r.k, rerank_threshold: r.rerank_threshold, temporal: blob.temporal || {} };
  }
  /** confirm 된 사실의 나이로 recency 가중을 넛지(EMA, bounded). tx 안에서 read→UPSERT(동시 confirm lost update 방지, Codex).
   *  scope_weights blob 의 기존 키는 보존(temporal 만 갱신). */
  function tuneOnConfirm(ns, revisionId) {
    tx(() => {
      const rev = db.prepare('SELECT recorded_at FROM fact_revisions WHERE namespace_id=? AND revision_id=?').get(ns, revisionId);
      if (!rev) return;
      const row = db.prepare('SELECT k, rerank_threshold, scope_weights FROM search_params WHERE namespace_id=?').get(ns);
      let blob = {}; try { blob = JSON.parse(row?.scope_weights || '{}'); } catch { /* noop */ }
      const ageDays = Math.max(0, (Date.now() - rev.recorded_at) / 86400000);
      const wR0 = typeof blob.temporal?.wRecency === 'number' ? blob.temporal.wRecency : 0;
      const target = ageDays > 180 ? 0.05 : 0.35;
      const wR = Math.max(0.05, Math.min(0.5, +(wR0 + 0.1 * (target - wR0)).toFixed(4)));   // EMA nudge, clamp
      blob.temporal = { ...blob.temporal, wRecency: wR };                                    // 기존 키 보존
      db.prepare(`INSERT INTO search_params(namespace_id,k,rerank_threshold,scope_weights) VALUES(?,?,?,?)
                  ON CONFLICT(namespace_id) DO UPDATE SET scope_weights=excluded.scope_weights`)
        .run(ns, row?.k || 8, row?.rerank_threshold || 0.5, JSON.stringify(blob));
    });
  }

  /** pin: 중요 기억 고정 — 자동 supersede/모순 disputed 후보에서 제외 + 목록 상단(향후 decay 면제). */
  function setPinned(ns, factId, pinned) {
    const r = db.prepare('UPDATE facts SET pinned=? WHERE namespace_id=? AND fact_id=?').run(pinned ? 1 : 0, ns, factId);
    if (r.changes !== 1) { const e = new Error('fact_not_found'); e.code = 404; throw e; }
    return { fact_id: factId, pinned: !!pinned };
  }

  // ── ★잘못된 정보 CRUD: hygiene — stale/중복/충돌을 표면화해 능동 정리 유도(Curator enqueue_stale 초월) ──
  function hygiene(ns, { staleDays = 180, limit = 50 } = {}) {
    const cutoff = Date.now() - staleDays * 86400000;
    // stale: 오래됐고 한 번도 confirm 안 됐고 pin 아닌 active head → 재검증/정리 후보.
    const stale = db.prepare(`SELECT r.fact_id, r.text, r.recorded_at
        FROM facts f JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
        WHERE f.namespace_id=? AND r.status=? AND f.pinned=0 AND r.recorded_at < ?
          AND NOT EXISTS (SELECT 1 FROM fact_events e WHERE e.namespace_id=r.namespace_id AND e.revision_id=r.revision_id AND e.type='confirm')
        ORDER BY r.recorded_at ASC LIMIT ?`).all(ns, STATUS.ACTIVE, cutoff, limit);
    // 중복: 같은 content_hash 활성 head 2+ (dedup 우회분·구DB) → 병합/삭제 후보. **원문 해시는 응답에 미노출**(사전대입 표면 제거, Codex).
    const duplicates = db.prepare(`SELECT COUNT(*) AS count, GROUP_CONCAT(r.fact_id) AS fact_ids
        FROM facts f JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
        WHERE f.namespace_id=? AND r.status=? GROUP BY r.content_hash HAVING count > 1 LIMIT ?`).all(ns, STATUS.ACTIVE, limit)
      .map((d) => ({ count: d.count, fact_ids: (d.fact_ids || '').split(',') }));
    // 충돌: **여전히 disputed 인** 묶음만(해소된 묶음 제외, Codex) → 유저가 하나 선택/정정.
    const conflicts = db.prepare(`SELECT cs.set_id, GROUP_CONCAT(cm.revision_id) AS revision_ids
        FROM conflict_sets cs JOIN conflict_members cm ON cm.namespace_id=cs.namespace_id AND cm.set_id=cs.set_id
        JOIN fact_revisions r ON r.namespace_id=cm.namespace_id AND r.revision_id=cm.revision_id AND r.status=?
        WHERE cs.namespace_id=? GROUP BY cs.set_id HAVING COUNT(*) >= 2 LIMIT ?`).all(STATUS.DISPUTED, ns, limit)
      .map((c) => ({ ...c, revision_ids: (c.revision_ids || '').split(',') }));
    return { stale, duplicates, conflicts, counts: { stale: stale.length, duplicates: duplicates.length, conflicts: conflicts.length } };
  }

  // ── 사용량(월 콜 캡·유저 현황) / 피드백 ──
  function incUsage(ns, period, kind) {   // kind = 'search' | 'write'
    const now = Date.now(); const s = kind === 'search' ? 1 : 0; const w = kind === 'write' ? 1 : 0;
    db.prepare(`INSERT INTO usage(namespace_id,period,calls,searches,writes,updated_at) VALUES(?,?,1,?,?,?)
                ON CONFLICT(namespace_id,period) DO UPDATE SET calls=calls+1, searches=searches+?, writes=writes+?, updated_at=?`)
      .run(ns, period, s, w, now, s, w, now);
  }
  function getUsage(ns, period) {
    return db.prepare('SELECT calls, searches, writes FROM usage WHERE namespace_id=? AND period=?').get(ns, period) || { calls: 0, searches: 0, writes: 0 };
  }
  function countMemories(ns) {
    return db.prepare(`SELECT COUNT(*) c FROM facts f JOIN fact_revisions r ON r.namespace_id=f.namespace_id AND r.revision_id=f.head_revision_id
                       WHERE f.namespace_id=? AND r.status=?`).get(ns, STATUS.ACTIVE).c;
  }
  /** namespace policy 병합 갱신(plan·캡 override 등 운영자 조정). */
  function updatePolicy(ns, patch) {
    const cur = getNamespace(ns);
    if (!cur) return null;
    const merged = { ...(cur.policy || {}), ...patch };
    db.prepare('UPDATE namespaces SET policy_json=? WHERE namespace_id=?').run(JSON.stringify(merged), ns);
    return merged;
  }
  function updateFeedbackStatus(ns, id, status) {
    const r = db.prepare('UPDATE feedback SET status=? WHERE namespace_id=? AND id=?').run(status, ns, id);
    return r.changes === 1;
  }
  function addFeedback(ns, { type, text, meta = null }) {
    const id = newId('fb');
    db.prepare('INSERT INTO feedback(namespace_id,id,type,text,status,created_at,meta) VALUES(?,?,?,?,?,?,?)')
      .run(ns, id, type, text, 'open', Date.now(), meta ? JSON.stringify(meta) : null);
    return { id };
  }
  /** ns 주면 그 유저 것만, null 이면 전 namespace(운영자). */
  function listFeedback(ns = null, { limit = 100 } = {}) {
    if (ns) return db.prepare('SELECT id, type, text, status, created_at FROM feedback WHERE namespace_id=? ORDER BY created_at DESC LIMIT ?').all(ns, limit);
    return db.prepare('SELECT namespace_id, id, type, text, status, created_at FROM feedback ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  function close() { db.close(); }

  return {
    SCHEMA_VERSION, contentHash, kpis, lineage, setPinned, getSearchParams, tuneOnConfirm, hygiene,
    incUsage, getUsage, countMemories, addFeedback, listFeedback, updatePolicy, updateFeedbackStatus,
    createInvite, redeemInvite, redeemInviteWithKey, listInvites,
    ensureNamespace, getNamespace, insertApiKey, resolveKey, revokeApiKey, listApiKeys,
    writeFact, processEmbeddings, processEmbeddingsAsync, namespacesWithPendingEmbeddings,
    decideModeration, retractFact, confirmRevision, forgetFact,
    getHead, listActive, activeApprovedRevisions, searchableRevisions, getVector, putVector, putImage, getImage, countActiveRefs,
    listPending, findActiveByContentHash, markDisputed, recordImport,
    audit, recordConsent, close,
  };
}
