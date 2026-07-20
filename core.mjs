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

    // dedup(증분2): create 경로에서 동일 scope 활성 head 와 content_hash 일치 → 새 fact 만들지 않고 기존 반환.
    // idempotencyKey 가 있으면 명시적 멱등 계약이 우선 — dedup 를 건너뛰고 writeFact 의 멱등 경로가 처리.
    if (!factId && !idempotencyKey) {
      const dup = this.store.findActiveByContentHash(ctx.namespaceId, this.store.contentHash(text), scopeKind);
      if (dup) {
        emit({ event: 'memory.write', ok: true, reason: 'deduped', actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId), latency_ms: Date.now() - t0 }, this.logger);
        return { ...dup, deduped: true, moderation: MOD.APPROVED, status: STATUS.ACTIVE };
      }
    }

    const res = this.store.writeFact(ctx.namespaceId, {
      factId, text, kind, scopeKind, scopeRef, authorType, moderationState, riskFlags: risk.length ? risk : null,
      expectedVersion, idempotencyKey,
      requestHash: idempotencyKey ? canonical({ op: 'write', text, kind, scopeKind, scopeRef: scopeRef ?? '', factId: factId ?? '', expectedVersion: expectedVersion ?? -1, authorType }) : null,
    });

    // 임베딩은 outbox consumer 가 — 실패해도 write 는 성공(pending 재시도). best-effort.
    if (moderationState === MOD.APPROVED && !res.idempotent_replay) {
      try { this.store.processEmbeddings(ctx.namespaceId, this._embedFn()); } catch { /* pending 유지 */ }
      // 모순검출(feature flag, 기본 OFF — 기준선 대비 개선 검증 후 승격). 애매 충돌 = disputed 양쪽 보존.
      const policy = this.store.getNamespace(ctx.namespaceId)?.policy || {};
      if (policy.contradiction_detection) {
        try {
          const c = this._detectContradiction(ctx.namespaceId, res.revision_id);
          if (c) { res.disputed_with = c.revision_id; res.conflict_set_id = c.set_id; res.status = STATUS.DISPUTED; }
        } catch { /* 검출 실패는 write 를 막지 않음 — best-effort(감사·계측은 _detect 내부) */ }
      }
    }
    this.store.audit(ctx.namespaceId, 'memory.write', ctx.actorPseudonym, { moderation: moderationState, risk: risk.length });
    emit({ event: 'memory.write', ok: true, moderation: moderationState, quarantined: moderationState === MOD.QUARANTINED,
      actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId), latency_ms: Date.now() - t0,
      input_units: text.length, tier: 'lexical', cost_usd_notional: notionalCost({ tier: 'embed', inputUnits: text.length }) }, this.logger);
    return res;
  }

  // 새 리비전과 가장 유사한 다른 active fact(같은 scope, cosine≥임계, 다른 내용) → disputed 양쪽 보존.
  // scope 는 새 리비전 자신의 fact scope 에서 도출(update 든 create 든 정확 — Codex #6).
  _detectContradiction(ns, newRevisionId, threshold = 0.85) {
    const nv = this.store.getVector(ns, newRevisionId);
    if (!nv) return null;
    const all = this.store.searchableRevisions(ns);
    const self = all.find((r) => r.revision_id === newRevisionId);
    if (!self) return null;                                 // 승인 head 아니면 검출 안 함
    const scopeKind = self.scope_kind;
    const qv = unpackVector(nv.vector, nv.dim);
    let best = null, bestScore = 0;
    for (const r of all) {
      if (r.revision_id === newRevisionId || r.status !== STATUS.ACTIVE || r.scope_kind !== scopeKind) continue;
      const v = this.store.getVector(ns, r.revision_id);
      if (!v) continue;
      const s = cosine(qv, unpackVector(v.vector, v.dim));
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best && bestScore >= threshold) {
      const { set_id } = this.store.markDisputed(ns, newRevisionId, best.revision_id);
      this.store.audit(ns, 'memory.contradiction', null, { score: +bestScore.toFixed(3) });
      emit({ event: 'memory.contradiction', ok: true, namespace_hash: labelHash(ns) }, this.logger);
      return { revision_id: best.revision_id, set_id, score: bestScore };
    }
    return null;
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
    const rows = this.store.searchableRevisions(ctx.namespaceId);   // active+disputed head, quarantine/pending 제외
    const scored = [];
    for (const r of rows) {
      const v = this.store.getVector(ctx.namespaceId, r.revision_id);
      if (!v) continue;
      const score = cosine(qv, unpackVector(v.vector, v.dim));
      scored.push({
        fact: r.text, fact_id: r.fact_id, revision_id: r.revision_id,
        fact_confidence: r.fact_confidence ?? null, retrieval_score: +score.toFixed(4),
        validity_status: r.status,                          // active | disputed (설명가능성: temporal 유효성 분리)
        conflict_set_id: r.conflict_set_id || null,          // disputed 는 충돌묶음 id 로 모델이 판단
        scope_kind: r.scope_kind,
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

  // ── 증분2: update(supersede) / pending inbox / review / md 양방향 ──

  /** 내용 변경 = 새 리비전으로 supersede(자동 덮어쓰기 아님 — 명시 호출). expectedVersion 필수(CAS).
   *  scope 는 생성 시 고정(불변) — update 로 바꾸지 않는다(바꾸려면 forget 후 재생성). */
  update(ctx, { fact_id, text, expectedVersion, idempotencyKey = null }) {
    requireScope(ctx, 'write');
    if (!fact_id) { const e = new Error('fact_id_required'); e.code = 422; throw e; }
    if (expectedVersion === null || expectedVersion === undefined) { const e = new Error('expected_version_required'); e.code = 428; throw e; }
    const res = this.write(ctx, { text, factId: fact_id, expectedVersion, idempotencyKey });
    emit({ event: 'memory.update', ok: true, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return res;
  }

  /** 저장 전 리뷰 큐(pending_review) 조회 — 승인 전 색인 안 됨. */
  pending(ctx, { limit = 100, offset = 0 } = {}) {
    requireScope(ctx, 'retrieve');
    const lim = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 100;
    const off = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
    return { items: this.store.listPending(ctx.namespaceId, { limit: lim, offset: off }) };
  }

  /** pending/quarantined 리비전 심의: approve → active+색인, reject/quarantine → 색인 안 됨. */
  review(ctx, { revision_id, decision }) {
    requireScope(ctx, 'write');
    const map = { approve: MOD.APPROVED, reject: MOD.REJECTED, quarantine: MOD.QUARANTINED };
    const state = map[decision];
    if (!state) { const e = new Error('bad_decision'); e.code = 422; throw e; }
    const r = this.store.decideModeration(ctx.namespaceId, revision_id, state, ctx.actorPseudonym || 'policy');
    if (state === MOD.APPROVED) { try { this.store.processEmbeddings(ctx.namespaceId, this._embedFn()); } catch { /* pending 유지 */ } }
    this.store.audit(ctx.namespaceId, 'memory.review', ctx.actorPseudonym, { decision });
    emit({ event: 'memory.review', ok: true, moderation: state, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return r;
  }

  /** md 임포트(온보딩 즉시 가치) — 헤딩/불릿/문단을 fact 단위로 분해해 저장. 각 라인은 write 게이트 통과. */
  importMarkdown(ctx, { markdown, source = 'md', scopeKind = 'user', scopeRef = null }) {
    requireScope(ctx, 'write');
    if (typeof markdown !== 'string' || !markdown.trim()) { const e = new Error('empty_markdown'); e.code = 422; throw e; }
    if (markdown.length > 200000) { const e = new Error('markdown_too_large'); e.code = 413; throw e; }
    const units = splitMarkdown(markdown);
    const results = [];
    for (const u of units) {
      try { results.push({ text: u, ...this.write(ctx, { text: u, kind: 'semantic', scopeKind, scopeRef }) }); }
      catch (e) { results.push({ text: u, error: e.message, code: e.code || 500 }); }
    }
    const imported = results.filter((r) => r.fact_id).length;
    const { import_id } = this.store.recordImport(ctx.namespaceId, source, { units: units.length, imported });
    this.store.audit(ctx.namespaceId, 'memory.import', ctx.actorPseudonym, { units: units.length, imported });
    emit({ event: 'memory.import', ok: true, result_count: imported, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return { import_id, units: units.length, imported, results };
  }

  /** 다이제스트 export(신뢰↑) — 활성 fact 를 사람용 md 로. 내용은 오너 namespace 만. */
  exportMarkdown(ctx, { limit = 1000 } = {}) {
    requireScope(ctx, 'retrieve');
    const items = this.store.listActive(ctx.namespaceId, { limit: Math.min(Math.max(limit, 1), 5000), offset: 0 });
    const lines = ['# Jikji memory export', '', `_${items.length} active memories_`, ''];
    for (const it of items) lines.push(`- ${String(it.text).replace(/\n+/g, ' ')}`);
    emit({ event: 'memory.export', ok: true, result_count: items.length, actor_pseudonym: ctx.actorPseudonym, namespace_hash: labelHash(ctx.namespaceId) }, this.logger);
    return { markdown: lines.join('\n') + '\n', count: items.length };
  }
}

/** md → fact 단위: 헤딩/불릿/번호목록/비어있지 않은 문단을 개별 fact 텍스트로. 코드펜스는 통째 1단위. */
function splitMarkdown(md) {
  const out = [];
  const lines = String(md).split(/\r?\n/);
  let inFence = false, fence = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line.trim())) {
      if (inFence) { fence.push(line); const block = fence.join('\n').trim(); if (block) out.push(block); fence = []; inFence = false; }
      else { inFence = true; fence = [line]; }
      continue;
    }
    if (inFence) { fence.push(line); continue; }
    const t = line.trim();
    if (!t) continue;
    // 불릿/번호/헤딩 마커 제거 후 본문만
    const cleaned = t.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (cleaned.length >= 2) out.push(cleaned);
  }
  if (inFence && fence.length) { const block = fence.join('\n').trim(); if (block) out.push(block); }
  // 과도한 세분화 방지: 중복 제거, 최대 500단위
  return [...new Set(out)].slice(0, 500);
}
