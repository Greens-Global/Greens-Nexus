import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';

// Team > Requests moved into Approvals (Neil, 11/04/2026: "make sure that you
// are not losing any functionality"). What the old inbox gave a decider must
// be here: the schedule around a request, Approve And Remove Shifts and the
// Remove Those Shifts follow-up, the HR hand-on message, a required decline
// note, Approve Anyway over a conflict, what waits on a teammate, and what
// the team decided lately - and a request opened from the planner's strip
// opens in Review.

const approvalsInbox = vi.fn();
const timeOffDecide = vi.fn();
const shiftRequestDecide = vi.fn();
const timeSchedule = vi.fn();
const shiftRequestsInbox = vi.fn();
const known = {
  approvalsInbox: (...a) => approvalsInbox(...a),
  approvalsHistory: () => Promise.resolve({ days: 30, decidedToday: 0, decidedWeek: 0, avgWaitDays: 0, rows: [] }),
  approvalsDecided: () => Promise.resolve({}),
  timeOffDecide: (...a) => timeOffDecide(...a),
  shiftRequestDecide: (...a) => shiftRequestDecide(...a),
  timeSchedule: (...a) => timeSchedule(...a),
  shiftRequestsInbox: (...a) => shiftRequestsInbox(...a),
  getPeopleDirectory: () => Promise.resolve([]),
  getTaskTablePrefs: () => Promise.resolve({ prefs: {} }),
  saveTaskTablePrefs: () => Promise.resolve({}),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => known[k] || (() => Promise.resolve(null)) });
  return { api, default: api };
});
const prompt = vi.fn();
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => prompt(...a), confirm: (...a) => confirm(...a) } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myGrantedModules: new Set(), myEmail: 'me@greensglobal.com' }),
}));

const { default: Approvals } = await import('./ApprovalsCenter');
const { UNDO_MS, runApproval } = await import('../lib/approvalActions');
const { openApproval, takeApprovalFocus } = await import('./focus');

const A = (key, label, tone = 'plain', note = 'none') => ({ key, label, tone, note });
const LABELS = [{ key: 'timeoff', label: 'Time Off' }, { key: 'shifts', label: 'Shifts' }];
const TIME_OFF = {
  key: 'time_off:t1', kind: 'time_off', id: 't1', group: 'timeoff', source: 'time_off', count: 1,
  person: { email: 'amy@x.com', name: 'Amy Test' }, title: 'Time Off - 11/16/2026 to 11/17/2026 (2 days)',
  detail: 'Vacation · 1 shared shift inside', createdAt: new Date().toISOString(), priority: 'medium',
  actions: [A('approve', 'Approve', 'primary'), A('approve_remove', 'Approve And Remove Shifts'), A('reject', 'Decline', 'plain', 'required')],
  facts: [{ label: 'Reason', value: 'Beach week' }, { label: 'Shared Shifts Inside', value: 'Mon 11/16/2026 9:00 AM - 5:00 PM' }],
  context: { email: 'amy@x.com', from: '2026-11-16', to: '2026-11-17' },
  link: { view: 'hr', sub: 'hr-time' },
};
const SWAP = {
  key: 'shift_request:s1', kind: 'shift_request', id: 's1', group: 'shifts', source: 'shift_request', count: 1,
  person: { email: 'bo@x.com', name: 'Bo Test' }, title: 'Swap - 11/18/2026', detail: 'Bo wants to swap with Cy',
  createdAt: new Date().toISOString(), priority: 'medium',
  actions: [A('approve', 'Approve', 'primary'), A('decline', 'Decline', 'plain', 'required')],
  facts: [{ label: 'Teammate', value: 'Cy Test' }], link: { view: 'shifts', sub: 'schedule:2026-11-18' },
};
const inbox = (rows) => ({ rows, counts: {}, groups: Object.fromEntries(rows.map((r) => [r.group, 1])), groupLabels: LABELS, errors: [], total: rows.length });
const SCHED = {
  scheduled: [
    { id: 'x1', email: 'amy@x.com', date: '2026-11-16', start: '09:00', end: '17:00' },
    { id: 'x2', email: 'cy@x.com', date: '2026-11-16', start: '09:00', end: '17:00' },
  ],
  groups: [{ id: 'g1', name: 'Front Desk', members: ['amy@x.com', 'cy@x.com', 'di@x.com'] }],
  timeoff: [{ email: 'di@x.com', startDate: '2026-11-17', endDate: '2026-11-17', status: 'approved' }],
  shifts: [], usual: {},
};

beforeEach(() => {
  [approvalsInbox, timeOffDecide, shiftRequestDecide, timeSchedule, shiftRequestsInbox, prompt, confirm].forEach((f) => f.mockReset());
  timeSchedule.mockResolvedValue(SCHED);
  shiftRequestsInbox.mockResolvedValue({ pending: [], waitingOnPeer: [], recent: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('requests in Approvals', () => {
  it('shows the schedule a time-off request lands on in Review, from one schedule read', async () => {
    approvalsInbox.mockResolvedValue(inbox([TIME_OFF]));
    render(<Approvals />);
    const row = (await screen.findByText(TIME_OFF.title)).closest('.apv-row');
    fireEvent.click(within(row).getByRole('button', { name: /^Review:/ }));
    const dlg = await screen.findByLabelText('Request details');
    const box = await waitFor(() => { const b = dlg.querySelector('[data-schedule-context]'); if (!b) throw new Error('no context'); return b; });
    expect(timeSchedule).toHaveBeenCalledWith('2026-11-16', '2026-11-17');
    expect(within(box).getByText('Lands On')).toBeTruthy();
    expect(within(box).getByText('Front Desk On')).toBeTruthy();
    expect(within(box).getByText('Also Off')).toBeTruthy();
    expect(within(dlg).getByText('Beach week')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Approve And Remove Shifts' })).toBeTruthy();
  });

  it('Approve And Remove Shifts sends remove_shifts and says to share', async () => {
    approvalsInbox.mockResolvedValue(inbox([TIME_OFF]));
    timeOffDecide.mockResolvedValue({ conflicts: [] });
    render(<Approvals />);
    await screen.findByText(TIME_OFF.title);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: /^Approve And Remove Shifts: Time Off/ }));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(timeOffDecide).toHaveBeenCalledWith('t1', { status: 'approved', note: '', remove_shifts: true });
    expect(await screen.findByText(/marked for removal\. Share the schedule/)).toBeTruthy();
  });

  it('a plain Approve with shifts still standing offers Remove Those Shifts', async () => {
    approvalsInbox.mockResolvedValue(inbox([TIME_OFF]));
    timeOffDecide.mockResolvedValueOnce({ conflicts: [{ id: 'x1' }] }).mockResolvedValueOnce({ conflicts: [] });
    render(<Approvals />);
    await screen.findByText(TIME_OFF.title);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: /^Approve: Time Off/ }));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(await screen.findByText('Time off approved. 1 shared shift inside it still stands.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Those Shifts' })); });
    expect(timeOffDecide).toHaveBeenLastCalledWith('t1', { status: 'approved', note: '', remove_shifts: true });
  });

  it('says when an approval now waits for HR', async () => {
    approvalsInbox.mockResolvedValue(inbox([TIME_OFF]));
    timeOffDecide.mockResolvedValue({ awaitingHr: true, conflicts: [] });
    render(<Approvals />);
    await screen.findByText(TIME_OFF.title);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: /^Approve: Time Off/ }));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(await screen.findByText(/it now waits for HR approval/)).toBeTruthy();
  });

  it('asks for the reason a decline needs', async () => {
    approvalsInbox.mockResolvedValue(inbox([TIME_OFF]));
    prompt.mockResolvedValue('We are short that week');
    timeOffDecide.mockResolvedValue({});
    render(<Approvals />);
    await screen.findByText(TIME_OFF.title);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Decline: Time Off/ })); });
    expect(prompt.mock.calls[0][1]).toMatchObject({ required: true });
    expect(prompt.mock.calls[0][0]).toMatch(/Tell them why/);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(timeOffDecide).toHaveBeenCalledWith('t1', { status: 'rejected', note: 'We are short that week' });
  });

  it('asks before approving a shift request over a conflict, and forces it on Approve Anyway', async () => {
    approvalsInbox.mockResolvedValue(inbox([SWAP]));
    shiftRequestDecide.mockRejectedValueOnce(Object.assign(new Error('Cy already works then.'), { status: 409 })).mockResolvedValueOnce({});
    confirm.mockResolvedValue(true);
    render(<Approvals activeSub="shifts" />);
    await screen.findByText(SWAP.title);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: /^Approve: Swap/ }));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    await waitFor(() => expect(shiftRequestDecide).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[0][1]).toMatchObject({ confirmText: 'Approve Anyway' });
  });

  it('lists what waits on a teammate and what the team decided, under Shifts', async () => {
    approvalsInbox.mockResolvedValue(inbox([SWAP]));
    shiftRequestsInbox.mockResolvedValue({
      pending: [],
      waitingOnPeer: [{ id: 'w1', summary: 'Bo offers Wed 11/18/2026 to Cy', requester: { email: 'bo@x.com', name: 'Bo Test' }, target: { email: 'cy@x.com', name: 'Cy Test' } }],
      recent: [{ id: 'r1', status: 'declined', summary: 'Di asks for the open shift on 11/12/2026', requester: { email: 'di@x.com', name: 'Di Test' },
        decidedBy: 'ed@x.com', decisionNote: 'Already covered', decidedAt: '2026-11-03T15:00:00' }],
    });
    render(<Approvals activeSub="shifts" />);
    const waiting = await waitFor(() => { const b = document.querySelector('[data-waiting-peer]'); if (!b) throw new Error('none'); return b; });
    expect(within(waiting).getByText('Bo offers Wed 11/18/2026 to Cy')).toBeTruthy();
    const recent = document.querySelector('[data-recent-decided]');
    expect(within(recent).getByText('Declined')).toBeTruthy();
    expect(within(recent).getByText(/Already covered/)).toBeTruthy();
    expect(within(recent).getByText('11/03/2026')).toBeTruthy();
  });

  it('opens the request the planner strip pointed at in Review', async () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    openApproval('time_off:t1', 'timeoff');
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'dashboard', sub: 'approvals:timeoff' }]);
    approvalsInbox.mockResolvedValue(inbox([TIME_OFF]));
    render(<Approvals activeSub="timeoff" />);
    expect(await screen.findByLabelText('Request details')).toBeTruthy();
  });
});

describe('focus handoff', () => {
  it('hands a key back once, only when the list holds it', () => {
    openApproval('time_off:z', 'timeoff');
    expect(takeApprovalFocus(() => false)).toBe('');
    expect(takeApprovalFocus((k) => k === 'time_off:z')).toBe('time_off:z');
    expect(takeApprovalFocus(() => true)).toBe('');
  });

  it('runs Approve And Remove Shifts through the time-off endpoint', async () => {
    timeOffDecide.mockResolvedValue({});
    await runApproval({ kind: 'time_off', id: 't9' }, 'approve_remove', '');
    expect(timeOffDecide).toHaveBeenCalledWith('t9', { status: 'approved', note: '', remove_shifts: true });
  });
});
