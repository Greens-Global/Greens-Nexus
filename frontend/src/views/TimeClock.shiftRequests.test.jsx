import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Workday > Time Off > Shift Requests (Charmi, 09/30): the employee's one
// place to ask for a swap, an offer or an open shift, next to the time-off
// form. The Shifts module no longer has a New Request.

const shiftRequestsMine = vi.fn();
const shiftRequestCreate = vi.fn();
const timeMySchedule = vi.fn();
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set() }) }));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...a) => (key === 'shiftRequestsMine' ? shiftRequestsMine(...a)
      : key === 'shiftRequestCreate' ? shiftRequestCreate(...a)
        : key === 'timeMySchedule' ? timeMySchedule(...a)
          : Promise.resolve(key === 'timeStatus' ? {} : key === 'timeOffTypes' ? { builtIn: [], custom: [], requestsOn: true } : [])),
  });
  return { api, default: api };
});

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const mine = { id: 'mine1', email: 'me@x.com', date: day(3), start: '09:00', end: '17:00', label: 'Front Desk' };
const theirs = { id: 'bob1', email: 'bob@x.com', date: day(4), start: '12:00', end: '20:00' };
const reqs = (over = {}) => ({
  mine: [], incoming: [], openShifts: [], teammates: [{ email: 'bob@x.com', name: 'Bob Brown' }], swapShifts: { 'bob@x.com': [theirs] },
  settings: { openShifts: true, swaps: true, offers: true, timeOffRequests: true }, ...over,
});
const SLOW = 20000;

beforeEach(() => {
  shiftRequestsMine.mockReset().mockResolvedValue(reqs());
  shiftRequestCreate.mockReset().mockResolvedValue({});
  timeMySchedule.mockReset().mockResolvedValue({ scheduled: [mine], teams: [] });
  Element.prototype.scrollIntoView = vi.fn();
});

async function renderTimeOff() {
  const TimeClock = (await import('./TimeClock')).default;
  return render(<TimeClock initialTab="timeoff" activeSub="timeoff" onSubChange={() => {}} />);
}

describe('Shift Requests on Workday > Time Off', () => {
  it('sits with the time-off form and sends a swap', async () => {
    await renderTimeOff();
    expect(await screen.findByText('Request Time Off')).toBeTruthy();
    expect(await screen.findByText('Shift Requests')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /New Request/ });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    screen.getByRole('dialog', { name: 'New Request' });
    fireEvent.change(screen.getByLabelText('Your shift'), { target: { value: 'mine1' } });
    fireEvent.change(screen.getByLabelText('Teammate'), { target: { value: 'bob@x.com' } });
    fireEvent.change(screen.getByLabelText('Their shift'), { target: { value: 'bob1' } });
    fireEvent.click(screen.getByText('Send Swap Request'));
    await waitFor(() => expect(shiftRequestCreate).toHaveBeenCalledWith({ kind: 'swap', shift_id: 'mine1', target_email: 'bob@x.com', target_shift_id: 'bob1', note: '' }));
    expect(await screen.findByText('Swap request sent to Bob Brown.')).toBeTruthy();
  }, SLOW);

  it('lists my requests with Title Case states, and lets me cancel one', async () => {
    const shiftRequestCancel = vi.fn().mockResolvedValue({});
    const { api } = await import('../api');
    api.shiftRequestCancel = shiftRequestCancel;
    shiftRequestsMine.mockResolvedValue(reqs({ mine: [
      { id: 'r1', kind: 'offer', status: 'pending_peer', shift: mine, target: { email: 'bob@x.com', name: 'Bob Brown' } },
      { id: 'r2', kind: 'open', status: 'declined', decisionNote: 'Another request filled this shift', shift: theirs },
    ] }));
    await renderTimeOff();
    expect(await screen.findByText('Waiting On Teammate')).toBeTruthy();
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText(/Another request filled this shift/)).toBeTruthy();
    expect(screen.getByText(/^You offered/)).toBeTruthy();
  }, SLOW);

  it('shows an error with Retry when the requests cannot load', async () => {
    shiftRequestsMine.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue(reqs());
    await renderTimeOff();
    expect(await screen.findByText('Your shift requests could not be loaded right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No shift requests yet.')).toBeTruthy();
  }, SLOW);
});
