import { describe, it, expect, afterAll } from 'vitest';
import { vi } from 'vitest';
import { collectCriticalDates, parseStoredDate, isSuspectDate } from './criticalItems.js';
import {
  collectDates, itemsForMode, groupDates, missingByKind, rollYear, rollPatch, datesSummary, bucketOf, relativeDays,
} from './datesModel.js';

// Today is fixed: 11/17/2026 - set when the file loads, not in beforeAll: the describe blocks
// build their dates while they are collected, before any beforeAll runs (11/18/2026: built on
// the real clock, 12/10 read "In 22 days").
vi.useFakeTimers();
vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 0));
afterAll(() => { vi.useRealTimers(); });

const P = (id, extra = {}) => ({ id, kind: 'property', name: `Property ${id}`, ...extra });
const store = (properties, more = {}) => ({ properties, warranties: [], inspections: [], vendors: [], ahj: [], maintenance: [], vservice: [], odometer: [], ...more });

describe('criticalItems - both date formats and date sanity', () => {
  it('reads MM/DD/YYYY and YYYY-MM-DD', () => {
    expect(parseStoredDate('12/10/2026')).toMatchObject({ y: 2026, m: 12, d: 10, format: 'us', suspect: false });
    expect(parseStoredDate('2026-08-04')).toMatchObject({ y: 2026, m: 8, d: 4, format: 'iso', suspect: false });
    expect(parseStoredDate('1/5/2027')).toMatchObject({ m: 1, d: 5, format: 'us' });
    expect(parseStoredDate('N/A')).toBeNull();
    expect(parseStoredDate('')).toBeNull();
  });

  it('flags implausible dates as suspect', () => {
    expect(isSuspectDate('12/32/3232')).toBe(true);
    expect(isSuspectDate('12/12/1212')).toBe(true);
    expect(isSuspectDate('02/30/2026')).toBe(true);
    expect(isSuspectDate('13/01/2026')).toBe(true);
    expect(isSuspectDate('02/29/2028')).toBe(false);
    expect(isSuspectDate('2026-12-10')).toBe(false);
  });

  it('never counts a suspect date as overdue or due', () => {
    const rows = collectCriticalDates(store([P('a', { taxDue: '12/12/1212' }), P('b', { taxDue: '12/32/3232' }), P('c', { taxDue: '11/01/2026' })]));
    const bad = rows.filter((x) => x.suspect);
    expect(bad.map((x) => x.id).sort()).toEqual(['a', 'b']);
    bad.forEach((x) => { expect(x.days < 0).toBe(false); expect(x.days <= 90).toBe(false); expect(x.days >= 0).toBe(false); });
    expect(rows.filter((x) => x.days < 0).map((x) => x.id)).toEqual(['c']);
    expect(rows[rows.length - 1].suspect).toBe(true);   // suspect last
  });

  it('splits tax installments and reads registration and permit expirations', () => {
    const rows = collectCriticalDates(store([
      P('a', { taxDue: '11/01/2026, 02/01/2027', permits: [{ 'Permit / Approval Type': 'Grading', 'Permit Expiration Date': '2027-01-15' }] }),
      { id: 'v', kind: 'vehicle', name: 'Truck', regExpiration: '2026-12-14' },
    ]));
    const tax = rows.filter((x) => x.kind === 'tax');
    expect(tax.map((x) => [x.date, x.part])).toEqual([['11/01/2026', 0], ['02/01/2027', 1]]);
    expect(rows.find((x) => x.kind === 'registration')).toMatchObject({ field: 'regExpiration', yearly: true, days: 27 });
    expect(rows.find((x) => x.kind === 'permit')).toMatchObject({ detail: 'Grading', cat: 'Permit' });
  });
});

describe('datesModel', () => {
  const props = [
    P('a', { taxDue: '12/10/2026', insExpiration: '2026-08-04' }),
    P('b', { taxDue: '12/10/2026' }),
    P('c', { taxDue: '12/32/3232' }),
    P('d', { taxDue: '01/31/2027, 11/01/2026' }),
    { id: 'v', kind: 'vehicle', name: 'Truck' },
  ];
  const s = store(props, { warranties: [{ id: 'w1', propertyId: 'a', expiration: '2027-10-01', scope: 'Roof' }] });
  const items = collectDates(s);

  it('buckets: passed, next 90, this year, suspect', () => {
    const by = Object.fromEntries(items.map((x) => [`${x.id}-${x.kind}-${x.part}`, bucketOf(x)]));
    expect(by['a-insurance-0']).toBe('passed');
    expect(by['a-tax-0']).toBe('next90');
    expect(by['c-tax-0']).toBe('suspect');
    expect(by['a-warranty-0']).toBe('year');
    expect(itemsForMode(items, 'passed').every((x) => ['passed', 'suspect'].includes(bucketOf(x)))).toBe(true);
    expect(itemsForMode(items, 'year').length).toBe(items.length);
  });

  it('groups Passed first, then Check These Dates, then months, collapsing one kind', () => {
    const groups = groupDates(itemsForMode(items, 'next90'), Object.fromEntries(props.map((p) => [p.id, p])));
    expect(groups.map((g) => g.label)).toEqual(['Passed', 'Check These Dates', 'December 2026', 'January 2027']);
    const dec = groups[2].rows[0];
    expect(dec).toMatchObject({ kind: 'tax', count: 2, where: '2 properties', when: '12/10/2026', stands: 'In 23 days', action: 'Mark Paid' });
    const passed = groups[0].rows;
    expect(passed.map((r) => r.kind)).toEqual(['insurance', 'tax']);
    expect(passed[0]).toMatchObject({ where: 'Property a', when: '08/04/2026', stands: '105 days ago', tone: 'red', action: 'Mark Renewed' });
    expect(groups[1].rows[0]).toMatchObject({ stands: 'Check this date', action: '', tone: 'orange' });
  });

  it('lists the assets missing a kind of date', () => {
    const m = Object.fromEntries(missingByKind(props).map((x) => [x.kind, x.assets.map((a) => a.id)]));
    expect(m.tax).toBeUndefined();
    expect(m.insurance).toEqual(['b', 'c', 'd', 'v']);
    expect(m.registration).toEqual(['v']);
  });

  it('rolls a yearly date one year on in the format it was stored in', () => {
    expect(rollYear('12/10/2026')).toBe('12/10/2027');
    expect(rollYear('2026-08-04')).toBe('2027-08-04');
    expect(rollYear('1/5/2026')).toBe('1/5/2027');
    expect(rollYear('02/29/2028')).toBe('02/28/2029');
    expect(rollYear('12/32/3232')).toBe('');
  });

  it('Mark Paid rolls only that installment and logs the field', () => {
    const d = props[3];
    const nov = items.find((x) => x.id === 'd' && x.date === '11/01/2026');
    expect(rollPatch(d, nov)).toEqual({
      patch: { taxDue: '01/31/2027, 11/01/2027' },
      changes: [{ field: 'Due Dates', from: '01/31/2027, 11/01/2026', to: '01/31/2027, 11/01/2027' }],
    });
    const ins = items.find((x) => x.id === 'a' && x.kind === 'insurance');
    expect(rollPatch(props[0], ins).patch).toEqual({ insExpiration: '2027-08-04' });
    // A suspect date, a record date and a stale value are not rolled.
    expect(rollPatch(props[2], items.find((x) => x.id === 'c'))).toBeNull();
    expect(rollPatch(props[0], items.find((x) => x.kind === 'warranty'))).toBeNull();
    expect(rollPatch({ ...d, taxDue: '03/01/2027' }, nov)).toBeNull();
  });

  it('summarizes', () => {
    expect(datesSummary(items, props)).toMatchObject({ passed: 2, suspect: 1, withInsurance: 1, assets: 5 });
    expect(relativeDays(0)).toBe('Today');
    expect(relativeDays(-3)).toBe('3 days ago');
  });
});
