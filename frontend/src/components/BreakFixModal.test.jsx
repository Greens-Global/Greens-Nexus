import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Fixing a break that never ended (Sep 29): a manager adds the break end
// straight on the card; an employee still sends a request to their approver.

const timeAddPunch = vi.fn();
const timePunchRequestCreate = vi.fn();
const timeAdjustPunch = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeAddPunch: (...a) => timeAddPunch(...a),
    timePunchRequestCreate: (...a) => timePunchRequestCreate(...a),
    timeAdjustPunch: (...a) => timeAdjustPunch(...a),
  },
}));

const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), prompt: vi.fn() } }));

const { BreakFixModal } = await import('./PayrollTimecard');

const day = { date: '2026-08-05', breaks: [{ start: '2026-08-05T09:00:00', end: '2026-08-05T19:25:00', min: 625, implicit: true }] };

beforeEach(() => {
  timeAddPunch.mockReset().mockResolvedValue({});
  timePunchRequestCreate.mockReset().mockResolvedValue({});
  timeAdjustPunch.mockReset().mockResolvedValue({});
  confirm.mockReset().mockResolvedValue(true);
});

// Delete a break (Charmi, Oct 15 2026).
const twoBreaks = { date: '2026-08-05', breaks: [
  { start: '2026-08-05T09:00:00', end: '2026-08-05T09:30:00', min: 30, implicit: false, startId: 'bs1', endId: 'be1' },
  { start: '2026-08-05T13:00:00', end: '2026-08-05T19:25:00', min: 385, implicit: true, startId: 'bs2', endId: '' },
] };
function openWith(d, self) {
  const onDone = vi.fn(), toastOk = vi.fn();
  render(<BreakFixModal day={d} email="aarav@x.com" self={self} busy={false} setBusy={() => {}}
    onDone={onDone} onClose={() => {}} toastOk={toastOk} toastErr={() => {}} />);
  return { onDone, toastOk };
}

describe('BreakFixModal - delete a break', () => {
  it('lets a manager delete a break: both of its punches are voided, with the reason', async () => {
    const { onDone } = openWith(twoBreaks, false);
    fireEvent.change(screen.getByLabelText('What needs fixing'), { target: { value: 'delete' } });
    expect(screen.getByRole('dialog', { name: 'Delete a break' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Which break/), { target: { value: '0' } });
    fireEvent.change(screen.getByPlaceholderText(/Why - e.g. confirmed/), { target: { value: 'Punched by mistake' } });
    fireEvent.click(screen.getByText('Delete Break'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(timeAdjustPunch.mock.calls).toEqual([
      ['be1', { void: true, adjust_note: 'Punched by mistake' }],
      ['bs1', { void: true, adjust_note: 'Punched by mistake' }],
    ]);
    expect(timeAddPunch).not.toHaveBeenCalled();
    // A manager's delete asks first and says how to put the break back (Oct 19).
    expect(confirm.mock.calls[0][0]).toMatch(/Add Punch with Type Break/);
  });

  it('keeps the break when the manager says Keep It', async () => {
    confirm.mockResolvedValue(false);
    const { onDone } = openWith(twoBreaks, false);
    fireEvent.change(screen.getByLabelText('What needs fixing'), { target: { value: 'delete' } });
    fireEvent.change(screen.getByPlaceholderText(/Why - e.g. confirmed/), { target: { value: 'Not a real break' } });
    fireEvent.click(screen.getByText('Delete Break'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(timeAdjustPunch).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('opens on the break that never ended, which has only a start punch to remove', async () => {
    openWith(twoBreaks, false);
    fireEvent.change(screen.getByLabelText('What needs fixing'), { target: { value: 'delete' } });
    fireEvent.change(screen.getByPlaceholderText(/Why - e.g. confirmed/), { target: { value: 'Not a real break' } });
    fireEvent.click(screen.getByText('Delete Break'));
    await waitFor(() => expect(timeAdjustPunch).toHaveBeenCalledTimes(1));
    expect(timeAdjustPunch).toHaveBeenCalledWith('bs2', { void: true, adjust_note: 'Not a real break' });
  });

  it('an employee asks their approver to remove it instead', async () => {
    openWith(twoBreaks, true);
    fireEvent.change(screen.getByLabelText('What needs fixing'), { target: { value: 'delete' } });
    fireEvent.change(screen.getByLabelText(/Which break/), { target: { value: '0' } });
    fireEvent.change(screen.getByPlaceholderText(/Why it's missing/), { target: { value: 'I never took this break' } });
    fireEvent.click(screen.getByText('Send Request'));
    await waitFor(() => expect(timePunchRequestCreate).toHaveBeenCalledTimes(2));
    expect(timePunchRequestCreate).toHaveBeenCalledWith({ action: 'remove', target_punch_id: 'be1', reason: 'I never took this break' });
    expect(timePunchRequestCreate).toHaveBeenCalledWith({ action: 'remove', target_punch_id: 'bs1', reason: 'I never took this break' });
    expect(timeAdjustPunch).not.toHaveBeenCalled();
  });

  it('offers no delete when the server named no punches for the breaks', () => {
    openWith(day, false);
    expect([...screen.getByLabelText('What needs fixing').options].map((o) => o.value)).not.toContain('delete');
  });
});

function open(self) {
  const onDone = vi.fn(), toastOk = vi.fn();
  render(<BreakFixModal day={day} email="aarav@x.com" self={self} busy={false} setBusy={() => {}}
    onDone={onDone} onClose={() => {}} toastOk={toastOk} toastErr={() => {}} />);
  return { onDone, toastOk };
}

describe('BreakFixModal', () => {
  it('lets a manager add the missing break end directly', async () => {
    const { onDone, toastOk } = open(false);
    expect(screen.getByRole('dialog', { name: 'Fix a break punch' })).toBeTruthy();
    expect(screen.getByText(/The break started at .* and was never ended/)).toBeTruthy();
    // It opens on the break's start - the end has to be later, so pick the time they came back.
    fireEvent.change(document.querySelector('input[type="datetime-local"]'), { target: { value: '2026-08-05T23:30' } });
    fireEvent.change(screen.getByPlaceholderText(/Why - e.g. confirmed/), { target: { value: 'Back at 1 PM per Aarav' } });
    fireEvent.click(screen.getByText('Save Break'));
    await waitFor(() => expect(timeAddPunch).toHaveBeenCalledWith(expect.objectContaining({
      employee_email: 'aarav@x.com', kind: 'break_end', note: 'Back at 1 PM per Aarav' })));
    expect(timePunchRequestCreate).not.toHaveBeenCalled();
    expect(toastOk).toHaveBeenCalledWith('Break end added - the time sheet is updated.');
    expect(onDone).toHaveBeenCalled();
  });

  it('still sends a request when it is the employee', async () => {
    open(true);
    expect(screen.getByRole('dialog', { name: 'Request a missing break punch' })).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="datetime-local"]'), { target: { value: '2026-08-05T23:30' } });
    fireEvent.change(screen.getByPlaceholderText(/Why it's missing/), { target: { value: 'Phone died' } });
    fireEvent.click(screen.getByText('Send Request'));
    await waitFor(() => expect(timePunchRequestCreate).toHaveBeenCalledWith(expect.objectContaining({ action: 'add', punch_kind: 'break_end' })));
    expect(timeAddPunch).not.toHaveBeenCalled();
  });
});

describe('BreakFixModal - forgot to punch back in (Oct 19)', () => {
  const lunch = { date: '2026-08-05', breaks: [{ start: '2026-08-05T19:00:00', end: '2026-08-06T01:00:00', min: 360, implicit: true }] };
  it('opens 30 minutes after the break started and offers one-tap times and reasons', async () => {
    render(<BreakFixModal day={lunch} email="aarav@x.com" self busy={false} setBusy={() => {}}
      onDone={() => {}} onClose={() => {}} toastOk={() => {}} toastErr={() => {}} />);
    const input = document.querySelector('input[type="datetime-local"]');
    const first = input.value;
    fireEvent.click(screen.getByText('Back After 1 Hour'));
    // 30 minutes after the break started, then the 1 hour pick is 30 minutes later still.
    expect((new Date(input.value) - new Date(first)) / 60000).toBe(30);
    fireEvent.click(screen.getByText('Back After 30 Min'));
    expect(input.value).toBe(first);
    fireEvent.click(screen.getByText('Back After 1 Hour'));
    fireEvent.click(screen.getByText('A customer came in'));
    fireEvent.click(screen.getByText('Send Request'));
    await waitFor(() => expect(timePunchRequestCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add', punch_kind: 'break_end', reason: 'A customer came in' })));
  });
});
