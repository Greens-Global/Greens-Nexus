import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// AMA, change request 13 (Charmi, Oct 22 call): the other side of each line on
// the first screen, Notes typed in the grid, and the GL reclass - the answerer
// picks the GL and a vendor or customer, it waits for the bookkeeper, and only
// the bookkeeper approves and pushes it.

const ME = 'neil@greensglobal.com';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const line = (over = {}) => ({
  id: 'line:L1', kind: 'line', entityCode: '12001', entryId: E1, entryNo: 'IA-1294340', lineId: 'L1', accountNo: '63501', accountTitle: '? Ask My Accountant',
  date: '2026-09-30', debit: 3000, credit: 0, amount: 3000, description: 'DDA Withdrawal', memo: '', party: '', journal: 'IA', source: 'ama', status: 'Open',
  question: '', askedBy: '', accountant: '', reclassed: false, lastReplyAt: '', replies: 0, department: '4100 Storage', departmentId: '4100', vendor: '', note: '', reclass: null, ...over,
});
const items = (over = {}) => ({
  from: '2025-10-22', to: '2026-10-22', entity: '', accounts: [{ code: '63501', title: '? Ask My Accountant' }], autoDetected: true, ledgerError: null, canEdit: false, me: ME,
  rows: [line(), line({ id: 'line:L2', lineId: 'L2', entryId: E2, entryNo: 'IA-1293973', amount: -2000, debit: 0, credit: 2000, description: 'ZELLE from DINA' })],
  counts: { Open: 2, Answered: 0, Resolved: 0, All: 2 }, isBookkeeper: false, pushToIntacct: false, ...over,
});
const offsets = {
  [E1]: { offsets: [{ accountNo: '11000', accountTitle: 'Chase Checking', entityCode: '12001', amount: -2500 }, { accountNo: '11050', accountTitle: 'Wells Checking', entityCode: '12001', amount: -500 }], hidden: 0 },
  [E2]: { offsets: [{ accountNo: '11050', accountTitle: 'Wells Checking', entityCode: '30001', amount: 2000 }], hidden: 0 },
};
const review = (over = {}) => ({
  id: 'R1', lineRef: 'L1', status: 'Awaiting Bookkeeper', reclassRef: 'R-0a1b2c3d', toAccount: '61000', toAccountTitle: 'Repairs', partyKind: '', partyId: '', partyName: '',
  reclassMemo: '', proposedBy: ME, proposedByName: 'Neil K', proposedAt: '2026-10-23T15:00:00Z', reviewNote: '', approvedBy: '', approvedAt: '', pushMode: '', intacctRef: '', pushError: '', history: [], note: '', ...over,
});

vi.mock('../../api', () => ({
  api: {
    getAskItems: vi.fn(),
    getAskOffsets: vi.fn(),
    getAskGlAccounts: vi.fn(async () => ({ accounts: [{ code: '11000', title: 'Chase Checking' }, { code: '61000', title: 'Repairs' }, { code: '40100', title: 'Rental Income' }] })),
    getAccountingPartners: vi.fn(async (kind) => ({ partners: kind === 'customer' ? [{ id: 'C100', name: 'Client Co', displayName: 'Client Co' }] : [{ id: 'V01812', name: 'Greens Global, Inc.', displayName: 'Greens Global, Inc.' }] })),
    saveAskNote: vi.fn(),
    proposeAskReclass: vi.fn(),
    pushAskReclass: vi.fn(),
    previewAskPush: vi.fn(),
    pushAskBatch: vi.fn(),
    getAskPushLog: vi.fn(async () => ({ log: [] })),
    sendBackAskReclass: vi.fn(),
    exportAskReclasses: vi.fn(),
    getAskThread: vi.fn(),
    getAskSettings: vi.fn(async () => ({})),
    getPeopleDirectory: vi.fn(async () => []),
    getAccountingLocations: vi.fn(async () => ({ entities: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));

import AskAccountantTab from './AskAccountantTab';
import { ReclassDialog, lineBody, otherSideText, pickOffsets, reclassLabel, sideFor } from './AmaReclass';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  api.getAskItems.mockImplementation(async () => items());
  api.getAskOffsets.mockImplementation(async (ids) => ({ offsets: Object.fromEntries(ids.filter((i) => offsets[i]).map((i) => [i, offsets[i]])), errors: {} }));
});

describe('the other side (pure)', () => {
  it('picks the opposite side, largest first, never the row\'s own account', () => {
    const side = pickOffsets(line(), offsets[E1], 'largest');
    expect(side.shown.map((o) => o.accountNo)).toEqual(['11000']);
    expect(side.all.map((o) => o.accountNo)).toEqual(['11000', '11050']);
    expect(pickOffsets(line(), offsets[E1], 'all').shown).toHaveLength(2);
    expect(otherSideText(side)).toBe('11000 Chase Checking; 11050 Wells Checking');
    // Nothing on the opposite side: every other account.
    expect(pickOffsets(line({ amount: -5 }), offsets[E1]).all).toHaveLength(2);
    expect(pickOffsets(line({ accountNo: '11000' }), offsets[E1]).all.map((o) => o.accountNo)).toEqual(['11050']);
    expect(pickOffsets(line(), undefined)).toBeNull();
    expect(pickOffsets(line(), { error: 'Outside your accounting access.' }).error).toBeTruthy();
    expect(sideFor(line({ entryId: '' }), {})).toEqual({ error: '', shown: [], all: [] });
  });

  it('builds the line the server keys and the status label', () => {
    expect(lineBody(line({ departmentId: '', department: '4300 Real Estate' }))).toMatchObject({ entityCode: '12001', lineId: 'L1', amount: 3000, departmentId: '4300', description: 'DDA Withdrawal' });
    expect(reclassLabel(review())).toBe('Awaiting Bookkeeper');
    expect(reclassLabel(review({ status: 'Pushed', pushMode: 'intacct' }))).toBe('Pushed To Intacct');
    expect(reclassLabel(review({ status: 'Pushed', pushMode: 'import' }))).toBe('Approved For Import');
    expect(reclassLabel(review({ status: 'Pushed', pushMode: 'edit' }))).toBe('Edited In Intacct');
  });
});

describe('AMA grid (CR-13)', () => {
  it('shows the other side on the first screen without opening the entry', async () => {
    render(<AskAccountantTab />);
    const tr = (await screen.findByText('DDA Withdrawal')).closest('tr');
    await waitFor(() => expect(within(tr).getByText('Chase Checking')).toBeTruthy());
    // Neil, 23 Oct: "Show all offsetting accounts" - every one, no "+1 more".
    expect(within(tr).getByText(/Wells Checking/)).toBeTruthy();
    expect(within(tr).queryByText(/\+1 more/)).toBeNull();
    expect(api.getAskOffsets).toHaveBeenCalledTimes(1);
    expect(api.getAskOffsets.mock.calls[0][0].sort()).toEqual([E1, E2].sort());
    const tr2 = screen.getByText('ZELLE from DINA').closest('tr');
    expect(within(tr2).getByText('Wells Checking')).toBeTruthy();
  });

  it('saves Notes typed in the grid without opening the row', async () => {
    api.saveAskNote.mockImplementation(async (b) => review({ status: '', note: b.note }));
    render(<AskAccountantTab />);
    const box = await screen.findByRole('textbox', { name: 'Notes for IA-1294340' });
    fireEvent.click(box);
    fireEvent.change(box, { target: { value: 'Paid the laborers' } });
    fireEvent.blur(box);
    await waitFor(() => expect(api.saveAskNote).toHaveBeenCalledWith(expect.objectContaining({ lineId: 'L1', entityCode: '12001', note: 'Paid the laborers' })));
    expect(screen.queryByRole('dialog', { name: 'Ask My Accountant Line' })).toBeNull();
    expect(await screen.findByDisplayValue('Paid the laborers')).toBeTruthy();
  });

  it('the answerer picks the GL and a vendor; it waits for the bookkeeper, no push', async () => {
    api.proposeAskReclass.mockImplementation(async (b) => review({ toAccount: b.toAccount, partyKind: b.partyKind, partyId: b.partyId }));
    render(<AskAccountantTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick GL for IA-1294340' }));
    const dlg = await screen.findByRole('dialog', { name: 'GL Reclass' });
    expect(within(dlg).queryByRole('button', { name: /Approve/ })).toBeNull();
    fireEvent.change(within(dlg).getByLabelText(/GL Account/), { target: { value: 'repa' } });
    fireEvent.click(await within(dlg).findByRole('option', { name: /61000/ }));
    fireEvent.change(within(dlg).getByLabelText('Counterparty'), { target: { value: 'vendor' } });
    fireEvent.click(await within(dlg).findByRole('option', { name: /V01812/ }));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send To Bookkeeper' }));
    await waitFor(() => expect(api.proposeAskReclass).toHaveBeenCalledWith(expect.objectContaining({ lineId: 'L1', toAccount: '61000', partyKind: 'vendor', partyId: 'V01812' })));
    expect(await within(dlg).findByText(/This reclass is with the bookkeeper/)).toBeTruthy();
    expect(within(dlg).queryByRole('button', { name: /Push/ })).toBeNull();
    expect(api.pushAskReclass).not.toHaveBeenCalled();
    // The row shows it waiting.
    expect(screen.getByRole('button', { name: /GL reclass 61000 Awaiting Bookkeeper/ })).toBeTruthy();
  });

  it('offers customers for income lines', async () => {
    render(<ReclassDialog row={line({ amount: -2000 })} side={null} isBookkeeper={false} pushToIntacct={false} onClose={() => {}} />);
    const dlg = await screen.findByRole('dialog', { name: 'GL Reclass' });
    fireEvent.change(within(dlg).getByLabelText('Counterparty'), { target: { value: 'customer' } });
    expect(await within(dlg).findByRole('option', { name: /C100/ })).toBeTruthy();
    expect(api.getAccountingPartners).toHaveBeenLastCalledWith('customer', '');
  });

  it('new_entry mode (kept behind config): a bookkeeper approves and pushes; the list reloads', async () => {
    api.getAskItems.mockImplementation(async () => items({ isBookkeeper: true, reclassMode: 'new_entry', rows: [line({ reclass: review() })] }));
    api.pushAskReclass.mockImplementation(async () => review({ status: 'Pushed', pushMode: 'import', approvedBy: 'book@greensglobal.com', approvedByName: 'Urmi G', approvedAt: '2026-10-23T16:00:00Z' }));
    render(<AskAccountantTab />);
    fireEvent.click(await screen.findByRole('button', { name: /GL reclass 61000 Awaiting Bookkeeper/ }));
    const dlg = await screen.findByRole('dialog', { name: 'GL Reclass' });
    expect(within(dlg).getByRole('button', { name: 'Send Back' })).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: /Approve & Record For Import/ }));
    await waitFor(() => expect(api.pushAskReclass).toHaveBeenCalledWith('R1'));
    expect(api.proposeAskReclass).not.toHaveBeenCalled();        // nothing changed, so no save first
    expect(await within(dlg).findByText(/Approved by/)).toBeTruthy();
    expect(within(dlg).getByText('Urmi G')).toBeTruthy();
    await waitFor(() => expect(api.getAskItems).toHaveBeenCalledTimes(2));
  });

  it('says Push To Intacct when the server pushes, and only after a preview', async () => {
    render(<ReclassDialog row={line({ reclass: review() })} side={null} isBookkeeper pushToIntacct onClose={() => {}} />);
    const btn = await screen.findByRole('button', { name: /Approve & Push To Intacct/ });
    expect(btn.disabled).toBe(true);
  });

  it('edit the original: preview shows before -> after, Push sends exactly that preview', async () => {
    const preview = {
      previewId: 'P1', ok: true, live: true, source: 'intacct', limit: 1, expiresAt: '2026-10-23T16:15:00Z',
      entries: [{ key: '5001', entryNo: '1294340', journal: 'IA', date: '2026-09-30', state: 'Posted', lineCount: 2, alreadyDone: false, problems: [],
        changes: [{ reviewId: 'R1', reclassRef: 'R-0a1b2c3d', lineNo: '1', accountBefore: '63501', accountBeforeTitle: '? Ask My Accountant', accountAfter: '61000', accountAfterTitle: 'Repairs',
          vendorBefore: '', vendorAfter: 'V01812', customerBefore: '', customerAfter: '', amount: 3000 }] }],
    };
    api.previewAskPush.mockImplementation(async () => preview);
    api.pushAskBatch.mockImplementation(async () => ({ dryRun: false, results: [{ key: '5001', entryNo: '1294340', outcome: 'edited', error: '' }],
      review: review({ status: 'Pushed', pushMode: 'edit', intacctRef: '5001', approvedBy: 'book@greensglobal.com', approvedByName: 'Urmi G', approvedAt: '2026-10-23T16:00:00Z' }) }));
    const onSaved = vi.fn();
    render(<ReclassDialog row={line({ reclass: review() })} side={null} isBookkeeper pushToIntacct onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Change' }));
    await waitFor(() => expect(api.previewAskPush).toHaveBeenCalledWith(['R1']));
    const table = await screen.findByLabelText('Push preview');
    expect(within(table).getByText('Repairs')).toBeTruthy();
    expect(within(table).getByText('(none) -> V01812')).toBeTruthy();
    const push = screen.getByRole('button', { name: /Approve & Push To Intacct/ });
    expect(push.disabled).toBe(false);
    fireEvent.click(push);
    await waitFor(() => expect(api.pushAskBatch).toHaveBeenCalledWith('P1', ['R1']));
    expect(api.pushAskReclass).not.toHaveBeenCalled();
    expect(await screen.findByText(/Edited in Intacct/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ status: 'Pushed', pushMode: 'edit' }));
  });

  it('a preview that stops the push shows why and offers no Push', async () => {
    api.previewAskPush.mockImplementation(async () => ({ previewId: null, ok: false, live: true, source: 'intacct', limit: 1,
      entries: [{ key: '5001', entryNo: '1294340', lineCount: 2, alreadyDone: false, problems: ['A line of the entry is reconciled (cleared).'], changes: [] }] }));
    render(<ReclassDialog row={line({ reclass: review() })} side={null} isBookkeeper pushToIntacct onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Change' }));
    expect(await screen.findByText(/reconciled/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve & Push To Intacct/ }).disabled).toBe(true);
  });

  it('the batch push never lets more lines be picked than the server allows', async () => {
    api.getAskItems.mockImplementation(async () => items({ isBookkeeper: true, pushBatchLimit: 1,
      rows: [line({ reclass: review() }), line({ id: 'line:L2', lineId: 'L2', entryId: E2, entryNo: 'IA-1293973', amount: -2000, reclass: review({ id: 'R2' }) })] }));
    render(<AskAccountantTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Push Reclasses \(2\)/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Push Reclasses' });
    const a = within(dlg).getByRole('checkbox', { name: 'Push IA-1294340' });
    const b = within(dlg).getByRole('checkbox', { name: 'Push IA-1293973' });
    fireEvent.click(a);
    expect(b.disabled).toBe(true);
    expect(within(dlg).getByRole('button', { name: /Record Dry Run/ }).disabled).toBe(true);
  });

  it('a bookkeeper sends it back with a note', async () => {
    api.sendBackAskReclass.mockImplementation(async (_id, note) => review({ status: 'Sent Back', reviewNote: note }));
    render(<ReclassDialog row={line({ reclass: review() })} side={null} isBookkeeper pushToIntacct={false} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send Back' }));
    fireEvent.change(screen.getByLabelText('Why It Goes Back'), { target: { value: 'Rent income' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Send Back' }).at(-1));
    await waitFor(() => expect(api.sendBackAskReclass).toHaveBeenCalledWith('R1', 'Rent income'));
    expect(await screen.findByText('Sent back: Rent income')).toBeTruthy();
  });
});
