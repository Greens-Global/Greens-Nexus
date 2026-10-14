import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Add Time (Neil, Oct 14 2026): the day picker says what each day holds and
// pre-picks the days that need a punch; Preview is the server's dry run and
// Add writes exactly that; Undo takes the batch back.

const apiMock = vi.hoisted(() => ({ timeAddTimeDays: vi.fn(), timeAddTime: vi.fn(), timeAddTimeUndo: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import AddTimeModal from './AddTimeModal';
import { dayNote, planText, hm } from '../lib/addTime';

const DAYS = [
  { date: '2026-10-05', state: 'needs_out', workedMin: 0, openIn: '2026-10-05T15:30:00', locked: '', shift: null, usual: { start: '08:30', end: '17:30', breakMin: 30 }, timeOff: '', holiday: '' },
  { date: '2026-10-06', state: 'has_time', workedMin: 480, locked: '', shift: null, usual: { start: '08:30', end: '17:30', breakMin: 30 }, timeOff: '', holiday: '' },
  { date: '2026-10-07', state: 'empty', workedMin: 0, locked: '', shift: null, usual: null, timeOff: 'vacation', holiday: '' },
  { date: '2026-10-08', state: 'empty', workedMin: 0, locked: '', shift: { start: '07:00', end: '15:00', breakMin: 0, label: 'Early' }, usual: null, timeOff: '', holiday: 'Founders Day' },
  { date: '2026-10-09', state: 'empty', workedMin: 0, locked: 'This pay period is finalized and locked.', shift: null, usual: null, timeOff: '', holiday: '' },
  { date: '2026-10-10', state: 'empty', workedMin: 0, locked: '', shift: null, usual: null, timeOff: '', holiday: '' },
];
const PLAN = (dry) => ({
  dryRun: dry, batchId: dry ? '' : 'b-1', added: 2, totalMin: 1020,
  days: [
    { date: '2026-10-05', action: 'fill_out', minutes: 540, inAt: '2026-10-05T15:30:00', outAt: '2026-10-06T00:30:00', breakMin: 0, reason: '' },
    { date: '2026-10-06', action: 'skip', minutes: 0, inAt: '', outAt: '', breakMin: 0, reason: 'Already has 8h 00m - add anyway to put a second shift on this day.' },
    { date: '2026-10-10', action: 'add', minutes: 480, inAt: '2026-10-10T15:30:00', outAt: '2026-10-11T00:30:00', breakMin: 60, reason: '' },
  ],
});

beforeEach(() => {
  apiMock.timeAddTimeDays.mockReset().mockResolvedValue({ email: 'dean@greensglobal.com', name: 'Dean Test', days: DAYS, timezone: '' });
  apiMock.timeAddTime.mockReset().mockImplementation((body) => Promise.resolve(PLAN(body.dry_run)));
  apiMock.timeAddTimeUndo.mockReset().mockResolvedValue({ voided: 5 });
});

const open = (props = {}) => render(
  <AddTimeModal email="dean@greensglobal.com" start="2026-10-05" end="2026-10-10" onClose={vi.fn()} onDone={vi.fn()} toastOk={vi.fn()} toastErr={vi.fn()} {...props} />,
);
const chip = (ds) => document.querySelector(`[data-day="${ds}"]`);

describe('dayNote and planText', () => {
  it('say what a day holds, in Title Case, and what a plan row does', () => {
    expect(dayNote(DAYS[0]).text).toBe('Needs Out');
    expect(dayNote(DAYS[1]).text).toBe('8h 00m');
    expect(dayNote(DAYS[2]).text).toBe('Off - Vacation');
    expect(dayNote(DAYS[3]).text).toBe('Holiday');              // the holiday word beats the shift hours - the warning matters more
    expect(dayNote({ ...DAYS[3], holiday: '' }).text).toBe('7:00a - 3:00p');
    expect(dayNote(DAYS[4]).text).toBe('Locked');
    expect(dayNote(DAYS[5]).text).toBe('No Time');
    expect(dayNote({ state: 'live' }).text).toBe('On the Clock');
    expect(planText({ action: 'add', minutes: 510, breakMin: 30 })).toBe('Add 8h 30m (30m break)');
    expect(planText({ action: 'fill_out', minutes: 540 })).toMatch(/^Clock-out only/);
    expect(planText({ action: 'skip', reason: 'nope' })).toBe('Skipped - nope');
    expect(hm(65)).toBe('1h 05m');
  });
});

describe('AddTimeModal', () => {
  it('reads the days, pre-picks the ones needing a punch, prefills the usual hours, locks the locked', async () => {
    open();
    expect(await screen.findByText('Add Time for Dean Test')).toBeTruthy();
    expect(apiMock.timeAddTimeDays).toHaveBeenCalledWith('dean@greensglobal.com', '2026-10-05', '2026-10-10');
    await waitFor(() => expect(chip('2026-10-05')).toBeTruthy());
    expect(chip('2026-10-05').getAttribute('aria-pressed')).toBe('true');
    expect(chip('2026-10-06').getAttribute('aria-pressed')).toBe('false');
    expect(chip('2026-10-09').disabled).toBe(true);
    expect(within(chip('2026-10-07')).getByText('Off - Vacation')).toBeTruthy();
    expect(screen.getByDisplayValue('08:30')).toBeTruthy();
    expect(screen.getByDisplayValue('17:30')).toBeTruthy();
    expect(screen.getByText('Days - 1 picked')).toBeTruthy();
  });

  it('starts from the handed-in dates instead', async () => {
    open({ initialDates: ['2026-10-10'] });
    await waitFor(() => expect(chip('2026-10-10')).toBeTruthy());
    expect(chip('2026-10-10').getAttribute('aria-pressed')).toBe('true');
    expect(chip('2026-10-05').getAttribute('aria-pressed')).toBe('false');
  });

  it('previews as a dry run, then adds exactly that, then undoes the batch', async () => {
    const onDone = vi.fn(); const onClose = vi.fn();
    open({ onDone, onClose });
    await waitFor(() => expect(chip('2026-10-10')).toBeTruthy());
    fireEvent.click(chip('2026-10-10'));
    fireEvent.click(chip('2026-10-06'));
    expect(screen.getByText('Days - 3 picked')).toBeTruthy();
    // the day that already has time offers "add anyway"
    const anyway = screen.getByLabelText(/already has 8h 00m - add a second shift anyway/);
    fireEvent.click(anyway);
    fireEvent.change(screen.getByRole('combobox', { name: 'Unpaid Break' }), { target: { value: '60' } });

    // no reason, no preview
    fireEvent.click(screen.getByRole('button', { name: 'Preview 3 Days' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Say why/);
    expect(apiMock.timeAddTime).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Why this time is being added/), { target: { value: 'No signal at the site all week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview 3 Days' }));
    await screen.findByText(/What will be written - 17h 00m over 2 days/);
    const dry = apiMock.timeAddTime.mock.calls[0][0];
    expect(dry.dry_run).toBe(true);
    expect(dry.employee_email).toBe('dean@greensglobal.com');
    expect(dry.reason).toBe('No signal at the site all week');
    expect(dry.days.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-10']);
    expect(dry.days.map((d) => d.force)).toEqual([false, true, false]);
    expect(dry.days.every((d) => d.break_min === 60 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(d.in_at) && /T/.test(d.out_at) && typeof d.tz_offset_min === 'number')).toBe(true);
    expect(document.querySelectorAll('[data-plan-row="skip"]')).toHaveLength(1);
    expect(screen.getByText(/Skipped - Already has 8h 00m/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Add 2 Days - 17h 00m/ }));
    await screen.findByText('Added 17h 00m over 2 days.');
    expect(apiMock.timeAddTime.mock.calls[1][0].dry_run).toBe(false);
    expect(onDone).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(apiMock.timeAddTimeUndo).toHaveBeenCalledWith('b-1'));
    expect(onClose).toHaveBeenCalled();
  });

  it('any change after a preview asks for a fresh one', async () => {
    open();
    await waitFor(() => expect(chip('2026-10-05')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Why this time/), { target: { value: 'Forgot to clock out' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview 1 Day' }));
    await screen.findByText(/What will be written/);
    fireEvent.click(chip('2026-10-10'));
    expect(screen.queryByText(/What will be written/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview 2 Days' })).toBeTruthy();
  });

  it('per-day hours send each day its own times', async () => {
    open({ initialDates: ['2026-10-08', '2026-10-10'] });
    await waitFor(() => expect(chip('2026-10-08')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Different hours per day'));
    fireEvent.click(screen.getByRole('button', { name: /Shift 7:00a - 3:00p/ }));
    fireEvent.change(screen.getByLabelText('Clock in on 10/10/2026'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('Clock out on 10/10/2026'), { target: { value: '14:00' } });
    fireEvent.change(screen.getByPlaceholderText(/Why this time/), { target: { value: 'Site had no signal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview 2 Days' }));
    await waitFor(() => expect(apiMock.timeAddTime).toHaveBeenCalled());
    const days = apiMock.timeAddTime.mock.calls[0][0].days;
    expect(days[0].in_at.slice(11, 16) !== days[1].in_at.slice(11, 16)).toBe(true);
  });
});
