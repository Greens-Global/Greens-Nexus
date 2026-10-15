import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Settings > Global Settings > Shifts (Oct 2026; was Shifts > Presets &
// Teams and the settings block under the manager inbox): deleting a shift
// type or a group is permanent, so it is confirmed first; the group controls
// show only to people whose changes the API accepts; a new shift type starts
// on the team time zone; the switches, zone and week start save at once.
// Shifts Phase 0 (Oct 14): settings, shift types and groups per company -
// one remembered picker across the three panels, shown only to people the
// API lets pick.

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
vi.mock('../../api', () => ({
  api: {
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

  it('forgets a remembered company the API no longer offers', async () => {
    localStorage.setItem('shifts.settings.company', 'gone');
    shiftRequestSettingsGetFor.mockImplementation(async (company) => withCompanies({ companyId: company }));
    render(<ShiftSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    await waitFor(() => expect(shiftRequestSettingsGetFor).toHaveBeenLastCalledWith(''));
    expect(localStorage.getItem('shifts.settings.company')).toBe('');
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
