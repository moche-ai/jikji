// jikji/embed.mjs — Embedder 인터페이스 + 스캐폴드 폴백(LexicalEmbedder)
//
// 정본: the internal design spec (계층형 검색). 검색 경로(cosine)는 실제와 동일 — 임베더 impl 만 스왑한다.
//  - LexicalEmbedder: GPU 무필요 결정적 char n-gram 해시 → 고정차원 f32. **품질 낮음(정직 라벨)**, KURE-v1 대기.
//  - HttpEmbedder(1b): jikji-embed(:8108) KURE-v1 호출 — 같은 인터페이스, 벡터만 고품질로.
//
// 벡터는 Float32Array → Buffer(LE) 로 직렬화해 BLOB 저장. dim 고정(스캐폴드 256).

import crypto from 'node:crypto';

export const SCAFFOLD_DIM = 256;

/** Float32Array → Node Buffer (명시적 little-endian, 이식성 P2-1). */
export function packVector(f32) {
  const buf = Buffer.allocUnsafe(f32.length * 4);
  for (let i = 0; i < f32.length; i++) buf.writeFloatLE(f32[i], i * 4);
  return buf;
}
/** BLOB(node:sqlite = Uint8Array) → Float32Array. 길이·dim 검증(P2-1). */
export function unpackVector(buf, dim) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!Number.isInteger(dim) || dim <= 0 || dim > 65536) throw new Error('bad_dim');
  if (u8.byteLength !== dim * 4) throw new Error('vector_length_mismatch');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const f = new Float32Array(dim);
  for (let i = 0; i < dim; i++) f[i] = dv.getFloat32(i * 4, true);
  return f;
}

/** 코사인 유사도. 차원 불일치는 조용히 절단하지 않고 0(P2-1). */
export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function l2normalize(f32) {
  let s = 0;
  for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
  for (let i = 0; i < f32.length; i++) f32[i] *= inv;
  return f32;
}

/** 텍스트 → char n-gram(2,3) 목록 (한글/영문/숫자 무관, 공백 정규화). */
function ngrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = [];
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= s.length; i++) grams.push(s.slice(i, i + n));
  }
  if (grams.length === 0 && s.length) grams.push(s);
  return grams;
}

/**
 * 결정적 해시 임베더 — 각 n-gram 을 md5 로 차원 버킷에 해싱(부호 포함) → L2 정규화.
 * GPU·모델 무필요. 재현성 있음(같은 텍스트=같은 벡터). **스캐폴드 품질**.
 */
export class LexicalEmbedder {
  constructor(dim = SCAFFOLD_DIM) {
    this.dim = dim;
    this.id = 'lexical-hash';
    this.ver = `scaffold-1-d${dim}`;
    this.isAsync = false;   // 동기 — write 시 인라인 드레인 가능(스캐폴드)
  }
  /** @param {string[]} texts @param {{instruction?:string}=} _opts (스캐폴드는 instruction 무시) @returns {Float32Array[]} */
  embed(texts, _opts) {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const g of ngrams(t)) {
        const h = crypto.createHash('md5').update(g).digest();
        const bucket = h.readUInt32LE(0) % this.dim;
        const sign = (h[4] & 1) ? 1 : -1;
        v[bucket] += sign;
      }
      return l2normalize(v);
    });
  }
}

/**
 * 실 임베더(GPU admission 게이트 뒤) — jikji-embed(:8108) KURE-v1 호출. async(Promise 반환, isAsync=true).
 * 문서 벡터는 백그라운드 outbox 워커가 생성·저장, 검색은 저장 벡터를 읽고 쿼리만 이걸로 임베딩. embedder_ver 재색인 추적.
 */
export class HttpEmbedder {
  constructor(url, { model = 'kure-v1', dim = 1024, timeoutMs = 5000 } = {}) {
    this.url = url; this.model = model; this.dim = dim; this.timeoutMs = timeoutMs;
    this.id = `http:${model}`; this.ver = model; this.isAsync = true;
  }
  async embed(texts, { instruction = null } = {}) {
    const res = await fetch(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, ...(instruction ? { instruction } : {}) }),   // 케이스별 임베딩(쿼리 instruction)
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`embed_http_${res.status}`);
    const j = await res.json();
    const arr = j.embeddings || j.data;
    if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('embed_bad_shape');
    return arr.map((v) => Float32Array.from(v.embedding || v));
  }
}

/**
 * 멀티모달 임베더 — vLLM Qwen3-VL /pooling 엔드포인트(텍스트+이미지 통합 임베딩 공간, 교차모달 검색).
 * embed(texts) = 텍스트, embedImage(dataUrl) = 이미지. 같은 4096차원 공간이라 텍스트질의로 이미지 회수 가능.
 */
export class VlPoolingEmbedder {
  constructor(url, { model = 'vlfp8', dim = 4096, timeoutMs = 8000 } = {}) {
    this.base = String(url).replace(/\/(pooling|v1\/embeddings|embed)\/?$/, '');
    this.url = this.base + '/pooling';
    this.model = model; this.dim = dim; this.timeoutMs = timeoutMs;
    this.id = `vl:${model}`; this.ver = model; this.isAsync = true; this.multimodal = true;
  }
  async _pool(content) {
    const res = await fetch(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`pool_http_${res.status}`);
    const v = (await res.json())?.data?.[0]?.data;
    if (!Array.isArray(v)) throw new Error('pool_bad_shape');
    return Float32Array.from(v);
  }
  async embed(texts, { instruction = null } = {}) {
    return Promise.all(texts.map((t) => this._pool([{ type: 'text', text: instruction ? `Instruct: ${instruction}\nQuery: ${t}` : t }])));
  }
  /** 이미지(data URL 또는 http url) → 임베딩. 텍스트와 같은 공간(교차모달). */
  async embedImage(url) { return this._pool([{ type: 'image_url', image_url: { url } }]); }
}

/** env 기반 임베더 팩토리. /pooling(멀티모달 vLLM) > HttpEmbedder(text) > 스캐폴드(sync). */
export function makeEmbedder(env = process.env) {
  if (env.JIKJI_EMBED_URL && (env.JIKJI_EMBED_MODE === 'vl' || /\/pooling\/?$/.test(env.JIKJI_EMBED_URL)))
    return new VlPoolingEmbedder(env.JIKJI_EMBED_URL, { model: env.JIKJI_EMBED_MODEL || 'vlfp8', dim: Number(env.JIKJI_EMBED_DIM || 4096) });
  if (env.JIKJI_EMBED_URL) return new HttpEmbedder(env.JIKJI_EMBED_URL, { dim: Number(env.JIKJI_EMBED_DIM || 1024) });
  return new LexicalEmbedder();
}
