// jikji/eval/run.mjs — 평가셋 실행 + 품질 게이트 CLI
//
// 사용: INFRA_TELEMETRY=off node eval/run.mjs [--k 8] [--floor 0.5] [--json]
//  - overall_recall < floor 이면 exit 1 (릴리스 차단 — 검색 품질 게이트, 회귀 방지).
//  - floor 는 현재 스캐폴드 기준선(BASELINE_FLOOR)이 기본. KURE-v1 승격은 이 floor 를 넘겨야 머지.
//
// 정본: the internal design spec §9-1 (평가셋 = MVP 필수, 미통과 릴리스 금지).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runEval, BASELINE_FLOOR } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const k = Number(arg('k', '8'));
  const floor = Number(arg('floor', String(BASELINE_FLOOR)));
  const asJson = process.argv.includes('--json');
  const dataset = JSON.parse(readFileSync(join(here, 'dataset-v0.json'), 'utf8'));
  const m = await runEval(dataset, { k });

  if (asJson) { console.log(JSON.stringify(m, null, 2)); }
  else {
    console.log(`\njikji eval — ${dataset.name} (k=${k})`);
    console.log(`  top1 accuracy  : ${m.top1_accuracy}  (passed ${m.passed}/${m.total})`);
    console.log(`  recall@k       : ${m.recall_at_k}`);
    console.log(`  contamination  : ${m.contamination}  (must_not violations ${m.violations})`);
    console.log('  by category    :');
    for (const [c, v] of Object.entries(m.by_category)) console.log(`    ${c.padEnd(10)} ${v}`);
    const fails = m.cases.filter((c) => !c.pass).map((c) => c.id);
    if (fails.length) console.log(`  failing cases  : ${fails.join(', ')}`);
  }

  if (m.top1_accuracy < floor) {
    console.error(`\n✗ GATE FAILED: top1_accuracy ${m.top1_accuracy} < floor ${floor} — 릴리스 차단(검색 품질 게이트).`);
    process.exit(1);
  }
  console.log(`\n✓ gate passed: top1_accuracy ${m.top1_accuracy} >= floor ${floor}`);
}

// 직접 실행일 때만 CLI 게이트 구동(import 부작용 금지 — Codex #7).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('eval error:', e); process.exit(2); });
}
