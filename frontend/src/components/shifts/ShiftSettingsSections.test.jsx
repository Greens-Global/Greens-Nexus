import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Settings > Global Settings > Shifts (Oct 2026; was Shifts > Presets &
// Teams and the settings block under the manager inbox): deleting a shift
// type or a group is permanent, so it is confirmed first; the group controls
// show only to people whose changes the API accepts; a new shift type starts
// on the team time zone; the switches, zone and week start save at once.
// Shifts Phase 0 (Oct 14): settings, shift types and groups per company -
// one remembered picker across the three panels, shown only to people the
// API lets pick. A viewer offered exactly one company is pinned to it; a
// company save sends only what changed; a remembered company that fails to
// load is dropped for the defaults; the type controls follow canManage.

const timeShiftsFor = vi.fn();
const timeShiftGroups = vi.fn();
const timeShiftDelete = vi.fn();
const timeShiftGroupDelete = vi.fn();
const timeShiftGroupOrder = vi.fn();
const shiftRequestSettingsGetFor = vi.fn();
const shiftRequestSettingsSaveFor = vi.fn();
const shiftRequestSettingsReset = vi.fn();
const timeShiftCreate = vi.fn();
const timeShiftGroupCreate = vi.fn();
const confirmAsk = vi.fn();
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a) } }));
vi.mock('../../teamsGraph', () => ({ graphTokenSilent: vi.fn(), graphTokenInteractive: vi.fn(), listMyChats: vi.fn(), channelTokenInteractive: vi.fn(), listMyChannels: vi.fn() }));
const timeShiftGroupSet = vi.fn();
const timeMyChannels = vi.fn();
const timeCalendarSyncStatus = vi.fn();
const role = { current: null };
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => role.current }));
vi.mock('../../api', () => ({
  api: {
    timeCalendarSyncStatus: (...a) => timeCalendarSyncStatus(...a),
    timeShiftsFor: (...a) => timeShiftsFor(...a),
    timeShiftGroups: (...a) => timeShiftGroups(...a),
    timeShiftDelete: (...a) => timeShiftDelete(...a),
    timeShiftGroupDelete: (...a) => timeShiftGroupDelete(...a),
    timeShiftGroupOrder: (...a) => timeShiftGroupOrder(...a),
    shiftRequestSettingsGetFor: (...a) => shiftRequestSettingsGetFor(...a),
    shiftRequestSettingsSaveFor: (...a) => shiftRequestSettingsSaveFor(...a),
    shiftRequestSettingsReset: (...a) => shiftRequestSettingsReset(...a),
    timeShiftCreate: (...a) => timeShiftCreate(...a), timeShiftUpdate: vi.fn(), timeShiftGroupCreate: (...a) => timeShiftGroupCreate(...a), timeMyChats: vi.fn(),
    timeShiftGroupSet: (...a) => timeShiftGroupSet(...a), timeMyChannels: (...a) => timeMyChannels(...a),
    timeOffTypes: vi.fn().mockResolvedValue({ builtIn: ['vacation'], custom: ['Jury Duty'] }),
    timeOffTypesSave: vi.fn().mockImplementation(async (b) => ({ builtIn: ['vacation'], custom: b.custom })),
    getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'a@x.com', name: 'Amy Adams' }, { email: 'b@x.com', name: 'Bob Brown' }, { email: 'c@x.com', name: 'Cat Cole' }]),
    getRolesDirectory: vi.fn().mockResolvedValue([]),
    getWorkSites: vi.fn().mockResolvedValue([{ id: 's1', name: 'Harbor View', latitude: '33.1', longitude: '-117.2' }, { id: 's2', name: 'Yard', latitude: '', longitude: '' }]),
  },
}));

const { ShiftSettingsPanel, ShiftTypesPanel, ShiftGroupsPanel } = await import('./ShiftSettingsSections');
const { ZONE_GROUPS } = await import('../../lib/worldClockZones');
const ASIA = ZONE_GROUPS.Asia[0];

const preset = { id: 'p1', name: 'Store', code: 'GST', start: '09:00', end: '17:00', days: '1,2,3,4,5', graceMin: 10, breakMin: 0, color: '#2563eb', timezone: 'America/Los_Angeles', placed: 3, assigned: 1 };
const groups = [{ id: 'g1', name: 'Front Desk', members: ['a@x.com', 'b@x.com'], schedulers: [], chatId: 'c1', chatName: 'Front Desk Chat', sortOrder: 0,
  workSiteId: 's1', workSiteName: 'Harbor View', siteLocated: true, weatherDeciders: ['a@x.com'], weatherAlerts: true },
  { id: 'g2', name: 'Back Office', members: ['c@x.com'], schedulers: [], sortOrder: 1 },
  { id: 'g3', name: 'Operations', members: ['a@x.com'], schedulers: [], chatId: 'ch9', chatName: 'BOD-EOD', teamsTarget: 'channel', teamId: 't9', teamName: 'Ops Team', sortOrder: 2 }];
const toastOk = vi.fn();
const toastErr = vi.fn();
const COMPANIES = [{ id: 'c1', name: 'Greens Storage' }, { id: 'c2', name: 'Greens India' }];
const SETTINGS = { openShifts: true, swaps: false, offers: true, timeOffRequests: true, teamSchedules: true, timeZone: 'America/Los_Angeles', weekStart: 'monday', defaultGraceMin: 10, companyId: '', hasOverride: false, companies: [], canPickCompany: false };

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom */ }
  timeShiftsFor.mockReset().mockResolvedValue({ shifts: [preset], defaultTimezone: ASIA, companies: [], canPickCompany: false });
  timeShiftGroups.mockReset().mockResolvedValue({ groups, canManageGroups: true, companies: [], canPickCompany: false });
  timeShiftDelete.mockReset().mockResolvedValue({ ok: true });
  timeShiftGroupDelete.mockReset().mockResolvedValue({ ok: true });
  timeShiftGroupOrder.mockReset().mockResolvedValue({ ok: true });
  timeShiftCreate.mockReset().mockResolvedValue({ ok: true });
  timeShiftGroupCreate.mockReset().mockResolvedValue({ ok: true });
  shiftRequestSettingsGetFor.mockReset().mockResolvedValue(SETTINGS);
  shiftRequestSettingsSaveFor.mockReset().mockImplementation(async (c) => c);
  shiftRequestSettingsReset.mockReset().mockResolvedValue({ ok: true });
  confirmAsk.mockReset().mockResolvedValue(true);
  timeCalendarSyncStatus.mockReset().mockResolvedValue({ enabled: true, reason: '', pending: 3, ok: 124, errors: 0, skipped: 0 });
  role.current = null;
  toastOk.mockReset(); toastErr.mockReset();
});

describe('Shift Settings', () => {
  it('saves a switch, the team time zone and the week start', async () => {
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const swaps = await screen.findByLabelText('Staff can swap shifts with teammates');
    expect(swaps.checked).toBe(false);
    fireEvent.click(swaps);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenCalledWith(expect.objectContaining({ swaps: true }), ''));
    const zone = screen.getByLabelText('Team time zone');
    fireEvent.change(zone, { target: { value: ASIA } });
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ timeZone: ASIA }), ''));
    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: 'sunday' } });
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ weekStart: 'sunday' }), ''));
    expect(await screen.findByText('Jury Duty')).toBeTruthy();   // the time-off reasons live here too
    expect(toastOk).toHaveBeenCalledWith('Shift settings saved.');
  });

  it('shows an error with Retry when the settings cannot load', async () => {
    shiftRequestSettingsGetFor.mockRejectedValueOnce(new Error('API error 500'));
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
    await waitFor(() => expect(timeShiftGroupOrder).toHaveBeenCalledWith(['g2', 'g1', 'g3']));
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

  it('binds a group to a Teams channel instead of a group chat (Oct 6)', async () => {
    timeShiftGroupSet.mockReset().mockResolvedValue({ ok: true });
    timeMyChannels.mockReset().mockResolvedValue({ channels: [
      { teamId: 't1', teamName: 'Admin', channelId: 'c-gen', channelName: 'General', membershipType: 'standard' },
      { teamId: 't1', teamName: 'Admin', channelId: 'c-bod', channelName: 'BOD-EOD', membershipType: 'private' }], reason: '' });
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText('Ops Team › BOD-EOD')).toBeTruthy();          // a channel binding in the list
    fireEvent.click(screen.getAllByText('Edit')[1]);                             // Back Office: nothing bound
    fireEvent.click(await screen.findByRole('radio', { name: /Channel/ }));
    fireEvent.click(screen.getByText('Bind A Channel'));
    const pick = await screen.findByLabelText('Teams channel');
    expect(screen.getByText('BOD-EOD (private)')).toBeTruthy();
    fireEvent.change(pick, { target: { value: 'c-bod' } });
    expect(screen.getByText(/Admin › BOD-EOD/)).toBeTruthy();
    expect(screen.getByText(/Each message is a new post in the channel/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(timeShiftGroupSet).toHaveBeenCalled());
    expect(timeShiftGroupSet.mock.calls[0][1]).toMatchObject({ teams_target: 'channel', teams_chat_id: 'c-bod', teams_chat_name: 'BOD-EOD', teams_team_id: 't1', teams_team_name: 'Admin' });
  });

  // Weather Call (Oct 2026): a group's work site is where the weather watch
  // looks, and its deciders make the call. The list says which groups the
  // watch cannot see; the editor saves the three fields with the rest.
  it('shows each group on the weather watch and saves its work site and deciders', async () => {
    timeShiftGroupSet.mockReset().mockResolvedValue({ ok: true });
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText('Harbor View · Weather alerts on · 1 decider')).toBeTruthy();
    expect(screen.getAllByText('No work site - weather alerts cannot watch this group').length).toBe(2);   // Back Office, Operations
    fireEvent.click(screen.getAllByText('Edit')[1]);                                  // Back Office
    const dlg = await screen.findByRole('dialog', { name: 'Edit Group' });
    fireEvent.change(within(dlg).getByLabelText('Work site'), { target: { value: 's1' } });
    fireEvent.change(within(dlg).getByLabelText('Add a weather decider'), { target: { value: 'b@x.com' } });
    expect(within(dlg).getByRole('button', { name: 'Remove weather decider Bob Brown' })).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(timeShiftGroupSet).toHaveBeenCalled());
    expect(timeShiftGroupSet.mock.calls[0][1]).toMatchObject({ work_site_id: 's1', weather_deciders: ['b@x.com'], weather_alerts: true });
  });

  it('switching between chat and channel clears the other kind', async () => {
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Front Desk');
    fireEvent.click(screen.getAllByText('Edit')[0]);                             // Front Desk: a group chat
    const dlg = await screen.findByRole('dialog', { name: 'Edit Group' });
    expect(dlg.textContent).toContain('Front Desk Chat');
    fireEvent.click(screen.getByRole('radio', { name: /Channel/ }));
    expect(dlg.textContent).not.toContain('Front Desk Chat');
    expect(screen.getByText('Bind A Channel')).toBeTruthy();
  });
});

// ── Companies (Shifts Phase 0, Oct 14) ──────────────────────────────────
describe('Companies', () => {
  const withCompanies = (over = {}) => ({ ...SETTINGS, companies: COMPANIES, canPickCompany: true, ...over });

  it('hides the company picker from people who cannot pick', async () => {
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByLabelText('Staff can request open shifts');
    expect(screen.queryByLabelText('Company')).toBeNull();
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByLabelText('Delete shift type Store');
    expect(screen.queryByLabelText('Company')).toBeNull();
    expect(screen.queryByText('Shared')).toBeNull();   // no company label on a row either
  });

  it('picking a company reloads its settings, saves for it, and is remembered', async () => {
    shiftRequestSettingsGetFor.mockImplementation(async (company) => withCompanies({ companyId: company, hasOverride: false }));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const pick = await screen.findByLabelText('Company');
    expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith('');
    expect(within(pick).getByText('All Companies (Default)')).toBeTruthy();
    expect(screen.queryByText(/Using the default settings/)).toBeNull();
    fireEvent.change(pick, { target: { value: 'c1' } });
    await waitFor(() => expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith('c1'));
    expect(await screen.findByText('Using the default settings. Changing anything here saves settings for Greens Storage only.')).toBeTruthy();
    expect(screen.queryByText('Use the Defaults')).toBeNull();
    fireEvent.click(screen.getByLabelText('Staff can swap shifts with teammates'));
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenCalledWith(expect.objectContaining({ swaps: true }), 'c1'));
    expect(await screen.findByText(/Greens Storage has its own settings/)).toBeTruthy();   // the save made an override
    expect(toastOk).toHaveBeenCalledWith('Shift settings saved for Greens Storage.');
    expect(localStorage.getItem('shifts.settings.company')).toBe('c1');
  });

  it('"Use the Defaults" drops the company override after a confirmation', async () => {
    localStorage.setItem('shifts.settings.company', 'c2');   // remembered from last time
    shiftRequestSettingsGetFor.mockImplementation(async (company) => withCompanies({ companyId: company, hasOverride: company === 'c2' }));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText(/Greens India has its own settings/)).toBeTruthy();
    expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith('c2');
    confirmAsk.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByText('Use the Defaults'));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalled());
    expect(shiftRequestSettingsReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Use the Defaults'));
    await waitFor(() => expect(shiftRequestSettingsReset).toHaveBeenCalledWith('c2'));
    expect(toastOk).toHaveBeenCalledWith('Greens India now uses the default settings.');
    await waitFor(() => expect(shiftRequestSettingsGetFor).toHaveBeenCalledTimes(2));   // reloaded
  });

  it('saves the default grace, clamped to 0-120, on blur', async () => {
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const grace = await screen.findByLabelText('Default grace');
    expect(grace.value).toBe('10');
    fireEvent.change(grace, { target: { value: '25' } });
    expect(shiftRequestSettingsSaveFor).not.toHaveBeenCalled();   // typing alone saves nothing
    fireEvent.blur(grace);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenCalledWith(expect.objectContaining({ defaultGraceMin: 25 }), ''));
    fireEvent.change(grace, { target: { value: '500' } });
    fireEvent.blur(grace);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ defaultGraceMin: 120 }), ''));
    expect(screen.getByText(/A shift type carries its own grace/)).toBeTruthy();
    expect(screen.getByText(/open shift requests are off unless turned on here/)).toBeTruthy();
  });

  // Shifts Phase 1 (Oct 14): the attendance thresholds - the no-show alert
  // and what counts as leaving early - save on blur, clamped to 0-240.
  it('saves the no-show alert and left-early minutes, clamped to 0-240, on blur or Enter', async () => {
    shiftRequestSettingsGetFor.mockResolvedValue({ ...SETTINGS, noShowAlertMin: 10, leftEarlyMin: 15 });
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const noShow = await screen.findByLabelText('No-show alert');
    const early = screen.getByLabelText('Left early');
    expect(screen.getByText('Attendance')).toBeTruthy();
    expect(noShow.value).toBe('10');
    expect(early.value).toBe('15');
    fireEvent.change(noShow, { target: { value: '0' } });
    expect(shiftRequestSettingsSaveFor).not.toHaveBeenCalled();   // typing alone saves nothing
    fireEvent.blur(noShow);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenCalledWith(expect.objectContaining({ noShowAlertMin: 0, leftEarlyMin: 15 }), ''));
    fireEvent.change(noShow, { target: { value: '999' } });
    fireEvent.keyDown(noShow, { key: 'Enter' });
    fireEvent.blur(noShow);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ noShowAlertMin: 240 }), ''));
    fireEvent.change(early, { target: { value: '-5' } });
    fireEvent.blur(early);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ leftEarlyMin: 0, noShowAlertMin: 240 }), ''));
    expect(screen.getByText(/always lands inside the six hours after the start\. 0 turns it off\.$/)).toBeTruthy();
    expect(screen.getByText(/counts as leaving early on the schedule/)).toBeTruthy();
    // Usual hours (Oct 15): off unless turned on; saves only that key.
    const usual = screen.getByLabelText('Alert for usual hours too');
    expect(usual.checked).toBe(false);
    expect(screen.getByText(/office staff who have usual hours but no shift on the schedule/)).toBeTruthy();
    fireEvent.click(usual);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith({ noShowOnUsualHours: true }, ''));
  });

  it('shows the defaults (10 and 15) when the API sends none, and an unchanged value saves nothing', async () => {
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const noShow = await screen.findByLabelText('No-show alert');
    expect(noShow.value).toBe('10');
    expect(screen.getByLabelText('Left early').value).toBe('15');
    fireEvent.change(noShow, { target: { value: '10' } });
    fireEvent.blur(noShow);
    fireEvent.change(noShow, { target: { value: '' } });
    fireEvent.blur(noShow);
    expect(shiftRequestSettingsSaveFor).not.toHaveBeenCalled();
    expect(noShow.value).toBe('10');
  });

  it('forgets a remembered company the API no longer offers', async () => {
    localStorage.setItem('shifts.settings.company', 'gone');
    shiftRequestSettingsGetFor.mockImplementation(async (company) => withCompanies({ companyId: company }));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    await waitFor(() => expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith(''));
    expect(localStorage.getItem('shifts.settings.company')).toBe('');
  });

  it('pins a company-scoped administrator to their one company, and every save carries it', async () => {
    const one = [COMPANIES[0]];
    shiftRequestSettingsGetFor.mockImplementation(async (company) => ({ ...SETTINGS, companyId: company, companies: one, canPickCompany: false }));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    await waitFor(() => expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith('c1'));
    expect(screen.queryByLabelText('Company')).toBeNull();   // nothing to pick
    expect(await screen.findByText('Using the default settings. Changing anything here saves settings for Greens Storage only.')).toBeTruthy();
    expect(localStorage.getItem('shifts.settings.company')).toBe('c1');
    fireEvent.click(screen.getByLabelText('Staff can swap shifts with teammates'));
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenCalledWith({ swaps: true }, 'c1'));
    expect(toastOk).toHaveBeenCalledWith('Shift settings saved for Greens Storage.');
    // A new shift type and a new group land on that company too, with no Company select offered.
    timeShiftsFor.mockImplementation(async () => ({ shifts: [preset], defaultTimezone: ASIA, companies: one, canPickCompany: false, canManage: true }));
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    await waitFor(() => expect(timeShiftsFor).toHaveBeenLastCalledWith('c1'));
    fireEvent.click(await screen.findByText('New Shift Type'));
    const dlg = screen.getByRole('dialog', { name: 'New Shift Type' });
    expect(within(dlg).queryByLabelText('Shift type company')).toBeNull();
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'Evening' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(timeShiftCreate).toHaveBeenCalled());
    expect(timeShiftCreate.mock.calls[0][0]).toMatchObject({ name: 'Evening', company_id: 'c1' });
    timeShiftGroups.mockResolvedValue({ groups, canManageGroups: true, companies: one, canPickCompany: false });
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    fireEvent.click(await screen.findByText('New Group'));
    const gdlg = await screen.findByRole('dialog', { name: 'New Group' });
    expect(within(gdlg).queryByLabelText('Group company')).toBeNull();
    fireEvent.change(within(gdlg).getByLabelText('Group name'), { target: { value: 'Yard' } });
    fireEvent.click(within(gdlg).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(timeShiftGroupCreate).toHaveBeenCalled());
    expect(timeShiftGroupCreate.mock.calls[0][0]).toMatchObject({ name: 'Yard', company_id: 'c1' });
  });

  it('sends only the changed key for a company and shows what the server kept', async () => {
    localStorage.setItem('shifts.settings.company', 'c1');
    shiftRequestSettingsGetFor.mockImplementation(async (company) => withCompanies({ companyId: company, hasOverride: false }));
    // The server stores only what differs from the tenant: a switch that
    // differs makes an override, one set back to the tenant's value leaves none.
    shiftRequestSettingsSaveFor.mockImplementation(async (patch) => withCompanies({ ...SETTINGS, ...patch, companyId: 'c1', hasOverride: patch.swaps === true }));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const swaps = await screen.findByLabelText('Staff can swap shifts with teammates');
    fireEvent.click(swaps);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenCalledWith({ swaps: true }, 'c1'));
    expect(shiftRequestSettingsSaveFor.mock.calls[0][0]).toEqual({ swaps: true });   // never the whole form
    expect(await screen.findByText(/Greens Storage has its own settings/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Staff can swap shifts with teammates'));
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith({ swaps: false }, 'c1'));
    expect(await screen.findByText(/Using the default settings/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: 'sunday' } });
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith({ weekStart: 'sunday' }, 'c1'));
  });

  it('drops a remembered company that no longer loads and shows the defaults, not an error', async () => {
    localStorage.setItem('shifts.settings.company', 'c2');
    const refused = Object.assign(new Error('API error 403'), { status: 403 });
    shiftRequestSettingsGetFor.mockImplementation(async (company) => { if (company) throw refused; return withCompanies({ companyId: '' }); });
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByLabelText('Staff can request open shifts')).toBeTruthy();
    expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith('');
    expect(screen.queryByText('The shift settings could not be loaded right now.')).toBeNull();
    expect(localStorage.getItem('shifts.settings.company')).toBe('');
    const gone = Object.assign(new Error('API error 404'), { status: 404 });
    localStorage.setItem('shifts.settings.company', 'c2');
    timeShiftsFor.mockImplementation(async (company) => { if (company) throw gone; return { shifts: [preset], defaultTimezone: ASIA, companies: COMPANIES, canPickCompany: true }; });
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByLabelText('Delete shift type Store')).toBeTruthy();
    expect(timeShiftsFor).toHaveBeenLastCalledWith('');
    expect(screen.queryByText('The shift types could not be loaded right now.')).toBeNull();
    expect(localStorage.getItem('shifts.settings.company')).toBe('');
  });

  it('hides New / Edit / Delete from a manager who may not change shift types', async () => {
    timeShiftsFor.mockResolvedValue({ shifts: [preset], defaultTimezone: ASIA, companies: [COMPANIES[0]], canPickCompany: false, canManage: false });
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText('Store')).toBeTruthy();
    expect(screen.queryByText('New Shift Type')).toBeNull();
    expect(screen.queryByLabelText('Edit shift type Store')).toBeNull();
    expect(screen.queryByLabelText('Delete shift type Store')).toBeNull();
    expect(screen.getByText('Shift types are set by company administrators.')).toBeTruthy();
  });

  it('offers the Company select in the shift type form only to people who can pick, and sends it', async () => {
    timeShiftsFor.mockImplementation(async (company) => ({ shifts: company === 'c1' ? [preset, { ...preset, id: 'p2', name: 'Night', companyId: 'c1' }] : [preset], defaultTimezone: ASIA, companies: COMPANIES, canPickCompany: true }));
    render(<ShiftTypesPanel toastOk={toastOk} toastErr={toastErr} />);
    const pick = await screen.findByLabelText('Company');
    expect(screen.getByText('Shared')).toBeTruthy();                  // the row label
    fireEvent.change(pick, { target: { value: 'c1' } });
    await waitFor(() => expect(timeShiftsFor).toHaveBeenLastCalledWith('c1'));
    expect(await screen.findByLabelText('Delete shift type Night')).toBeTruthy();
    expect(screen.getByTitle('Only this company').textContent).toBe('Greens Storage');   // Night's label
    fireEvent.click(screen.getByText('New Shift Type'));
    const dlg = screen.getByRole('dialog', { name: 'New Shift Type' });
    const sel = within(dlg).getByLabelText('Shift type company');
    expect(sel.value).toBe('c1');                                     // starts on the picked company
    expect(within(sel).getByText('Shared With Every Company')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'Evening' } });
    fireEvent.change(sel, { target: { value: '' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(timeShiftCreate).toHaveBeenCalled());
    expect(timeShiftCreate.mock.calls[0][0]).toMatchObject({ name: 'Evening', company_id: '' });
  });

  it('labels each group with its company and sends the form\'s choice', async () => {
    timeShiftGroups.mockResolvedValue({ groups: [groups[0], { ...groups[1], companyId: 'c2' }], canManageGroups: true, companies: COMPANIES, canPickCompany: true });
    render(<ShiftGroupsPanel toastOk={toastOk} toastErr={toastErr} />);
    const pick = await screen.findByLabelText('Company');
    expect(screen.getByText('Shared')).toBeTruthy();
    expect(screen.getByTitle('Only this company').textContent).toBe('Greens India');
    fireEvent.change(pick, { target: { value: 'c1' } });              // Greens Storage: the shared group only
    await waitFor(() => expect(screen.queryByText('Back Office')).toBeNull());
    expect(screen.getByText('Front Desk')).toBeTruthy();
    fireEvent.click(screen.getByText('New Group'));
    const dlg = await screen.findByRole('dialog', { name: 'New Group' });
    const sel = within(dlg).getByLabelText('Group company');
    expect(sel.value).toBe('c1');
    fireEvent.change(within(dlg).getByLabelText('Group name'), { target: { value: 'Yard' } });
    fireEvent.click(within(dlg).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(timeShiftGroupCreate).toHaveBeenCalled());
    expect(timeShiftGroupCreate.mock.calls[0][0]).toMatchObject({ name: 'Yard', company_id: 'c1' });
  });
});

// Shifts Phase 2 (Oct 14): the Rules - five numbers (0 = off) that warn on
// the schedule and never block, and whether sharing with warnings needs a
// reason.
describe('ShiftSettingsPanel rules', () => {
  const commit = (el, value) => { fireEvent.change(el, { target: { value } }); fireEvent.blur(el); };
  it('saves each rule, clamped to its range, and the reason switch', async () => {
    shiftRequestSettingsSaveFor.mockImplementation(async (b) => b);
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const rest = await screen.findByLabelText('Minimum rest between shifts');
    expect(rest.value).toBe('0');
    expect(screen.getByText(/^California daily overtime; applies to people on the California overtime rule\./)).toBeTruthy();
    expect(screen.getByText(/US people get the California rule, everyone else has no overtime rules/)).toBeTruthy();
    expect(screen.getByText(/the payroll week, Sunday to Saturday/)).toBeTruthy();
    expect(screen.getByText(/the week shown on the grid/)).toBeTruthy();
    // The "0 turns a rule off" note sits under the Rules heading, not on the last field.
    const rules = screen.getByText('Rules').parentElement;
    expect(rules.children[1].textContent).toBe('0 turns a rule off. Rules warn on the schedule; they never block.');
    expect(screen.getByText(/A company that does not want to be asked turns this off here/)).toBeTruthy();
    commit(rest, '10');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleMinRestHours: 10 }), ''));
    commit(screen.getByLabelText('Minimum rest between shifts'), '99');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleMinRestHours: 24 }), ''));
    commit(screen.getByLabelText('Most days in a row'), '20');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleMaxDaysInRow: 14, ruleMinRestHours: 24 }), ''));
    commit(screen.getByLabelText('Daily overtime after'), '8');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleDailyOtHours: 8 }), ''));
    commit(screen.getByLabelText('Weekly overtime after'), '100');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleWeeklyOtHours: 80 }), ''));
    commit(screen.getByLabelText('Most hours per week'), '150');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleMaxWeekHours: 100 }), ''));
    commit(screen.getByLabelText('Most hours per week'), '-3');
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ ruleMaxWeekHours: 0 }), ''));
    const box = screen.getByLabelText('Require a reason to share a schedule that has warnings');
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith({ publishReasonRequired: true }, ''));   // only the key that changed (a sparse company override)
    expect(screen.getByLabelText('Require a reason to share a schedule that has warnings').checked).toBe(true);
  });

  it('shows what the API sends and saves nothing for an unchanged value', async () => {
    shiftRequestSettingsGetFor.mockResolvedValue({ ...SETTINGS, ruleMinRestHours: 8, ruleMaxDaysInRow: 6, ruleDailyOtHours: 8, ruleWeeklyOtHours: 40, ruleMaxWeekHours: 60, publishReasonRequired: true });
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const rest = await screen.findByLabelText('Minimum rest between shifts');
    expect(rest.value).toBe('8');
    expect(screen.getByLabelText('Most days in a row').value).toBe('6');
    expect(screen.getByLabelText('Weekly overtime after').value).toBe('40');
    expect(screen.getByLabelText('Most hours per week').value).toBe('60');
    expect(screen.getByLabelText('Require a reason to share a schedule that has warnings').checked).toBe(true);
    commit(rest, '8');
    commit(rest, '');
    expect(shiftRequestSettingsSaveFor).not.toHaveBeenCalled();
    expect(rest.value).toBe('8');
  });
});

// Shifts Phase 3a (Oct 14): Sharing - Outlook calendars for shared shifts
// (and how a shift shows there), confirmations, and for an administrator
// the sync status: a count when it runs, a quiet amber note (never an
// error) while the Entra permission is still to be granted.
describe('ShiftSettingsPanel sharing', () => {
  it('saves the three sharing settings, and Show In Outlook As follows the calendar switch', async () => {
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const cal = await screen.findByLabelText("Add shared shifts to people's Outlook calendars");
    expect(cal.checked).toBe(true);                                             // on by default
    const showAs = screen.getByLabelText('Show in Outlook as');
    expect(showAs.disabled).toBe(false);
    expect(showAs.value).toBe('free');
    fireEvent.change(showAs, { target: { value: 'busy' } });
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ outlookShowAs: 'busy' }), ''));
    fireEvent.click(cal);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ outlookCalendar: false, outlookShowAs: 'busy' }), ''));
    expect(screen.getByLabelText('Show in Outlook as').disabled).toBe(true);
    const ask = screen.getByLabelText('Ask people to confirm a shared schedule');
    expect(ask.checked).toBe(true);
    fireEvent.click(ask);
    await waitFor(() => expect(shiftRequestSettingsSaveFor).toHaveBeenLastCalledWith(expect.objectContaining({ confirmRequests: false }), ''));
    expect(timeCalendarSyncStatus).not.toHaveBeenCalled();                     // not an administrator: no status line
    expect(document.querySelector('[data-calendar-sync]')).toBeNull();
  });

  it('shows an administrator the sync count, or the quiet permission note, and nothing on a failed call', async () => {
    role.current = { can: (r) => r === 'administrator' };
    const { unmount } = render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const line = await screen.findByText('Outlook calendar: on - 124 synced, 3 pending');
    expect(line.getAttribute('data-calendar-sync')).toBe('on');
    unmount();
    timeCalendarSyncStatus.mockResolvedValue({ enabled: false, reason: 'Calendars.ReadWrite is not granted - see docs/Outlook-Calendar-Setup.md', pending: 0, ok: 0, errors: 0, skipped: 0 });
    const r2 = render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe('Outlook calendar sync is waiting on an Entra permission (Calendars.ReadWrite). See docs/Outlook-Calendar-Setup.md.');
    expect(note.getAttribute('data-calendar-sync')).toBe('waiting');
    expect(note.style.color).toBe('hsl(var(--color-orange))');                 // amber, never red
    expect(screen.queryByRole('alert')).toBeNull();
    r2.unmount();
    timeCalendarSyncStatus.mockRejectedValue(new Error('API error 403'));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByLabelText('Ask people to confirm a shared schedule');
    await waitFor(() => expect(timeCalendarSyncStatus).toHaveBeenCalledTimes(3));
    expect(document.querySelector('[data-calendar-sync]')).toBeNull();
    expect(toastErr).not.toHaveBeenCalled();
  });
});
