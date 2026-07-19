// jikji/test/hardening.test.mjs — 이관본 추가 하드닝 증거 (Codex M0 검토 반영)
//  - Host 검증이 healthz 포함 전 경로에 우선 적용(DNS rebinding 방어)
//  - Origin allowlist 거부
//  - JIKJI_ENV=production 경로의 시크릿 fail-closed (env 경로, prod 파라미터 아님)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { createJikjiServer } from '../server.mjs';

function freshServer(opts = {}) {
  const dbPath = join(tmpdir(), `jikji-hard-${crypto.randomBytes(6).toString('hex')}.db`);
  const s = createJikjiServer({ dbPath, ...opts });
  return { ...s, dbPath, cleanup: () => { try { s.store.close(); } catch {} try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} } };
}

// 원시 http 요청으로 Host/Origin 헤더를 임의 지정(fetch 는 Host 를 못 바꿈).
function rawRequest(port, { method = 'POST', path = '/mcp', host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (host) headers.Host = host;
    if (origin) headers.Origin = origin;
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end('{}'); else req.end();
  });
}

test('Host 위조(non-loopback) → 403 host_forbidden (healthz 포함 전 경로)', async () => {
  const { httpServer, cleanup } = freshServer();
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const mcp = await rawRequest(port, { method: 'POST', path: '/mcp', host: 'evil.example.com' });
    assert.equal(mcp.status, 403);
    assert.match(mcp.body, /host_forbidden/);
    // healthz 도 Host 검증 뒤에 있으므로 위조 Host 는 403
    const hz = await rawRequest(port, { method: 'GET', path: '/healthz', host: 'evil.example.com' });
    assert.equal(hz.status, 403);
  } finally { await new Promise((r) => httpServer.close(r)); cleanup(); }
});

test('Origin allowlist 거부 → 403 origin_forbidden', async () => {
  const { httpServer, cleanup } = freshServer({ allowedOrigins: ['http://good.example'] });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  try {
    const res = await rawRequest(port, { method: 'POST', path: '/mcp', host: '127.0.0.1', origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    assert.match(res.body, /origin_forbidden/);
  } finally { await new Promise((r) => httpServer.close(r)); cleanup(); }
});

test('JIKJI_ENV=production → 시크릿 없으면 fail-closed (env 경로)', () => {
  const savedEnv = process.env.JIKJI_ENV;
  const savedSecret = process.env.JIKJI_API_HMAC_SECRET;
  process.env.JIKJI_ENV = 'production';
  delete process.env.JIKJI_API_HMAC_SECRET;
  const dbPath = join(tmpdir(), `jikji-fc-env-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    // prod 파라미터를 넘기지 않아도 JIKJI_ENV 로 prod 판정 → 시크릿 부재 = throw
    assert.throws(() => createJikjiServer({ dbPath }), /fail-closed/);
  } finally {
    if (savedEnv !== undefined) process.env.JIKJI_ENV = savedEnv; else delete process.env.JIKJI_ENV;
    if (savedSecret !== undefined) process.env.JIKJI_API_HMAC_SECRET = savedSecret;
    try { rmSync(dbPath); } catch {}
  }
});
