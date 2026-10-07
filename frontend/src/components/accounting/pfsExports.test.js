import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { refSuffix } from './pfsCondition';
import { buildPfsPdf } from './pfsPdf';
import { pfsSheets } from './pfsXlsx';
import { formatZip, normalizePfsDetails, splitCityStateZip, zipError } from './pfsAddress';

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

describe('Borrower addresses and the co-borrower name (Oct 7)', () => {
  const borrowerText = (details) => {
    const sheet = pfsSheets({ statement: { ...base, assets: [], profile: { ...base.profile, details } } }).find((s) => s.name === 'Borrower');
    return sheet.rows.map((r) => r.map((c) => c?.text ?? '').join('|')).join('\n');
  };

  it('splits an old combined value best effort, keeping what it cannot split', () => {
    expect(splitCityStateZip('Sacramento, CA 95814')).toEqual({ city: 'Sacramento', state: 'CA', zip: '95814' });
    expect(splitCityStateZip('San Luis Obispo ca 934011234')).toEqual({ city: 'San Luis Obispo', state: 'CA', zip: '93401-1234' });
    expect(splitCityStateZip('Escondido, CA')).toEqual({ city: 'Escondido', state: 'CA' });
    expect(splitCityStateZip('Pune, Maharashtra 411001 India')).toEqual({ city: 'Pune, Maharashtra 411001 India' });
    expect(splitCityStateZip('')).toEqual({});
  });

  it('checks a ZIP: 5 digits or 9', () => {
    expect(zipError('92025')).toBe('');
    expect(zipError('92025-1234')).toBe('');
    expect(zipError('')).toBe('');
    expect(zipError('9202')).not.toBe('');
    expect(zipError('92025-12')).not.toBe('');
    expect(formatZip('920251234')).toBe('92025-1234');
  });

  it('folds the old spouse field into the co-borrower name, the block name first', () => {
    expect(normalizePfsDetails({ spouse: 'Archana Kadakia' }).coBorrower).toEqual({ name: 'Archana Kadakia' });
    expect(normalizePfsDetails({ spouse: 'Old', coBorrower: { name: 'New' } }).coBorrower.name).toBe('New');
    expect(normalizePfsDetails({}).coBorrower).toBeUndefined();
  });

  it('prints "City, ST ZIP" on the workbook for both borrowers', () => {
    const text = borrowerText({ address: '1 Capitol Mall', city: 'Sacramento', state: 'CA', zip: '95814',
      coBorrower: { name: 'Archana Kadakia', address: '2 Oak St', city: 'Escondido', state: 'CA', zip: '92025-1234' } });
    expect(text).toContain('Address|1 Capitol Mall, Sacramento, CA 95814');
    expect(text).toContain('Address|2 Oak St, Escondido, CA 92025-1234');
  });

  it('a statement kept before Oct 7 prints the same way, the spouse as the co-borrower', () => {
    const text = borrowerText({ address: '1 Capitol Mall', city_state_zip: 'Sacramento CA 95814', spouse: 'Archana Kadakia' });
    expect(text).toContain('Address|1 Capitol Mall, Sacramento, CA 95814');
    expect(text).toContain('Co-Borrower');
    expect(text).toContain('Name|Archana Kadakia');
  });

  it('builds the PDF with the old fields and the new', async () => {
    const statement = { ...base, assets: [], profile: { ...base.profile, kind: 'joint', details: { city_state_zip: 'Sacramento, CA 95814', spouse: 'Archana Kadakia', coBorrower: { city: 'Escondido', state: 'CA', zip: '92025' } } } };
    const pdf = await PDFDocument.load(await buildPfsPdf({ statement }));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });
});
