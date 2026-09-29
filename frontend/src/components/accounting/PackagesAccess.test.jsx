import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';

// Render-smoke for Accounting -> Packages and Accounting -> Access, and the
// PDF a package is built into (Neil, Sep 25).

const reports = [
  { id: 'r1', name: 'Income Statement - Valley Center - Last Quarter', config: { report: 'pnl', preset: 'last-quarter', book: 'accrual', entities: ['15000'] }, shared: false, mine: true, owner: 'me@greensglobal.com' },
  { id: 'r2', name: 'Balance Sheet - Valley Center', config: { report: 'balance-sheet', book: 'accrual', entities: ['15000'] }, shared: true, mine: true, owner: 'me@greensglobal.com' },
];
const packages = [
  { id: 'p1', name: 'F&M Bank - Valley Center', description: 'Prepared for Farmers & Merchants Bank', shared: false, mine: true, owner: 'me@greensglobal.com',
    items: [{ reportId: 'r2', title: '', missing: false }, { reportId: 'gone', title: 'Rent Roll', missing: true }] },
];
const statement = {
  org: 'Greens Global', generated_at: '2026-09-28',
  sections: [{ key: 'revenue', label: 'Revenue', total: 1500, accounts: [{ account_no: '41000', title: 'Rental Income', amount: 1000 }, { account_no: '41100', title: 'Parking Income', amount: 500 }] }],
  totals: { gross_profit: 1500, operating_income: 1500, net_income: 1500, liabilities_and_equity: 0, difference: 0 },
};

vi.mock('../../api', () => ({
  api: {
    getAccountingPackages: vi.fn(async () => packages),
    getAccountingSavedReports: vi.fn(async () => reports),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido', parent_code: null }, { code: '15900', name: 'Escondido Annex', parent_code: '15000' }, { code: '90000', name: 'Family Trust', parent_code: null }] })),
    createAccountingPackage: vi.fn(async (body) => ({ id: 'p2', mine: true, owner: 'me@greensglobal.com', ...body })),
    updateAccountingPackage: vi.fn(async (id, body) => ({ id, mine: true, owner: 'me@greensglobal.com', ...body })),
    getAccountingPnl: vi.fn(async () => statement),
    getAccountingBalanceSheet: vi.fn(async () => statement),
    getAccountingAccess: vi.fn(async () => ({ people: [
      { email: 'urmi.gor@greensglobal.com', level: 'viewer', hasGrant: true, entities: ['15000'] },
      { email: 'priyanka.sahu@greensglobal.com', level: 'editor', hasGrant: true, entities: [] },
    ] })),
    setAccountingAccess: vi.fn(async (email, entities) => ({ email, entities })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'urmi.gor@greensglobal.com', name: 'Urmi Gor' }, { email: 'priyanka.sahu@greensglobal.com', name: 'Priyanka Sahu' }]),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'me@greensglobal.com' }) }));

import PackagesTab from './PackagesTab';
import AccessTab from './AccessTab';
import { api } from '../../api';
import { buildPackagePdf } from './reportPdf';
import { resolveConfig, runReport } from './reportModel';

beforeEach(() => { vi.clearAllMocks(); });

describe('PackagesTab', () => {
  it('opens a package, shows a statement that is no longer available, and saves a change', async () => {
    render(<PackagesTab />);
    const name = await screen.findByLabelText('Package Name');
    expect(name.value).toBe('F&M Bank - Valley Center');
    expect(screen.getByText(/It is left out of the PDF/)).toBeTruthy();
    expect(screen.getByText('1 statement is no longer available')).toBeTruthy();
    // Nothing to save yet; Build PDF is ready.
    expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Build PDF/ }).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Add a memorized report'), { target: { value: 'r1' } });
    expect(screen.getByRole('button', { name: /Build PDF/ }).disabled).toBe(true);   // save first
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updateAccountingPackage).toHaveBeenCalled());
    // The statement that is gone is not written back.
    expect(api.updateAccountingPackage.mock.calls[0]).toEqual(['p1', {
      name: 'F&M Bank - Valley Center', description: 'Prepared for Farmers & Merchants Bank', shared: false,
      items: [{ reportId: 'r2', title: '' }, { reportId: 'r1', title: '' }],
    }]);
  });

  it('starts a new package', async () => {
    render(<PackagesTab />);
    await screen.findByLabelText('Package Name');
    fireEvent.click(screen.getByRole('button', { name: /New Package/ }));
    expect(screen.getByLabelText('Package Name').value).toBe('');
    fireEvent.change(screen.getByLabelText('Package Name'), { target: { value: 'Quarterly Lender Package' } });
    fireEvent.change(screen.getByLabelText('Add a memorized report'), { target: { value: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Package' }));
    await waitFor(() => expect(api.createAccountingPackage).toHaveBeenCalledWith({ name: 'Quarterly Lender Package', description: '', shared: false, items: [{ reportId: 'r2', title: '' }] }));
  });
});

describe('the package PDF', () => {
  it('has a cover and a page per statement, landscape for a comparison', async () => {
    const plain = await runReport(api, resolveConfig({ report: 'pnl', preset: 'last-quarter', entities: ['15000'] }));
    const compared = await runReport(api, resolveConfig({ report: 'pnl', preset: 'ytd', compare: 'prior-year' }));
    const bytes = await buildPackagePdf({
      name: 'F&M Bank - Valley Center - Quarterly Package', description: 'Prepared for Farmers & Merchants Bank', preparedBy: 'Charmi Desai',
      statements: [{ title: 'Income Statement', result: plain, entities: [] }, { title: 'Income Statement vs Prior Year', result: compared, entities: [] }],
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    const sizes = doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
    expect(sizes).toEqual([[612, 792], [612, 792], [792, 612]]);
    expect(doc.getTitle()).toBe('F&M Bank - Valley Center - Quarterly Package');
  });

  it('runs a long statement onto more pages and survives odd characters', async () => {
    const long = {
      ...statement,
      sections: [{ key: 'expense', label: 'Operating Expenses', total: 1, accounts: Array.from({ length: 140 }, (_, i) => ({ account_no: String(60000 + i), title: `Professional Fees ${String.fromCharCode(0x2013)} ${String.fromCharCode(0x201c)}quoted${String.fromCharCode(0x201d)} ${String.fromCharCode(0x4e2d)} ${i}`, amount: i - 20 })) }],
    };
    api.getAccountingPnl.mockResolvedValueOnce(long);
    const result = await runReport(api, resolveConfig({ report: 'pnl' }));
    const bytes = await buildPackagePdf({ name: 'Long', statements: [{ title: 'Income Statement', result, entities: [] }], cover: false });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
  });
});

describe('AccessTab', () => {
  it('lists the team by name and limits a person to entities', async () => {
    render(<AccessTab />);
    const row = (await screen.findByText('Urmi Gor')).closest('tr');
    expect(within(row).getByText('Greens Escondido')).toBeTruthy();
    expect(within(row).getByText('Viewer')).toBeTruthy();
    const other = screen.getByText('Priyanka Sahu').closest('tr');
    expect(within(other).getByText('All entities')).toBeTruthy();
    // Never a raw email address.
    expect(screen.queryByText(/@greensglobal\.com/)).toBeNull();

    fireEvent.click(within(other).getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog', { name: /Entities Priyanka Sahu can read/i });
    fireEvent.click(within(dialog).getByLabelText(/Only the entities picked below/));
    expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);   // nothing picked yet
    fireEvent.click(within(dialog).getByRole('option', { name: /Family Trust/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setAccountingAccess).toHaveBeenCalledWith('priyanka.sahu@greensglobal.com', ['90000']));
  });

  it('lifts a limit', async () => {
    render(<AccessTab />);
    const row = (await screen.findByText('Urmi Gor')).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Change' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/All entities/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setAccountingAccess).toHaveBeenCalledWith('urmi.gor@greensglobal.com', []));
  });
});
