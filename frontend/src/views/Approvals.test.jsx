import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Render-smoke for Approvals (/approvals): every state paints something
// (loading, empty, a failing source, rows), the chips filter by kind with
// counts, and a decision leaves at once, can be undone, and only then calls
// the module's own endpoint - a refusal brings the row back.

const approvalsInbox = vi.fn();
const timeOffDecide = vi.fn();
const decideReimbursement = vi.fn();
const addTaskComment = vi.fn();
// HR's kinds (Oct 27 2026).
const hrApi = { timeOffHrDecide: vi.fn(), decideSalaryAdvance: vi.fn(), probationApprove: vi.fn(),
  probationDecline: vi.fn(), hrLetterDecline: vi.fn(), decideHeadcount: vi.fn() };
vi.mock('../api', () => ({
  api: {
    approvalsInbox: (...a) => approvalsInbox(...a),
    timeOffDecide: (...a) => timeOffDecide(...a),
    decideReimbursement: (...a) => decideReimbursement(...a),
    addTaskComment: (...a) => addTaskComment(...a),
    ...Object.fromEntries(Object.keys(hrApi).map((k) => [k, (...a) => hrApi[k](...a)])),
  },
}));
const prompt = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => prompt(...a), confirm: vi.fn() } }));

const { default: Approvals } = await import('./Approvals');
const { UNDO_MS, shortName, waited, runApproval, runsInline } = await import('../lib/approvalActions');

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
const A = (key, label, tone = 'plain', note = 'none') => ({ key, label, tone, note });
const INBOX = {
  rows: [
    { key: 'time_off:t1', kind: 'time_off', id: 't1', group: 'timeoff', source: 'time_off', count: 1,
      person: { email: 'priya.s@greensglobal.com', name: 'Priya Sharma' },
      title: 'Time Off - 11/03/2026 to 11/05/2026 (3 days)', detail: 'Vacation', createdAt: iso(26),
      actions: [A('approve', 'Approve', 'primary'), A('reject', 'Reject', 'plain', 'optional')],
      link: { view: 'hr', sub: 'hr-time' }, forName: 'Max Test' },
    { key: 'reimbursement:r1', kind: 'reimbursement', id: 'r1', group: 'money', source: 'reimbursement', count: 1,
      person: { email: 'ankit.p@greensglobal.com', name: 'Ankit Patel' },
      title: 'Reimbursement - $142.50 (2 receipts)', detail: 'Monitor', createdAt: iso(5),
      actions: [A('approve', 'Approve', 'primary'), A('send_back', 'Send Back', 'plain', 'required')],
      link: { view: 'myhr', sub: 'reimbursements' }, forName: '' },
    { key: 'timesheet_review:a|b', kind: 'timesheet_review', id: 'a|b', group: 'timesheets', source: 'timesheet_review', count: 4,
      person: { email: '', name: 'Austin' }, title: 'Time Sheet Review - 10/12/2026 to 10/25/2026 (4 people)',
      detail: '', createdAt: iso(2), actions: [A('open', 'Review')], link: { view: 'hr', sub: 'hr-time' }, forName: '' },
  ],
  counts: { time_off: 1, reimbursement: 1, timesheet_review: 4 },
  groups: { timeoff: 1, money: 1, timesheets: 4 },
  groupLabels: [{ key: 'timeoff', label: 'Time Off' }, { key: 'timesheets', label: 'Time Sheets' },
    { key: 'shifts', label: 'Shifts' }, { key: 'money', label: 'Money' }, { key: 'hiring', label: 'Hiring' },
    { key: 'signatures', label: 'Signatures' }],
  errors: [],
  total: 6,
};

beforeEach(() => {
  [approvalsInbox, timeOffDecide, decideReimbursement, addTaskComment, prompt].forEach((f) => f.mockReset());
});
afterEach(() => { vi.useRealTimers(); });

const chip = (name) => screen.getAllByRole('tab').find((t) => t.textContent.startsWith(name));

describe('Approvals', () => {
  it('renders the rows oldest first, with chips that count and filter', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    const onSubChange = vi.fn();
    const { rerender } = render(<Approvals activeSub={null} onSubChange={onSubChange} />);
    expect(await screen.findByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)')).toBeTruthy();
    expect(screen.getByText('Priya S.')).toBeTruthy();
    expect(screen.getByText('Austin')).toBeTruthy();
    expect(screen.getByText('For Max Test')).toBeTruthy();
    expect(screen.getByText('1d ago')).toBeTruthy();
    // All 6 (the review row stands for 4 people); chips with nothing are left out.
    expect(chip('All').textContent).toBe('All6');
    expect(chip('Time Sheets').textContent).toBe('Time Sheets4');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).not.toContain('Hiring0');
    fireEvent.click(chip('Money'));
    expect(onSubChange).toHaveBeenCalledWith('money');
    rerender(<Approvals activeSub="money" onSubChange={onSubChange} />);
    expect(screen.queryByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)')).toBeNull();
    expect(screen.getByText('Reimbursement - $142.50 (2 receipts)')).toBeTruthy();
  });

  it('shows a friendly empty state', async () => {
    approvalsInbox.mockResolvedValue({ ...INBOX, rows: [], counts: {}, groups: {}, total: 0 });
    render(<Approvals />);
    expect(await screen.findByText('Nothing waiting on you')).toBeTruthy();
  });

  it('says quietly which source could not load, and still lists the rest', async () => {
    approvalsInbox.mockResolvedValue({ ...INBOX, errors: [{ source: 'reimbursement', label: 'Reimbursements' }] });
    render(<Approvals />);
    expect(await screen.findByText("Couldn't load Reimbursements.")).toBeTruthy();
    expect(screen.getByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)')).toBeTruthy();
  });

  it('shows an error banner when the whole inbox fails', async () => {
    approvalsInbox.mockRejectedValue(new Error('down'));
    render(<Approvals />);
    expect(await screen.findByText(/couldn't be loaded/)).toBeTruthy();
  });

  it('removes a decision at once, undoes it, and sends it only after the Undo window', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    timeOffDecide.mockResolvedValue({ conflicts: [] });
    render(<Approvals />);
    await screen.findByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: /^Approve: Time Off/ }));
    expect(screen.queryByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)')).toBeNull();
    expect(chip('All').textContent).toBe('All5');
    fireEvent.click(screen.getByText('Undo'));
    expect(screen.getByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(timeOffDecide).not.toHaveBeenCalled();
    // Again, and let it go through: the module's own endpoint.
    fireEvent.click(screen.getByRole('button', { name: /^Approve: Time Off/ }));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(timeOffDecide).toHaveBeenCalledWith('t1', { status: 'approved', note: '' });
  });

  it('asks for the note Send Back needs, and brings the row back when the module refuses', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    decideReimbursement.mockRejectedValue(new Error('Already with HR'));
    prompt.mockResolvedValue('Attach the receipt');
    render(<Approvals />);
    await screen.findByText('Reimbursement - $142.50 (2 receipts)');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Send Back: Reimbursement/ })); });
    expect(prompt).toHaveBeenCalled();
    expect(prompt.mock.calls[0][1]).toMatchObject({ required: true, confirmText: 'Send Back' });
    expect(screen.queryByText('Reimbursement - $142.50 (2 receipts)')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(decideReimbursement).toHaveBeenCalledWith('r1', { action: 'send_back', note: 'Attach the receipt' });
    expect(await screen.findByText('Already with HR')).toBeTruthy();
    expect(screen.getByText('Reimbursement - $142.50 (2 receipts)')).toBeTruthy();
  });

  it('a cancelled note decides nothing', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    prompt.mockResolvedValue(null);
    render(<Approvals />);
    await screen.findByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Reject: Time Off/ })); });
    expect(screen.getByText('Time Off - 11/03/2026 to 11/05/2026 (3 days)')).toBeTruthy();
    expect(screen.queryByText('Undo')).toBeNull();
  });

  it('opens a row that needs more than one click in its module', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    render(<Approvals />);
    const row = (await screen.findByText(/Time Sheet Review/)).closest('.apv-row');
    fireEvent.click(within(row).getByRole('button', { name: /^Review:/ }));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'hr', sub: 'hr-time' }]);
  });
});

describe('HR approvals (Oct 27 2026)', () => {
  it("decides through each module's own endpoint", async () => {
    Object.values(hrApi).forEach((f) => f.mockReset().mockResolvedValue({}));
    await runApproval({ kind: 'time_off_hr', id: 't9' }, 'approve');
    expect(hrApi.timeOffHrDecide).toHaveBeenCalledWith('t9', { status: 'approved', note: '' });
    await runApproval({ kind: 'salary_advance', id: 'a1' }, 'decline', 'Too soon');
    expect(hrApi.decideSalaryAdvance).toHaveBeenCalledWith('a1', { action: 'decline', note: 'Too soon' });
    await runApproval({ kind: 'probation', id: 'e1' }, 'approve');
    expect(hrApi.probationApprove).toHaveBeenCalledWith('e1', {});
    await runApproval({ kind: 'probation', id: 'e1' }, 'decline', 'Not yet');
    expect(hrApi.probationDecline).toHaveBeenCalledWith('e1', 'Not yet');
    await runApproval({ kind: 'hr_letter', id: 'l1' }, 'decline', 'Wrong type');
    expect(hrApi.hrLetterDecline).toHaveBeenCalledWith('l1', 'Wrong type');
    await runApproval({ kind: 'headcount', id: 'h1' }, 'approve');
    expect(hrApi.decideHeadcount).toHaveBeenCalledWith('h1', 'approve', '');
  });
  it('opens the steps that need more than a click', () => {
    expect(runsInline({ kind: 'hr_letter' }, 'open')).toBe(false);
    expect(runsInline({ kind: 'salary_advance_payout' }, 'open')).toBe(false);
    expect(runsInline({ kind: 'probation_due' }, 'open')).toBe(false);
    expect(runsInline({ kind: 'headcount' }, 'decline')).toBe(true);
  });
});

describe('helpers', () => {
  it('shortens a person, never a team or place', () => {
    expect(shortName({ email: 'p@x.com', name: 'Priya Sharma' })).toBe('Priya S.');
    expect(shortName({ email: '', name: 'Your Team' })).toBe('Your Team');
    expect(shortName({ email: 'p@x.com', name: 'You' })).toBe('You');
  });
  it('says how long it waited', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(waited('2026-10-27T11:59:30Z', now)).toBe('Just now');
    expect(waited('2026-10-27T10:00:00Z', now)).toBe('2h ago');
    expect(waited('2026-10-25T12:00:00Z', now)).toBe('2d ago');
    expect(waited('', now)).toBe('');
  });
});
