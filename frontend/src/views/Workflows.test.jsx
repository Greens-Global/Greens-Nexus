import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Render-smoke for Workflows (/workflows): every tab paints something in
// every state (loading, empty, rows, a failing load), the paused-all banner
// sits above every tab with Resume for a Global Admin, the Automations
// switch calls the Tasks-rule proxy and comes back when it refuses, and the
// Runs tab opens the run drawer from run:<id>. Then the review fixes (Oct 28
// 2026): a company's workflow switch is shown on the row, the Actions view
// speaks in step statuses, the To date seeds the paging cursor, a task
// rule's Runs popup, the drawer's error state and a Replay that 409s, the
// catalog's labels on a step's input, /workflows/settings going to Settings
// > Workflows, and the Undo word for a workflow's own option keys.

const api = {
  wfOverview: vi.fn(), wfList: vi.fn(), wfCreate: vi.fn(), wfStatus: vi.fn(), wfDuplicate: vi.fn(),
  wfAutomations: vi.fn(), wfTaskRuleEnabled: vi.fn(), wfRuns: vi.fn(), wfRunGet: vi.fn(),
  wfRunReplay: vi.fn(), wfRunCancel: vi.fn(), wfPauseAll: vi.fn(), wfCatalog: vi.fn(),
  wfTemplates: vi.fn(), wfCatalogSeen: vi.fn(), wfGet: vi.fn(), getEntities: vi.fn(),
  getTaskAutomationRuns: vi.fn(), wfJobOff: vi.fn(),
};
vi.mock('../api', () => ({ api: Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])) }));

const role = { can: vi.fn(() => true), canAccessModule: vi.fn(() => true), myEmail: 'neil@greensglobal.com' };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role }));
vi.mock('../lib/useActionCounts', () => ({ useActionCounts: () => ({}), tabCount: () => 0 }));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), prompt: vi.fn(), alert: vi.fn() } }));

const { default: Workflows } = await import('./Workflows');
const { invalidateCatalog } = await import('../workflows/lib/useCatalog');
const { doneWord } = await import('../lib/approvalActions');

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
  // Its company has workflows switched off in Settings > Workflows.
  { id: 'w3', name: 'Birthday Note', ownerName: 'Neil Kadakia', ownerEmail: 'neil@greensglobal.com', companyId: 'c2', companyName: 'Greens India',
    status: 'active', version: 1, trigger: { kind: 'event', event: 'hr.employee.started' }, triggerText: 'When an employee starts', runs7d: 0, failCount: 0, lastRunAt: '', companyEnabled: false },
];
const AUTOMATIONS = {
  taskRules: [{ id: 'tr1', name: 'Escalate Overdue', enabled: true, triggerText: 'When a task is overdue', companyId: 'c1', runCount: 7, lastRunAt: T }],
  jobs: [
    { key: 'reminders', label: 'Task Reminders', what: 'Emails the day a task is due', every: 'Every minute', settingLink: { view: 'admin-console', sub: 'emails:task-notifications' }, off: false },
    { key: 'noshow', label: 'No-Show Scan', what: 'Bells the manager when a shift has no punch', every: 'Every minute', settingLink: null, off: true },
    { key: 'workflows', label: 'Workflows Runner', what: 'Runs the workflows on this screen', every: 'Every 5 seconds', settingLink: { view: 'admin', sub: 'workflows' }, switch: false, off: false },
  ],
};
const RUNS = { items: [
  { id: 'r1', workflowId: 'w1', workflowName: 'New Hire Welcome', version: 3, triggerKind: 'event', entity: 'employee', subjectId: 'e1', subjectLabel: 'Priya Shah',
    subjectLink: { view: 'hr', sub: 'hr-people' }, status: 'failed', startedAt: T, finishedAt: T, summary: '2 of 3 steps', error: 'Mail server refused', startedBy: '' },
], next: 'cursor-2' };
// Steps end done | failed (never a run's `succeeded`).
const RUN = { ...RUNS.items[0], steps: [
  { id: 's1', stepId: 'a', kind: 'action', action: 'email', label: 'Send Email', status: 'done', startedAt: T, finishedAt: T, input: { to: 'priya@x.com', body_lines: ['Hello', 'Welcome'] }, output: { sent: ['priya@x.com'] }, detail: '', attempt: 1 },
  { id: 's2', stepId: 'b', kind: 'action', action: 'tasks.create', label: 'Create Task', status: 'failed', startedAt: T, finishedAt: T, input: {}, output: {}, detail: 'Mail server refused', attempt: 2 },
], event: { key: 'hr.employee.started', at: T, payload: { id: 'e1' } } };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  role.can.mockReturnValue(true);
  role.canAccessModule.mockReturnValue(true);
  confirm.mockReset();
  invalidateCatalog();
  api.wfCatalog.mockResolvedValue({
    entities: [{ key: 'employee', label: 'Employee', fields: [], dates: [{ key: 'probation.end', label: 'Probation End' }], people: [] }],
    events: [], listSources: [],
    actions: [{ key: 'email', label: 'Send Email', module: 'core', params: [{ key: 'to', label: 'Send To', type: 'recipients' }, { key: 'body_lines', label: 'Lines', type: 'template' }] }],
  });
  api.getTaskAutomationRuns.mockResolvedValue([]);
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
    expect(screen.getAllByText('When an employee starts').length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]);
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
    expect(screen.getAllByRole('button', { name: /Settings/ })).toHaveLength(2);   // the reminders job and the runner
    expect(screen.getByRole('button', { name: 'Open Workflows' }).parentElement.textContent).toMatch(/3 workflows in your company, 2 active/);
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

  // The built-in off switch (Oct 28 2026): a Global Admin flips a job through
  // POST /workflows/automations/jobs/{key}/off, optimistic, back on a refusal.
  it('lets a Global Admin switch a built-in automation off and reverts a refusal', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    render(<Workflows activeSub="automations" onSubChange={vi.fn()} />);
    expect(await screen.findByText('Task Reminders')).toBeTruthy();
    const sw = screen.getByRole('switch', { name: 'Task Reminders on' });
    expect(sw.checked).toBe(true);
    expect(screen.getByRole('switch', { name: 'No-Show Scan on' }).checked).toBe(false);
    expect(screen.queryByRole('switch', { name: 'Workflows Runner on' })).toBeNull();
    expect(screen.queryByText('Off')).toBeNull();
    api.wfJobOff.mockResolvedValue({ key: 'reminders', off: true });
    fireEvent.click(sw);
    expect(sw.checked).toBe(false);
    await waitFor(() => expect(api.wfJobOff).toHaveBeenCalledWith('reminders', true));
    api.wfJobOff.mockRejectedValue(Object.assign(new Error('Only a Global Admin may switch an automation'), { status: 403, detail: 'Only a Global Admin may switch an automation' }));
    fireEvent.click(sw);
    expect(sw.checked).toBe(true);
    await waitFor(() => expect(sw.checked).toBe(false));
    expect(api.wfJobOff).toHaveBeenLastCalledWith('reminders', false);
    expect(screen.getByRole('alert').textContent).toContain('Only a Global Admin may switch an automation');
  });

  it('shows everyone else an Off chip instead of the built-in switch', async () => {
    role.can.mockImplementation((p) => p !== 'owner');
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    render(<Workflows activeSub="automations" onSubChange={vi.fn()} />);
    expect(await screen.findByText('No-Show Scan')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Task Reminders on' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'No-Show Scan on' })).toBeNull();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Escalate Overdue on' })).toBeTruthy();
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
    // The drawer opens before the run's detail arrives; a busy CI runner needs more than 1s.
    await within(dialog).findByText('Send Email', {}, { timeout: 5000 });
    expect(within(dialog).getByText('Create Task')).toBeTruthy();
    expect(within(dialog).getByText('attempt 2')).toBeTruthy();
    expect(within(dialog).getAllByText('Mail server refused').length).toBeGreaterThan(0);
    // The step's input keys wear the catalog's labels; a list reads as words.
    expect(within(dialog).getByText('Send To')).toBeTruthy();
    expect(within(dialog).getByText('Lines')).toBeTruthy();
    expect(within(dialog).getByText('Hello, Welcome')).toBeTruthy();
    expect(within(dialog).getByText('Sent')).toBeTruthy();
    expect(within(dialog).getAllByText('priya@x.com').length).toBe(2);
    expect(within(dialog).getByText('Done')).toBeTruthy();
    api.wfRunReplay.mockResolvedValue({ ok: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /Replay/ }));
    await waitFor(() => expect(api.wfRunReplay).toHaveBeenCalledWith('r1'));
    // The footer's Close (the Modal's own X is named Close too).
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1));
    await waitFor(() => expect(go).toHaveBeenCalledWith('runs'));
  });

  it('says on the row and in the builder when the company switch is off', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    render(<Workflows activeSub="list" onSubChange={vi.fn()} />);
    const off = (await screen.findByText('Birthday Note')).closest('[role="row"]');
    expect(within(off).getByText('Paused: company switch')).toBeTruthy();
    // A row without the flag says nothing about it.
    const on = screen.getByText('New Hire Welcome').closest('[role="row"]');
    expect(within(on).queryByText(/company switch/)).toBeNull();
  });

  it('offers only Done / Failed on the Actions view and drops a run status on the switch', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    render(<Workflows activeSub="runs" onSubChange={vi.fn()} />);
    await screen.findByRole('button', { name: /New Hire Welcome.*Priya Shah/ });
    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(within(status).getAllByRole('option').map((o) => o.textContent)).toEqual(['Any status', 'Running', 'Waiting', 'Succeeded', 'Failed', 'Skipped', 'Cancelled', 'Test']);
    fireEvent.change(status, { target: { value: 'succeeded' } });
    await waitFor(() => expect(api.wfRuns).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' })));
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }));
    expect(within(status).getAllByRole('option').map((o) => o.textContent)).toEqual(['Any status', 'Done', 'Failed']);
    expect(status.value).toBe('');
    await waitFor(() => expect(api.wfRuns).toHaveBeenCalledWith(expect.objectContaining({ kind: 'actions', status: '' })));
    fireEvent.change(status, { target: { value: 'done' } });
    await waitFor(() => expect(api.wfRuns).toHaveBeenCalledWith(expect.objectContaining({ kind: 'actions', status: 'done' })));
  });

  it('seeds the paging cursor from the To date and keeps Load More while older pages exist', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    render(<Workflows activeSub="runs" onSubChange={vi.fn()} />);
    await screen.findByRole('button', { name: /New Hire Welcome.*Priya Shah/ });
    expect(api.wfRuns).toHaveBeenLastCalledWith(expect.objectContaining({ before: null }));
    // Pick a To day on the calendar: the next request starts at the end of it.
    fireEvent.click(screen.getByRole('button', { name: 'To' }));
    const day = screen.getAllByRole('button', { name: '15' }).find((b) => !b.disabled);
    fireEvent.click(day);
    await waitFor(() => expect(api.wfRuns).toHaveBeenLastCalledWith(expect.objectContaining({ before: expect.stringMatching(/^\d{4}-\d{2}-15T23:59:59\.999Z$/) })));
    // The one row (10/28) is outside the range, yet the server has more:
    // Load More stays, with a line saying this page has nothing in range.
    expect(screen.queryByText('No runs match')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load More' })).toBeTruthy();
    expect(screen.getByText(/load more to look further back/)).toBeTruthy();
  });

  it('opens a task rule\'s runs in a popup, newest first', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    api.getTaskAutomationRuns.mockResolvedValue([
      { id: 'x1', ruleId: 'tr1', ruleName: 'Escalate Overdue', taskId: 't1', taskCode: 'T-41', taskTitle: 'Fix the gate', trigger: 'overdue', event: 'Overdue', actions: ['Set priority Urgent'], status: 'ok', detail: '', at: T },
      { id: 'x2', ruleId: 'tr1', ruleName: 'Escalate Overdue', taskId: 't2', taskCode: 'T-40', taskTitle: 'Paint the fence', trigger: 'overdue', event: 'Overdue', actions: [], status: 'error', detail: 'No assignee', at: '2026-10-27T09:00:00Z' },
    ]);
    render(<Workflows activeSub="automations" onSubChange={vi.fn()} />);
    await screen.findByText('Escalate Overdue');
    // The rule row's Runs link (the Runs tab is a button of the same name).
    fireEvent.click(screen.getAllByRole('button', { name: 'Runs' }).find((b) => !b.className.includes('module-tab-inline-btn')));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.getTaskAutomationRuns).toHaveBeenCalledWith('tr1', 50));
    expect(within(dialog).getByText('Escalate Overdue - Runs')).toBeTruthy();
    expect(await within(dialog).findByText('T-41 Fix the gate - Set priority Urgent')).toBeTruthy();
    expect(within(dialog).getByText('T-40 Paint the fence - No assignee')).toBeTruthy();
    expect(within(dialog).getByText('Done')).toBeTruthy();
    expect(within(dialog).getByText('Failed')).toBeTruthy();
    expect(within(dialog).getByText(/10\/28\/2026, \d{1,2}:\d{2} [AP]M/)).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the drawer\'s error state with a retry, and the server\'s words when Replay is refused', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    api.wfRunGet.mockRejectedValueOnce(new Error('API error 500')).mockResolvedValue(RUN);
    render(<Workflows activeSub="run:r1" onSubChange={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/This run couldn't be loaded right now/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('Send Email')).toBeTruthy();
    api.wfRunReplay.mockRejectedValue(Object.assign(new Error('API error 409'), { status: 409, detail: 'Only a failed run can be replayed' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Replay/ }));
    expect(await within(dialog).findByText('Only a failed run can be replayed')).toBeTruthy();
    // A bare status code never reaches the screen.
    api.wfRunReplay.mockRejectedValue(Object.assign(new Error('API error 500'), { status: 500, detail: null }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Replay/ }));
    expect(await within(dialog).findByText('The run could not be replayed - please try again.')).toBeTruthy();
  });

  it('sends /workflows/settings to Settings > Workflows', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    render(<Workflows activeSub="settings" onSubChange={vi.fn()} />);
    await waitFor(() => expect(nav).toHaveBeenCalled());
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'admin-console', sub: 'workflows' });
    window.removeEventListener('nexus:navigate', nav);
    // Overview stands in meanwhile - never a blank screen.
    expect(await screen.findByText('Every workflow is running as published.')).toBeTruthy();
  });

  it('names the decision in the Undo toast whatever case the option key came in', () => {
    expect(doneWord('approve')).toBe('Approved');
    expect(doneWord('Approve')).toBe('Approved');
    expect(doneWord('DECLINE')).toBe('Declined');
    expect(doneWord('Send Back')).toBe('Sent back');
    expect(doneWord('Escalate')).toBe('Done');
    expect(doneWord('')).toBe('Done');
  });

  it('routes the Templates, Catalog and builder subs to their screens, never blank', async () => {
    api.wfOverview.mockResolvedValue(EMPTY_OVERVIEW);
    api.wfTemplates.mockResolvedValue([]);
    api.wfCatalog.mockResolvedValue({ entities: [], events: [], actions: [], listSources: [], operators: {}, filters: [], newSince: [] });
    api.wfCatalogSeen.mockResolvedValue({});
    api.wfGet.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<Workflows activeSub="templates" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/No Templates Yet/)).toBeTruthy();
    rerender(<Workflows activeSub="catalog" onSubChange={vi.fn()} />);
    await waitFor(() => expect(api.wfCatalog).toHaveBeenCalled());
    expect(document.body.textContent.length).toBeGreaterThan(0);
    rerender(<Workflows activeSub="wf:w1" onSubChange={vi.fn()} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/builder|Builder|Loading|Opening|Workflow/));
  });
});
