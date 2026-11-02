import { describe, it, expect } from 'vitest';
import { canMove, insertKind, moveBetween } from './edits';
import { emptyDefinition, getLane, newStep } from '../lib/definition';

const action = (id) => ({ ...newStep('action', { key: 'notify', params: [] }), id });

function def() {
  const d = emptyDefinition();
  const iff = { ...newStep('if'), id: 'if1', then: [action('t1')], else: [] };
  d.steps = [action('a0'), iff, action('a2')];
  return d;
}

describe('canvas edits', () => {
  it('inserts a new block at an insert point without touching the old definition', () => {
    const d = def(); const json = JSON.stringify(d);
    const next = insertKind(d, 'wait', { path: ['steps'], index: 1 });
    expect(next.steps.map((s) => s.kind)).toEqual(['action', 'wait', 'if', 'action']);
    expect(JSON.stringify(d)).toBe(json);
    const empty = insertKind(d, 'action', { path: ['steps', 1, 'else'], index: 0 });
    expect(getLane(empty, ['steps', 1, 'else'])[0]).toMatchObject({ kind: 'action', action: '' });
  });

  it('moves a step down its own lane, adjusting for the removal', () => {
    const next = moveBetween(def(), { path: ['steps'], index: 0 }, { path: ['steps'], index: 3 });
    expect(next.steps.map((s) => s.id)).toEqual(['if1', 'a2', 'a0']);
  });

  it('moves a step into a nested lane whose path passes the removed slot', () => {
    // a0 leaves the root lane, so the If slides from index 1 to 0: the drop path follows it
    const next = moveBetween(def(), { path: ['steps'], index: 0 }, { path: ['steps', 1, 'else'], index: 0 });
    expect(next.steps.map((s) => s.id)).toEqual(['if1', 'a2']);
    expect(getLane(next, ['steps', 0, 'else']).map((s) => s.id)).toEqual(['a0']);
  });

  it('moves a step out of a nested lane to the root', () => {
    const next = moveBetween(def(), { path: ['steps', 1, 'then'], index: 0 }, { path: ['steps'], index: 3 });
    expect(next.steps.map((s) => s.id)).toEqual(['a0', 'if1', 'a2', 't1']);
    expect(getLane(next, ['steps', 1, 'then'])).toEqual([]);
  });

  it('refuses a drop into the step\'s own lanes and onto its own slot', () => {
    const d = def();
    expect(canMove(d, { path: ['steps'], index: 1 }, { path: ['steps', 1, 'then'], index: 1 })).toBe(false);
    expect(canMove(d, { path: ['steps'], index: 1 }, { path: ['steps'], index: 1 })).toBe(false);
    expect(canMove(d, { path: ['steps'], index: 1 }, { path: ['steps'], index: 2 })).toBe(false);
    expect(canMove(d, { path: ['steps'], index: 1 }, { path: ['steps'], index: 0 })).toBe(true);
    expect(moveBetween(d, { path: ['steps'], index: 1 }, { path: ['steps', 1, 'then'], index: 1 })).toBe(d);
  });
});
