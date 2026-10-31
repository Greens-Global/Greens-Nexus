// replayPlan (10/30/2026): the lane an approval took comes from the run,
// unknown steps are dropped, a stopped run is cut where it stopped, and a
// run from another version says so.
import { describe, it, expect } from 'vitest';
import { replayPlan } from './replay';
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
});
