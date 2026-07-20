// jikji/test/increment5b.test.mjs — 증분5(M5): Gateway 프록시(캐시인지 주입·fail-open·인증)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { createGateway } from '../gateway.mjs';

// 모의 업스트림: 받은 messages 를 그대로 응답 content 에 담아 반환(주입 검증용).
function mockUpstream() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(body.messages) } }] }));
    });
  });
  return srv;
}

async function setup({ autoWrite = false } = {}) {
  const up = mockUpstream();
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${up.address().port}`;
  const dbPath = join(tmpdir(), `jikji-gw-${crypto.randomBytes(6).toString('hex')}.db`);
  const gw = createGateway({ dbPath, apiSecret: 'test-secret', upstream, autoWrite });
  gw.store.ensureNamespace('nsG', 'owner:g', { auto_approve: true, default_no_train: true });
  const { token } = gw.mintApiKey('nsG', ['retrieve', 'write']);
  await new Promise((r) => gw.httpServer.listen(0, '127.0.0.1', r));
  const port = gw.httpServer.address().port;
  return {
    gw, up, token, port, dbPath,
    cleanup: async () => { await new Promise((r) => gw.httpServer.close(r)); await new Promise((r) => up.close(r)); gw.store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} },
  };
}
const chat = (port, token, body) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

test('gateway: 관련 기억을 마지막 user 직전 system 슬롯에 주입(캐시인지) + 안전문구', async () => {
  const s = await setup();
  try {
    s.gw.core.write({ namespaceId: 'nsG', scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null }, { text: '내가 좋아하는 커피는 아메리카노다' });
    const r = await chat(s.port, s.token, { model: 'x', messages: [{ role: 'system', content: '너는 비서다' }, { role: 'user', content: '내가 좋아하는 커피 뭐였지' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-jikji-injected'), '1');
    const forwarded = JSON.parse((await r.json()).choices[0].message.content);
    // 고정 system prefix 는 첫 자리 유지, 기억 system 은 마지막 user 직전
    assert.equal(forwarded[0].content, '너는 비서다');
    const memIdx = forwarded.findIndex((m) => m.role === 'system' && m.content.includes('아메리카노'));
    const userIdx = forwarded.findIndex((m) => m.role === 'user');
    assert.ok(memIdx >= 0 && memIdx === userIdx - 1, '기억은 마지막 user 직전 슬롯');
    assert.ok(forwarded[memIdx].content.includes('reference DATA'), 'injection 안전 문구');
  } finally { await s.cleanup(); }
});

test('gateway: 무인증 401 (fail-CLOSED)', async () => {
  const s = await setup();
  try {
    const r = await chat(s.port, null, { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 401);
  } finally { await s.cleanup(); }
});

test('gateway: 관련 기억 없으면 미주입 + 원 요청 그대로 통과(fail-open 성격)', async () => {
  const s = await setup();
  try {
    const r = await chat(s.port, s.token, { model: 'x', messages: [{ role: 'user', content: '전혀 관련 없는 새로운 질문 xyzzy' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-jikji-injected'), '0');
    const forwarded = JSON.parse((await r.json()).choices[0].message.content);
    assert.equal(forwarded.length, 1);   // 주입 없음
  } finally { await s.cleanup(); }
});

test('gateway: 업스트림 오류(비JSON)는 status·body 원상 전달(502 일반화 아님)', async () => {
  const up = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('rate limited by upstream'); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const dbPath = join(tmpdir(), `jikji-gwe-${crypto.randomBytes(6).toString('hex')}.db`);
  const gw = createGateway({ dbPath, apiSecret: 'test-secret', upstream: `http://127.0.0.1:${up.address().port}` });
  gw.store.ensureNamespace('nsG', 'owner:g', { auto_approve: true, default_no_train: true });
  const { token } = gw.mintApiKey('nsG', ['retrieve', 'write']);
  await new Promise((r) => gw.httpServer.listen(0, '127.0.0.1', r));
  const port = gw.httpServer.address().port;
  try {
    const r = await chat(port, token, { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 429);                          // 원 status 보존
    assert.match(await r.text(), /rate limited by upstream/);
  } finally { await new Promise((r) => gw.httpServer.close(r)); await new Promise((r) => up.close(r)); gw.store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} }
});

test('gateway: auto-write(옵트인) → assistant 응답이 pending 기억으로 비동기 저장', async () => {
  const s = await setup({ autoWrite: true });
  try {
    await chat(s.port, s.token, { model: 'x', messages: [{ role: 'user', content: '기억해둘 사실 하나' }] });
    await new Promise((r) => setTimeout(r, 50));   // 비동기 write 대기
    const ctx = { namespaceId: 'nsG', scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null };
    // assistant 발화는 pending_review 로 격리(자동활성 금지)
    assert.ok(s.gw.core.pending(ctx).items.length >= 1);
  } finally { await s.cleanup(); }
});
