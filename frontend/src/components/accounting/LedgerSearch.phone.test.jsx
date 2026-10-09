import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Accounting on a phone (Neil, Oct 1): the ledger lines are cards, not the
// 1,600 px grid, and the journal entry fills the screen with its lines
// stacked. Same data, same taps; the desktop grid is covered next door in
// LedgerSearch.test.jsx.

vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => true }));

const line = {
  line_id: 'l1', entry_id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-08-19', description: 'Amazon Marketplace Pay - Mop stainless steel',
  doc: 'INV-77', journal: 'CCJ', gl_code: '71100', account_name: 'General', location: '12000', location_name: 'Greens Global, Inc.',
  vendor_id: 'V00225', vendor_name: 'American Express', customer_id: '', customer_name: '', employee_id: '', employee_name: '',
  memo: 'Amazon Marketplace Pay', debit: 22.46, credit: 0,
};
const payment = { ...line, line_id: 'l2', entry_id: 'e2', entry_no: 'CCJ-44120', description: '', memo: 'Payment - American Express', debit: 0, credit: 3960 };

vi.mock('../../api', () => ({
  api: {
    searchAccountingLedger: vi.fn(async () => ({ rows: [line, payment], total: 2, debit: 22.46, credit: 3960, facets: {} })),
    getAccountingEntry: vi.fn(async () => ({
      entry: { id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-08-19', narration: '', posted_at: '2026-08-20' },
      lines: [{ id: 'l1', gl_code: '71100', account_name: 'General', description: '', location: '10001', location_name: 'Rajesh and D', department: '9500', department_name: 'Personal', book_tag: 'both', intacct_record_no: '9', debit: 22.46, credit: 0 }],
      intacct: [{ record_no: '9', batch_no: '77', journal: 'CCJ', memo: 'Amazon Marketplace Pay', vendor_id: 'V00225', vendor_name: 'American Express' }],
      totals: { debit: 22.46, credit: 0 }, path: '/finance/ledgers/entry/e1',
    })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
  },
}));

import LedgerSearch from './LedgerSearch';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); });

describe('LedgerSearch on a phone', () => {
  it('lists the lines as cards with the amount, account, entity, date and party; no grid, no column chooser', async () => {
    render(<LedgerSearch term="amazon" entities={['12000']} entityName="Greens Global, Inc. (12000)" onClose={() => {}} onClearDrill={() => {}} />);
    const card = (await screen.findByText('Amazon Marketplace Pay - Mop stainless steel')).closest('button');
    expect(card).toBeTruthy();
    expect(within(card).getByText('22.46')).toBeTruthy();
    expect(within(card).getByText(/General · Greens Global, Inc\./)).toBeTruthy();
    expect(within(card).getByText('08/19/2026 · IA-1293173')).toBeTruthy();
    expect(within(card).getByText('American Express')).toBeTruthy();
    // A line with no description shows its memo; a credit reads in parentheses.
    const pay = screen.getByText('Payment - American Express').closest('button');
    expect(within(pay).getByText('(3,960.00)')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /Columns/ })).toBeNull();
    // The totals over the whole result still read above the cards.
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('a tapped card opens the entry full screen with its lines stacked', async () => {
    render(<LedgerSearch term="amazon" entities={[]} onClose={() => {}} onClearDrill={() => {}} />);
    fireEvent.click((await screen.findByText('Amazon Marketplace Pay - Mop stainless steel')).closest('button'));
    const dialog = await screen.findByRole('dialog', { name: /Journal entry/ });
    await within(dialog).findByText('Rajesh and D');
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Fill the screen|Back to window size/ })).toBeNull();
    expect(within(dialog).getByText('Personal')).toBeTruthy();
    expect(within(dialog).getByText('American Express')).toBeTruthy();
    expect(within(dialog).getByText('22.46 debit · 0.00 credit')).toBeTruthy();
    expect(dialog.style.width).toBe('100vw');
  });
});
