import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

// Render-smoke for Accounting -> PFS (Neil, Sep 25): a guarantor's statement
// for a date, the lines with where each figure comes from, a ledger line set
// up by picking an entity and its accounts, and the PDF it is produced into.
// Oct 2 (Charmi + Neil): Move to..., real estate from the ledger with its
// mortgage, a co-borrower, a guarantor prefilled from People, jewelry, and
// the Excel workbook.

// Oct 6 (Charmi, 10/03-10/04): the first page (Statement of Financial
// Condition), one Export menu, the bank as the Institution, Cash first,
// Vehicles, Jewelry folded into Personal Holdings, rows in order, a skeleton.
// Oct 7 (Neil + Charmi): the tab order without Schedules, the guarantor
// dropdown with both names, the co-borrower photo, the entity picker, the
// share from Affiliated Entities, the Liabilities sections, Investments, the
// account number once, "Not found - Set It", whole-row drag, Select All, the
// password-protected PDF.
const meta = {
  assetCategories: [{ key: 'cash', label: 'Cash' }, { key: 'bank', label: 'Bank Accounts' }, { key: 'retirement', label: 'Retirement Accounts' }, { key: 'investment', label: 'Investment Accounts' }, { key: 'business', label: 'Business Interests' }, { key: 'vehicles', label: 'Vehicles' }, { key: 'personal', label: 'Personal Holdings' }, { key: 'other_holding', label: 'Other Holdings' }],
  liabilityCategories: [{ key: 'business_loan', label: 'Commercial Loans' }, { key: 'residential_loan', label: 'Residential Loans' }, { key: 'credit_card', label: 'Credit Cards' }],
  retiredCategories: [{ key: 'contingent', label: 'Contingent Liabilities' }],
  realEstateKinds: [{ key: 'residential', label: 'Residential Real Estate' }, { key: 'commercial', label: 'Commercial Real Estate' }],
  historyQuestions: ['Have you ever filed for bankruptcy?'],
};
const profile = {
  id: 'p1', name: 'Test Guarantor', kind: 'joint', archived: false, photo: '', executiveProfile: 'Founder of the company.',
  details: { address: '1 Main St', ssn_last4: '6789', members: [{ name: 'First Person', role: 'Borrower' }, { name: 'Second Person', role: 'Spouse' }] },
  history: [{ question: 'Have you ever filed for bankruptcy?', answer: 'No', note: '' }],
  lines: [
    // Set up before Oct 6: the entity's name kept as the Institution. Its share follows Affiliated Entities (Oct 7).
    { id: 'l1', section: 'asset', category: 'bank', label: 'Operating Account', institution: 'Neil & Archana Kadakia', accountRef: '7546', ownershipPct: 7.5, source: 'ledger', ledgerEntity: '60100', ledgerAccounts: ['10100'], manualValue: 0, manualAsOf: '', details: { shareFrom: 'affiliated' }, notes: '',
      shareFrom: 'affiliated', affiliatedShare: { pct: 7.5, basis: 'ownership', text: 'Test Guarantor 5% + Second Person 2.5%', parts: [] } },
    { id: 'l2', section: 'asset', category: 'retirement', label: 'Roth IRA', institution: 'Fidelity', accountRef: '', ownershipPct: 100, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 120000, manualAsOf: '2026-08-31', details: {}, notes: '' },
    { id: 'l4', section: 'asset', category: 'bank', label: 'Chase Checking - 6532', institution: '', accountRef: '6532', ownershipPct: 100, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 0, manualAsOf: '', details: {}, notes: '' },
    { id: 'l3', section: 'real_estate', category: 'commercial', label: 'Storage Property', institution: '', accountRef: '', ownershipPct: 50, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 3000000, manualAsOf: '', details: { address: '1 Storage Way', legal_owner: 'Storage LLC', loan: { source: 'ledger', entity: '15000', accounts: ['25100'] } }, notes: '' },
    // A guarantee kept before Oct 7, when Contingent Liabilities was a section.
    { id: 'l5', section: 'liability', category: 'contingent', label: 'Guarantee - Storage LLC loan', institution: 'F&M Bank', accountRef: '', ownershipPct: 50, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 2500000, manualAsOf: '', details: {}, notes: '' },
  ],
};
const row = (l, balance, extra = {}) => ({ id: l.id, label: l.label, institution: l.institution, accountRef: l.accountRef, ownershipPct: l.ownershipPct, balance, adjusted: Math.round(balance * l.ownershipPct) / 100, source: l.source, asOf: '2026-09-28', notes: '', details: l.details, ...extra });
const statement = {
  profile: { id: 'p1', name: 'Test Guarantor', kind: 'joint', details: profile.details, history: profile.history, executiveProfile: profile.executiveProfile },
  asOf: '2026-09-28',
  assets: [
    // The statement reads the bank from the account linked to the GL (Oct 6); none was found for Chase (Oct 7).
    { key: 'bank', label: 'Bank Accounts', total: 75000, rows: [row(profile.lines[0], 1000000, { institution: 'Farmers & Merchants Bank' }), row(profile.lines[2], 0, { institutionMissing: true })] },
    { key: 'retirement', label: 'Retirement Accounts', total: 120000, rows: [row(profile.lines[1], 120000)] },
  ],
  liabilities: [],
  realEstate: [{ key: 'commercial', label: 'Commercial Real Estate', value: 1500000, loan: 1000000, rows: [row(profile.lines[3], 3000000, { value: 3000000, valueAdjusted: 1500000, loan: 2000000, loanAdjusted: 1000000, loanSource: 'ledger', equity: 500000 })] }],
  summary: { assets: [{ label: 'Bank Accounts', amount: 75000 }, { label: 'Retirement Accounts', amount: 120000 }, { label: 'Real Estate (fair market value)', amount: 1500000 }], liabilities: [{ label: 'Real Estate Loans', amount: 1000000 }] },
  totals: { assets: 1695000, liabilities: 1000000, netWorth: 695000 },
  condition: {
    assets: [
      { key: 'cash', label: 'Cash on Hand', ownership: '', count: 0, amount: 0 },
      { key: 'bank', label: 'Bank Accounts / Cash Equivalents', ownership: '7.5%', count: 1, amount: 75000 },
      { key: 'securities', label: 'Marketable Securities', ownership: '', count: 0, amount: 0 },
      { key: 'retirement', label: 'Retirement Accounts', ownership: '100%', count: 1, amount: 120000 },
      { key: 'real_estate', label: 'Real Estate', ownership: '50%', count: 1, amount: 1500000 },
      { key: 'vehicles', label: 'Vehicles', ownership: '', count: 0, amount: 0 },
      { key: 'personal', label: 'Personal Holdings', ownership: '', count: 0, amount: 0 },
    ],
    liabilities: [
      { key: 'notes_banks', label: 'Notes Payable to Banks', ownership: '', count: 0, amount: 0 },
      { key: 'mortgages', label: 'Mortgages on Real Estate', ownership: '50%', count: 1, amount: 1000000 },
    ],
    totals: { assets: 1695000, liabilities: 1000000 },
    contingent: [{ label: 'Guarantee - Storage LLC loan', institution: 'F&M Bank', ownershipPct: 50, amount: 2500000, notes: '' }],
    contingentAnswer: { answer: 'Yes', note: '' },
    income: { year: '2026', lines: [{ key: 'rental', label: 'Net Rental Income (Schedule E)', amount: 8850 }], total: 8850 },
  },
  schedules: {
    year: '2026',
    e: [{ lineId: 'l3', label: 'Storage Property', entity: '15000', year: '2026', ownershipPct: 50, address: '1 Storage Way', income: 120000, cogs: 0, expenses: 102300, net: 17700, netAtShare: 8850,
      lines: [{ key: 'management', label: 'Management Fees', amount: 9600, accounts: [{ code: '60100', title: 'Property Management Fees', amount: 9600 }] }, { key: 'mortgage_interest', label: 'Mortgage Interest', amount: 42000, accounts: [{ code: '60400', title: 'Mortgage Interest', amount: 42000 }] }, { key: 'other', label: 'Other', amount: 50700, accounts: [] }] }],
    c: [],
  },
  warnings: ['Operating Account: account 19999 has no balance in entity 60100 as of this date.'],
};
const investments = {
  label: 'Investments', total: 515000, assetKeys: ['investment', 'business'], realEstate: { value: 1500000, loans: 1000000, equity: 500000 },
  note: 'Real estate is shown here at equity (market value less loans, at the share owned).',
  groups: [
    { key: 'investment', label: 'Investment Accounts', total: 15000, rows: [{ id: 'i1', label: 'Schwab Brokerage', accountRef: '', institution: 'Schwab', ownershipPct: 100, balance: 15000, adjusted: 15000, details: {} }] },
    { key: 'real_estate_equity', label: 'Real Estate', total: 500000, rows: [{ id: 'l3', label: 'Storage Property', category: 'commercial', categoryLabel: 'Commercial Real Estate', ownershipPct: 50, valueAdjusted: 1500000, loanAdjusted: 1000000, equity: 500000, details: {} }] },
  ],
};
const ENTITIES = [
  { code: '60100', name: 'Business - ANK' },
  { code: '12000', name: 'Greens Global Inc' },
  { code: '62005', name: 'Old Circle (H)' },
];

vi.mock('../../api', () => ({
  api: {
    getPfsMeta: vi.fn(async () => meta),
    getPfsProfiles: vi.fn(async () => [
      { id: 'p1', name: 'Test Guarantor', displayName: 'Test Guarantor and Second Person', kind: 'joint', archived: false },
      { id: 'p9', name: 'Closed File', displayName: 'Closed File', kind: 'individual', archived: true },
    ]),
    getPfsProfile: vi.fn(async () => profile),
    getPfsStatement: vi.fn(async () => statement),
    getPfsStatements: vi.fn(async () => [{ id: 's1', asOf: '2026-06-30', generatedBy: 'charmi@greensglobal.com', generatedAt: '2026-07-02T17:00:00Z', netWorth: 650000 }]),
    getPfsSavedStatement: vi.fn(async () => ({ ...statement, id: 's1', generatedBy: 'charmi@greensglobal.com' })),
    producePfsStatement: vi.fn(async () => ({ id: 's2', ...statement })),
    getPfsLedgerEntities: vi.fn(async () => ({ entities: ENTITIES })),
    getPfsLedgerAccounts: vi.fn(async () => ({ accounts: [
      { code: '10100', title: 'Operating Chkg -7546', section: 'asset', amount: 1000000, suggested: { section: 'asset', category: 'bank' } },
      { code: '11301', title: 'NRK & ANK - F&M - 6870', section: 'asset', amount: 12000, suggested: { section: 'asset', category: 'bank' } },
      { code: '11309', title: 'ANK - 401K - Fidelity - 6165', section: 'asset', amount: 327.85, suggested: { section: 'asset', category: 'retirement' } },
      { code: '11348', title: 'WeBull Brokerage Account', section: 'asset', amount: 101, suggested: { section: 'asset', category: 'investment' } },
      { code: '15200', title: 'Building - Escondido', section: 'asset', amount: 1600000, suggested: { section: 'real_estate', category: 'commercial' } },
      { code: '25000', title: 'Loan Payable', section: 'liability', amount: 400000, suggested: { section: 'liability', category: 'business_loan' } },
      { code: '25100', title: 'Mortgage - Escondido', section: 'liability', amount: 1200000, suggested: { section: 'liability', category: 'business_loan' } },
    ] })),
    getPfsAffiliatedShares: vi.fn(async () => ({ shares: {}, resolved: {} })),
    getPfsShareMismatches: vi.fn(async () => ({ lines: [], count: 0 })),
    resolvePfsShareMismatches: vi.fn(async (id, ids) => ({ updated: ids.length, lines: [] })),
    encryptPfsPdf: vi.fn(async () => ({ pdf: btoa('%PDF-1.7 encrypted'), encryption: 'AES-256' })),
    addPfsLine: vi.fn(async (id, body) => ({ id: 'new', ...body })),
    updatePfsLine: vi.fn(async (id, lineId, body) => ({ id: lineId, ...body })),
    addPfsLinesBulk: vi.fn(async (id, body) => ({ added: body.accounts.length, lines: [] })),
    movePfsLine: vi.fn(async (id, lineId, section, category) => ({ id: lineId, section, category })),
    reorderPfsLines: vi.fn(async (id, ids) => ({ ok: true, ids })),
    getPfsExecutiveProfiles: vi.fn(async () => ({ profiles: [{ key: 'primary', name: 'Test Guarantor', text: 'Founder of the company.' }, { key: 'co', name: 'Second Person', text: '' }] })),
    savePfsExecutiveProfile: vi.fn(async () => ({ profiles: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    updatePfsProfile: vi.fn(async (id, body) => ({ id, ...body })),
    createPfsProfile: vi.fn(async (body) => ({ id: 'p2', ...body })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => [{ email: 'charmi@greensglobal.com', name: 'Charmi Desai', companyName: 'Greens Global' }, { email: 'sahil@greensglobal.com', name: 'Sahil Desai', companyName: 'Greens Global' }]),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'me@greensglobal.com' }) }));
vi.mock('./reportModel', async (importOriginal) => ({ ...(await importOriginal()), downloadBlob: vi.fn() }));

import PfsTab from './PfsTab';
import { api } from '../../api';
import { buildPfsPdf } from './pfsPdf';
import { buildPfsWorkbook, pfsSheets } from './pfsXlsx';
import { downloadBlob } from './reportModel';

beforeEach(() => { vi.clearAllMocks(); try { localStorage.clear(); } catch { /* none */ } });

// The statement has loaded when its first page is on screen.
const loaded = () => screen.findByRole('region', { name: 'Statement of Financial Condition' });
const tab = (name) => fireEvent.click(screen.getByRole('button', { name }));
// The module's entity picker: open it, search, pick (Oct 7, items 7 / 12 / 14).
const pickEntity = async (scope, name, query, option) => {
  fireEvent.click(await within(scope).findByRole('button', { name }));
  fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: query } });
  fireEvent.click(screen.getByRole('option', { name: option || new RegExp(query) }));
};

describe('PfsTab', () => {
  it('opens on the statement: the first page, net worth, what was produced before', async () => {
    render(<PfsTab canEdit />);
    const page = await loaded();
    expect(within(page).getAllByText('695,000.00').length).toBeGreaterThan(0);
    expect(within(page).getAllByText('1,695,000.00').length).toBeGreaterThan(0);
    // Every line of a bank's form, in its words, with the share owned (Charmi, 10/04).
    const bank = within(page).getByText('Bank Accounts / Cash Equivalents').closest('tr');
    expect([...bank.cells].map((c) => c.textContent)).toEqual(['Bank Accounts / Cash Equivalents', '7.5%', '75,000.00']);
    expect([...within(page).getByText('Cash on Hand').closest('tr').cells].map((c) => c.textContent)).toEqual(['Cash on Hand', '', '-']);
    expect(within(within(page).getByText('Mortgages on Real Estate').closest('tr')).getByText('1,000,000.00')).toBeTruthy();
    expect(within(within(page).getByText('Total Liabilities and Net Worth').closest('tr')).getByText('1,695,000.00')).toBeTruthy();
    // Guarantees are listed, never totaled in; the year's income from the schedules.
    expect(within(within(page).getByText('Guarantee - Storage LLC loan').closest('tr')).getByText('2,500,000.00')).toBeTruthy();
    expect(within(within(page).getByText('Net Rental Income (Schedule E)').closest('tr')).getByText('8,850.00')).toBeTruthy();
    // A ledger account with no balance is said out loud, not silently counted as zero.
    expect(screen.getByText(/account 19999 has no balance/)).toBeTruthy();
    const past = screen.getByText('06/30/2026').closest('tr');
    expect(within(past).getByText('Charmi Desai')).toBeTruthy();      // a name, never an email
    expect(within(past).getByText('650,000.00')).toBeTruthy();
    expect(within(past).getByRole('button', { name: 'Open Excel' })).toBeTruthy();
    expect(api.getPfsStatement).toHaveBeenCalledWith('p1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('has the tabs in Neil\'s order and no Schedules tab (Oct 7)', async () => {
    const { container } = render(<PfsTab canEdit />);
    await loaded();
    const tabs = [...container.querySelector('.scroll-tabs').querySelectorAll('button')].map((b) => b.textContent);
    expect(tabs).toEqual(['Statement', 'Borrower(s)', 'Affiliated Entities', 'History and Profile', 'Assets', 'Liabilities', 'Real Estate']);
    expect(screen.queryByRole('button', { name: 'Schedules' })).toBeNull();
    // The left Guarantors panel and its lock explanation are gone.
    expect(screen.queryByText(/Only owners and people granted this screen/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Access Log' })).toBeTruthy();
  });

  it('picks a guarantor from a dropdown that shows both names and the lock', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    const button = screen.getByRole('button', { name: /Test Guarantor and Second Person/ });
    expect(within(button).getByRole('img', { name: 'Open in this tab' })).toBeTruthy();
    fireEvent.click(button);
    const menu = screen.getByRole('dialog', { name: 'Guarantors' });
    const options = within(menu).getAllByRole('option');
    expect(options.map((o) => o.title)).toEqual(['Test Guarantor and Second Person', 'Closed File']);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].textContent).toContain('Archived');
    expect(options[1].style.opacity).toBe('0.55');
    expect(within(options[1]).getByRole('img')).toBeTruthy();
    // "+ New Guarantor" for editors, at the end of the list.
    fireEvent.click(within(menu).getByRole('button', { name: /New Guarantor/ }));
    expect(screen.getByRole('dialog', { name: 'New guarantor' })).toBeTruthy();
  });

  it('shows each line with where its figure comes from', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    const line = screen.getByText('Operating Account').closest('tr');
    expect(within(line).getByText(/Ledger · 60100 · 10100/)).toBeTruthy();
    expect(within(line).getByText('7.5%')).toBeTruthy();
    expect(within(line).getByText('1,000,000.00')).toBeTruthy();
    expect(within(line).getByText('75,000.00')).toBeTruthy();
    expect(within(screen.getByText('Roth IRA').closest('tr')).getByText(/Kept by hand · 08\/31\/2026/)).toBeTruthy();
    // The Institution is the bank the statement read, never the entity kept from the old setup (Charmi, 10/03).
    expect(within(line).getByText('Farmers & Merchants Bank')).toBeTruthy();
    expect(within(line).queryByText('Neil & Archana Kadakia')).toBeNull();
    // Where the share comes from, on hover (Oct 7, item 28).
    const owned = within(line).getByText('7.5%').closest('td');
    expect(owned.title).toBe('From Affiliated Entities: Test Guarantor 5% + Second Person 2.5%');
    expect(within(owned).getByText('Affiliated')).toBeTruthy();
    expect(within(screen.getByText('Roth IRA').closest('tr')).getByText('100%').closest('td').title).toBe('Typed by hand');
    // Cash first; Vehicles; no Jewelry section - it is Personal Holdings now (Oct 6).
    const cards = screen.getAllByText(/^(Cash|Bank Accounts|Vehicles|Personal Holdings|Jewelry & Personal Property|Other Holdings)$/).map((e) => e.textContent);
    expect(cards).toEqual(['Cash', 'Bank Accounts', 'Vehicles', 'Personal Holdings', 'Other Holdings']);

    tab('Real Estate');
    const prop = screen.getByText('Storage Property').closest('tr');
    expect([...prop.cells].slice(4, 8).map((c) => c.textContent)).toEqual(['50%', '1,500,000.00', '1,000,000.00', '500,000.00']);
  });

  it('prints the account number once (Charmi, Oct 7)', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    const chase = screen.getByText('Chase Checking - 6532').closest('tr');
    expect(within(chase).getAllByText(/6532/)).toHaveLength(1);
    expect(chase.querySelector('.acct-code')).toBeNull();
    // A label without the number still shows it.
    expect(within(screen.getByText('Operating Account').closest('tr')).getByText('7546')).toBeTruthy();
  });

  it('offers "Not found - Set It" where no bank was found, opening the editor at Institution', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    const chase = screen.getByText('Chase Checking - 6532').closest('tr');
    fireEvent.click(within(chase).getByRole('button', { name: 'Not found - Set It' }));
    const dialog = screen.getByRole('dialog', { name: 'Change Chase Checking - 6532' });
    const inst = within(dialog).getByLabelText('Institution');
    expect(document.activeElement).toBe(inst);
    fireEvent.change(inst, { target: { value: 'JPMorgan Chase' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePfsLine).toHaveBeenCalled());
    expect(api.updatePfsLine.mock.calls[0][2]).toMatchObject({ institution: 'JPMorgan Chase', details: { institutionManual: true } });
  });

  it('groups Investment Accounts, Business Interests and real estate at equity under Investments', async () => {
    api.getPfsStatement.mockResolvedValueOnce({ ...statement, investments });
    render(<PfsTab canEdit />);
    const page = await loaded();
    // The Statement tab has the block too, with its subtotal.
    const onStatement = screen.getByRole('region', { name: 'Investments' });
    expect(page.contains(onStatement)).toBe(false);
    expect(within(within(onStatement).getByText('Real Estate (Equity)').closest('tr')).getByText('500,000.00')).toBeTruthy();
    expect(within(within(onStatement).getAllByText('Total Investments').pop().closest('tr')).getByText('515,000.00')).toBeTruthy();

    tab('Assets');
    const block = screen.getByRole('region', { name: 'Investments' });
    expect(within(block).getByText('Investment Accounts')).toBeTruthy();
    expect(within(block).getByText('Business Interests')).toBeTruthy();
    const prop = within(block).getByRole('button', { name: 'Storage Property' }).closest('tr');
    expect([...prop.cells].slice(1).map((c) => c.textContent)).toEqual(['50%', '1,500,000.00', '1,000,000.00', '500,000.00']);
    expect(within(block).getAllByText('515,000.00').length).toBeGreaterThan(0);
    // Investment Accounts is listed once - inside Investments, not again on its own.
    expect(screen.getAllByText('Investment Accounts')).toHaveLength(1);
    fireEvent.click(within(block).getByRole('button', { name: 'Open Real Estate' }));
    expect(screen.getByRole('button', { name: 'Real Estate' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('lists the Liabilities sections from the server, a retired Contingent line read-only', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Liabilities');
    const headings = screen.getAllByText(/^(Commercial Loans|Residential Loans|Credit Cards|Contingent Liabilities \(Retired\))$/).map((e) => e.textContent);
    expect(headings).toEqual(['Commercial Loans', 'Residential Loans', 'Credit Cards', 'Contingent Liabilities (Retired)']);
    const kept = screen.getByText('Guarantee - Storage LLC loan').closest('tr');
    expect(within(kept).queryByRole('button')).toBeNull();
    // Nothing offers Contingent for a line any more.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(within(dialog).getByLabelText('Listed Under')).queryByRole('option', { name: /Contingent/ })).toBeNull();
  });

  it('puts the rows of a section in order, kept for the guarantor', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    expect(screen.getByRole('button', { name: 'Move Operating Account up' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Chase Checking - 6532 up' }));
    await waitFor(() => expect(api.reorderPfsLines).toHaveBeenCalledWith('p1', ['l4', 'l1']));
    // The statement is read again, so every figure and file follows the new order.
    await waitFor(() => expect(api.getPfsStatement).toHaveBeenCalledTimes(2));
  });

  it('drags a whole row onto another (Charmi: "the rows are not draggable")', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    const first = screen.getByText('Operating Account').closest('tr');
    const second = screen.getByText('Chase Checking - 6532').closest('tr');
    expect(second.getAttribute('draggable')).toBe('true');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(second, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'l4');
    // The drop target is the row itself - any cell of it.
    fireEvent.dragOver(first.cells[3], { dataTransfer });
    fireEvent.drop(first.cells[3], { dataTransfer });
    await waitFor(() => expect(api.reorderPfsLines).toHaveBeenCalledWith('p1', ['l4', 'l1']));
    // A row alone in its category does not drag.
    expect(screen.getByText('Roth IRA').closest('tr').getAttribute('draggable')).toBeNull();
  });

  it('shows a skeleton while the statement is read', async () => {
    let finish;
    api.getPfsStatement.mockImplementationOnce(() => new Promise((ok) => { finish = ok; }));
    render(<PfsTab canEdit />);
    expect(await screen.findByLabelText('Loading the statement')).toBeTruthy();
    finish(statement);
    await loaded();
    expect(screen.queryByLabelText('Loading the statement')).toBeNull();
  });

  it('exports through one menu, the one Reports has: PDF, Excel, Email, Save to Files', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    expect(screen.queryByRole('button', { name: /Produce/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const menu = screen.getByRole('menu', { name: 'Export' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Email/ }));
    // The PDF's password first (optional), then the send dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const dialog = screen.getByRole('dialog', { name: 'Email This Statement' });
    // A personal financial statement goes out as PDF or Excel, never CSV.
    expect(within(dialog).getAllByRole('radio').map((r) => r.textContent)).toEqual(['PDF', 'Excel']);
    expect(within(dialog).getByLabelText('File Name').value).toMatch(/^PFS_Test-Guarantor_\d{4}-\d{2}-\d{2}$/);
  });

  it('protects the PDF with a password typed at export, sent once to be encrypted, never kept', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^PDF/ }));
    const form = screen.getByRole('form', { name: 'PDF Password' });
    expect(within(form).getByText(/for example the main guarantor's Social Security number - it is never saved/)).toBeTruthy();
    const box = within(form).getByLabelText('Protect With a Password');
    expect(box.type).toBe('password');
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(within(form).getByRole('button', { name: 'Download PDF' }).disabled).toBe(true);    // 4 characters at least
    fireEvent.change(box, { target: { value: '123-45-6789' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(api.encryptPfsPdf).toHaveBeenCalled());
    const [id, body] = api.encryptPfsPdf.mock.calls[0];
    expect(id).toBe('p1');
    expect(body.password).toBe('123-45-6789');
    expect(body.statementId).toBe('s2');
    expect(atob(body.pdf).slice(0, 5)).toBe('%PDF-');
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const blob = downloadBlob.mock.calls[0][1];
    expect(await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsText(blob); })).toBe('%PDF-1.7 encrypted');
    await screen.findByText('PDF produced, protected with the password, and the statement kept on record.');
    // The next export starts without it.
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^PDF/ }));
    expect(screen.getByLabelText('Protect With a Password').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(2));
    expect(api.encryptPfsPdf).toHaveBeenCalledTimes(1);
  });

  it('sets a line up from the ledger: an entity, then its accounts', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Liabilities');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'F&M Bank Loan' } });
    fireEvent.change(within(dialog).getByLabelText('Share Owned (%)'), { target: { value: '7.5' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'From the Ledger' }));
    expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);   // nothing to read yet
    await pickEntity(dialog, 'Entity', '60100');
    fireEvent.click(await within(dialog).findByRole('option', { name: /25000/ }));
    // The figure sits in its own <Amount /> span (tabular, reserved ) slot), so read the whole line.
    expect(within(dialog).getByText(/1 picked ·/).textContent).toBe('1 picked · 400,000.00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.addPfsLine).toHaveBeenCalled());
    expect(api.addPfsLine.mock.calls[0][1]).toMatchObject({ section: 'liability', category: 'business_loan', label: 'F&M Bank Loan', ownershipPct: 7.5, source: 'ledger', ledgerEntity: '60100', ledgerAccounts: ['25000'], details: { shareFrom: 'manual' } });
  });

  it('a single new line takes its share from Affiliated Entities until one is typed', async () => {
    api.getPfsAffiliatedShares.mockResolvedValue({ resolved: { 60100: { pct: 20, basis: 'ownership', text: 'Neil R. Kadakia 10% + Archana N. Kadakia 10%', parts: [] } } });
    try {
      render(<PfsTab canEdit />);
      await loaded();
      tab('Liabilities');
      fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Loan' } });
      fireEvent.click(within(dialog).getByRole('radio', { name: 'From the Ledger' }));
      await pickEntity(dialog, 'Entity', '60100');
      await within(dialog).findByText('From Affiliated Entities: Neil R. Kadakia 10% + Archana N. Kadakia 10%');
      expect(within(dialog).getByLabelText('Share Owned (%)').value).toBe('20');
      fireEvent.change(within(dialog).getByLabelText('Share Owned (%)'), { target: { value: '15' } });
      expect(within(dialog).getByText(/Typed by hand. Affiliated Entities says 20%/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Use Affiliated %' }));
      expect(within(dialog).getByLabelText('Share Owned (%)').value).toBe('20');
      fireEvent.click(await within(dialog).findByRole('option', { name: /25000/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.addPfsLine).toHaveBeenCalled());
      expect(api.addPfsLine.mock.calls[0][1]).toMatchObject({ ownershipPct: 20, details: { shareFrom: 'affiliated' } });
    } finally {
      api.getPfsAffiliatedShares.mockResolvedValue({ shares: {}, resolved: {} });
    }
  });

  it('adds a whole GL group from the ledger at once, each account under the category the server suggests', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    fireEvent.click(screen.getByRole('button', { name: 'Add From the Ledger' }));
    const dialog = screen.getByRole('dialog', { name: 'Add from the ledger' });
    fireEvent.change(within(dialog).getByLabelText('Share Owned (%) for New Lines'), { target: { value: '50' } });
    await pickEntity(dialog, 'Entity', '60100');
    // Only this section's accounts, in GL groups; one tick takes a group.
    await within(dialog).findByText(/GL group 113xx/);
    expect(within(dialog).queryByText('Loan Payable')).toBeNull();
    expect(within(dialog).getByText('Not on Affiliated Entities. Add it there to fill this in.')).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('GL group 113'));
    expect(within(dialog).getByText(/3 picked/)).toBeTruthy();
    // "NRK & ANK - F&M - 6870" is a bank account (Charmi, 10/01), not an other holding.
    expect(within(dialog).getByLabelText('Category for 11301').value).toBe('bank');
    expect(within(dialog).getByLabelText('Category for 11309').value).toBe('retirement');
    expect(within(dialog).getByLabelText('Category for 11348').value).toBe('investment');
    // A building is flagged as real estate, not silently listed as an asset.
    expect(within(dialog).getByText('looks like real estate')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Add 3 Lines/ }));
    await waitFor(() => expect(api.addPfsLinesBulk).toHaveBeenCalled());
    expect(api.addPfsLinesBulk.mock.calls[0][1]).toMatchObject({ section: 'asset', entity: '60100', entityName: 'Business - ANK', ownershipPct: 50, shareFrom: 'manual',
      accounts: [{ code: '11301', category: 'bank', ownershipPct: 50 }, { code: '11309', category: 'retirement', ownershipPct: 50 }, { code: '11348', category: 'investment', ownershipPct: 50 }] });
    await screen.findByText('3 lines added from the ledger.');
  });

  it('fills Share Owned from Affiliated Entities when the entity is picked', async () => {
    api.getPfsAffiliatedShares.mockResolvedValueOnce({ resolved: { 60100: { pct: 20, basis: 'ownership', text: 'Neil R. Kadakia 10% + Archana N. Kadakia 10%', parts: [] } } });
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    fireEvent.click(screen.getByRole('button', { name: 'Add From the Ledger' }));
    const dialog = screen.getByRole('dialog', { name: 'Add from the ledger' });
    await pickEntity(dialog, 'Entity', '60100');
    await within(dialog).findByText('From Affiliated Entities: Neil R. Kadakia 10% + Archana N. Kadakia 10%');
    expect(api.getPfsAffiliatedShares).toHaveBeenCalledWith('p1', ['60100']);
    expect(within(dialog).getByLabelText('Share Owned (%) for New Lines').value).toBe('20');
    await within(dialog).findByText(/GL group 113xx/);
    expect(within(dialog).getByLabelText('Share for 11301').value).toBe('20');
    fireEvent.click(within(dialog).getByLabelText('GL group 113'));
    // One account with its own %: that one is typed, the rest follow Affiliated Entities.
    fireEvent.change(within(dialog).getByLabelText('Share for 11348'), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Add 3 Lines/ }));
    await waitFor(() => expect(api.addPfsLinesBulk).toHaveBeenCalled());
    const body = api.addPfsLinesBulk.mock.calls[0][1];
    expect(body).toMatchObject({ shareFrom: 'affiliated', ownershipPct: 20 });
    expect(body.accounts.map((a) => [a.code, a.ownershipPct])).toEqual([['11301', undefined], ['11309', undefined], ['11348', 5]]);
  });

  it('offers once to bring lines in line with Affiliated Entities - Update or Keep', async () => {
    api.getPfsShareMismatches.mockResolvedValueOnce({ count: 2, lines: [
      { id: 'l1', label: 'Operating Account', section: 'asset', category: 'bank', entity: '60100', ownershipPct: 7.5, affiliatedPct: 20, text: 'Neil 10% + Archana 10%', affiliateName: 'Business - ANK', via: '' },
      { id: 'l4', label: 'Chase Checking - 6532', section: 'asset', category: 'bank', entity: '60100', ownershipPct: 100, affiliatedPct: 20, text: 'Neil 10% + Archana 10%', affiliateName: 'Business - ANK', via: '' },
    ] });
    render(<PfsTab canEdit />);
    await loaded();
    const banner = await screen.findByRole('region', { name: 'Share differs from Affiliated Entities' });
    expect(within(banner).getByText('2 lines use a different % than Affiliated Entities.')).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Show' }));
    expect([...within(banner).getByText('Chase Checking - 6532').closest('tr').cells].map((c) => c.textContent)).toEqual(['Chase Checking - 6532', 'Business - ANK', '100%', '20%']);
    fireEvent.click(within(banner).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.resolvePfsShareMismatches).toHaveBeenCalledWith('p1', ['l1', 'l4'], 'update'));
    await screen.findByText('2 lines now follow Affiliated Entities.');
    expect(screen.queryByRole('region', { name: 'Share differs from Affiliated Entities' })).toBeNull();
  });

  it('opens Add From the Ledger nearly full screen, with Maximize and a Select All box', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    fireEvent.click(screen.getByRole('button', { name: 'Add From the Ledger' }));
    const dialog = screen.getByRole('dialog', { name: 'Add from the ledger' });
    expect(dialog.style.width).toBe('min(1400px, 96vw)');
    expect(dialog.style.height).toBe('92vh');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fill the screen' }));
    expect(dialog.style.width).toBe('100vw');
    expect(localStorage.getItem('nexus:pfs-ledger-add-full')).toBe('1');
    await pickEntity(dialog, 'Entity', '60100');
    await within(dialog).findByText(/GL group 113xx/);
    const all = within(dialog).getByRole('checkbox', { name: 'Select All' });
    fireEvent.click(all);
    expect(within(dialog).getByText(/5 picked/)).toBeTruthy();
    expect(all.checked).toBe(true);
    fireEvent.click(within(dialog).getByLabelText('10100 Operating Chkg -7546'));
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    fireEvent.click(all);
    expect(within(dialog).getByText(/0 picked/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^Add\s+Lines$/ }).disabled).toBe(true);
    // The choice is remembered for the next time.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add From the Ledger' }));
    expect(screen.getByRole('dialog', { name: 'Add from the ledger' }).style.width).toBe('100vw');
  });

  it('finds the entity by its number and leaves historical entities out', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    fireEvent.click(screen.getByRole('button', { name: 'Add From the Ledger' }));
    const dialog = screen.getByRole('dialog', { name: 'Add from the ledger' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Entity' }));
    expect(screen.queryByRole('option', { name: /Old Circle/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search entity by name or code'), { target: { value: '12000' } });
    fireEvent.click(screen.getByRole('option', { name: /Greens Global Inc/ }));
    await waitFor(() => expect(api.getPfsLedgerAccounts).toHaveBeenCalledWith('12000', expect.any(String)));
  });

  it('adds real estate from the ledger with its mortgage account as the loan', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Real Estate');
    fireEvent.click(screen.getByRole('button', { name: 'Add From the Ledger' }));
    const dialog = screen.getByRole('dialog', { name: 'Add from the ledger' });
    expect(within(dialog).getByText('Add Real Estate From the Ledger')).toBeTruthy();
    await pickEntity(dialog, 'Entity', '60100');
    await within(dialog).findByText(/GL group 152xx/);
    const loan = within(dialog).getByLabelText('Mortgage account for 15200');
    expect(loan.value).toBe('25100');          // the entity's mortgage, picked for it
    fireEvent.click(within(dialog).getByLabelText('15200 Building - Escondido'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Add 1 Line/ }));
    await waitFor(() => expect(api.addPfsLinesBulk).toHaveBeenCalled());
    expect(api.addPfsLinesBulk.mock.calls[0][1]).toMatchObject({ section: 'real_estate', entity: '60100', accounts: [{ code: '15200', category: 'commercial', loanAccount: '25100' }] });
  });

  it('moves a line to another category in one click', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Assets');
    fireEvent.click(screen.getByRole('button', { name: 'Move Operating Account' }));
    const pick = screen.getByLabelText('Move Operating Account to');
    expect(within(pick).getByRole('group', { name: 'Liabilities' })).toBeTruthy();   // every section is offered
    fireEvent.change(pick, { target: { value: 'asset:retirement' } });
    await waitFor(() => expect(api.movePfsLine).toHaveBeenCalledWith('p1', 'l1', 'asset', 'retirement'));
    await screen.findByText('Operating Account moved to Retirement Accounts.');
  });

  it('the co-borrower name is the one spouse field (Oct 7)', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Borrower(s)');
    expect(screen.queryByLabelText('Spouse or Co-Borrower')).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Archana Kadakia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
    const sent = api.updatePfsProfile.mock.calls[0][1].details;
    expect(sent.spouse).toBeUndefined();
    expect(sent.coBorrower.name).toBe('Archana Kadakia');
  });

  it('reads an old combined City, State, ZIP and spouse into the new fields, saved that way next time', async () => {
    const old = { ...profile, details: { ...profile.details, city_state_zip: 'Sacramento, CA 95814', spouse: 'Archana Kadakia', coBorrower: { city_state_zip: 'Somewhere odd' } } };
    api.getPfsProfile.mockImplementation(async () => old);
    try {
      render(<PfsTab canEdit />);
      await loaded();
      tab('Borrower(s)');
      await waitFor(() => expect(screen.getAllByLabelText('City')[0].value).toBe('Sacramento'));
      expect(screen.getAllByLabelText('State')[0].value).toBe('CA');
      expect(screen.getAllByLabelText('ZIP')[0].value).toBe('95814');
      expect(screen.getByLabelText('Name').value).toBe('Archana Kadakia');
      expect(screen.getAllByLabelText('City')[1].value).toBe('Somewhere odd');   // could not be split: kept whole
      expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(true);   // reading it is not an edit
      fireEvent.change(screen.getAllByLabelText('Phone')[0], { target: { value: '(916) 555-0100' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
      const sent = api.updatePfsProfile.mock.calls[0][1].details;
      expect(sent).toMatchObject({ city: 'Sacramento', state: 'CA', zip: '95814', coBorrower: { name: 'Archana Kadakia', city: 'Somewhere odd' } });
      expect(sent.city_state_zip).toBeUndefined();
      expect(sent.spouse).toBeUndefined();
      expect(sent.coBorrower.city_state_zip).toBeUndefined();
    } finally {
      api.getPfsProfile.mockImplementation(async () => profile);
    }
  });

  it('checks the ZIP as it is typed, on both blocks', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Borrower(s)');
    const [zip, coZip] = screen.getAllByLabelText('ZIP');
    fireEvent.change(zip, { target: { value: '9202' } });
    expect(screen.getByText('ZIP is 5 digits, or 9 as 12345-6789.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(true);
    fireEvent.change(zip, { target: { value: '92025-1234' } });
    expect(screen.queryByText('ZIP is 5 digits, or 9 as 12345-6789.')).toBeNull();
    fireEvent.change(coZip, { target: { value: '1234567' } });
    expect(screen.getByText('ZIP is 5 digits, or 9 as 12345-6789.')).toBeTruthy();
    fireEvent.change(coZip, { target: { value: '92025' } });
    fireEvent.change(screen.getAllByLabelText('State')[0], { target: { value: 'CA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
    expect(api.updatePfsProfile.mock.calls[0][1].details).toMatchObject({ state: 'CA', zip: '92025-1234', coBorrower: { zip: '92025' } });
  });

  it('keeps a co-borrower, with four digits of the Social Security number at most', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Borrower(s)');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Archana Kadakia' } });
    fireEvent.change(screen.getAllByLabelText('Employer')[1], { target: { value: 'Greens Global' } });   // [0] is the borrower's own
    const ssn = screen.getAllByLabelText('Social Security Number - Last 4 Digits')[1];
    fireEvent.change(ssn, { target: { value: '987-65-4321' } });
    expect(ssn.value).toBe('9876');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
    expect(api.updatePfsProfile.mock.calls[0][1].details.coBorrower).toEqual({ name: 'Archana Kadakia', employer: 'Greens Global', ssn_last4: '9876' });
  });

  describe('the co-borrower photo (Oct 7, item 38)', () => {
    const RealImage = globalThis.Image;
    beforeEach(() => {
      globalThis.Image = class { set src(v) { this.width = 640; this.height = 480; setTimeout(() => this.onload?.(), 0); } };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} });
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,Q08=');
    });
    afterEach(() => { globalThis.Image = RealImage; vi.restoreAllMocks(); });

    it('takes a pasted photo for the co-borrower, the borrower\'s untouched', async () => {
      render(<PfsTab canEdit />);
      await loaded();
      tab('Borrower(s)');
      const box = screen.getByRole('group', { name: 'Co-Borrower Photo on the Cover' });
      expect(within(box).getByText('or click here and press Ctrl+V to paste one')).toBeTruthy();
      expect(within(box).getByText('Choose Photo')).toBeTruthy();
      const file = new File([new Uint8Array([1, 2, 3])], 'co.png', { type: 'image/png' });
      fireEvent.paste(box, { clipboardData: { files: [file] } });
      const img = await within(box).findByAltText('the co-borrower as shown on the cover');
      expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,Q08=');
      expect(within(screen.getByRole('group', { name: 'Photo on the Cover' })).getByText('No photo')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
      const body = api.updatePfsProfile.mock.calls[0][1];
      expect(body.details.coBorrower.photo).toBe('data:image/jpeg;base64,Q08=');
      expect(body.photo).toBe('');
      // Remove takes it off again.
      fireEvent.click(within(box).getByRole('button', { name: 'Remove' }));
      expect(within(box).getByText('No photo')).toBeTruthy();
    });
  });

  it('keeps only four digits of a Social Security number', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    tab('Borrower(s)');
    const ssn = screen.getAllByLabelText('Social Security Number - Last 4 Digits')[0];
    fireEvent.change(ssn, { target: { value: '123-45-6789' } });
    expect(ssn.value).toBe('1234');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updatePfsProfile).toHaveBeenCalled());
    expect(api.updatePfsProfile.mock.calls[0][1].details.ssn_last4).toBe('1234');
  });

  it('starts a new guarantor from People, joint with both names', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Test Guarantor and Second Person/ }));
    fireEvent.click(screen.getByRole('button', { name: /New Guarantor/ }));
    const dialog = screen.getByRole('dialog', { name: 'New guarantor' });
    fireEvent.change(within(dialog).getByLabelText('Statement Type'), { target: { value: 'joint' } });
    await within(dialog).findAllByRole('option', { name: /Sahil Desai/ });   // both pickers list People once it has loaded
    fireEvent.change(within(dialog).getByLabelText('Prefill From People'), { target: { value: 'sahil@greensglobal.com' } });
    expect(within(dialog).getByLabelText('Name on the Statement').value).toBe('Sahil Desai');
    fireEvent.change(within(dialog).getByLabelText('Second Person From People'), { target: { value: 'charmi@greensglobal.com' } });
    expect(within(dialog).getByLabelText('Second Name on the Statement').value).toBe('Charmi Desai');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createPfsProfile).toHaveBeenCalled());
    expect(api.createPfsProfile.mock.calls[0][0]).toEqual({ name: 'Sahil Desai', kind: 'joint', details: { email: 'sahil@greensglobal.com', coBorrower: { name: 'Charmi Desai' } } });
  });

  it('produces the statement as an Excel workbook, kept on record', async () => {
    render(<PfsTab canEdit />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Excel/ }));
    await waitFor(() => expect(api.producePfsStatement).toHaveBeenCalledWith('p1', expect.any(String), 'xlsx', 'download'));
    await screen.findByText('Excel workbook produced and the statement kept on record.');
    expect(downloadBlob).toHaveBeenCalledWith(expect.stringMatching(/^PFS_Test-Guarantor_2026-09-28\.xlsx$/), expect.any(Blob));
    expect(api.encryptPfsPdf).not.toHaveBeenCalled();
  });

  it('is read-only without the editor level', async () => {
    render(<PfsTab canEdit={false} />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Test Guarantor and Second Person/ }));
    expect(screen.queryByRole('button', { name: /New Guarantor/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Access Log' })).toBeNull();
    tab('Assets');
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change Operating Account/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move Operating Account/ })).toBeNull();
    expect(screen.getByText('Operating Account').closest('tr').getAttribute('draggable')).toBeNull();
    // Where no bank was found a viewer reads "Not found" - nothing to click.
    expect(within(screen.getByText('Chase Checking - 6532').closest('tr')).getByText('Not found')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Export/ })).toBeTruthy();   // a viewer still produces the statement
    expect(api.getPfsShareMismatches).not.toHaveBeenCalled();
  });
});

describe('the PFS PDF', () => {
  it('prints every section and a place to sign', async () => {
    const bytes = await buildPfsPdf({ statement, preparedBy: 'Charmi Desai' });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    // financial condition (page 1, Oct 6), borrower, assets, real estate, schedule E, history, executive profile (no liabilities listed)
    expect(doc.getPageCount()).toBe(7);
    expect(doc.getTitle()).toBe('Personal Financial Statement - Test Guarantor');
  });

  it('prints with a photo that cannot be read, with nothing listed, and a statement kept before the first page existed', async () => {
    const empty = { ...statement, assets: [], liabilities: [], realEstate: [], schedules: { year: '2026', e: [], c: [] }, summary: { assets: [], liabilities: [] }, totals: { assets: 0, liabilities: 0, netWorth: 0 }, condition: undefined, profile: { ...statement.profile, history: [], executiveProfile: '', details: {} } };
    const bytes = await buildPfsPdf({ statement: empty, photo: 'data:image/jpeg;base64,not-an-image' });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);   // financial condition, borrower
  });

  it('puts both photos on the cover when there is a co-borrower (Oct 7)', async () => {
    // A 1x1 PNG.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const withCo = { ...statement, profile: { ...statement.profile, details: { ...statement.profile.details, coBorrower: { name: 'Archana Kadakia', photo: png } } } };
    const one = await PDFDocument.load(await buildPfsPdf({ statement, photo: png }));
    const two = await PDFDocument.load(await buildPfsPdf({ statement: withCo, photo: png }));
    const images = (doc) => doc.context.enumerateIndirectObjects().filter(([, o]) => o?.dict?.get?.(doc.context.obj('Subtype'))?.toString() === '/Image').length;
    // A PNG may embed as the image plus its alpha mask: the second photo doubles the count.
    expect(images(one)).toBeGreaterThan(0);
    expect(images(two)).toBe(images(one) * 2);
  });
});

describe('the PFS Excel workbook', () => {
  it('has one sheet per section of the statement, with the schedule when there is one', async () => {
    const withCo = { ...statement, profile: { ...statement.profile, details: { ...statement.profile.details, coBorrower: { name: 'Archana Kadakia', ssn_last4: '4321' } } } };
    const sheets = pfsSheets({ statement: withCo, preparedBy: 'Charmi Desai' });
    // The bank-style first page is the first sheet (Charmi, 10/04).
    expect(sheets.map((s) => s.name)).toEqual(['Financial Condition', 'Borrower', 'Assets', 'Liabilities', 'Real Estate', 'Schedule E', 'History']);
    const text = (s) => sheets.find((x) => x.name === s).rows.flat().map((c) => c?.text ?? '').join('\n');
    expect(text('Financial Condition')).toContain('Statement of Financial Condition');
    expect(text('Financial Condition')).toContain('Mortgages on Real Estate');
    expect(text('Financial Condition')).toContain('Guarantee - Storage LLC loan');
    expect(text('Financial Condition')).toContain('Net Rental Income (Schedule E)');
    expect(text('Assets')).toContain('Farmers & Merchants Bank');
    expect(text('Assets')).not.toContain('Neil & Archana Kadakia');
    expect(text('Borrower')).toContain('Co-Borrower');
    expect(text('Borrower')).toContain('XXX-XX-4321');
    expect(text('Borrower')).not.toMatch(/(^|\n)\d{4}(\n|$)/);   // never bare digits: both print masked
    expect(text('Borrower')).toContain('XXX-XX-6789');
    expect(text('Schedule E')).toContain('Mortgage Interest');
    // The executive profile is headed with the person's name (Oct 7).
    expect(text('History')).toContain('Executive Profile - Test Guarantor');
    // Net worth is a live formula over the two totals.
    const summary = sheets[0].rows.flat();
    expect(summary.find((c) => c?.f && /^C\d+-C\d+$/.test(c.f))).toBeTruthy();

    const bytes = await buildPfsWorkbook({ statement: withCo, preparedBy: 'Charmi Desai' });
    const zip = await JSZip.loadAsync(bytes);
    const workbook = await zip.file('xl/workbook.xml').async('string');
    ['Financial Condition', 'Borrower', 'Assets', 'Liabilities', 'Real Estate', 'Schedule E', 'History'].forEach((n) => expect(workbook).toContain(`name="${n}"`));
    expect(Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).length).toBe(7);
    const assets = await zip.file('xl/worksheets/sheet3.xml').async('string');
    expect(assets).toContain('Operating Account');
    expect(assets).toContain('<f>SUM(');
  });
});
