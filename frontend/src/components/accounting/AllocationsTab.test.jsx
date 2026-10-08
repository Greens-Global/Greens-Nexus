import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Accounting -> Allocations (Oct 2): the basis per person, the entry
// preview, unmapped sites blocking the export, the mapping editor, Keep Run
// and the export of a kept run.

const preview = {
  month: '2026-09', start: '2026-09-01', end: '2026-09-30', currencies: ['USD'],
  people: [{ email: 'pat@greensglobal.com', name: 'Pat Test', payType: 'hourly', currency: 'USD', company: 'c1', companyName: 'Greens Global', department: 'Maintenance', wages: 1000, workedMin: 480,
    sites: [{ workSiteId: 's1', workSite: 'Rental A', workedMin: 360, share: 75, amount: 750, entity: '15000', account: '60100', mapped: true },
      { workSiteId: 's2', workSite: 'Rental B', workedMin: 120, share: 25, amount: 250, entity: '', account: '', mapped: false }] }],
  entries: [{ journal: 'GJ', date: '2026-09-30', reference_no: '', description: 'Payroll allocation 09/2026 - Greens Global', companyId: 'c1', companyName: 'Greens Global', payingEntity: '12000',
    lines: [
      { line_no: 1, type: 'debit', acct_no: '60100', location_id: '15000', dept_id: 'Maintenance', memo: 'Pat Test - Rental A - 6.00 h of 8.00 h (75.0%)', debit: 750, credit: null, mapped: true },
      { line_no: 2, type: 'debit', acct_no: '', location_id: '', dept_id: 'Maintenance', memo: 'Pat Test - Rental B - 2.00 h of 8.00 h (25.0%)', debit: 250, credit: null, mapped: false },
      { line_no: 3, type: 'credit', acct_no: '21500', location_id: '12000', dept_id: 'Maintenance', memo: 'Pat Test - payroll allocation 09/2026', debit: null, credit: 1000, mapped: true },
    ] }],
  totals: { wages: 1000, debits: 1000, credits: 1000, people: 1, unmappedLines: 1 },
  unmapped: { sites: [{ id: 's2', name: 'Rental B' }], companies: [] },
  mapping: { journal: 'GJ', sites: { s1: { entity: '15000', account: '60100' } }, companies: { c1: { entity: '12000', account: '21500', wageAccount: '60100' } }, offsite: {} },
};
const mapped = { ...preview, people: [{ ...preview.people[0], sites: preview.people[0].sites.map((s) => ({ ...s, entity: s.entity || '16000', account: s.account || '60100', mapped: true })) }],
  entries: [{ ...preview.entries[0], lines: preview.entries[0].lines.map((l) => ({ ...l, acct_no: l.acct_no || '60100', location_id: l.location_id || '16000', mapped: true })) }],
  totals: { ...preview.totals, unmappedLines: 0 }, unmapped: { sites: [], companies: [] } };

vi.mock('../../api', () => ({
  api: {
    previewAllocations: vi.fn(async () => preview),
    getAllocationsMap: vi.fn(async () => ({ map: preview.mapping, sites: [{ id: 's1', name: 'Rental A' }, { id: 's2', name: 'Rental B' }], companies: [{ id: 'c1', name: 'Greens Global' }] })),
    saveAllocationsMap: vi.fn(async (m) => ({ map: m })),
    getAllocationRuns: vi.fn(async () => ({ runs: [{ id: 'r1', month: '2026-08', by: 'c@greensglobal.com', byName: 'Charmi Desai', at: '2026-09-02T10:00:00Z', totals: { wages: 900, debits: 900, people: 1 }, people: 1, entries: 1 }] })),
    saveAllocationRun: vi.fn(async (body) => ({ id: 'r2', month: body.month, totals: body.preview.totals })),
    deleteAllocationRun: vi.fn(async () => null),
    allocationRunCsv: vi.fn(async () => ({ blob: new Blob(['x']), filename: 'Intacct GL Import - Payroll Allocation - 2026-09.csv' })),
    allocationRunExcel: vi.fn(async () => ({ blob: new Blob(['x']), filename: 'Payroll Allocation - 2026-09.xlsx' })),
  },
}));
vi.mock('../../ui/dialog', () => ({ dialog: { alert: vi.fn(async () => true), confirm: vi.fn(async () => true), prompt: vi.fn(async () => '') } }));
vi.mock('../../stepup/StepUp', () => ({ ensureStepUp: vi.fn(async () => ({ ok: true })), isStepUpRequired: (e) => e?.status === 403, StepUpNeeded: ({ label }) => <div>Verify to view {label}</div> }));

import AllocationsTab from './AllocationsTab';
import { api } from '../../api';

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('AllocationsTab', () => {
  it('shows the basis and the entry preview, flagging what is unmapped', async () => {
    render(<AllocationsTab canEdit />);
    expect(await screen.findByText('Pat Test')).toBeTruthy();
    expect(screen.getByText('1 unmapped')).toBeTruthy();
    const b = screen.getByText('Rental B').closest('tr');
    expect(within(b).getAllByText('Unmapped').length).toBe(2);
    expect(within(b).getByText('25.0%')).toBeTruthy();
    expect(screen.getByText('Pat Test - payroll allocation 09/2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Keep Run/ })).toBeDisabled();
    expect(screen.getByText('Charmi Desai')).toBeTruthy();   // a run kept earlier
  });

  it('saves the mapping and rebuilds the preview', async () => {
    render(<AllocationsTab canEdit />);
    await screen.findByText('Pat Test');
    fireEvent.click(screen.getByRole('button', { name: /Account Mapping/ }));
    fireEvent.change(screen.getByLabelText('Rental B entity'), { target: { value: '16000' } });
    fireEvent.change(screen.getByLabelText('Rental B wage account'), { target: { value: '60100' } });
    api.previewAllocations.mockResolvedValueOnce(mapped);
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    await waitFor(() => expect(api.saveAllocationsMap).toHaveBeenCalled());
    expect(api.saveAllocationsMap.mock.calls[0][0].sites.s2).toEqual({ entity: '16000', account: '60100' });
    await waitFor(() => expect(screen.queryByText('1 unmapped')).toBeNull());
    expect(screen.getByRole('button', { name: /Keep Run/ })).toBeEnabled();
  });

  it('keeps a run and exports it as the Intacct file', async () => {
    api.previewAllocations.mockResolvedValue(mapped);
    render(<AllocationsTab canEdit />);
    await screen.findByText('Pat Test');
    fireEvent.click(screen.getByRole('button', { name: /Export Intacct CSV/ }));
    await waitFor(() => expect(api.saveAllocationRun).toHaveBeenCalled());
    expect(api.saveAllocationRun.mock.calls[0][0]).toMatchObject({ month: expect.any(String), preview: mapped });
    await waitFor(() => expect(api.allocationRunCsv).toHaveBeenCalledWith('r2'));
  });

  it('asks for a step-up when the backend wants one', async () => {
    api.previewAllocations.mockRejectedValueOnce(Object.assign(new Error('stepup_required'), { status: 403 }));
    render(<AllocationsTab canEdit />);
    expect(await screen.findByText(/Verify to view wages by person/)).toBeTruthy();
  });
});
