import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// People > Notices (Neil, Oct 21 2026): the library renders grouped by area,
// a notice opens with its versions, and an approver sees Approve on a
// version waiting for approval.

const library = vi.fn();
const detail = vi.fn();
const review = vi.fn();
const coverage = vi.fn();
vi.mock('../api', () => ({
  api: {
    noticesLibrary: (...a) => library(...a),
    noticeDetail: (...a) => detail(...a),
    reviewNoticeVersion: (...a) => review(...a),
    noticeEvents: vi.fn().mockResolvedValue([]),
    noticeFile: vi.fn(),
    noticeCoverage: (...a) => coverage(...a),
  },
}));

const { default: NoticesAdmin } = await import('./NoticesAdmin');

const ver = (over) => ({
  id: 'v1', noticeId: 'ca-mw', number: 1, label: '2027', major: true, status: 'in_review', statusLabel: 'Awaiting Approval',
  files: [{ lang: 'en', name: 'MW-2027.pdf', size: 10, sha256: 'abcdef1234567890' }], agencyRevision: '', effectiveDate: '2027-01-01',
  summary: 'Minimum wage $17.40', origin: 'watcher', preparedBy: 'Charmi', preparedByEmail: 'charmi@x.com', preparedAt: '2026-10-22T10:00:00Z',
  submittedAt: '2026-10-22T10:00:00Z', approvedBy: '', approvedAt: '', reviewNote: '', retiredAt: '', ...over,
});
const notice = (over) => ({
  id: 'ca-mw', title: 'California Minimum Wage', formCode: 'MW-2026', agency: 'DIR', kind: 'poster', area: 'US-CA', mode: 'post',
  trigger: 'always', annualDue: '', window: [], applies: { workerTypes: ['employee'] }, requiresAck: false, languages: ['en'],
  sourceUrl: 'https://www.dir.ca.gov/iwc/MW-2026.pdf', notes: '', status: 'active', state: 'awaiting_approval', reviewDue: '', sort: 1,
  live: null, scheduled: null, pending: [ver()], source: null, ...over,
});

beforeEach(() => {
  library.mockReset().mockResolvedValue({
    notices: [notice(), notice({ id: 'fed-flsa', title: 'Employee Rights Under the FLSA', area: 'US', state: 'needs_file', pending: [] })],
    queue: [ver()], canApprove: true, approvers: [{ email: 'charmi@x.com', name: 'Charmi' }], unplaced: [],
    settings: { approvers: [], countCompaniesTogether: true, yearlyAck: true, yearlyAckDueDays: 31, ackDueDays: 14, eVerify: true,
      txWorkersComp: 'subscriber', languages: ['en'], elections: ['2026-11-03'], watcherOn: true },
  });
  detail.mockReset().mockResolvedValue({ ...notice(), versions: [ver()], events: [] });
  review.mockReset().mockResolvedValue(ver({ status: 'approved' }));
});

describe('NoticesAdmin', () => {
  it('renders the library grouped by area', async () => {
    render(<NoticesAdmin toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('California Minimum Wage')).toBeInTheDocument();
    expect(screen.getByText('Federal')).toBeInTheDocument();
    expect(screen.getByText('California')).toBeInTheDocument();
  });

  it('opens a notice and approves the waiting version', async () => {
    const ok = vi.fn();
    render(<NoticesAdmin toastOk={ok} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByText('California Minimum Wage'));
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(review).toHaveBeenCalledWith('v1', { decision: 'approve' }));
    expect(ok).toHaveBeenCalledWith('Approved.');
  });

  it('after Approve, re-reads the notice and the queue before Approve can be clicked again', async () => {
    let finish;
    detail.mockResolvedValueOnce({ ...notice(), versions: [ver()], events: [] })
      .mockReturnValueOnce(new Promise(r => { finish = r; }));
    render(<NoticesAdmin toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByText('California Minimum Wage'));
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(library).toHaveBeenCalledTimes(2));     // queue and counts behind the popup
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
    finish({ ...notice({ state: 'scheduled', pending: [] }), versions: [ver({ status: 'approved' })], events: [] });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull());
  });

  it('a failed refresh behind the popup keeps the popup open', async () => {
    render(<NoticesAdmin toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByText('California Minimum Wage'));
    library.mockRejectedValueOnce(new Error('Could not load the notices.'));
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(library).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Could not load the notices.')).toBeNull();
    expect(await screen.findByRole('button', { name: /Approve/ })).toBeInTheDocument();   // the popup is still up
  });

  it('Coverage says Complete on every row the headline counts as complete', async () => {
    const person = (over) => ({ email: 'a@x.com', name: 'A', country: 'US', state: '', workerType: 'employee', owed: [], notGiven: [], emergency: 'done', ...over });
    coverage.mockResolvedValue({ totals: { people: 2, allDone: 1 }, people: [
      person({ email: 'c@x.com', name: 'Contractor Person', workerType: 'contractor' }),   // US, no state, owes nothing
      person({ email: 'e@x.com', name: 'Unplaced Employee' }),                             // US employee, no state: not complete
    ] });
    render(<NoticesAdmin toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Coverage/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Everyone' }));
    expect(screen.getAllByText('Complete')).toHaveLength(1);
    expect(screen.getByText('Contractor Person').closest('span').parentElement.textContent).toContain('Complete');
  });

  it('shows the review queue', async () => {
    render(<NoticesAdmin toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Review Queue/ }));
    expect(await screen.findByText(/Waiting For Approval/)).toBeInTheDocument();
  });
});
