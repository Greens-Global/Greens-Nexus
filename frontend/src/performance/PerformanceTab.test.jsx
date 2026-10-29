import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Workday > Performance and People > Performance, made simple (Oct 29 2026):
// the employee page paints My Numbers, My Goals (computed status, Measured
// by Nexus, Proposed) and 1:1s; a manager's My Team lists direct reports
// with their numbers and opens one on the same page; HR's New Review Cycle is
// three fields; a phone gets one column with no sideways scroll.

const m = {
  perfMe: vi.fn(), perfGoals: vi.fn(), perfOneOnOnes: vi.fn(), perfTeam: vi.fn(), perfOneOnOne: vi.fn(),
  perfGoal: vi.fn(), getPeopleDirectory: vi.fn(), perfScorecard: vi.fn(), perfReviews: vi.fn(), perfCycles: vi.fn(),
  perfCycleCreate: vi.fn(), perfCycle: vi.fn(), perfGoalApprove: vi.fn(),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set(), canAccessModule: () => false }) }));

const PerformanceTab = (await import('./PerformanceTab')).default;
const PerformanceAdmin = (await import('./PerformanceAdmin')).default;

const METRICS = [
  { key: 'on_time', label: 'On-Time Arrival', unit: '%', good: 'high', kind: 'rate', description: 'Shifts started on time' },
  { key: 'tasks_done', label: 'Tasks Completed', unit: '', good: 'high', kind: 'count', description: 'Tasks finished' },
];
const CTX = {
  email: 'erin@greensglobal.com', name: 'Erin Test', company: 'co', department: 'Ops',
  manager: { email: 'max@greensglobal.com', name: 'Max Test' }, reports: [], team: [], hasTeam: false,
  isHr: false, hrCompanies: [], settings: { checkinEveryDays: 14, oneOnOneReminder: true }, metrics: METRICS, maxGoals: 5,
};
const GOAL = {
  id: 'g1', level: 'personal', ownerEmail: 'erin@greensglobal.com', ownerName: 'Erin Test', title: 'Close 40 tickets',
  measure: 'number', currentValue: 12, targetValue: 40, startValue: 0, unit: 'tickets', status: 'at_risk', progress: 30,
  dueOn: '2026-12-31', canEdit: true, department: 'Ops', measuredByNexus: false, proposed: false,
};
const NEXUS_GOAL = {
  ...GOAL, id: 'g2', title: '95% on time', measuredByNexus: true, metricKey: 'on_time', metricLabel: 'On-Time Arrival',
  metricGood: 'high', unit: '%', currentValue: 92, targetValue: 95, status: 'at_risk', progress: 97, proposed: true,
};
const CARD = {
  period: { start: '2026-10-01', end: '2026-10-29', readTo: '2026-10-29' },
  metrics: [
    { key: 'on_time', label: 'On-Time Arrival', display: '92%', detail: '23 of 25 shifts on time', available: true },
    { key: 'hours', label: 'Hours vs Expected', display: '', available: false },
    { key: 'tasks_done', label: 'Tasks Completed', display: '7', detail: '7 finished', available: true },
  ],
};
const SERIES = {
  id: 's1', withName: 'Max Test', cadenceLabel: 'Weekly', status: 'active', current: true, teamsMeeting: true, side: 'report',
  managerEmail: 'max@greensglobal.com', managerName: 'Max Test', reportEmail: 'erin@greensglobal.com', reportName: 'Erin Test',
  next: { id: 'm1', at: '2099-11-02T18:00:00Z', label: '11/02/2099 at 10:00 AM' }, joinUrl: 'https://teams/x',
};

const realMatch = window.matchMedia;
function phone(on) {
  window.matchMedia = (q) => ({ matches: on && /max-width/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.getPeopleDirectory.mockResolvedValue([]);
  m.perfScorecard.mockResolvedValue(CARD);
  m.perfReviews.mockResolvedValue({ mine: [], team: [] });
  phone(false);
});
afterEach(() => { window.matchMedia = realMatch; });

describe('Workday > Performance', () => {
  it('shows my numbers, my goals and my 1:1s', async () => {
    m.perfMe.mockResolvedValue(CTX);
    m.perfGoals.mockResolvedValue([GOAL, NEXUS_GOAL]);
    m.perfOneOnOnes.mockResolvedValue([SERIES]);
    render(<PerformanceTab />);
    expect(await screen.findByText('92%')).toBeTruthy();
    expect(screen.getByText('On-Time Arrival')).toBeTruthy();
    expect(screen.queryByText('Hours vs Expected')).toBeNull();          // does not apply: hidden
    expect(await screen.findByText('Close 40 tickets')).toBeTruthy();
    expect(screen.getByText('12 of 40 tickets')).toBeTruthy();
    expect(screen.getByText(/Measured by Nexus: On-Time Arrival/)).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('92% of 95%')).toBeTruthy();
    expect(await screen.findByText('With Max Test')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'My Team' })).toBeNull();
    // The period switch asks the server for that period.
    fireEvent.click(screen.getByRole('tab', { name: 'This Month' }));
    await waitFor(() => expect(m.perfScorecard).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'month' })));
  });

  it('paints the empty states', async () => {
    m.perfMe.mockResolvedValue(CTX);
    m.perfGoals.mockResolvedValue([]);
    m.perfOneOnOnes.mockResolvedValue([]);
    m.perfScorecard.mockResolvedValue({ ...CARD, metrics: [] });
    render(<PerformanceTab />);
    expect(await screen.findByText(/No goals yet/)).toBeTruthy();
    expect(await screen.findByText(/No numbers yet/)).toBeTruthy();
    expect(await screen.findByText(/Max Test sets them up/)).toBeTruthy();
  });

  it('a manager sees direct reports with their numbers and opens one on the same page', async () => {
    m.perfMe.mockResolvedValue({ ...CTX, hasTeam: true, reports: [{ email: 'pat@x.com', name: 'Pat Test' }] });
    m.perfGoals.mockResolvedValue([]);
    m.perfOneOnOnes.mockResolvedValue([]);
    m.perfTeam.mockResolvedValue([{ email: 'pat@x.com', name: 'Pat Test', title: 'Analyst', direct: true,
      numbers: [{ key: 'on_time', label: 'On-Time Arrival', display: '88%' }],
      goals: { total: 2, onTrack: 1, atRisk: 0, behind: 1, done: 0, proposed: 1, progress: 40 },
      review: { id: 'r1', stage: 'manager_review' }, nextOneOnOne: null }]);
    render(<PerformanceTab />);
    fireEvent.click(await screen.findByRole('tab', { name: 'My Team' }));
    const table = await screen.findByRole('table', { name: 'My Team' });
    expect(within(table).getByText('Pat Test')).toBeTruthy();
    expect(within(table).getByText('88%')).toBeTruthy();
    expect(within(table).getByText('1 Behind')).toBeTruthy();
    expect(within(table).getByText('1 to Approve')).toBeTruthy();
    expect(within(table).getByText('Manager Review')).toBeTruthy();
    m.perfGoals.mockResolvedValue([{ ...NEXUS_GOAL, ownerEmail: 'pat@x.com', ownerName: 'Pat Test', canApprove: true }]);
    fireEvent.click(within(table).getByText('Pat Test'));
    expect(await screen.findByText("Pat's Numbers")).toBeTruthy();
    await waitFor(() => expect(m.perfGoals).toHaveBeenCalledWith('person', { person: 'pat@x.com' }));
    await waitFor(() => expect(m.perfScorecard).toHaveBeenCalledWith(expect.objectContaining({ email: 'pat@x.com' })));
    m.perfGoalApprove.mockResolvedValue({});
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(m.perfGoalApprove).toHaveBeenCalledWith('g2'));
    expect(screen.getByText('Add Goal for Them')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /My Team/ }));
    expect(await screen.findByRole('table', { name: 'My Team' })).toBeTruthy();
  });

  it('opens a 1:1 from a bell link, without private notes for the report', async () => {
    m.perfMe.mockResolvedValue(CTX);
    m.perfGoals.mockResolvedValue([]);
    m.perfOneOnOnes.mockResolvedValue([SERIES]);
    m.perfOneOnOne.mockResolvedValue({ ...SERIES, meetings: [{ id: 'm1', at: '2099-11-02T18:00:00Z', label: '11/02/2099 at 10:00 AM',
      status: 'scheduled', sharedNotes: '', agenda: [{ id: 'a1', text: 'Promotion path', byName: 'Erin Test', done: false, mine: true }], actions: [] }] });
    render(<PerformanceTab focus={{ sub: 'performance:1on1:s1' }} />);
    expect(await screen.findByText('Promotion path')).toBeTruthy();
    expect(screen.queryByText(/Private Notes/)).toBeNull();
    await waitFor(() => expect(m.perfOneOnOne).toHaveBeenCalledWith('s1'));
  });

  it('on a phone it is one column: goal cards and the team as rows, no header row', async () => {
    phone(true);
    m.perfMe.mockResolvedValue({ ...CTX, hasTeam: true, reports: [{ email: 'pat@x.com', name: 'Pat Test' }] });
    m.perfGoals.mockResolvedValue([GOAL]);
    m.perfOneOnOnes.mockResolvedValue([]);
    m.perfTeam.mockResolvedValue([{ email: 'pat@x.com', name: 'Pat Test', direct: true, numbers: [],
      goals: { total: 0 }, review: null, nextOneOnOne: null }]);
    render(<PerformanceTab />);
    expect(await screen.findByText('Close 40 tickets')).toBeTruthy();
    fireEvent.click(await screen.findByRole('tab', { name: 'My Team' }));
    const table = await screen.findByRole('table', { name: 'My Team' });
    expect(within(table).queryByRole('columnheader')).toBeNull();
    expect(within(table).getByText('No numbers yet')).toBeTruthy();
  });
});

describe('People > Performance', () => {
  it('tells a non-HR person where their own goals are', async () => {
    m.perfMe.mockResolvedValue(CTX);
    render(<PerformanceAdmin />);
    expect(await screen.findByText(/for HR/)).toBeTruthy();
  });

  it('lists the goals, Behind first, and starts a review with three fields', async () => {
    m.perfMe.mockResolvedValue({ ...CTX, isHr: true, hrCompanies: [{ id: 'co', name: 'Perf Co' }] });
    m.perfGoals.mockResolvedValue([{ ...GOAL, id: 'c1', level: 'company', title: 'Grow 10%', status: 'on_track' },
      { ...GOAL, id: 'p1', title: 'Fine one', status: 'on_track' }, { ...GOAL, id: 'p2', title: 'Late one', status: 'behind' }]);
    m.perfCycles.mockResolvedValue([]);
    render(<PerformanceAdmin />);
    expect(await screen.findByText('Grow 10%')).toBeTruthy();
    const everyone = screen.getByRole('region', { name: "Everyone's Goals" });
    const titles = within(everyone).getAllByText(/one$/).map(n => n.textContent);
    expect(titles).toEqual(['Late one', 'Fine one']);
    fireEvent.click(screen.getByText('New Review Cycle'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Name')).toBeTruthy();
    expect(within(dialog).getByText('Due Date')).toBeTruthy();
    expect(within(dialog).queryByText('Questions')).toBeNull();
    expect(within(dialog).queryByText('Departments')).toBeNull();
    expect(within(dialog).getByText(/past probation/)).toBeTruthy();
    m.perfCycleCreate.mockResolvedValue({ id: 'c9', counts: { total: 6 } });
    m.perfCycle.mockResolvedValue({ id: 'c9', name: '2026 Year-End Review', status: 'active', counts: { total: 6 }, reviews: [] });
    fireEvent.click(within(dialog).getByText('Start Review'));
    expect(await within(dialog).findByText('Pick the due date.')).toBeTruthy();
    expect(m.perfCycleCreate).not.toHaveBeenCalled();
  });
});
