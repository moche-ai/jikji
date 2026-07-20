// jikji/server.mjs — MCP 진입점 (공식 @modelcontextprotocol/sdk, StreamableHTTP, JSON 응답모드)
//
// Ref: the internal design spec. Codex 코드검토 r1 반영: 시작 시 시크릿 fail-closed(P0-8) · authorType 서버봉인(P0-6) ·
//   enableJsonResponse(P1-4) · loopback 강제 + Host 검증(P1-5) · 경로 정확매칭(P2-2) · cleanup 1회(P2-3).
//  - 인증: Bearer jk_… → HMAC → resolveKey. namespace·authorType 는 인증에서 봉인(요청 body 불신, IDOR).

import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { openStore } from './store.mjs';
import { makeEmbedder } from './embed.mjs';
import { makeReranker } from './rerank.mjs';
import { startEmbeddingWorker } from './worker.mjs';
import { MemoryCore } from './core.mjs';
import { actorPseudonym } from './telemetry.mjs';
import { makeResolveBearer, probeAuthzProjection } from './authz.mjs';
import { makeRateLimiter } from './ratelimit.mjs';
import { INSTRUCTIONS, TOOL_DESC } from './protocol.mjs';

const NAME = 'jikji';
const VERSION = '0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
// 소켓 원격주소가 loopback 인가(Host 헤더 위조·DNS rebinding 방어 — dashboard.mjs 와 동일 강도).
const isLoopbackAddr = (a) => !!a && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.'));
const hostOf = (h) => String(h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
// 공개 노출 호스트 allowlist(리버스 프록시/터널 뒤). 소켓은 여전히 loopback(로컬 프록시)이어야 하고,
// Host 헤더만 이 목록을 추가로 허용한다(예: JIKJI_PUBLIC_HOSTS=mcp.moche.ai). 미설정이면 loopback 전용.
const PUBLIC_HOSTS = new Set((process.env.JIKJI_PUBLIC_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const hostAllowed = (h) => LOOPBACK.has(h) || PUBLIC_HOSTS.has(String(h).toLowerCase());

function buildServer(core, ctx) {
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  const ok = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
  const err = (e) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message, code: e.code || 500 }) }] });
  const reg = (name, shape, fn) => server.registerTool(name, { description: TOOL_DESC[name], inputSchema: shape }, async (a) => { try { return ok(await fn(a)); } catch (e) { return err(e); } });

  reg('memory_search', { task_context: z.string().optional(), need: z.string().optional(), location: z.string().optional(), k: z.number().int().min(1).max(50).optional() },
    (a) => core.search(ctx, a));
  reg('memory_write', { text: z.string(), kind: z.enum(['semantic', 'episodic', 'procedural']).optional(), scope_kind: z.enum(['user', 'workspace', 'project', 'session']).optional(), scope_ref: z.string().optional(), idempotency_key: z.string().optional() },
    (a) => core.write(ctx, { text: a.text, kind: a.kind, scopeKind: a.scope_kind, scopeRef: a.scope_ref, idempotencyKey: a.idempotency_key }));
  reg('memory_confirm', { revision_id: z.string() }, (a) => core.confirm(ctx, a));
  reg('memory_invalidate', { fact_id: z.string(), reason: z.string().optional() }, (a) => core.invalidate(ctx, a));
  reg('memory_update', { fact_id: z.string(), text: z.string(), expected_version: z.number().int().min(0) },
    (a) => core.update(ctx, { fact_id: a.fact_id, text: a.text, expectedVersion: a.expected_version }));
  reg('memory_list', { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }, (a) => core.list(ctx, a));
  reg('memory_pending', { limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }, (a) => core.pending(ctx, a));
  reg('memory_review', { revision_id: z.string(), decision: z.enum(['approve', 'reject', 'quarantine']) }, (a) => core.review(ctx, a));
  reg('memory_import_md', { markdown: z.string(), source: z.string().optional(), scope_kind: z.enum(['user', 'workspace', 'project', 'session']).optional(), scope_ref: z.string().optional() },
    (a) => core.importMarkdown(ctx, { markdown: a.markdown, source: a.source, scopeKind: a.scope_kind, scopeRef: a.scope_ref }));
  reg('memory_export_md', { limit: z.number().int().min(1).max(5000).optional() }, (a) => core.exportMarkdown(ctx, a));
  reg('memory_graph', { need: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, (a) => core.graph(ctx, a));
  reg('memory_lineage', { fact_id: z.string() }, (a) => core.lineage(ctx, a));
  reg('memory_hygiene', { stale_days: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
    (a) => core.hygiene(ctx, { staleDays: a.stale_days, limit: a.limit }));
  reg('memory_usage', {}, () => core.usage(ctx));
  reg('memory_feedback', { type: z.enum(['bug', 'feature', 'other']).optional(), text: z.string() }, (a) => core.feedback(ctx, a));
  reg('memory_pin', { fact_id: z.string(), pinned: z.boolean().optional() }, (a) => core.pin(ctx, a));
  reg('memory_write_batch', { items: z.array(z.object({ text: z.string(), kind: z.enum(['semantic', 'episodic', 'procedural']).optional(), scope_kind: z.enum(['user', 'workspace', 'project', 'session']).optional(), scope_ref: z.string().optional(), idempotency_key: z.string().optional() })).min(1).max(200) },
    (a) => core.writeBatch(ctx, a));
  reg('memory_forget', { fact_id: z.string(), reason: z.string().optional() }, (a) => core.forget(ctx, a));
  reg('memory_write_image', { image: z.string(), caption: z.string().optional(), mime: z.string().optional(), scope_kind: z.enum(['user', 'workspace', 'project', 'session']).optional(), scope_ref: z.string().optional() },
    (a) => core.writeImage(ctx, { image: a.image, caption: a.caption, mime: a.mime, scopeKind: a.scope_kind, scopeRef: a.scope_ref }));
  return server;
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 20_000_000) throw new Error('body_too_large'); chunks.push(c); }   // 이미지 data URL(멀티모달) 수용 — loopback+Bearer 전용
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * @param {object} o
 * @param {string} o.dbPath  고정 DB 경로(cwd 폴백 없음)
 * @param {string[]} o.allowedOrigins
 * @param {boolean} o.prod  production 여부(시크릿 fail-closed)
 * @param {string=} o.apiSecret  주입(미지정 시 env). prod 부재 시 생성 실패.
 */
export function createJikjiServer({ dbPath, allowedOrigins = [], prod = (process.env.JIKJI_ENV === 'production'), apiSecret } = {}) {
  if (!dbPath) throw new Error('dbPath required (no cwd fallback)');
  const secret = apiSecret ?? process.env.JIKJI_API_HMAC_SECRET ?? (prod ? null : 'dev-jikji-api-secret');
  if (!secret) throw new Error('JIKJI_API_HMAC_SECRET missing (fail-closed in production)'); // P0-8: 시작 시 검증
  const hashToken = (t) => crypto.createHmac('sha256', secret).update(String(t)).digest('hex');
  // 통합 ID(unified account): Bearer 'jku_…' → 공유 authz projection 리졸브. 'jk_…' → 자체 store(HMAC).
  const authzDbPath = process.env.JIKJI_AUTHZ_DB || './data/jikji-authz.db';
  // 내부 대시보드용 서버간 토큰(loopback + 이 토큰). 중앙 identity 앱의 웹 대시보드가 namespace별 통계를 프록시.
  // prod 에서 미설정 = 내부 엔드포인트 비활성(fail-closed). dev 는 로컬 기본값.
  const internalToken = process.env.JIKJI_INTERNAL_TOKEN || (prod ? null : 'dev-jikji-internal-token');
  const safeEq = (a, b) => {
    const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };

  const store = openStore(dbPath);
  const embedder = makeEmbedder();
  const core = new MemoryCore(store, embedder, { reranker: makeReranker() });
  // 실 임베더(async)면 백그라운드 임베딩 워커 기동(요청경로 무차단, GPU admission 게이트 뒤). 스캐폴드는 인라인.
  const stopWorker = embedder.isAsync ? startEmbeddingWorker(store, embedder) : null;
  const resolveBearer = makeResolveBearer({ store, hashToken, authzDbPath });
  // rate-limit/백프레셔: 검색=8B embed+rerank(공유 GPU)라 폭주 보호. 테넌트(namespace)별 토큰버킷 + 글로벌 in-flight.
  const limiter = makeRateLimiter({
    maxInflight: Number(process.env.JIKJI_MAX_INFLIGHT || 16),
    ratePerMin: Number(process.env.JIKJI_RATE_RPM || 120),
    burst: Number(process.env.JIKJI_RATE_BURST || 30),
  });
  // 부팅 probe(비치명): projection 없으면 통합키 인증만 fail-closed, 자체 store 는 정상.
  if (!probeAuthzProjection(authzDbPath)) console.error(`[jikji] authz projection unavailable at ${authzDbPath} — unified (jku_) keys will fail-closed; native keys OK`);
  const allowed = new Set(allowedOrigins);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://internal');
      // Host 검증(loopback 전용, DNS rebinding 방어 — P1-5). healthz 포함 전 경로에 우선 적용:
      // JIKJI_ALLOW_NONLOOPBACK 로 외부 bind 해도 원격 Host 는 healthz 조차 노출되지 않는다.
      // 기본(loopback 전용)엔 소켓주소+Host 둘 다 검증. JIKJI_ALLOW_NONLOOPBACK=1(프록시 뒤 의도적 노출)이면 소켓검증 생략.
      if ((process.env.JIKJI_ALLOW_NONLOOPBACK !== '1' && !isLoopbackAddr(req.socket?.remoteAddress)) || !hostAllowed(hostOf(req.headers.host))) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'host_forbidden' })); }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, service: NAME, version: VERSION }));
      }
      // 내부 대시보드 — 서버간 read 전용. ★신뢰경계(명시): loopback 강제(소켓+Host) + JIKJI_INTERNAL_TOKEN.
      // namespace 는 caller 가 지정하므로, 이 토큰을 가진 loopback 프로세스(=인증 세션으로 namespace 를
      // 서버측 도출하는 중앙 identity 앱)만 신뢰한다. 토큰 유출 시 cross-tenant read 가능 → 반드시 프로세스
      // 로컬 시크릿으로 관리. 강한 격리(서명된 namespace assertion·토큰별 namespace 스코프)는 GA 하드닝.
      if (url.pathname === '/internal/dashboard') {
        if (req.method !== 'GET') { res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' }); return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
        const t = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
        if (!internalToken || !safeEq(t, internalToken)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })); }
        const ns = url.searchParams.get('namespace');
        if (!ns || typeof ns !== 'string' || ns.length > 200) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad_namespace' })); }
        const dctx = { namespaceId: ns, scopes: ['retrieve'], authorType: 'self', actorPseudonym: null };
        try {
          const usage = core.usage(dctx);
          const kpi = core.kpis(dctx);
          const memories = core.list(dctx, { limit: 20 }).items.map((m) => ({ fact_id: m.fact_id, text: String(m.text ?? '').slice(0, 280), scope_kind: m.scope_kind, status: m.status }));
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ usage, kpi, memories }));
        } catch { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'internal_error' })); }
      }
      if (url.pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not_found' })); }
      // Origin allowlist (있을 때만)
      const o = req.headers.origin;
      if (o && !allowed.has(o)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'origin_forbidden' })); }
      if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }); return res.end(JSON.stringify({ error: 'method_not_allowed' })); }

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const resolved = resolveBearer(token);
      if (!resolved) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      // rate-limit/백프레셔(테넌트별). 초과 = 429 + Retry-After(에이전트가 백오프). 슬롯은 응답 close 시 반환.
      const gate = limiter.take(resolved.namespaceId);
      if (!gate.ok) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(gate.retryAfter) }); return res.end(JSON.stringify({ error: 'rate_limited', reason: gate.reason, retry_after: gate.retryAfter })); }
      let rlReleased = false; const rlRelease = () => { if (!rlReleased) { rlReleased = true; limiter.release(); } };
      res.once('close', rlRelease);
      // namespace·authorType 봉인(owner MCP = self). 클라이언트가 못 바꿈.
      const ctx = { namespaceId: resolved.namespaceId, scopes: resolved.scopes, authorType: 'self', actorPseudonym: actorPseudonym(resolved.keyId) };

      const body = await readBody(req);
      const server = buildServer(core, ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void server.close().catch(() => {}); });   // server.close() 가 transport 도 닫음(1회)
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(e.message === 'body_too_large' ? 413 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', message: String(e.message || e) }));
      }
    }
  });

  // 테스트/admin 키 발급 — 인스턴스 시크릿으로 HMAC
  const mintApiKey = (ns, scopes = ['write', 'retrieve']) => {
    const t = `jk_${crypto.randomBytes(24).toString('base64url')}`;
    const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
    store.insertApiKey({ keyId, keyPrefix: t.slice(0, 10), keyHash: hashToken(t), namespaceId: ns, scopes });
    return { token: t, keyId };
  };
  return { httpServer, store, core, mintApiKey, stopWorker };
}

// ── 직접 실행(서비스) ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.JIKJI_DB;
  if (!dbPath) { console.error('JIKJI_DB env required (fixed path, no cwd fallback)'); process.exit(1); }
  const host = process.env.JIKJI_HOST || '127.0.0.1';
  if (!LOOPBACK.has(host) && process.env.JIKJI_ALLOW_NONLOOPBACK !== '1') {
    console.error(`refusing non-loopback bind ${host} (증분1 loopback 전용; 외부노출=게이트). set JIKJI_ALLOW_NONLOOPBACK=1 to override.`);
    process.exit(1);
  }
  const port = Number(process.env.JIKJI_PORT || 8107);
  const origins = (process.env.JIKJI_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const { httpServer, store, stopWorker } = createJikjiServer({ dbPath, allowedOrigins: origins });
    httpServer.listen(port, host, () => console.log(`jikji-mcp listening http://${host}:${port} (db=${dbPath})`));
    // 우아한 종료: worker stop(진행 틱 await) → server close → store close 순서(Codex #8).
    let shuttingDown = false;
    const shutdown = async (sig) => {
      if (shuttingDown) return; shuttingDown = true;
      console.log(`jikji-mcp shutting down (${sig})`);
      try { if (stopWorker) await stopWorker(); } catch { /* noop */ }
      await new Promise((r) => httpServer.close(r));
      try { store.close(); } catch { /* noop */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (e) { console.error('startup failed:', e.message); process.exit(1); }
}
