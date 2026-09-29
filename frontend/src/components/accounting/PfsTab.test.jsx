import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';

// Render-smoke for Accounting -> PFS (Neil, Sep 25): a guarantor's statement
// for a date, the lines with where each figure comes from, a ledger line set
// up by picking an entity and its accounts, and the PDF it is produced into.

const meta = {
  assetCategories: [{ key: 'bank', label: 'Bank Accounts' }, { key: 'retirement', label: 'Retirement Accounts' }],
  liabilityCategories: [{ key: 'business_loan', label: 'Business Loans' }],
  realEstateKinds: [{ key: 'residential', label: 'Residential Real Estate' }, { key: 'commercial', label: 'Commercial Real Estate' }],
  historyQuestions: ['Have you ever filed for bankruptcy?'],
};
const profile = {
  id: 'p1', name: 'Test Guarantor', kind: 'joint', archived: false, photo: '', executiveProfile: 'Founder of the company.',
  details: { address: '1 Main St', ssn_last4: '6789', members: [{ name: 'First Person', role: 'Borrower' }, { name: 'Second Person', role: 'Spouse' }] },
  history: [{ question: 'Have you ever filed for bankruptcy?', answer: 'No', note: '' }],
  lines: [
    { id: 'l1', section: 'asset', category: 'bank', label: 'Operating Account', institution: 'Farmers & Merchants Bank', accountRef: '7546', ownershipPct: 7.5, source: 'ledger', ledgerEntity: '60100', ledgerAccounts: ['10100'], manualValue: 0, manualAsOf: '', details: {}, notes: '' },
    { id: 'l2', section: 'asset', category: 'retirement', label: 'Roth IRA', institution: 'Fidelity', accountRef: '', ownershipPct: 100, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 120000, manualAsOf: '2026-08-31', details: {}, notes: '' },
    { id: 'l3', section: 'real_estate', category: 'commercial', label: 'Storage Property', institution: '', accountRef: '', ownershipPct: 50, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 3000000, manualAsOf: '', details: { address: '1 Storage Way', legal_owner: 'Storage LLC', loan: { source: 'manual', value: 2000000 } }, notes: '' },
  ],
};
const row = (l, balance, extra = {}) => ({ id: l.id, label: l.label, institution: l.institution, accountRef: l.accountRef, ownershipPct: l.ownershipPct, balance, adjusted: Math.round(balance * l.ownershipPct) / 100, source: l.source, asOf: '2026-09-28', notes: '', details: l.details, ...extra });
const statement = {
  profile: { id: 'p1', name: 'Test Guarantor', kind: 'joint', details: profile.details, history: profile.history, executiveProfile: profile.executiveProfile },
  asOf: '2026-09-28',
  assets: [
    { key: 'bank', label: 'Bank Accounts', total: 75000, rows: [row(profile.lines[0], 1000000)] },
    { key: 'retirement', label: 'Retirement Accounts', total: 120000, rows: [row(profile.lines[1], 120000)] },
  ],
  liabilities: [],
  realEstate: [{ key: 'commercial', label: 'Commercial Real Estate', value: 1500000, loan: 1000000, rows: [row(profile.lines[2], 3000000, { value: 3000000, valueAdjusted: 1500000, loan: 2000000, loanAdjusted: 1000000, loanSource: 'manual', equity: 500000 })] }],
  summary: { assets: [{ label: 'Bank Accounts', amount: 75000 }, { label: 'Retirement Accounts', amount: 120000 }, { label: 'Real Estate (fair market value)', amount: 1500000 }], liabilities: [{ label: 'Real Estate Loans', amount: 1000000 }] },
  totals: { assets: 1695000, liabilities: 1000000, netWorth: 695000 },
  warnings: ['Operating Account: account 19999 has no balance in entity 60100 as of this date.'],
};

vi.mock('../../api', () => ({
  api: {
    getPfsMeta: vi.fn(async () => meta),
    getPfsProfiles: vi.fn(async () => [{ id: 'p1', name: 'Test Guarantor', kind: 'joint', archived: false }]),
    getPfsProfile: vi.fn(async () => profile),
    getPfsStatement: vi.fn(async () => statement),
    getPfsStatements: vi.fn(async () => [{ id: 's1', asOf: '2026-06-30', generatedBy: 'charmi@greensglobal.com', generatedAt: '2026-07-02T17:00:00Z', netWorth: 650000 }]),
    getPfsLedgerEntities: vi.fn(async () => ({ entities: [{ code: '60100', name: 'Business - ANK' }] })),
    getPfsLedgerAccounts: vi.fn(async () => ({ accounts: [{ code: '10100', title: 'Operating Chkg', section: 'asset', amount: 1000000 }, { code: '25000', title: 'Loan Payable', section: 'liability', amount: 400000 }] })),
    addPfsLine: vi.fn(async (id, body) => ({ id: 'new', ...body })),
    updatePfsProfile: vi.fn(async (id, body) => ({ id, ...body })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'charmi@greensglobal.com', name: 'Charmi Desai' }]),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'me@greensglobal.com' }) }));

import PfsTab from './PfsTab';
import { api } from '../../api';
import { buildPfsPdf } from './pfsPdf';

beforeEach(() => { vi.clearAllMocks(); });

describe('PfsTab', () => {
  it('opens on the statement: net worth, the summary, what was produced before', async () => {
    render(<PfsTab canEdit />);
    expect(await screen.findByText('695,000.00')).toBeTruthy();
    expect(screen.getAllByText('1,695,000.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Real Estate (fair market value)')).toBeTruthy();
    // A ledger account with no balance is said out loud, not silently counted as zero.
    expect(screen.getByText(/account 19999 has no balance/)).toBeTruthy();
    const past = screen.getByText('06/30/2026').closest('tr');
    expect(within(past).getByText('Charmi Desai')).toBeTruthy();      // a name, never an email
    expect(within(past).getByText('650,000.00')).toBeTruthy();
    expect(api.getPfsStatement).toHaveBeenCalledWith('p1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('shows each line with where its figure comes from', async () => {
    render(<PfsTab canEdit />);
    await screen.findByText('695,000.00');
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    const line = screen.getByText('Operating Account').closest('tr');
    expect(within(line).getByText(/Ledger · 60100 · 10100/)).toBeTruthy();
    expect(within(line).getByText('7.5%')).toBeTruthy();
    expect(within(line).getByText('1,000,000.00')).toBeTruthy();
    expect(within(line).getByText('75,000.00')).toBeTruthy();
    expect(within(screen.getByText('Roth IRA').closest('tr')).getByText(/Kept by hand · 08\/31\/2026/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Real Estate' }));
    const prop = screen.getByText('Storage Property').closest('tr');
    expect([...prop.cells].slice(3, 7).map((c) => c.textContent)).toEqual(['50%', '1,500,000.00', '1,000,000.00', '500,000.00']);
  });

  it('sets a line up from the ledger: an entity, then its accounts', async () => {
    render(<PfsTab canEdit />);
    await screen.findByText('695,000.00');
    fireEvent.click(screen.getByRole('button', { name: 'Liabilities' }));
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'F&M Bank Loan' } });
    fireEvent.change(within(dialog).getByLabelText('Share Owned (%)'), { target: { value: '7.5' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'From the Ledger' }));
    expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);   // nothing to read yet
    fireEvent.change(await within(dialog).findByLabelText('Entity'), { target: { value: '60100' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /25000/ }));
    expect(within(dialog).getByText(/1 picked · 400,000.00/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.addPfsLine).toHaveBeenCalled());
    expect(api.addPfsLine.mock.calls[0][1]).toMatchObject({ section: 'liability', category: 'business_loan', label: 'F&M Bank Loan', ownershipPct: 7.5, source: 'ledger', ledgerEntity: '60100', ledgerAccounts: ['25000'] });
  });

  it('keeps only four digits of a Social Security number', async () => {
    render(<PfsTab canEdit />);
    await screen.findByText('695,000.00');
    fireEvent.click(screen.getByRole('button', { name: 'Borrower' }));
    const ssn = screen.getByLabelText('Social Security Number - Last 4 Digits');
    fireEvent.change(ssn, { target: { value: '123-45-6789' } });
    expect(ssn.value).toBe('1234');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
    expect(api.updatePfsProfile.mock.calls[0][1].details.ssn_last4).toBe('1234');
  });

  it('is read-only without the editor level', async () => {
    render(<PfsTab canEdit={false} />);
    await screen.findByText('695,000.00');
    expect(screen.queryByRole('button', { name: /New Guarantor/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change Operating Account/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Produce PDF/ })).toBeTruthy();
  });
});

describe('the PFS PDF', () => {
  it('prints every section and a place to sign', async () => {
    const bytes = await buildPfsPdf({ statement, preparedBy: 'Charmi Desai' });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    // cover, borrower, assets, real estate, summary, history, executive profile (no liabilities listed)
    expect(doc.getPageCount()).toBe(7);
    expect(doc.getTitle()).toBe('Personal Financial Statement - Test Guarantor');
  });

  it('prints with a photo that cannot be read, and with nothing listed', async () => {
    const empty = { ...statement, assets: [], liabilities: [], realEstate: [], summary: { assets: [], liabilities: [] }, totals: { assets: 0, liabilities: 0, netWorth: 0 }, profile: { ...statement.profile, history: [], executiveProfile: '', details: {} } };
    const bytes = await buildPfsPdf({ statement: empty, photo: 'data:image/jpeg;base64,not-an-image' });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);   // cover, borrower, summary
  });
});
