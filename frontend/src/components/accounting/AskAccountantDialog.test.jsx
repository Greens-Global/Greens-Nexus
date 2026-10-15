import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Ask My Accountant from Ledger Search (Neil, 10/15): the question mark at the
// end of a ledger line opens the dialog with the line, the accountant set for
// the entity picked by default, and the question goes out with a snapshot of
// the line. The same action sits on every line of the journal entry.

const line = {
  line_id: 'L1', entry_id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-08-19', location: '10001', location_name: 'Rajesh and D',
  gl_code: '71100', account_name: 'General', description: 'Amazon Marketplace Pay', memo: 'Order 113', vendor_id: 'V00225', vendor_name: 'American Express',
  journal: 'CCJ', debit: 22.46, credit: 0,
};

vi.mock('../../api', () => ({
  api: {
    searchAccountingLedger: vi.fn(async () => ({ rows: [line], total: 1, debit: 22.46, credit: 0, facets: {} })),
    getAccountingEntry: vi.fn(async () => ({
      entry: { id: 'e1', entry_no: 'IA-1293173', entry_date: '2026-08-19', narration: '', posted_at: '2026-08-20' },
      lines: [{ id: 'l1', gl_code: '71100', account_name: 'General', description: '', location: '10001', location_name: 'Rajesh and D', book_tag: 'both', intacct_record_no: '9', debit: 22.46, credit: 0 }],
      intacct: [{ record_no: '9', journal: 'CCJ', memo: 'Amazon Marketplace Pay', vendor_id: 'V00225', vendor_name: 'American Express' }],
      totals: { debit: 22.46, credit: 0 },
    })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getAskSettings: vi.fn(async () => ({ accountants: { 10001: [{ email: 'charmi@greensglobal.com', name: 'Charmi' }], '': [{ email: 'neil@greensglobal.com', name: 'Neil' }] }, lastAccountant: '' })),
    getPeopleDirectory: vi.fn(async () => [{ email: 'charmi@greensglobal.com', name: 'Charmi' }, { email: 'neil@greensglobal.com', name: 'Neil' }]),
    askAccountant: vi.fn(async (b) => ({ id: 'T1', accountant: b.accountant, accountantName: 'Neil', merged: false })),
  },
}));

import LedgerSearch from './LedgerSearch';
import { defaultAccountant, lineFromSearch } from './AskAccountantDialog';
import { api } from '../../api';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => { localStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); });

describe('Ask My Accountant on a ledger line', () => {
  it('asks from Ledger Search with the line as a snapshot', async () => {
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask My Accountant about this line' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask My Accountant' });
    expect(within(dialog).getByText('71100 General')).toBeTruthy();
    expect(within(dialog).getByText('08/19/2026')).toBeTruthy();
    // The accountant set for the entity is picked; another can be chosen.
    await waitFor(() => expect(within(dialog).getByLabelText('Accountant').value).toBe('charmi@greensglobal.com'));
    fireEvent.change(within(dialog).getByLabelText('Accountant'), { target: { value: 'neil@greensglobal.com' } });
    // The question is required.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send Question' }));
    expect(await within(dialog).findByText('Type the question.')).toBeTruthy();
    expect(api.askAccountant).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Question'), { target: { value: 'Which property?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send Question' }));
    await waitFor(() => expect(api.askAccountant).toHaveBeenCalledWith(expect.objectContaining({
      entityCode: '10001', entryId: 'e1', entryNo: 'IA-1293173', lineId: 'L1', accountNo: '71100', date: '2026-08-19', debit: 22.46,
      memo: 'Order 113', party: 'V00225 American Express', question: 'Which property?', accountant: 'neil@greensglobal.com',
    })));
    expect(await screen.findByText(/Question sent to Neil/)).toBeTruthy();
  });

  it('asks from a line of the journal entry', async () => {
    render(<LedgerSearch term="amazon" entities={[]} entityName="All entities" onClose={() => {}} onClearDrill={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'IA-1293173' }));
    const entry = await screen.findByRole('dialog', { name: /Journal entry/ });
    await within(entry).findByText('American Express', { exact: false });
    fireEvent.click(within(entry).getByRole('button', { name: 'Ask My Accountant about this line' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask My Accountant' });
    fireEvent.change(within(dialog).getByLabelText('Question'), { target: { value: 'Personal?' } });
    await waitFor(() => expect(within(dialog).getByLabelText('Accountant').value).toBe('charmi@greensglobal.com'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send Question' }));
    await waitFor(() => expect(api.askAccountant).toHaveBeenCalledWith(expect.objectContaining({ entityCode: '10001', entryId: 'e1', lineId: 'l1', journal: 'CCJ', question: 'Personal?' })));
    expect(screen.getByRole('dialog', { name: /Journal entry/ })).toBeTruthy();      // the entry stays open
  });

  it('picks the default accountant: the entity, then every entity, then the last one asked', () => {
    const s = { accountants: { 15000: [{ email: 'a@x.com' }], '': [{ email: 'b@x.com' }] }, lastAccountant: 'c@x.com' };
    expect(defaultAccountant(s, '15000')).toBe('a@x.com');
    expect(defaultAccountant(s, '56000')).toBe('b@x.com');
    expect(defaultAccountant({ accountants: {}, lastAccountant: 'c@x.com' }, '56000')).toBe('c@x.com');
    expect(lineFromSearch({ ...line, debit: 0, credit: 5 })).toEqual(expect.objectContaining({ debit: 0, credit: 5, entityName: 'Rajesh and D' }));
  });
});
