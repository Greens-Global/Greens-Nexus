// The Job, Connected (Neil, 11/03/2026, plan phase 2): the Job page's tabs
// (by job type, in the URL), its Overview, the punch list's two steps and
// per-person filter, the Schedule tab drawing the Tasks timeline, Start Job on
// a ticket, and a property's Jobs panel. The rules live on the server
// (backend/test_construction_jobs_*.py); these pin what the screens do.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../api', () => ({ api: {
  getJobConnected: vi.fn(), getJobSchedule: vi.fn(), setPunchDone: vi.fn(), setPunchVerified: vi.fn(),
  addPunchItem: vi.fn(), makeJobTaskProject: vi.fn(), getJobLabor: vi.fn(), getJobPhotos: vi.fn(),
  getJobForms: vi.fn(), getJobEquipment: vi.fn(), linkJobEquipment: vi.fn(), endJobEquipment: vi.fn(),
  getTicketJobs: vi.fn(), startJobFromTicket: vi.fn(), getPropertyJobs: vi.fn(), getTaskPortfolios: vi.fn(),
  getConstructionMeta: vi.fn(), getConstructionWeather: vi.fn(), weather: vi.fn(), getConstructionRegister: vi.fn(),
  getPeopleDirectory: vi.fn(), getTicketProperties: vi.fn(),
} }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'ana.lopez@greensglobal.com' }) }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), alert: vi.fn() } }));
// The Schedule tab's Tasks store and timeline: the real ones load the whole
// workspace; here the store is empty (the server's read stands in) and the
// timeline says what it was given.
vi.mock('../../tasks/TasksContext', () => ({
  TasksProvider: ({ children }) => children,
  useTasks: () => ({ tasks: [], nameOf: (e) => e, taskById: new Map() }),
}));
vi.mock('../../tasks/views/more', () => ({
  TimelineView: ({ tasks }) => <div data-testid="timeline">{tasks.map((t) => t.title).join(', ')}</div>,
}));
vi.mock('../../tasks/TaskDetailDrawer', () => ({ default: () => null }));

const { api } = await import('../../api');
const { dialog } = await import('../../ui/dialog');
const { default: JobPage } = await import('./JobPage');
const { default: PunchTab } = await import('./PunchTab');
const { default: ScheduleTab } = await import('./ScheduleTab');
const { default: TicketJobAction } = await import('../../tickets/TicketJobAction');
const { default: PropertyJobs } = await import('../../components/PropertyJobs');
const { jobTabs, tabFor, punchState } = await import('../lib/job');
const { parseConstructionSub, projectSub } = await import('../lib/navigation');

const ANA = 'ana.lopez@greensglobal.com';
const SAM = 'sam.lee@greensglobal.com';
const base = {
  id: 'j1', name: 'Gate Motor Repair', jobType: 'work_order', status: 'active', percentComplete: 20,
  address: '12 Gate Rd', canEdit: true, today: '2026-11-03', workerEmails: [ANA, SAM], managerEmails: [],
  executiveEmails: [], names: { [ANA]: 'Ana Lopez', [SAM]: 'Sam Lee' },
  health: { state: 'on_track', reasons: [], nextMilestone: null, overdueRfis: 0, lastLogDate: '', daysSinceLog: null, daysPastTarget: 0 },
};
const view = (over = {}) => ({
  taskProject: { id: 'tp1', name: 'Gate Motor Repair', portfolioId: '' },
  punchSectionId: 'sec-p', verifiedStatusId: 'st-v', today: '2026-11-03', canEdit: true, canLog: true,
  lookAheadIds: ['t1'], milestoneIds: ['m1'], punch: { open: 1, done: 1, verified: 1, total: 3 },
  sections: [{ id: 'sec-p', name: 'Punch' }, { id: 'sec-c', name: 'Closeout' }],
  tasks: [
    { id: 't1', title: 'Make the repair', sectionId: 'sec-r', startOn: '2026-11-03', dueOn: '2026-11-04', completed: false, assigneeIds: [ANA] },
    { id: 'm1', title: 'Repair Verified', sectionId: 'sec-v', isMilestone: true, dueOn: '2026-11-05', completed: false },
    { id: 'p1', title: 'Touch up paint', sectionId: 'sec-p', completed: false, assigneeIds: [ANA], assigneeNames: { [ANA]: 'Ana Lopez' } },
    { id: 'p2', title: 'Caulk window', sectionId: 'sec-p', completed: true, status: 'completed', assigneeIds: [SAM], assigneeNames: { [SAM]: 'Sam Lee' } },
    { id: 'p3', title: 'Fix latch', sectionId: 'sec-p', completed: true, status: 'st-v', assigneeIds: [SAM] },
  ],
  ...over,
});

beforeEach(() => {
  api.getConstructionMeta.mockResolvedValue({ aiEnabled: false, tags: [] });
  api.getConstructionWeather.mockResolvedValue({ sites: [] });
  api.getPeopleDirectory.mockResolvedValue([]);
  api.getConstructionRegister.mockResolvedValue([]);
  api.getJobSchedule.mockResolvedValue(view());
  api.getTaskPortfolios.mockResolvedValue([]);
  api.getJobConnected.mockResolvedValue({
    needsYou: { logsToReview: 0, rfisToAnswer: 2, submittalsToDecide: 0, myPunch: 1 },
    punch: { open: 1, done: 1, verified: 1 }, nextMilestones: [],
    lastLog: { id: 'l1', logDate: '2026-11-02', status: 'approved', authorName: 'Ana Lopez', crewSize: 3, hoursWorked: 24 },
    crew: { people: [{ email: ANA, name: 'Ana Lopez', days: ['2026-11-03', '2026-11-04'], plannedHours: 16 }] },
    tickets: [{ id: 'tk1', code: 'TK-12', subject: 'Gate will not open', status: 'in_progress', requesterEmail: SAM, photos: [] }],
    property: { id: 'prop-1', name: 'Escondido Yard', address: '1 Main St', city: 'Escondido', state: 'CA' },
    names: {},
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Job tabs and the URL', () => {
  it('a work order shows Overview, Tasks, Field and Closeout; a project every tab', () => {
    expect(jobTabs('work_order').map((t) => t.label)).toEqual(['Overview', 'Tasks', 'Field', 'Closeout']);
    expect(jobTabs('project').map((t) => t.key)).toEqual(['overview', 'schedule', 'punch', 'field', 'rfis', 'closeout']);
    expect(tabFor('work_order', 'schedule')).toBe('overview');
    expect(tabFor('project', 'rfis')).toBe('rfis');
  });

  it('the tab rides in the URL: project:<id>:<tab>', () => {
    expect(parseConstructionSub('project:j1:punch')).toEqual({ tab: 'construction-dashboard', projectId: 'j1', jobTab: 'punch' });
    expect(parseConstructionSub('project:j1')).toEqual({ tab: 'construction-dashboard', projectId: 'j1' });
    expect(parseConstructionSub('project:j1:bogus').jobTab).toBeUndefined();
    expect(projectSub('j1', 'rfis')).toBe('project:j1:rfis');
    expect(projectSub('j1', 'overview')).toBe('project:j1');
  });

  it('the page draws the work order tabs and a click asks for the tab', async () => {
    const onTab = vi.fn();
    render(<JobPage project={base} tab="overview" onTab={onTab} onBack={() => {}} />);
    const labels = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(labels).toEqual(['Overview', 'Tasks', 'Field', 'Closeout']);
    fireEvent.click(screen.getByRole('tab', { name: 'Field' }));
    expect(onTab).toHaveBeenCalledWith('field');
  });

  it('the Overview says what needs you, the crew, the source ticket and the property', async () => {
    const onTab = vi.fn();
    const { container } = render(<JobPage project={base} tab="overview" onTab={onTab} onBack={() => {}} />);
    expect(await screen.findByText(/2 RFIs to answer/)).toBeInTheDocument();
    expect(screen.getByText(/1 punch item assigned to you/)).toBeInTheDocument();
    expect(container.querySelector('[data-job-card="crew"]').textContent).toContain('Ana Lopez');
    expect(container.querySelector('[data-job-card="crew"]').textContent).toContain('2 days · 16 h');
    expect(container.querySelector('[data-job-card="tickets"]').textContent).toContain('TK-12');
    expect(container.querySelector('[data-job-card="tickets"]').textContent).toContain('Requested by Sam Lee');
    expect(container.querySelector('[data-job-card="property"]').textContent).toContain('Escondido Yard');
    expect(container.querySelector('[data-job-card="log"]').textContent).toContain('11/02/2026');
    // A work order has no milestones card.
    expect(container.querySelector('[data-job-card="milestones"]')).toBeNull();
    fireEvent.click(screen.getByText(/2 RFIs to answer/));
    expect(onTab).toHaveBeenCalledWith('rfis');
  });
});

describe('Punch list', () => {
  it('reads each item\'s state: Open, Done, Verified', () => {
    const v = view();
    expect(v.tasks.filter((t) => t.sectionId === 'sec-p').map((t) => punchState(t, v.verifiedStatusId))).toEqual(['open', 'done', 'verified']);
  });

  it('the crew marks Done, a reviewer Verifies, and the list narrows to one person', async () => {
    api.setPunchDone.mockResolvedValue({});
    api.setPunchVerified.mockResolvedValue({});
    const { container } = render(<PunchTab project={base} />);
    await waitFor(() => expect(container.querySelector('[data-punch-row="p1"]')).toBeTruthy());
    // A work order also lists its steps above the punch list.
    expect(screen.getByText('Work Steps')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-punch-row="p1"]').querySelector('button'));
    await waitFor(() => expect(api.setPunchDone).toHaveBeenCalledWith('p1', true));
    const verify = [...container.querySelector('[data-punch-row="p2"]').querySelectorAll('button')].find((b) => b.textContent === 'Verify');
    fireEvent.click(verify);
    await waitFor(() => expect(api.setPunchVerified).toHaveBeenCalledWith('p2', true));
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: SAM } });
    expect(container.querySelector('[data-punch-row="p1"]')).toBeNull();
    expect(container.querySelector('[data-punch-row="p2"]')).toBeTruthy();
  });

  it('adds an item with an id made on the phone', async () => {
    api.addPunchItem.mockResolvedValue({});
    render(<PunchTab project={{ ...base, jobType: 'project' }} />);
    fireEvent.change(await screen.findByLabelText('What needs fixing'), { target: { value: 'Scuffed door' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    await waitFor(() => expect(api.addPunchItem).toHaveBeenCalled());
    const [jobId, body] = api.addPunchItem.mock.calls[0];
    expect(jobId).toBe('j1');
    expect(body.title).toBe('Scuffed door');
    expect(body.id).toMatch(/^punch-/);
  });

  it('a job with no schedule offers to set it up', async () => {
    api.getJobSchedule.mockResolvedValue({ taskProject: null, tasks: [], canStamp: true });
    api.makeJobTaskProject.mockResolvedValue({});
    render(<PunchTab project={base} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set Up Schedule' }));
    await waitFor(() => expect(api.makeJobTaskProject).toHaveBeenCalledWith('j1'));
  });
});

describe('Schedule', () => {
  it('draws the Tasks timeline, the two-week look-ahead and the milestones', async () => {
    const { container } = render(<ScheduleTab project={{ ...base, jobType: 'project' }} />);
    expect(await screen.findByTestId('timeline')).toHaveTextContent('Make the repair');
    expect(container.querySelector('[data-lookahead="t1"]')).toBeTruthy();
    expect(container.querySelector('[data-milestone="m1"]').textContent).toContain('11/05/2026');
    expect(screen.getByLabelText('Portfolio')).toBeInTheDocument();
  });
});

describe('Start Job on a ticket', () => {
  it('a manager starts a Work Order job from the ticket and lands on it', async () => {
    api.getTicketJobs.mockResolvedValue({ jobs: [], canStart: true });
    api.startJobFromTicket.mockResolvedValue({ job: { id: 'j9' }, created: true });
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    render(<TicketJobAction ticketId="tk1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Start Job/ }));
    await waitFor(() => expect(api.startJobFromTicket).toHaveBeenCalledWith('tk1', {}));
    expect(dialog.confirm).toHaveBeenCalled();
    await waitFor(() => expect(seen).toEqual([{ view: 'ops', sub: 'project:j9' }]));
    window.removeEventListener('nexus:navigate', on);
  });

  it('a ticket with a job offers Open Job; someone who cannot start one sees nothing', async () => {
    api.getTicketJobs.mockResolvedValueOnce({ jobs: [{ id: 'j1', name: 'Gate Motor Repair' }], canStart: true });
    render(<TicketJobAction ticketId="tk1" />);
    expect(await screen.findByRole('button', { name: /Open Job/ })).toBeInTheDocument();
    cleanup();
    api.getTicketJobs.mockResolvedValueOnce({ jobs: [], canStart: false });
    const { container } = render(<TicketJobAction ticketId="tk2" />);
    await waitFor(() => expect(api.getTicketJobs).toHaveBeenCalledWith('tk2'));
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('A property\'s Jobs', () => {
  it('lists the open jobs with their health and the recent ones', async () => {
    api.getPropertyJobs.mockResolvedValue({
      open: [{ id: 'j1', name: 'Gate Motor Repair', jobType: 'work_order', health: { state: 'late' } }],
      recent: [{ id: 'j0', name: 'Old Fence', jobType: 'project', status: 'complete' }],
    });
    const { container } = render(<PropertyJobs property={{ id: 'prop-1' }} />);
    await waitFor(() => expect(container.querySelector('[data-property-job="j1"]')).toBeTruthy());
    expect(container.querySelector('[data-property-job="j1"]').textContent).toContain('Late');
    expect(container.querySelector('[data-property-job="j0"]').textContent).toContain('Complete');
  });

  it('a property the reader may not see shows nothing', async () => {
    api.getPropertyJobs.mockRejectedValue(new Error('Property not found'));
    const { container } = render(<PropertyJobs property={{ id: 'prop-private' }} />);
    await waitFor(() => expect(container.querySelector('[data-property-jobs]')).toBeNull());
  });
});
