import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';

// Accounting -> PFS (Charmi, 10/04): the Affiliated Entities tab, an executive
// profile for each borrower, the per-file lock with its one-time code, the
// Access Log, "+ New", and both new sections in the PDF and the workbook.

const profile = {
  id: 'p1', name: 'Rajesh Kadakia', kind: 'joint', archived: false, photo: '', executiveProfile: 'Founder.',
  details: { email: 'rk@example.com', coBorrower: { name: 'Darshana Kadakia', email: 'dk@example.com' } },
  history: [], lines: [],
};
const statement = {
  profile: { id: 'p1', name: 'Rajesh Kadakia', displayName: 'Rajesh Kadakia and Darshana Kadakia', kind: 'joint', details: profile.details, history: [], executiveProfile: 'Founder.' },
  asOf: '2026-09-30', assets: [], liabilities: [], realEstate: [], schedules: { year: '2026', e: [], c: [] },
  summary: { assets: [], liabilities: [] }, totals: { assets: 0, liabilities: 0, netWorth: 0 }, warnings: [],
};
const borrowers = [{ key: 'primary', name: 'Rajesh Kadakia' }, { key: 'co', name: 'Darshana Kadakia' }];
const rows = [
  { id: 'a1', name: 'Greens Storage LLC', entityType: 'multi_member_llc', entityTypeLabel: 'Multi-Member LLC', einLast4: '1234', state: 'CA', ownership: { primary: 50, co: 50 }, beneficialPct: 100, role: 'Managing Member', notes: '', ledgerEntity: '60100' },
  { id: 'a2', name: 'Kadakia Family Trust', entityType: 'trust', entityTypeLabel: 'Trust', einLast4: '', state: 'CA', ownership: { primary: 100 }, beneficialPct: null, role: 'Trustee', notes: 'Revocable', ledgerEntity: '' },
];

let status = { lockEnabled: true, unlocked: { p1: '2099-01-01T00:00:00+00:00' } };
vi.mock('../../api', () => ({
  api: {
    getPfsMeta: vi.fn(async () => ({ assetCategories: [], liabilityCategories: [], realEstateKinds: [], historyQuestions: [] })),
    getPfsProfiles: vi.fn(async () => [{ id: 'p1', name: 'Rajesh Kadakia', kind: 'joint', archived: false }, { id: 'p2', name: 'Second File', kind: 'individual', archived: false }]),
    getPfsProfile: vi.fn(async () => profile),
    getPfsStatement: vi.fn(async () => statement),
    getPfsStatements: vi.fn(async () => []),
    getPfsLedgerEntities: vi.fn(async () => ({ entities: [{ code: '60100', name: 'Business - ANK' }] })),
    getPeopleDirectory: vi.fn(async () => []),
    getRolesDirectory: vi.fn(async () => []),
    getPfsAccessStatus: vi.fn(async () => status),
    requestPfsCode: vi.fn(async () => ({ sentTo: 'm••@greensglobal.com', expiresIn: 600 })),
    verifyPfsCode: vi.fn(async (id) => ({ profileId: id, unlockedUntil: '2099-01-01T00:00:00+00:00' })),
    lockPfsFile: vi.fn(async () => null),
    getPfsAccessLog: vi.fn(async () => [
      { id: 'g1', profileId: 'p1', fileName: 'Rajesh Kadakia', email: 'me@greensglobal.com', action: 'unlocked', at: '2026-10-06T17:05:00Z', ip: '10.0.0.1', details: {} },
      { id: 'g2', profileId: 'p1', fileName: 'Rajesh Kadakia', email: 'me@greensglobal.com', action: 'failed', at: '2026-10-06T17:04:00Z', ip: '10.0.0.1', details: { attempt: 1 } },
    ]),
    getPfsAffiliatesMeta: vi.fn(async () => ({ entityTypes: [{ key: 'single_member_llc', label: 'Single-Member LLC' }, { key: 'multi_member_llc', label: 'Multi-Member LLC' }, { key: 'trust', label: 'Trust' }], roles: ['Member', 'Manager', 'Trustee'] })),
    getPfsAffiliates: vi.fn(async () => ({ borrowers, rows })),
    addPfsAffiliate: vi.fn(async (id, body) => ({ id: 'a3', ...body })),
    updatePfsAffiliate: vi.fn(async (id, aid, body) => ({ id: aid, ...body })),
    deletePfsAffiliate: vi.fn(async () => null),
    reorderPfsAffiliates: vi.fn(async (id, ids) => ({ rows: ids.map((x) => rows.find((r) => r.id === x)) })),
    getPfsExecutiveProfiles: vi.fn(async () => ({ profiles: [{ key: 'primary', name: 'Rajesh Kadakia', text: 'Founder.' }, { key: 'co', name: 'Darshana Kadakia', text: '' }] })),
    savePfsExecutiveProfile: vi.fn(async (id, key, text) => ({ profiles: [{ key: 'primary', name: 'Rajesh Kadakia', text: 'Founder.' }, { key, name: 'Darshana Kadakia', text }] })),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'me@greensglobal.com' }) }));

import PfsTab from './PfsTab';
import { api } from '../../api';
import { affiliatedRows, pctText, pfsExtraPdf, pfsExtraSheets } from './pfsAffiliatedExport';
import { buildPfsPdf } from './pfsPdf';
import { pfsSheets } from './pfsXlsx';

beforeEach(() => {
  vi.clearAllMocks();
  status = { lockEnabled: true, unlocked: { p1: '2099-01-01T00:00:00+00:00' } };
});

const openTab = async (name) => {
  render(<PfsTab canEdit />);
  await screen.findByRole('button', { name: 'Affiliated Entities' });
  fireEvent.click(screen.getByRole('button', { name }));
};

describe('Affiliated Entities', () => {
  it('sits between Statement and Borrower', async () => {
    render(<PfsTab canEdit />);
    await screen.findByRole('button', { name: 'Affiliated Entities' });
    const tabs = ['Statement', 'Affiliated Entities', 'Borrower'].map((n) => screen.getByRole('button', { name: n }));
    expect(tabs[0].compareDocumentPosition(tabs[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs[1].compareDocumentPosition(tabs[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists each entity with an ownership column per borrower, the EIN masked', async () => {
    await openTab('Affiliated Entities');
    await screen.findByText('Greens Storage LLC');
    expect(screen.getByRole('columnheader', { name: 'Rajesh Kadakia %' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Darshana Kadakia %' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Beneficial %' })).toBeTruthy();
    expect(screen.getByText('XX-XXX1234')).toBeTruthy();
    expect(screen.getByText('Managing Member')).toBeTruthy();
    expect(screen.getByText('Revocable')).toBeTruthy();
  });

  it('adds an entity prefilled from the ledger, four EIN digits at most', async () => {
    await openTab('Affiliated Entities');
    await screen.findByText('Greens Storage LLC');
    fireEvent.click(screen.getByRole('button', { name: /Add Entity/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add an affiliated entity' });
    await within(dialog).findByRole('option', { name: 'Business - ANK (60100)' });
    fireEvent.change(within(dialog).getByLabelText('Prefill From the Ledger'), { target: { value: '60100' } });
    expect(within(dialog).getByLabelText('Entity Name').value).toBe('Business - ANK');
    fireEvent.change(within(dialog).getByLabelText('Entity Type'), { target: { value: 'single_member_llc' } });
    fireEvent.change(within(dialog).getByLabelText('EIN - Last 4 Digits'), { target: { value: '12-3456789' } });
    expect(within(dialog).getByLabelText('EIN - Last 4 Digits').value).toBe('1234');
    fireEvent.change(within(dialog).getByLabelText('Rajesh Kadakia - Ownership %'), { target: { value: '60' } });
    fireEvent.change(within(dialog).getByLabelText('Darshana Kadakia - Ownership %'), { target: { value: '40' } });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'Member' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.addPfsAffiliate).toHaveBeenCalled());
    expect(api.addPfsAffiliate.mock.calls[0]).toEqual(['p1', expect.objectContaining({
      name: 'Business - ANK', entityType: 'single_member_llc', einLast4: '1234', ownership: { primary: 60, co: 40 }, role: 'Member', ledgerEntity: '60100', beneficialPct: null,
    })]);
  });

  it('refuses a share over 100%', async () => {
    await openTab('Affiliated Entities');
    await screen.findByText('Greens Storage LLC');
    fireEvent.click(screen.getByRole('button', { name: 'Change Greens Storage LLC' }));
    const dialog = screen.getByRole('dialog', { name: 'Change Greens Storage LLC' });
    fireEvent.change(within(dialog).getByLabelText('Beneficial Ownership %'), { target: { value: '120' } });
    expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(within(dialog).getByText('Percents are between 0 and 100.')).toBeTruthy();
  });

  it('moves an entity down the list', async () => {
    await openTab('Affiliated Entities');
    await screen.findByText('Greens Storage LLC');
    fireEvent.click(screen.getByRole('button', { name: 'Move Greens Storage LLC down' }));
    await waitFor(() => expect(api.reorderPfsAffiliates).toHaveBeenCalledWith('p1', ['a2', 'a1']));
  });

  it('is read-only without the editor level', async () => {
    render(<PfsTab canEdit={false} />);
    await screen.findByRole('button', { name: 'Affiliated Entities' });
    fireEvent.click(screen.getByRole('button', { name: 'Affiliated Entities' }));
    await screen.findByText('Greens Storage LLC');
    expect(screen.queryByRole('button', { name: /Add Entity/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change Greens Storage LLC/ })).toBeNull();
  });
});

describe('an executive profile for each borrower', () => {
  it('keeps the co-borrower\'s on its own', async () => {
    await openTab('History and Profile');
    expect(await screen.findByLabelText('Executive Profile - Rajesh Kadakia')).toBeTruthy();
    const co = await screen.findByLabelText('Executive Profile - Darshana Kadakia');
    fireEvent.change(co, { target: { value: 'Runs the family office.' } });
    fireEvent.click(screen.getByRole('button', { name: "Save Darshana's Profile" }));
    await waitFor(() => expect(api.savePfsExecutiveProfile).toHaveBeenCalledWith('p1', 'co', 'Runs the family office.'));
  });
});

describe('the file lock', () => {
  it('shows a lock beside each file and "+ New"', async () => {
    render(<PfsTab canEdit />);
    await screen.findByRole('button', { name: 'Affiliated Entities' });
    expect(screen.getByRole('button', { name: 'New Guarantor' }).textContent.trim()).toBe('New');
    expect(screen.getAllByRole('img', { name: 'Open in this tab' }).length).toBe(1);
    expect(screen.getAllByRole('img', { name: 'Locked' }).length).toBe(1);
  });

  it('asks for a code before a locked file opens, then opens it', async () => {
    status = { lockEnabled: true, unlocked: {} };
    render(<PfsTab canEdit />);
    await screen.findByText('Rajesh Kadakia Is Locked');
    expect(api.getPfsProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Send Code/ }));
    await waitFor(() => expect(api.requestPfsCode).toHaveBeenCalledWith('p1'));
    const input = await screen.findByLabelText('One-time code');
    fireEvent.change(input, { target: { value: '12a3456' } });
    expect(input.value).toBe('123456');
    fireEvent.click(screen.getByRole('button', { name: /Open File/ }));
    await waitFor(() => expect(api.verifyPfsCode).toHaveBeenCalledWith('p1', '123456'));
    await waitFor(() => expect(api.getPfsProfile).toHaveBeenCalledWith('p1'));
    await screen.findByRole('button', { name: 'Affiliated Entities' });
    expect(screen.getByRole('button', { name: /Lock Now/ })).toBeTruthy();
  });

  it('locks the screen when the server says the file is locked', async () => {
    status = { lockEnabled: true, unlocked: { p1: '2099-01-01T00:00:00+00:00' } };
    const locked = Object.assign(new Error('This file is locked.'), { status: 423, detail: { code: 'pfs_locked' } });
    api.getPfsProfile.mockRejectedValueOnce(locked);
    render(<PfsTab canEdit />);
    await screen.findByText('Rajesh Kadakia Is Locked');
  });

  it('shows the access log to editors', async () => {
    render(<PfsTab canEdit />);
    await screen.findByRole('button', { name: 'Affiliated Entities' });
    fireEvent.click(screen.getByRole('button', { name: 'Access Log' }));
    const dialog = await screen.findByRole('dialog', { name: 'Access log' });
    await within(dialog).findByText('Opened');
    expect(within(dialog).getByText('Wrong Code')).toBeTruthy();
    expect(within(dialog).getByText('Try 1 of 5')).toBeTruthy();
    expect(within(dialog).getAllByText(/^10\/06\/2026/).length).toBe(2);
  });

  it('has no access log for viewers', async () => {
    render(<PfsTab canEdit={false} />);
    await screen.findByRole('button', { name: 'Affiliated Entities' });
    expect(screen.queryByRole('button', { name: 'Access Log' })).toBeNull();
  });
});

describe('the exports', () => {
  const full = {
    ...statement,
    affiliated: { borrowers, rows },
    executiveProfiles: [{ key: 'primary', name: 'Rajesh Kadakia', text: 'Founder.' }, { key: 'co', name: 'Darshana Kadakia', text: 'Runs the family office.' }],
  };

  it('lists the entities with each borrower\'s share and role, no EIN or State (Oct 7)', () => {
    const { columns, rows: out } = affiliatedRows(full);
    expect(columns.map((c) => c.label)).toEqual(['Entity Name', 'Entity Type', 'Rajesh Kadakia Ownership', 'Rajesh Kadakia Role', 'Darshana Kadakia Ownership', 'Darshana Kadakia Role', 'Beneficial Ownership', 'Notes']);
    // A row saved before per-borrower roles: its one role is the primary's.
    expect(out[0]).toEqual(['Greens Storage LLC', 'Multi-Member LLC', 50, 'Managing Member', 50, '', 100, '']);
    const perBorrower = affiliatedRows({ ...full, affiliated: { borrowers, rows: [{ ...rows[0], roles: { primary: 'Managing Member', co: 'Member' } }] } });
    expect(perBorrower.rows[0]).toEqual(['Greens Storage LLC', 'Multi-Member LLC', 50, 'Managing Member', 50, 'Member', 100, '']);
    expect(affiliatedRows(statement).rows).toEqual([]);    // a statement kept before 10/06
  });

  it('prints an empty percent as "-"', () => {
    expect(pctText(null)).toBe('-');
    expect(pctText('')).toBe('-');
    expect(pctText(12.5)).toBe('12.5%');
    const sheet = pfsExtraSheets(full)[0];
    expect(sheet.rows[1]).toContain('-');     // the trust has no co-borrower share and no beneficial %
  });

  it('adds an Affiliated Entities sheet and the co-borrower profile to the workbook', () => {
    expect(pfsExtraSheets(statement)).toEqual([]);
    const sheets = pfsSheets({ statement: full });
    expect(sheets.map((s) => s.name).slice(-2)).toEqual(['Affiliated Entities', 'Co-Borrower Profile']);
    const text = sheets.find((s) => s.name === 'Affiliated Entities').rows.flat().map((c) => c?.text ?? '').join('\n');
    expect(text).toContain('Greens Storage LLC');
    expect(text).toContain('50%');
    expect(text).not.toContain('0%\n0%');
  });

  it('adds the same two sections to the PDF', async () => {
    expect(pfsExtraPdf(full, 504).map((x) => x.title)).toEqual(['Affiliated Entities', 'Executive Profile - Darshana Kadakia']);
    const plain = await PDFDocument.load(await buildPfsPdf({ statement }));
    const withBoth = await PDFDocument.load(await buildPfsPdf({ statement: full }));
    expect(withBoth.getPageCount()).toBe(plain.getPageCount() + 2);
  });
});
