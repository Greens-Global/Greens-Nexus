import { describe, expect, it } from 'vitest';
import { DIM_COLOR, attentionGroups, focusColors, occupancyBuckets, reasonGroup, shortMoney, summaryLine } from './panelModel.js';

const status = (u) => u.s;
const units = [{ n: 'A1', s: 'leased' }, { n: 'A2', s: 'vacant' }, { n: 'A3', s: 'bad' }, { n: 'M1', s: 'leased' }, { n: 'A4', s: 'leased', gone: true }];

describe('site model panel model', () => {
  it('buckets storage units by status (mailboxes and units gone from Cubby apart)', () => {
    expect(occupancyBuckets(units, status).map((b) => [b.key, b.count, b.units])).toEqual([['leased', 1, ['A1']], ['vacant', 1, ['A2']], ['bad', 1, ['A3']]]);
  });
  it('a picked bucket keeps its colors and dims the rest', () => {
    const b = occupancyBuckets(units, status)[1];
    expect(focusColors(units, b, null, status)).toMatchObject({ A1: DIM_COLOR, A2: '#e0b45a', A3: DIM_COLOR });
    expect(focusColors(units, b, { A2: '#123456' }, status).A2).toBe('#123456');
    expect(focusColors(units, null, { A2: '#123456' }, status)).toEqual({ A2: '#123456' });
  });
  it('folds the figures into one line', () => {
    expect(shortMoney(17517350)).toBe('$175k');
    expect(shortMoney(420000)).toBe('$4.2k');
    expect(summaryLine(807, 774, { rentRoll: 17300000, pastDue: 420000 })).toBe('807 Units · 95.9% Leased · $173k Rent Roll · $4.2k Past Due');
    expect(summaryLine(10, 5, null)).toBe('10 Units · 50.0% Leased');
  });
  it('names the reason a unit is out of service', () => {
    expect(reasonGroup('REPAIRS_REQUIRED', 'Door fall')).toBe('Repairs Required');
    expect(reasonGroup('OTHER', '')).toBe('No Reason Given');
    expect(reasonGroup('', '')).toBe('Out of Service');
    expect(reasonGroup('OTHER', 'Business Class Agreement - NOT PHYSICAL UNIT')).toBe('Not Physical (Business Class Agreement)');
    expect(reasonGroup('OTHER', 'Air duct units')).toBe('Air Duct');
    expect(reasonGroup('OTHER', 'Fire hydrant unit')).toBe('Fire Hydrant Unit');
  });
  it('groups Needs Attention, biggest first and the vague groups last', () => {
    const bad = [{ n: 'X1', why: 'OTHER' }, { n: 'X2', why: 'OTHER', note: 'Air duct unit' }, { n: 'X3', why: 'OTHER', note: 'Air duct units' }, { n: 'X4', why: 'REPAIRS_REQUIRED' }];
    expect(attentionGroups(bad).map((g) => [g.label, g.units.length])).toEqual([['Air Duct', 2], ['Repairs Required', 1], ['No Reason Given', 1]]);
  });
});
