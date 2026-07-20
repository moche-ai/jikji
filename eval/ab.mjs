// jikji/eval/ab.mjs — A/B 측정 헬퍼: 한 임베더/리랭커 구성으로 데이터셋 top1/recall 출력(게이트 없음).
//  사용: JIKJI_EMBED_URL=... JIKJI_RERANK_URL=... node eval/ab.mjs <dataset.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runEval } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ds = process.argv[2] || 'dataset-v0.json';
const m = await runEval(JSON.parse(readFileSync(join(here, ds), 'utf8')), { k: 8 });
console.log(JSON.stringify({ dataset: ds, top1: m.top1_accuracy, recall: m.recall_at_k, contamination: m.contamination }));
