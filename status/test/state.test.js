import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState, dayStatus, uptimePct, worst, dayKey, lastDays, DOWN_AFTER } from '../src/state.js';

test('down only after three failed checks in a row, one event', () => {
  let s = null;
  const events = [];
  for (let i = 0; i < 5; i += 1) {
    const r = nextState(s, 'down', `t${i}`);
    s = r.state; events.push(r.event);
  }
  assert.deepEqual(events, [null, null, 'down', null, null]);
  assert.equal(s.status, 'down');
  assert.equal(s.since, 't2');
  assert.equal(DOWN_AFTER, 3);
});

test('a single blip never goes down', () => {
  let s = nextState(null, 'down', 't0').state;
  s = nextState(s, 'down', 't1').state;
  const r = nextState(s, 'operational', 't2');
  assert.equal(r.state.status, 'operational');
  assert.equal(r.state.failStreak, 0);
  assert.equal(nextState(r.state, 'down', 't3').state.status, 'operational');
});

test('recovers after two good checks, once', () => {
  let s = { status: 'down', failStreak: 9, okStreak: 0, since: 't0' };
  const r1 = nextState(s, 'operational', 't1');
  assert.equal(r1.event, null);
  assert.equal(r1.state.status, 'down');
  const r2 = nextState(r1.state, 'operational', 't2');
  assert.equal(r2.event, 'recovered');
  assert.equal(r2.state.status, 'operational');
  s = r2.state;
  assert.equal(nextState(s, 'operational', 't3').event, null);
});

test('a part that never answered stays unknown, not operational', () => {
  const r = nextState(null, 'unknown', 't0');
  assert.equal(r.state.status, 'unknown');
  assert.equal(nextState(r.state, 'operational', 't1').state.status, 'operational');
});

test('unknown never moves the state', () => {
  const s = { status: 'down', failStreak: 4, okStreak: 0, since: 't0' };
  assert.deepEqual(nextState(s, 'unknown', 't1'), { state: s, event: null });
});

test('degraded shows at once, keeps its since while it lasts', () => {
  const a = nextState({ status: 'operational', failStreak: 0, okStreak: 5, since: 't0' }, 'degraded', 't1');
  assert.equal(a.state.status, 'degraded');
  assert.equal(a.state.since, 't1');
  assert.equal(nextState(a.state, 'degraded', 't2').state.since, 't1');
});

test('a day reads from its counts', () => {
  assert.equal(dayStatus(null), 'nodata');
  assert.equal(dayStatus({ total: 1440, down: 0, degraded: 0 }), 'ok');
  assert.equal(dayStatus({ total: 1440, down: 0, degraded: 3 }), 'degraded');
  assert.equal(dayStatus({ total: 1440, down: 4, degraded: 0 }), 'partial');
  assert.equal(dayStatus({ total: 1440, down: 30, degraded: 0 }), 'major');
});

test('uptime is good minutes over checked minutes, rounded down', () => {
  assert.equal(uptimePct([]), null);
  assert.equal(uptimePct([{ total: 1000, down: 1 }]), 99.9);
  assert.equal(uptimePct([{ total: 3, down: 1 }]), 66.66);
});

test('worst status wins', () => {
  assert.equal(worst(['operational', 'degraded', 'unknown']), 'degraded');
  assert.equal(worst(['operational', 'down', 'degraded']), 'down');
  assert.equal(worst(['operational']), 'operational');
});

test('days are Pacific days', () => {
  // 03:00 UTC on Oct 27 is still Oct 26 in California.
  assert.equal(dayKey(new Date('2026-10-27T03:00:00Z')), '2026-10-26');
  const days = lastDays(90, new Date('2026-10-27T20:00:00Z'));
  assert.equal(days.length, 90);
  assert.equal(days[89], '2026-10-27');
});
