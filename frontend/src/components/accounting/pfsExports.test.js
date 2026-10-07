import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { refSuffix } from './pfsCondition';
import { buildPfsPdf } from './pfsPdf';
import { pfsSheets } from './pfsXlsx';

// PFS exports, Oct 7 (Charmi): the account number printed once, and the
// Investments group (Investment Accounts, Business Interests, Real Estate at
// equity) on the Assets page and sheet.

const line = (id, label, accountRef, adjusted) => ({ id, label, accountRef, institution: 'Chase', ownershipPct: 100, balance: adjusted, adjusted, source: 'manual', asOf: '', notes: '', details: {} });
const base = {
  profile: { id: 'p1', name: 'Neil R. Kadakia', displayName: 'Neil R. Kadakia', kind: 'individual', details: {}, history: [], executiveProfile: '' },
  asOf: '2026-10-01', liabilities: [], realEstate: [], schedules: { year: '2026', e: [], c: [] },
  summary: { assets: [], liabilities: [] }, totals: { assets: 0, liabilities: 0, netWorth: 0 }, warnings: [],
};

describe('refSuffix', () => {
  it('is empty when the label already shows the account number', () => {
    expect(refSuffix('RJK - Citi - 3536', '3536')).toBe('');
    expect(refSuffix('Chase Checking-2554', '2554')).toBe('');
    expect(refSuffix('Chase Checking - 6532', '6532')).toBe('');
  });
  it('is the ref when the label does not show it', () => {
    expect(refSuffix('Chase Checking', '6532')).toBe('6532');
    expect(refSuffix('Account 165320', '6532')).toBe('6532');     // inside a longer number is not "shown"
    expect(refSuffix('Anything', '')).toBe('');
    expect(refSuffix('Anything', null)).toBe('');
  });
});

describe('Investments in the exports', () => {
  const statement = {
    ...base,
    assets: [
      { key: 'cash', label: 'Cash', rows: [line('c1', 'Cash', '', 100)], total: 100 },
      { key: 'investment', label: 'Investment Accounts', rows: [line('i1', 'Schwab - 1111', '1111', 5000)], total: 5000 },
      { key: 'business', label: 'Business Interests', rows: [line('b1', 'Greens LLC', '', 10000)], total: 10000 },
    ],
    investments: {
      label: 'Investments', total: 215000, assetKeys: ['investment', 'business'], realEstate: { value: 500000, loans: 300000, equity: 200000 },
      note: 'Real estate is shown here at equity.',
      groups: [
        { key: 'investment', label: 'Investment Accounts', rows: [line('i1', 'Schwab - 1111', '1111', 5000)], total: 5000 },
        { key: 'business', label: 'Business Interests', rows: [line('b1', 'Greens LLC', '', 10000)], total: 10000 },
        { key: 'real_estate_equity', label: 'Real Estate', total: 200000,
          rows: [{ id: 'r1', label: 'Plaza', category: 'domestic_commercial', categoryLabel: 'Domestic Commercial Real Estate', ownershipPct: 50, valueAdjusted: 500000, loanAdjusted: 300000, equity: 200000, details: {} }] },
      ],
    },
  };

  it('puts an Investments block on the Assets sheet, real estate shown at equity only', () => {
    const sheet = pfsSheets({ statement }).find((s) => s.name === 'Assets');
    const text = sheet.rows.map((r) => r.map((c) => c?.text ?? '').join('|')).join('\n');
    expect(text).toContain('Investments - Investment Accounts');
    expect(text).toContain('Investments - Real Estate');
    expect(text).toContain('Total Investments');
    expect(text.indexOf('Cash')).toBeLessThan(text.indexOf('Investments - Investment Accounts'));
    // The grand total still counts the asset groups only (real estate is on its own sheet).
    const grand = sheet.rows.find((r) => r[0]?.text === 'Total Assets (Excluding Real Estate)');
    expect(grand[6].num).toBe(15100);
    const invTotal = sheet.rows.find((r) => r[0]?.text === 'Total Investments');
    expect(invTotal[6].num).toBe(215000);
  });

  it('a statement kept before Oct 7 lays out as it did', () => {
    const old = { ...statement, investments: undefined };
    const text = pfsSheets({ statement: old }).find((s) => s.name === 'Assets').rows.map((r) => r.map((c) => c?.text ?? '').join('|')).join('\n');
    expect(text).not.toContain('Total Investments');
    expect(text).toContain('Investment Accounts');
  });

  it('builds the PDF with and without the block', async () => {
    const withInv = await PDFDocument.load(await buildPfsPdf({ statement }));
    const old = { ...statement, investments: undefined };
    const without = await PDFDocument.load(await buildPfsPdf({ statement: old }));
    expect(withInv.getPageCount()).toBeGreaterThanOrEqual(without.getPageCount());
  });
});
