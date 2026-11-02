import { describe, it, expect } from 'vitest';
import { isVisible, visibleAnswers, validateAnswers, computeFormulas, isEmptyAnswer, formsForShift, groupDefs } from './formRules';

// The client half of the form rules (Forms & Checklists, Neil 11/02/2026):
// a showIf field that is hidden is neither required nor sent, a repeat group
// is a list of answer maps, a formula is worked out from the other answers,
// and a shift card offers a form only for its own site.

const DEFS = [
  { token: 'plate', label: 'Plate', type: 'text', required: true, section: 'Vehicle' },
  { token: 'damage', label: 'Any Damage?', type: 'yesno', required: true, section: 'Damage' },
  { token: 'damage_detail', label: 'Describe the Damage', type: 'multiline', required: true, section: 'Damage',
    showIf: { token: 'damage', op: 'eq', value: true } },
  { token: 'photos', label: 'Photos', type: 'photo', required: true, section: 'Damage',
    showIf: { token: 'damage', op: 'eq', value: true } },
  { token: 'tire', label: 'Tire', type: 'text', required: true, section: 'Tires', repeat: { group: 'tires', max: 4 } },
  { token: 'psi', label: 'PSI', type: 'number', section: 'Tires', repeat: { group: 'tires', max: 4 } },
  { token: 'total_psi', label: 'Total PSI', type: 'number', formula: '{Miles} * 2', section: 'Tires' },
  { token: 'miles', label: 'Miles', type: 'number', section: 'Tires' },
];

describe('isVisible', () => {
  it('shows a field with no showIf, and follows eq / ne / any / empty / notEmpty', () => {
    expect(isVisible(DEFS[0], {})).toBe(true);
    expect(isVisible(DEFS[2], { damage: true })).toBe(true);
    expect(isVisible(DEFS[2], { damage: false })).toBe(false);
    expect(isVisible({ showIf: { token: 'kind', op: 'ne', value: 'Car' } }, { kind: 'Truck' })).toBe(true);
    expect(isVisible({ showIf: { token: 'kind', op: 'ne', value: 'Car' } }, { kind: 'Car' })).toBe(false);
    expect(isVisible({ showIf: { token: 'kind', op: 'any', value: ['Car', 'Van'] } }, { kind: 'Van' })).toBe(true);
    expect(isVisible({ showIf: { token: 'kind', op: 'any', value: ['Car', 'Van'] } }, { kind: 'Bus' })).toBe(false);
    expect(isVisible({ showIf: { token: 'note', op: 'empty' } }, { note: '' })).toBe(true);
    expect(isVisible({ showIf: { token: 'note', op: 'notEmpty' } }, { note: 'x' })).toBe(true);
    expect(isVisible({ showIf: { token: 'note', op: 'notEmpty' } }, {})).toBe(false);
  });
  it('reads a yes/no answer written as a string the same way', () => {
    expect(isVisible(DEFS[2], { damage: 'true' })).toBe(true);
  });
});

describe('visibleAnswers', () => {
  it('drops a hidden token even when it holds a stale value, and tokens the form never defined', () => {
    const out = visibleAnswers(DEFS, { plate: 'ABC', damage: false, damage_detail: 'scratch', junk: 1, miles: '3' });
    expect(out).toEqual({ plate: 'ABC', damage: false, miles: '3', total_psi: 6, tires: [] });
  });
  it('keeps a repeat group as a list of maps in order, hidden tokens dropped per row and empty rows gone', () => {
    const out = visibleAnswers(DEFS, { plate: 'A', damage: false, tires: [{ tire: 'FL', psi: '32' }, { tire: '', psi: '' }, { tire: 'RR', psi: '30' }] });
    expect(out.tires).toEqual([{ tire: 'FL', psi: '32' }, { tire: 'RR', psi: '30' }]);
  });
});

describe('validateAnswers', () => {
  it('requires a visible required field and ignores a hidden one', () => {
    // (the sample's tire field is required, so its empty group is refused too)
    expect(validateAnswers(DEFS, { plate: '', damage: false, tires: [{ tire: 'FL' }] })).toEqual({ plate: 'This field is required' });
    const errs = validateAnswers(DEFS, { plate: 'A', damage: true, damage_detail: '', photos: [] });
    expect(errs.damage_detail).toBe('This field is required');
    expect(errs.photos).toBe('This field is required');
  });
  it('a yes/no with no answer, a rating of 0 and an empty photo list are empty', () => {
    expect(isEmptyAnswer({ type: 'yesno' }, null)).toBe(true);
    expect(isEmptyAnswer({ type: 'yesno' }, false)).toBe(false);
    expect(isEmptyAnswer({ type: 'rating' }, 0)).toBe(true);
    expect(isEmptyAnswer({ type: 'rating' }, 3)).toBe(false);
    expect(isEmptyAnswer({ type: 'photo' }, [])).toBe(true);
    expect(isEmptyAnswer({ type: 'gps' }, null)).toBe(true);
    expect(isEmptyAnswer({ type: 'gps' }, { lat: 1, lng: 2 })).toBe(false);
  });
  it('a required repeat group with zero rows refuses; a row is checked field by field', () => {
    expect(validateAnswers(DEFS, { plate: 'A', damage: false, tires: [] }).tires).toMatch(/at least one/i);
    const errs = validateAnswers(DEFS, { plate: 'A', damage: false, tires: [{ tire: '', psi: '12' }] });
    expect(errs['tires.0.tire']).toBe('This field is required');
  });
  it('checks formats through the shared field validator', () => {
    const defs = [{ token: 'mail', label: 'Mail', type: 'email' }];
    expect(validateAnswers(defs, { mail: 'nope' }).mail).toMatch(/valid email/);
    expect(validateAnswers(defs, { mail: 'a@b.co' })).toEqual({});
  });
});

describe('computeFormulas', () => {
  it('works a formula out from the other answers by label or token', () => {
    expect(computeFormulas(DEFS, { miles: '21' }).total_psi).toBe(42);
    expect(computeFormulas([{ token: 't', formula: '{miles} + 1' }, DEFS[7]], { miles: 2 }).t).toBe(3);
  });
  it('a formula with a blank input follows the Tasks engine (blank counts as zero) and never throws', () => {
    expect(() => computeFormulas(DEFS, {})).not.toThrow();
    expect(computeFormulas(DEFS, {}).total_psi).toBe(0);
    expect(computeFormulas([{ token: 'bad', formula: '{nope} + 1' }], {}).bad).toBe(null);
  });
});

describe('groupDefs', () => {
  it('orders sections by first appearance with repeat groups as one block', () => {
    const groups = groupDefs(DEFS);
    expect(groups.map((g) => g.section)).toEqual(['Vehicle', 'Damage', 'Tires']);
    const tires = groups[2].items;
    expect(tires[0]).toMatchObject({ repeat: 'tires' });
    expect(tires[0].defs.map((d) => d.token)).toEqual(['tire', 'psi']);
    expect(tires[1].def.token).toBe('total_psi');
  });
});

describe('formsForShift', () => {
  const forms = [
    { id: 'f1', title: 'Vehicle Check', showOnShifts: true, workSiteId: '' },
    { id: 'f2', title: 'Opening Checklist', showOnShifts: true, workSiteId: 'siteA' },
    { id: 'f3', title: 'Closing Checklist', showOnShifts: true, workSiteId: 'siteB' },
    { id: 'f4', title: 'Incident Report', showOnShifts: false, workSiteId: '' },
  ];
  const teams = [{ id: 'g', name: 'Store', workSiteId: 'siteA' }];
  it('offers the company-wide ones and the ones for the shift team site only', () => {
    expect(formsForShift(forms, { id: 's', groupId: 'g' }, teams).map((f) => f.id)).toEqual(['f1', 'f2']);
  });
  it('reads a site straight off the shift when it carries one', () => {
    expect(formsForShift(forms, { id: 's', workSiteId: 'siteB' }, teams).map((f) => f.id)).toEqual(['f1', 'f3']);
  });
  it('a shift with no known site gets only the company-wide ones', () => {
    expect(formsForShift(forms, { id: 's' }, []).map((f) => f.id)).toEqual(['f1']);
  });
});
