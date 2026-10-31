import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Shifts > Requests, Phase 3b (Oct 15): a Releases tab beside Open Shifts.
// Hidden while the company has releases off and none exist; shown by the
// switch or by a release request; the row says "wants to release" and the
// shift; Approve / Decline carry a note like the other kinds.
// Oct 30 2026 (Neil): Swaps, Offers and Open Shifts follow their switches
// too, no tab strip when only Time Off is left; Decline asks for a note,
// Approve keeps one behind Add Note.

const shiftRequestDecide = vi.fn();
const timeOffDecide = vi.fn();
const prompt = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true), prompt: (...a) => prompt(...a) } }));
vi.mock('../api', () => ({
  api: {
    shiftRequestDecide: (...a) => shiftRequestDecide(...a),
    timeOffDecide: (...a) => timeOffDecide(...a),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'amy@x.com', name: 'Amy Adams' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const Inbox = (await import('./ShiftRequestsInbox')).default;

const amy = { email: 'amy@x.com', name: 'Amy Adams' };
const release = { id: 'r9', kind: 'release', status: 'pending_manager', summary: 'Amy Adams wants to release 10/20/2026 9:00 AM - 5:00 PM',
  requester: amy, target: null, note: 'Family visit', createdAt: '2026-10-15T10:00:00', shift: { id: 's9', date: '2026-10-20', start: '09:00', end: '17:00', code: 'GST', color: '#2563eb' }, targetShift: null };
const toastOk = vi.fn();
const toastErr = vi.fn();
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent.replace(/\d+$/, '').trim());
const page = (inbox) => render(<Inbox inbox={inbox} timeoff={[]} loading={false} error={null} onRetry={vi.fn()} onChanged={vi.fn()} toastOk={toastOk} toastErr={toastErr} />);

beforeEach(() => { shiftRequestDecide.mockReset().mockResolvedValue({}); prompt.mockReset(); toastOk.mockReset(); toastErr.mockReset(); });

describe('Shifts > Requests - Releases tab', () => {
  it('hides the tab while releases are off and none exist', () => {
    page({ pending: [], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: false, swaps: true, offers: true, openShifts: true } });
    expect(tabNames()).toEqual(['Time Off', 'Swaps', 'Offers', 'Open Shifts']);
  });

  it('shows the tab when the company turned releases on', () => {
    page({ pending: [], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: true, swaps: true, offers: true, openShifts: true } });
    expect(tabNames()).toEqual(['Time Off', 'Swaps', 'Offers', 'Open Shifts', 'Releases']);
  });

  it('hides Swaps, Offers and Open Shifts with their switches, and the strip when only Time Off is left', () => {
    const { unmount } = page({ pending: [], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: false, swaps: false, offers: true, openShifts: false } });
    expect(tabNames()).toEqual(['Time Off', 'Offers']);
    unmount();
    page({ pending: [], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: false, swaps: false, offers: false, openShifts: false } });
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows the tab for a release request even after the switch went off, counts it, and decides it with a note', async () => {
    page({ pending: [release], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: false } });
    const tab = screen.getByRole('tab', { name: /Releases/ });
    expect(tab.textContent).toContain('1');
    fireEvent.click(tab);
    expect(screen.getByText('Amy Adams wants to release Tue 10/20/2026 · 9:00 AM - 5:00 PM.')).toBeTruthy();
    expect(screen.getByText(/Release/, { selector: 'div' })).toBeTruthy();
    expect(screen.queryByLabelText('Note to the team')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Note' }));
    fireEvent.change(screen.getByLabelText('Note to the team'), { target: { value: 'Covered by Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(shiftRequestDecide).toHaveBeenCalledWith('r9', { approve: true, note: 'Covered by Bob' }));
    expect(toastOk).toHaveBeenCalledWith('Approved. The shift is in the open pool and they were told.');
  });

  it('declines a release only with a note, asked for at Decline', async () => {
    page({ pending: [release], waitingOnPeer: [], recent: [], photos: {}, settings: { releaseShifts: true } });
    fireEvent.click(screen.getByRole('tab', { name: /Releases/ }));
    prompt.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt.mock.calls[0][1]).toMatchObject({ title: 'Decline Release', required: true });
    expect(shiftRequestDecide).not.toHaveBeenCalled();
    prompt.mockResolvedValueOnce('Nobody free');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(shiftRequestDecide).toHaveBeenCalledWith('r9', { approve: false, note: 'Nobody free' }));
    expect(toastOk).toHaveBeenCalledWith('Declined. Everyone involved was told.');
  });
});
