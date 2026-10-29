import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The lines behind a report figure in the side panel (call of 10/27 with
// Charmi, item 17): every query read and listed as one, newest first, with
// the total; each entry opens; Open Full; resizable columns kept per person;
// Open in Reports hands the same search to the ledger (drill.js).

vi.mock('../../api', () => ({
  api: {
    searchAccountingLedger: vi.fn(),
    getAccountingEntry: vi.fn(async () => ({ entry: { entry_no: 'AP-2001' }, lines: [], intacct: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));

import LinesPanel, { lineAccount, lineName, readLines } from './LinesPanel';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';
import { takePendingDrill } from './drill';

const L1 = { line_id: 'l1', entry_id: 'e-1', entry_no: 'AP-2001', entry_date: '2026-01-15', gl_code: '62100', account_name: 'Utilities - Electric', vendor_id: 'V-SDGE', vendor_name: 'San Diego Gas & Electric', description: 'SDGE January', debit: 410, credit: 0 };
const L2 = { line_id: 'l2', entry_id: 'e-2', entry_no: 'AP-2002', entry_date: '2026-01-28', gl_code: '62110', account_name: 'Utilities - Gas', vendor_id: 'V-SDGE', vendor_name: 'San Diego Gas & Electric', description: 'Gas', debit: 0, credit: 25 };

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountingPrefs();
  api.searchAccountingLedger.mockImplementation(async (q) => ({ rows: q.account === '62100' ? [L1] : [L2], total: 1 }));
});

describe('LinesPanel', () => {
  it('reads every query and lists the lines as one, newest first', async () => {
    const d = await readLines([{ account: '62100' }, { account: '62110' }]);
    expect(d.lines.map((l) => l.entry_no)).toEqual(['AP-2002', 'AP-2001']);
    expect(d.more).toBe(false);
    expect(api.searchAccountingLedger).toHaveBeenCalledWith({ account: '62100', offset: 0, limit: 500 });
    expect(lineAccount(L1)).toBe('62100 Utilities - Electric');
    expect(lineName(L1)).toBe('V-SDGE San Diego Gas & Electric');
    expect(lineName({ employee_id: 'E-0084', employee_name: 'Valinda Cranfill' })).toBe('Valinda Cranfill');
  });

  it('shows the lines and their total in the side panel, entries open, columns resize, Open in Reports', async () => {
    const onClose = vi.fn();
    const report = { account: '62100', party: { kind: 'vendor', code: 'V-SDGE', name: 'SDG&E' }, from: '2026-01-01', to: '2026-01-31', entity: '15000' };
    render(<LinesPanel label="SDG&E, Jan 2026" title="SDG&E - Jan 2026" queries={[{ account: '62100' }, { account: '62110' }]} report={report} widthsKey="test" onClose={onClose} />);
    const panel = screen.getByRole('dialog', { name: 'SDG&E, Jan 2026' });
    expect(within(panel).getByRole('button', { name: /Open Full/ })).toBeTruthy();
    const table = await within(panel).findByRole('table', { name: /ledger lines/ });
    expect(within(table).getByText('Total - 2 lines').closest('tr').textContent).toContain('385.00');
    for (const c of ['Date', 'Entry', 'Account', 'Name', 'Description', 'Amount']) expect(within(table).getByRole('separator', { name: `Resize the ${c} column` })).toBeTruthy();
    // A column dragged (double-click fits; jsdom has no layout - the 60 px floor) is kept.
    fireEvent.doubleClick(within(table).getByRole('separator', { name: 'Resize the Description column' }));
    await waitFor(() => expect(within(table).getByRole('columnheader', { name: /Description/ }).style.width).toBe('60px'));
    fireEvent.click(within(table).getByRole('button', { name: 'AP-2001' }));
    await waitFor(() => expect(api.getAccountingEntry).toHaveBeenCalledWith('e-1'));
    // Escape closes the entry first, not the panel.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: /Open in Reports/ }));
    expect(takePendingDrill()).toEqual(report);
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when nothing posted', async () => {
    api.searchAccountingLedger.mockImplementation(async () => ({ rows: [], total: 0 }));
    render(<LinesPanel title="Nothing" queries={[{ account: '1' }]} onClose={() => {}} />);
    expect(await screen.findByText('Nothing posted for this figure.')).toBeTruthy();
  });
});
