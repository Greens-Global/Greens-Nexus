import { describe, it, expect, afterEach } from 'vitest';
import cases from './formula.cases.json';
import {
  parseFormula, runFormula, checkFormula, createFormulaEngine, formulaEngineFor, formatFormulaValue,
  formatNumberAs, formulaSortValue, formulaExportValue, formulaMatches, normalizeFormat, dateValue,
  FormulaError, FDate, formulaFieldRefs, fieldKey, fieldNameProblem, formulasUsing, applyFieldUpdate,
  excelFormat, formulaContext, MAX_TEXT,
} from './formula';
import { pdfColumns, PDF_MAX_COLS } from './exporting';
import { totalFor } from './totals';

// Evaluate with a fixed field table and today.
const run = (src, fields = {}, today = '2026-10-22') => runFormula(src, {
  today,
  field: (name) => {
    const k = Object.keys(fields).find((x) => x.toLowerCase() === name.toLowerCase());
    if (k === undefined) throw new FormulaError(`Unknown field {${name}}.`);
    return fields[k];
  },
});
const val = (src, fields, today) => {
  const r = run(src, fields, today);
  if (r.error) throw new Error(`unexpected error for ${src}: ${r.error}`);
  return r.value instanceof FDate ? r.value.iso : r.value;
};
const err = (src, fields) => run(src, fields).error;

describe('grammar (shared with the server)', () => {
  it('parses every valid case', () => {
    for (const src of cases.valid) expect(() => parseFormula(src), src).not.toThrow();
  });
  it('refuses every invalid case with the same message', () => {
    for (const [src, fragment] of cases.invalid) {
      let msg = '';
      try { parseFormula(src); } catch (e) { msg = e.message; }
      expect(msg, src).toContain(fragment);
    }
  });
  it('compares field names and counts lengths like the server', () => {
    for (const [name, key] of cases.keys) expect(fieldKey(name), JSON.stringify(name)).toBe(key);
    for (const c of cases.repeat) {
      const src = c.prefix + c.unit.repeat(c.times) + c.suffix;
      let msg = '';
      try { parseFormula(src); } catch (e) { msg = e.message; }
      if (c.error === null) expect(msg, `${c.unit} x${c.times}`).toBe('');
      else expect(msg, `${c.unit} x${c.times}`).toContain(c.error);
    }
  });
  it('refuses very long input and over-deep nesting', () => {
    expect(() => parseFormula('1+'.repeat(1001) + '1')).toThrow(/at most 2000/);
    expect(() => parseFormula(`${'-'.repeat(60)}1`)).toThrow(/nested too deeply/);
    expect(() => parseFormula('٣ + 1')).toThrow(/Unexpected/);
  });
  it('lists field references once each, by name', () => {
    expect(formulaFieldRefs('{Budget} - { budget } + {Spent} & "{Nope}"')).toEqual(['Budget', 'Spent']);
  });
});

describe('operators and precedence', () => {
  it('does math in the usual order', () => {
    expect(val('1 + 2 * 3')).toBe(7);
    expect(val('(1 + 2) * 3')).toBe(9);
    expect(val('-2 * 3')).toBe(-6);
    expect(val('10 % 4')).toBe(2);
    expect(val('7 / 2')).toBe(3.5);
    expect(val('2 - -1')).toBe(3);
  });
  it('joins text with & after the math', () => {
    expect(val('1 + 1 & "x"')).toBe('2x');
    expect(val('"a" & "b" & 3')).toBe('ab3');
    expect(val('0.1 + 0.2 & ""')).toBe('0.3');
  });
  it('compares last', () => {
    expect(val('1 + 1 = 2')).toBe(true);
    expect(val('2 > 3')).toBe(false);
    expect(val('"abc" = "ABC"')).toBe(true);
    expect(val('1 <> 2')).toBe(true);
    expect(val('"10" = 10')).toBe(true);
    expect(val('"x" = 1')).toBe(false);
  });
  it('treats numeric text as a number and other text as an error', () => {
    expect(val('{T} * 2', { T: '21' })).toBe(42);
    expect(err('{T} * 2', { T: 'abc' })).toMatch(/Expected a number but got text "abc"/);
  });
});

describe('functions', () => {
  it('SUM / AVG / MIN / MAX skip blanks', () => {
    expect(val('SUM(1, {B}, 2)', { B: null })).toBe(3);
    expect(val('AVG(2, 4, {B})', { B: null })).toBe(3);
    expect(val('AVG({B})', { B: null })).toBe(null);
    expect(val('MIN(3, 1, 2)')).toBe(1);
    expect(val('MAX(3, 1, 2)')).toBe(3);
    expect(val('MAX({D}, {E})', { D: dateValue('2026-01-05'), E: dateValue('2026-03-01') })).toBe('2026-03-01');
  });
  it('ROUND rounds half away from zero without float noise', () => {
    expect(val('ROUND(1.005, 2)')).toBe(1.01);
    expect(val('ROUND(-2.5)')).toBe(-3);
    expect(val('ROUND(1234, -2)')).toBe(1200);
  });
  it('IF only works out the side it takes', () => {
    expect(val('IF({B} = 0, 0, 10 / {B})', { B: 0 })).toBe(0);
    expect(val('IF(FALSE, 1)')).toBe(null);
    expect(val('IF({B} > 100, "High", "Low")', { B: 150 })).toBe('High');
  });
  it('logic, blanks and text helpers', () => {
    expect(val('AND(TRUE, 1, "x")')).toBe(true);
    expect(val('OR(FALSE, 0, {B})', { B: null })).toBe(false);
    expect(val('NOT(ISBLANK({B}))', { B: '' })).toBe(false);
    expect(val('ABS(-4)')).toBe(4);
    expect(val('CONCAT("a", 1, TRUE)')).toBe('a1True');
    expect(val('UPPER("ab") & LOWER("CD")')).toBe('ABcd');
  });
  it('ISBLANK, and blanks in math', () => {
    expect(val('ISBLANK({B})', { B: null })).toBe(true);
    expect(val('{A} - {B}', { A: 10, B: null })).toBe(10);
    expect(val('{A} - {B}', { A: null, B: null })).toBe(null);
    expect(val('{A} > 5', { A: null })).toBe(false);
  });
});

describe('dates', () => {
  const D = (s) => dateValue(s);
  it('date - date = days; date + number = date', () => {
    expect(val('{Due} - {Start}', { Due: D('2026-10-31'), Start: D('2026-10-01') })).toBe(30);
    expect(val('{Due} + 3', { Due: D('2026-12-30') })).toBe('2027-01-02');
    expect(val('3 + {Due}', { Due: D('2026-02-27') })).toBe('2026-03-02');
    expect(val('{Due} - {Start}', { Due: null, Start: D('2026-10-01') })).toBe(null);
    expect(err('{Due} + {Start}', { Due: D('2026-10-01'), Start: D('2026-10-02') })).toMatch(/cannot be added/);
  });
  it('DAYS and TODAY use the local calendar day', () => {
    expect(val('DAYS({Due}, TODAY())', { Due: D('2026-10-25') }, '2026-10-22')).toBe(3);
    expect(val('TODAY()', {}, '2026-10-22')).toBe('2026-10-22');
    expect(val('DAYS("2026-12-31", "2026-01-01")')).toBe(364);
  });
  it('WORKDAYS counts Monday to Friday, both ends', () => {
    // Fri Oct 23 2026 .. Mon Oct 26 2026 = Fri + Mon
    expect(val('WORKDAYS("2026-10-23", "2026-10-26")')).toBe(2);
    expect(val('WORKDAYS("2026-10-26", "2026-10-23")')).toBe(-2);
    expect(val('WORKDAYS("2026-10-01", "2026-10-31")')).toBe(22);
    expect(val('WORKDAYS("2026-10-24", "2026-10-25")')).toBe(0);
  });

  const origTz = process.env.TZ;
  afterEach(() => { process.env.TZ = origTz; });
  it('is not thrown by a DST change (US and India)', () => {
    for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/London']) {
      process.env.TZ = tz;
      // US clocks fall back on Nov 1 2026, spring forward on Mar 8 2026.
      expect(val('{A} - {B}', { A: D('2026-11-02'), B: D('2026-10-31') }), tz).toBe(2);
      expect(val('{A} - {B}', { A: D('2026-03-09'), B: D('2026-03-07') }), tz).toBe(2);
      expect(val('{A} + 1', { A: D('2026-03-07') }), tz).toBe('2026-03-08');
      expect(val('{A} + 1', { A: D('2026-10-31') }), tz).toBe('2026-11-01');
      expect(val('WORKDAYS("2026-10-30", "2026-11-03")'), tz).toBe(3);
    }
  });
  it('reads a timestamp as the viewer\'s local day', () => {
    process.env.TZ = 'America/Los_Angeles';
    const eng = createFormulaEngine({ customFields: [{ id: 'f', name: 'Made', type: 'formula', formula: '{Created}' }], today: '2026-10-22' });
    // 03:00 UTC on the 22nd is still the 21st in California.
    const r = eng.result({ id: 't', createdAt: '2026-10-22T03:00:00Z' }, { id: 'f', name: 'Made', type: 'formula', formula: '{Created}' });
    expect(r.value.iso).toBe('2026-10-21');
  });
});

describe('errors stay in their cell', () => {
  it('division by zero, bad types, unknown names', () => {
    expect(err('1 / 0')).toBe('Division by zero.');
    expect(err('5 % {Z}', { Z: 0 })).toBe('Division by zero.');
    expect(err('{Nope} + 1')).toBe('Unknown field {Nope}.');
    expect(err('"a" < 1')).toMatch(/Cannot compare text with a number/);
    expect(err('-{D}', { D: dateValue('2026-01-01') })).toMatch(/negative/);
    expect(err('1 +')).toBe('The formula ends too soon.');
  });
  it('injection-shaped names are just unknown', () => {
    expect(err('{__proto__}')).toBe('Unknown field {__proto__}.');
    expect(err('{constructor}')).toBe('Unknown field {constructor}.');
    expect(err('constructor(1)')).toBe('Unknown function constructor.');
    expect(err('toString()')).toBe('Unknown function toString.');
  });
});

describe('the engine', () => {
  const fields = [
    { id: 'bud', name: 'Budget', type: 'number' },
    { id: 'sp', name: 'Spent', type: 'number' },
    { id: 'stage', name: 'Stage', type: 'select', options: [{ id: 'o1', label: 'Design' }] },
    { id: 'who', name: 'Reviewers', type: 'people' },
    { id: 'ok', name: 'Approved', type: 'checkbox' },
    { id: 'when', name: 'Install', type: 'date' },
    { id: 'left', name: 'Left', type: 'formula', formula: '{Budget} - {Spent}' },
    { id: 'pct', name: 'Used', type: 'formula', formula: '{Spent} / {Budget}', formulaFormat: { format: 'percent' } },
    { id: 'lbl', name: 'Label', type: 'formula', formula: '{Stage} & " / " & {Reviewers} & " / " & {Approved}' },
    { id: 'chain', name: 'Twice Left', type: 'formula', formula: '{Left} * 2' },
    { id: 'loopa', name: 'Loop A', type: 'formula', formula: '{Loop B} + 1' },
    { id: 'loopb', name: 'Loop B', type: 'formula', formula: '{Loop A} + 1' },
    { id: 'prog', name: 'Prog', type: 'formula', formula: '{Progress}' },
  ];
  const sub1 = { id: 's1', completed: true };
  const sub2 = { id: 's2', completed: false };
  const task = {
    id: 't1', subtaskIds: ['s1', 's2'], estimateHours: 4,
    customFieldValues: { bud: 200, sp: 50, stage: 'o1', who: ['ana.ruiz@greensglobal.com'], ok: true, when: '2026-11-01' },
  };
  const eng = createFormulaEngine({ customFields: fields, taskById: { s1: sub1, s2: sub2 }, nameOf: (e) => (e.startsWith('ana') ? 'Ana Ruiz' : e) });
  const get = (id) => eng.result(task, fields.find((f) => f.id === id));

  it('reads custom fields by type', () => {
    expect(get('left').value).toBe(150);
    expect(get('pct').value).toBe(0.25);
    expect(get('lbl').value).toBe('Design / Ana Ruiz / True');
    expect(get('chain').value).toBe(300);
    expect(get('prog').value).toBe(0.5);
  });
  it('memoizes per task and field', () => {
    expect(get('left')).toBe(get('left'));
    const changed = { ...task, customFieldValues: { ...task.customFieldValues, sp: 100 } };
    expect(eng.result(changed, fields.find((f) => f.id === 'left')).value).toBe(100);
  });
  it('a loop through two formulas is an error, not a hang', () => {
    expect(get('loopa').error).toMatch(/Loop B/);
  });
  it('a non-formula field has no result', () => {
    expect(eng.result(task, fields[0])).toEqual({ value: null, error: '' });
  });
  it('shares one engine per data snapshot', () => {
    const store = { customFields: fields, taskById: {} };
    expect(formulaEngineFor(store)).toBe(formulaEngineFor(store));
    expect(formulaEngineFor({ ...store, taskById: {} })).not.toBe(formulaEngineFor(store));
  });
  it('picks the same-named field the task actually uses', () => {
    const twin = [
      { id: 'a', name: 'Cost', type: 'number', projectIds: ['p1'] },
      { id: 'b', name: 'Cost', type: 'number', projectIds: ['p2'] },
      { id: 'f', name: 'Double', type: 'formula', formula: '{Cost} * 2' },
    ];
    const e = createFormulaEngine({ customFields: twin });
    expect(e.result({ id: 'x', projectId: 'p2', customFieldValues: { a: 1, b: 5 } }, twin[2]).value).toBe(10);
  });
});

describe('formatting, sorting and export values', () => {
  it('formats like the column', () => {
    expect(formatFormulaValue(1234.5, { format: 'currency' })).toBe('$1,234.50');
    expect(formatFormulaValue(0.256, { format: 'percent', decimals: 1 })).toBe('25.6%');
    expect(formatFormulaValue(1234.5678, { format: 'number' })).toBe('1,234.57');
    expect(formatFormulaValue(3, { format: 'number' })).toBe('3');
    expect(formatFormulaValue(dateValue('2026-10-04'), { format: 'number' })).toBe('10/04/2026');
    expect(formatFormulaValue(true, {})).toBe('True');
    expect(formatFormulaValue(null, {})).toBe('');
    expect(formatNumberAs(-5, { format: 'currency', decimals: 0 })).toBe('-$5');
  });
  it('normalizes formats like the server', () => {
    expect(normalizeFormat(undefined)).toEqual({ format: 'number', decimals: 2 });
    expect(normalizeFormat({ format: 'percent' })).toEqual({ format: 'percent', decimals: 0 });
    expect(normalizeFormat({ format: 'nope', decimals: 40 })).toEqual({ format: 'number', decimals: 6 });
  });
  it('sort values put blanks and errors last (null)', () => {
    expect(formulaSortValue({ value: 3, error: '' })).toBe(3);
    expect(formulaSortValue({ value: dateValue('1970-01-02'), error: '' })).toBe(1);
    expect(formulaSortValue({ value: 'B', error: '' })).toBe('b');
    expect(formulaSortValue({ value: null, error: 'x' })).toBe(null);
  });
  it('export values keep numbers numeric and mark errors', () => {
    expect(formulaExportValue({ value: 1.23456, error: '' }, { format: 'number', decimals: 2 })).toBe(1.23);
    expect(formulaExportValue({ value: 0.12345, error: '' }, { format: 'percent', decimals: 1 })).toBe(0.123);
    expect(formulaExportValue({ value: null, error: 'Division by zero.' }, {})).toBe('#Error');
    expect(formulaExportValue({ value: dateValue('2026-10-04'), error: '' }, {})).toBe('10/04/2026');
  });
  it('filter states', () => {
    expect(formulaMatches({ value: 1, error: '' }, ['__filled'])).toBe(true);
    expect(formulaMatches({ value: null, error: '' }, ['__filled'])).toBe(false);
    expect(formulaMatches({ value: null, error: 'x' }, ['__error', '__blank'])).toBe(true);
    expect(formulaMatches({ value: null, error: '' }, [])).toBe(true);
  });
});

describe('checkFormula (the editor)', () => {
  const opts = { selfName: 'Left', fieldNames: ['Budget', 'Spent', 'Other'], formulaFields: { Other: '{Left} + 1' } };
  it('accepts a good formula and explains a bad one', () => {
    expect(checkFormula('{Budget} - {Spent}', opts)).toBe('');
    expect(checkFormula('{Due Date} - TODAY()', opts)).toBe('');
    expect(checkFormula('{Nope}', opts)).toBe('Unknown field {Nope}.');
    expect(checkFormula('{Left}', opts)).toMatch(/itself/);
    expect(checkFormula('{Other} * 2', opts)).toMatch(/Circular reference/);
    expect(checkFormula('SUM(', opts)).toBe('The formula ends too soon.');
  });
});

describe('review fixes (Oct 22 2026)', () => {
  it('catches a loop through one of two same-named formula columns', () => {
    const fields = [
      { id: 'x1', name: 'X', type: 'formula', formula: '{Budget}', appliesTo: ['task'] },
      { id: 'x2', name: 'X', type: 'formula', formula: '{Y} + 1', appliesTo: ['task'] },
      { id: 'b', name: 'Budget', type: 'number', appliesTo: ['task'] },
    ];
    const ctx = formulaContext(fields, '__draft');
    expect(ctx.formulaFields).toHaveLength(2);
    expect(checkFormula('{X} * 2', { selfName: 'Y', ...ctx })).toMatch(/Circular reference/);
  });

  it('caps text: a nested chain of joins errors instead of exploding', () => {
    const many = (name, n) => Array.from({ length: n }, () => `{${name}}`).join('&');
    const fields = [
      { id: 't', name: 'T', type: 'text' },
      { id: 'a', name: 'A', type: 'formula', formula: many('T', 50) },
      { id: 'b', name: 'B', type: 'formula', formula: many('A', 300) },
      { id: 'c', name: 'C', type: 'formula', formula: many('B', 300) },
      { id: 'u', name: 'U', type: 'formula', formula: 'UPPER({A}) & LOWER({A})' },
      { id: 'k', name: 'K', type: 'formula', formula: `CONCAT(${Array.from({ length: 80 }, () => '{A}').join(', ')})` },
    ];
    const e = createFormulaEngine({ customFields: fields });
    const task = { id: 'x', customFieldValues: { t: 'x'.repeat(100) } };
    const get = (id) => e.result(task, fields.find((f) => f.id === id));
    expect(get('a').value).toHaveLength(5000);
    const t0 = Date.now();
    expect(get('b').error).toMatch(/Text is too long/);
    expect(get('c').error).toMatch(/\{B\} has an error/);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(get('u').value).toHaveLength(10000);
    expect(get('k').error).toMatch(/Text is too long/);
    expect(run('{T}', { T: 'y'.repeat(MAX_TEXT + 1) }).error).toMatch(/Text is too long/);
  });

  it('dates past 12/31/9999 or before 01/01/0001 are an error, not a bad date', () => {
    expect(err('{D} + 100000000000', { D: dateValue('2026-01-01') })).toBe('The date is out of range.');
    expect(err('{D} - 1000000', { D: dateValue('2026-01-01') })).toBe('The date is out of range.');
    expect(val('{D} + 1', { D: dateValue('9999-12-30') })).toBe('9999-12-31');
  });

  it('names a custom field may not have', () => {
    expect(fieldNameProblem('Budget')).toBe('');
    expect(fieldNameProblem('Spent}x')).toMatch(/\{ or \}/);
    expect(fieldNameProblem(' due   DATE ')).toMatch(/built-in/);
  });

  it('lists the formulas a delete would break, unless the name lives on in another field', () => {
    const spent = { id: 's', name: 'Spent', type: 'number' };
    const left = { id: 'l', name: 'Left', type: 'formula', formula: '{Budget} - { spent }' };
    expect(formulasUsing([spent, left], spent).map((f) => f.id)).toEqual(['l']);
    expect(formulasUsing([spent, left, { id: 's2', name: 'Spent', type: 'number' }], spent)).toEqual([]);
  });

  it('a rename puts the rewritten formula columns in place', () => {
    const list = [{ id: 's', name: 'Spent' }, { id: 'l', name: 'Left', formula: '{Spent}' }, { id: 'o', name: 'Other' }];
    const next = applyFieldUpdate(list, 's', { id: 's', name: 'Actual', rewrittenFormulas: [{ id: 'l', name: 'Left', formula: '{Actual}' }] });
    expect(next.map((f) => f.name)).toEqual(['Actual', 'Left', 'Other']);
    expect(next[1].formula).toBe('{Actual}');
    expect(next[0]).not.toHaveProperty('rewrittenFormulas');
    expect(next[2]).toBe(list[2]);
  });

  it('exports: Excel number formats and the PDF column cap', () => {
    expect(excelFormat({ format: 'percent', decimals: 1 })).toBe('0.0%');
    expect(excelFormat({ format: 'percent', decimals: 0 })).toBe('0%');
    expect(excelFormat({ format: 'currency' })).toBe('"$"#,##0.00');
    expect(excelFormat({ format: 'number' })).toBeUndefined();
    const base = Array.from({ length: 12 }, (_, i) => ({ header: `B${i}` }));
    const extra = Array.from({ length: 5 }, (_, i) => ({ header: `C${i}`, optional: true }));
    const { columns, dropped } = pdfColumns([...base, ...extra]);
    expect(columns).toHaveLength(PDF_MAX_COLS);
    expect(dropped).toBe(3);
    expect(pdfColumns(base.slice(0, 3)).dropped).toBe(0);
  });

  it('remembers a total per (rows, column, total)', () => {
    const rows = [{ estimateHours: 1 }, { estimateHours: 2 }];
    const a = totalFor(rows, 'estimate', 'sum');
    rows.push({ estimateHours: 5 });   // same array: the remembered answer stands
    expect(totalFor(rows, 'estimate', 'sum')).toBe(a);
    expect(totalFor([...rows], 'estimate', 'sum')).toBe(8);
    expect(totalFor(rows, 'estimate', 'max')).toBe(5);
  });
});
