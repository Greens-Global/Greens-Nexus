// Live tickets (11/13/2026). Every committed ticket change writes a
// task_events row marked kind "ticket" (backend ticket_events.py), on the same
// table - and so the same ONE Realtime channel - the task pings use. A ticket
// ping refetches the ticket list 400ms later; a task ping refetches the tasks
// and never the tickets (the ticket fetch is the whole list). The 60s poll
// stays as the fallback (ticketsRefresh.phone.test.jsx).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const getTaskTickets = vi.hoisted(() => vi.fn());
const getTasksDelta = vi.hoisted(() => vi.fn());
const updateTaskTicket = vi.hoisted(() => vi.fn());
const createTaskTicket = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => {
      if (k === 'getTaskTickets') return getTaskTickets;
      if (k === 'getTasksDelta') return getTasksDelta;
      if (k === 'updateTaskTicket') return updateTaskTicket;
      if (k === 'createTaskTicket') return createTaskTicket;
      return () => Promise.resolve([]);
    },
  }),
}));
// A stand-in Realtime client: keeps what each provider subscribed to, so the
// test can deliver a task_events row the way Supabase would.
const realtime = vi.hoisted(() => ({ channels: [] }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    channel: (topic) => {
      const ch = { topic, handlers: [], on(_type, filter, cb) { ch.handlers.push({ filter, cb }); return ch; }, subscribe() { return ch; } };
      realtime.channels.push(ch);
      return ch;
    },
    removeChannel: (ch) => { realtime.channels = realtime.channels.filter((c) => c !== ch); },
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => e }));
vi.mock('./taskStore', () => ({
  FIRST_PAINT: [],
  loadOlderTasks: async () => [],
  withRecent: (prev, recent) => recent,
  withOlder: (prev) => prev,
  taskSnapshot: () => null,
  rememberTaskData: () => {},
  loadTaskData: async (apply) => { apply('tickets', [{ id: 'a', subject: 'First' }]); },
}));

import { TasksProvider, useTasks } from './TasksContext';

function Probe() {
  const { tickets, updateTicket, createTicket } = useTasks();
  return (
    <div>
      <div data-testid="list">{tickets.map((t) => t.subject).join(',')}</div>
      <button onClick={() => updateTicket('a', { subject: 'Mine' })}>Save</button>
      <button onClick={() => createTicket({ subject: 'Brand new' })}>Create</button>
    </div>
  );
}

let visibility = 'visible';
function setVisibility(v) {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}
async function mount() {
  render(<TasksProvider><Probe /></TasksProvider>);
  await act(async () => { await Promise.resolve(); });
}
const list = () => screen.getByTestId('list').textContent;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
// A task_events INSERT, as Realtime hands it to every subscribed provider.
const ping = (row) => act(() => {
  for (const ch of realtime.channels) for (const h of ch.handlers) h.cb({ eventType: 'INSERT', new: row });
});
const ticketPing = () => ping({ id: 1, task_id: '', kind: 'ticket', affected_email: '' });
const taskPing = (kind = 'updated') => ping({ id: 2, task_id: 't-1', kind, affected_email: '' });
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('live tickets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    realtime.channels = [];
    getTaskTickets.mockReset();
    getTasksDelta.mockReset();
    getTasksDelta.mockResolvedValue({ tasks: [], deletedIds: [], serverTime: 't' });
    updateTaskTicket.mockReset();
    createTaskTicket.mockReset();
    window.history.replaceState(null, '', '/tickets');
  });
  afterEach(() => { vi.useRealTimers(); window.history.replaceState(null, '', '/'); });

  it('listens on one channel, for task_events inserts', async () => {
    await mount();
    expect(realtime.channels).toHaveLength(1);
    expect(realtime.channels[0].handlers).toHaveLength(1);
    expect(realtime.channels[0].handlers[0].filter).toMatchObject({ event: 'INSERT', table: 'task_events' });
  });

  it('a ticket ping refetches the ticket list within half a second - and not the tasks', async () => {
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'First' }, { id: 'b', subject: 'Reply came in' }]);
    await mount();
    ticketPing();
    await tick(399);
    expect(getTaskTickets).not.toHaveBeenCalled();
    await tick(1);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    expect(list()).toBe('First,Reply came in');
    expect(getTasksDelta).not.toHaveBeenCalled();
  });

  it('a task ping refetches the tasks and never the ticket list', async () => {
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
    await mount();
    for (const kind of ['created', 'updated', 'deleted', 'comment', 'attachment', 'bulk', '']) taskPing(kind);
    await tick(2000);
    expect(getTasksDelta).toHaveBeenCalledTimes(1);
    expect(getTaskTickets).not.toHaveBeenCalled();
    expect(list()).toBe('First');
  });

  it('a row that arrives without its columns reads as a task ping', async () => {
    await mount();
    ping(undefined);
    await tick(400);
    expect(getTasksDelta).toHaveBeenCalledTimes(1);
    expect(getTaskTickets).not.toHaveBeenCalled();
  });

  it('a burst of ticket pings is one download', async () => {
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
    await mount();
    ticketPing();
    await tick(200);
    ticketPing();
    await tick(200);
    ticketPing();
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
  });

  it('is not held back by the 15 second freshness window', async () => {
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'One' }]);
    await mount();
    ticketPing();
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Two' }]);
    await tick(2000);
    ticketPing();
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(2);
    expect(list()).toBe('Two');
  });

  it('a ping that lands while a fetch is on the wire fetches again once it answers', async () => {
    const answers = [];
    getTaskTickets.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    await mount();
    ticketPing();
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    ticketPing();                       // a second change, while the first read is out
    await tick(1000);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    await act(async () => { answers[0]([{ id: 'a', subject: 'Older read' }]); });
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(2);
    await act(async () => { answers[1]([{ id: 'a', subject: 'Newest' }]); });
    await flush();
    expect(list()).toBe('Newest');
    // Nothing left to fetch: it does not keep going.
    await tick(5000);
    expect(getTaskTickets).toHaveBeenCalledTimes(2);
  });

  it('keeps the list when the refetch fails, and the next tick still picks the change up', async () => {
    getTaskTickets.mockRejectedValueOnce(new Error('offline'));
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Back' }]);
    await mount();
    ticketPing();
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    expect(list()).toBe('First');
    // No retry loop on a failure...
    await tick(10000);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    // ...the 60s poll is the fallback.
    await tick(50000);
    expect(getTaskTickets).toHaveBeenCalledTimes(2);
    expect(list()).toBe('Back');
  });

  it('drops an answer that was on the wire when a local save landed, then reads again', async () => {
    const answers = [];
    getTaskTickets.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    updateTaskTicket.mockResolvedValue({ id: 'a', subject: 'Mine' });
    await mount();
    ticketPing();
    await tick(400);
    fireEvent.click(screen.getByText('Save'));
    await flush();
    expect(list()).toBe('Mine');
    await act(async () => { answers[0]([{ id: 'a', subject: 'First' }]); });   // read before the save
    await flush();
    expect(list()).toBe('Mine');
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(2);
    await act(async () => { answers[1]([{ id: 'a', subject: 'Mine' }, { id: 'b', subject: 'Theirs' }]); });
    await flush();
    expect(list()).toBe('Mine,Theirs');
  });

  it('downloads nothing on another screen, and catches up on arriving at Tickets', async () => {
    window.history.replaceState(null, '', '/tasks');
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
    await mount();
    ticketPing();
    await tick(5000);
    expect(getTaskTickets).not.toHaveBeenCalled();
    window.history.pushState(null, '', '/tickets');
    await tick(1000);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    expect(list()).toBe('Changed');
  });

  it('downloads nothing while the tab is hidden, and catches up at once on return - even inside the 15 seconds', async () => {
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'One' }]);
    await mount();
    ticketPing();
    await tick(400);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    act(() => setVisibility('hidden'));
    getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Two' }]);
    ticketPing();
    await tick(3000);
    expect(getTaskTickets).toHaveBeenCalledTimes(1);
    act(() => setVisibility('visible'));
    await flush();
    expect(getTaskTickets).toHaveBeenCalledTimes(2);
    expect(list()).toBe('Two');
  });

  it('a new ticket is listed once even when the ping beats the create answer', async () => {
    let created;
    createTaskTicket.mockImplementation(() => new Promise((r) => { created = r; }));
    getTaskTickets.mockResolvedValue([{ id: 'n', subject: 'Brand new' }, { id: 'a', subject: 'First' }]);
    await mount();
    fireEvent.click(screen.getByText('Create'));
    ticketPing();
    await tick(400);
    expect(list()).toBe('Brand new,First');
    await act(async () => { created({ id: 'n', subject: 'Brand new' }); });
    await flush();
    expect(list()).toBe('Brand new,First');
  });
});
