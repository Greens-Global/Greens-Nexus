import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { formatDateTime } from '../../lib/datetime';

// The shift panel's History (Shifts Phase 2, Oct 14): a saved shift lists
// what happened to it, newest first, with who, when, what changed and the
// reason it was shared with; a quiet empty state; nothing at all when the
// API cannot answer, and never loaded for a shift that is not saved yet.

const timeSchedCheck = vi.fn();
const timeSchedHistory = vi.fn();
const createJobsite = vi.fn();
const resolveJobsiteLink = vi.fn();
vi.mock('../../api', () => ({
  api: {
    createJobsite: (...a) => createJobsite(...a),
    resolveJobsiteLink: (...a) => resolveJobsiteLink(...a),
    timeSchedCheck: (...a) => timeSchedCheck(...a),
    timeSchedHistory: (...a) => timeSchedHistory(...a),
    timeOffTypes: vi.fn().mockResolvedValue({ builtIn: ['vacation'], custom: [] }),
  },
}));

const { default: ShiftPanel, historyChangeText } = await import('./ShiftPanel');

const existing = { id: 's1', email: 'amy@x.com', date: '2026-10-20', start: '07:00', end: '15:30', label: 'GSV', shiftId: '', breakMin: 0, conflicts: [] };
const HISTORY = [
  { action: 'shared', actor: 'amy.lee@x.com', actorName: 'Amy Lee', at: '2026-10-14T22:12:00Z', before: { start: '08:00', end: '16:30', label: 'GSV' }, after: { start: '07:00', end: '15:30', label: 'GSV' }, reason: 'Overtime approved' },
  { action: 'edited', actor: 'amy.lee@x.com', actorName: 'Amy Lee', at: '2026-10-14T21:00:00Z', before: { start: '08:00', end: '16:30', label: 'GSV' }, after: { start: '07:00', end: '15:30', label: 'GSV' }, reason: '' },
  { action: 'weather', actor: 'bob@x.com', actorName: 'Bob Brown', at: '2026-10-13T15:00:00Z', before: null, after: null, reason: '' },
  { action: 'created', actor: 'amy.lee@x.com', actorName: '', at: '2026-10-10T15:00:00Z', before: null, after: { start: '08:00', end: '16:30', label: 'GSV' }, reason: '' },
];
const noop = () => {};
const open = (cell) => render(<ShiftPanel cell={cell} presets={[]} groups={[]} people={[]} nameOf={(e) => ({ 'amy@x.com': 'Amy Adams', 'bob@x.com': 'Bob Brown' }[e] || e)}
  onSave={noop} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);

beforeEach(() => {
  timeSchedCheck.mockReset().mockResolvedValue({ warnings: [] });
  timeSchedHistory.mockReset().mockResolvedValue({ shiftId: 's1', email: 'amy@x.com', date: '2026-10-20', entries: HISTORY });
});

describe('historyChangeText', () => {
  it('tells what changed in one line', () => {
    expect(historyChangeText({ start: '08:00', end: '16:30' }, { start: '07:00', end: '15:30' })).toBe('8:00 AM - 4:30 PM -> 7:00 AM - 3:30 PM');
    expect(historyChangeText({ start: '08:00', end: '16:30', label: 'Front' }, { start: '08:00', end: '16:30', label: 'Yard' })).toBe('Label: Front -> Yard');
    expect(historyChangeText({ start: '08:00', end: '16:30', date: '2026-10-20' }, { start: '08:00', end: '16:30', date: '2026-10-21' })).toBe('10/20/2026 -> 10/21/2026');
    expect(historyChangeText({ email: '' }, { email: 'amy@x.com' }, (e) => 'Amy Adams')).toBe('Open shift -> Amy Adams');
    expect(historyChangeText({ openSlots: 2 }, { openSlots: 1 })).toBe('2 -> 1 open');
    expect(historyChangeText(null, { start: '08:00', end: '16:30', label: 'GSV' })).toBe('8:00 AM - 4:30 PM · GSV');
    expect(historyChangeText({ start: '08:00', end: '16:30' }, null)).toBe('8:00 AM - 4:30 PM');
    expect(historyChangeText(null, null)).toBe('');
    expect(historyChangeText({ shiftId: 'a' }, { shiftId: 'b' })).toBe('Shift type changed');
    // Lunch, team, zone and the note fingerprint (Oct 15) - never the note's text.
    const base = { start: '08:00', end: '16:30', breakMin: 30 };
    expect(historyChangeText(base, { ...base, breakMin: 60 })).toBe('Lunch 30 -> 60 min');
    expect(historyChangeText({ ...base, groupId: 'g1' }, { ...base, groupId: 'g2' }, null, (g) => ({ g1: 'Austin', g2: 'Georgetown' }[g]))).toBe('Team: Austin -> Georgetown');
    expect(historyChangeText({ ...base, groupId: '' }, { ...base, groupId: 'g2' }, null, (g) => ({ g2: 'Georgetown' }[g]))).toBe('Team: No team -> Georgetown');
    expect(historyChangeText({ ...base, timezone: 'America/Chicago' }, { ...base, timezone: 'Asia/Kolkata' })).toMatch(/^Zone: .*Chicago.* -> .*Kolkata/);
    expect(historyChangeText(base, { ...base, timezone: 'Asia/Kolkata' })).toMatch(/^Zone: Team zone -> /);
    expect(historyChangeText({ ...base, noteHash: '' }, { ...base, noteHash: 'ab12cd34' })).toBe('Note changed');
    expect(historyChangeText({ ...base, noteHash: 'ab12cd34', groupId: 'g1' }, { ...base, noteHash: 'ab12cd34', groupId: 'g1' }, null, () => 'Austin')).toBe('');
    // A row from before the richer snapshot (no lunch recorded) says nothing about the new fields.
    expect(historyChangeText({ start: '08:00', end: '16:30' }, { ...base, groupId: 'g1', timezone: 'Asia/Kolkata', noteHash: 'x' })).toBe('');
  });
});

describe('ShiftPanel history', () => {
  it('lists the history of a saved shift newest first with who, when, the change and the reason', async () => {
    open({ email: 'amy@x.com', date: '2026-10-20', existing });
    const section = await waitFor(() => { const el = document.querySelector('[data-shift-history]'); if (!el) throw new Error('not yet'); return el; });
    expect(timeSchedHistory).toHaveBeenCalledWith('s1');
    const rows = [...section.querySelectorAll(':scope > div > div')].map((r) => r.textContent);
    expect(rows[0]).toBe(`Shared by Amy Lee · ${formatDateTime('2026-10-14T22:12:00Z')}8:00 AM - 4:30 PM -> 7:00 AM - 3:30 PM"Overtime approved"`);
    expect(rows[1]).toBe(`Edited by Amy Lee · ${formatDateTime('2026-10-14T21:00:00Z')}8:00 AM - 4:30 PM -> 7:00 AM - 3:30 PM`);
    expect(rows[2]).toBe(`Weather Call by Bob Brown · ${formatDateTime('2026-10-13T15:00:00Z')}`);
    expect(rows[3]).toBe(`Created by amy.lee@x.com · ${formatDateTime('2026-10-10T15:00:00Z')}8:00 AM - 4:30 PM · GSV`);
    expect(screen.getByText('History')).toBeTruthy();
  });

  it('says what a share was warned about', async () => {
    timeSchedHistory.mockResolvedValue({ shiftId: 's1', email: 'amy@x.com', date: '2026-10-20', entries: [
      { ...HISTORY[0], after: { ...HISTORY[0].after, warnings: ['Only 8h 00m rest before this shift (10h minimum).'] } },
    ] });
    open({ email: 'amy@x.com', date: '2026-10-20', existing });
    const el = await waitFor(() => { const x = document.querySelector('[data-history-warnings]'); if (!x) throw new Error('not yet'); return x; });
    expect(el.textContent).toBe('Shared with a warning: Only 8h 00m rest before this shift (10h minimum).');
  });

  it('says No history yet. for a shift with none', async () => {
    timeSchedHistory.mockResolvedValue({ shiftId: 's1', email: 'amy@x.com', date: '2026-10-20', entries: [] });
    open({ email: 'amy@x.com', date: '2026-10-20', existing });
    expect(await screen.findByText('No history yet.')).toBeTruthy();
  });

  it('shows nothing when the history cannot load, and never asks for a new shift', async () => {
    timeSchedHistory.mockRejectedValue(new Error('500'));
    const { unmount } = open({ email: 'amy@x.com', date: '2026-10-20', existing });
    await waitFor(() => expect(timeSchedHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[data-shift-history]')).toBeNull();
    expect(screen.queryByText('History')).toBeNull();
    unmount();
    timeSchedHistory.mockClear();
    open({ email: 'amy@x.com', date: '2026-10-20', existing: null });
    expect(screen.getByRole('dialog', { name: 'Add Shift' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(timeSchedHistory).not.toHaveBeenCalled();
  });
});

describe('ShiftPanel live check', () => {
  it('sends the unpaid break with the check, so the daily and weekly rules count paid minutes', async () => {
    // A 7:00 - 3:30 shift with a 30-minute lunch is 8h paid - without the
    // break the check read 8h 30m and warned of daily overtime that the
    // grid would never show once the shift was saved.
    open({ email: 'amy@x.com', date: '2026-10-20', existing: { ...existing, breakMin: 30 } });
    await waitFor(() => expect(timeSchedCheck).toHaveBeenCalled());
    expect(timeSchedCheck).toHaveBeenLastCalledWith({ email: 'amy@x.com', date: '2026-10-20', start: '07:00', end: '15:30', exclude_id: 's1', break_min: 30 });
  });

  it('takes a new shift\'s break from its shift type', async () => {
    const { unmount } = render(<ShiftPanel cell={{ email: 'amy@x.com', date: '2026-10-20' }} presets={[{ id: 'p1', name: 'Day', code: 'D', start: '07:00', end: '15:30', breakMin: 30, color: '#2563eb' }]} groups={[]} people={[]}
      nameOf={(e) => e} onSave={noop} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);
    await waitFor(() => expect(timeSchedCheck).toHaveBeenCalled());
    expect(timeSchedCheck).toHaveBeenLastCalledWith(expect.objectContaining({ start: '07:00', end: '15:30', break_min: 30 }));
    unmount();
  });
});

// Where the shift is worked (the weather follows the jobsite - Neil,
// 10/30/2026; Pranshu, 11/02/2026): None (the team's site) by default, a
// project or a company location, a hint when the jobsite has no address (it
// uses the team site's weather), and "+ New Jobsite" makes one from a name
// and its Google Maps link - the exact point its weather is read at.
describe('ShiftPanel jobsite', () => {
  const JOBSITES = [
    { id: 'project-red', kind: 'project', name: 'Redding Solar Farm', where: '1 Solar Way, Redding, CA', located: true, hint: '' },
    { id: 'project-bar', kind: 'project', name: 'Barstow Lot', where: '', located: false, hint: 'No address on file yet' },
    { id: 'site-irv', kind: 'site', name: 'Irvine Yard', where: '', located: true, hint: '' },
  ];
  const groups = [{ id: 'g1', name: 'Yard Crew', workSiteName: 'Irvine Yard', members: ['amy@x.com'] }];

  it('saves the jobsite picked, warns about one with no address, and adds a new one in place', async () => {
    const onSave = vi.fn();
    createJobsite.mockReset().mockResolvedValue({ id: 'project-fre', kind: 'project', name: 'Fresno Warehouse', where: '1450 Oak St, Fresno, CA', located: true, hint: '' });
    render(<ShiftPanel cell={{ email: 'amy@x.com', date: '2026-10-20', groupId: 'g1' }} presets={[]} groups={groups} people={[]} jobsites={JOBSITES} nameOf={(e) => e}
      onSave={onSave} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);
    const pick = screen.getByLabelText('Jobsite');
    expect(pick.value).toBe('');
    expect(pick.options[0].textContent).toBe('None');
    expect([...pick.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Construction Projects', 'Company Locations']);
    fireEvent.change(pick, { target: { value: 'project-bar' } });
    expect(document.querySelector('[data-jobsite-hint]').textContent).toContain("Barstow Lot has no address on file yet, so this shift uses the team site's weather.");
    fireEvent.change(pick, { target: { value: '__new' } });
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '07:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '15:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Jobsite/ }));
    expect(screen.getByRole('alert').textContent).toBe('Give the jobsite a name and paste its Google Maps link.');
    expect(createJobsite).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Jobsite name'), { target: { value: 'Fresno Warehouse' } });
    fireEvent.change(screen.getByLabelText('Jobsite address'), { target: { value: '1450 Oak St, Fresno, CA' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Jobsite/ }));
    await waitFor(() => expect(screen.getByLabelText('Jobsite').value).toBe('project-fre'));
    expect(createJobsite).toHaveBeenCalledWith({ name: 'Fresno Warehouse', address: '1450 Oak St, Fresno, CA' });
    expect(screen.queryByRole('group', { name: 'New Jobsite' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ jobsite: 'project-fre', group_id: 'g1' }));
  });

  it('places a new jobsite from its Google Maps link, at the exact point', async () => {
    createJobsite.mockReset().mockResolvedValue({ id: 'project-tem', kind: 'project', name: 'GS Temecula', where: '41715 Enterprise Cir N, Temecula, CA 92590', located: true, hint: '' });
    resolveJobsiteLink.mockReset().mockResolvedValue({ lat: 33.517652, lng: -117.155831, precision: 'place', address: '41715 Enterprise Cir N, Temecula, CA 92590', placeName: 'GS Temecula' });
    render(<ShiftPanel cell={{ email: 'amy@x.com', date: '2026-10-20', groupId: 'g1' }} presets={[]} groups={groups} people={[]} jobsites={JOBSITES} nameOf={(e) => e}
      onSave={noop} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);
    fireEvent.change(screen.getByLabelText('Jobsite'), { target: { value: '__new' } });
    fireEvent.change(screen.getByLabelText('Google Maps link or coordinates'), { target: { value: 'https://maps.app.goo.gl/abc' } });
    fireEvent.click(screen.getByRole('button', { name: /Use Link/ }));
    await waitFor(() => expect(screen.getByLabelText('Jobsite address').value).toBe('41715 Enterprise Cir N, Temecula, CA 92590'));
    expect(resolveJobsiteLink).toHaveBeenCalledWith('https://maps.app.goo.gl/abc');
    expect(screen.getByLabelText('Jobsite name').value).toBe('GS Temecula');
    fireEvent.click(screen.getByRole('button', { name: /Add Jobsite/ }));
    await waitFor(() => expect(screen.getByLabelText('Jobsite').value).toBe('project-tem'));
    expect(createJobsite).toHaveBeenCalledWith({ name: 'GS Temecula', address: '41715 Enterprise Cir N, Temecula, CA 92590', latitude: 33.517652, longitude: -117.155831 });
  });

  it('opens on the shift\'s own jobsite', () => {
    render(<ShiftPanel cell={{ email: 'amy@x.com', date: '2026-10-20', existing: { ...existing, jobsite: 'project-red' } }} presets={[]} groups={groups} people={[]} jobsites={JOBSITES}
      nameOf={(e) => e} onSave={noop} onAssign={noop} onDelete={noop} onDiscard={noop} onSaveTimeOff={noop} onClose={noop} />);
    expect(screen.getByLabelText('Jobsite').value).toBe('project-red');
    expect(screen.getByText('1 Solar Way, Redding, CA')).toBeTruthy();
  });
});
