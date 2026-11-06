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
  // Field and Closeout (phase 3): the punch writes the outbox sends, the reads it saves.
  setPunchDoneWithPhoto: vi.fn(), setPunchVerifiedQueued: vi.fn(), addPunchItemQueued: vi.fn(),
  getJobTimeline: vi.fn(), getLogPrefill: vi.fn(), getJobChanges: vi.fn(), getConstructionLogs: vi.fn(),
  // Meetings and Safety (Round Two item 10).
  newJobMeeting: vi.fn(),
} }));
vi.mock('../lib/upload', () => ({
  uploadConstructionMedia: vi.fn(async () => ({ payload: { kind: 'photo', url: 'https://x/construction-media/construction/j1/done.jpg', mime_type: 'image/jpeg', size_bytes: 9 }, error: null })),
  validate: () => '', kindOf: () => 'photo', filesFromPaste: () => [], MAX_BYTES: {}, BUCKET: 'construction-media',
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'ana.lopez@greensglobal.com' }) }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), alert: vi.fn(), undo: vi.fn() } }));
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
    expect(jobTabs('work_order').map((t) => t.label)).toEqual(['Overview', 'Tasks', 'Field', 'Photos', 'Changes', 'Closeout']);
    expect(jobTabs('project').map((t) => t.key)).toEqual(['overview', 'schedule', 'punch', 'field', 'photos', 'rfis', 'drawings', 'permits', 'subs', 'changes', 'closeout']);
    expect(tabFor('work_order', 'permits')).toBe('overview');
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
    expect(labels).toEqual(['Overview', 'Tasks', 'Field', 'Photos', 'Changes', 'Closeout']);
    fireEvent.click(screen.getByRole('tab', { name: 'Field' }));
    expect(onTab).toHaveBeenCalledWith('field');
  });

  it('the Overview says what needs you, the crew, the source ticket and the property', async () => {
    const onTab = vi.fn();
    const { container } = render(<JobPage project={base} tab="overview" onTab={onTab} onBack={() => {}} />);
    expect(await screen.findByText(/2 RFIs to answer/)).toBeInTheDocument();
    expect(screen.getByText(/1 punch item assigned to you/)).toBeInTheDocument();
    expect(container.querySelector('[data-job-card="crew"]').textContent).toContain('Ana Lopez');
    expect(container.querySelector('[data-job-card="crew"]').textContent).toContain('2 days · 16h');
    expect(container.querySelector('[data-job-card="tickets"]').textContent).toContain('TK-12');
    expect(container.querySelector('[data-job-card="tickets"]').textContent).toContain('Requested by Sam Lee');
    expect(container.querySelector('[data-job-card="property"]').textContent).toContain('Escondido Yard');
    expect(container.querySelector('[data-job-card="log"]').textContent).toContain('11/02/2026');
    // A work order has no milestones card.
    expect(container.querySelector('[data-job-card="milestones"]')).toBeNull();
    fireEvent.click(screen.getByText(/2 RFIs to answer/));
    expect(onTab).toHaveBeenCalledWith('rfis');
  });

  it('the Meetings card lists the job meeting notes and New Meeting opens a new one; the Safety card says the three facts', async () => {
    api.getJobConnected.mockResolvedValue({
      needsYou: {}, punch: {}, crew: { people: [] }, tickets: [], names: {},
      meetings: [{ id: 'note_1', title: 'Gate Motor Repair Meeting 11/03/2026', day: '2026-11-03' }],
      safety: { lastToolboxTalk: '2026-11-02', daysSinceIncident: 12, openSafetyTags: 2,
        toolboxFormId: 'form-toolbox-talk', incidentFormId: 'form-near-miss-incident' },
    });
    api.newJobMeeting.mockResolvedValue({ id: 'note_2' });
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    const { container } = render(<JobPage project={base} tab="overview" onTab={() => {}} onBack={() => {}} />);
    await screen.findByText('Gate Motor Repair Meeting 11/03/2026');
    const safety = container.querySelector('[data-job-card="safety"]').textContent;
    expect(safety).toContain('11/02/2026');
    expect(safety).toContain('12');
    expect(safety).toContain('Open Safety Tags on Logs2');
    fireEvent.click(screen.getByText('Gate Motor Repair Meeting 11/03/2026'));
    expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'dashboard', sub: 'notes:note_1' });
    fireEvent.click(screen.getByText('New Meeting'));
    await waitFor(() => expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'dashboard', sub: 'notes:note_2' }));
    expect(api.newJobMeeting).toHaveBeenCalledWith('j1');
    window.removeEventListener('nexus:navigate', nav);
  });

  it('with nothing recorded the Safety card says so', async () => {
    api.getJobConnected.mockResolvedValue({
      needsYou: {}, punch: {}, crew: { people: [] }, tickets: [], names: {}, meetings: [],
      safety: { lastToolboxTalk: '', daysSinceIncident: null, openSafetyTags: 0, toolboxFormId: 'a', incidentFormId: 'b' },
    });
    const { container } = render(<JobPage project={base} tab="overview" onTab={() => {}} onBack={() => {}} />);
    await screen.findByText(/No meeting notes yet/);
    expect(container.querySelector('[data-job-card="safety"]').textContent.match(/None recorded/g)).toHaveLength(2);
  });
});

describe('Punch list', () => {
  it('reads each item\'s state: Open, Done, Verified', () => {
    const v = view();
    expect(v.tasks.filter((t) => t.sectionId === 'sec-p').map((t) => punchState(t, v.verifiedStatusId))).toEqual(['open', 'done', 'verified']);
  });

  it('the crew marks Done with a photo, a reviewer Verifies (with Undo), and the list narrows to one person', async () => {
    api.setPunchDoneWithPhoto.mockResolvedValue({});
    api.setPunchVerifiedQueued.mockResolvedValue({});
    const { container } = render(<PunchTab project={base} />);
    await waitFor(() => expect(container.querySelector('[data-punch-row="p1"]')).toBeTruthy());
    // A work order also lists its steps above the punch list.
    expect(screen.getByText('Work Steps')).toBeInTheDocument();
    const row = container.querySelector('[data-punch-row="p1"]');
    fireEvent.click([...row.querySelectorAll('button')].find((b) => /Mark Done/.test(b.textContent)));
    expect(api.setPunchDoneWithPhoto).not.toHaveBeenCalled();     // the camera opens first
    fireEvent.change(container.querySelector('input[data-done-photo="p1"]'), { target: { files: [new File(['x'], 'done.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(api.setPunchDoneWithPhoto).toHaveBeenCalledWith('p1', true,
      expect.objectContaining({ url: expect.stringContaining('done.jpg') }), { headers: { 'Idempotency-Key': expect.any(String) } }));
    const verify = [...container.querySelector('[data-punch-row="p2"]').querySelectorAll('button')].find((b) => b.textContent === 'Verify');
    fireEvent.click(verify);
    await waitFor(() => expect(api.setPunchVerifiedQueued).toHaveBeenCalledWith('p2', true, expect.anything()));
    await waitFor(() => expect(dialog.undo).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(container.querySelector('[data-punch-row="p2"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    fireEvent.change(screen.getByLabelText('Show one person'), { target: { value: SAM } });
    expect(container.querySelector('[data-punch-row="p1"]')).toBeNull();
    expect(container.querySelector('[data-punch-row="p2"]')).toBeTruthy();
  });

  it('adds an item with an id made on the phone', async () => {
    api.addPunchItemQueued.mockResolvedValue({});
    render(<PunchTab project={{ ...base, jobType: 'project' }} />);
    fireEvent.change(await screen.findByLabelText('What needs fixing'), { target: { value: 'Scuffed door' } });
    fireEvent.change(screen.getByLabelText('Where on the site'), { target: { value: 'Unit 4' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    await waitFor(() => expect(api.addPunchItemQueued).toHaveBeenCalled());
    const [jobId, body, opts] = api.addPunchItemQueued.mock.calls[0];
    expect(jobId).toBe('j1');
    expect(body.title).toBe('Scuffed door');
    expect(body.location_text).toBe('Unit 4');
    expect(body.id).toMatch(/^punch-/);
    // ONE mechanism: the record's phone-made id is the Idempotency-Key.
    expect(opts.headers['Idempotency-Key']).toBe(body.id);
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
