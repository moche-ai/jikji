// jikji/test/increment11-ratelimit.test.mjs — rate-limit + in-flight 백프레셔
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRateLimiter } from '../ratelimit.mjs';

test('토큰버킷: burst 소진 후 rate 거부, 시간 경과로 리필', () => {
  let t = 0;
  const rl = makeRateLimiter({ maxInflight: 100, ratePerMin: 60, burst: 3, now: () => t }); // 1 token/sec
  assert.equal(rl.take('k').ok, true);
  assert.equal(rl.take('k').ok, true);
  assert.equal(rl.take('k').ok, true);          // burst 3 소진
  const d = rl.take('k');
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'rate');
  assert.ok(d.retryAfter >= 1);
  t += 1000;                                     // +1 토큰
  assert.equal(rl.take('k').ok, true);
  assert.equal(rl.take('k').ok, false);          // 다시 소진
});

test('in-flight 상한: 초과 시 inflight 거부, release 로 슬롯 반환', () => {
  const rl = makeRateLimiter({ maxInflight: 2, ratePerMin: 600000, burst: 1000, now: () => 0 });
  assert.equal(rl.take('k').ok, true);
  assert.equal(rl.take('k').ok, true);           // inflight 2
  const d = rl.take('k');
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'inflight');
  assert.equal(rl.stats().inflight, 2);
  rl.release();
  assert.equal(rl.stats().inflight, 1);
  assert.equal(rl.take('k').ok, true);           // 슬롯 반환됨
});

test('in-flight 거부 시 토큰은 소비되지 않음(낭비 방지)', () => {
  const rl = makeRateLimiter({ maxInflight: 1, ratePerMin: 60, burst: 2, now: () => 0 });
  assert.equal(rl.take('k').ok, true);           // token 2→1, inflight 1
  assert.equal(rl.take('k').ok, false);          // inflight 거부 — token 소비 안 함
  rl.release();
  assert.equal(rl.take('k').ok, true);           // 남은 token 1 사용 가능
  assert.equal(rl.take('k').ok, false);          // 이제 token 소진(rate) — inflight 아님
});

test('키(테넌트)별 독립 버킷', () => {
  const rl = makeRateLimiter({ maxInflight: 100, ratePerMin: 60, burst: 1, now: () => 0 });
  assert.equal(rl.take('a').ok, true);
  assert.equal(rl.take('a').ok, false);          // a 소진
  assert.equal(rl.take('b').ok, true);           // b 는 독립
});

test('release 는 0 미만으로 내려가지 않음(중복 방지)', () => {
  const rl = makeRateLimiter({ maxInflight: 4, now: () => 0 });
  rl.release(); rl.release();
  assert.equal(rl.stats().inflight, 0);
  assert.equal(rl.take('k').ok, true);
  assert.equal(rl.stats().inflight, 1);
});
