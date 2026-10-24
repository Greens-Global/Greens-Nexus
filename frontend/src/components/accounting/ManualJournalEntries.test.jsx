import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Reports > Audit & Insights > Manual Journal Entries (CR-10, Oct 23): the
// entries a person keyed, who and when, grouped by user, filterable.

const ENTRIES = [
  { recordNo: '502', batchNo: '94650', journal: 'GJCA', date: '2026-10-21', title: 'RTP deposit fix', state: 'Posted', amount: 497, locations: ['12000', '12019'],
    createdBy: 'vinod.bhole', modifiedBy: 'vinod.bhole', whenCreated: '10/21/2026 16:25:51', whenModified: '10/21/2026 16:25:51', kind: 'created' },
  { recordNo: '503', batchNo: '94700', journal: 'GJ', date: '2026-10-20', title: 'Bank feed draft, edited', state: 'Posted', amount: 250, locations: ['15000'],
    createdBy: 'system', modifiedBy: 'urmi.shah', whenCreated: '10/20/2026 09:00:00', whenModified: '10/20/2026 11:30:00', kind: 'edited' },
];
vi.mock('../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '12000', name: 'Greens Global, Inc.' }] })),
    getManualJournalEntries: vi.fn(async () => ({ available: true, from: '2026-09-01', to: '2026-09-30', entries: ENTRIES, users: ['urmi.shah', 'vinod.bhole'], scanned: 40, excludedUsers: ['nexus_api_user', 'system'], note: '' })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [{ entry_id: 'uuid-1', entry_no: '94650', batch_no: '94650' }] })),
    getAccountingEntry: vi.fn(async () => ({ entry: { entry_no: '94650' }, lines: [], intacct: [], totals: { debit: 0, credit: 0 } })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));

import ManualJournalEntries from './ManualJournalEntries';
import { resetAccountingPrefs } from './prefs';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); });

describe('Manual Journal Entries', () => {
  it('lists the entries with who created and posted them, grouped by user, with the spec columns', async () => {
    render(<ManualJournalEntries />);
    const table = await screen.findByRole('table');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.getAttribute('aria-label'));
    expect(heads).toEqual(['Date', 'Journal', 'Entry No.', 'Entity', 'Description', 'Amount', 'Created By', 'Posted / Changed By', 'Created', 'Posted / Changed', 'State', 'Open']);
    const text = table.textContent;
    expect(text).toContain('vinod.bhole · 1 entry');
    expect(text).toContain('urmi.shah · 1 entry');
    expect(text).toContain('Changed by a Person');
    expect(text).toContain('10/21/2026');
    expect(table.closest('div').parentElement.textContent).toMatch(/2 manual entries of 40/);
    // Opened on last month, every entity, every journal.
    expect(api.getManualJournalEntries.mock.calls[0][0]).toMatchObject({ locations: [], journals: [], user: '', edited: true });
    expect(api.getManualJournalEntries.mock.calls[0][0].from).toMatch(/-01$/);
  });

  it('filters by user and leaves out changed system entries when asked', async () => {
    render(<ManualJournalEntries />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByRole('combobox', { name: 'User' }), { target: { value: 'vinod.bhole' } });
    await waitFor(() => expect(api.getManualJournalEntries.mock.calls.at(-1)[0].user).toBe('vinod.bhole'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Include system entries a person changed/ }));
    await waitFor(() => expect(api.getManualJournalEntries.mock.calls.at(-1)[0].edited).toBe(false));
  });

  it('opens an entry from the Nexus ledger copy', async () => {
    render(<ManualJournalEntries />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Open entry 94650' }));
    await waitFor(() => expect(api.searchAccountingLedger).toHaveBeenCalledWith(expect.objectContaining({ q: '94650', journal: 'GJCA', from: '2026-10-21', to: '2026-10-21' })));
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenCalled());
  });

  it('explains when Intacct is not connected', async () => {
    api.getManualJournalEntries.mockResolvedValueOnce({ available: false, reason: 'Intacct is not connected on this server.', entries: [] });
    render(<ManualJournalEntries />);
    const note = await screen.findByRole('note');
    expect(within(note).getByText(/not available here/)).toBeTruthy();
  });
});
