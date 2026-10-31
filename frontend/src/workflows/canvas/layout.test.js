// The canvas layout engine (10/30/2026): the shape rules the approved
// mockup pinned - a ghost slot for an empty lane, lanes that rejoin at a
// dot unless every one ends in Stop, a LOOP frame for For Each, an insert
// point on every connector, and a walk order a run replay follows.
import { describe, it, expect } from 'vitest';
import { GHOST_H, JOIN_R, NODE_H, NODE_W, bezierPoint, laneInside, laneOpen, layout, walkOrder } from './layout';
import { emptyDefinition, newStep } from '../lib/definition';

const action = (id) => ({ ...newStep('action', { key: 'notify', params: [] }), id });
const stop = (id) => ({ ...newStep('stop'), id });

function hrExample() {
  const def = emptyDefinition({ kind: 'event', event: 'hr.candidate.hired', filters: [] });
  def.conditions = [[{ field: 'company', op: 'is', value: 'gg' }]];
  const approval = { ...newStep('approval'), id: 'ap' };
  approval.params.options = ['Confirm', 'Change It'];
  approval.branches = { Confirm: [action('a2'), { ...newStep('wait'), id: 'w1' }, action('a3')], 'Change It': [action('a4'), stop('s1')], expired: [] };
  const loop = { ...newStep('for_each'), id: 'fe', steps: [action('a5')] };
  def.steps = [action('a1'), approval, loop, action('a6')];
  def.settings.faultSteps = [action('f1')];
  return def;
}

const byId = (L, id) => L.nodes.find((n) => n.id === id);

describe('layout', () => {
  it('draws an empty workflow as a trigger and a ghost slot with an insert point at the start', () => {
    const L = layout(emptyDefinition());
    expect(byId(L, 'trigger')).toMatchObject({ kind: 'trigger', w: NODE_W, h: NODE_H });
    expect(byId(L, 'gate')).toBeUndefined();
    const ghost = L.nodes.find((n) => n.kind === 'ghost');
    expect(ghost).toMatchObject({ id: 'ghost-steps', h: GHOST_H, path: ['steps'], index: 0 });
    expect(L.hots.some((h) => h.insert.path.join('.') === 'steps' && h.insert.index === 0)).toBe(true);
    // the fault lane is drawn too, with its own ghost
    expect(byId(L, 'fault')).toBeTruthy();
    expect(byId(L, 'ghost-settings.faultSteps')).toBeTruthy();
    expect(L.w).toBeGreaterThan(NODE_W * 2);
  });

  it('lays the HR example out: a gate, one join, one frame, three approval lanes', () => {
    const L = layout(hrExample());
    expect(byId(L, 'gate')).toBeTruthy();
    expect(L.nodes.filter((n) => n.kind === 'join').map((n) => n.id)).toEqual(['join-ap']);
    expect(L.frames.map((f) => f.id)).toEqual(['frame-fe']);
    const laneEdges = L.edges.filter((e) => e.from === 'ap');
    expect(laneEdges.map((e) => e.label)).toEqual(['Confirm', 'Change It', 'No Answer']);
    // the Change It lane ends in Stop: nothing from it reaches the join
    expect(L.edges.some((e) => e.from === 's1')).toBe(false);
    // the Confirm lane's last step and the empty No Answer lane's ghost both do
    expect(L.edges.filter((e) => e.to === 'join-ap').map((e) => e.from).sort()).toEqual(['a3', 'ghost-steps.1.branches.expired']);
    // the step after the approval hangs off the join
    expect(L.edges.some((e) => e.from === 'join-ap' && e.to === 'fe')).toBe(true);
    // the loop: node -> inner lane -> frame bottom -> next step
    expect(L.edges.some((e) => e.from === 'fe' && e.to === 'a5' && e.label === 'each')).toBe(true);
    expect(L.edges.some((e) => e.from === 'a5' && e.to === 'frame-fe')).toBe(true);
    expect(L.edges.some((e) => e.from === 'frame-fe' && e.to === 'a6')).toBe(true);
    // every step node knows its lane and index
    expect(byId(L, 'a4')).toMatchObject({ path: ['steps', 1, 'branches', 'Change It'], index: 0 });
    expect(byId(L, 's1')).toMatchObject({ w: 160 });
    // the root tail carries the append point
    expect(L.hots.some((h) => h.insert.path.join('.') === 'steps' && h.insert.index === 4)).toBe(true);
    // everything is on the sheet
    L.nodes.forEach((n) => { expect(n.x).toBeGreaterThanOrEqual(0); expect(n.y).toBeGreaterThanOrEqual(0); });
    expect(byId(L, 'join-ap').w).toBe(2 * JOIN_R);
  });

  it('gives a branch whose lanes all end in Stop no join, and draws what follows with no connector in', () => {
    const def = emptyDefinition();
    const iff = { ...newStep('if'), id: 'if1', then: [stop('s1')], else: [stop('s2')] };
    def.steps = [iff, action('after')];
    const L = layout(def);
    expect(L.nodes.some((n) => n.kind === 'join')).toBe(false);
    expect(byId(L, 'after')).toBeTruthy();
    expect(L.edges.some((e) => e.to === 'after')).toBe(false);
    expect(L.edges.filter((e) => e.from === 'if1').map((e) => e.label)).toEqual(['Yes', 'No']);
    expect(laneOpen(def, def.steps, ['steps'])).toBe(true); // the unreachable action keeps the lane open
    expect(laneOpen(def, [iff], ['steps'])).toBe(false);
  });

  it('knows which lanes sit inside a step', () => {
    const def = hrExample();
    expect(laneInside(def, ['steps', 1, 'branches', 'Confirm'], 'ap')).toBe(true);
    expect(laneInside(def, ['steps', 1, 'branches', 'Confirm'], 'a1')).toBe(false);
    expect(laneInside(def, ['steps', 2, 'steps'], 'fe')).toBe(true);
    expect(laneInside(def, ['steps'], 'ap')).toBe(false);
    expect(laneInside(def, ['settings', 'faultSteps'], 'ap')).toBe(false);
  });

  it('walks the order a run follows: first lane by default, a chosen lane on request, Stop ends it, skipped steps are left out', () => {
    const def = hrExample();
    expect(walkOrder(def)).toEqual(['trigger', 'gate', 'a1', 'ap', 'a2', 'w1', 'a3', 'join-ap', 'fe', 'a5', 'frame-fe', 'a6']);
    expect(walkOrder(def, (s) => (s.id === 'ap' ? 1 : 0))).toEqual(['trigger', 'gate', 'a1', 'ap', 'a4', 's1']);
    def.steps[0].enabled = false;
    expect(walkOrder(def)[2]).toBe('ap');
  });

  it('does not touch the definition it lays out', () => {
    const def = hrExample();
    const json = JSON.stringify(def);
    layout(def); walkOrder(def);
    expect(JSON.stringify(def)).toBe(json);
  });

  it('puts the midpoint of a connector half way between its ends', () => {
    expect(bezierPoint({ x: 0, y: 0 }, { x: 100, y: 200 }, 0.5)).toEqual({ x: 50, y: 100 });
    expect(bezierPoint({ x: 0, y: 0 }, { x: 100, y: 200 }, 0)).toEqual({ x: 0, y: 0 });
  });
});
