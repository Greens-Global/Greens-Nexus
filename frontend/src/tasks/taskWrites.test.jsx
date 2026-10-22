// Task writes that fail, and the undo of a delete (Oct 21 2026).
//  - A refused save puts the fields it touched back. The delta refetch that
//    used to be the only repair never returns a row the server did not
//    change, so the optimistic value used to stick on screen.
//  - A refused delete puts the row back.
//  - Undo after a delete RESTORES the trashed task (same id) instead of
//    creating a copy from its fields.
//  - Bulk delete is one batch with one toast; its Undo restores all of them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  updateTask: vi.fn(), deleteTask: vi.fn(), restoreTask: vi.fn(), createTask: vi.fn(), getTasksDelta: vi.fn(), useTaskTemplate: vi.fn(),
}));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => {
      if (api[k]) return api[k];
      return () => Promise.resolve([]);
    },
  }),
}));
vi.mock('../lib/supabase', () => ({ supabase: null }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
const NAMES = { 'jane@x.com': 'Jane Doe', 'john@x.com': 'John Roe' };
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => NAMES[e] || e }));
vi.mock('./celebrate', () => ({ celebrateCompletion: () => {} }));
const SEED = [
  { id: 'a', title: 'Alpha', priority: 'low', status: 'not_started' },
  { id: 'b', title: 'Bravo', priority: 'low', status: 'not_started' },
  { id: 'c', title: 'Charlie', priority: 'low', status: 'not_started' },
];
vi.mock('./taskStore', () => ({
  FIRST_PAINT: [],
  taskSnapshot: () => null,
  rememberTaskData: () => {},
  loadTaskData: async (apply) => { apply('tasks', { tasks: SEED.map((t) => ({ ...t })), serverTime: 's' }); },
}));

const dialogAlert = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../ui/dialog', () => ({ dialog: { alert: dialogAlert, confirm: vi.fn(() => Promise.resolve(true)) } }));

import { TasksProvider, useTasks } from './TasksContext';
import { deleteSelectedTasks } from './lib';

// The live store, kept from an effect (assigning it during render is a side
// effect the hooks lint refuses).
const live = { store: null };
function Probe() {
  const s = useTasks();
  useEffect(() => { live.store = s; });
  return <div data-testid="rows">{s.tasks.map((t) => `${t.id}:${t.priority}`).sort().join(',')}</div>;
}
const rows = () => screen.getByTestId('rows').textContent;
async function mount() {
  render(<TasksProvider><Probe /></TasksProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getTasksDelta.mockImplementation(() => Promise.resolve({ tasks: [], deletedIds: [], serverTime: 't' }));
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('a refused save', () => {
  it('puts the field back instead of leaving the optimistic value', async () => {
    api.updateTask.mockRejectedValue(Object.assign(new Error('Blocked by a dependency'), { status: 409 }));
    await mount();
    await act(async () => { await live.store.updateTask('a', { priority: 'urgent' }).catch(() => {}); });
    expect(rows()).toBe('a:low,b:low,c:low');
    expect(window.alert).toHaveBeenCalledWith('Blocked by a dependency');
  });

  it('keeps a save that succeeded', async () => {
    api.updateTask.mockImplementation((id, body) => Promise.resolve({ ...SEED.find((t) => t.id === id), ...body }));
    await mount();
    await act(async () => { await live.store.updateTask('a', { priority: 'urgent' }); });
    expect(rows()).toBe('a:urgent,b:low,c:low');
  });
});

describe('delete', () => {
  it('puts the row back when the server refuses', async () => {
    api.deleteTask.mockRejectedValue(new Error('Not allowed'));
    await mount();
    await act(async () => { await live.store.deleteTask('b').catch(() => {}); });
    expect(rows()).toBe('a:low,b:low,c:low');
  });

  it('Undo restores the trashed task with its id, never a recreated copy', async () => {
    api.deleteTask.mockResolvedValue(null);
    api.restoreTask.mockImplementation((id) => Promise.resolve({ ...SEED.find((t) => t.id === id) }));
    await mount();
    await act(async () => { await live.store.deleteTask('b'); });
    expect(rows()).toBe('a:low,c:low');
    expect(screen.getByText('Deleted "Bravo"')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Undo')); await Promise.resolve(); await Promise.resolve(); });
    expect(api.restoreTask).toHaveBeenCalledWith('b');
    expect(api.createTask).not.toHaveBeenCalled();
    expect(rows()).toBe('a:low,b:low,c:low');
  });
});

describe('the delta after a restore', () => {
  // The server keeps a deleted task's tombstone after a restore, so the delta
  // can name the same id as changed AND deleted. Changed wins: the restored
  // row must not vanish again.
  it('keeps a row the delta returns both as changed and as deleted', async () => {
    api.deleteTask.mockResolvedValue(null);
    api.restoreTask.mockImplementation((id) => Promise.resolve({ ...SEED.find((t) => t.id === id) }));
    await mount();
    await act(async () => { await live.store.deleteTasks(['a', 'b']); });
    expect(rows()).toBe('c:low');
    api.getTasksDelta.mockImplementation(() => Promise.resolve({
      tasks: [{ ...SEED[0] }, { ...SEED[1] }], deletedIds: ['a', 'b'], serverTime: 'u',
    }));
    await act(async () => { fireEvent.click(screen.getByText('Undo')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.getTasksDelta).toHaveBeenCalled();
    expect(rows()).toBe('a:low,b:low,c:low');
  });

  it('still drops a row that is only in deletedIds', async () => {
    api.updateTask.mockRejectedValue(new Error('x'));
    await mount();
    api.getTasksDelta.mockImplementation(() => Promise.resolve({ tasks: [], deletedIds: ['c'], serverTime: 'v' }));
    await act(async () => { await live.store.updateTask('a', { priority: 'high' }).catch(() => {}); await Promise.resolve(); });
    expect(rows()).toBe('a:low,b:low');
  });
});

describe('bulk delete', () => {
  it('is one batch with one toast whose Undo restores every task', async () => {
    api.deleteTask.mockResolvedValue(null);
    api.restoreTask.mockImplementation((id) => Promise.resolve({ ...SEED.find((t) => t.id === id) }));
    await mount();
    let r;
    await act(async () => { r = await live.store.deleteTasks(['a', 'b', 'c']); });
    expect(r).toEqual({ deleted: 3, failed: 0, error: null });
    expect(rows()).toBe('');
    expect(screen.getByText('Deleted 3 tasks')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Undo')); await Promise.resolve(); await Promise.resolve(); });
    expect(api.restoreTask.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c']);
    expect(rows()).toBe('a:low,b:low,c:low');
  });

  it('counts the ones the server refused and puts them back', async () => {
    api.deleteTask.mockImplementation((id) => (id === 'b' ? Promise.reject(new Error('Not yours')) : Promise.resolve(null)));
    await mount();
    let r;
    await act(async () => { r = await live.store.deleteTasks(['a', 'b', 'c']); });
    expect(r.deleted).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.error.message).toBe('Not yours');
    expect(rows()).toBe('b:low');
    expect(screen.getByText('Deleted 2 tasks')).toBeTruthy();
  });
});

describe('the bulk bar delete', () => {
  it('says how many could not be deleted', async () => {
    dialogAlert.mockClear();
    const fake = { deleteTasks: vi.fn(() => Promise.resolve({ deleted: 2, failed: 1, error: new Error('Not yours') })) };
    await deleteSelectedTasks(fake, ['a', 'b', 'c']);
    expect(fake.deleteTasks).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(dialogAlert.mock.calls[0][0]).toBe('Deleted 2 of 3 tasks. 1 could not be deleted and is back in the list. Not yours');
  });

  it('stays quiet when every delete went through', async () => {
    dialogAlert.mockClear();
    await deleteSelectedTasks({ deleteTasks: () => Promise.resolve({ deleted: 3, failed: 0, error: null }) }, ['a', 'b', 'c']);
    expect(dialogAlert).not.toHaveBeenCalled();
  });
});

describe('people a create could not add (Oct 21 2026)', () => {
  it('names them in one notice, by name, and keeps the key out of the stored row', async () => {
    api.createTask
      .mockResolvedValueOnce({ id: 'n1', title: 'Copy one', priority: 'low', droppedPeople: ['jane@x.com'] })
      .mockResolvedValueOnce({ id: 'n2', title: 'Copy two', priority: 'low', droppedPeople: ['john@x.com', 'jane@x.com'] })
      .mockResolvedValueOnce({ id: 'n3', title: 'Copy three', priority: 'low' });
    await mount();
    let created;
    await act(async () => {
      created = await live.store.createTask({ title: 'Copy one' });
      await live.store.createTask({ title: 'Copy two' });
      await live.store.createTask({ title: 'Copy three' });
    });
    expect('droppedPeople' in created).toBe(false);
    expect(live.store.tasks.some((t) => 'droppedPeople' in t)).toBe(false);
    const notice = screen.getByTestId('dropped-people');
    expect(notice.textContent).toBe('Not added: Jane Doe, John Roe - not in the Nexus directory or no longer with the company.×');
    expect(screen.getAllByTestId('dropped-people')).toHaveLength(1);
  });

  it('says nothing when everyone was added', async () => {
    api.createTask.mockResolvedValue({ id: 'n1', title: 'Fine', priority: 'low' });
    await mount();
    await act(async () => { await live.store.createTask({ title: 'Fine' }); });
    expect(screen.queryByTestId('dropped-people')).toBeNull();
  });

  it('a task started from a template reports them too', async () => {
    api.useTaskTemplate.mockResolvedValue({ id: 'n9', title: 'From template', priority: 'low', droppedPeople: ['jane@x.com'] });
    await mount();
    let r;
    await act(async () => { r = await live.store.startFromTemplate('tpl1', { title: 'From template' }); });
    expect('droppedPeople' in r).toBe(false);
    expect(screen.getByTestId('dropped-people').textContent).toContain('Not added: Jane Doe');
  });
});
