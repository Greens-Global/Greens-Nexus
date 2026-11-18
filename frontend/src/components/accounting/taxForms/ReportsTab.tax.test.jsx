import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting > Reports > Tax on screen (Charmi, 11/19/2026): a new form reads
// the books, lists what is not mapped, and its Line Mapping saves under its
// own form; the 1040's Line Mapping saves each entity's schedule for that entity.

const PNL = {
  org: 'Greens Global', generated_at: '2026-11-19',
  sections: [
    { key: 'revenue', accounts: [{ account_no: '40000', title: 'Sales', amount: 5000 }] },
    { key: 'expense', accounts: [{ account_no: '61000', title: 'Advertising', amount: 400 }, { account_no: '69000', title: 'Owner Draws', amount: 25 }] },
  ],
};

vi.mock('../../../api', () => ({
  api: {
    getAccountingLocations: vi.fn(async () => ({ entities: [{ code: '15000', name: 'Greens Escondido', parent_code: null }] })),
    getAccountingPnl: vi.fn(async () => PNL),
    getAccountingBalanceSheet: vi.fn(async () => ({ sections: [] })),
    getAccountingBuckets: vi.fn(async () => ({ rows: [] })),
    getAccountingDimensionValues: vi.fn(async () => ({ values: [] })),
    getAccountingJournals: vi.fn(async () => ({ available: true, journals: [] })),
    getAccountingBooks: vi.fn(async () => ({ available: false })),
    getAccountingTaxLines: vi.fn(async () => ({ lines: [] })),
    saveAccountingTaxLines: vi.fn(async (b) => ({ lines: b.lines.map((l) => ({ ...l, entity: b.entity })) })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0 })),
    getAccountingSavedReports: vi.fn(async () => []),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (prefs) => ({ prefs })),
    getRolesDirectory: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
  },
}));

import ReportsTab from '../ReportsTab';
import ScheduleCMapping from '../ScheduleCMapping';
import { api } from '../../../api';
import { resetAccountingPrefs } from '../prefs';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetAccountingPrefs(); vi.clearAllMocks(); window.scrollTo = vi.fn(); });

describe('Tax forms on the Reports screen (11/19/2026)', () => {
  it('Form 1065: page 1 from the books, the draft note, and Line Mapping saves under form_1065', async () => {
    render(<ReportsTab report="tax-1065" />);
    expect(await screen.findByText('Line 1a - Gross receipts or sales')).toBeTruthy();
    expect(screen.getByText('Schedule K Line 5 - Interest income')).toBeTruthy();
    expect(screen.getByText(/Draft working paper for the preparer, not a filed return/)).toBeTruthy();
    expect(api.getAccountingTaxLines).toHaveBeenCalledWith('form_1065', '');
    // Owner draws are never suggested: they wait for review.
    fireEvent.click(screen.getByRole('button', { name: /Line Mapping \(1 Not Mapped\)/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Form 1065 Line Mapping')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Line for 69000 Owner Draws'), { target: { value: 'skip' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(api.saveAccountingTaxLines).toHaveBeenCalledWith({ form: 'form_1065', entity: '', lines: [{ accountNo: '69000', line: 'skip' }] }));
  });

  it('Form 1040 Line Mapping: one row per entity, each saved for its own entity', async () => {
    const rows = [
      { code: 'return', rowKey: '15000', saveEntity: '15000', title: '15000 Greens Escondido', section: 'entity', amount: 1000, line: 'schedule_e', source: 'suggested', suggested: 'schedule_e' },
      { code: 'return', rowKey: '12000', saveEntity: '12000', title: '12000 Greens Global', section: 'entity', amount: 500, line: 'schedule_c', source: 'suggested', suggested: 'schedule_c' },
    ];
    render(<ScheduleCMapping rows={rows} taxForm={{ form: 'form_1040', report: 'tax-1040' }} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText('Form 1040 Line Mapping')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Line for 12000 Greens Global'), { target: { value: 'schedule_e' } });
    fireEvent.click(screen.getByRole('button', { name: /Accept Suggestions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save (2)' }));
    await waitFor(() => expect(api.saveAccountingTaxLines).toHaveBeenCalledTimes(2));
    expect(api.saveAccountingTaxLines).toHaveBeenCalledWith({ form: 'form_1040', entity: '12000', lines: [{ accountNo: 'return', line: 'schedule_e' }] });
    expect(api.saveAccountingTaxLines).toHaveBeenCalledWith({ form: 'form_1040', entity: '15000', lines: [{ accountNo: 'return', line: 'schedule_e' }] });
  });
});
