import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Global Settings > Shifts (Oct 2026; was Shifts > Presets &
// Teams and the settings block under the manager inbox): deleting a shift
// type or a group is permanent, so it is confirmed first; the group controls
// show only to people whose changes the API accepts; a new shift type starts
// on the team time zone; the switches, zone and week start save at once.

const timeShifts = vi.fn();
const timeShiftGroups = vi.fn();
const timeShiftDelete = vi.fn();
const timeShiftGroupDelete = vi.fn();
const timeShiftGroupOrder = vi.fn();
const shiftRequestSettingsGet = vi.fn();
const shiftRequestSettingsSave = vi.fn();
const confirmAsk = vi.fn();
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a) } }));
vi.mock('../../teamsGraph', () => ({ graphTokenSilent: vi.fn(), graphTokenInteractive: vi.fn(), listMyChats: vi.fn() }));
vi.mock('../../api', () => ({
  api: {
    timeShifts: (...a) => timeShifts(...a),
    timeShiftGroups: (...a) => timeShiftGroups(...a),
    timeShiftDelete: (...a) => timeShiftDelete(...a),
    timeShiftGroupDelete: (...a) => timeShiftGroupDelete(...a),
    timeShiftGroupOrder: (...a) => timeShiftGroupOrder(...a),
    shiftRequestSettingsGet: (...a) => shiftRequestSettingsGet(...a),
    shiftRequestSettingsSave: (...a) => shiftRequestSettingsSave(...a),
    timeShiftCreate: vi.fn(), timeShiftUpdate: vi.fn(), timeShiftGroupCreate: vi.fn(), timeShiftGroupSet: vi.fn(), timeMyChats: vi.fn(),
    timeOffTypes: vi.fn().mockResolvedValue({ builtIn: ['vacation'], custom: ['Jury Duty'] }),
    timeOffTypesSave: vi.fn().mockImplementation(async (b) => ({ builtIn: ['vacation'], custom: b.custom })),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'a@x.com', name: 'Amy Adams' }, { email: 'b@x.com', name: 'Bob Brown' }, { email: 'c@x.com', name: 'Cat Cole' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
  },
}));

const { ShiftSettingsPanel, ShiftTypesPanel, ShiftGroupsPanel } = await import('./ShiftSettingsSections');
const { ZONE_GROUPS } = await import('../../lib/worldClockZones');
const ASIA = ZONE_GROUPS.Asia[0];

const preset = { id: 'p1', name: 'Store', code: 'GST', start: '09:00', end: '17:00', days: '1,2,3,4,5', graceMin: 10, breakMin: 0, color: '#2563eb', timezone: 'America/Los_Angeles', placed: 3, assigned: 1 };
const groups = [{ id: 'g1', name: 'Front Desk', members: ['a@x.com', 'b@x.com'], schedulers: [], chatId: 'c1', chatName: 'Front Desk Chat', sortOrder: 0 },
  { id: 'g2', name: 'Back Office', members: ['c@x.com'], schedulers: [], sortOrder: 1 }];
const toastOk = vi.fn();
const toastErr = vi.fn();

beforeEach(() => {
  timeShifts.mockReset().mockResolvedValue({ shifts: [preset], defaultTimezone: ASIA });
  timeShiftGroups.mockReset().mockResolvedValue({ groups, canManageGroups: true });
  timeShiftDelete.mockReset().mockResolvedValue({ ok: true });
  timeShiftGroupDelete.mockReset().mockResolvedValue({ ok: true });
  timeShiftGroupOrder.mockReset().mockResolvedValue({ ok: true });
  shiftRequestSettingsGet.mockReset().mockResolvedValue({ openShifts: true, swaps: false, offers: true, timeOffRequests: true, teamSchedules: true, reminders: true, reminderLeadMinutes: 60, timeZone: 'America/Los_Angeles', weekStart: 'monday' });
  shiftRequestSettingsSave.mockReset().mockImplementation(async (c) => c);
  confirmAsk.mockReset().mockResolvedValue(true);
  toastOk.mockReset(); toastErr.mockReset();
});

describe('Shift Settings', () => {
  it('saves a switch, the team time zone and the week start', async () => {
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const swaps = await screen.findByLabelText('Staff can swap shifts with teammates');
    expect(swaps.checked).toBe(false);
    fireEvent.click(swaps);
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenCalledWith(expect.objectContaining({ swaps: true })));
    const zone = screen.getByLabelText('Team time zone');
    fireEvent.change(zone, { target: { value: ASIA } });
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: ASIA })));
    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: 'sunday' } });
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ weekStart: 'sunday' })));
    fireEvent.change(screen.getByLabelText('Reminder lead time'), { target: { value: '120' } });
    await waitFor(() => expect(shiftRequestSettingsSave).toHaveBeenLastCalledWith(expect.objectContaining({ reminderLeadMinutes: 120 })));
    expect(await screen.findByText('Jury Duty')).toBeTruthy();   // the time-off reasons live here too
    expect(toastOk).toHaveBeenCalledWith('Shift settings saved.');
  });

  it('shows an error with Retry when the settings cannot load', async () => {
    shiftRequestSettingsGet.mockRejectedValueOnce(new Error('API error 500'));
    const { api } = await import('../../api');
    api.shiftRequestsInbox = vi.fn().mockRejectedValue(new Error('API error 500'));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText('The shift settings could not be loaded right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Staff can request open shifts')).toBeTruthy();
  });
});

describe('Shift Types', () => {
  it('asks before deleting a shift type, and says what hangs off it', async () => {
    confirmAsk.mockResolvedValue(false);
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    fireEvent.click(await screen.findByLabelText('Delete shift type Store'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
    const [message, opts] = confirmAsk.mock.calls[0];
    expect(message).toContain('Delete the shift type "Store"?');
    expect(message).toContain('3 shifts already on the schedule stay');
    expect(message).toContain('1 person loses it as their usual hours');
    expect(opts).toMatchObject({ title: 'Delete Shift Type', danger: true });
    expect(timeShiftDelete).not.toHaveBeenCalled();
    confirmAsk.mockResolvedValue(true);
    fireEvent.click(screen.getByLabelText('Delete shift type Store'));
    await waitFor(() => expect(timeShiftDelete).toHaveBeenCalledWith('p1'));
    expect(toastOk).toHaveBeenCalledWith('Shift type deleted.');
  });

  it('starts a new shift type on the team time zone', async () => {
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByLabelText('Delete shift type Store');
    fireEvent.click(screen.getByText('New Shift Type'));
    expect(screen.getByRole('dialog', { name: 'New Shift Type' })).toBeTruthy();
    expect(screen.getByLabelText('Shift type time zone').value).toBe(ASIA);
  });
});

describe('Groups', () => {
  it('asks before deleting a group, and reorders with the arrows', async () => {
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    fireEvent.click(await screen.findByLabelText('Delete group Front Desk'));
    await waitFor(() => expect(timeShiftGroupDelete).toHaveBeenCalledWith('g1'));
    const [message, opts] = confirmAsk.mock.calls[0];
    expect(message).toContain('Its 2 members keep their shifts');
    expect(message).toContain('Teams chat');
    expect(opts).toMatchObject({ title: 'Delete Group', danger: true });
    fireEvent.click(screen.getByLabelText('Move Back Office up'));
    await waitFor(() => expect(timeShiftGroupOrder).toHaveBeenCalledWith(['g2', 'g1']));
  });

  it('offers no group changes to a manager without company-wide access', async () => {
    timeShiftGroups.mockResolvedValue({ groups, canManageGroups: false });
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText('Front Desk')).toBeTruthy();
    expect(screen.queryByText('New Group')).toBeNull();
    expect(screen.queryByLabelText('Delete group Front Desk')).toBeNull();
    expect(screen.getByText('Groups are changed by an administrator')).toBeTruthy();
  });

  it('picks members from the curated People list by name, never an email', async () => {
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Front Desk');
    fireEvent.click(screen.getByText('New Group'));
    expect(await screen.findByLabelText('Add Cat Cole')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search people to add'), { target: { value: 'bob' } });
    expect(screen.queryByLabelText('Add Cat Cole')).toBeNull();
    fireEvent.click(screen.getByLabelText('Add Bob Brown'));
    expect(screen.getByText('Members (1)')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'New Group' }).textContent).not.toContain('@x.com');
  });
});
