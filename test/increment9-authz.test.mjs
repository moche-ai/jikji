// jikji/test/increment9-authz.test.mjs — 통합 ID(unified account) read-path 소비자
//
// 계약: 중앙 identity 앱 UNIFIED-ID-DESIGN §11 (Option D). app 이 공유 authz projection 의 writer,
// jikji 는 read-only 룩업 + native 'jk_'(HMAC)는 현행 유지. 'jku_'(index2='u')는 native 'jk_'와 disjoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { readAuthzProjection, probeAuthzProjection, makeResolveBearer } from '../authz.mjs';

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// 공유 projection 픽스처(app writer 스키마 v2 — account_status.plan 포함) 생성.
function makeProjection(rows = [], accounts = []) {
  const p = join(tmpdir(), `jikji-authz-${crypto.randomBytes(6).toString('hex')}.db`);
  const db = new DatabaseSync(p);
  db.exec('PRAGMA user_version = 2');
  db.exec(`CREATE TABLE authz_keys(key_hash TEXT PRIMARY KEY, jikji_subject TEXT NOT NULL, key_prefix TEXT,
    scopes TEXT NOT NULL, status TEXT NOT NULL, issued_at INTEGER, expires_at INTEGER, rotated_from TEXT);
    CREATE TABLE account_status(jikji_subject TEXT PRIMARY KEY, status TEXT NOT NULL, plan TEXT);`);
  for (const r of rows) db.prepare('INSERT INTO authz_keys(key_hash,jikji_subject,key_prefix,scopes,status,issued_at,expires_at,rotated_from) VALUES(?,?,?,?,?,?,?,?)')
    .run(r.key_hash, r.jikji_subject, r.key_prefix ?? r.key_hash.slice(0, 12), r.scopes, r.status ?? 'active', r.issued_at ?? Date.now(), r.expires_at ?? null, null);
  for (const a of accounts) db.prepare('INSERT INTO account_status(jikji_subject,status,plan) VALUES(?,?,?)').run(a.jikji_subject, a.status, a.plan ?? null);
  db.close();
  return { path: p, cleanup: () => { try { rmSync(p); rmSync(p + '-wal'); rmSync(p + '-shm'); } catch {} } };
}

test('probe: 유효 projection true, 없는 경로 false', () => {
  const { path, cleanup } = makeProjection();
  try {
    assert.equal(probeAuthzProjection(path), true);
    assert.equal(probeAuthzProjection(path + '.nope'), false);
  } finally { cleanup(); }
});

test('jku_ 정상 해석: namespace=jikji_subject, scopes 파싱', () => {
  const tok = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const { path, cleanup } = makeProjection([{ key_hash: sha256(tok), jikji_subject: 'subjA', scopes: 'retrieve,write' }]);
  try {
    const r = readAuthzProjection(path, tok);
    assert.deepEqual(r, { jikjiSubject: 'subjA', scopes: ['retrieve', 'write'], plan: 'free' }); // plan 미설정 → free
  } finally { cleanup(); }
});

test('요금제 반영: account_status.plan → interpretRow.plan (free 기본·beta 설정·unknown→free)', () => {
  const betaTok = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const freeTok = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const bogusTok = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const { path, cleanup } = makeProjection(
    [
      { key_hash: sha256(betaTok), jikji_subject: 'bta', scopes: 'retrieve,write' },
      { key_hash: sha256(freeTok), jikji_subject: 'fre', scopes: 'retrieve,write' },
      { key_hash: sha256(bogusTok), jikji_subject: 'bog', scopes: 'retrieve' },
    ],
    [
      { jikji_subject: 'bta', status: 'active', plan: 'beta' },
      { jikji_subject: 'fre', status: 'active', plan: 'free' },
      { jikji_subject: 'bog', status: 'active', plan: 'enterprise_x' }, // unknown → free
    ],
  );
  try {
    assert.equal(readAuthzProjection(path, betaTok).plan, 'beta');
    assert.equal(readAuthzProjection(path, freeTok).plan, 'free');
    assert.equal(readAuthzProjection(path, bogusTok).plan, 'free'); // 화이트리스트 밖 → least-privilege
  } finally { cleanup(); }
});

test('fail-closed: 미스·revoked·disabled·만료·unknown scope 전부 null', () => {
  const now = Date.now();
  const good = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const revoked = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const expired = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const disabled = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const badscope = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const { path, cleanup } = makeProjection(
    [
      { key_hash: sha256(good), jikji_subject: 'ok', scopes: 'retrieve' },
      { key_hash: sha256(revoked), jikji_subject: 'r', scopes: 'retrieve', status: 'revoked' },
      { key_hash: sha256(expired), jikji_subject: 'e', scopes: 'retrieve', expires_at: now - 1000 },
      { key_hash: sha256(disabled), jikji_subject: 'd', scopes: 'retrieve' },
      { key_hash: sha256(badscope), jikji_subject: 'b', scopes: 'retrieve,admin' },
    ],
    [{ jikji_subject: 'd', status: 'disabled' }],
  );
  try {
    assert.ok(readAuthzProjection(path, good));                                    // sanity
    assert.equal(readAuthzProjection(path, 'jku_' + 'x'.repeat(40)), null);        // 미스
    assert.equal(readAuthzProjection(path, revoked), null);                        // revoked
    assert.equal(readAuthzProjection(path, expired), null);                        // 만료
    assert.equal(readAuthzProjection(path, disabled), null);                       // 계정 disabled
    assert.equal(readAuthzProjection(path, badscope), null);                       // unknown scope → 전체 거부
    assert.equal(readAuthzProjection(path, 'jk_native_token'), null);              // jku_ 아님 → null
  } finally { cleanup(); }
});

test('resolveBearer: jku_ → projection(JIT namespace), native jk_ → store(HMAC), 오분기 0', () => {
  const dbPath = join(tmpdir(), `jikji-authz-store-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const secret = 'test-secret';
  const hashToken = (t) => crypto.createHmac('sha256', secret).update(String(t)).digest('hex');

  // native 키: 자체 store 에 namespace + 키.
  store.ensureNamespace('nativeNs', 'owner:n', { auto_approve: true, default_no_train: true });
  const nativeTok = 'jk_' + crypto.randomBytes(24).toString('base64url');
  store.insertApiKey({ keyId: 'key_x', keyPrefix: nativeTok.slice(0, 10), keyHash: hashToken(nativeTok), namespaceId: 'nativeNs', scopes: ['retrieve', 'write'] });

  // unified 키: 공유 projection.
  const uTok = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const { path: authzDbPath, cleanup } = makeProjection([{ key_hash: sha256(uTok), jikji_subject: 'subjU', scopes: 'retrieve,write' }]);
  const resolveBearer = makeResolveBearer({ store, hashToken, authzDbPath });

  try {
    // native → 자체 store
    const rn = resolveBearer(nativeTok);
    assert.equal(rn?.namespaceId, 'nativeNs');
    // unified → projection, namespace=jikji_subject, JIT 로 namespaces 행 생성됨
    const ru = resolveBearer(uTok);
    assert.equal(ru?.namespaceId, 'subjU');
    assert.deepEqual(ru?.scopes, ['retrieve', 'write']);
    assert.ok(store.getNamespace('subjU'), 'unified namespace JIT ensured');
    // 잘못된 토큰 → null
    assert.equal(resolveBearer('jku_' + 'z'.repeat(40)), null);   // projection miss
    assert.equal(resolveBearer('jk_' + 'nope'), null);            // native miss (HMAC 불일치)
    assert.equal(resolveBearer(null), null);
  } finally {
    store.close();
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
    cleanup();
  }
});

test('account_status allowlist: unknown/suspended 상태 = 거부(active·행부재만 허용)', () => {
  const susp = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const active = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const { path, cleanup } = makeProjection(
    [
      { key_hash: sha256(susp), jikji_subject: 's', scopes: 'retrieve' },
      { key_hash: sha256(active), jikji_subject: 'a', scopes: 'retrieve' },
    ],
    [{ jikji_subject: 's', status: 'suspended' }, { jikji_subject: 'a', status: 'active' }],
  );
  try {
    assert.equal(readAuthzProjection(path, susp), null);              // unknown status → 거부
    assert.ok(readAuthzProjection(path, active));                     // 'active' → 통과
  } finally { cleanup(); }
});

test('P0 하이재킹 방지: subject와 같은 id의 native namespace가 있으면 unified 접근 거부', () => {
  const dbPath = join(tmpdir(), `jikji-authz-hj-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const hashToken = (t) => crypto.createHmac('sha256', 'sec').update(String(t)).digest('hex');
  // native 소유 namespace 를 subject 와 동일 id 로 선점.
  store.ensureNamespace('collide', 'owner:native', { auto_approve: true });
  const uTok = 'jku_' + crypto.randomBytes(32).toString('base64url');
  const { path: authzDbPath, cleanup } = makeProjection([{ key_hash: sha256(uTok), jikji_subject: 'collide', scopes: 'retrieve,write' }]);
  const resolveBearer = makeResolveBearer({ store, hashToken, authzDbPath });
  try {
    assert.equal(resolveBearer(uTok), null, 'native 소유 namespace 를 unified 가 하이재킹 못 함');
  } finally {
    store.close();
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
    cleanup();
  }
});

test('native jk_ 토큰은 절대 projection 으로 오분기되지 않음(구조적 disjoint)', () => {
  // 'jk_' + base64url 는 index2 가 항상 '_' → startsWith('jku_') false 보장.
  for (let i = 0; i < 200; i++) {
    const tok = 'jk_' + crypto.randomBytes(24).toString('base64url');
    assert.equal(tok.startsWith('jku_'), false);
  }
});
