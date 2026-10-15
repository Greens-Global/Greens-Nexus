import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Share Schedule, two steps (Shifts Phase 2, Oct 14): step 1 picks the dates,
// group and who hears, and ends in Review; step 2 sums up the changes per
// person, lists rule and conflict warnings per person (each a jump to the
// cell), needs a reason when the company requires one for a schedule with
// warnings, and shows the server's refusal in place.

const timeSchedUnshared = vi.fn();
const timeSchedPublishReview = vi.fn();
const timeSchedShares = vi.fn();
vi.mock('../../api', () => ({
  api: {
    timeSchedUnshared: (...a) => timeSchedUnshared(...a),
    timeSchedPublishReview: (...a) => timeSchedPublishReview(...a),
    timeSchedShares: (...a) => timeSchedShares(...a),
  },
}));

const { ShareDialog, changeLine, reviewSummary } = await import('./ScheduleToolbar');

const REVIEW = {
  people: 2, reasonRequired: true,
  changes: [
    { email: 'amy@x.com', name: 'Amy Adams', kind: 'changed', date: '2026-10-20', start: '07:00', end: '15:30', label: 'GSV', was: { start: '08:00', end: '16:30', label: 'GSV' } },
    { email: 'amy@x.com', name: 'Amy Adams', kind: 'added', date: '2026-10-21', start: '08:00', end: '16:30', label: '', was: null },
    { email: 'bob@x.com', name: 'Bob Brown', kind: 'added', date: '2026-10-21', start: '08:00', end: '16:30', label: 'Yard', was: null },
    { email: 'bob@x.com', name: 'Bob Brown', kind: 'removed', date: '2026-10-22', start: '08:00', end: '16:30', label: 'Yard', was: { start: '08:00', end: '16:30', label: 'Yard' } },
  ],
  warnings: [
    { email: 'amy@x.com', name: 'Amy Adams', date: '2026-10-21', shiftId: 's2', text: 'Only 6 hours of rest after Tue 10/20.', kind: 'rule' },
    { email: 'bob@x.com', name: 'Bob Brown', date: '2026-10-21', shiftId: 's3', text: 'Overlaps approved time off.', kind: 'conflict' },
  ],
};
const onPublish = vi.fn();
const onJump = vi.fn();
const onClose = vi.fn();
const open = (over = {}) => render(<ShareDialog defaultStart="2026-10-19" defaultEnd="2026-10-25" lastPublishedAt="" localCount={3}
  groups={[{ id: 'g1', name: 'Front Desk' }]} busy={false} onPublish={onPublish} onJump={onJump} onClose={onClose} {...over} />);
const dlg = () => screen.getByRole('dialog', { name: 'Share Schedule' });
const review = async () => {
  fireEvent.click(within(dlg()).getByRole('button', { name: 'Review' }));
  await screen.findByText('Review And Share');
};

beforeEach(() => {
  onPublish.mockReset().mockResolvedValue({ published: 4 });
  onJump.mockReset(); onClose.mockReset();
  timeSchedUnshared.mockReset().mockResolvedValue({ count: 4 });
  timeSchedPublishReview.mockReset().mockResolvedValue(REVIEW);
  timeSchedShares.mockReset().mockResolvedValue({ shares: [] });
});

describe('changeLine and reviewSummary', () => {
  it('writes one line per change and one summary line', () => {
    expect(changeLine(REVIEW.changes[0])).toBe('Tue 10/20 · 7:00 AM - 3:30 PM · GSV (was 8:00 AM - 4:30 PM)');
    expect(changeLine(REVIEW.changes[1])).toBe('Wed 10/21 · 8:00 AM - 4:30 PM (new)');
    expect(changeLine(REVIEW.changes[3])).toBe('Thu 10/22 · 8:00 AM - 4:30 PM · Yard (removed)');
    expect(changeLine({ ...REVIEW.changes[0], was: { start: '08:00', end: '16:30', label: 'Old' } })).toBe('Tue 10/20 · 7:00 AM - 3:30 PM · GSV (was 8:00 AM - 4:30 PM · Old)');
    expect(reviewSummary(REVIEW.changes, 2)).toBe('4 changes for 2 people: 2 new, 1 changed, 1 removed');
    expect(reviewSummary([{ kind: 'added' }], 1)).toBe('1 change for 1 person: 1 new');
    expect(reviewSummary([], 0)).toBe('No changes in these dates.');
  });
});

describe('ShareDialog', () => {
  it('reviews the picked dates and group, sums up the changes per person and groups the warnings', async () => {
    open();
    const d = dlg();
    expect(await within(d).findByText('4 changes to share in these dates.')).toBeTruthy();
    expect(within(d).queryByRole('button', { name: 'Share' })).toBeNull();
    fireEvent.change(within(d).getByLabelText('Share to'), { target: { value: '2026-11-01' } });
    fireEvent.change(within(d).getByLabelText('Share group'), { target: { value: 'g1' } });
    await review();
    expect(timeSchedPublishReview).toHaveBeenCalledWith({ start: '2026-10-19', end: '2026-11-01', group_id: 'g1' });
    expect(d.querySelector('[data-review-summary]').textContent).toBe('4 changes for 2 people: 2 new, 1 changed, 1 removed');
    // The short list is open; each person, then their lines.
    const changes = d.querySelector('[data-review-changes]');
    expect(changes.textContent).toContain('Amy Adams');
    expect(changes.textContent).toContain('Tue 10/20 · 7:00 AM - 3:30 PM · GSV (was 8:00 AM - 4:30 PM)');
    expect(changes.textContent).toContain('Thu 10/22 · 8:00 AM - 4:30 PM · Yard (removed)');
    fireEvent.click(within(d).getByRole('button', { name: /Hide Changes/ }));
    expect(d.querySelector('[data-review-changes]')).toBeNull();
    fireEvent.click(within(d).getByRole('button', { name: /Show Changes/ }));
    expect(d.querySelector('[data-review-changes]')).toBeTruthy();
    // Warnings per person, told apart by a chip, each a jump.
    const warns = d.querySelector('[data-review-warnings]');
    expect(within(warns).getByText('Rule')).toBeTruthy();
    expect(within(warns).getByText('Conflict')).toBeTruthy();
    const people = [...warns.querySelectorAll(':scope > div > div:first-child')].map((x) => x.textContent);
    expect(people).toEqual(['Amy Adams', 'Bob Brown']);
    fireEvent.click(within(warns).getByText('Overlaps approved time off.'));
    expect(onJump).toHaveBeenCalledWith('bob@x.com', '2026-10-21', 's3');
  });

  it('needs a reason when the company requires one, sends it, and Back returns to step 1', async () => {
    open();
    await review();
    const d = dlg();
    const share = within(d).getByRole('button', { name: 'Share' });
    expect(share.disabled).toBe(true);
    const reason = within(d).getByLabelText('Reason for sharing with warnings');
    expect(within(d).getByText('Managers see this reason in the history of the shifts it applies to.')).toBeTruthy();
    expect(reason.getAttribute('maxlength')).toBe('300');   // the server keeps 300 (routers/timeclock, shift_log)
    expect(d.querySelector('[data-reason-count]')).toBeNull();
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(share.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: ' Short-staffed, overtime approved ' } });
    expect(share.disabled).toBe(false);
    fireEvent.click(within(d).getByRole('button', { name: 'Back' }));
    expect(within(d).getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(within(d).getByLabelText('Share from').value).toBe('2026-10-19');
    fireEvent.click(within(d).getByText('The whole team'));
    await review();
    expect(within(d).getByLabelText('Reason for sharing with warnings').value).toBe(' Short-staffed, overtime approved ');   // kept across Back
    fireEvent.click(within(d).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith({ start_date: '2026-10-19', end_date: '2026-10-25', notify: 'team', reason: 'Short-staffed, overtime approved' }));
  });

  it('says No warnings and shares at once when there are none; a reason is never asked for then', async () => {
    timeSchedPublishReview.mockResolvedValue({ ...REVIEW, warnings: [], reasonRequired: true });
    open();
    await review();
    const d = dlg();
    expect(within(d).getByText('No warnings.')).toBeTruthy();
    expect(within(d).queryByLabelText('Reason for sharing with warnings')).toBeNull();
    const share = within(d).getByRole('button', { name: 'Share' });
    expect(share.disabled).toBe(false);
    fireEvent.click(share);
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith({ start_date: '2026-10-19', end_date: '2026-10-25', notify: 'changed', reason: '' }));
  });

  it('shows the server refusal in the dialog', async () => {
    timeSchedPublishReview.mockResolvedValue({ ...REVIEW, reasonRequired: false });
    onPublish.mockResolvedValue({ error: 'A reason is needed to share a schedule with warnings.' });
    open();
    await review();
    const d = dlg();
    fireEvent.click(within(d).getByRole('button', { name: 'Share' }));
    expect(await within(d).findByRole('alert')).toBeTruthy();
    expect(within(d).getByRole('alert').textContent).toBe('A reason is needed to share a schedule with warnings.');
    expect(within(d).getByRole('button', { name: 'Share' })).toBeTruthy();   // still on step 2
  });

  it('stays on step 1 and says so when the review cannot load; Share waits for changes', async () => {
    timeSchedPublishReview.mockRejectedValue(new Error('Not now'));
    open();
    fireEvent.click(within(dlg()).getByRole('button', { name: 'Review' }));
    expect(await within(dlg()).findByRole('alert')).toBeTruthy();
    expect(within(dlg()).getByRole('alert').textContent).toBe('Not now');
    expect(within(dlg()).getByRole('button', { name: 'Review' })).toBeTruthy();
    timeSchedPublishReview.mockResolvedValue({ changes: [], people: 0, warnings: [], reasonRequired: false });
    await review();
    expect(within(dlg()).getByText('No changes in these dates.')).toBeTruthy();
    expect(within(dlg()).getByRole('button', { name: 'Share' }).disabled).toBe(true);
  });
});

describe('ShareDialog hardening (Oct 15)', () => {
  it('counts the reason from 250 characters and never sends more than 300', async () => {
    open();
    await review();
    const d = dlg();
    const reason = within(d).getByLabelText('Reason for sharing with warnings');
    fireEvent.change(reason, { target: { value: 'x'.repeat(249) } });
    expect(d.querySelector('[data-reason-count]')).toBeNull();
    fireEvent.change(reason, { target: { value: 'x'.repeat(250) } });
    expect(d.querySelector('[data-reason-count]').textContent).toBe('250/300');
    fireEvent.change(reason, { target: { value: 'y'.repeat(320) } });
    expect(d.querySelector('[data-reason-count]').textContent).toBe('300/300');
    fireEvent.click(within(d).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(onPublish).toHaveBeenCalled());
    expect(onPublish.mock.calls[0][0].reason).toBe('y'.repeat(300));
  });

  it('tags a pending request, availability or an overlap as a heads-up that never asks for a reason', async () => {
    timeSchedPublishReview.mockResolvedValue({ ...REVIEW, reasonRequired: false, warnings: [
      { email: 'bob@x.com', name: 'Bob Brown', date: '2026-10-21', shiftId: 's3', text: 'Time off requested that day (vacation).', kind: 'conflict', soft: true },
      { email: 'bob@x.com', name: 'Bob Brown', date: '2026-10-21', shiftId: 's3', text: 'On approved time off that day (sick).', kind: 'conflict', soft: false },
    ] });
    open();
    await review();
    const warns = dlg().querySelector('[data-review-warnings]');
    expect(within(warns).getByText('Heads Up')).toBeTruthy();
    expect(within(warns).getByText('Conflict')).toBeTruthy();
    expect(within(dlg()).queryByLabelText('Reason for sharing with warnings')).toBeNull();
    expect(within(dlg()).getByRole('button', { name: 'Share' }).disabled).toBe(false);
  });

  it('lists the recent shares made with warnings, with the reason in quotes', async () => {
    timeSchedShares.mockResolvedValue({ shares: [
      { publishId: 'p1', by: 'mia@x.com', byName: 'Mia Lee', at: '2026-10-14T22:12:00Z', people: 2, shifts: 5, warnings: 3, reason: 'Short-staffed', start: '2026-10-19', end: '2026-10-25' },
      { publishId: 'p2', by: 'ada@x.com', byName: 'Ada Lee', at: '2026-10-10T15:00:00Z', people: 1, shifts: 1, warnings: 1, reason: '', start: '2026-10-12', end: '2026-10-12' },
    ] });
    open();
    const box = await waitFor(() => { const el = dlg().querySelector('[data-recent-shares]'); if (!el) throw new Error('not yet'); return el; });
    expect(timeSchedShares).toHaveBeenCalledWith({ limit: 10 });
    expect(within(box).getByText('Recent Shares')).toBeTruthy();
    expect(box.textContent).toContain('Mia Lee');
    expect(box.textContent).toContain('2 people · 3 warnings');
    expect(box.textContent).toContain('"Short-staffed"');
    expect(box.textContent).toContain('1 person · 1 warning');
    await review();
    expect(dlg().querySelector('[data-recent-shares]')).toBeNull();   // step 1 only
  });

  it('shows nothing under Recent Shares when there are none or the API has no such route', async () => {
    open();
    await screen.findByText('4 changes to share in these dates.');
    await waitFor(() => expect(timeSchedShares).toHaveBeenCalled());
    expect(dlg().querySelector('[data-recent-shares]')).toBeNull();
  });

  it('hands its state back on a warning jump and comes back on Review And Share with it', async () => {
    const onMemo = vi.fn();
    const { unmount } = open({ onMemo });
    const d = dlg();
    fireEvent.change(within(d).getByLabelText('Share to'), { target: { value: '2026-11-01' } });
    fireEvent.click(within(d).getByText('The whole team'));
    await review();
    fireEvent.change(within(d).getByLabelText('Reason for sharing with warnings'), { target: { value: 'Overtime approved' } });
    fireEvent.click(within(d.querySelector('[data-review-warnings]')).getByText('Overlaps approved time off.'));
    expect(onMemo).toHaveBeenCalledWith({ from: '2026-10-19', to: '2026-11-01', notify: 'team', groupId: '', reason: 'Overtime approved', review: REVIEW });
    expect(onJump).toHaveBeenCalledWith('bob@x.com', '2026-10-21', 's3');
    unmount();
    // Reopened with the memo: straight to Review And Share, the same review, the reason kept.
    timeSchedPublishReview.mockClear();
    open({ onMemo, memo: onMemo.mock.calls[0][0] });
    expect(screen.getByText('Review And Share')).toBeTruthy();
    expect(timeSchedPublishReview).not.toHaveBeenCalled();
    expect(within(dlg()).getByLabelText('Reason for sharing with warnings').value).toBe('Overtime approved');
    fireEvent.click(within(dlg()).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith({ start_date: '2026-10-19', end_date: '2026-11-01', notify: 'team', reason: 'Overtime approved' }));
    await waitFor(() => expect(onMemo).toHaveBeenLastCalledWith(null));   // a share forgets it
    // Cancel forgets it too.
    onMemo.mockClear();
    fireEvent.click(within(dlg()).getByRole('button', { name: 'Cancel' }));
    expect(onMemo).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ShareDialog under StrictMode', () => {
  it('still reaches the review step (the mounted flag survives the double effect run)', async () => {
    // StrictMode runs every effect's cleanup once right after mount. A
    // "live" flag that was only ever cleared left Review stuck on "…" with
    // the server's answer thrown away (QA, Oct 15).
    render(<StrictMode><ShareDialog defaultStart="2026-10-19" defaultEnd="2026-10-25" lastPublishedAt="" localCount={3} groups={[]} busy={false}
      onPublish={onPublish} onJump={onJump} onClose={onClose} /></StrictMode>);
    fireEvent.click(within(dlg()).getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Review And Share')).toBeTruthy();
    expect(screen.getByText('4 changes for 2 people: 2 new, 1 changed, 1 removed')).toBeTruthy();
  });
});
