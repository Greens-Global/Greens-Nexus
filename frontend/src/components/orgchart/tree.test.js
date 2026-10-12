import { describe, it, expect } from 'vitest';
import { initialCollapsed, allBranchKeys, countBelow, divisionColor, clampZoom, DIVISION_PALETTE } from './tree';

// A tiny tree in the Contact Directory's node shape: {person, children}.
const n = (email, children = []) => ({ person: { email }, children });
const kids = (x) => x.children;
const key = (x) => x.person.email;
const ceo = n('ceo', [n('vp1', [n('m1', [n('e1'), n('e2')]), n('m2', [n('e3')])]), n('vp2', [n('e4')])]);

describe('org chart tree helpers', () => {
  it('starts with roots and their direct reports open, deeper teams folded', () => {
    expect([...initialCollapsed([ceo], kids, key)].sort()).toEqual(['m1', 'm2', 'vp1', 'vp2']);
  });
  it('lists every branch for collapse all and counts everyone below a node', () => {
    expect([...allBranchKeys([ceo], kids, key)].sort()).toEqual(['ceo', 'm1', 'm2', 'vp1', 'vp2']);
    expect(countBelow(ceo, kids)).toBe(8);
    expect(countBelow(ceo.children[1], kids)).toBe(1);
    expect(countBelow(n('solo'), kids)).toBe(0);
  });
  it('gives a division a stable color from its position in the sorted names', () => {
    const names = ['Finance', 'Operations'];
    expect(divisionColor('Finance', names)).toBe(DIVISION_PALETTE[0]);
    expect(divisionColor('Operations', names)).toBe(DIVISION_PALETTE[1]);
    expect(divisionColor('', names)).toBe('');
  });
  it('keeps zoom inside the canvas limits', () => {
    expect(clampZoom(0.1)).toBe(0.3);
    expect(clampZoom(9)).toBe(1.6);
    expect(clampZoom(1.23456)).toBe(1.235);
  });
});
