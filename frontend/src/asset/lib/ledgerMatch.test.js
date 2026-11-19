import { describe, it, expect } from 'vitest';
import { ownerKey, suggestEntity, ownerGroups, unlinkedProperties } from './ledgerMatch.js';

// The books as they come from GET /accounting/reports/locations: a company at several levels
// (the parent over its own "(G)" child), historical (H) copies, address-named sub-entities.
const LEDGER = [
  { code: '63000', name: 'Harbor Heritage, LLC.', parent_code: null },
  { code: '63001', name: '(G) Harbor Heritage, LLC.', parent_code: '63000' },
  { code: 'H63001', name: '(H) (G) Harbor Heritage, LLC.', parent_code: '63000' },
  { code: '61000', name: 'Harbor Family Limited Partnership', parent_code: null },
  { code: '62000', name: 'Marsh Family Limited Partnership', parent_code: null },
  { code: '18000', name: 'Harbor Investments, LLC.', parent_code: null },
  { code: '78000', name: 'Northgate Inv1, LLC.', parent_code: null },
  { code: '79000', name: 'Northgate Inv2, LLC.', parent_code: null },
  { code: '30000', name: 'Sam & Rita Vale', parent_code: null },
  { code: '30001', name: '(G) Sam & Rita Vale', parent_code: '30000' },
  { code: '64001-2', name: '47385 Canyon Rd, Temecula', parent_code: '64001' },
  { code: '57004', name: 'Harbor Murrieta', parent_code: '57000', is_active: false },
  { code: '70000', name: 'Northgate Capital Holdings, LLC.', parent_code: null },
];

describe('ownerKey', () => {
  it('drops the company words, the punctuation and the books\' tags', () => {
    expect(ownerKey('(G) Harbor Heritage, LLC.')).toBe('harbor heritage');
    expect(ownerKey('Harbor Heritage LLC ')).toBe('harbor heritage');
    expect(ownerKey('Harbor Heritage LL')).toBe('harbor heritage');       // a cut-off "LLC"
    expect(ownerKey('Harbor Family LP')).toBe(ownerKey('Harbor Family Limited Partnership'));
    expect(ownerKey('Northgate Investment 1 LLC')).toBe(ownerKey('Northgate Inv1, LLC.'));
    expect(ownerKey('Sam & Rita Vale')).toBe('sam rita vale');
    expect(ownerKey('  ')).toBe('');
  });
});

describe('suggestEntity', () => {
  it('finds the company itself, the parent over its same-named child, never a historical copy', () => {
    expect(suggestEntity('Harbor Heritage LLC', LEDGER)).toEqual({ code: '63000', name: 'Harbor Heritage, LLC.', match: 'exact' });
    expect(suggestEntity('Harbor Heritage LL', LEDGER).code).toBe('63000');
    expect(suggestEntity('Sam & Rita Vale', LEDGER).code).toBe('30000');
  });
  it('tells two families and two numbered companies apart', () => {
    expect(suggestEntity('Harbor Family LP', LEDGER).code).toBe('61000');
    expect(suggestEntity('Marsh Family Limited Partnership', LEDGER).code).toBe('62000');
    expect(suggestEntity('Northgate Investment 1 LLC', LEDGER).code).toBe('78000');
    expect(suggestEntity('Northgate Inv2, LLC.', LEDGER).code).toBe('79000');
    expect(suggestEntity('Harbor Investment LLC', LEDGER).code).toBe('18000');
  });
  it('offers a close match only when one entity fits, and says so', () => {
    expect(suggestEntity('Northgate Capital', LEDGER)).toEqual({ code: '70000', name: 'Northgate Capital Holdings, LLC.', match: 'close' });
    // One word is never enough to guess from.
    expect(suggestEntity('Harbor', LEDGER).match).toBe('none');
  });
  it('offers nothing for a name the books do not hold, an inactive entity or a blank', () => {
    expect(suggestEntity('Vale Family Trust', LEDGER).match).toBe('none');
    expect(suggestEntity('Harbor Murrieta', LEDGER).match).toBe('none');
    expect(suggestEntity('', LEDGER).match).toBe('none');
    expect(suggestEntity('Harbor Heritage LLC', []).match).toBe('none');
  });
  it('says "several" when two entities fit equally, and picks neither', () => {
    const twice = [...LEDGER, { code: '99000', name: 'Harbor Heritage, Inc.', parent_code: null }];
    expect(suggestEntity('Harbor Heritage LLC', twice)).toEqual({ code: '', name: '', match: 'several' });
  });
});

describe('ownerGroups', () => {
  const ASSETS = [
    { id: 'a', kind: 'property', name: 'Lot 1', entity: 'Harbor Heritage LLC' },
    { id: 'b', kind: 'property', name: 'Lot 2', entity: 'Harbor Heritage LL', parentId: 'a' },
    { id: 'c', kind: 'property', name: 'Lot 3', entity: 'Harbor Heritage LLC ' },
    { id: 'd', kind: 'property', name: 'Canyon Store', entity: 'Harbor Family LP' },
    { id: 'e', kind: 'property', name: 'Open Field', entity: '' },
    { id: 'f', kind: 'property', name: 'Linked Already', entity: 'Harbor Heritage LLC', entityCode: '63000' },
    { id: 'g', kind: 'property', name: 'In the Trash', entity: 'Harbor Heritage LLC', deleted: true },
    { id: 'h', kind: 'vehicle', name: 'Truck 4', entity: 'Harbor Heritage LLC' },
  ];
  it('asks once per owner, whatever the spelling, most properties first', () => {
    const { groups, untyped } = ownerGroups(ASSETS, LEDGER);
    expect(groups.map((g) => [g.label, g.assets.map((p) => p.id), g.suggestion.code])).toEqual([
      ['Harbor Heritage LLC', ['a', 'b', 'c'], '63000'],
      ['Harbor Family LP', ['d'], '61000'],
    ]);
    expect(untyped.map((p) => p.id)).toEqual(['e']);
  });
  it('leaves out what is linked, in the Trash or not a property', () => {
    expect(unlinkedProperties(ASSETS).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
