// jikji/test/mcp.test.mjs — 공식 MCP SDK 클라이언트 호환 증거 (Codex P0-5)
// 실 StreamableHTTP 클라이언트로 initialize + tools/list + tools/call 라운드트립.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createJikjiServer } from '../server.mjs';

test('MCP SDK 호환: initialize + tools/list + write→search 라운드트립', async () => {
  const dbPath = join(tmpdir(), `jikji-mcp-${crypto.randomBytes(6).toString('hex')}.db`);
  const { httpServer, store, mintApiKey } = createJikjiServer({ dbPath });
  store.ensureNamespace('nsMCP', 'owner:mcp', { auto_approve: true, default_no_train: true });
  const { token } = mintApiKey('nsMCP', ['write', 'retrieve']);

  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client({ name: 'jikji-test-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  try {
    await client.connect(transport);
    // instructions 전달(비강제 힌트) 확인
    const instr = client.getInstructions?.();
    assert.ok(instr && instr.includes('memory_search'), 'initialize.instructions 에 프로토콜 힌트');

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['memory_confirm', 'memory_export_md', 'memory_feedback', 'memory_forget', 'memory_graph', 'memory_hygiene', 'memory_import_md', 'memory_invalidate', 'memory_lineage', 'memory_list', 'memory_pending', 'memory_pin', 'memory_review', 'memory_search', 'memory_update', 'memory_usage', 'memory_write', 'memory_write_batch', 'memory_write_image']);

    // write
    const wRes = await client.callTool({ name: 'memory_write', arguments: { text: 'MCP 경유로 저장된 사실: 주말엔 등산을 한다' } });
    const w = JSON.parse(wRes.content[0].text);
    assert.ok(w.fact_id && w.revision_id);
    assert.equal(w.moderation, 'approved');

    // search (서버측 쿼리 최적화 인터페이스)
    const sRes = await client.callTool({ name: 'memory_search', arguments: { need: '주말 취미', task_context: '일정 계획', location: 'repo:x' } });
    const s = JSON.parse(sRes.content[0].text);
    assert.ok(s.results.length >= 1 && s.results[0].fact.includes('등산'));
    assert.ok('retrieval_score' in s.results[0]);
  } finally {
    try { await client.close(); } catch {}
    await new Promise((r) => httpServer.close(r));
    store.close();
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
  }
});

test('MCP: 무인증 요청 401', async () => {
  const dbPath = join(tmpdir(), `jikji-mcp-${crypto.randomBytes(6).toString('hex')}.db`);
  const { httpServer, store } = createJikjiServer({ dbPath });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => httpServer.close(r));
    store.close();
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
  }
});

test('prod fail-closed: 시크릿 없으면 createJikjiServer 실패 (P0-8)', () => {
  const dbPath = join(tmpdir(), `jikji-fc-${crypto.randomBytes(6).toString('hex')}.db`);
  const saved = process.env.JIKJI_API_HMAC_SECRET;
  delete process.env.JIKJI_API_HMAC_SECRET;
  try {
    assert.throws(() => createJikjiServer({ dbPath, prod: true }), /fail-closed/);
  } finally {
    if (saved !== undefined) process.env.JIKJI_API_HMAC_SECRET = saved;
    try { rmSync(dbPath); } catch {}
  }
});

test('MCP: healthz', async () => {
  const dbPath = join(tmpdir(), `jikji-mcp-${crypto.randomBytes(6).toString('hex')}.db`);
  const { httpServer, store } = createJikjiServer({ dbPath });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.service, 'jikji');
  } finally {
    await new Promise((r) => httpServer.close(r));
    store.close();
    try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {}
  }
});
