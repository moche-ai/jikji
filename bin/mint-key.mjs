#!/usr/bin/env node
// jikji/bin/mint-key.mjs — API 키 수명주기 CLI (로컬/베타 운영자용)
//
// 발급: namespace 보장 + scope 별 API 키(jk_…). raw 토큰은 **한 번만** 출력(HMAC 만 DB 저장).
// 폐기/회전/목록도 지원. prod(JIKJI_ENV=production)에서 JIKJI_API_HMAC_SECRET 부재 = fail-closed.
//
// 사용:
//   node bin/mint-key.mjs --namespace ns_alice --scopes retrieve,write   # 발급(읽기전용=--scopes retrieve)
//   node bin/mint-key.mjs --list --namespace ns_alice                    # 키 목록(값 없음, 메타만)
//   node bin/mint-key.mjs --revoke key_xxxx                              # 폐기
//   node bin/mint-key.mjs --rotate key_xxxx --namespace ns_alice --scopes retrieve  # 새 키 발급 + 구키 폐기
//   (JIKJI_DB, JIKJI_API_HMAC_SECRET 환경변수 필요)

import crypto from 'node:crypto';
import { openStore } from '../store.mjs';

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const dbPath = process.env.JIKJI_DB;
if (!dbPath) { console.error('JIKJI_DB env required (fixed path)'); process.exit(1); }
const prod = process.env.JIKJI_ENV === 'production';
const secret = process.env.JIKJI_API_HMAC_SECRET ?? (prod ? null : 'dev-jikji-api-secret');
if (!secret) { console.error('JIKJI_API_HMAC_SECRET missing (fail-closed in production)'); process.exit(1); }

const VALID = new Set(['retrieve', 'write', 'admin']);
function parseScopes() {
  const raw = (arg('scopes', 'retrieve,write')).split(',').map((s) => s.trim()).filter(Boolean);
  const scopes = [...new Set(raw)];                 // 중복 제거
  if (!scopes.length) { console.error('at least one scope required'); process.exit(1); }
  if (!scopes.every((s) => VALID.has(s))) { console.error(`invalid scope (allowed: ${[...VALID].join(',')})`); process.exit(1); }
  return scopes;
}
function mint(store, namespaceId, scopes, rotatedFrom = null) {
  const owner = arg('owner', `owner:${namespaceId}`);
  store.ensureNamespace(namespaceId, owner, { auto_approve: true, default_no_train: true });
  const token = `jk_${crypto.randomBytes(24).toString('base64url')}`;
  const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
  const keyHash = crypto.createHmac('sha256', secret).update(token).digest('hex');
  store.insertApiKey({ keyId, keyPrefix: token.slice(0, 10), keyHash, namespaceId, scopes, rotatedFrom });
  console.log(JSON.stringify({ token, key_id: keyId, namespace_id: namespaceId, scopes }, null, 2));
  console.error('\n⚠  save the token now — it is not stored (only its HMAC is).');
}

const store = openStore(dbPath);
try {
  if (has('revoke')) {
    const keyId = arg('revoke');
    if (!keyId) { console.error('--revoke <key_id> required'); process.exit(1); }
    const ok = store.revokeApiKey(keyId);
    console.log(JSON.stringify({ revoked: ok, key_id: keyId }));
    if (!ok) process.exit(1);
  } else if (has('list')) {
    const ns = arg('namespace');
    if (!ns) { console.error('--namespace required for --list'); process.exit(1); }
    console.log(JSON.stringify(store.listApiKeys(ns), null, 2));   // 값 없음(prefix/메타만)
  } else if (has('rotate')) {
    const oldKeyId = arg('rotate');
    const ns = arg('namespace');
    if (!oldKeyId || !ns) { console.error('--rotate <key_id> --namespace <ns> required'); process.exit(1); }
    mint(store, ns, parseScopes(), oldKeyId);
    store.revokeApiKey(oldKeyId);
    console.error(`(rotated: old key ${oldKeyId} revoked)`);
  } else {
    const namespaceId = arg('namespace');
    if (!namespaceId) { console.error('--namespace required'); process.exit(1); }
    mint(store, namespaceId, parseScopes());
  }
} finally { store.close(); }
