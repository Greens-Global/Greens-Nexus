import { describe, expect, it } from 'vitest';
import { filterCellOf, filterColumnsOf } from './viewFilterColumns';

const COLUMNS = [
  { key: 'name', label: 'Name', text: (r) => r.name },
  { key: 'day', label: 'Day', type: 'date', value: (r) => r.day, text: (r) => `${r.day} shown` },
  { key: 'amount', label: 'Amount', type: 'amount', value: (r) => r.amount },
  { key: 'act', label: '', noFilter: true },
];
const ROW = { name: 'Acme', code: 'V-100', day: '2026-12-05', amount: null };

describe('filterColumnsOf', () => {
  it('reads each cell: text as it reads, dates as MM/DD/YYYY, amounts as figures, no box for actions', () => {
    const [name, day, amount, ...rest] = filterColumnsOf(COLUMNS);
    expect(rest).toEqual([]);
    expect(name.text(ROW)).toBe('Acme');
    expect(day.text(ROW)).toBe('12/05/2026');
    expect(day.placeholder).toBe('MM/DD/YYYY');
    expect(amount.num).toBe(true);
    expect(Number.isNaN(amount.value(ROW))).toBe(true);
  });

  it('also adds to what a box finds; instead replaces it', () => {
    const added = filterColumnsOf(COLUMNS, { also: { name: (r) => r.code } });
    expect(added[0].text(ROW)).toBe('Acme V-100');
    const swapped = filterColumnsOf(COLUMNS, { instead: { name: (r) => r.code, day: COLUMNS[1].text } });
    expect(swapped[0].text(ROW)).toBe('V-100');
    expect(swapped[1].text(ROW)).toBe('2026-12-05 shown');
  });

  it('filterCellOf marks only the pinned column', () => {
    const cell = filterCellOf('name');
    expect(cell({ key: 'name' }).className).toBe('acct-head');
    expect(cell({ key: 'day' }).className).toBeUndefined();
  });
});
