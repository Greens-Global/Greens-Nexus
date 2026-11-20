import { describe, it, expect } from 'vitest';
import { addDatePatch, missingByKind } from './datesModel.js';

// Dates > Missing fills in place (Neil, 11/20/2026): the patch a picked day becomes.
describe('addDatePatch', () => {
  it('puts the day on the kind\'s own key, in the format the dates on file read', () => {
    expect(addDatePatch('insurance', '2027-03-01')).toEqual({ patch: { insExpiration: '03/01/2027' }, changes: [{ field: 'Policy Expiration', from: '', to: '03/01/2027' }] });
    expect(addDatePatch('tax', '2026-12-10')).toEqual({ patch: { taxDue: '12/10/2026' }, changes: [{ field: 'Due Dates', from: '', to: '12/10/2026' }] });
    expect(addDatePatch('registration', '2027-06-30').patch).toEqual({ regExpiration: '06/30/2027' });
  });
  it('refuses a kind that is not filled here and a day that is not one', () => {
    expect(addDatePatch('loan', '2027-03-01')).toBeNull();        // loan maturity comes from the books
    expect(addDatePatch('insurance', '')).toBeNull();
    expect(addDatePatch('insurance', '03/01/2027')).toBeNull();
    expect(addDatePatch('insurance', '2027-02-30')).toBeNull();
    expect(addDatePatch('insurance', '2027-13-01')).toBeNull();
  });
  it('what it writes is a date the Missing view then counts as on file', () => {
    const asset = { id: 'a', kind: 'property', name: 'Oak Street' };
    expect(missingByKind([asset]).map((m) => m.kind)).toEqual(['tax', 'insurance']);
    const filled = { ...asset, ...addDatePatch('insurance', '2027-03-01').patch, ...addDatePatch('tax', '2026-12-10').patch };
    expect(missingByKind([filled])).toEqual([]);
  });
});
