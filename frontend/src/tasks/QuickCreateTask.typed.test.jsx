// The phone New Task composer reads a typed sentence (11/13/2026; the chip
// composer of 11/15/2026): what it understood fills the composer's own chips,
// a chip's x puts the words back, Create and Full Details use exactly that,
// and a plain name is as before.
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
const chips = () => screen.getByRole('group', { name: 'Task Details' });
const SENTENCE = 'Check the gate tomorrow, urgent, for Bob';

describe('QuickCreateTask typed sentence', () => {
  it('fills the chips from the sentence, and Create saves the cleaned name with those fields', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    const box = await open();
    const create = screen.getByRole('button', { name: 'Create Task' });
    expect(create.disabled).toBe(true);                 // nothing to create without a name
    fireEvent.change(box, { target: { value: 'Check the gate' } });
    expect(within(chips()).getByRole('button', { name: 'Due Date, needed. Pick a date' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();   // a plain name: nothing read from it
    // A name with no date: Create opens the date picker instead of a red form.
    await act(async () => { fireEvent.click(create); });
    expect(screen.getByRole('group', { name: 'Quick Dates' })).toBeTruthy();
    expect(createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: SENTENCE } });
    expect(within(chips()).getByText('Urgent')).toBeTruthy();
    expect(within(chips()).getByText('Bob Brown')).toBeTruthy();
    expect(within(chips()).getByText('Tomorrow')).toBeTruthy();
    expect(createTask).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Task' })); });
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
    expect(within(chips()).getByText('You')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(createTask.mock.calls[0][0]).toMatchObject({ title: 'order more gloves for the crew', priority: 'medium', assigneeIds: [ME], dueOn: '2099-01-01' });
  });
});
