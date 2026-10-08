// Render-smoke + data-shaping tests for the Find a Transaction tile (Oct 1):
// it searches the ledger with what is typed, lists the top lines, and hands
// the words (and a tapped entry) to Accounting -> Reports through drill.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ searchAccountingLedger: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import { WIDGETS, widgetAllowed } from './widgets.jsx';
import { FindTransactionWidget, transactionRows, signed } from './accountingWidgets.jsx';
import { takePendingDrill } from '../components/accounting/drill';

const line = {
  line_id: 'l1', entry_id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-09-26', description: 'Sunbelt Rentals - scissor lift, Hwy 50 site',
  doc: '', journal: 'PJ', gl_code: '61200', account_name: 'Equipment Rental', location: '20000', location_name: 'Greens Construction',
  vendor_name: 'Sunbelt Rentals', customer_name: '', employee_name: '', memo: '', debit: 2840, credit: 0,
};
const payment = { ...line, line_id: 'l2', entry_id: 'e2', entry_no: 'CCJ-44120', entry_date: '2026-09-15', description: '', memo: 'Payment - Sunbelt Rentals', location_name: 'Greens Global LLC', debit: 0, credit: 3960 };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  takePendingDrill();
  apiMock.searchAccountingLedger.mockReset();
  apiMock.searchAccountingLedger.mockResolvedValue({ rows: [line, payment], total: 11, debit: 5440, credit: 3960, facets: {} });
});
afterEach(() => { vi.useRealTimers(); });

const type = async (text) => {
  fireEvent.change(screen.getByLabelText('Find a transaction'), { target: { value: text } });
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
};

describe('transactionRows', () => {
  it('shows what, when and where, the amount with credits in parentheses, and the other party', () => {
    const rows = transactionRows([line, payment]);
    expect(rows[0]).toMatchObject({ entryId: 'e1', entryNo: 'IA-1293173', title: 'Sunbelt Rentals - scissor lift, Hwy 50 site', meta: '09/26/2026 · IA-1293173 · Greens Construction', amount: '2,840.00', party: 'Sunbelt Rentals' });
    // No description: the memo stands in. A credit reads in parentheses.
    expect(rows[1]).toMatchObject({ title: 'Payment - Sunbelt Rentals', amount: '(3,960.00)', meta: '09/15/2026 · CCJ-44120 · Greens Global LLC' });
    expect(signed(1480)).toBe('1,480.00');
    expect(signed(-25.5)).toBe('(25.50)');
  });
});

describe('Find a Transaction', () => {
  it('waits for two characters, then asks the ledger for six lines and lists them', async () => {
    render(<FindTransactionWidget />);
    expect(screen.getByText('Type at least two characters. Enter opens the ledger with your search.')).toBeTruthy();
    await type('s');
    expect(apiMock.searchAccountingLedger).not.toHaveBeenCalled();
    await type('sunbelt');
    expect(apiMock.searchAccountingLedger).toHaveBeenCalledTimes(1);
    expect(apiMock.searchAccountingLedger.mock.calls[0][0]).toEqual({ q: 'sunbelt', limit: 6 });
    expect(await screen.findByText('Sunbelt Rentals - scissor lift, Hwy 50 site')).toBeTruthy();
    expect(screen.getByText('2,840.00')).toBeTruthy();
    expect(screen.getByText('(3,960.00)')).toBeTruthy();
    expect(screen.getByText('11 lines · 1,480.00 net')).toBeTruthy();
  });

  it('a tapped line opens Reports with the words and that entry on top', async () => {
    const seen = [];
    const onNav = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<FindTransactionWidget />);
    await type('sunbelt');
    fireEvent.click(await screen.findByText('Sunbelt Rentals - scissor lift, Hwy 50 site'));
    window.removeEventListener('nexus:navigate', onNav);
    expect(seen).toEqual([{ view: 'accounting', sub: 'reports' }]);
    expect(takePendingDrill()).toEqual({ q: 'sunbelt', entryId: 'e1', entryNo: 'IA-1293173' });
  });

  it('Enter and "Open in Ledger" hand over the words alone', async () => {
    const seen = [];
    const onNav = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<FindTransactionWidget />);
    await type('sunbelt 2840');
    await screen.findByText('Open in Ledger');
    fireEvent.submit(screen.getByRole('search'));
    expect(takePendingDrill()).toEqual({ q: 'sunbelt 2840', entryId: null, entryNo: '' });
    fireEvent.click(screen.getByText('Open in Ledger'));
    expect(takePendingDrill()).toEqual({ q: 'sunbelt 2840', entryId: null, entryNo: '' });
    window.removeEventListener('nexus:navigate', onNav);
    expect(seen).toHaveLength(2);
  });

  it('says so when nothing matches, and shows the server\'s reason when it fails', async () => {
    apiMock.searchAccountingLedger.mockResolvedValue({ rows: [], total: 0, debit: 0, credit: 0, facets: {} });
    const { unmount } = render(<FindTransactionWidget />);
    await type('zzzz');
    expect(await screen.findByText('No ledger lines match. Try fewer words or the entry number.')).toBeTruthy();
    unmount();
    apiMock.searchAccountingLedger.mockRejectedValue(new Error('The accounting app is not reachable right now.'));
    render(<FindTransactionWidget />);
    await type('sunbelt');
    expect(await screen.findByText('The accounting app is not reachable right now.')).toBeTruthy();
    expect(screen.queryByText('Open in Ledger')).toBeNull();
  });

  it('is registered under Accounting and gated on the Accounting grant', () => {
    const def = WIDGETS['find-transaction'];
    expect(def).toMatchObject({ title: 'Find a Transaction', cat: 'Accounting', module: 'accounting' });
    expect(def.minRole).toBeUndefined();
    const role = (granted) => ({ can: () => false, myGrantedModules: new Map(), canAccessModule: (m) => granted && m === 'accounting' });
    expect(widgetAllowed(def, role(true))).toBe(true);
    expect(widgetAllowed(def, role(false))).toBe(false);
    // Role-tiered tiles keep their old rule: the role, or the manager-dashboard grant.
    const team = WIDGETS['time-off'];
    expect(widgetAllowed(team, role(false))).toBe(false);
    expect(widgetAllowed(team, { can: () => false, myGrantedModules: new Map([['manager-dashboard', 'viewer']]) })).toBe(true);
    expect(widgetAllowed(WIDGETS.notes, role(false))).toBe(true);
  });
});
