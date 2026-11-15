// The phone New Task composer (Neil, 11/15/2026 - Option B): chips for Due,
// Assignee, Project and Priority that open phone pickers in the sheet, Create
// that points at what is missing instead of a red form, the screen's project
// locked, Details carrying everything, a seeded description kept as it was.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

const ME = 'me@greensglobal.com';
const BOB = 'bob@greensglobal.com';
const createTask = vi.fn();
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    createTask, myEmail: ME, customFields: [],
    projects: [{ id: 'p1', name: 'Temecula Site Ops' }, { id: 'p2', name: 'Austin Buildout' }, { id: 'p3', name: 'Old', archived: true }],
  }),
}));
vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn(async () => [{ email: BOB, name: 'Bob Brown' }, { email: ME, name: 'Mia Moss' }]) } }));
vi.mock('./lib', async (orig) => ({
  ...(await orig()), uploadFilesToTask: async () => [],
  // Austin Buildout requires a Unit Number (a project's required custom field).
  requiredFieldsFor: (_cf, pid) => (pid === 'p2' ? [{ id: 'f1', name: 'Unit Number', type: 'text' }] : []),
}));
vi.mock('./TaskDetailDrawer', () => ({
  CustomFieldInput: ({ field, value, onChange }) => <input aria-label={field.name} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));

import QuickCreateTask from './QuickCreateTask';
import { todayISO, addDays } from './lib';

afterEach(() => { cleanup(); createTask.mockReset(); });

const open = async (props = {}) => {
  render(<QuickCreateTask defaults={{}} onClose={() => {}} onFullDetails={() => {}} {...props} />);
  await act(async () => { await Promise.resolve(); });
  return screen.getByLabelText('Task name');
};
const chips = () => screen.getByRole('group', { name: 'Task Details' });
const tap = async (name) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

describe('QuickCreateTask composer', () => {
  it('starts with you assigned and the date needed; a quick date and Create save it', async () => {
    createTask.mockResolvedValue({ id: 't1', dueOn: addDays(todayISO(), 1) });
    const onCreated = vi.fn();
    const box = await open({ onCreated });
    expect(within(chips()).getByRole('button', { name: 'Assignee: You. Change' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Walk Building C' } });
    await tap('Due Date, needed. Pick a date');
    await tap(/^Tomorrow/);
    expect(within(chips()).getByText('Tomorrow')).toBeTruthy();
    await tap('Create Task');
    expect(createTask.mock.calls[0][0]).toMatchObject({ title: 'Walk Building C', dueOn: addDays(todayISO(), 1), assigneeIds: [ME], priority: 'medium', projectId: '' });
    // What Add Another keeps rides along.
    expect(onCreated.mock.calls[0][1]).toMatchObject({ dueOn: addDays(todayISO(), 1), assigneeIds: [ME], projectId: '', priority: 'medium' });
  });

  it('with nobody assigned, Create opens the people picker; picked people save', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open({ defaults: { dueOn: '2099-01-01', assigneeIds: [] } });
    fireEvent.change(box, { target: { value: 'Call the vendor' } });
    await tap('Create Task');
    expect(createTask).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'People' })).toBeTruthy();
    await tap(/Bob Brown/);
    await tap(/^Done/);
    expect(within(chips()).getByRole('button', { name: 'Assignee: Bob Brown. Change' })).toBeTruthy();
    await tap('Create Task');
    expect(createTask.mock.calls[0][0]).toMatchObject({ assigneeIds: [BOB] });
  });

  it('the calendar picks a later day and will not go back past this month', async () => {
    await open();
    await tap('Due Date, needed. Pick a date');
    expect(screen.getByRole('button', { name: 'Previous Month' }).disabled).toBe(true);
    await tap('Next Month');
    const firstOfNext = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1, 1); return d; })();
    const day = within(screen.getByRole('grid')).getAllByRole('button').find((b) => b.textContent === '1');
    await act(async () => { fireEvent.click(day); });
    const iso = `${firstOfNext.getFullYear()}-${String(firstOfNext.getMonth() + 1).padStart(2, '0')}-01`;
    expect(within(chips()).getByRole('button', { name: new RegExp(`^Due Date: .*${iso.slice(5, 7)}/01/${iso.slice(0, 4)}`) })).toBeTruthy();
  });

  it('the screen\'s own project is shown and locked', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open({ defaults: { projectId: 'p1', dueOn: '2099-01-01' } });
    const chip = within(chips()).getByRole('button', { name: 'Project: Temecula Site Ops' });
    expect(chip.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Check locks' } });
    await tap('Create Task');
    expect(createTask.mock.calls[0][0]).toMatchObject({ projectId: 'p1' });
  });

  it('a picked project lists only live ones, and its required field must be filled before Create', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open({ defaults: { dueOn: '2099-01-01' } });
    fireEvent.change(box, { target: { value: 'Order keypads' } });
    await tap('Project: none. Change');
    expect(screen.queryByRole('button', { name: 'Old' })).toBeNull();          // archived
    await tap('Austin Buildout');
    expect(screen.getByLabelText('Unit Number')).toBeTruthy();
    await tap('Create Task');
    expect(createTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Unit Number'), { target: { value: 'B-12' } });
    await tap('Create Task');
    expect(createTask.mock.calls[0][0]).toMatchObject({ projectId: 'p2', customFieldValues: { f1: 'B-12' } });
  });

  it('Details carries the project, the note as HTML and the picked priority', async () => {
    const onFullDetails = vi.fn();
    const box = await open({ onFullDetails, defaults: { dueOn: '2099-01-01' } });
    fireEvent.change(box, { target: { value: 'Replace gate battery' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Front gate\nUse the 9V' } });
    await tap('Project: none. Change');
    await tap('Temecula Site Ops');
    await tap('Priority: Medium. Change');
    await tap('High');
    await tap('Full Details');
    expect(onFullDetails.mock.calls[0][0]).toMatchObject({
      title: 'Replace gate battery', projectId: 'p1', priority: 'high', dueOn: '2099-01-01',
      description: '<p>Front gate</p><p>Use the 9V</p>',
    });
  });

  it('a seeded description shows as words and is saved as it came when left alone', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const html = '<p>From the <b>Share</b> sheet</p>';
    await open({ defaults: { title: 'Shared photo', description: html, dueOn: '2099-01-01' } });
    expect(screen.getByLabelText('Note').value).toBe('From the Share sheet');
    await tap('Create Task');
    expect(createTask.mock.calls[0][0].description).toBe(html);
  });

  it('a sentence\'s date on a chip can be swapped for a picked one', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open();
    fireEvent.change(box, { target: { value: 'Paint the curb tomorrow' } });
    expect(within(chips()).getByText('Tomorrow')).toBeTruthy();
    await tap(/^Due Date: Tomorrow/);
    await tap(/^Today/);
    await tap('Create Task');
    // The picked date wins, and the word stays in the name - it was not read.
    expect(createTask.mock.calls[0][0]).toMatchObject({ dueOn: todayISO(), title: 'Paint the curb tomorrow' });
  });

  it('closing with words typed asks first', async () => {
    const onClose = vi.fn();
    const box = await open({ onClose });
    fireEvent.change(box, { target: { value: 'Half typed' } });
    await tap('Close');
    expect(onClose).not.toHaveBeenCalled();
  });
});
