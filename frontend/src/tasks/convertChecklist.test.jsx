// Convert to Subtask (Neil, Oct 22 2026): the store takes the subtask the
// server made from a checklist line, so the drawer's Subtasks list shows it at
// once, and the parent's row its fresh checklist counters. The toast says so,
// with Open.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  convertTaskChecklistItem: vi.fn(),
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

// The live store, kept from an effect (assigning it during render is a side
// effect the hooks lint refuses).
const live = { store: null };
function Probe() {
  const s = useTasks();
  useEffect(() => { live.store = s; });
  return <div data-testid="rows">{s.tasks.map((t) => `${t.id}:${t.parentTaskId || '-'}:${t.checklistTotal ?? '-'}`).sort().join(',')}</div>;
}
const rows = () => screen.getByTestId('rows').textContent;
async function mount() {
  render(<TasksProvider><Probe /></TasksProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => { api.convertTaskChecklistItem.mockReset(); live.store = null; });

describe('convertChecklistItem (the store side of Convert to Subtask)', () => {
  it('puts the new subtask in the store and the parent\'s fresh counters on its row', async () => {
    await mount();
    api.convertTaskChecklistItem.mockResolvedValue({
      subtask: { id: 's1', title: 'Call the vendor', parentTaskId: 'a', priority: 'low', status: 'not_started' },
      task: { ...SEED[0], checklistTotal: 0, subtaskIds: ['s1'] },
    });
    let r;
    await act(async () => { r = await live.store.convertChecklistItem('i1'); });
    expect(api.convertTaskChecklistItem).toHaveBeenCalledWith('i1');
    expect(r.subtask.id).toBe('s1');
    expect(rows()).toBe('a:-:0,b:-:-,c:-:-,s1:a:-');
  });

  it('says who could not be put on the subtask, like any create', async () => {
    await mount();
    api.convertTaskChecklistItem.mockResolvedValue({
      subtask: { id: 's2', title: 'X', parentTaskId: 'a', droppedPeople: [{ email: 'john@x.com', reason: 'has left' }] },
      task: { ...SEED[0] },
    });
    let r;
    await act(async () => { r = await live.store.convertChecklistItem('i2'); });
    expect(r.subtask.droppedPeople).toBeUndefined();
    expect(screen.getByTestId('dropped-people').textContent).toContain('John Roe');
  });

  it('a refusal reaches the caller and changes nothing', async () => {
    await mount();
    api.convertTaskChecklistItem.mockRejectedValue(Object.assign(new Error('gone'), { status: 409 }));
    await act(async () => { await expect(live.store.convertChecklistItem('i3')).rejects.toThrow('gone'); });
    expect(rows()).toBe('a:-:-,b:-:-,c:-:-');
  });

  it('the toast can carry an Open action instead of Undo', async () => {
    await mount();
    const run = vi.fn();
    act(() => { live.store.offerUndo('Converted to a subtask', run, 'Open'); });
    expect(screen.getByText('Converted to a subtask')).toBeTruthy();
    expect(screen.queryByText('Undo')).toBeNull();
    fireEvent.click(screen.getByText('Open'));
    expect(run).toHaveBeenCalled();
    act(() => { live.store.offerUndo('Completed "x"', () => {}); });
    expect(screen.getByText('Undo')).toBeTruthy();
  });
});
