import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const claim = {
  id: 'c1', employeeEmail: 'amy@x.com', employeeName: 'Amy Adams', expenseDate: '2026-10-10', vendor: 'Home Depot',
  category: 'supplies', amount: 42.5, currency: 'USD', description: 'Paint', status: 'manager_approved',
  receiptUrls: ['https://x/files/view?u=r.jpg'],
  history: [{ at: '2026-10-11T10:00:00Z', by: 'amy@x.com', byName: 'Amy Adams', action: 'submitted', note: '' }],
};

vi.mock('../api', () => ({
  api: {
    expensesMine: vi.fn().mockResolvedValue([]),
    expensesQueue: vi.fn().mockResolvedValue({ canReview: true, claims: [claim] }),
  },
}));

const { MyExpenses, ExpenseQueue } = await import('./Expenses');

describe('Expenses', () => {
  it('Workday > Expenses renders the form and an empty list', async () => {
    render(<MyExpenses toast={() => {}} />);
    expect(screen.getByText('Request a Reimbursement')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Submit Claim/ })).toBeTruthy();
    expect(await screen.findByText('No claims yet.')).toBeTruthy();
  });

  it('Reimbursements lists the claim to review and opens it with Approve', async () => {
    render(<ExpenseQueue />);
    fireEvent.click(await screen.findByText(/Amy Adams - Home Depot/));
    expect(await screen.findByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(screen.getAllByText('Awaiting Accounting')).toHaveLength(2);   // the row and the popup
  });
});
