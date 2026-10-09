// My Day tile (Essentials, Oct 7): the row builder's ordering, the cap and
// View All, the empty state, and the one-click actions against the real
// /daily-briefing/me row shape (mocked). A crash here would blank a saved
// dashboard view, so the tile is mounted, not just the pure function.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyBriefing: vi.fn(), actOnMyBriefing: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyDay, { buildMyDayRows, urgencyOf, targetFor, nextDueOf, OVERDUE, DUE_TODAY, WAITING, MAX_ROWS } from './MyDay.jsx';

// Fixed "now": Thursday 10/08/2026 09:00 local.
const NOW = new Date(2026, 9, 8, 9, 0);

const approval = { title: 'Approve: Budget sign-off', detail: 'Waiting on your decision', module: 'tasks', path: '/tasks/mine?task=t1', taskId: 't1', decision: { kind: 'task_approval', id: 't1' } };
const timeOff = { title: "Approve: Sagar Patel's time off (Vacation)", detail: '10/12/2026 - 10/14/2026', module: 'time_off', path: '/timeclock', decision: { kind: 'timeoff_approval', id: 'to1' } };
const ticketApproval = { title: 'Approve: New laptop', detail: '#27 - waiting on your decision', module: 'tickets', path: '/tickets?ticket=tk1', decision: { kind: 'ticket_approval', id: 'tk1' } };
const dueToday = { title: 'Send the Q3 report', detail: 'Due today - Finance', module: 'tasks', path: '/tasks/mine?task=t2', taskId: 't2', taskOpen: true };
const closedCard = { title: 'Submit your time card', detail: 'Pay period ending 10/04/2026 is closed - sign off is still open', module: 'timecard', path: '/timeclock' };
const signature = { title: 'Sign: Offer Letter - Priya', detail: 'Signature required', module: 'documents', path: '/documents/documents-esign' };
const punchFix = { title: "Approve: Ankush Jain's timesheet fix", detail: 'Asked to add a clock-out on 10/06/2026', module: 'timecard', path: '/hr/hr-time-requests' };
const review = { title: "Review Visesh's timesheet", detail: '09/21/2026 - 10/04/2026 - 80h 00m', module: 'timecard', path: '/timeclock/timesheet' };
const bundled = { title: "Approve: Charmi's time off (2 requests)", detail: '2 pending requests - decide each below', module: 'time_off', path: '/timeclock',
  subDecisions: [{ detail: '10/20/2026 - 10/21/2026 (Vacation)', kind: 'timeoff_approval', id: 'to2' }, { detail: '11/02/2026 - 11/02/2026 (Sick)', kind: 'timeoff_approval', id: 'to3' }] };

const briefing = (rows, extra = []) => ({ greeting: 'Good morning', firstName: 'Neil', date: '2026-10-08', since: '2026-10-07T13:00:00', reactions: [],
  sections: [{ key: 'action_required', label: 'Action Required', rows }, ...extra] });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  apiMock.actOnMyBriefing.mockResolvedValue({ ok: true, message: 'Done.' });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('buildMyDayRows', () => {
  it('reads urgency from the row wording', () => {
    expect(urgencyOf(closedCard, NOW)).toBe(OVERDUE);
    expect(urgencyOf(dueToday, NOW)).toBe(DUE_TODAY);
    expect(urgencyOf({ module: 'timecard', detail: 'Pay period closes 10/08/2026 - review and sign off before it locks' }, NOW)).toBe(DUE_TODAY);
    expect(urgencyOf({ module: 'timecard', detail: 'Pay period closes 10/10/2026 - review and sign off before it locks' }, NOW)).toBe(WAITING);
    expect(urgencyOf({ module: 'time_off', detail: '10/01/2026 - 10/03/2026' }, NOW)).toBe(OVERDUE);
    expect(urgencyOf({ module: 'time_off', detail: '10/07/2026 - 10/09/2026' }, NOW)).toBe(DUE_TODAY);
    expect(urgencyOf(timeOff, NOW)).toBe(WAITING);
    expect(urgencyOf(review, NOW)).toBe(WAITING);   // a review period is always in the past; that is not overdue
  });

  it('sorts overdue before due today before waiting, keeping server order inside a class', () => {
    const rows = buildMyDayRows(briefing([approval, timeOff, dueToday, signature, closedCard]), NOW);
    expect(rows.map((r) => r.title)).toEqual([
      'Submit your time card', 'Send the Q3 report', 'Approve: Budget sign-off', "Approve: Sagar Patel's time off (Vacation)", 'Sign: Offer Letter - Priya',
    ]);
  });

  it('puts the oldest first when rows carry a timestamp', () => {
    const rows = buildMyDayRows(briefing([
      { ...approval, createdAt: new Date(NOW.getTime() - 20 * 3600000).toISOString() },
      { ...signature, createdAt: new Date(NOW.getTime() - 2 * 86400000 - 3600000).toISOString() },
    ]), NOW);
    expect(rows.map((r) => r.title)).toEqual(['Sign: Offer Letter - Priya', 'Approve: Budget sign-off']);
    expect(rows[0].meta).toBe('Signature required · 2d');
  });

  it('assigns a kind and one action per row, and splits a bundled time-off card per request', () => {
    const rows = buildMyDayRows(briefing([approval, ticketApproval, dueToday, signature, punchFix, review, bundled, closedCard]), NOW);
    const by = (t) => rows.filter((r) => r.title === t);
    expect(by('Approve: Budget sign-off')[0]).toMatchObject({ kind: 'approval', action: { type: 'decision', label: 'Approve' } });
    expect(by('Approve: New laptop')[0]).toMatchObject({ kind: 'approval', decision: { kind: 'ticket_approval', id: 'tk1' } });
    expect(by('Send the Q3 report')[0]).toMatchObject({ kind: 'task', action: { type: 'complete', label: 'Complete' } });
    expect(by('Sign: Offer Letter - Priya')[0]).toMatchObject({ kind: 'signature', action: { type: 'nav', label: 'Sign' } });
    expect(by("Approve: Ankush Jain's timesheet fix")[0]).toMatchObject({ kind: 'punch', action: { label: 'Fix Punch' } });
    expect(by("Review Visesh's timesheet")[0]).toMatchObject({ kind: 'timesheet_review', action: { label: 'Open' } });
    expect(by('Submit your time card')[0]).toMatchObject({ kind: 'timecard', action: { label: 'Open' } });
    const split = by("Approve: Charmi's time off (2 requests)");
    expect(split).toHaveLength(2);
    expect(split.map((r) => r.decision.id)).toEqual(['to2', 'to3']);
    expect(split[0].meta).toBe('10/20/2026 - 10/21/2026 (Vacation)');
  });

  it('maps the briefing paths onto the app views', () => {
    expect(targetFor('/tasks/mine?task=t1')).toMatchObject({ view: 'tasks', sub: 'mine', taskId: 't1' });
    expect(targetFor('/tickets?ticket=tk1')).toMatchObject({ view: 'tickets', sub: null, ticketId: 'tk1' });
    expect(targetFor('/itemmanagement')).toMatchObject({ view: 'inventory', sub: null });
    expect(targetFor('/documents/documents-esign')).toMatchObject({ view: 'documents', sub: 'documents-esign' });
    expect(targetFor('/hr/hr-time-requests')).toMatchObject({ view: 'hr', sub: 'hr-time-requests' });
    expect(targetFor('https://dev.nexus.example/shifts/mine')).toMatchObject({ view: 'shifts', sub: 'mine' });
    expect(targetFor('')).toBeNull();
  });

  it('finds the next due item in the other sections', () => {
    const d = briefing([], [{ key: 'needs_to_know', label: 'Updates for You', rows: [{ title: 'A comment', detail: 'New activity', module: 'tasks' }, { title: 'Renew insurance', detail: 'Due Fri 10/09/2026', module: 'tasks' }] }]);
    expect(nextDueOf(d)?.title).toBe('Renew insurance');
    expect(nextDueOf(briefing([]))).toBeNull();
  });
});

describe('My Day tile', () => {
  it('shows a loader, then the rows most urgent first with the count in the header', async () => {
    apiMock.getMyBriefing.mockResolvedValue(briefing([approval, dueToday, closedCard]));
    render(<MyDay />);
    expect(screen.queryByText('3 things need you')).toBeNull();
    expect(await screen.findByText('3 things need you')).toBeInTheDocument();
    const titles = screen.getAllByTestId('my-day-row').map((el) => within(el).getByRole('button', { name: /Submit|Send|Approve:/ }).textContent);
    expect(titles[0]).toContain('Submit your time card');
    expect(titles[1]).toContain('Send the Q3 report');
    expect(titles[2]).toContain('Approve: Budget sign-off');
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Due Today')).toBeInTheDocument();
  });

  it('caps at seven rows and View All opens the briefing', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...signature, title: `Sign: Document ${i + 1}` }));
    apiMock.getMyBriefing.mockResolvedValue(briefing(many));
    const dispatched = vi.spyOn(window, 'dispatchEvent');
    render(<MyDay />);
    expect(await screen.findByText('9 things need you')).toBeInTheDocument();
    expect(screen.getAllByTestId('my-day-row')).toHaveLength(MAX_ROWS);
    expect(screen.queryByText('Sign: Document 8')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /View All \(9\)/ }));
    const ev = dispatched.mock.calls.map((c) => c[0]).find((e) => e.type === 'nexus:navigate');
    expect(ev.detail).toEqual({ view: 'briefing', sub: null });
    dispatched.mockRestore();
  });

  it('says you are clear when nothing needs you, and names the next due item', async () => {
    apiMock.getMyBriefing.mockResolvedValue(briefing([], [{ key: 'needs_to_know', label: 'Updates for You', rows: [{ title: 'Renew insurance', detail: 'Due Fri 10/09/2026', module: 'tasks' }] }]));
    render(<MyDay />);
    expect(await screen.findByText(/You're clear for today\./)).toBeInTheDocument();
    expect(screen.getByText(/Next up: Renew insurance - Due Fri 10\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();
  });

  it('shows an error line, never a blank card, when the briefing fails to load', async () => {
    apiMock.getMyBriefing.mockRejectedValue(new Error('boom'));
    render(<MyDay />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/);
  });

  it('Approve posts the decision, drops the row at once and refetches', async () => {
    apiMock.getMyBriefing.mockResolvedValueOnce(briefing([approval, signature])).mockResolvedValue(briefing([signature]));
    render(<MyDay />);
    expect(await screen.findByText('2 things need you')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(apiMock.actOnMyBriefing).toHaveBeenCalledWith({ kind: 'decision', id: 't1', decision_kind: 'task_approval', action: 'approve', text: '' });
    await waitFor(() => expect(screen.queryByText('Approve: Budget sign-off')).toBeNull());
    await waitFor(() => expect(apiMock.getMyBriefing).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('1 thing needs you')).toBeInTheDocument();
  });

  it('Reject asks for a reason inline and only then posts it', async () => {
    apiMock.getMyBriefing.mockResolvedValueOnce(briefing([ticketApproval])).mockResolvedValue(briefing([]));
    render(<MyDay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(apiMock.actOnMyBriefing).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Confirm Reject' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Reason for rejecting (required)'), { target: { value: 'Not in this budget' } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(apiMock.actOnMyBriefing).toHaveBeenCalledWith({ kind: 'decision', id: 'tk1', decision_kind: 'ticket_approval', action: 'reject', text: 'Not in this budget' });
    await waitFor(() => expect(screen.queryByText('Approve: New laptop')).toBeNull());
  });

  it('Complete marks a task due today done through the briefing action', async () => {
    apiMock.getMyBriefing.mockResolvedValueOnce(briefing([dueToday])).mockResolvedValue(briefing([]));
    render(<MyDay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    expect(apiMock.actOnMyBriefing).toHaveBeenCalledWith({ kind: 'task', id: 't2', action: 'complete', text: '' });
    await waitFor(() => expect(screen.queryByText('Send the Q3 report')).toBeNull());
  });

  it('keeps the row and shows the message inline when an action fails', async () => {
    apiMock.getMyBriefing.mockResolvedValue(briefing([approval]));
    apiMock.actOnMyBriefing.mockRejectedValue(new Error('You are not this task\'s approver.'));
    render(<MyDay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("You are not this task's approver.");
    expect(screen.getByText('Approve: Budget sign-off')).toBeInTheDocument();
  });

  it('Sign and Open hand off to the owning screen, and a task row opens that task', async () => {
    apiMock.getMyBriefing.mockResolvedValue(briefing([signature, dueToday]));
    const dispatched = vi.spyOn(window, 'dispatchEvent');
    render(<MyDay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    let navs = dispatched.mock.calls.map((c) => c[0]).filter((e) => e.type === 'nexus:navigate');
    expect(navs.at(-1).detail).toEqual({ view: 'documents', sub: 'documents-esign' });
    fireEvent.click(screen.getByRole('button', { name: /Send the Q3 report/ }));
    navs = dispatched.mock.calls.map((c) => c[0]).filter((e) => e.type === 'nexus:navigate');
    expect(navs.at(-1).detail).toEqual({ view: 'tasks', sub: 'mine' });
    await waitFor(() => expect(dispatched.mock.calls.map((c) => c[0]).some((e) => e.type === 'nexus:open-task' && e.detail.taskId === 't2')).toBe(true));
    dispatched.mockRestore();
  });
});
