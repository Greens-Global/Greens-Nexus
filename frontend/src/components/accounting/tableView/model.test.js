import { describe, it, expect } from 'vitest';
import {
  MAX_RULES, applyView, arrange, canMove, defaultState, distinctValues, filterCount, moveColumn, normalizeState,
  ruleHit, ruleReady, ruleText, sameState, sumColumn, viewTable,
} from './model';

// The standard table view's engine (10/23 meeting, item 01): rule filters
// (field + condition + value, All or Any), the heading value lists, sort,
// column order / hide / width, and the export of exactly what is shown.

const COLS = [
  { key: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => (r.date ? `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}/${r.date.slice(0, 4)}` : ''), width: 96 },
  { key: 'vendor', label: 'Vendor', text: (r) => r.vendor || '', width: 200 },
  { key: 'amount', label: 'Amount', type: 'amount', value: (r) => r.amount, text: (r) => (r.amount == null ? '' : r.amount.toFixed(2)), width: 110, total: true },
  { key: 'memo', label: 'Memo', text: (r) => r.memo || '', off: true, width: 240 },
];
const ROWS = [
  { id: 1, date: '2026-09-23', vendor: 'Home Depot', amount: 3000, memo: 'Doors' },
  { id: 2, date: '2026-08-21', vendor: 'Amazon', amount: -1250.5, memo: '' },
  { id: 3, date: '2026-07-23', vendor: 'Home Depot', amount: 3921.42, memo: 'Paint' },
  { id: 4, date: '', vendor: '', amount: null, memo: 'Suspense' },
];
const ids = (rows) => rows.map((r) => r.id);
const run = (patch) => ids(applyView(ROWS, COLS, normalizeState({ ...defaultState(), ...patch })));
const rule = (col, op, a = '', b = '') => ({ id: `${col}${op}`, col, op, a, b });

describe('rules', () => {
  it('text conditions, case-insensitive', () => {
    expect(run({ rules: [rule('vendor', 'contains', 'home')] })).toEqual([1, 3]);
    expect(run({ rules: [rule('vendor', 'not_contains', 'home')] })).toEqual([2, 4]);
    expect(run({ rules: [rule('vendor', 'eq', 'AMAZON')] })).toEqual([2]);
    expect(run({ rules: [rule('vendor', 'ne', 'amazon')] })).toEqual([1, 3, 4]);
    expect(run({ rules: [rule('vendor', 'starts', 'ho')] })).toEqual([1, 3]);
    expect(run({ rules: [rule('vendor', 'ends', 'zon')] })).toEqual([2]);
    expect(run({ rules: [rule('vendor', 'empty')] })).toEqual([4]);
    expect(run({ rules: [rule('memo', 'not_empty')] })).toEqual([1, 3, 4]);
  });

  it('amounts: comparisons, between either way round, and a plain figure matches either sign', () => {
    expect(run({ rules: [rule('amount', 'gt', '3,000')] })).toEqual([3]);
    expect(run({ rules: [rule('amount', 'gte', '3000')] })).toEqual([1, 3]);
    expect(run({ rules: [rule('amount', 'lt', '0')] })).toEqual([2]);
    expect(run({ rules: [rule('amount', 'between', '4000', '2999')] })).toEqual([1, 3]);
    expect(run({ rules: [rule('amount', 'between', '3500', '')] })).toEqual([3]);
    expect(run({ rules: [rule('amount', 'eq', '1,250.50')] })).toEqual([2]);
    expect(run({ rules: [rule('amount', 'eq', '(1,250.50)')] })).toEqual([2]);
    expect(run({ rules: [rule('amount', 'eq', '-3000')] })).toEqual([]);
    expect(run({ rules: [rule('amount', 'empty')] })).toEqual([4]);
  });

  it('dates: on, before, after, between - typed as MM/DD/YYYY or picked', () => {
    expect(run({ rules: [rule('date', 'eq', '2026-08-21')] })).toEqual([2]);
    expect(run({ rules: [rule('date', 'eq', '08/21/2026')] })).toEqual([2]);
    expect(run({ rules: [rule('date', 'lt', '2026-08-21')] })).toEqual([3]);
    expect(run({ rules: [rule('date', 'gte', '2026-08-21')] })).toEqual([1, 2]);
    expect(run({ rules: [rule('date', 'between', '2026-09-30', '2026-08-01')] })).toEqual([1, 2]);
    expect(run({ rules: [rule('date', 'empty')] })).toEqual([4]);
  });

  it('All needs every rule, Any needs one; an empty value filters nothing', () => {
    const rules = [rule('vendor', 'eq', 'amazon'), rule('amount', 'gt', '3500')];
    expect(run({ rules, match: 'all' })).toEqual([]);
    expect(run({ rules, match: 'any' })).toEqual([2, 3]);
    expect(run({ rules: [rule('vendor', 'contains', '  ')] })).toEqual([1, 2, 3, 4]);
    expect(ruleReady(rule('vendor', 'contains', ''), COLS[1])).toBe(false);
    expect(ruleReady(rule('vendor', 'empty'), COLS[1])).toBe(true);
    expect(ruleHit(rule('amount', 'ne', '5'), COLS[2], ROWS[3])).toBe(true);
  });

  it('counts the filters that are on and reads a rule back in words', () => {
    const s = normalizeState({ rules: [rule('vendor', 'contains', 'home'), rule('memo', 'eq', '')], picks: { vendor: { out: ['Amazon'] } } });
    expect(filterCount(s, COLS)).toBe(2);
    expect(ruleText(rule('amount', 'between', '1', '2'), COLS[2])).toBe('Amount between 1 and 2');
    expect(ruleText(rule('date', 'lt', '2026-08-21'), COLS[0])).toBe('Date is before 08/21/2026');
  });

  it('keeps at most 20 rules', () => {
    const many = Array.from({ length: 25 }, (_v, i) => rule('vendor', 'contains', `x${i}`));
    expect(normalizeState({ rules: many }).rules).toHaveLength(MAX_RULES);
  });
});

describe('heading value lists (Excel)', () => {
  it('only these, or all but these; blanks are a value', () => {
    expect(run({ picks: { vendor: { in: ['Amazon', ''] } } })).toEqual([2, 4]);
    expect(run({ picks: { vendor: { out: ['Home Depot'] } } })).toEqual([2, 4]);
    expect(run({ picks: { vendor: { in: [] } } })).toEqual([]);
  });

  it("lists a column's values with counts, from the rows the other filters leave", () => {
    const s = normalizeState({ picks: { vendor: { in: ['Amazon'] } }, rules: [rule('amount', 'gt', '0')] });
    // Its own pick does not narrow its own list; the amount rule does.
    expect(distinctValues(ROWS, COLS, s, 'vendor')).toEqual([{ text: 'Home Depot', n: 2 }]);
    expect(distinctValues(ROWS, COLS, defaultState(), 'vendor')).toEqual([{ text: 'Amazon', n: 1 }, { text: 'Home Depot', n: 2 }, { text: '', n: 1 }]);
    expect(distinctValues(ROWS, COLS, defaultState(), 'amount').map((v) => v.text)).toEqual(['-1250.50', '3000.00', '3921.42', '']);
  });
});

describe('sort', () => {
  it('sorts text, numbers and dates either way, blanks always last, ties in place', () => {
    expect(run({ sort: { col: 'vendor', dir: 'asc' } })).toEqual([2, 1, 3, 4]);
    expect(run({ sort: { col: 'vendor', dir: 'desc' } })).toEqual([1, 3, 2, 4]);
    expect(run({ sort: { col: 'amount', dir: 'desc' } })).toEqual([3, 1, 2, 4]);
    expect(run({ sort: { col: 'date', dir: 'asc' } })).toEqual([3, 2, 1, 4]);
    expect(run({ sort: { col: 'nope', dir: 'asc' } })).toEqual([1, 2, 3, 4]);
  });
});

describe('columns', () => {
  it('hides the default-off ones, follows the saved order, keeps a new column near its neighbor', () => {
    const keys = (s) => arrange(COLS, normalizeState(s)).filter((c) => !c.hidden).map((c) => c.key);
    expect(keys({})).toEqual(['date', 'vendor', 'amount']);
    expect(keys({ vis: { memo: true, date: false } })).toEqual(['vendor', 'amount', 'memo']);
    expect(keys({ order: ['amount', 'date'] })).toEqual(['amount', 'date', 'vendor']);
    expect(arrange(COLS, normalizeState({ widths: { vendor: 320 } })).find((c) => c.key === 'vendor').width).toBe(320);
  });

  it('a fixed column never moves or hides', () => {
    const cols = [{ ...COLS[1], fixed: true }, COLS[0], COLS[2]];
    const s = normalizeState({ order: ['amount', 'date'], vis: { vendor: false } });
    expect(arrange(cols, s).map((c) => [c.key, c.hidden])).toEqual([['vendor', false], ['amount', false], ['date', false]]);
  });

  it('moves left / right over hidden columns, and knows the ends', () => {
    const s = normalizeState({ vis: { memo: true, amount: false } });
    expect(moveColumn(COLS, s, 'memo', -1)).toEqual(['date', 'memo', 'vendor', 'amount']);
    expect(canMove(COLS, s, 'date', -1)).toBe(false);
    expect(canMove(COLS, s, 'memo', 1)).toBe(false);
    expect(canMove(COLS, s, 'vendor', 1)).toBe(true);
  });
});

describe('saved state', () => {
  it('is the same view whatever the rule ids or key order', () => {
    const a = { rules: [{ id: 'x', col: 'vendor', op: 'contains', a: 'home' }], widths: { a: 100, b: 200 } };
    const b = { widths: { b: 200, a: 100 }, rules: [{ id: 'y', col: 'vendor', op: 'contains', a: 'home', b: '' }], match: 'all' };
    expect(sameState(a, b)).toBe(true);
    expect(sameState(a, { ...b, match: 'any' })).toBe(false);
    expect(sameState(defaultState({ sort: { col: 'date', dir: 'desc' } }), defaultState())).toBe(false);
  });

  it('drops junk and clamps widths', () => {
    const s = normalizeState({ rules: [null, { col: 5 }, { col: 'vendor' }], picks: { a: { out: [] }, b: 'x', c: { in: [1] } }, widths: { a: 5, b: 99999, c: 'x' }, sort: { col: 'a', dir: 'up' } });
    expect(s.rules).toHaveLength(1);
    expect(s.picks).toEqual({ c: { in: ['1'] } });
    expect(s.widths).toEqual({ a: 40, b: 1200 });
    expect(s.sort).toEqual({ col: 'a', dir: 'asc' });
  });
});

describe('export and totals', () => {
  it('exports exactly the rows and columns shown, in order, with totals over the amount columns', () => {
    const s = normalizeState({ rules: [rule('vendor', 'contains', 'home')], sort: { col: 'amount', dir: 'desc' }, order: ['amount', 'date', 'vendor', 'memo'], vis: { date: false } });
    const rows = applyView(ROWS, COLS, s);
    const shown = arrange(COLS, s).filter((c) => !c.hidden);
    const t = viewTable(rows, shown, { title: 'Test' });
    expect(t.columns.map((c) => c.label)).toEqual(['Amount', 'Vendor']);
    expect(t.rows).toEqual([[3921.42, 'Home Depot'], [3000, 'Home Depot']]);
    expect(t.totals).toEqual([6921.42, 'Total - 2 rows']);
    expect(sumColumn(rows, COLS[2])).toBe(6921.42);
  });

  it('a column can export as several, or not at all', () => {
    const cols = [{ ...COLS[1], exportAs: [{ label: 'No.', get: (r) => r.id }, { label: 'Name', get: (r) => r.vendor }] }, { key: 'x', label: 'Open', exportAs: [] }];
    const t = viewTable(ROWS.slice(0, 1), cols, { title: 'T', totals: false });
    expect(t.columns.map((c) => c.label)).toEqual(['No.', 'Name']);
    expect(t.rows).toEqual([[1, 'Home Depot']]);
    expect(t.totals).toBeNull();
  });
});
