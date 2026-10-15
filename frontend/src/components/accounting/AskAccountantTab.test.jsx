import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Reporting -> AMA, Ask My Accountant (Neil, 10/15): the screen
// renders (a render smoke test - a crash here would blank the screen), the
// counts and the status tabs, a row opens the side panel with the thread, a
// reply goes out and the status follows, a reclassed line resolves in one
// click, an unasked AMA line opens the Ask dialog, and the export table.

const ME = 'viewer@greensglobal.com';
const ACCT = 'acct@greensglobal.com';
const thread = (over = {}) => ({
  id: 'T1', kind: 'thread', entityCode: '15000', entryId: 'e1', entryNo: 'GJ-100', lineId: 'L1', accountNo: '99999', accountTitle: 'Ask My Accountant',
  date: '2026-09-15', debit: 125, credit: 0, amount: 125, description: 'Home Depot card', memo: '', party: 'V00412 Home Depot', journal: 'GJ',
  source: 'ama', question: 'Which property is this for?', askedBy: ME, askedByName: 'Val Viewer', askedAt: '2026-10-14T16:00:00Z',
  accountant: ACCT, accountantName: 'Ann Accountant', status: 'Open', movedToAccount: '', reclassed: false, lastReplyAt: '', lastReplyBy: '', replies: 0, ...over,
});
const line = { id: 'line:L2', kind: 'line', entityCode: '56000', entryId: 'e2', entryNo: 'GJ-101', lineId: 'L2', accountNo: '99999', accountTitle: 'Ask My Accountant',
  date: '2026-09-20', debit: 0, credit: 40, amount: -40, description: 'Unknown deposit', memo: '', party: '', journal: 'GJ', source: 'ama', status: 'Open', question: '',
  askedBy: '', accountant: '', reclassed: false, lastReplyAt: '', replies: 0 };
const items = () => ({
  from: '2025-10-15', to: '2026-10-15', entity: '', accounts: [{ code: '99999', title: 'Ask My Accountant' }], autoDetected: true, ledgerError: null, canEdit: false, me: ME,
  rows: [thread(), line, thread({ id: 'T2', lineId: 'L9', entryNo: 'GJ-109', question: 'Capitalize?', status: 'Answered', lastReplyAt: '2026-10-15T15:00:00Z', lastReplyByName: 'Ann Accountant' }),
    thread({ id: 'T3', lineId: 'L8', entryNo: 'GJ-108', question: 'Moved yet?', status: 'Resolved', movedToAccount: '61000' })],
  counts: { Open: 2, Answered: 1, Resolved: 1, All: 4 },
});
const detail = (over = {}) => ({ ...thread(over), messages: [{ id: 'm1', kind: 'question', body: 'Which property is this for?', author: ME, authorName: 'Val Viewer', at: '2026-10-14T16:00:00Z' }] });

vi.mock('../../api', () => ({
  api: {
    getAskItems: vi.fn(),
    getAskThread: vi.fn(),
    replyAskThread: vi.fn(),
    resolveAskThread: vi.fn(),
    reopenAskThread: vi.fn(),
    askAccountant: vi.fn(),
    getAskSettings: vi.fn(async () => ({ accountants: { '': [{ email: ACCT, name: 'Ann Accountant' }] }, lastAccountant: '' })),
    getAskChart: vi.fn(async () => ({ accounts: [] })),
    saveAskSettings: vi.fn(async () => ({})),
    getPeopleDirectory: vi.fn(async () => [{ email: ACCT, name: 'Ann Accountant' }, { email: ME, name: 'Val Viewer' }]),
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido, LLC.' }, { code: '56000', name: 'MCD Services, Inc.' }] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
    getAccountingEntry: vi.fn(async () => ({ entry: {}, lines: [], intacct: [] })),
  },
}));

import AskAccountantTab, { exportTable, visibleRows } from './AskAccountantTab';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  try { localStorage.clear(); } catch { /* private mode */ }
  api.getAskItems.mockImplementation(async () => items());
  api.getAskThread.mockImplementation(async () => detail());
});

describe('AskAccountantTab', () => {
  it('renders the Open lines with the counts per status', async () => {
    render(<AskAccountantTab />);
    expect(screen.getByText('Ask My Accountant')).toBeTruthy();
    const q = await screen.findByText('Which property is this for?');
    const tr = q.closest('tr');
    expect(within(tr).getByText('09/15/2026')).toBeTruthy();
    expect(within(tr).getByText('125.00')).toBeTruthy();
    expect(within(tr).getByText('Val Viewer')).toBeTruthy();
    expect(within(tr).getByText('Ann Accountant')).toBeTruthy();
    expect(within(tr).getByText('Open')).toBeTruthy();
    // The unasked AMA line shows under Open too.
    expect(screen.getByText('Unknown deposit')).toBeTruthy();
    expect(screen.getByText('Not Asked Yet')).toBeTruthy();
    expect(screen.queryByText('Capitalize?')).toBeNull();
    expect(screen.getByRole('tab', { name: /Open 2/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Answered 1/ })).toBeTruthy();
    expect(screen.getByText(/AMA account: 99999 Ask My Accountant \(found by title\)/)).toBeTruthy();
    for (const h of ['Date', 'Entity', 'Entry', 'Account', 'Description', 'Amount', 'Question', 'Asked By', 'Accountant', 'Status', 'Last Reply']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('tab', { name: /Answered/ }));
    expect(await screen.findByText('Capitalize?')).toBeTruthy();
    expect(screen.queryByText('Which property is this for?')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(screen.getByText('Moved yet?')).toBeTruthy();
    expect(api.getAskItems).toHaveBeenCalledWith(expect.objectContaining({ entity: '' }));
  });

  it('opens the thread and sends a reply', async () => {
    api.replyAskThread.mockImplementation(async () => ({ ...detail({ status: 'Open' }), messages: [...detail().messages, { id: 'm2', kind: 'reply', body: 'Escondido, please.', author: ME, authorName: 'Val Viewer', at: '2026-10-15T16:00:00Z' }] }));
    render(<AskAccountantTab />);
    fireEvent.click((await screen.findByText('Which property is this for?')).closest('tr'));
    const panel = await screen.findByRole('dialog', { name: 'Ask My Accountant Question' });
    await within(panel).findByRole('list', { name: 'Thread' });
    expect(within(panel).getByText('Open the Journal Entry')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Resolve' })).toBeTruthy();     // the asker may resolve
    const box = within(panel).getByRole('textbox', { name: 'Reply' });
    fireEvent.change(box, { target: { value: 'Escondido, please.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(api.replyAskThread).toHaveBeenCalledWith('T1', 'Escondido, please.'));
    expect(await within(panel).findByText('Escondido, please.')).toBeTruthy();
    expect(box.value).toBe('');
    await waitFor(() => expect(api.getAskItems).toHaveBeenCalledTimes(2));            // the list follows
  });

  it('resolves a reclassed line in one click', async () => {
    api.getAskItems.mockImplementation(async () => ({ ...items(), rows: [thread({ reclassed: true })], counts: { Open: 1, Answered: 0, Resolved: 0, All: 1 } }));
    api.getAskThread.mockImplementation(async () => detail({ reclassed: true }));
    api.resolveAskThread.mockImplementation(async () => detail({ status: 'Resolved', reclassed: true }));
    render(<AskAccountantTab />);
    const tr = (await screen.findByText('Which property is this for?')).closest('tr');
    expect(within(tr).getByText('Reclassed')).toBeTruthy();
    fireEvent.click(tr);
    const panel = await screen.findByRole('dialog', { name: 'Ask My Accountant Question' });
    const note = await within(panel).findByRole('note');
    fireEvent.click(within(note).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(api.resolveAskThread).toHaveBeenCalledWith('T1', { movedToAccount: '' }));
  });

  it('asks about an AMA line nobody asked about yet', async () => {
    api.askAccountant.mockImplementation(async (b) => ({ ...detail(), id: 'T9', lineId: b.lineId }));
    render(<AskAccountantTab />);
    fireEvent.click((await screen.findByText('Unknown deposit')).closest('tr'));
    fireEvent.click(await screen.findByRole('button', { name: /Ask My Accountant/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask My Accountant' });
    fireEvent.change(within(dialog).getByLabelText('Question'), { target: { value: 'What is this deposit?' } });
    await waitFor(() => expect(within(dialog).getByLabelText('Accountant').value).toBe(ACCT));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send Question' }));
    await waitFor(() => expect(api.askAccountant).toHaveBeenCalledWith(expect.objectContaining({ lineId: 'L2', entityCode: '56000', question: 'What is this deposit?', accountant: ACCT, credit: 40 })));
  });

  it('filters by whose and by text, and builds the export', () => {
    const rows = items().rows;
    expect(visibleRows(rows, { status: 'All', mine: 'asked', me: ME }).map((r) => r.id)).toEqual(['T1', 'T2', 'T3']);
    expect(visibleRows(rows, { status: 'All', mine: 'assigned', me: ACCT }).map((r) => r.id)).toEqual(['T1', 'T2', 'T3']);
    expect(visibleRows(rows, { status: 'All', text: 'deposit' }).map((r) => r.id)).toEqual(['line:L2']);
    const t = exportTable(rows, { from: '2025-10-15', to: '2026-10-15' });
    expect(t.columns.map((c) => c.label)).toEqual(['Date', 'Entity', 'Entry', 'Account', 'Description', 'Amount', 'Question', 'Asked By', 'Accountant', 'Status', 'Last Reply']);
    expect(t.rows[0].slice(0, 6)).toEqual(['09/15/2026', '15000', 'GJ-100', '99999 Ask My Accountant', 'Home Depot card', 125]);
  });

  it('shows the editor the settings and a plain error', async () => {
    api.getAskItems.mockImplementationOnce(async () => { throw new Error('Accounting service: timeout'); });
    render(<AskAccountantTab canEdit />);
    expect(await screen.findByText('Accounting service: timeout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await screen.findByText('Which property is this for?');
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    expect(await screen.findByRole('dialog', { name: 'AMA Settings' })).toBeTruthy();
    expect(screen.getByText(/Find them by title/)).toBeTruthy();
  });
});
