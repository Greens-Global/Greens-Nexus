import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The one request dialog, Shifts Phase 3b (Oct 15): a Release kind that
// shows only when the company turned releases on, sends {kind: 'release',
// shift_id, note}, says "A manager approves it." or "It goes to the open
// pool right away." as the company set it, and an open-shift list that
// names the team with an "Other Team" chip when claiming crosses teams.

const shiftRequestCreate = vi.fn();
vi.mock('../../api', () => ({ api: { shiftRequestCreate: (...a) => shiftRequestCreate(...a) } }));

const Dialog = (await import('./ShiftRequestDialog')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const mine = { id: 'mine1', email: 'me@x.com', date: day(3), start: '09:00', end: '17:00', label: 'Front Desk' };
const theirs = { id: 'bob1', email: 'bob@x.com', date: day(4), start: '12:00', end: '20:00' };
const reqs = (settings = {}, over = {}) => ({
  mine: [], incoming: [], openShifts: [], teammates: [{ email: 'bob@x.com', name: 'Bob Brown' }], swapShifts: { 'bob@x.com': [theirs] },
  settings: { openShifts: true, swaps: true, offers: true, ...settings }, ...over,
});
const onDone = vi.fn();
const onClose = vi.fn();
const open = (settings, over) => render(<Dialog reqs={reqs(settings, over)} myShifts={[mine]} onClose={onClose} onDone={onDone} />);
const kindNames = () => within(screen.getByRole('group', { name: 'Request type' })).getAllByRole('button').map((b) => b.textContent.trim());

beforeEach(() => { shiftRequestCreate.mockReset().mockResolvedValue({}); onDone.mockReset(); onClose.mockReset(); });

describe('ShiftRequestDialog - Release (Phase 3b)', () => {
  it('offers Release only when the company turned it on', () => {
    open();
    expect(kindNames()).toEqual(['Swap', 'Offer', 'Open Shift']);
  });

  it('releases one of my shifts with a note, and says a manager approves it', async () => {
    open({ releaseShifts: true });
    expect(kindNames()).toEqual(['Swap', 'Offer', 'Open Shift', 'Release']);
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(screen.getByText(/Put one of your shifts in the open pool for a teammate to pick up\. A manager approves it\./)).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Release Shift' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your shift'), { target: { value: 'mine1' } });
    fireEvent.change(screen.getByPlaceholderText(/Why, or anything a teammate should know/), { target: { value: 'Out of town' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith({ kind: 'release', shift_id: 'mine1', note: 'Out of town' }));
    expect(onDone).toHaveBeenCalledWith('Release requested. A manager will approve it.');
  });

  it('says it goes to the pool right away when no approval is needed', async () => {
    shiftRequestCreate.mockResolvedValue({ status: 'approved' });
    open({ releaseShifts: true, releaseNeedsApproval: false });
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(screen.getByText(/It goes to the open pool right away\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your shift'), { target: { value: 'mine1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Release Shift' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Shift released to the open pool.'));
  });

  it('needs a shared shift coming up, and opens on Release when the other kinds are off', () => {
    render(<Dialog reqs={reqs({ releaseShifts: true, swaps: false, offers: false, openShifts: false })} myShifts={[]} onClose={onClose} onDone={onDone} />);
    expect(screen.getByRole('button', { name: 'Release' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('note').textContent).toMatch(/A release needs a shift your manager has shared/);
  });

  it('names the team on an open shift and marks another team', () => {
    open({}, { openShifts: [
      { id: 'o1', date: day(2), start: '08:00', end: '16:00', openSlots: 1, team: 'Front Desk', crossTeam: false },
      { id: 'o2', date: day(5), start: '08:00', end: '16:00', openSlots: 2, team: 'Yard', crossTeam: true },
    ] });
    fireEvent.click(screen.getByRole('button', { name: 'Open Shift' }));
    expect(screen.getByText(/1 spot · Front Desk/)).toBeTruthy();
    expect(screen.getByText(/2 spots · Yard/)).toBeTruthy();
    const chips = document.querySelectorAll('[data-cross-team]');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('Other Team');
  });
});
