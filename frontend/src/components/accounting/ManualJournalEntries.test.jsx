import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
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
vi.mock('./reportModel', async (importOriginal) => ({ ...(await importOriginal()), downloadBlob: vi.fn() }));

import ManualJournalEntries from './ManualJournalEntries';
import { resetAccountingPrefs } from './prefs';
import { api } from '../../api';
import { downloadBlob } from './reportModel';

beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); });
const readFile = (file) => new Promise((done) => { const fr = new FileReader(); fr.onload = () => done(String(fr.result)); fr.readAsText(file); });


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./tableView/panels'); }, 30000);
describe('Manual Journal Entries', () => {
  it('lists the entries with who created and posted them, grouped by user, with the spec columns', async () => {
    render(<ManualJournalEntries />);
    const table = await screen.findByRole('table');
    expect(table.classList.contains('acct-sticky-head')).toBe(true);   // headings pinned in the box (item 05, round 3)
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

  it('has the standard table view: a rule narrows the entries, the count and the total follow; the stamps sort in time order (10/23, item 01)', async () => {
    try { localStorage.clear(); } catch { /* private mode */ }
    render(<ManualJournalEntries />);
    const table = await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    // One name per control (round 3): the journal picker is Journals, the table's rules are Filters.
    expect(screen.getByRole('button', { name: 'Journals' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Filters/ })).toHaveLength(1);
    expect(screen.queryByText(/Row Filters/)).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: /Add Filter/ }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 field' }), { target: { value: 'amount' } });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 condition' }), { target: { value: 'gt' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 1 value' }), { target: { value: '300' } });
    expect(table.textContent).not.toContain('urmi.shah · 1 entry');
    expect(table.closest('div').parentElement.textContent).toMatch(/1 manual entry of 40 .* Amount 497\.00/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete rule 1' }));
    // Turn grouping off, then sort Posted / Changed ascending: 10/20 11:30 before 10/21 16:25.
    fireEvent.click(screen.getByLabelText('Group by user'));
    fireEvent.click(screen.getByRole('button', { name: /^Posted \/ Changed - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Posted / Changed column' })).getByRole('menuitemradio', { name: /Sort Ascending/ }));
    const first = table.querySelector('tbody tr');
    expect(first.textContent).toContain('Bank feed draft, edited');
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

  // Item 14 (Charmi, 10/26: "There should be search option for all").
  it('has a box under every heading: typing filters the entries, the count and the total, and Export takes only those', async () => {
    try { localStorage.clear(); } catch { /* private mode */ }
    render(<ManualJournalEntries />);
    const table = await screen.findByRole('table');
    const head = table.querySelector('thead');
    for (const l of ['Date', 'Journal', 'Entry No.', 'Entity', 'Description', 'Created By', 'Posted / Changed By', 'Created', 'Posted / Changed', 'State']) expect(head.contains(screen.getByRole('textbox', { name: `Filter ${l}` }))).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Operator for Amount' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Filter Date' }).getAttribute('placeholder')).toBe('MM/DD/YYYY');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Posted / Changed By' }), { target: { value: 'urmi' } });
    expect(table.textContent).not.toContain('RTP deposit fix');
    expect(table.textContent).toContain('Bank feed draft, edited');
    expect(table.closest('div').parentElement.textContent).toMatch(/1 manual entry of 40 .* Amount 250\.00/);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const text = await readFile(downloadBlob.mock.calls[0][1]);
    expect(text).toContain('Bank feed draft, edited');
    expect(text).not.toContain('RTP deposit fix');
    // A date box reads MM/DD/YYYY; the amount box compares.
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Posted / Changed By' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Date' }), { target: { value: '10/21' } });
    expect(table.textContent).toContain('RTP deposit fix');
    expect(table.textContent).not.toContain('Bank feed draft, edited');
    fireEvent.change(screen.getByRole('combobox', { name: 'Operator for Amount' }), { target: { value: '<' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Amount' }), { target: { value: '300' } });
    expect(screen.getByText('Nothing matches these column filters.')).toBeTruthy();
  });

  it('explains when Intacct is not connected', async () => {
    api.getManualJournalEntries.mockResolvedValueOnce({ available: false, reason: 'Intacct is not connected on this server.', entries: [] });
    render(<ManualJournalEntries />);
    const note = await screen.findByRole('note');
    expect(within(note).getByText(/not available here/)).toBeTruthy();
  });
});
