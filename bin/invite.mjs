#!/usr/bin/env node
// jikji/bin/invite.mjs — 베타 invite 코드 수명주기 (create/list/redeem)
//
// invite 발송 자체는 유저 게이트 — 이 CLI 는 코드 생성·조회·리딤(키 발급)만 한다.
//  create : 코드 생성(namespace·scope·max_uses)
//  redeem : 코드 소진 + 그 namespace/scope 로 API 키(jk_) 발급(raw 1회 출력)
//  list   : 코드 목록(메타만)
// JIKJI_DB, JIKJI_API_HMAC_SECRET 필요. prod 시크릿 부재 = fail-closed.

import crypto from 'node:crypto';
import { openStore } from '../store.mjs';

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const dbPath = process.env.JIKJI_DB;
if (!dbPath) { console.error('JIKJI_DB env required'); process.exit(1); }
const prod = process.env.JIKJI_ENV === 'production';
const secret = process.env.JIKJI_API_HMAC_SECRET ?? (prod ? null : 'dev-jikji-api-secret');
if (!secret) { console.error('JIKJI_API_HMAC_SECRET missing (fail-closed in production)'); process.exit(1); }

const VALID = new Set(['retrieve', 'write', 'admin']);
const store = openStore(dbPath);
try {
  if (has('create')) {
    const namespaceId = arg('namespace');
    if (!namespaceId) { console.error('--namespace required'); process.exit(1); }
    const scopes = [...new Set((arg('scopes', 'retrieve,write')).split(',').map((s) => s.trim()).filter(Boolean))];
    if (!scopes.length || !scopes.every((s) => VALID.has(s))) { console.error('invalid scopes'); process.exit(1); }
    const maxUses = Number(arg('max-uses', '1'));
    if (!Number.isSafeInteger(maxUses) || maxUses < 1) { console.error('--max-uses must be a positive integer'); process.exit(1); }
    const days = Number(arg('expires-days', '0'));
    if (!Number.isSafeInteger(days) || days < 0) { console.error('--expires-days must be a non-negative integer'); process.exit(1); }
    const expiresAt = days > 0 ? Date.now() + days * 86400_000 : null;
    const code = `jikji-${crypto.randomBytes(9).toString('base64url')}`;
    store.ensureNamespace(namespaceId, `owner:${namespaceId}`, { auto_approve: true, default_no_train: true });
    store.createInvite({ code, namespaceId, scopes, maxUses, expiresAt, note: arg('note', null) });
    console.log(JSON.stringify({ code, namespace_id: namespaceId, scopes, max_uses: maxUses, expires_at: expiresAt }, null, 2));
    console.error('\n(발송은 유저 게이트 — 이 코드는 운영자 보관용)');
  } else if (has('redeem')) {
    const code = arg('redeem');
    if (!code) { console.error('--redeem <code> required'); process.exit(1); }
    // 소진 + 키 발급을 한 tx 로(원자성 — Codex #1). 토큰/키ID 는 미리 생성해 전달.
    const token = `jk_${crypto.randomBytes(24).toString('base64url')}`;
    const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
    const keyHash = crypto.createHmac('sha256', secret).update(token).digest('hex');
    const r = store.redeemInviteWithKey(code, { keyId, keyPrefix: token.slice(0, 10), keyHash });
    if (!r) { console.error('invite invalid / expired / exhausted'); process.exit(1); }
    console.log(JSON.stringify({ token, key_id: keyId, namespace_id: r.namespaceId, scopes: r.scopes }, null, 2));
    console.error('\n⚠  save the token now — it is not stored (only its HMAC is).');
  } else if (has('list')) {
    console.log(JSON.stringify(store.listInvites(), null, 2));
  } else {
    console.error('usage: --create --namespace <ns> [--scopes retrieve,write] [--max-uses N] [--expires-days D] | --redeem <code> | --list');
    process.exit(1);
  }
} finally { store.close(); }
