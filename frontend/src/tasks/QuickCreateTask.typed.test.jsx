// The phone New Task sheet reads a typed sentence (11/13/2026): what it
// understood shows as chips under the name and in the sheet's own fields,
// Create and Full Details use exactly that, and a plain name is as before.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

const ME = 'me@greensglobal.com';
const BOB = 'bob@greensglobal.com';
const createTask = vi.fn();
vi.mock('./TasksContext', () => ({
  useTasks: () => ({ createTask, myEmail: ME, projects: [], customFields: [] }),
}));
vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn(async () => [{ email: BOB, name: 'Bob Brown' }, { email: ME, name: 'Me' }]) } }));
vi.mock('./lib', async (orig) => ({ ...(await orig()), uploadFilesToTask: async () => [] }));

import QuickCreateTask from './QuickCreateTask';
import { todayISO, addDays } from './lib';

afterEach(() => { cleanup(); createTask.mockReset(); });

const open = async (props = {}) => {
  render(<QuickCreateTask defaults={{}} onClose={() => {}} onFullDetails={() => {}} {...props} />);
  await act(async () => { await Promise.resolve(); });   // people load, so "Bob" can be matched
  return screen.getByLabelText('Task name');
};
const chips = () => screen.queryByRole('group', { name: 'Understood From the Task Name' });
const SENTENCE = 'Check the gate tomorrow, urgent, for Bob';

describe('QuickCreateTask typed sentence', () => {
  it('shows what it understood, and Create saves the cleaned name with those fields', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open();
    const create = screen.getByRole('button', { name: 'Create Task' });
    fireEvent.change(box, { target: { value: 'Check the gate' } });
    expect(chips()).toBeNull();
    expect(create.disabled).toBe(true);                 // a plain name still needs its date
    fireEvent.change(box, { target: { value: SENTENCE } });
    expect(within(chips()).getByText('Urgent')).toBeTruthy();
    expect(within(chips()).getByText('Bob Brown')).toBeTruthy();
    expect(create.disabled).toBe(false);                // the date came from the sentence
    expect(createTask).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(create); });
    expect(createTask.mock.calls[0][0]).toMatchObject({
      title: 'Check the gate', priority: 'urgent', assigneeIds: [BOB], dueOn: addDays(todayISO(), 1),
    });
  });

  it('a removed chip is name text again, and its field goes back to what it was', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open();
    fireEvent.change(box, { target: { value: SENTENCE } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove assignee Bob Brown' }));
    expect(within(chips()).queryByText('Bob Brown')).toBeNull();
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(createTask.mock.calls[0][0]).toMatchObject({ title: 'Check the gate, for Bob', priority: 'urgent', assigneeIds: [ME] });
  });

  it('Full Details carries what the chips show', async () => {
    const onFullDetails = vi.fn();
    const box = await open({ onFullDetails });
    fireEvent.change(box, { target: { value: SENTENCE } });
    fireEvent.click(screen.getByRole('button', { name: 'Full Details' }));
    expect(onFullDetails.mock.calls[0][0]).toMatchObject({
      title: 'Check the gate', priority: 'urgent', assigneeIds: [BOB], dueOn: addDays(todayISO(), 1),
    });
  });

  it('a plain name is saved exactly as typed, with the sheet\'s own fields', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open({ defaults: { dueOn: '2099-01-01' } });
    fireEvent.change(box, { target: { value: 'order more gloves for the crew' } });
    expect(chips()).toBeNull();
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(createTask.mock.calls[0][0]).toMatchObject({ title: 'order more gloves for the crew', priority: 'medium', assigneeIds: [ME], dueOn: '2099-01-01' });
  });
});
