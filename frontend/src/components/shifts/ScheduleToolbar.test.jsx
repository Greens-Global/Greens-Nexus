import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Share Schedule, two steps (Shifts Phase 2, Oct 14): step 1 picks the dates,
// group and who hears, and ends in Review; step 2 sums up the changes per
// person, lists rule and conflict warnings per person (each a jump to the
// cell), needs a reason when the company requires one for a schedule with
// warnings, and shows the server's refusal in place.

const timeSchedUnshared = vi.fn();
const timeSchedPublishReview = vi.fn();
vi.mock('../../api', () => ({
  api: {
    timeSchedUnshared: (...a) => timeSchedUnshared(...a),
    timeSchedPublishReview: (...a) => timeSchedPublishReview(...a),
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
    expect(within(d).getByText('Everyone who sees the history of these shifts sees this reason.')).toBeTruthy();
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
