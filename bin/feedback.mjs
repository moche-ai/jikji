#!/usr/bin/env node
// jikji/bin/feedback.mjs — 운영자 피드백/버그 리포트 콘솔 (베타 리포트 바로 확인·정리)
//
//  --list [--namespace ns] [--type bug|feature|other] [--open]   # 목록(기본 전 namespace)
//  --resolve <namespace> <id>                                    # 상태 resolved
//  --plan <namespace> <free|basic|pro|beta>                      # 유저 요금제 지정(베타=Pro급 무료)
//  --notify                                                      # open 피드백 요약을 Signal 로(env JIKJI_SIGNAL_CMD)
// JIKJI_DB 필요.

import { execFileSync } from 'node:child_process';
import { openStore } from '../store.mjs';

const dbPath = process.env.JIKJI_DB;
if (!dbPath) { console.error('JIKJI_DB env required'); process.exit(1); }
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : undefined; };
const pos = argv.filter((a) => !a.startsWith('--'));

const store = openStore(dbPath);
try {
  if (has('resolve')) {
    const [, ns, id] = pos.length >= 2 ? [null, pos[0], pos[1]] : [];
    if (!ns || !id) { console.error('--resolve <namespace> <id>'); process.exit(1); }
    console.log(JSON.stringify({ resolved: store.updateFeedbackStatus(ns, id, 'resolved'), namespace: ns, id }));
  } else if (has('plan')) {
    const ns = pos[0]; const plan = pos[1];
    if (!ns || !['free', 'basic', 'pro', 'beta'].includes(plan)) { console.error('--plan <namespace> <free|basic|pro|beta>'); process.exit(1); }
    const merged = store.updatePolicy(ns, { plan });
    console.log(JSON.stringify({ namespace: ns, plan, ok: !!merged }));
  } else {
    // list (기본)
    const ns = val('namespace') || null;
    let rows = store.listFeedback(ns, { limit: 500 });
    if (val('type')) rows = rows.filter((r) => r.type === val('type'));
    if (has('open')) rows = rows.filter((r) => r.status === 'open');
    if (has('notify')) {
      const open = rows.filter((r) => r.status === 'open');
      const summary = `[Jikji 베타 피드백] open ${open.length}건` + open.slice(0, 5).map((r) => `\n- [${r.type}] ${String(r.text).slice(0, 80)}`).join('');
      const cmd = process.env.JIKJI_SIGNAL_CMD;   // 예: /path/signal_alert.sh (내부경로는 env — 공개 리포에 안 박음)
      if (cmd) { try { execFileSync(cmd, [summary], { stdio: 'ignore' }); console.log('notified:', open.length); } catch { console.error('notify failed'); } }
      else console.log('(JIKJI_SIGNAL_CMD 미설정 — 알림 스킵)\n' + summary);
    } else {
      console.log(JSON.stringify(rows, null, 2));
    }
  }
} finally { store.close(); }
