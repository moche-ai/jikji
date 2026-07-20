// jikji/dashboard.mjs — 미니 대시보드 (기억 목록·검색·pending 승인·삭제·export/import·KPI)
//
// 정본: the internal design spec §5·§6. 유저 표면 = 소유권 체감(목록·검색·pending·삭제) + 절감 위젯.
// loopback 전용, API키(jk_) 인증 — server.mjs 와 같은 HMAC. 모든 액션은 MemoryCore 경유(계측 자동).
// 외부 노출은 유저 게이트. 별도 진입점(코어≠진입점): MemoryCore 를 얇게 위임할 뿐.

import http from 'node:http';
import crypto from 'node:crypto';
import { openStore } from './store.mjs';
import { makeEmbedder } from './embed.mjs';
import { makeReranker } from './rerank.mjs';
import { MemoryCore } from './core.mjs';
import { actorPseudonym } from './telemetry.mjs';

const NAME = 'jikji-dashboard';
const VERSION = '0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const hostOf = (h) => String(h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
// 실제 소켓 원격주소가 loopback 인가(Host 헤더는 위조 가능 — Codex #4).
const isLoopbackAddr = (a) => !!a && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.'));
// 보안 헤더(민감 기억 API·HTML — Codex #6). 인라인 스크립트 허용하되 origin 제한.
const SEC_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

export function createDashboard({ dbPath, prod = (process.env.JIKJI_ENV === 'production'), apiSecret } = {}) {
  if (!dbPath) throw new Error('dbPath required');
  const secret = apiSecret ?? process.env.JIKJI_API_HMAC_SECRET ?? (prod ? null : 'dev-jikji-api-secret');
  if (!secret) throw new Error('JIKJI_API_HMAC_SECRET missing (fail-closed in production)');
  const hashToken = (t) => crypto.createHmac('sha256', secret).update(String(t)).digest('hex');

  const store = openStore(dbPath);
  const core = new MemoryCore(store, makeEmbedder(), { reranker: makeReranker() });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...SEC_HEADERS }); res.end(JSON.stringify(obj)); };

  const httpServer = http.createServer(async (req, res) => {
    try {
      // loopback 강제: 소켓 원격주소 + Host 헤더 둘 다(위조 방지 — Codex #4).
      if (!isLoopbackAddr(req.socket?.remoteAddress) || !LOOPBACK.has(hostOf(req.headers.host))) return json(res, 403, { error: 'host_forbidden' });
      const url = new URL(req.url || '/', 'http://internal');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, service: NAME, version: VERSION });
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS }); return res.end(HTML); }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });

      // 인증(모든 /api) — Bearer jk_
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const resolved = token ? store.resolveKey(hashToken(token)) : null;
      if (!resolved) return json(res, 401, { error: 'unauthorized' });
      const ctx = { namespaceId: resolved.namespaceId, scopes: resolved.scopes, authorType: 'self', actorPseudonym: actorPseudonym(resolved.keyId) };

      let body = {};
      if (req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 1_000_000) return json(res, 413, { error: 'too_large' }); chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }

      const route = `${req.method} ${url.pathname}`;
      const r = await handle(route, ctx, body, url);
      if (r === undefined) return json(res, 404, { error: 'not_found' });
      return json(res, 200, r);
    } catch (e) {
      // 알려진 도메인 오류(4xx, e.code)만 메시지 전달. 그 외(JSON 파싱·SQLite 등)는 일반화(내부정보 비노출 — Codex #5).
      const known = e.code && Number.isInteger(e.code) && e.code >= 400 && e.code < 500;
      return json(res, known ? e.code : 500, { error: known ? e.message : 'internal_error' });
    }
  });

  async function handle(route, ctx, body, url) {
    switch (route) {
      case 'GET /api/kpi': return core.kpis(ctx);
      case 'GET /api/graph': return core.graph(ctx, { need: url.searchParams.get('need') || null, limit: Number(url.searchParams.get('limit') || 120) });
      case 'GET /api/memories': return core.list(ctx, { limit: Number(url.searchParams.get('limit') || 50) });
      case 'GET /api/pending': return core.pending(ctx);
      case 'GET /api/usage': return core.usage(ctx);
      case 'POST /api/feedback': return core.feedback(ctx, body);
      case 'GET /api/hygiene': return core.hygiene(ctx, {});
      case 'GET /api/lineage': return core.lineage(ctx, { fact_id: url.searchParams.get('fact_id') });
      case 'POST /api/pin': return core.pin(ctx, body);
      case 'GET /api/export': return core.exportMarkdown(ctx);
      case 'POST /api/search': return await core.search(ctx, body);
      case 'POST /api/review': return core.review(ctx, body);
      case 'POST /api/forget': return core.forget(ctx, body);
      case 'POST /api/import': return core.importMarkdown(ctx, body);
      default: return undefined;
    }
  }

  return { httpServer, store, core };
}

const HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jikji — my memory</title><style>
:root{--bg:#0f1216;--card:#191d24;--fg:#e6e9ef;--mut:#8b93a1;--acc:#5b8cff;--bad:#ff6b6b;--ok:#3ecf8e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,sans-serif}
header{padding:16px 20px;border-bottom:1px solid #262b33;display:flex;gap:12px;align-items:center}
h1{font-size:16px;margin:0}input,textarea,button{font:inherit}
input,textarea{background:#0c0f13;border:1px solid #2a303a;color:var(--fg);border-radius:8px;padding:8px 10px;width:100%}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}
button.ghost{background:#232833}button.bad{background:var(--bad)}button.ok{background:var(--ok)}
main{max-width:960px;margin:0 auto;padding:20px;display:grid;gap:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.card{background:var(--card);border:1px solid #262b33;border-radius:12px;padding:14px}
.kpi{text-align:center}.kpi b{display:block;font-size:22px}.kpi span{color:var(--mut);font-size:12px}
.row{display:flex;gap:8px;align-items:center}.mut{color:var(--mut)}.item{border-bottom:1px solid #232833;padding:10px 0}
.pill{font-size:11px;padding:2px 6px;border-radius:20px;background:#232833;color:var(--mut)}
.disputed{color:#ffc14d}.tok{color:var(--ok)}
</style></head><body>
<header><h1>直指 Jikji</h1><span class="mut">my portable memory</span>
<div style="flex:1"></div><input id="tok" placeholder="API token (jk_…)" style="max-width:280px"></header>
<main>
 <section class="grid" id="kpis"></section>
 <section class="card"><div class="row"><input id="q" placeholder="검색: 무엇이 필요한가 (need)"><button onclick="search()">검색</button></div>
  <div id="results"></div></section>
 <section class="card"><div class="row"><b>승인 대기 (pending)</b><button class="ghost" onclick="loadPending()">새로고침</button></div><div id="pending"></div></section>
 <section class="card"><div class="row"><b>기억 목록</b><button class="ghost" onclick="loadMemories()">새로고침</button>
  <div style="flex:1"></div><button class="ghost" onclick="exportMd()">export md</button></div><div id="memories"></div></section>
 <section class="card"><div class="row"><b>기억 지도</b><button class="ghost" onclick="loadGraph()">그리기</button><span class="mut">공유 용어로 이어진 관련 기억</span></div><div id="graph"></div></section>
 <section class="card"><b>md 임포트</b><textarea id="imp" rows="4" placeholder="- 이름은 …\\n- 선호는 …"></textarea>
  <div class="row" style="margin-top:8px"><button onclick="importMd()">임포트</button><span id="impmsg" class="mut"></span></div></section>
</main>
<script>
const tok=()=>document.getElementById('tok').value.trim();
document.getElementById('tok').value=sessionStorage.getItem('jk')||'';
document.getElementById('tok').oninput=e=>{sessionStorage.setItem('jk',e.target.value.trim());refresh()};
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json','authorization':'Bearer '+tok()}});if(!r.ok)throw new Error((await r.json()).error||r.status);return r.json()}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function loadKpi(){try{const k=await api('/api/kpi');document.getElementById('kpis').innerHTML=[['active',k.active],['pending',k.pending],['quarantined',k.quarantined],['disputed',k.disputed_sets],['confirms',k.confirms],['절감토큰(추정)',k.saved_tokens_estimate]].map(([l,v])=>'<div class="card kpi"><b class="'+(l.startsWith('절감')?'tok':'')+'">'+v+'</b><span>'+l+'</span></div>').join('')}catch(e){document.getElementById('kpis').innerHTML='<div class="mut">토큰을 입력하세요 ('+esc(e.message)+')</div>'}}
async function search(){const need=document.getElementById('q').value;if(!need)return;try{const s=await api('/api/search',{method:'POST',body:JSON.stringify({need})});document.getElementById('results').innerHTML=s.results.map(r=>'<div class="item"><span class="pill '+(r.validity_status==='disputed'?'disputed':'')+'">'+r.validity_status+'</span> '+esc(r.fact)+' <span class="mut">('+r.retrieval_reasons.join(',')+')</span></div>').join('')||'<div class="mut">없음</div>'}catch(e){alert(e.message)}}
async function loadMemories(){try{const m=await api('/api/memories');document.getElementById('memories').innerHTML=m.items.map(i=>'<div class="item row"><div style="flex:1">'+esc(i.text)+'</div><button class="bad" onclick="forget(\\''+i.fact_id+'\\')">삭제</button></div>').join('')||'<div class="mut">없음</div>'}catch(e){}}
async function loadPending(){try{const p=await api('/api/pending');document.getElementById('pending').innerHTML=p.items.map(i=>'<div class="item row"><div style="flex:1">'+esc(i.text)+' <span class="pill">'+i.author_type+'</span></div><button class="ok" onclick="review(\\''+i.revision_id+'\\',\\'approve\\')">승인</button><button class="ghost" onclick="review(\\''+i.revision_id+'\\',\\'reject\\')">거절</button></div>').join('')||'<div class="mut">없음</div>'}catch(e){}}
async function forget(id){if(!confirm('영구 삭제(파생 연쇄)?'))return;await api('/api/forget',{method:'POST',body:JSON.stringify({fact_id:id})});refresh()}
async function review(id,d){await api('/api/review',{method:'POST',body:JSON.stringify({revision_id:id,decision:d})});refresh()}
async function exportMd(){const e=await api('/api/export');const b=new Blob([e.markdown],{type:'text/markdown'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='jikji-export.md';a.click()}
async function importMd(){const md=document.getElementById('imp').value;if(!md)return;try{const r=await api('/api/import',{method:'POST',body:JSON.stringify({markdown:md})});document.getElementById('impmsg').textContent=r.imported+'/'+r.units+' 임포트';document.getElementById('imp').value='';refresh()}catch(e){alert(e.message)}}
async function loadGraph(){try{const g=await api('/api/graph');const W=900,H=440,cx=W/2,cy=H/2,R=Math.min(cx,cy)-46;const n=g.nodes.slice(0,60);const pos={};n.forEach((nd,i)=>{const a=2*Math.PI*i/(n.length||1);pos[nd.id]=[cx+R*Math.cos(a),cy+R*Math.sin(a)]});const ids=new Set(n.map(x=>x.id));const lines=g.edges.filter(e=>ids.has(e.src)&&ids.has(e.dst)).map(e=>'<line x1="'+pos[e.src][0]+'" y1="'+pos[e.src][1]+'" x2="'+pos[e.dst][0]+'" y2="'+pos[e.dst][1]+'" stroke="#2f3947" stroke-width="'+Math.min(e.weight,4)+'"/>').join('');const dots=n.map(nd=>'<circle cx="'+pos[nd.id][0]+'" cy="'+pos[nd.id][1]+'" r="'+(4+Math.min(nd.degree,8))+'" fill="'+(nd.status==='disputed'?'#ffc14d':'#5b8cff')+'"><title>'+esc(nd.label)+'</title></circle>').join('');document.getElementById('graph').innerHTML='<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="max-height:460px">'+lines+dots+'</svg><div class="mut">'+n.length+' 노드 · '+g.edges.length+' 엣지</div>'}catch(e){document.getElementById('graph').innerHTML='<div class="mut">'+esc(e.message)+'</div>'}}
function refresh(){loadKpi();loadMemories();loadPending()}
refresh();
</script></body></html>`;

// ── 직접 실행 ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.JIKJI_DB;
  if (!dbPath) { console.error('JIKJI_DB env required'); process.exit(1); }
  const host = process.env.JIKJI_HOST || '127.0.0.1';
  if (!LOOPBACK.has(host) && process.env.JIKJI_ALLOW_NONLOOPBACK !== '1') { console.error('refusing non-loopback bind (외부노출=게이트)'); process.exit(1); }
  const port = Number(process.env.JIKJI_DASHBOARD_PORT || 8109);
  try {
    const { httpServer } = createDashboard({ dbPath });
    httpServer.listen(port, host, () => console.log(`jikji-dashboard http://${host}:${port}`));
  } catch (e) { console.error('startup failed:', e.message); process.exit(1); }
}
