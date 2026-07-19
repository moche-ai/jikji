// jikji/core.mjs — MemoryCore (진입 무관 코어; MCP/Gateway/어댑터가 얇게 위임)
//
// Ref: the internal design spec. Codex 코드검토 r1 반영:
//  - author_type 은 **ctx 봉인값**(서버 결정) — write payload 에서 제거(P0-6). 클라이언트 불신.
//  - 멱등 해시 = 전체 canonical command(P0-2). 임베딩 = outbox consumer(write 성공과 분리, P0-3).
//  - 입력 NFKC/zero-width 정규화 후 스캔 + secret 확장(P0-7). 검색 입력 검증(P1-8).
//
// ctx = { namespaceId, scopes[], authorType, actorPseudonym } — namespace·authorType 은 인증에서 봉인(요청 body 불신).

import crypto from 'node:crypto';
import { MOD, STATUS } from './store.mjs';
import { packVector, unpackVector, cosine } from './embed.mjs';
import { emit, notionalCost, labelHash } from './telemetry.mjs';

// injection 패턴(risk signal — 승인 근거 아님)
const INJECTION_PATTERNS = [
  /ignore (the )?(previous|above|prior|all)/i, /disregard (the )?(previous|above|all)/i,
  /무시(하고|해|하라|하세요|할)/, /system prompt|시스템 프롬프트|system message/i,
  /you are now|act as|jailbreak|developer mode/i,
  /(reveal|print|show|leak|dump).{0,24}(secret|api[ _-]?key|password|token|credential)/i,
  /(비밀|비번|토큰|키|자격).{0,12}(알려|공개|출력|보여|유출)/,
  /<\/?(system|tool_call|function|assistant)>/i, /\[\[?system\]?\]/i,
];
// secret 패턴(저장 거부 — 마스킹 아님). 확장.
const SECRET_PATTERNS = [
  /sk-(proj-)?[a-zA-Z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{40,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, /AIza[0-9A-Za-z_-]{35}/,
];

/** NFKC 정규화 + zero-width/제어문자 제거(회피 방어). 스캔용 사본 — 저장은 원문. */
function normalizeForScan(text) {
  return String(text ?? '').normalize('NFKC').replace(/[​-‍﻿⁠­]/g, '').replace(/\s+/g, ' ');
}
function requireScope(ctx, scope) { if (!ctx?.scopes?.includes(scope)) { const e = new Error('forbidden_scope'); e.code = 403; throw e; } }
function canonical(obj) {
  const keys = Object.keys(obj).sort();
  return crypto.createHash('sha256').update(JSON.stringify(keys.map((k) => [k, obj[k]]))).digest('hex');
}

export class MemoryCore {
  constructor(store, embedder, { logger = null } = {}) { this.store = store; this.embedder = embedder; this.logger = logger; }

  ensureTenant(namespaceId, ownerScope, policy = { auto_approve: true, default_no_train: true }) {
    return this.store.ensureNamespace(namespaceId, ownerScope, policy);
  }

  // moderation: risk/external/third_party → quarantine · assistant(자동추출) → pending · self → 정책 auto_approve
  _moderate(ns, authorType, riskFlags) {
    if (riskFlags?.length) return MOD.QUARANTINED;
    if (authorType === 'external' || authorType === 'third_party') return MOD.QUARANTINED;
    if (authorType === 'assistant') return MOD.PENDING;
    const policy = this.store.getNamespace(ns)?.policy || {};
    return policy.auto_approve ? MOD.APPROVED : MOD.PENDING;
  }

  _embedFn() {
    const emb = this.embedder;
    return (text) => { const [v] = emb.embed([text]); return { dim: emb.dim, buf: packVector(v), embedderId: emb.id, embedderVer: emb.ver }; };
  }

  // ── WRITE (authorType = ctx 봉인, payload 불신) ──
  write(ctx, { text, kind = 'semantic', scopeKind = 'user', scopeRef = null, idempotencyKey = null, factId = null, expectedVersion = null }) {
    requireScope(ctx, 'write');
    const t0 = Date.now();
    if (typeof text !== 'string' || !text.trim()) { const e = new Error('empty_text'); e.code = 422; throw e; }
    if (text.length > 8000) { const e = new Error('text_too_large'); e.code = 413; throw e; }
    const scan = normalizeForScan(text);
    if (SECRET_PATTERNS.some((re) => re.test(scan)) || SECRET_PATTERNS.some((re) => re.test(text))) {
      this.store.audit(ctx.namespaceId, 'write.secret_rejected', ctx.actorPseudonym);
      emit({ event: 'memory.write', ok: false, reason: 'secret_rejected', actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
      const e = new Error('secret_content_rejected'); e.code = 422; throw e;
    }
    const risk = INJECTION_PATTERNS.filter((re) => re.test(scan)).map((re) => re.source.slice(0, 24));
    const authorType = ctx.authorType;                    // 서버 봉인(P0-6). 누락 = fail-closed(기본 승격 금지)
    if (!authorType) { const e = new Error('author_type_required'); e.code = 500; throw e; }
    const moderationState = this._moderate(ctx.namespaceId, authorType, risk);

    const res = this.store.writeFact(ctx.namespaceId, {
      factId, text, kind, scopeKind, scopeRef, authorType, moderationState, riskFlags: risk.length ? risk : null,
      expectedVersion, idempotencyKey,
      requestHash: idempotencyKey ? canonical({ op: 'write', text, kind, scopeKind, scopeRef: scopeRef ?? '', factId: factId ?? '', expectedVersion: expectedVersion ?? -1, authorType }) : null,
    });

    // 임베딩은 outbox consumer 가 — 실패해도 write 는 성공(pending 재시도). best-effort.
    if (moderationState === MOD.APPROVED && !res.idempotent_replay) {
      try { this.store.processEmbeddings(ctx.namespaceId, this._embedFn()); } catch { /* pending 유지 */ }
    }
    this.store.audit(ctx.namespaceId, 'memory.write', ctx.actorPseudonym, { moderation: moderationState, risk: risk.length });
    emit({ event: 'memory.write', ok: true, moderation: moderationState, quarantined: moderationState === MOD.QUARANTINED,
      actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId), latency_ms: Date.now() - t0,
      input_units: text.length, tier: 'lexical', cost_usd_notional: notionalCost({ tier: 'embed', inputUnits: text.length }) }, this.logger);
    return res;
  }

  // ── SEARCH (서버측 쿼리 최적화 {task_context, need, location}) ──
  search(ctx, { task_context = '', need = '', location = '', k = 8 } = {}) {
    requireScope(ctx, 'retrieve');
    const t0 = Date.now();
    for (const [n, v] of [['task_context', task_context], ['need', need], ['location', location]]) {
      if (typeof v !== 'string') { const e = new Error(`bad_${n}`); e.code = 422; throw e; }
      if (v.length > 2000) { const e = new Error(`${n}_too_large`); e.code = 413; throw e; }
    }
    const kk = Number.isInteger(k) ? Math.min(Math.max(k, 1), 50) : 8;
    const queryText = [need, task_context, location].filter((s) => s && s.trim()).join(' \n ').trim();
    if (!queryText) { const e = new Error('empty_query'); e.code = 422; throw e; } // 빈 질의 = 랜덤 top-k 방지(P1-8)

    const [qv] = this.embedder.embed([queryText]);
    const rows = this.store.activeApprovedRevisions(ctx.namespaceId);   // quarantine/pending 제외
    const scored = [];
    for (const r of rows) {
      const v = this.store.getVector(ctx.namespaceId, r.revision_id);
      if (!v) continue;
      const score = cosine(qv, unpackVector(v.vector, v.dim));
      scored.push({
        fact: r.text, fact_id: r.fact_id, revision_id: r.revision_id,
        fact_confidence: r.fact_confidence ?? null, retrieval_score: +score.toFixed(4),
        validity_status: STATUS.ACTIVE, scope_kind: r.scope_kind,
        source: [{ revision_id: r.revision_id }], retrieval_reasons: ['dense_lexical'],
      });
    }
    scored.sort((a, b) => b.retrieval_score - a.retrieval_score);
    const results = scored.slice(0, kk);
    emit({ event: 'memory.search', ok: true, result_count: results.length, tier: 'lexical',
      actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId), latency_ms: Date.now() - t0,
      input_units: queryText.length, cost_usd_notional: notionalCost({ tier: 'embed', inputUnits: queryText.length }) }, this.logger);
    return { results, query_optimized: true };
  }

  confirm(ctx, { revision_id }) {
    requireScope(ctx, 'retrieve');
    const r = this.store.confirmRevision(ctx.namespaceId, revision_id);
    emit({ event: 'memory.confirm', ok: r.ok, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return r;
  }
  invalidate(ctx, { fact_id, reason = null }) {
    requireScope(ctx, 'write');
    const r = this.store.retractFact(ctx.namespaceId, fact_id, reason);
    emit({ event: 'memory.invalidate', ok: true, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return r;
  }
  list(ctx, { limit = 50, offset = 0 } = {}) {
    requireScope(ctx, 'retrieve');
    const lim = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    const off = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
    return { items: this.store.listActive(ctx.namespaceId, { limit: lim, offset: off }) };
  }
  forget(ctx, { fact_id, reason = null }) {
    requireScope(ctx, 'write');
    const r = this.store.forgetFact(ctx.namespaceId, fact_id, reason);
    emit({ event: 'memory.forget', ok: true, verified: r.active_verified, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return r;
  }
}
