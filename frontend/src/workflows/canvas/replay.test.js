// replayPlan (10/30/2026): the lane an approval took comes from the run,
// unknown steps are dropped, a stopped run is cut where it stopped, and a
// run from another version says so.
import { describe, it, expect } from 'vitest';
import { replayPlan, stepIdOf } from './replay';
import { emptyDefinition, newStep } from '../lib/definition';

const action = (id) => ({ ...newStep('action', { key: 'notify', params: [] }), id });
const stop = (id) => ({ ...newStep('stop'), id });

function def() {
  const d = emptyDefinition({ kind: 'event', event: 'x', filters: [] });
  d.conditions = [[{ field: 'status', op: 'is', value: 'active' }]];
  const ap = { ...newStep('approval'), id: 'ap' };
  ap.branches = { Approve: [action('a2')], Decline: [action('a4'), stop('s1')], expired: [] };
  d.steps = [action('a1'), ap, action('a6')];
  return d;
}
const step = (stepId, status, output) => ({ stepId, status, output: output || {} });

describe('replayPlan', () => {
  it('follows the lane the approval decided and keeps the join behind the last step', () => {
    const run = { steps: [step('a1', 'done'), step('ap', 'done', { outcome: 'Decline' }), step('a4', 'done'), step('s1', 'done')], conditionsPassed: true };
    const p = replayPlan(def(), run);
    expect(p.order).toEqual(['trigger', 'gate', 'a1', 'ap', 'a4', 's1']);
    expect(p.statusById).toEqual({ trigger: 'done', gate: 'done', a1: 'done', ap: 'done', a4: 'done', s1: 'done' });
    expect(p.note).toBe('');
  });

  it('takes the first lane when the approval has not been answered and stops there, waiting', () => {
    const run = { steps: [step('a1', 'done'), step('ap', 'waiting')] };
    const p = replayPlan(def(), run);
    expect(p.order).toEqual(['trigger', 'gate', 'a1', 'ap']);
    expect(p.statusById.ap).toBe('waiting');
    expect(p.statusById.a2).toBeUndefined();
  });

  it('runs the whole flow when every step finished, join and all', () => {
    const run = { steps: [step('a1', 'done'), step('ap', 'done', { outcome: 'Approve' }), step('a2', 'done'), step('a6', 'succeeded')] };
    const p = replayPlan(def(), run);
    expect(p.order).toEqual(['trigger', 'gate', 'a1', 'ap', 'a2', 'join-ap', 'a6']);
    expect(p.statusById['join-ap']).toBe('done');
    expect(p.statusById.a6).toBe('done');
  });

  it('marks a failed step and cuts after it', () => {
    const run = { steps: [step('a1', 'failed')] };
    const p = replayPlan(def(), run);
    expect(p.order).toEqual(['trigger', 'gate', 'a1']);
    expect(p.statusById.a1).toBe('failed');
  });

  it('drops steps the draft no longer has and names the version that ran', () => {
    const run = { version: 3, steps: [step('gone', 'done'), step('a1', 'planned')] };
    const p = replayPlan(def(), run, 5);
    expect(p.order).toEqual(['trigger', 'gate', 'a1']);
    expect(p.statusById.gone).toBeUndefined();
    expect(p.statusById.a1).toBe('done');
    expect(p.note).toBe('This run used version 3');
    expect(replayPlan(def(), { version: 5, steps: [] }, 5).note).toBe('');
  });

  it('shows only the trigger and a skipped gate when the conditions stopped the run', () => {
    const p = replayPlan(def(), { steps: [], conditionsPassed: false });
    expect(p.order).toEqual(['trigger', 'gate']);
    expect(p.statusById).toEqual({ trigger: 'done', gate: 'skipped' });
    const noGate = emptyDefinition(); noGate.steps = [action('a1')];
    expect(replayPlan(noGate, { steps: [] }).order).toEqual(['trigger']);
  });

  it('survives a missing run', () => {
    expect(replayPlan(def(), null).order).toEqual(['trigger', 'gate']);
  });

  it('matches the engine\'s path-prefixed rows to the draft\'s steps, the worst status winning over a loop\'s items', () => {
    const d = emptyDefinition();
    const loop = { ...newStep('for_each'), id: 'fe', steps: [action('a5')] };
    const ap = { ...newStep('approval'), id: 'ap' };
    ap.branches = { Approve: [action('a2')], Decline: [action('a4'), stop('s1')], expired: [] };
    d.steps = [action('a1'), ap, loop, action('a6')];
    d.settings.faultSteps = [action('f1')];
    const run = { steps: [
      step('a1', 'done'), step('ap', 'done', { outcome: 'Decline' }), step('ap/Decline/a4', 'done'), step('ap/Decline/s1', 'done'),
    ] };
    expect(replayPlan(d, run).order).toEqual(['trigger', 'a1', 'ap', 'a4', 's1']);
    const looped = { steps: [
      step('a1', 'done'), step('ap', 'done', { outcome: 'Approve' }), step('ap/Approve/a2', 'done'),
      step('fe', 'done'), step('fe#0/a5', 'done'), step('fe#1/a5', 'failed'), step('fe#2/a5', 'done'), step('fault/f1', 'done'),
    ] };
    const p = replayPlan(d, looped);
    expect(p.order).toEqual(['trigger', 'a1', 'ap', 'a2', 'join-ap', 'fe', 'a5', 'frame-fe']);
    expect(p.statusById.a5).toBe('failed');
    expect(p.statusById.a2).toBe('done');
    expect(stepIdOf('fe#12/a5')).toBe('a5');
    expect(stepIdOf('fe#1')).toBe('fe');
    expect(stepIdOf('a1')).toBe('a1');
  });

  it('follows the Else lane when the If says so', () => {
    const d = emptyDefinition();
    const iff = { ...newStep('if'), id: 'if1', then: [action('t1')], else: [action('e1')] };
    d.steps = [iff, action('z')];
    const run = { steps: [step('if1', 'done', { branch: 'else' }), step('if1/e1', 'done'), step('z', 'done')] };
    const p = replayPlan(d, run);
    expect(p.order).toEqual(['trigger', 'if1', 'e1', 'join-if1', 'z']);
    expect(p.statusById.t1).toBeUndefined();
    expect(p.statusById.e1).toBe('done');
    // a plan-only If that recorded Then
    expect(replayPlan(d, { steps: [step('if1', 'planned', { branch: 'then' }), step('if1/t1', 'planned')] }).order).toEqual(['trigger', 'if1', 't1', 'join-if1']);
  });
});
