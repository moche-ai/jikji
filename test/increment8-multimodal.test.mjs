// jikji/test/increment8-multimodal.test.mjs — 멀티모달(이미지) 기억 + 교차모달 검색
//
// 실 VL 임베더(GPU)는 서빙 필요 → 여기선 결정적 스텁으로 배선을 검증한다.
// 스텁은 "완벽한 VL 모델"을 흉내: 이미지 data URL 페이로드를 개념 텍스트로 디코드해 텍스트와 같은 공간에 임베딩.
// 따라서 캡션에 없는 개념도 이미지 벡터가 담고, 텍스트 질의로 교차모달 회수됨.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { openStore } from '../store.mjs';
import { LexicalEmbedder } from '../embed.mjs';
import { MemoryCore } from '../core.mjs';

// 텍스트·이미지 통합 공간 스텁(멀티모달). 텍스트=lexical, 이미지=data URL 페이로드를 텍스트로 임베딩.
class StubVL {
  constructor() { this.lex = new LexicalEmbedder(64); this.dim = 64; this.id = 'stub:vl'; this.ver = 'vl-1'; this.isAsync = true; this.multimodal = true; }
  async embed(texts) { return this.lex.embed(texts); }
  async embedImage(url) {
    const m = /^data:[^,]+,(.+)$/s.exec(String(url));
    const concept = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
    return this.lex.embed([concept])[0];
  }
}
const dataUrlOf = (concept) => 'data:image/png;base64,' + Buffer.from(concept, 'utf8').toString('base64');

function freshCore(embedder) {
  const dbPath = join(tmpdir(), `jikji-i8-${crypto.randomBytes(6).toString('hex')}.db`);
  const store = openStore(dbPath);
  const core = new MemoryCore(store, embedder);
  return { store, core, cleanup: () => { store.close(); try { rmSync(dbPath); rmSync(dbPath + '-wal'); rmSync(dbPath + '-shm'); } catch {} } };
}
const ctxOf = (ns) => ({ namespaceId: ns, scopes: ['write', 'retrieve'], authorType: 'self', actorPseudonym: null });

test('멀티모달: 이미지 기억 저장 — fact+캡션+바이트+벡터', async () => {
  const { store, core, cleanup } = freshCore(new StubVL());
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true });
    const r = await core.writeImage(ctxOf('nsA'), { caption: '사진 하나', image: dataUrlOf('빨간 사각형 red square') });
    assert.equal(r.image, true);
    assert.ok(r.fact_id && r.revision_id);
    const img = store.getImage('nsA', r.revision_id);
    assert.ok(img && img.mime === 'image/png' && img.bytes.length > 0);   // 원본 바이트 보관
    const vec = store.getVector('nsA', r.revision_id);
    assert.ok(vec && vec.dim === 64);                                     // 이미지 벡터 색인됨(텍스트 outbox 아님)
    assert.equal(core.usage(ctxOf('nsA')).memories, 1);
  } finally { cleanup(); }
});

test('교차모달: 캡션에 없는 개념도 텍스트 질의로 이미지 회수(이미지 벡터 주도)', async () => {
  const { core, cleanup } = freshCore(new StubVL());
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true });
    // 캡션은 중립("사진 하나/둘") — 개념은 이미지에만. BM25는 무매칭 → dense(이미지 벡터)가 순위 결정.
    const red = await core.writeImage(ctxOf('nsA'), { caption: '사진 하나', image: dataUrlOf('빨간 사각형 red square') });
    await core.writeImage(ctxOf('nsA'), { caption: '사진 둘', image: dataUrlOf('파란 원 blue circle') });
    const res = await core.search(ctxOf('nsA'), { need: '빨간 사각형' });
    assert.equal(res.results[0].fact_id, red.fact_id);                    // 교차모달 top-1
    assert.ok(res.results[0].retrieval_reasons.includes('dense'));        // 이미지 벡터가 근거
  } finally { cleanup(); }
});

test('501: 비 멀티모달 임베더는 writeImage 거부', async () => {
  const { core, cleanup } = freshCore(new LexicalEmbedder());   // multimodal=undefined
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true });
    await assert.rejects(() => core.writeImage(ctxOf('nsA'), { image: dataUrlOf('x') }), (e) => e.code === 501);
  } finally { cleanup(); }
});

test('422: 잘못된 이미지 입력(빈 값/데이터URL 아님은 바이트 미보관이나 임베딩은 시도)', async () => {
  const { core, cleanup } = freshCore(new StubVL());
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true });
    await assert.rejects(() => core.writeImage(ctxOf('nsA'), { image: '' }), (e) => e.code === 422);
  } finally { cleanup(); }
});

test('pending→approve 이미지: 이미지 벡터가 승인 후에도 텍스트로 덮이지 않음', async () => {
  const { store, core, cleanup } = freshCore(new StubVL());
  try {
    // auto_approve=false → 이미지 write 는 pending. 벡터는 write 시 저장돼 있고, approve 가 텍스트로 덮으면 안 됨.
    core.ensureTenant('nsA', 'owner:a', { auto_approve: false, default_no_train: true });
    const r = await core.writeImage(ctxOf('nsA'), { caption: '사진', image: dataUrlOf('빨간 사각형 red square') });
    const before = store.getVector('nsA', r.revision_id);
    assert.ok(before, 'pending 이미지도 벡터 보유');
    core.review(ctxOf('nsA'), { revision_id: r.revision_id, decision: 'approve' });
    const after = store.getVector('nsA', r.revision_id);
    assert.deepEqual([...after.vector], [...before.vector], '승인 후 이미지 벡터 불변(텍스트 임베딩 미유입)');
    // 승인 → 교차모달 검색됨
    const res = await core.search(ctxOf('nsA'), { need: '빨간 사각형' });
    assert.equal(res.results[0].fact_id, r.fact_id);
  } finally { cleanup(); }
});

test('기억 수 캡: 이미지도 양 차등 대상(402)', async () => {
  const { core, cleanup } = freshCore(new StubVL());
  try {
    core.ensureTenant('nsA', 'owner:a', { auto_approve: true, default_no_train: true, max_memories: 1 });
    await core.writeImage(ctxOf('nsA'), { caption: 'c1', image: dataUrlOf('a') });
    await assert.rejects(() => core.writeImage(ctxOf('nsA'), { caption: 'c2', image: dataUrlOf('b') }), (e) => e.code === 402);
  } finally { cleanup(); }
});
