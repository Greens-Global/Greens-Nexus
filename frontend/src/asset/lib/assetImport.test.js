import { describe, it, expect } from 'vitest';
import { matchCompany, readImportRows, COMPANY_COLUMN } from './assetImport.js';
import { assetCsvRows, nexusCsvParse } from './csvExport.js';

// The import's Company column (Neil, 11/03/2026): matched by id or by name
// (case and spaces ignored), never guessed; blank = no company.

const COMPANIES = [
  { id: 'c1', name: 'Greens Storage', assignable: true },
  { id: 'c2', name: 'Greens  Build', assignable: true },
  { id: 'c3', name: 'Other Co', assignable: false },
  { id: 'c4', name: 'Twin', assignable: true },
  { id: 'c5', name: 'twin', assignable: true },
];

describe('matchCompany', () => {
  it('blank is no company and no problem', () => {
    expect(matchCompany(COMPANIES, '')).toEqual({ companyId: '', problem: null });
    expect(matchCompany(COMPANIES, '   ')).toEqual({ companyId: '', problem: null });
  });

  it('matches a name with any case or spacing, and an id', () => {
    expect(matchCompany(COMPANIES, 'greens storage').companyId).toBe('c1');
    expect(matchCompany(COMPANIES, '  GREENS   STORAGE ').companyId).toBe('c1');
    expect(matchCompany(COMPANIES, 'Greens Build').companyId).toBe('c2');
    expect(matchCompany(COMPANIES, 'c2').companyId).toBe('c2');
  });

  it('an unknown name is a problem, never a guess', () => {
    const m = matchCompany(COMPANIES, 'Greens');
    expect(m.companyId).toBe('');
    expect(m.problem.label).toBe('Unknown Company');
    expect(m.problem.hint).toMatch(/^"Greens" is not a company in Nexus/);
  });

  it('a name that matches more than one company is a problem; the id still works', () => {
    const m = matchCompany(COMPANIES, 'TWIN');
    expect(m.companyId).toBe('');
    expect(m.problem.label).toBe('More Than One Match');
    expect(matchCompany(COMPANIES, 'c5').companyId).toBe('c5');
  });

  it('a company the person may not assign is a problem', () => {
    const m = matchCompany(COMPANIES, 'Other Co');
    expect(m.companyId).toBe('');
    expect(m.problem.label).toBe('Not One of Your Companies');
  });

  it('with no company list at all a typed company cannot be matched', () => {
    expect(matchCompany([], 'Greens Storage').problem.label).toBe('Unknown Company');
    expect(matchCompany(undefined, '').problem).toBe(null);
  });
});

const FIELDS = [{ k: 'name', label: 'Asset Name / Unit #' }, { k: 'make', label: 'Make' }];

describe('readImportRows', () => {
  it('reads every row with its company and problems, by spreadsheet row number', () => {
    const rows = [
      ['Asset Name / Unit #', 'Make', 'company'],
      ['Truck 1', 'Ford', 'Greens Storage'],
      ['Truck 2', 'Ram', ''],
      ['Truck 3', 'GMC', 'Nope Inc'],
      ['', 'Kia', 'Greens Storage'],
    ];
    const { items, hasCompanyColumn } = readImportRows(rows, FIELDS, COMPANIES);
    expect(hasCompanyColumn).toBe(true);
    expect(items.map((it) => [it.line, it.name, it.companyId, it.problems.map((p) => p.label)])).toEqual([
      [2, 'Truck 1', 'c1', []],
      [3, 'Truck 2', '', []],
      [4, 'Truck 3', '', ['Unknown Company']],
      [5, '', 'c1', ['No Name']],
    ]);
    expect(items[0].values).toEqual({ name: 'Truck 1', make: 'Ford' });
  });

  it('a file without a Company column imports with no company', () => {
    const { items, hasCompanyColumn } = readImportRows([['Asset Name / Unit #'], ['Truck 1']], FIELDS, COMPANIES);
    expect(hasCompanyColumn).toBe(false);
    expect(items[0]).toMatchObject({ companyId: '', problems: [] });
  });
});

describe('asset CSV export - Company', () => {
  it('exports the company NAME, which the import matches back', () => {
    const rows = assetCsvRows({ id: 'a1', companyId: 'c1', snapshot: [] }, {}, { companies: COMPANIES });
    expect(rows[1]).toEqual(['Overview', 'Company', 'Company', 'Greens Storage']);
    expect(matchCompany(COMPANIES, rows[1][3]).companyId).toBe('c1');
  });

  it('an id the list does not name goes out as the id; no company is blank', () => {
    expect(assetCsvRows({ id: 'a1', companyId: 'zz' }, {}, { companies: COMPANIES })[1][3]).toBe('zz');
    expect(assetCsvRows({ id: 'a1' }, {}, { companies: COMPANIES })[1][3]).toBe('');
  });

  it('callers that pass no company list get the old file', () => {
    expect(assetCsvRows({ id: 'a1' }, {}, null)).toEqual([['Section', 'Group', 'Field', 'Value']]);
  });

  it('the column name is the template header the import reads', () => {
    expect(nexusCsvParse(`Name,${COMPANY_COLUMN}\nA,Twin`)[0][1]).toBe('Company');
  });
});
