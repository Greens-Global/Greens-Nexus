import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Accounting -> Loans -> Amortization and Stress Test
// (Charmi and Neil, 10/06): a kept schedule with the schedule-vs-ledger
// compare, building one and saving it, the bank-file mapping from pasted
// cells, the single-loan stress table and the portfolio view.

const loan = {
  id: 'FL1', loanNo: '6870', lender: 'F&M Bank', entityCode: '15000', entityName: 'Greens Escondido, LLC.', balance: 99400,
  ratePct: 6, rateType: 'variable', maturity: '2036-10-01', monthlyPi: 5995.51, noiT12: 201600, covenantMin: 1.35, isActive: true,
};
const schedule = {
  id: 'S1', loanId: 'FL1', source: 'upload', fileUrl: 'https://x.supabase.co/storage/v1/object/public/task-files/accounting/loan-schedules/FL1/bank.xlsx', fileName: 'bank.xlsx', by: 'charmi@greensglobal.com', at: '2026-10-06T10:00:00Z',
  rows: [
    { n: 1, date: '2026-09-01', payment: 1000, interest: 500, principal: 500, balloon: 0, balance: 100000 },
    { n: 2, date: '2026-10-01', payment: 1000, interest: 400, principal: 600, balloon: 0, balance: 99400 },
  ],
};

vi.mock('../../api', () => ({
  api: {
    getLoanSchedule: vi.fn(async () => ({ schedule: null })),
    saveLoanSchedule: vi.fn(async (_id, body) => ({ schedule: { id: 'S2', loanId: 'FL1', ...body, by: 'me', at: '2026-10-06T10:00:00Z' } })),
    deleteLoanSchedule: vi.fn(async () => ({ deleted: 1 })),
    getLoanStressScenarios: vi.fn(async () => ({ scenarios: [] })),
    saveLoanStressScenario: vi.fn(async (_id, body) => ({ scenario: { id: 'X1', ...body, by: 'me', at: '' } })),
    deleteLoanStressScenario: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../../investor/lib/upload', () => ({ uploadToSupabase: vi.fn(async () => ({ url: '', error: null })), safeFileName: (s) => s }));

import LoanAmortization from './LoanAmortization';
import LoanStress, { LoanStressPortfolio } from './LoanStress';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); });

describe('LoanAmortization', () => {
  it('shows a kept schedule and compares it with the ledger', async () => {
    api.getLoanSchedule.mockResolvedValueOnce({ schedule });
    render(<LoanAmortization loan={loan} canEdit month="2026-10" />);
    expect(await screen.findByText('Bank File')).toBeInTheDocument();
    expect(screen.getByText(/Schedule vs Ledger - Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText('Matches')).toBeInTheDocument();
    expect(screen.getByText('10/01/2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /bank.xlsx/ })).toBeInTheDocument();
  });

  it('builds a schedule and saves it', async () => {
    render(<LoanAmortization loan={loan} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: /Build Schedule/ }));
    expect(screen.getByText('Monthly P&I')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Schedule' }));
    await waitFor(() => expect(api.saveLoanSchedule).toHaveBeenCalled());
    const [, body] = api.saveLoanSchedule.mock.calls[0];
    expect(body.source).toBe('build');
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.params.ratePct).toBe(6);
  });

  it('reads cells pasted from the bank and maps the columns', async () => {
    render(<LoanAmortization loan={loan} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: /Upload Bank File/ }));
    const text = 'Due Date\tPayment\tInterest\tPrincipal\tBalance\n11/01/2026\t1,000.00\t400.00\t600.00\t99,400.00\n12/01/2026\t1,000.00\t397.00\t603.00\t98,797.00';
    fireEvent.paste(screen.getByText('Upload Bank File').parentElement, { clipboardData: { getData: () => text } });
    expect(await screen.findByText(/2 payments read/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 Payments' }));
    await waitFor(() => expect(api.saveLoanSchedule).toHaveBeenCalled());
    expect(api.saveLoanSchedule.mock.calls[0][1]).toMatchObject({ source: 'upload', fileName: 'Pasted from Excel' });
    expect(api.saveLoanSchedule.mock.calls[0][1].rows[1]).toMatchObject({ date: '2026-12-01', balance: 98797 });
  });

  it('a viewer cannot build or upload', async () => {
    render(<LoanAmortization loan={loan} />);
    expect(await screen.findByText(/No amortization schedule kept/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Build Schedule/ })).toBeNull();
  });
});

describe('LoanStress', () => {
  it('shows the shocks side by side with the covenant result', async () => {
    render(<LoanStress loan={loan} canEdit />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getAllByText('+200 bps').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pass').length).toBeGreaterThan(0);
    expect(screen.getByText(/Break-Even Rate/)).toBeInTheDocument();
    await waitFor(() => expect(api.getLoanStressScenarios).toHaveBeenCalledWith('FL1'));
    fireEvent.click(screen.getByRole('button', { name: /Save Scenario/ }));
    await waitFor(() => expect(api.saveLoanStressScenario).toHaveBeenCalled());
    expect(api.saveLoanStressScenario.mock.calls[0][1].params.shockBps).toBe(200);
  });

  it('asks for the NOI when none is on file', () => {
    render(<LoanStress loan={{ ...loan, noiT12: null }} />);
    expect(screen.getByText(/Enter the NOI/)).toBeInTheDocument();
  });

  it('stresses the portfolio entity by entity', () => {
    const loans = [loan, { ...loan, id: 'FL2', lender: 'Chase', entityCode: '56000', entityName: 'MCD Services, Inc.', balance: 400000, noiT12: 36000, monthlyPi: null }];
    render(<LoanStressPortfolio loans={loans} />);
    expect(screen.getByText('MCD Services, Inc.')).toBeInTheDocument();
    expect(screen.getAllByText('Below Covenant').length).toBeGreaterThan(0);
  });
});
