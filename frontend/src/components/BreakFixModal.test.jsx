import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Fixing a break that never ended (Sep 29): a manager adds the break end
// straight on the card; an employee still sends a request to their approver.

const timeAddPunch = vi.fn();
const timePunchRequestCreate = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeAddPunch: (...a) => timeAddPunch(...a),
    timePunchRequestCreate: (...a) => timePunchRequestCreate(...a),
  },
}));

const { BreakFixModal } = await import('./PayrollTimecard');

const day = { date: '2026-08-05', breaks: [{ start: '2026-08-05T09:00:00', end: '2026-08-05T19:25:00', min: 625, implicit: true }] };

beforeEach(() => {
  timeAddPunch.mockReset().mockResolvedValue({});
  timePunchRequestCreate.mockReset().mockResolvedValue({});
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
    expect(toastOk).toHaveBeenCalledWith('Break end added - the timecard is updated.');
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
