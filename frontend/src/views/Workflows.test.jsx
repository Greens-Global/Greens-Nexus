import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Workflows (/workflows): every tab paints something in
// every state (loading, empty, rows, a failing load), the paused-all banner
// sits above every tab with Resume for a Global Admin, the Automations
// switch calls the Tasks-rule proxy and comes back when it refuses, and the
// Runs tab opens the run drawer from run:<id>.

const api = {
  wfOverview: vi.fn(), wfList: vi.fn(), wfCreate: vi.fn(), wfStatus: vi.fn(), wfDuplicate: vi.fn(),
  wfAutomations: vi.fn(), wfTaskRuleEnabled: vi.fn(), wfRuns: vi.fn(), wfRunGet: vi.fn(),
  wfRunReplay: vi.fn(), wfRunCancel: vi.fn(), wfPauseAll: vi.fn(), wfCatalog: vi.fn(),
};
vi.mock('../api', () => ({ api: Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])) }));

const role = { can: vi.fn(() => true), canAccessModule: vi.fn(() => true), myEmail: 'neil@greensglobal.com' };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role }));
vi.mock('../lib/useActionCounts', () => ({ useActionCounts: () => ({}), tabCount: () => 0 }));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), prompt: vi.fn(), alert: vi.fn() } }));

const { default: Workflows } = await import('./Workflows');
const { invalidateCatalog } = await import('../workflows/lib/useCatalog');

const T = '2026-10-28T12:00:00Z';
const EMPTY_OVERVIEW = { needsAttention: [], last24h: { runs: 0, succeeded: 0, failed: 0 }, recent: [], pausedAll: { paused: false } };
const OVERVIEW = {
  needsAttention: [{ id: 'w2', name: 'Probation Ending Reminder', reason: 'Owner has left the company', since: T }],
  last24h: { runs: 12, succeeded: 11, failed: 1 },
  recent: [{ id: 'r1', workflowId: 'w1', workflowName: 'New Hire Welcome', version: 3, status: 'succeeded', startedAt: T, subjectLabel: 'Priya Shah' }],
  pausedAll: { paused: false },
};
const LIST = [
  { id: 'w1', name: 'New Hire Welcome', ownerName: 'Neil Kadakia', ownerEmail: 'neil@greensglobal.com', companyId: 'c1', companyName: 'Greens Global',
    status: 'active', version: 3, trigger: { kind: 'event', event: 'hr.employee.started' }, triggerText: 'When an employee starts', runs7d: 4, failCount: 0, lastRunAt: T },
  { id: 'w2', name: 'Probation Ending Reminder', ownerName: 'Max Test', ownerEmail: 'max@greensglobal.com', companyId: '', companyName: '',
    status: 'needs_attention', version: 1, trigger: { kind: 'date', entity: 'employee', field: 'probation.end', offsetDays: -14, time: '08:00' }, triggerText: '',
    runs7d: 0, failCount: 2, lastRunAt: '', pausedReason: 'Owner has left the company' },
];
const AUTOMATIONS = {
  taskRules: [{ id: 'tr1', name: 'Escalate Overdue', enabled: true, triggerText: 'When a task is overdue', companyId: 'c1', runCount: 7, lastRunAt: T }],
  jobs: [
    { key: 'reminders', label: 'Task Reminders', what: 'Emails the day a task is due', every: 'Every minute', settingLink: { view: 'admin-console', sub: 'emails:task-notifications' } },
    { key: 'noshow', label: 'No-Show Scan', what: 'Bells the manager when a shift has no punch', every: 'Every minute', settingLink: null },
  ],
};
const RUNS = { items: [
  { id: 'r1', workflowId: 'w1', workflowName: 'New Hire Welcome', version: 3, triggerKind: 'event', entity: 'employee', subjectId: 'e1', subjectLabel: 'Priya Shah',
    subjectLink: { view: 'hr', sub: 'hr-people' }, status: 'failed', startedAt: T, finishedAt: T, summary: '2 of 3 steps', error: 'Mail server refused', startedBy: '' },
], next: 'cursor-2' };
const RUN = { ...RUNS.items[0], steps: [
  { id: 's1', stepId: 'a', kind: 'action', action: 'email', label: 'Send Email', status: 'succeeded', startedAt: T, finishedAt: T, input: { to: 'priya@x.com' }, output: { sent: ['priya@x.com'] }, detail: '', attempt: 1 },
  { id: 's2', stepId: 'b', kind: 'action', action: 'tasks.create', label: 'Create Task', status: 'failed', startedAt: T, finishedAt: T, input: {}, output: {}, detail: 'Mail server refused', attempt: 2 },
], event: { key: 'hr.employee.started', at: T, payload: { id: 'e1' } } };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  role.can.mockReturnValue(true);
  role.canAccessModule.mockReturnValue(true);
  confirm.mockReset();
  invalidateCatalog();
  api.wfCatalog.mockResolvedValue({ entities: [{ key: 'employee', label: 'Employee', fields: [], dates: [{ key: 'probation.end', label: 'Probation End' }], people: [] }], events: [], actions: [], listSources: [] });
  api.wfList.mockResolvedValue(LIST);
  api.wfAutomations.mockResolvedValue(AUTOMATIONS);
  api.wfRuns.mockResolvedValue(RUNS);
  api.wfRunGet.mockResolvedValue(RUN);
});

const tabs = () => screen.getAllByRole('button').filter((b) => b.className.includes('module-tab-inline-btn')).map((b) => b.textContent.trim());

describe('Workflows', () => {
  it('shows a skeleton while the overview loads, then the empty states', async () => {
    let resolve;
    api.wfOverview.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = render(<Workflows activeSub="overview" onSubChange={vi.fn()} />);
    expect(container.querySelector('.nx-skel')).toBeTruthy();
    expect(tabs()).toEqual(['Overview', 'Workflows', 'Automations', 'Runs', 'Templates', 'Catalog']);
    resolve(EMPTY_OVERVIEW);
    expect(await screen.findByText('Every workflow is running as published.')).toBeTruthy();
    expect(screen.getByText(/No runs yet/)).toBeTruthy();
    expect(screen.queryByText(/All workflows are paused/)).toBeNull();
  });

  it('lists what needs attention, the figures and the recent runs, and opens them', async () => {
    api.wfOverview.mockResolvedValue(OVERVIEW);
    const go = vi.fn();
    render(<Workflows activeSub={null} onSubChange={go} />);
    expect(await screen.findByText('Probation Ending Reminder')).toBeTruthy();
    expect(screen.getByText('Probation Ending Reminder').parentElement.textContent).toMatch(/Owner has left the company - since 10\/28\/2026/);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
    fireEvent.click(screen.getByText('New Hire Welcome'));
    expect(go).toHaveBeenCalledWith('run:r1');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(go).toHaveBeenCalledWith('wf:w2');
    api.wfCreate.mockResolvedValue({ id: 'w9' });
    fireEvent.click(screen.getByRole('button', { name: /New Workflow/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('wf:w9'));
    expect(api.wfCreate).toHaveBeenCalledWith({ name: 'Untitled Workflow', companyId: '' });
  });

  it('says so when the overview cannot load', async () => {
    api.wfOverview.mockRejectedValue(new Error('API error 500'));
    render(<Workflows activeSub="overview" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/couldn't be loaded right now/)).toBeTruthy();
  });

  it('shows the paused-all banner on every tab and lets a Global Admin resume', async () => {
    api.wfOverview.mockResolvedValue({ ...EMPTY_OVERVIEW, pausedAll: { paused: true, by: 'Neil Kadakia', at: T } });
    api.wfPauseAll.mockResolvedValue({ ok: true });
    const { rerender } = render(<Workflows activeSub="overview" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/All workflows are paused by Neil Kadakia since 10\/28\/2026/)).toBeTruthy();
    rerender(<Workflows activeSub="automations" onSubChange={vi.fn()} />);
    expect(screen.getByText(/All workflows are paused by Neil Kadakia/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(api.wfPauseAll).toHaveBeenCalledWith({ paused: false });
    await waitFor(() => expect(api.wfOverview).toHaveBeenCalledTimes(2));
  });

  it('hides Resume from everyone but a Global Admin', async () => {
    role.can.mockReturnValue(false);
    api.wfOverview.mockResolvedValue({ ...EMPTY_OVERVIEW, pausedAll: { paused: true, by: 'Neil Kadakia', at: T } });
    render(<Workflows activeSub="overview" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/All workflows are paused/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('lists workflows with their trigger in English and the scope chips the role allows', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    const go = vi.fn();
    const { unmount } = render(<Workflows activeSub="list" onSubChange={go} />);
    expect(await screen.findByText('New Hire Welcome')).toBeTruthy();
    expect(screen.getByText('When an employee starts')).toBeTruthy();
    // No triggerText from the server: built from the trigger and the catalog.
    expect(await screen.findByText('14 days before Probation End of employee at 8:00 AM')).toBeTruthy();
    expect(screen.getByText('Needs Attention')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Every Company' })).toBeTruthy();
    // A workflow with no company shows the scope in words.
    expect(screen.getAllByText('Every Company').length).toBe(2);
    expect(api.wfList).toHaveBeenCalledWith({ scope: 'mine' });
    fireEvent.click(screen.getByRole('tab', { name: 'My Company' }));
    await waitFor(() => expect(api.wfList).toHaveBeenCalledWith({ scope: 'company' }));
    fireEvent.click(screen.getByText('New Hire Welcome'));
    expect(go).toHaveBeenCalledWith('wf:w1');
    // Pause goes to the status endpoint, and the row follows the answer.
    api.wfStatus.mockResolvedValue({ status: 'paused' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.wfStatus).toHaveBeenCalledWith('w1', { status: 'paused', reason: '' }));
    expect(await screen.findByText('Paused')).toBeTruthy();
    // Archive asks first and takes no for an answer.
    confirm.mockResolvedValue(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(api.wfStatus).toHaveBeenCalledTimes(1);
    unmount();

    role.canAccessModule.mockReturnValue(false);
    render(<Workflows activeSub="list" onSubChange={go} />);
    await screen.findAllByText('New Hire Welcome');
    expect(screen.queryByRole('tab', { name: 'Every Company' })).toBeNull();
  });

  it('shows the Automations switches, saves through the Tasks-rule proxy and reverts a refusal', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    render(<Workflows activeSub="automations" onSubChange={vi.fn()} />);
    expect(await screen.findByText('Escalate Overdue')).toBeTruthy();
    expect(screen.getByText('Task Reminders')).toBeTruthy();
    expect(screen.getByText('Always on')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Workflows' }).parentElement.textContent).toMatch(/2 workflows in your company, 1 active/);
    const sw = screen.getByRole('switch', { name: 'Escalate Overdue on' });
    expect(sw.checked).toBe(true);
    api.wfTaskRuleEnabled.mockResolvedValue({ ok: true });
    fireEvent.click(sw);
    expect(sw.checked).toBe(false);
    await waitFor(() => expect(api.wfTaskRuleEnabled).toHaveBeenCalledWith('tr1', false));
    api.wfTaskRuleEnabled.mockRejectedValue(Object.assign(new Error('Only a manager may change this rule'), { status: 403, detail: 'Only a manager may change this rule' }));
    fireEvent.click(sw);
    expect(sw.checked).toBe(true);
    await waitFor(() => expect(sw.checked).toBe(false));
    expect(screen.getByRole('alert').textContent).toContain('Only a manager may change this rule');
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByRole('button', { name: /Edit In Tasks/ }));
    expect(nav).toHaveBeenCalled();
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'tasks', sub: 'manage' });
    window.removeEventListener('nexus:navigate', nav);
  });

  it('lists runs, pages with Load More, and opens the drawer for run:<id>', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    const go = vi.fn();
    const { rerender } = render(<Workflows activeSub="runs" onSubChange={go} />);
    // The row (the workflow filter's option carries the same name).
    const row = await screen.findByRole('button', { name: /New Hire Welcome.*Priya Shah/ });
    expect(within(row).getByText('Failed')).toBeTruthy();
    expect(within(row).getByText(/Mail server refused/)).toBeTruthy();
    expect(api.wfRuns).toHaveBeenCalledWith({ kind: 'runs', workflow: '', status: '', before: null, limit: 50 });
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await waitFor(() => expect(api.wfRuns).toHaveBeenCalledWith({ kind: 'runs', workflow: '', status: '', before: 'cursor-2', limit: 50 }));
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }));
    await waitFor(() => expect(api.wfRuns).toHaveBeenCalledWith(expect.objectContaining({ kind: 'actions' })));
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    await screen.findByText('Priya Shah');
    fireEvent.click(screen.getByText('Priya Shah').closest('button'));
    expect(go).toHaveBeenCalledWith('run:r1');

    rerender(<Workflows activeSub="run:r1" onSubChange={go} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Send Email')).toBeTruthy();
    expect(within(dialog).getByText('Create Task')).toBeTruthy();
    expect(within(dialog).getByText('attempt 2')).toBeTruthy();
    expect(within(dialog).getAllByText('Mail server refused').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('priya@x.com')).toBeTruthy();
    api.wfRunReplay.mockResolvedValue({ ok: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /Replay/ }));
    await waitFor(() => expect(api.wfRunReplay).toHaveBeenCalledWith('r1'));
    // The footer's Close (the Modal's own X is named Close too).
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1));
    await waitFor(() => expect(go).toHaveBeenCalledWith('runs'));
  });

  it('shows the Templates and Catalog placeholders and a missing builder honestly', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    const { rerender } = render(<Workflows activeSub="templates" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/Templates is coming in this release/)).toBeTruthy();
    rerender(<Workflows activeSub="catalog" onSubChange={vi.fn()} />);
    expect(screen.getByText(/The catalog browser is coming in this release/)).toBeTruthy();
    rerender(<Workflows activeSub="wf:w1" onSubChange={vi.fn()} />);
    // Either the builder (when its file is present) or the placeholder - never blank.
    await waitFor(() => expect(document.body.textContent).toMatch(/builder|Builder|Loading|Opening/));
  });
});
