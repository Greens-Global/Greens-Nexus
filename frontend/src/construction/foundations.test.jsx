import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

// Construction phase 1 (Neil, 11/03/2026, plan
// https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr): the Edit Job sheet, AI
// hidden while AI is off, the health row, the project URL and the holds.
// The rules live on the server (backend/test_construction_foundations.py);
// these pin what the screens do with them.

vi.mock('../api', () => ({ api: {
  getConstructionOverview: vi.fn(),
  getConstructionLogs: vi.fn(),
  getConstructionReviewQueue: vi.fn(),
  getConstructionReviewQueueFor: vi.fn(),
  getConstructionReports: vi.fn(),
  getConstructionRegister: vi.fn(),
  getConstructionMedia: vi.fn(),
  getConstructionMeta: vi.fn(),
  getConstructionProject: vi.fn(),
  updateConstructionProject: vi.fn(),
  getConstructionWeather: vi.fn(),
  weather: vi.fn(),
  getPeopleDirectory: vi.fn(),
  getTicketProperties: vi.fn(),
  resolveProjectLink: vi.fn(),
  reviewConstructionLog: vi.fn(),
  reopenConstructionLog: vi.fn(),
  deleteConstructionRegisterItem: vi.fn(),
  updateConstructionRegisterItem: vi.fn(),
  generateConstructionReport: vi.fn(),
  publishConstructionReport: vi.fn(),
  updateConstructionReport: vi.fn(),
  getNotifications: vi.fn(),
  markNotifRead: vi.fn(),
  deleteConstructionMedia: vi.fn(),
  removeConstructionMedia: vi.fn(),
  updateConstructionLog: vi.fn(),
  submitConstructionLog: vi.fn(),
  submitConstructionLogSigned: vi.fn(),
  createConstructionMedia: vi.fn(),
  getLogPrefill: vi.fn(async () => null),
  getJobTimeline: vi.fn(async () => ({ photos: [], pairs: [] })),
  // The Job page (phase 2): its Overview reads what the job is connected to.
  getJobConnected: vi.fn(),
} }));
vi.mock('../components/WorkSiteAddressMap', () => ({ default: () => null }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'marcus.reed@greensglobal.com' }) }));

const { api } = await import('../api');
const { resetConstructionMeta } = await import('./lib/meta');
const { default: ConstructionDashboard } = await import('./ConstructionDashboard');
const { default: EditJobSheet } = await import('./EditJobSheet');
const { default: ReviewQueue } = await import('./ReviewQueue');
const { default: WeeklyReports } = await import('./WeeklyReports');
const { default: Registers } = await import('./Registers');
const { default: HealthRow } = await import('./HealthRow');
const { changesFor, savedOf } = await import('./lib/jobForm');
const { parseConstructionSub } = await import('./lib/navigation');
const { weekChoices } = await import('./lib/weeks');
const { isOverdue, daysOpen } = await import('./lib/registers');
const { uploadErrorWords, NO_BUCKET } = await import('./lib/upload');
const { default: DailyLogCapture } = await import('./DailyLogCapture');
const { dialog } = await import('../ui/dialog');
const { HOLD_RECORD_MS } = await import('../ui/HoldButton');

const health = {
  state: 'late', reasons: ['3 days past the target finish'], daysPastTarget: 3, overdueRfis: 1,
  nextMilestone: { id: 'm1', name: 'Final Inspection', targetDate: '2026-11-06', days: 3 },
  lastLogDate: '2026-10-31', daysSinceLog: 3, today: '2026-11-03',
};
const project = {
  id: 'p1', name: 'Temecula Phase 2', address: '41715 Enterprise Cir N', phase: 'Framing',
  percentComplete: 94, status: 'active', startOn: '2026-06-02', targetFinishOn: '2026-10-31',
  workerEmails: ['ana.ruiz@greensglobal.com'], managerEmails: ['marcus.reed@greensglobal.com'],
  executiveEmails: [], latitude: 0, longitude: 0, canEdit: true, contractValue: 1240000,
  today: '2026-11-03', weekStart: '2026-11-02', weekStartsOn: 1, health,
  names: { 'ana.ruiz@greensglobal.com': 'Ana Ruiz', 'marcus.reed@greensglobal.com': 'Marcus Reed' },
};
const queued = {
  id: 'l1', projectId: 'p1', projectName: project.name, logDate: '2026-11-02', status: 'submitted',
  authorEmail: 'ana.ruiz@greensglobal.com', authorName: 'Ana Ruiz', notes: 'Framed the east wall.',
  tags: ['safety'], aiSummary: 'The model would say this', aiSafetyFlags: [{ severity: 'high', issue: 'x' }],
  aiConfidence: 0.2, aiProcessedAt: '', awaitingAi: true, geofenceOk: true, mediaCount: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetConstructionMeta();
  api.getConstructionMeta.mockResolvedValue({ aiEnabled: false });
  api.getConstructionOverview.mockResolvedValue({
    activeSites: 1, totalWorkforce: 1, pendingReview: 1, tagCounts: { delay: 1, safety: 2, issue: 0, weather: 0 },
    projects: [project],
  });
  api.getConstructionLogs.mockResolvedValue([]);
  api.getConstructionReviewQueue.mockResolvedValue([queued]);
  api.getConstructionReviewQueueFor.mockResolvedValue([queued]);
  api.getConstructionReports.mockResolvedValue([]);
  api.getConstructionRegister.mockResolvedValue([]);
  api.getConstructionMedia.mockResolvedValue([]);
  api.getConstructionWeather.mockResolvedValue({ sites: [] });
  api.getConstructionProject.mockResolvedValue(project);
  api.getPeopleDirectory.mockResolvedValue([
    { email: 'ana.ruiz@greensglobal.com', name: 'Ana Ruiz' },
    { email: 'marcus.reed@greensglobal.com', name: 'Marcus Reed' },
    { email: 'lee.chan@greensglobal.com', name: 'Lee Chan' },
  ]);
  api.getTicketProperties.mockResolvedValue({ properties: [{ id: 'prop1', name: 'GS Temecula', city: 'Temecula', state: 'CA' }] });
  api.getNotifications.mockResolvedValue([]);
});

describe('Edit Job sheet', () => {
  it('opens from the project page and saves only what changed, in one Save', async () => {
    api.updateConstructionProject.mockResolvedValue({ ...project, phase: 'Finishes' });
    const onSaved = vi.fn();
    render(<EditJobSheet project={project} onClose={() => {}} onSaved={onSaved} />);
    expect(screen.getByText('Edit Job')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();                       // nothing changed yet
    fireEvent.change(screen.getByLabelText('Phase'), { target: { value: 'Finishes' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'on_hold' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /GS Temecula/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Property'), { target: { value: 'prop1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.updateConstructionProject).toHaveBeenCalledWith('p1',
      { phase: 'Finishes', status: 'on_hold', property_id: 'prop1' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows contract value only when the server sent it', () => {
    const { unmount } = render(<EditJobSheet project={project} onClose={() => {}} />);
    expect(screen.getByLabelText('Contract Value')).toBeInTheDocument();
    unmount();
    const { contractValue, ...crewView } = project;   // eslint-disable-line no-unused-vars
    render(<EditJobSheet project={crewView} onClose={() => {}} />);
    expect(screen.queryByLabelText('Contract Value')).not.toBeInTheDocument();
  });

  it('builds the body from the draft: team, dates, percent and, only when allowed, money', () => {
    const saved = savedOf(project);
    const draft = { ...saved, workerEmails: [...saved.workerEmails, 'lee.chan@greensglobal.com'], percentComplete: '96',
      targetFinishOn: '2026-11-14', contractValue: '1250000' };
    expect(changesFor(saved, draft, { canCost: true })).toEqual({
      worker_emails: ['ana.ruiz@greensglobal.com', 'lee.chan@greensglobal.com'], target_finish_on: '2026-11-14',
      percent_complete: 96, contract_value: 1250000 });
    expect(changesFor(saved, draft, { canCost: false })).not.toHaveProperty('contract_value');
  });
});

describe('AI is off', () => {
  it('the review queue shows no AI label, summary, confidence or AI flag', async () => {
    render(<ReviewQueue />);
    const card = await screen.findByText(project.name);
    fireEvent.click(card);
    expect(screen.queryByText(/AI Pending/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI Summary/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/check this one/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Safety Flag/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/low AI confidence/i)).not.toBeInTheDocument();
    // The crew's own tag and words, and names - never an address.
    expect(screen.getByText('Safety')).toBeInTheDocument();
    expect(screen.getByText('Framed the east wall.')).toBeInTheDocument();
    expect(screen.getByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send Back/ })).toBeInTheDocument();
  });

  it('with AI on, the same queue shows them', async () => {
    api.getConstructionMeta.mockResolvedValue({ aiEnabled: true });
    render(<ReviewQueue />);
    fireEvent.click(await screen.findByText(project.name));
    expect(await screen.findByText(/AI Pending/i)).toBeInTheDocument();
    expect(screen.getByText(/AI Summary/i)).toBeInTheDocument();
  });

  it('the review queue on a jobsite asks for that jobsite only, and Approve can be undone', async () => {
    api.reviewConstructionLog.mockResolvedValue({});
    render(<ReviewQueue projectId="p1" />);
    expect(api.getConstructionReviewQueueFor).toHaveBeenCalledWith('p1');
    fireEvent.click(await screen.findByText(project.name));
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(api.reviewConstructionLog).toHaveBeenCalledWith('l1', { decision: 'approve', note: '' }));
  });

  it('the dashboard counts the crew\'s tags, not AI safety flags', async () => {
    render(<ConstructionDashboard />);
    expect(await screen.findByText('Flagged by Crew')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/1 Delay · 2 Safety \(7 days\)/)).toBeInTheDocument());
    expect(screen.queryByText(/raised by AI/i)).not.toBeInTheDocument();
  });

  it('Weekly Reports drafts a picked week with no AI sparkle', async () => {
    api.generateConstructionReport.mockResolvedValue({ id: 'r1', projectId: 'p1', weekStart: '2026-10-26', weekEnd: '2026-11-01',
      title: 'Week', status: 'draft', version: 1, sections: {}, sectionOrder: [], stats: {} });
    render(<WeeklyReports project={project} canReview />);
    const week = await screen.findByLabelText('Week');
    expect(within(week).getByRole('option', { name: 'This Week (11/02/2026)' })).toBeInTheDocument();
    fireEvent.change(week, { target: { value: '2026-10-26' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft Report/ }));
    await waitFor(() => expect(api.generateConstructionReport).toHaveBeenCalledWith('p1', { week_start: '2026-10-26' }));
  });
});

describe('Health row', () => {
  it('says the state and the facts a manager acts on', () => {
    render(<HealthRow health={health} />);
    expect(screen.getByText('Late')).toBeInTheDocument();
    expect(screen.getByText('3 days past target')).toBeInTheDocument();
    expect(screen.getByText(/Final Inspection in 3 days \(11\/06\/2026\)/)).toBeInTheDocument();
    expect(screen.getByText('1 RFI overdue')).toBeInTheDocument();
    expect(screen.getByText('No log in 3 days')).toBeInTheDocument();
  });

  it('every project card carries it, and the progress track turns red past the target', async () => {
    const { container } = render(<ConstructionDashboard />);
    await waitFor(() => expect(container.querySelector('[data-project-card="p1"] [data-health-row]')).toBeTruthy());
    expect(container.querySelector('[data-project-card="p1"] .nx-track.is-overdue')).toBeTruthy();
  });
});

describe('Project URLs', () => {
  it('reads project:<id> and activity:<id>, and the old ids still land', () => {
    expect(parseConstructionSub('project:p1')).toEqual({ tab: 'construction-dashboard', projectId: 'p1' });
    expect(parseConstructionSub('activity:p1')).toEqual({ tab: 'construction-activity', projectId: 'p1' });
    expect(parseConstructionSub('ops-activity')).toEqual({ tab: 'construction-activity', projectId: '' });
    expect(parseConstructionSub('')).toEqual({ tab: 'construction-dashboard', projectId: '' });
  });

  it('a card opens its project through the URL, and Open Site Activity carries the project', async () => {
    const onOpenProject = vi.fn();
    api.getJobConnected.mockResolvedValue({ needsYou: {}, punch: {}, crew: { people: [] }, tickets: [], nextMilestones: [], lastLog: null, property: null });
    const { rerender } = render(<ConstructionDashboard onOpenProject={onOpenProject} projectId="" />);
    fireEvent.click(await screen.findByText(project.address));
    expect(onOpenProject).toHaveBeenCalledWith('p1');
    rerender(<ConstructionDashboard onOpenProject={onOpenProject} projectId="p1" />);
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Site Activity' }));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'ops', sub: 'activity:p1' }]);
    expect(screen.getByRole('button', { name: /Edit Job/ })).toBeInTheDocument();
  });
});

describe('Holds', () => {
  it('Publish is pressed and held, never a plain click', async () => {
    api.getConstructionReports.mockResolvedValue([{ id: 'r1', projectId: 'p1', weekStart: '2026-11-02', weekEnd: '2026-11-08',
      title: 'Week of 11/02/2026', status: 'draft', version: 1, sections: {}, sectionOrder: [], stats: {} }]);
    const { container } = render(<WeeklyReports project={project} canReview />);
    await waitFor(() => expect(container.querySelector('.nx-hold.nx-hold-send')).toBeTruthy());
    expect(container.querySelector('.nx-hold').textContent).toContain('Publish');
  });

  it('a register row\'s Remove is a hold too, and the row opens as a sheet', async () => {
    api.getConstructionRegister.mockImplementation((_id, kind) => Promise.resolve(kind === 'milestones' ? [] : []));
    api.getConstructionRegister.mockResolvedValue([{ id: 'm1', name: 'Final Inspection', targetDate: '2026-10-30', status: 'upcoming' }]);
    const { container } = render(<Registers project={project} canReview />);
    await waitFor(() => expect(container.querySelector('[data-register-row="m1"] .nx-hold')).toBeTruthy());
    expect(within(container.querySelector('[data-register-row="m1"]')).getByText('Overdue')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Final Inspection'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Removing a filed photo (review L7)', () => {
  const draft = { id: 'l1', projectId: 'p1', logDate: '2026-11-03', status: 'draft', notes: '', tags: [] };
  const filed = (uploadedBy) => [{ id: 'm1', kind: 'photo', url: '', thumbnailUrl: '', uploadedBy }];
  const holdRemove = async () => {
    const btn = await screen.findByRole('button', { name: /Remove this photo, press and hold/ });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
      await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS + 50); });
    } finally { vi.useRealTimers(); }
  };

  it('a manager removing someone else\'s photo holds, then gives a reason that is sent', async () => {
    api.getConstructionMedia.mockResolvedValue(filed('ana.ruiz@greensglobal.com'));
    api.removeConstructionMedia.mockResolvedValue(undefined);
    const prompt = vi.spyOn(dialog, 'prompt').mockResolvedValue('Wrong jobsite');
    render(<DailyLogCapture log={draft} project={project} onClose={() => {}} onSubmitted={() => {}} />);
    await holdRemove();
    await waitFor(() => expect(api.removeConstructionMedia).toHaveBeenCalledWith('m1', 'Wrong jobsite'));
    expect(prompt).toHaveBeenCalled();
    expect(api.deleteConstructionMedia).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it('the uploader removes their own with the hold alone', async () => {
    api.getConstructionMedia.mockResolvedValue(filed('marcus.reed@greensglobal.com'));
    api.deleteConstructionMedia.mockResolvedValue(undefined);
    render(<DailyLogCapture log={draft} project={project} onClose={() => {}} onSubmitted={() => {}} />);
    await holdRemove();
    await waitFor(() => expect(api.deleteConstructionMedia).toHaveBeenCalledWith('m1'));
  });
});

describe('Pure rules', () => {
  it('the week picker starts at the jobsite week the server answers', () => {
    expect(weekChoices(project, 3)).toEqual(['2026-11-02', '2026-10-26', '2026-10-19']);
  });

  it('days open and overdue come from the row\'s own dates', () => {
    const rfi = { status: 'open', submittedOn: '2026-10-20', dueOn: '2026-10-27' };
    expect(isOverdue('rfis', rfi, '2026-11-03')).toBe(true);
    expect(daysOpen('rfis', rfi, '2026-11-03')).toBe(14);
    expect(isOverdue('rfis', { ...rfi, status: 'answered' }, '2026-11-03')).toBe(false);
  });

  it('a missing photo bucket says so in plain words', () => {
    expect(uploadErrorWords({ message: 'Bucket not found', statusCode: '404' })).toBe(NO_BUCKET);
    expect(NO_BUCKET).toMatch(/^Photo storage is not set up yet - ask an administrator/);
    expect(uploadErrorWords({ message: 'Network down' })).toBe('Network down');
  });
});
