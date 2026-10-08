import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildStatementWorkbook, statementCells } from './reportExcel';
import { defaultConfig, resolveConfig, runReport } from './reportModel';

// The Excel export (Neil, 09/29 call, "critical"): bold totals, fitted
// columns, and totals that are LIVE formulas over the rows above them.

const NOW = new Date(2026, 8, 28);
const pnl = {
  org: 'Greens Global', generated_at: '2026-09-28',
  sections: [
    { key: 'revenue', label: 'Revenue', accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking', amount: 50 }] },
    { key: 'cogs', label: 'Cost of Sales', accounts: [{ account_no: '51000', title: 'Propane', amount: 250 }] },
    { key: 'expense', label: 'Operating Expenses', accounts: [{ account_no: '61000', title: 'Repairs', amount: 300 }] },
  ],
};
const api = { getAccountingPnl: async () => pnl };

describe('statement workbook', () => {
  it('lays the statement out with SUM formulas on the section totals and formulas on the subtotals', async () => {
    const r = await runReport(api, resolveConfig(defaultConfig(NOW), NOW));
    const { rows, widths, headerRow } = statementCells({ title: 'Income Statement', result: r });
    expect(headerRow).toBe(4);
    const text = (row) => (row[0]?.text ?? '');
    const labels = rows.slice(4).map(text);
    expect(labels).toEqual(['Revenue', '41000', '41100', 'Total Revenue', 'Cost of Sales', '51000', 'Total Cost of Sales', 'Operating Expenses', '61000', 'Total Operating Expenses', 'Gross Profit', 'Operating Income', 'Net Income', 'Net Profit Margin %']);
    const at = (label) => rows[labels.indexOf(label) + 4];
    // Column C holds the one figure column (A = code, B = title).
    expect(at('Total Revenue')[2]).toMatchObject({ f: 'SUM(C6:C7)', num: 1050 });
    expect(at('Total Cost of Sales')[2]).toMatchObject({ f: 'SUM(C10:C10)', num: 250 });
    expect(at('Gross Profit')[2]).toMatchObject({ f: 'C8-(C11)', num: 800 });
    expect(at('Operating Income')[2]).toMatchObject({ f: 'C15-(C14)', num: 500 });
    expect(at('Net Income')[2]).toMatchObject({ f: 'C16', num: 500 });
    expect(at('Net Profit Margin %')[2].f).toBe('IF((C8)=0,"",C17/(C8))');
    // Totals stand out; accounts do not.
    expect(at('Total Revenue')[2].s).not.toBe(at('41000')[2].s);
    // Every column is at least as wide as the title column's floor.
    expect(widths[1]).toBeGreaterThanOrEqual(24);
  });

  it('adds a row-wise SUM for the Total column of a by-month layout', async () => {
    const months = {
      org: 'Greens Global', generated_at: '2026-09-28', labels: {},
      rows: [
        { account_no: '41000', title: 'Rental Income', section: 'revenue', bucket: '2026-08-01', debit: 0, credit: 600 },
        { account_no: '41000', title: 'Rental Income', section: 'revenue', bucket: '2026-09-01', debit: 0, credit: 400 },
      ],
    };
    const r = await runReport({ getAccountingBuckets: async () => months }, resolveConfig({ ...defaultConfig(NOW), cols: 'month' }, NOW));
    const { rows } = statementCells({ title: 'Income Statement', result: r });
    const account = rows.find((row) => row[0]?.text === '41000');
    // C and D are the months, E the Total across the row.
    expect(account[4]).toMatchObject({ f: 'SUM(C6,D6)', num: 1000 });
  });

  it('writes a workbook Excel can open: styles, one sheet, frozen header, formulas in the XML', async () => {
    const r = await runReport(api, resolveConfig(defaultConfig(NOW), NOW));
    const bytes = await buildStatementWorkbook({ title: 'Income Statement', result: r });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter((f) => !f.endsWith('/')).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    expect(sheet).toContain('<f>SUM(C6:C7)</f>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<t xml:space="preserve">Rental Income</t>');
    const wb = await zip.file('xl/workbook.xml').async('string');
    expect(wb).toContain('name="Income Statement"');
    expect(wb).toContain('fullCalcOnLoad="1"');
  });
});
