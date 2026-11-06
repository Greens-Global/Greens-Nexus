import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { parse, tokenize, shiftFormula, colName, colIndex } from './formula/parse.js';
import { createEngine, isErr } from './formula/eval.js';
import { seedSheetDoc, buildCtx, writeCells, insertLines, deleteLines, newTabSnapshot, formulaText, addTab, setTabMeta } from './model.js';
import { serialFromYMD, ymdFromSerial, parseInput, formatValue, textFormat } from './format.js';

/** A workbook from {'A1': value or '=formula'} per tab name. */
function book(tabs) {
  const snap = { type: 'nexus-sheet', v: 1, tabs: Object.keys(tabs).map((name) => newTabSnapshot(name, 50, 10)) };
  const doc = seedSheetDoc(snap);
  const ids = Object.fromEntries(snap.tabs.map((t) => [t.name, t.id]));
  for (const [name, cells] of Object.entries(tabs)) {
    writeCells(doc, ids[name], Object.entries(cells).map(([ref, val]) => {
      const r = Number(ref.match(/\d+/)[0]) - 1, c = colIndex(ref.match(/[A-Z]+/)[0]);
      const p = parseInput(val);
      return { r, c, v: p.v, f: p.f };
    }));
  }
  return { doc, ids };
}
const at = (doc, tabId, ref) => {
  const r = Number(ref.match(/\d+/)[0]) - 1, c = colIndex(ref.match(/[A-Z]+/)[0]);
  return createEngine(buildCtx(doc)).value(tabId, r, c);
};
/** Evaluate one formula in a sheet holding `cells`. */
function ev(formula, cells = {}) {
  const { doc, ids } = book({ S: { ...cells, J50: formula } });
  const v = at(doc, ids.S, 'J50');
  return isErr(v) ? v.code : v;
}

describe('parse', () => {
  it('names columns', () => {
    expect(colName(0)).toBe('A'); expect(colName(25)).toBe('Z'); expect(colName(26)).toBe('AA'); expect(colIndex('AB')).toBe(27);
  });
  it('tokenizes refs, functions and sheets', () => {
    const t = tokenize("SUM($A$1:B2)+'My Tab'!C3*Q3!A1");
    expect(t.filter((x) => x.type === 'ref').map((x) => x.value.sheet)).toEqual([null, 'My Tab', 'Q3']);
    expect(t[0]).toMatchObject({ type: 'func', value: 'SUM' });
    expect(tokenize('LOG10(1)')[0].type).toBe('func');
  });
  it('respects precedence', () => {
    expect(ev('=1+2*3')).toBe(7);
    expect(ev('=-2^2')).toBe(4);
    expect(ev('=2^3^2')).toBe(64);
    expect(ev('=(1+2)*3')).toBe(9);
    expect(ev('=1+2=3')).toBe(true);
    expect(ev('="a"&1+1')).toBe('a2');
    expect(ev('=50%')).toBe(0.5);
  });
  it('throws on bad syntax and evaluates it as #ERROR!', () => {
    expect(() => parse('=1+')).toThrow();
    expect(ev('=SUM(1,')).toBe('#ERROR!');
  });
  it('shifts relative parts only', () => {
    expect(shiftFormula('=A1+$B$2+C$3+$D4', 1, 1)).toBe('=B2+$B$2+D$3+$D5');
    expect(shiftFormula('=A1', -1, 0)).toBe('=#REF!');
  });
});

describe('evaluate', () => {
  const data = { A1: '1', A2: '2', A3: '3', A4: 'x', B1: '10', B2: '20', B3: '30', C1: 'apple', C2: 'banana', C3: 'cherry' };
  it.each([
    ['=SUM(A1:A4)', 6], ['=AVERAGE(A1:A3)', 2], ['=MIN(A1:A3)', 1], ['=MAX(B1:B3)', 30], ['=COUNT(A1:A4)', 3],
    ['=COUNTA(A1:A4)', 4], ['=PRODUCT(A1:A3)', 6], ['=ROUND(2.345,2)', 2.35], ['=ROUND(-2.5,0)', -3], ['=ROUNDUP(1.21,1)', 1.3],
    ['=ROUNDDOWN(1.29,1)', 1.2], ['=INT(-1.5)', -2], ['=MOD(-3,2)', 1], ['=POWER(2,10)', 1024], ['=MEDIAN(1,3,2,4)', 2.5],
    ['=SUMPRODUCT(A1:A3,B1:B3)', 140], ['=SUMIF(A1:A3,">1",B1:B3)', 50], ['=SUMIFS(B1:B3,A1:A3,">=2",C1:C3,"b*")', 20],
    ['=COUNTIF(C1:C3,"*an*")', 1], ['=COUNTIFS(A1:A3,">1",B1:B3,"<30")', 1], ['=AVERAGEIF(A1:A3,"<>2",B1:B3)', 20],
    ['=MAXIFS(B1:B3,A1:A3,"<3")', 20], ['=MINIFS(B1:B3,A1:A3,">1")', 20], ['=IF(A1>0,"yes","no")', 'yes'],
    ['=IFS(A1>5,"a",A1>0,"b")', 'b'], ['=IFERROR(1/0,"oops")', 'oops'], ['=AND(TRUE,A1)', true], ['=OR(FALSE,0)', false],
    ['=XOR(TRUE,TRUE)', false], ['=NOT(FALSE)', true], ['=SWITCH(A2,1,"one",2,"two","many")', 'two'],
    ['=CONCAT(C1:C2)', 'applebanana'], ['=TEXTJOIN(", ",TRUE,C1:C3)', 'apple, banana, cherry'], ['=LEFT(C1,3)', 'app'],
    ['=RIGHT(C1,2)', 'le'], ['=MID(C2,2,3)', 'ana'], ['=LEN(C3)', 6], ['=UPPER("ab")', 'AB'], ['=PROPER("hello world")', 'Hello World'],
    ['=TRIM("  a   b ")', 'a b'], ['=SUBSTITUTE("a-b-c","-","+",2)', 'a-b+c'], ['=REPLACE("abcdef",2,3,"X")', 'aXef'],
    ['=FIND("n",C2)', 3], ['=SEARCH("N",C2)', 3], ['=VALUE("1,200.5")', 1200.5], ['=REPT("ab",3)', 'ababab'], ['=EXACT("a","A")', false],
    ['=VLOOKUP(2,A1:B3,2,FALSE)', 20], ['=VLOOKUP(2.5,A1:B3,2)', 20], ['=HLOOKUP(10,A1:C2,2,FALSE)', 20], ['=XLOOKUP("banana",C1:C3,B1:B3)', 20],
    ['=XLOOKUP("kiwi",C1:C3,B1:B3,"none")', 'none'], ['=INDEX(B1:B3,3)', 30], ['=MATCH("cherry",C1:C3,0)', 3], ['=CHOOSE(2,"a","b")', 'b'],
    ['=ROW(B7)', 7], ['=COLUMN(C1)', 3], ['=ROWS(A1:B3)', 3], ['=COLUMNS(A1:C1)', 3], ['=SIGN(-4)', -1], ['=SQRT(16)', 4],
    ['=ISBLANK(D1)', true], ['=ISNUMBER(A1)', true], ['=ISTEXT(C1)', true], ['=ISNA(MATCH("z",C1:C3,0))', true],
    ['=SUM(A:A)', 6], ['=SUM(1:1)', 11], ['=CEILING(4.1,0.5)', 4.5], ['=FLOOR(4.9,2)', 4],
  ])('%s', (f, want) => { expect(ev(f, data)).toBe(want); });

  it('dates', () => {
    expect(serialFromYMD(1900, 1, 1)).toBe(1);
    expect(serialFromYMD(1900, 3, 1)).toBe(61);
    expect(serialFromYMD(2026, 11, 5)).toBe(46331);
    expect(ymdFromSerial(46331)).toEqual({ y: 2026, m: 11, d: 5 });
    expect(ymdFromSerial(60)).toEqual({ y: 1900, m: 2, d: 29 });
    expect(ev('=DATE(2026,11,5)')).toBe(46331);
    expect(ev('=DATE(2026,13,1)')).toBe(serialFromYMD(2027, 1, 1));
    expect(ev('=YEAR(DATE(2026,11,5))')).toBe(2026);
    expect(ev('=EOMONTH(DATE(2026,1,15),1)')).toBe(serialFromYMD(2026, 2, 28));
    expect(ev('=EDATE(DATE(2026,1,31),1)')).toBe(serialFromYMD(2026, 2, 28));
    expect(ev('=WEEKDAY(DATE(2026,11,5))')).toBe(5);
    expect(ev('=NETWORKDAYS(DATE(2026,11,2),DATE(2026,11,8))')).toBe(5);
    expect(ev('=DATEDIF(DATE(2020,1,15),DATE(2026,11,5),"Y")')).toBe(6);
    expect(ev('=DAYS("11/05/2026","11/01/2026")')).toBe(4);
    expect(ev('=TEXT(DATE(2026,11,5),"mm/dd/yyyy")')).toBe('11/05/2026');
  });
  it('finance', () => {
    expect(ev('=ROUND(PMT(0.05/12,360,200000),2)')).toBe(-1073.64);
    expect(ev('=ROUND(FV(0.05,10,-100),2)')).toBe(1257.79);
    expect(ev('=ROUND(RATE(360,-1073.64,200000)*12,4)')).toBe(0.05);
  });
  it('errors', () => {
    expect(ev('=1/0')).toBe('#DIV/0!');
    expect(ev('=NOPE(1)')).toBe('#NAME?');
    expect(ev('="a"+1')).toBe('#VALUE!');
    expect(ev('=VLOOKUP(9,A1:B3,2,FALSE)', data)).toBe('#N/A');
    expect(ev('=SUM(1/0,1)')).toBe('#DIV/0!');
    expect(ev("='No Tab'!A1")).toBe('#REF!');
  });
  it('flags a cycle', () => {
    const { doc, ids } = book({ S: { A1: '=B1', B1: '=A1+1' } });
    const v = at(doc, ids.S, 'A1');
    expect(v.code).toBe('#REF!');
    expect(v.note).toMatch(/Circular/);
  });
  it('reads other tabs, and follows a rename', () => {
    const { doc, ids } = book({ Main: { A1: "='Q3 Plan'!B2*2" }, 'Q3 Plan': { B2: '21' } });
    expect(at(doc, ids.Main, 'A1')).toBe(42);
    setTabMeta(doc, ids['Q3 Plan'], { name: 'Plan' });
    const ctx = buildCtx(doc);
    expect(formulaText(ctx, ids.Main, ctx.cell(ctx.tabById(ids.Main), 0, 0).f)).toBe('=Plan!B2*2');
    expect(at(doc, ids.Main, 'A1')).toBe(42);
  });
});

describe('references follow rows and columns', () => {
  it('survive insert and delete', () => {
    const { doc, ids } = book({ S: { A1: '5', A2: '=A1*2', B5: '=SUM(A1:A2)' } });
    insertLines(doc, ids.S, 'rows', 0, 2);      // A1 -> A3, A2 -> A4, B5 -> B7
    insertLines(doc, ids.S, 'cols', 0, 1);      // and one column to the right
    const ctx = buildCtx(doc);
    const tab = ctx.tabById(ids.S);
    expect(formulaText(ctx, ids.S, ctx.cell(tab, 3, 1).f)).toBe('=B3*2');
    expect(formulaText(ctx, ids.S, ctx.cell(tab, 6, 2).f)).toBe('=SUM(B3:B4)');
    expect(at(doc, ids.S, 'C7')).toBe(15);
    deleteLines(doc, ids.S, 'rows', 2, 1);      // the 5 is gone
    expect(at(doc, ids.S, 'B3').code).toBe('#REF!');
  });
  it('survive a concurrent insert in two copies', () => {
    const { doc, ids } = book({ S: { A1: '1', A3: '=A1+10' } });
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    insertLines(doc, ids.S, 'rows', 0, 1);               // me: a row on top
    insertLines(other, ids.S, 'rows', 1, 3);             // them: three rows under row 1
    writeCells(other, ids.S, [{ r: 0, c: 0, v: 7 }]);    // and they change the 1
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    for (const d of [doc, other]) {
      const ctx = buildCtx(d);
      const tab = ctx.tabById(ids.S);
      expect(formulaText(ctx, ids.S, ctx.cell(tab, 6, 0).f)).toBe('=A2+10');
      expect(at(d, ids.S, 'A7')).toBe(17);
    }
  });
  it('a new tab is reachable by name', () => {
    const { doc, ids } = book({ S: {} });
    addTab(doc, { ...newTabSnapshot('Rates', 5, 5), cells: {} });
    const rates = buildCtx(doc).tabByName('rates');
    writeCells(doc, rates.id, [{ r: 0, c: 0, v: 3 }]);
    writeCells(doc, ids.S, [{ r: 0, c: 0, f: '=Rates!A1*Rates!E40' }]);   // E40 grows the Rates tab
    expect(at(doc, ids.S, 'A1')).toBe(0);
    expect(buildCtx(doc).tabByName('Rates').rows.length).toBe(40);
  });
});

describe('typing', () => {
  it('reads numbers, money, percents, dates, times and text', () => {
    expect(parseInput('1,200.50')).toEqual({ v: 1200.5 });
    expect(parseInput('$1,200.50')).toEqual({ v: 1200.5, nf: 'currency', d: 2 });
    expect(parseInput('-$5')).toEqual({ v: -5, nf: 'currency', d: 2 });
    expect(parseInput('15%')).toEqual({ v: 0.15, nf: 'percent', d: 0 });
    expect(parseInput('11/05/2026')).toEqual({ v: 46331, nf: 'date' });
    expect(parseInput('11/5/26')).toEqual({ v: 46331, nf: 'date' });
    expect(parseInput('2/30/2026').v).toBe('2/30/2026');
    expect(parseInput('3:30 PM').nf).toBe('time');
    expect(parseInput("'00123")).toEqual({ v: '00123' });
    expect(parseInput('true')).toEqual({ v: true });
    expect(parseInput('=A1')).toEqual({ f: '=A1' });
  });
  it('shows formats the US way', () => {
    expect(formatValue(1234.5, { nf: 'number' })).toBe('1,234.50');
    expect(formatValue(-1234.5, { nf: 'currency' })).toBe('-$1,234.50');
    expect(formatValue(0.153, { nf: 'percent', d: 1 })).toBe('15.3%');
    expect(formatValue(46331.75, { nf: 'datetime' })).toBe('11/05/2026 6:00 PM');
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
    expect(textFormat(1234.567, '$#,##0.00')).toBe('$1,234.57');
    expect(textFormat(0.25, '0%')).toBe('25%');
  });
});
