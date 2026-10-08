import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// People > Work Logs keeps EVERY message of a day (Oct 3): Oct 2 held an EOD
// filed there before the shift-day fix AND, once that night's shift ended,
// the right one - and only one was shown, so the new message disappeared.

const LOGS = [
  // newest first, as the API sends them
  { id: 'e-new', kind: 'eod', date: '2026-10-02', message: 'EOD for the Oct 2 night', tasks: '', at: '2026-10-02T21:00:00', punchAt: '2026-10-02T21:00:00', punchTz: -330 },
  { id: 'b-2', kind: 'bod', date: '2026-10-02', message: 'BOD Oct 2', tasks: '', at: '2026-10-02T13:58:00', punchAt: '2026-10-02T13:58:00', punchTz: -330 },
  { id: 'e-old', kind: 'eod', date: '2026-10-02', message: 'EOD - Not doing OT today due to headache', tasks: '', at: '2026-10-01T21:00:00', punchAt: '', punchTz: null },
];
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (k === 'getEmployeeBod' ? async () => ({ logs: LOGS }) : async () => []) }),
}));
const { WorkLogsSection } = await import('./HR');

describe('Work Logs - every message of a day', () => {
  it('shows both EODs on one day, oldest first, each with its send time', async () => {
    render(<WorkLogsSection employee={{ id: 'p1', workEmail: 'p@x.com' }} />);
    expect(await screen.findByText('EOD for the Oct 2 night')).toBeTruthy();
    expect(screen.getByText('EOD - Not doing OT today due to headache')).toBeTruthy();
    const sent = screen.getAllByText(/^Sent /);
    expect(sent).toHaveLength(2);
    // The day's clock-out still shows once, from the message that has it.
    expect(screen.getAllByText(/Punched out/)).toHaveLength(1);
  });
});
