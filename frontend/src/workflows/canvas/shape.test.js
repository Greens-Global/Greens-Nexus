// The silhouette grammar (10/30/2026): mirrors backend/workflows/shape.py,
// and a shape turned back into a definition lays out with the same node
// kinds in the same order as the workflow it came from.
import { describe, it, expect } from 'vitest';
import { definitionFromShape, shapeOf } from './shape';
import { layout } from './layout';
import { emptyDefinition, newStep } from '../lib/definition';

const action = (id) => ({ ...newStep('action', { key: 'notify', params: [] }), id });
const stop = (id) => ({ ...newStep('stop'), id });

function example() {
  const def = emptyDefinition({ kind: 'event', event: 'x', filters: [] });
  const ap = { ...newStep('approval'), id: 'ap' };
  ap.params.options = ['Confirm', 'Change It'];
  ap.branches = { Confirm: [action('a2'), { ...newStep('wait'), id: 'w1' }], 'Change It': [action('a4'), stop('s1')], expired: [] };
  def.steps = [action('a1'), ap, { ...newStep('for_each'), id: 'fe', steps: [action('a5')] }, { ...newStep('if'), id: 'if1', then: [action('t1')], else: [] }];
  def.settings.faultSteps = [action('f1')];
  return def;
}

const kindsOf = (def) => layout(def).nodes.filter((n) => n.step && n.path[0] === 'steps').map((n) => n.kind);

describe('shape', () => {
  it('writes the grammar the backend writes', () => {
    expect(shapeOf(example())).toEqual([
      ['action'],
      ['approval', [[['action'], ['wait']], [['action'], ['stop']], []]],
      ['for_each', [[['action']]]],
      ['if', [[['action']], []]],
    ]);
    expect(shapeOf({ steps: [{ kind: 'approval', branches: { Decline: [{ kind: 'stop' }] } }] })).toEqual([['approval', [[], [['stop']], []]]]);
    expect(shapeOf(null)).toEqual([]);
    expect(shapeOf({ steps: [{ kind: 'weird' }, null] })).toEqual([['action']]);
  });

  it('round-trips through the layout engine with the same kinds in the same order', () => {
    const def = example();
    const back = definitionFromShape(shapeOf(def));
    expect(kindsOf(back)).toEqual(kindsOf(def));
    expect(shapeOf(back)).toEqual(shapeOf(def));
    // the approval fans into three lanes either way
    expect(layout(back).edges.filter((e) => e.from === 's1').length).toBe(3);
    // the fault lane is not part of a shape
    expect(back.settings.faultSteps).toEqual([]);
  });

  it('draws an empty shape as a trigger and a drop slot', () => {
    const L = layout(definitionFromShape([]));
    expect(L.nodes.some((n) => n.kind === 'trigger')).toBe(true);
    expect(L.nodes.some((n) => n.id === 'ghost-steps')).toBe(true);
    expect(layout(definitionFromShape(undefined)).nodes.length).toBeGreaterThan(0);
  });
});
