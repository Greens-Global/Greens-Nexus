// Manage > Automation Rules editor - the value widgets for the Monday-recipe
// triggers and actions (Oct 22 2026): custom field pickers, Create Task,
// Move to Project and Send Email. The vocabulary itself is covered by
// automationRules.test.js; the engine by backend test_task_automation_gaps.py.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
// The sections API answers with a section the store has never loaded (a
// project nobody opened this session).
vi.mock('../api', () => ({ api: {
  getPeopleDirectory: () => Promise.resolve([]),
  getTaskSections: () => Promise.resolve([{ id: 's9', projectId: 'p3', name: 'Fresh' }, { id: 's1', projectId: 'p2', name: 'Ready' }]),
} }));
vi.mock('./TasksContext', () => ({ useTasks: () => ({ teams: [], projects: [], tasks: [] }) }));

const { RuleModal } = await import('./ManageView');

const budget = { id: 'budget', name: 'Budget Status', type: 'select', options: [{ id: 'ok', label: 'OK' }, { id: 'over', label: 'Over' }] };
const signed = { id: 'signed', name: 'Signed', type: 'checkbox', options: [] };
const ctx = {
  statusOrder: ['not_started', 'in_progress', 'completed'], statusMeta: {},
  projects: [{ id: 'p1', name: 'Ops' }, { id: 'p2', name: 'Build' }], teams: [],
  people: [{ email: 'sam@greensglobal.com', name: 'Sam Lee' }],
  // A formula field (another branch): computed, saved with readOnly false.
  customFields: [budget, signed, { id: 'total', name: 'Total Cost', type: 'formula', options: [], readOnly: false }],
  sections: [{ id: 's1', projectId: 'p2', name: 'Ready' }],
  statusLabel: (id) => id, priorityLabel: (k) => k, projectName: (id) => id, teamName: (id) => id,
  personName: (e) => e, fieldName: (id) => id, fieldOptionLabel: (f, v) => v, sectionName: (id) => id,
};

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

const open = (rule) => {
  const onSave = vi.fn();
  render(<RuleModal rule={rule} ctx={ctx} onClose={() => {}} onSave={onSave} />);
  return onSave;
};
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save Rule' }));

describe('Send Email action', () => {
  const rule = {
    name: 'Tell them', enabled: true, trigger: { type: 'created', value: '' }, conditions: [],
    actions: [{ type: 'send_email', value: { to: 'assignees', subject: '{title} - {status}', body: 'Hi' } }],
  };

  it('edits the recipients, subject and message and saves them', () => {
    const onSave = open(rule);
    expect(screen.getByDisplayValue('The Assignees')).toBeTruthy();
    expect(screen.getAllByText(/Fill-ins:/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByPlaceholderText('e.g. {title} is over budget'), { target: { value: '{title} is late' } });
    save();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].actions[0]).toEqual({ type: 'send_email', value: { to: 'assignees', subject: '{title} is late', body: 'Hi' } });
  });

  it('asks for a person when "A Specific Person" is chosen and none is picked', () => {
    const onSave = open(rule);
    fireEvent.change(screen.getByDisplayValue('The Assignees'), { target: { value: 'person' } });
    expect(screen.getByText('Choose a person')).toBeTruthy();
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Pick who the email goes to.')).toBeTruthy();
  });
});

describe('Create Task action', () => {
  it('hides the project when the task is created as a subtask', () => {
    const onSave = open({
      name: 'Next', enabled: true, trigger: { type: 'created', value: '' }, conditions: [],
      actions: [{ type: 'create_task', value: { title: 'Follow up: {title}', projectId: 'p2', asSubtask: false, assignee: '{assignee}', dueInDays: 2, priority: 'high' } }],
    });
    expect(screen.getByDisplayValue('Follow up: {title}')).toBeTruthy();
    expect(screen.getByDisplayValue('The Same Assignees')).toBeTruthy();
    expect(screen.getByText('Project')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/subtask of the task that triggered the rule/));
    expect(screen.queryByText('Project')).toBeNull();
    save();
    expect(onSave.mock.calls[0][0].actions[0].value).toEqual({
      title: 'Follow up: {title}', projectId: '', asSubtask: true, assignee: '{assignee}', dueInDays: 2, priority: 'high',
    });
  });
});

describe('Move to Project action', () => {
  it('offers the sections of the chosen project', () => {
    const onSave = open({
      name: 'Route', enabled: true, trigger: { type: 'created', value: '' }, conditions: [],
      actions: [{ type: 'move_to_project', value: { projectId: 'p2', sectionId: '' } }],
    });
    fireEvent.change(screen.getByDisplayValue('No Section'), { target: { value: 's1' } });
    save();
    expect(onSave.mock.calls[0][0].actions[0].value).toEqual({ projectId: 'p2', sectionId: 's1' });
  });
});

describe('Move to Project loads the destination sections', () => {
  it('shows sections of a project the store has not loaded', async () => {
    const onSave = open({
      name: 'Route', enabled: true, trigger: { type: 'created', value: '' }, conditions: [],
      actions: [{ type: 'move_to_project', value: { projectId: 'p3', sectionId: '' } }],
    });
    const picker = await screen.findByDisplayValue('No Section');
    fireEvent.change(picker, { target: { value: 's9' } });
    save();
    expect(onSave.mock.calls[0][0].actions[0].value).toEqual({ projectId: 'p3', sectionId: 's9' });
  });
});

describe('action rows keep their own editor state', () => {
  it('removing a row does not hand its editor to the next row', () => {
    open({
      name: 'Two emails', enabled: true, trigger: { type: 'created', value: '' }, conditions: [],
      actions: [
        { type: 'send_email', value: { to: 'assignees', subject: 'One', body: 'x' } },
        { type: 'send_email', value: { to: 'creator', subject: 'Two', body: 'y' } },
      ],
    });
    // The second row switches to "A Specific Person" (held in its editor's
    // local state until a person is picked).
    fireEvent.change(screen.getByDisplayValue('The Creator'), { target: { value: 'person' } });
    fireEvent.click(screen.getAllByTitle('Remove Action')[0]);
    expect(screen.getByDisplayValue('Two')).toBeTruthy();
    expect(screen.getByDisplayValue('A Specific Person')).toBeTruthy();
    expect(screen.queryByDisplayValue('The Assignees')).toBeNull();
  });
});

describe('custom field trigger and condition', () => {
  it('picks the option a select field changes to', () => {
    const onSave = open({
      name: 'Over', enabled: true, trigger: { type: 'custom_field_changed', value: { fieldId: 'budget', to: '' } },
      conditions: [{ field: 'custom_field', fieldId: 'signed', op: 'is', value: 'checked' }],
      actions: [{ type: 'set_priority', value: 'high' }],
    });
    fireEvent.change(screen.getByDisplayValue('Any value'), { target: { value: 'over' } });
    // The checkbox condition reads Checked / Unchecked.
    expect(screen.getByDisplayValue('Checked')).toBeTruthy();
    save();
    const body = onSave.mock.calls[0][0];
    expect(body.trigger).toEqual({ type: 'custom_field_changed', value: { fieldId: 'budget', to: 'over' } });
    expect(body.conditions).toEqual([{ field: 'custom_field', fieldId: 'signed', op: 'is', value: 'checked' }]);
  });

  it('never offers a formula field', () => {
    open({
      name: 'Pick', enabled: true, trigger: { type: 'custom_field_changed', value: { fieldId: '', to: '' } },
      conditions: [], actions: [{ type: 'set_custom_field', value: { fieldId: '', value: '' } }],
    });
    for (const button of screen.getAllByText('Choose a custom field')) {
      fireEvent.click(button);
      expect(screen.getAllByText('Budget Status').length).toBeGreaterThan(0);
      expect(screen.queryByText('Total Cost')).toBeNull();
      fireEvent.keyDown(document, { key: 'Escape' });
    }
  });

  it('refuses a custom field trigger with no field', () => {
    const onSave = open({
      name: 'Nothing', enabled: true, trigger: { type: 'custom_field_changed', value: { fieldId: '', to: '' } },
      conditions: [], actions: [{ type: 'set_priority', value: 'high' }],
    });
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Pick the custom field the rule watches.')).toBeTruthy();
  });
});
