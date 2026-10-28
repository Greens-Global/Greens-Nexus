// The workflow builder (Oct 2026): a definition reads as sentences, Add Step
// adds a step through the menu, Publish stays off with its reason until the
// draft is clean and tested, Test shows the trace and the planned lines,
// Describe It lands a draft in the builder.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myRole: 'owner', myEmail: 'neil@greensglobal.com', companies: [] }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

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
  api.wfGet.mockImplementation(() => Promise.resolve(workflow()));
});

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

  it('never renders blank while loading or on an error', async () => {
    api.wfGet.mockImplementation(() => Promise.reject(new Error('boom')));
    const { container } = render(<Builder id="w1" go={() => {}} />);
    expect(container.textContent.length).toBeGreaterThan(0);
    expect(await screen.findByText('This workflow could not be loaded.')).toBeInTheDocument();
  });
});
