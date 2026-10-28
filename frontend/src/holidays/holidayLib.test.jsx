import { describe, it, expect } from 'vitest';
import {
  findSourceRow, redate, applyRuleToAll, sameDayNotes, sameDayNote, conflictLines, otherCompaniesText,
} from './holidayLib';

// The shared holiday helpers - the Oct 29 2026 review fixes (findings 1, 4,
// 7, 10, 11).

describe('findSourceRow (finding 11)', () => {
  const s1 = { date: '2026-01-03', name: "Hazarat Ali's Birthday" };
  const s2 = { date: '2026-12-23', name: "Hazarat Ali's Birthday" };
  const first = { key: "IN:hazarat-ali-s-birthday:2026", date: '2026-01-03', actualDate: '', name: s1.name, countries: ['IN'] };
  const second = { key: "IN:hazarat-ali-s-birthday:2026:2", date: '2026-12-23', actualDate: '', name: s2.name, countries: ['IN'] };

  it('does not show the second holiday of the same name as chosen because the first one is', () => {
    expect(findSourceRow([first], s1, 'IN')).toBe(first);
    expect(findSourceRow([first], s2, 'IN')).toBeUndefined();
  });

  it("matches the server's ':2' key to its own date", () => {
    expect(findSourceRow([first, second], s2, 'IN')).toBe(second);
    expect(findSourceRow([second], s1, 'IN')).toBeUndefined();
  });

  it('still finds a holiday moved off its real date (Observe On)', () => {
    const moved = { key: 'US:independence-day:2027', date: '2027-07-05', actualDate: '2027-07-04', name: 'Independence Day', countries: ['US'] };
    expect(findSourceRow([moved], { date: '2027-07-04', name: 'Independence Day' }, 'US')).toBe(moved);
  });
});

describe('redate (finding 7)', () => {
  it('a plain date edit changes the day only - the old day is not recorded as the real date', () => {
    const h = { date: '2027-03-17', actualDate: '', name: 'Founders Day', source: 'manual' };
    expect(redate(h, '2027-03-18')).toMatchObject({ date: '2027-03-18', actualDate: '' });
    const weekday = { date: '2027-11-25', actualDate: '', name: 'Thanksgiving Day', source: 'public' };
    expect(redate(weekday, '2027-11-26')).toMatchObject({ date: '2027-11-26', actualDate: '' });
  });

  it('a list holiday on a weekend keeps its real date when moved', () => {
    const h = { date: '2027-07-04', actualDate: '', name: 'Independence Day', source: 'public' };
    expect(redate(h, '2027-07-05')).toMatchObject({ date: '2027-07-05', actualDate: '2027-07-04' });
  });

  it('keeps an existing real date, and clears it when the day goes back to it', () => {
    const h = { date: '2027-07-05', actualDate: '2027-07-04', name: 'Independence Day', source: 'public' };
    expect(redate(h, '2027-07-02')).toMatchObject({ date: '2027-07-02', actualDate: '2027-07-04' });
    expect(redate(h, '2027-07-04')).toMatchObject({ date: '2027-07-04', actualDate: '' });
  });
});

describe('applyRuleToAll (finding 10)', () => {
  const rows = [
    { key: 'a', date: '2027-07-04', actualDate: '', name: 'Independence Day', source: 'public' },
    { key: 'b', date: '2027-12-24', actualDate: '2027-12-25', name: 'Christmas Day', source: 'public' },
    { key: 'c', date: '2027-03-20', actualDate: '', name: 'Founders Day', source: 'manual' },
    { key: 'd', date: '2027-02-15', actualDate: '', name: "Presidents' Day", source: 'public' },
  ];

  it('re-dates every list holiday from its real date and lists the changes', () => {
    const { next, changes, removed } = applyRuleToAll(rows, 'next_monday');
    expect(changes).toEqual([
      { key: 'a', name: 'Independence Day', from: '2027-07-04', to: '2027-07-05' },
      { key: 'b', name: 'Christmas Day', from: '2027-12-24', to: '2027-12-27' },
    ]);
    expect(removed).toEqual([]);
    expect(next.find(h => h.key === 'b')).toMatchObject({ date: '2027-12-27', actualDate: '2027-12-25' });
    expect(next.find(h => h.key === 'c').date).toBe('2027-03-20');      // typed in: left alone
  });

  it('Keep The Date puts them back on the real date; No Day Off takes weekend ones out', () => {
    expect(applyRuleToAll(rows, 'keep').next.find(h => h.key === 'b')).toMatchObject({ date: '2027-12-25', actualDate: '' });
    const off = applyRuleToAll(rows, 'not_observed');
    expect(off.removed).toEqual(['Independence Day', 'Christmas Day']);
    expect(off.next.map(h => h.key)).toEqual(['c', 'd']);
  });
});

describe('same-day notes (finding 1)', () => {
  it('says which holiday wins a shared day', () => {
    const rows = [
      { date: '2027-12-24', name: 'Christmas Day', type: 'mandatory', countries: ['US'] },
      { date: '2027-12-24', name: 'Christmas Eve', type: 'half_day', countries: ['US'] },
      { date: '2027-12-24', name: 'Diwali Bonus Day', type: 'mandatory', countries: ['IN'] },
    ];
    expect(sameDayNotes(rows)).toEqual({
      0: 'Same day as Christmas Eve - Christmas Day wins',
      1: 'Same day as Christmas Day - Christmas Day wins',
    });
    expect(sameDayNote(rows[0], [{ name: 'Office Closed', type: 'mandatory' }]))
      .toBe('Same day as Office Closed - one Mandatory day, the names shown together');
  });

  it('a clash with another holiday on the same day says so in the save summary', () => {
    const lines = conflictLines([{ name: 'Greens Global', conflicts: [
      { date: '2027-12-31', name: "New Year's Day", with: 'US Holidays', withName: "New Year's Eve", withDate: '2027-12-31',
        reason: 'same_day', note: "Same day as New Year's Eve - New Year's Day wins" },
      { date: '2027-12-24', name: 'Christmas Day', with: "Company's Own Holidays", withName: 'Christmas Day', withDate: '2027-12-27', reason: 'same_name' },
    ] }]);
    expect(lines).toEqual([
      "New Year's Day 12/31/2027 is the same day as New Year's Eve in US Holidays - New Year's Day wins",
      "Christmas Day 12/24/2027 is also in Company's Own Holidays on 12/27/2027",
    ]);
  });
});

describe('otherCompaniesText (finding 4)', () => {
  it('counts the companies outside the caller scope', () => {
    expect(otherCompaniesText(0)).toBe('');
    expect(otherCompaniesText(1)).toBe(' and 1 other company');
    expect(otherCompaniesText(3)).toBe(' and 3 other companies');
  });
});
