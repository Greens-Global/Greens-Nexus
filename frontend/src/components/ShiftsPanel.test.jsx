import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Presets & Groups (Sep 29 audit): deleting a preset or a group is permanent,
// so it is confirmed first; and the group controls show only to people whose
// changes the API accepts (company-wide access).

const timeShifts = vi.fn();
const timeShiftGroups = vi.fn();
const timeShiftDelete = vi.fn();
const timeShiftGroupDelete = vi.fn();
const confirmAsk = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a) } }));
vi.mock('../teamsGraph', () => ({ graphTokenSilent: vi.fn(), graphTokenInteractive: vi.fn(), listMyChats: vi.fn() }));
vi.mock('../api', () => ({
  api: {
    timeShifts: (...a) => timeShifts(...a),
    timeShiftGroups: (...a) => timeShiftGroups(...a),
    timeShiftAssignments: vi.fn().mockResolvedValue({ assignments: {} }),
    timeShiftDelete: (...a) => timeShiftDelete(...a),
    timeShiftGroupDelete: (...a) => timeShiftGroupDelete(...a),
    timeShiftCreate: vi.fn(), timeShiftUpdate: vi.fn(), timeShiftGroupCreate: vi.fn(), timeShiftGroupSet: vi.fn(),
    timeShiftAssign: vi.fn(), timeMyChats: vi.fn(),
  },
}));

const ShiftsPanel = (await import('./ShiftsPanel')).default;
// A zone the picker really offers (the engine renames some, e.g. Kolkata / Calcutta).
const { ZONE_GROUPS } = await import('../lib/worldClockZones');
const ASIA = ZONE_GROUPS.Asia[0];

const preset = { id: 'p1', name: 'Store', code: 'GST', start: '09:00', end: '17:00', days: '1,2,3,4,5', graceMin: 10,
  breakMin: 0, color: '#2563eb', timezone: 'America/Los_Angeles', placed: 3, assigned: 1 };
const group = { id: 'g1', name: 'Front Desk', members: ['a@x.com', 'b@x.com'], schedulers: [], chatId: 'c1', chatName: 'Front Desk Chat' };
const toastOk = vi.fn();

beforeEach(() => {
  timeShifts.mockReset().mockResolvedValue({ shifts: [preset], defaultTimezone: ASIA });
  timeShiftGroups.mockReset().mockResolvedValue({ groups: [group], canManageGroups: true });
  timeShiftDelete.mockReset().mockResolvedValue({ ok: true });
  timeShiftGroupDelete.mockReset().mockResolvedValue({ ok: true });
  confirmAsk.mockReset().mockResolvedValue(true);
  toastOk.mockReset();
});

describe('Presets & Groups', () => {
  it('asks before deleting a preset, and says what hangs off it', async () => {
    confirmAsk.mockResolvedValue(false);
    render(<ShiftsPanel toastOk={toastOk} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('Delete preset Store'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
    const [message, opts] = confirmAsk.mock.calls[0];
    expect(message).toContain('Delete the preset "Store"?');
    expect(message).toContain('3 shifts already on the schedule stay');
    expect(message).toContain('1 person loses it as their usual hours');
    expect(opts).toMatchObject({ title: 'Delete Preset', danger: true });
    expect(timeShiftDelete).not.toHaveBeenCalled();   // declined: nothing is deleted

    confirmAsk.mockResolvedValue(true);
    fireEvent.click(screen.getByLabelText('Delete preset Store'));
    await waitFor(() => expect(timeShiftDelete).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Preset deleted.'));
  });

  it('asks before deleting a group', async () => {
    render(<ShiftsPanel toastOk={toastOk} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('Delete group Front Desk'));
    await waitFor(() => expect(timeShiftGroupDelete).toHaveBeenCalledWith('g1'));
    const [message, opts] = confirmAsk.mock.calls[0];
    expect(message).toContain('Its 2 members keep their shifts');
    expect(message).toContain('Teams chat');
    expect(opts).toMatchObject({ title: 'Delete Group', danger: true });
  });

  it('offers no group changes to a manager without company-wide access', async () => {
    timeShiftGroups.mockResolvedValue({ groups: [group], canManageGroups: false });
    render(<ShiftsPanel toastOk={toastOk} toastErr={vi.fn()} />);
    expect(await screen.findByText('Front Desk')).toBeTruthy();
    expect(screen.queryByText('New Group')).toBeNull();
    expect(screen.queryByLabelText('Delete group Front Desk')).toBeNull();
    expect(screen.getByText('Groups are changed by an administrator')).toBeTruthy();
    expect(screen.getByText('New Shift')).toBeTruthy();   // presets are still theirs to manage
  });

  it('starts a new preset on the team time zone', async () => {
    render(<ShiftsPanel toastOk={toastOk} toastErr={vi.fn()} />);
    await screen.findByLabelText('Delete preset Store');
    fireEvent.click(screen.getByText('New Shift'));
    expect(screen.getByText('Color')).toBeTruthy();
    const zone = screen.getByText("Time zone this team's shift runs on").querySelector('select');
    expect(zone.value).toBe(ASIA);
  });
});
