// The workflow builder (Oct 2026): a definition reads as sentences, Add Step
// adds a step through the menu, Publish stays off with its reason until the
// draft is clean and tested, Test shows the trace and the planned lines,
// Describe It lands a draft in the builder, Save As Template is a full-level
// action on a published workflow, and a workflow made from a template opens
// with its blanks named and outlined once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const catalog = {
  entities: [{
    key: 'employee', label: 'Person', module: 'hr',
    fields: [
      { key: 'name', label: 'Name', type: 'text', visibility: 'all' },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'left', label: 'Left' }], visibility: 'all' },
      { key: 'start_date', label: 'Start Date', type: 'date', visibility: 'all' },
    ],
    dates: [{ key: 'start_date', label: 'Start Date', yearly: false }],
    people: [{ key: 'self', label: 'The Person' }, { key: 'manager', label: 'Their Manager' }],
  }],
  events: [{ key: 'hr.employee.status_changed', entity: 'employee', label: 'Status Changes', module: 'hr', group: 'People', changes: ['status'], volume: 'normal' }],
  actions: [
    {
      key: 'notify', label: 'Send A Notification', module: 'core', needsPerson: true, adminOnly: false,
      params: [
        { key: 'to', label: 'To', type: 'recipients', required: true },
        { key: 'title', label: 'Title', type: 'template', required: true, max: 120 },
      ],
    },
    { key: 'tasks.create', label: 'Create Task', module: 'tasks', needsPerson: true, adminOnly: false, params: [{ key: 'title', label: 'Title', type: 'template', required: true }] },
  ],
  listSources: [],
  operators: { text: [{ key: 'is', label: 'is' }, { key: 'contains', label: 'contains' }], select: [{ key: 'is', label: 'is' }, { key: 'changed_to', label: 'changed to' }], date: [{ key: 'before', label: 'before' }] },
  filters: [{ key: 'us_date', label: 'As A Date' }, { key: 'upper', label: 'Upper' }],
  newSince: ['tasks.create'],
};

const api = {
  wfGet: vi.fn(),
  wfSaveDraft: vi.fn(() => Promise.resolve({})),
  wfPublish: vi.fn(() => Promise.resolve({})),
  wfStatus: vi.fn(() => Promise.resolve({})),
  wfReown: vi.fn(() => Promise.resolve({})),
  wfDuplicate: vi.fn(() => Promise.resolve({ id: 'w2' })),
  wfDelete: vi.fn(() => Promise.resolve({})),
  wfSaveAsTemplate: vi.fn(() => Promise.resolve({ key: 't1', name: 'Welcome Note' })),
  wfVersions: vi.fn(() => Promise.resolve([])),
  wfVersion: vi.fn(() => Promise.resolve({})),
  wfRestore: vi.fn(() => Promise.resolve({})),
  wfDiff: vi.fn(() => Promise.resolve({ lines: [] })),
  wfRecentEvents: vi.fn(() => Promise.resolve([{ id: 'ev1', at: '2026-10-27T15:30:00Z', subjectLabel: 'Priya Shah', actor: 'hr@greensglobal.com' }])),
  wfTest: vi.fn(() => Promise.resolve({
    id: 'run1', status: 'test', summary: 'Would notify Priya Shah',
    trace: [{ group: 0, field: 'status', op: 'is', value: 'active', actual: 'active', ok: true }, { group: 0, field: 'name', op: 'contains', value: 'Z', actual: 'Priya Shah', ok: false }],
    steps: [
      { stepId: 's1', kind: 'action', action: 'notify', label: 'Send A Notification', status: 'planned', detail: 'Would notify Their Manager: Welcome Priya Shah' },
      { stepId: 's2', kind: 'wait', action: '', label: 'Wait', status: 'planned', detail: '2026-11-12T16:00:00Z' },
    ],
  })),
  wfPreviewSchedule: vi.fn(() => Promise.resolve({ count: 0, items: [] })),
  wfRun: vi.fn(() => Promise.resolve({ id: 'run9' })),
  wfDescribe: vi.fn(() => Promise.resolve({
    definition: {
      v: 1, trigger: { kind: 'event', event: 'hr.employee.status_changed', filters: [] }, conditions: [],
      steps: [{ id: 'd1', kind: 'action', action: 'notify', params: { to: [{ kind: 'manager' }], title: 'Drafted {{ subject.name }}' }, enabled: true }],
      settings: {},
    },
    problems: [], notes: 'One step drafted.',
  })),
  getPeopleDirectory: vi.fn(() => Promise.resolve([{ email: 'sam@greensglobal.com', name: 'Sam Lee' }])),
  getTaskProjects: vi.fn(() => Promise.resolve([])),
};

vi.mock('../api', () => ({ api }));
vi.mock('./lib/useCatalog', () => ({
  useCatalog: () => ({
    catalog, loading: false, error: null,
    entity: (k) => catalog.entities.find((e) => e.key === k) || null,
    event: (k) => catalog.events.find((e) => e.key === k) || null,
    action: (k) => catalog.actions.find((a) => a.key === k) || null,
    isNew: (k) => catalog.newSince.includes(k),
  }),
}));
vi.mock('./lib/text', () => ({
  describeTrigger: (t) => (t?.kind === 'event' && t.event ? `When ${t.event} happens` : 'When something happens'),
  describeCondition: (r) => `${r.field} ${r.op} ${r.value}`,
  describeStep: (s) => (s.kind === 'action' ? `Do ${s.action}: ${s.params?.title || '(no title)'}` : `Step ${s.kind}`),
  describeWorkflow: () => ['When something happens', 'Do notify'],
}));
const roleState = { myRole: 'owner', myEmail: 'neil@greensglobal.com', companies: [], full: true };
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ ...roleState, canAccessModule: (mod, minRole, level) => (mod === 'workflows' && level === 'full' ? roleState.full : true) }),
}));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const dialog = { confirm: vi.fn(() => Promise.resolve(true)), alert: vi.fn(() => Promise.resolve()), prompt: vi.fn() };
vi.mock('../ui/dialog', () => ({ dialog }));

const { default: Builder } = await import('./Builder');

const definition = {
  v: 1,
  trigger: { kind: 'event', event: 'hr.employee.status_changed', filters: [] },
  conditions: [[{ field: 'status', op: 'is', value: 'active' }]],
  steps: [{ id: 's1', kind: 'action', action: 'notify', params: { to: [{ kind: 'manager' }], title: 'Welcome {{ subject.name }}' }, enabled: true }],
  settings: { oncePerSubject: false, cooldownHours: 0, suppress: { people: [], companies: [] }, logSkips: false, allowDownstream: false, maxRunsPerHour: 100, maxRecipients: 50, onError: 'stop', faultSteps: [] },
};

function workflow(over = {}) {
  return {
    id: 'w1', name: 'Welcome Note', description: '', ownerEmail: 'neil@greensglobal.com', ownerName: 'Neil Kadakia', runAs: 'owner',
    companyId: '', status: 'draft', version: 0, definition, draft: null, lastTestedAt: null, testedCurrent: false, problems: [], pausedReason: '', versions: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  roleState.full = true;
  window.sessionStorage.clear();
  // these tests drive the recipe; the canvas (the desktop default since
  // 10/30/2026) has its own tests in BuilderCanvas.test.jsx and canvas/
  window.localStorage.setItem('wf-builder-view', 'recipe');
  api.wfGet.mockImplementation(() => Promise.resolve(workflow()));
  dialog.confirm.mockResolvedValue(true);
  dialog.alert.mockResolvedValue(undefined);
});

// What api.js hands a caller on a 422 the workflow routes answer with
// {"detail": {"problems": [...]}}: the message is the bare status, the parsed
// detail sits on err.detail.
const refused422 = (problems) => Object.assign(new Error('API error 422'), { status: 422, detail: { problems } });

const open = (props = {}) => {
  const go = vi.fn();
  render(<Builder id="w1" go={go} {...props} />);
  return go;
};

describe('Builder', () => {
  it('renders the definition as sentences', async () => {
    open();
    expect(await screen.findByText('When hr.employee.status_changed happens')).toBeInTheDocument();
    expect(screen.getByText(/Only if status is active/)).toBeInTheDocument();
    expect(screen.getByText('Do notify: Welcome {{ subject.name }}')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Welcome Note')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    // the Run As row (a Global Admin sees it) says what Nexus can and cannot do (permissions review L5)
    expect(screen.getByText('Nexus can only send notifications and emails, and reads only the fields everyone can see.')).toBeInTheDocument();
    expect(screen.queryByText(/every record it may touch/)).toBeNull();
  });

  it('adds a step through the Add Step menu', async () => {
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    const doCard = screen.getByRole('region', { name: 'Do' });
    fireEvent.click(within(doCard).getByRole('button', { name: /Add Step/ }));
    const menu = screen.getByRole('menu', { name: 'Add a step' });
    expect(within(menu).getByText('New')).toBeInTheDocument();        // tasks.create is in newSince
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Send A Notification/ }));
    expect(screen.getByText('Do notify: (no title)')).toBeInTheDocument();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    // The new step opens on its controls: the recipients picker and the title box.
    expect(screen.getByLabelText('Add a recipient')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Insert Field/ }).length).toBeGreaterThan(0);
  });

  it('keeps Publish off with the reason until the workflow is tested', async () => {
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    const publish = screen.getByRole('button', { name: /Publish/ });
    expect(publish).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Test this workflow before publishing');
  });

  it('names a problem in the definition instead', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({
      definition: { ...definition, steps: [{ ...definition.steps[0], params: { to: [], title: 'Hi' } }] }, testedCurrent: true,
    })));
    open();
    await screen.findByText('Do notify: Hi');
    expect(screen.getByRole('button', { name: /Publish/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('To is required');
  });

  it('runs a test from a recent event and shows the trace and the planned lines', async () => {
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('tab', { name: 'Test' }));
    const row = await screen.findByRole('button', { name: /Priya Shah/ });
    expect(row).toHaveTextContent('10/27/2026');
    fireEvent.click(row);
    await waitFor(() => expect(api.wfTest).toHaveBeenCalledWith('w1', { eventId: 'ev1' }));
    const traces = await screen.findAllByTestId('trace-row');
    expect(traces).toHaveLength(2);
    expect(traces[0]).toHaveTextContent('status is active');
    expect(within(traces[0]).getByLabelText('Passed')).toBeInTheDocument();
    expect(within(traces[1]).getByLabelText('Failed')).toBeInTheDocument();
    const planned = screen.getAllByTestId('planned-step');
    expect(planned[0]).toHaveTextContent('Planned');
    expect(planned[0]).toHaveTextContent('Would notify Their Manager: Welcome Priya Shah');
    expect(planned[1]).toHaveTextContent(/Would wait until 11\/12\/2026/);
    expect(screen.getByText('Nothing was sent. This was a dry run.')).toBeInTheDocument();
    // Tested now: Publish is on.
    expect(screen.getByRole('button', { name: /Publish/ })).not.toBeDisabled();
  });

  it('applies a Describe It draft on a workflow with no steps', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({ definition: { ...definition, steps: [] } })));
    open();
    const box = await screen.findByLabelText('Describe what should happen');
    fireEvent.change(box, { target: { value: 'Tell the manager when someone leaves' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft It/ }));
    // the draft is checked against the workflow's company, not the caller's
    await waitFor(() => expect(api.wfDescribe).toHaveBeenCalledWith({ text: 'Tell the manager when someone leaves', companyId: '' }));
    expect(await screen.findByText('Do notify: Drafted {{ subject.name }}')).toBeInTheDocument();
    expect(screen.queryByLabelText('Describe what should happen')).toBeNull();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('shows an If / Else step with its branches as lanes and edits inside one', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({
      definition: {
        ...definition,
        steps: [{
          id: 'if1', kind: 'if', conditions: [[{ field: 'status', op: 'is', value: 'left' }]], enabled: true,
          then: [{ id: 'n1', kind: 'action', action: 'notify', params: { to: [{ kind: 'manager' }], title: 'Inside then' }, enabled: true }],
          else: [],
        }],
      },
    })));
    open();
    const sentence = await screen.findByText('Step if');
    expect(screen.queryByText('Do notify: Inside then')).toBeNull();     // collapsed: only the If's sentence
    fireEvent.click(sentence);
    expect(screen.getByText('Then')).toBeInTheDocument();
    expect(screen.getByText('Otherwise')).toBeInTheDocument();
    expect(screen.getByText('Do notify: Inside then')).toBeInTheDocument();
    // Delete the nested step: the Then lane empties, the If stays.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete step' })[1]);
    expect(screen.queryByText('Do notify: Inside then')).toBeNull();
    expect(screen.getByText('Step if')).toBeInTheDocument();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('saves the draft with the definition', async () => {
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(api.wfSaveDraft).toHaveBeenCalled());
    expect(api.wfSaveDraft.mock.calls[0][0]).toBe('w1');
    expect(api.wfSaveDraft.mock.calls[0][1]).toEqual(definition);
  });

  it('shows the problems a 422 Publish carries under Publish, never "API error 422"', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({ testedCurrent: true })));
    api.wfPublish.mockImplementation(() => Promise.reject(refused422([
      { message: 'Step 1: To is required', path: 'steps.0.params.to' },
      { message: 'Owner may not post to Teams', path: 'steps.0' },
    ])));
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    const publish = screen.getByRole('button', { name: /Publish/ });
    expect(publish).not.toBeDisabled();
    fireEvent.click(publish);
    await waitFor(() => expect(api.wfPublish).toHaveBeenCalledWith('w1', { note: '' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Publish is off: Step 1: To is required (and 1 more)');
    expect(status).toHaveTextContent('Owner may not post to Teams');
    expect(screen.getByRole('button', { name: /Publish/ })).toBeDisabled();
    expect(dialog.alert).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/API error/);
  });

  it('words a refused Save Draft with the server\'s problem, not the status code', async () => {
    api.wfSaveDraft.mockImplementation(() => Promise.reject(refused422([{ message: 'Step 1: Title is too long', path: 'steps.0.params.title' }])));
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(dialog.alert).toHaveBeenCalledWith('Step 1: Title is too long'));
    expect(screen.getByRole('status')).toHaveTextContent('Step 1: Title is too long');
    // A plain refusal (a 403) shows the server's sentence; a bare 500 the fallback.
    api.wfSaveDraft.mockImplementation(() => Promise.reject(Object.assign(new Error('API error 403'), { status: 403, detail: 'Only the owner may edit this workflow' })));
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(dialog.alert).toHaveBeenCalledWith('Only the owner may edit this workflow'));
    api.wfSaveDraft.mockImplementation(() => Promise.reject(Object.assign(new Error('API error 500'), { status: 500, detail: null })));
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(dialog.alert).toHaveBeenCalledWith('The draft could not be saved.'));
  });

  it('renders the approval, For Each and Wait cards and opens their controls', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({
      definition: {
        ...definition,
        steps: [
          { id: 'ap1', kind: 'approval', params: { approvers: [{ kind: 'manager' }], mode: 'any', question: 'Approve {{ subject.name }}?', options: ['Approve', 'Decline'], remindDays: 2, expireDays: 7 }, branches: { Approve: [], Decline: [], expired: [] }, enabled: true },
          { id: 'fe1', kind: 'for_each', source: { key: '', params: {} }, as: 'report', steps: [], enabled: true },
          { id: 'wt1', kind: 'wait', params: { mode: 'duration', minutes: 60 }, enabled: true },
        ],
      },
    })));
    open();
    const approval = await screen.findByText('Step approval');
    expect(screen.getByText('Step for_each')).toBeInTheDocument();
    expect(screen.getByText('Step wait')).toBeInTheDocument();
    fireEvent.click(approval);
    expect(screen.getByText('Who Approves *')).toBeInTheDocument();
    expect(screen.getByLabelText('How They Decide').value).toBe('any');
    expect(screen.getByLabelText('Remind after days').value).toBe('2');
    fireEvent.click(screen.getByText('Step for_each'));
    expect(screen.getByLabelText('Call Each One').value).toBe('report');
    expect(screen.getByText('For Each report')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Step wait'));
    expect(screen.getByLabelText('How long to wait').value).toBe('duration');
  });

  it('offers Who Would It Run On for a schedule only, never a date trigger', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({
      definition: { ...definition, trigger: { kind: 'date', entity: 'employee', field: 'start_date', offsetDays: -14, time: '08:00' }, conditions: [] },
    })));
    const { unmount } = render(<Builder id="w1" go={vi.fn()} />);
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('tab', { name: 'Test' }));
    expect(screen.getByRole('button', { name: /Use Sample/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Who Would It Run On' })).toBeNull();
    unmount();

    api.wfGet.mockImplementation(() => Promise.resolve(workflow({
      definition: { ...definition, trigger: { kind: 'schedule', every: 'week', days: [1], time: '08:00', zone: 'company', entity: 'employee' }, conditions: [] },
    })));
    render(<Builder id="w1" go={vi.fn()} />);
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('tab', { name: 'Test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Who Would It Run On' }));
    await waitFor(() => expect(api.wfPreviewSchedule).toHaveBeenCalledWith('w1'));
    expect(await screen.findByText('Nobody right now.')).toBeInTheDocument();
  });

  it('saves a published workflow as a template through the popup', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({ status: 'active', version: 2, testedCurrent: true, description: 'Says hello.' })));
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('button', { name: /Save As Template/ }));
    const name = await screen.findByLabelText('Name');
    expect(name.value).toBe('Welcome Note');                         // the workflow's name by default
    fireEvent.change(name, { target: { value: 'Welcome Note Template' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'For every new hire.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Template/ }));
    await waitFor(() => expect(api.wfSaveAsTemplate).toHaveBeenCalledWith('w1', { name: 'Welcome Note Template', description: 'For every new hire.' }));
    expect(await screen.findByText('Saved as a template')).toBeInTheDocument();
    expect(screen.queryByLabelText('Description')).toBeNull();        // the popup closed
  });

  it('words a refused Save As Template with the server\'s sentence', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({ status: 'active', version: 1 })));
    api.wfSaveAsTemplate.mockImplementation(() => Promise.reject(Object.assign(new Error('API error 403'), { status: 403, detail: 'Only a Global Admin saves a template for every company' })));
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    fireEvent.click(screen.getByRole('button', { name: /Save As Template/ }));
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: /Save Template/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Global Admin saves a template for every company');
    expect(document.body.textContent).not.toMatch(/API error/);
    expect(screen.queryByText('Saved as a template')).toBeNull();
  });

  it('offers Save As Template only to full level and only once published', async () => {
    open();                                                           // a draft (version 0)
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    expect(screen.queryByRole('button', { name: /Save As Template/ })).toBeNull();
    cleanup();
    roleState.full = false;                                           // editor level, published: still no button
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({ status: 'active', version: 1 })));
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    expect(screen.queryByRole('button', { name: /Save As Template/ })).toBeNull();
  });

  it('names a template\'s blanks once and outlines the steps they sit in', async () => {
    api.wfGet.mockImplementation(() => Promise.resolve(workflow({
      definition: { ...definition, steps: [definition.steps[0], { id: 's2', kind: 'action', action: 'notify', params: { to: [{ kind: 'self' }], title: '' }, enabled: true }] },
    })));
    // the shape the backend's templates.py uses, stashed by Templates before it navigates
    window.sessionStorage.setItem('wf:blanks:w1', JSON.stringify(['steps[1].params.title', 'steps[1].params.to']));
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    const note = screen.getByRole('note', { name: 'Template blanks' });
    expect(note).toHaveTextContent('Fill in: Title, To');
    const cards = document.querySelectorAll('[data-blank="true"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Do notify: (no title)');
    expect(cards[0].style.border).toMatch(/dashed/);
    // read once: the key is gone, a reload shows a plain builder
    expect(window.sessionStorage.getItem('wf:blanks:w1')).toBeNull();
  });

  it('shows no blanks notice when nothing was stashed', async () => {
    open();
    await screen.findByText('Do notify: Welcome {{ subject.name }}');
    expect(screen.queryByRole('note', { name: 'Template blanks' })).toBeNull();
    expect(document.querySelectorAll('[data-blank="true"]')).toHaveLength(0);
  });

  it('never renders blank while loading or on an error', async () => {
    api.wfGet.mockImplementation(() => Promise.reject(new Error('boom')));
    const { container } = render(<Builder id="w1" go={() => {}} />);
    expect(container.textContent.length).toBeGreaterThan(0);
    expect(await screen.findByText('This workflow could not be loaded.')).toBeInTheDocument();
  });
  // Hold to confirm (Neil, Oct 30 2026): one workflow, so Delete is held on
  // the button with no dialog; a refusal rewinds it with the reason.
  it('deletes on a full hold of Delete, with no dialog, then goes back to the list', async () => {
    const go = open();
    const del = await screen.findByRole('button', { name: 'Delete, press and hold' });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(del, { button: 0, pointerId: 1 });
      await act(async () => { vi.advanceTimersByTime(1200); });
      expect(api.wfDelete).toHaveBeenCalledWith('w1');
      expect(dialog.confirm).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(700); });
      expect(go).toHaveBeenCalledWith('list');
    } finally { vi.useRealTimers(); }
  });

  it('a refused delete rewinds the button and says why', async () => {
    api.wfDelete.mockRejectedValueOnce(Object.assign(new Error('Only the owner may delete this workflow'), { status: 403 }));
    const go = open();
    const del = await screen.findByRole('button', { name: 'Delete, press and hold' });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(del, { button: 0, pointerId: 1 });
      await act(async () => { vi.advanceTimersByTime(1200); });
    } finally { vi.useRealTimers(); }
    expect(screen.getByRole('alert')).toHaveTextContent('Only the owner may delete this workflow');
    expect(go).not.toHaveBeenCalledWith('list');
  });
});
