import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Workday > Performance and People > Performance (Oct 27
// 2026): each paints with data and without, the team view appears only for
// someone with a team, a 1:1 opens from its row, and the report's view of a
// 1:1 has no private-notes box.

const m = {
  perfMe: vi.fn(), perfGoals: vi.fn(), perfOneOnOnes: vi.fn(), perfTeam: vi.fn(), perfOneOnOne: vi.fn(),
  perfGoal: vi.fn(), getPeopleDirectory: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }) }));

const PerformanceTab = (await import('./PerformanceTab')).default;
const PerformanceAdmin = (await import('./PerformanceAdmin')).default;

const CTX = {
  email: 'erin@greensglobal.com', name: 'Erin Test', company: 'co', department: 'Ops',
  manager: { email: 'max@greensglobal.com', name: 'Max Test' }, reports: [], team: [], hasTeam: false,
  isHr: false, hrCompanies: [], settings: { checkinEveryDays: 14, oneOnOneReminder: true },
};
const GOAL = {
  id: 'g1', level: 'personal', ownerEmail: 'erin@greensglobal.com', ownerName: 'Erin Test', title: 'Close 40 tickets',
  measure: 'number', currentValue: 12, targetValue: 40, startValue: 0, unit: 'tickets', status: 'at_risk', progress: 30,
  dueOn: '2026-12-31', parentTitle: 'Grow 10%', canEdit: true, department: 'Ops',
};
const SERIES = {
  id: 's1', withName: 'Max Test', cadenceLabel: 'Weekly', status: 'active', teamsMeeting: true, side: 'report',
  managerEmail: 'max@greensglobal.com', managerName: 'Max Test', reportEmail: 'erin@greensglobal.com', reportName: 'Erin Test',
  next: { id: 'm1', at: '2099-11-02T18:00:00Z', label: '11/02/2099 at 10:00 AM' }, joinUrl: 'https://teams/x',
};

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.getPeopleDirectory.mockResolvedValue([]);
});

describe('PerformanceTab', () => {
  it('shows my goals and 1:1s, no team switch without a team', async () => {
    m.perfMe.mockResolvedValue(CTX);
    m.perfGoals.mockResolvedValue([GOAL]);
    m.perfOneOnOnes.mockResolvedValue([SERIES]);
    render(<PerformanceTab />);
    expect(await screen.findByText('Close 40 tickets')).toBeTruthy();
    expect(screen.getByText('12 of 40 tickets')).toBeTruthy();
    expect(screen.getByText('At Risk')).toBeTruthy();
    expect(await screen.findByText('With Max Test')).toBeTruthy();
    expect(screen.queryByText('My Team')).toBeNull();
    expect(screen.queryByText('Set Up a 1:1')).toBeNull();
  });

  it('paints the empty states', async () => {
    m.perfMe.mockResolvedValue(CTX);
    m.perfGoals.mockResolvedValue([]);
    m.perfOneOnOnes.mockResolvedValue([]);
    render(<PerformanceTab />);
    expect(await screen.findByText(/No goals yet/)).toBeTruthy();
    expect(await screen.findByText(/Max Test sets them up/)).toBeTruthy();
  });

  it('shows the team view to a manager', async () => {
    m.perfMe.mockResolvedValue({ ...CTX, hasTeam: true, reports: [{ email: 'pat@x.com', name: 'Pat Test' }], team: [{ email: 'pat@x.com', name: 'Pat Test' }] });
    m.perfGoals.mockResolvedValue([]);
    m.perfOneOnOnes.mockResolvedValue([]);
    m.perfTeam.mockResolvedValue([{ email: 'pat@x.com', name: 'Pat Test', title: 'Analyst', direct: true,
      goals: { total: 2, atRisk: 1, offTrack: 0, done: 0, progress: 40 }, nextOneOnOne: null }]);
    render(<PerformanceTab />);
    fireEvent.click(await screen.findByRole('tab', { name: 'My Team' }));
    expect(await screen.findByText('Pat Test')).toBeTruthy();
    expect(screen.getByText('2 Goals')).toBeTruthy();
    expect(screen.getByText('No 1:1 yet')).toBeTruthy();
  });

  it('opens a 1:1 from a bell link, without private notes for the report', async () => {
    m.perfMe.mockResolvedValue(CTX);
    m.perfGoals.mockResolvedValue([]);
    m.perfOneOnOnes.mockResolvedValue([SERIES]);
    m.perfOneOnOne.mockResolvedValue({ ...SERIES, meetings: [{ id: 'm1', at: '2099-11-02T18:00:00Z', label: '11/02/2099 at 10:00 AM',
      status: 'scheduled', sharedNotes: '', agenda: [{ id: 'a1', text: 'Promotion path', byName: 'Erin Test', done: false, mine: true }], actions: [] }] });
    render(<PerformanceTab focus="performance:1on1:s1" />);
    expect(await screen.findByText('Promotion path')).toBeTruthy();
    expect(screen.getByText('Shared Notes')).toBeTruthy();
    expect(screen.queryByText(/Private Notes/)).toBeNull();
    expect(screen.getByText('Join Teams Meeting')).toBeTruthy();
    await waitFor(() => expect(m.perfOneOnOne).toHaveBeenCalledWith('s1'));
  });
});

describe('PerformanceAdmin', () => {
  it('tells a non-HR person where their own goals are', async () => {
    m.perfMe.mockResolvedValue(CTX);
    render(<PerformanceAdmin />);
    expect(await screen.findByText(/for HR/)).toBeTruthy();
  });

  it('lists the company goals for HR', async () => {
    m.perfMe.mockResolvedValue({ ...CTX, isHr: true, hrCompanies: [{ id: 'co', name: 'Perf Co' }] });
    m.perfGoals.mockResolvedValue([{ ...GOAL, id: 'c1', level: 'company', title: 'Grow 10%', status: 'on_track' }, GOAL]);
    render(<PerformanceAdmin />);
    expect(await screen.findByText('Grow 10%')).toBeTruthy();
    expect(screen.getByText('Close 40 tickets')).toBeTruthy();
    expect(screen.getByText('Add Company Goal')).toBeTruthy();
    expect(m.perfGoals).toHaveBeenCalledWith('company', { company: 'co' });
  });
});
