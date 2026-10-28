import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for headcount requests (Oct 27 2026): the list, a request
// waiting on the viewer with Approve / Decline (a reason required), the
// restricted salary shown only as "set", and the New Headcount Request form.

const req = {
  id: 'h1', code: 'HC-0001', company: 'ent', companyName: 'Hire Co', department: 'Accounting', roleId: 'r1',
  roleTitle: 'Staff Accountant', workSiteId: '', location: 'Austin, TX', employmentType: 'full_time',
  employmentLabel: 'Full-Time', openings: 2, targetStart: '2026-12-01', justification: 'Month-end volume doubled.',
  status: 'awaiting_approval', step: 'department', requestedBy: 'maya@x.com', requestedByName: 'Maya T',
  submittedAt: '2026-10-27T15:00:00Z', deptApprovers: [{ email: 'hank@x.com', name: 'Hank H' }],
  deptDecidedBy: '', deptDecidedByName: '', hrDecidedBy: '', hrDecidedByName: '', declineNote: '', openingId: '',
  openingStatus: '', history: [{ at: '2026-10-27T15:00:00Z', by: 'maya@x.com', byName: 'Maya T', action: 'submitted', note: '' }],
  hasSalary: true, canEdit: false, canDecide: true, canSeePay: false,
};
const meta = { canRaise: true, canSeePay: false, isHr: false, companyId: 'ent', companies: [{ id: 'ent', name: 'Hire Co' }],
  departments: ['Accounting'], roles: [{ id: 'r1', name: 'Staff Accountant', department: 'Accounting' }], workSites: [],
  employmentTypes: [{ value: 'full_time', label: 'Full-Time' }], waiting: 1, showTab: true };
const decide = vi.fn();
const create = vi.fn();
vi.mock('../../api', () => ({
  api: {
    listHeadcount: () => Promise.resolve([req]),
    headcountMeta: () => Promise.resolve(meta),
    decideHeadcount: (...a) => decide(...a),
    createHeadcount: (...a) => create(...a),
  },
}));
const { default: HeadcountRequests } = await import('./HeadcountRequests');

beforeEach(() => {
  decide.mockReset().mockImplementation((id, decision, note) => Promise.resolve({ ...req, status: decision === 'decline' ? 'declined' : 'awaiting_approval', step: decision === 'decline' ? '' : 'hr', declineNote: note || '', canDecide: false }));
  create.mockReset().mockImplementation((body) => Promise.resolve({ ...req, id: 'h2', code: 'HC-0002', status: body.submit ? 'awaiting_approval' : 'draft' }));
});

describe('HeadcountRequests', () => {
  it('lists requests and approves the one waiting on me', async () => {
    const toastOk = vi.fn();
    render(<HeadcountRequests toastOk={toastOk} toastErr={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/2 x Staff Accountant/)).toBeTruthy());
    expect(screen.getByText('Waiting On Me (1)')).toBeTruthy();
    fireEvent.click(screen.getByText(/2 x Staff Accountant/));
    expect(await screen.findByText('Set - shown to Pay & Benefits only')).toBeTruthy();
    expect(screen.getByText('Month-end volume doubled.')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('h1', 'approve'));
    expect(toastOk).toHaveBeenCalled();
  });

  it('a decline needs a reason', async () => {
    render(<HeadcountRequests toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByText(/2 x Staff Accountant/));
    fireEvent.click(await screen.findByText('Decline'));
    const confirm = screen.getByText('Decline Request');
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Why Is It Declined? *'), { target: { value: 'No budget' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(decide).toHaveBeenCalledWith('h1', 'decline', 'No budget'));
  });

  it('raises a new request', async () => {
    render(<HeadcountRequests toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByText('New Headcount Request'));
    expect(await screen.findByText('Send For Approval')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Role *'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('Justification *'), { target: { value: 'Two people left.' } });
    fireEvent.change(screen.getByLabelText('Salary Minimum'), { target: { value: '60000' } });
    fireEvent.click(screen.getByText('Send For Approval'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ company: 'ent', role_id: 'r1', department: 'Accounting', salary_min: 60000, submit: true });
  });
});
