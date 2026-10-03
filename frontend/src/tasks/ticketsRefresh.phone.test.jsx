// Ticket list refresh (fix/tickets-refresh). Tickets used to load once per
// session; TasksProvider now refetches them every 60s while the tab is
// visible and straight away when the tab comes back from hidden. The refresh
// is not phone-gated - a phone that sits in a pocket is the case that needed
// it most - so every case runs at phone width and at desktop width. It only
// runs while a ticket surface (Tickets, Support) is the page on screen, so
// most cases sit at /tickets.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';

const getTaskTickets = vi.hoisted(() => vi.fn());
const updateTaskTicket = vi.hoisted(() => vi.fn());
const addTicketLink = vi.hoisted(() => vi.fn());
const removeTicketLink = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, k) => {
      if (k === 'getTaskTickets') return getTaskTickets;
      if (k === 'updateTaskTicket') return updateTaskTicket;
      if (k === 'addTicketLink') return addTicketLink;
      if (k === 'removeTicketLink') return removeTicketLink;
      if (k === 'getTasksDelta') return () => Promise.resolve({ tasks: [], deletedIds: [], serverTime: 't' });
      return () => Promise.resolve([]);
    },
  }),
}));
vi.mock('../lib/supabase', () => ({ supabase: null }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (e) => e }));
// The first load hands the provider one ticket; the refresh is what is tested.
vi.mock('./taskStore', () => ({
  FIRST_PAINT: [],
  taskSnapshot: () => null,
  rememberTaskData: () => {},
  loadTaskData: async (apply) => { apply('tickets', [{ id: 'a', subject: 'First' }]); },
}));

import { TasksProvider, useTasks } from './TasksContext';

function setViewport(isMobile) {
  globalThis.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

// Render bookkeeping lives in an effect, not the render body (react-hooks
// purity rules): every commit counts, and the first ticket object is kept.
const seen = { renders: 0, first: null };
function Probe() {
  const { tickets, ticketsLoaded, updateTicket, addTicketLink: link, removeTicketLink: unlink } = useTasks();
  useEffect(() => {
    seen.renders += 1;
    if (!seen.first && tickets[0]) seen.first = tickets[0];
  });
  return (
    <div>
      <div data-testid="loaded">{ticketsLoaded ? 'yes' : 'no'}</div>
      <div data-testid="list">{tickets.map((t) => t.subject).join(',')}</div>
      <div data-testid="same">{tickets[0] && (!seen.first || tickets[0] === seen.first) ? 'same' : 'new'}</div>
      <button onClick={() => updateTicket('a', { subject: 'Mine' })}>Save</button>
      <button onClick={() => link('a', 'b', 'relates')}>Link</button>
      <button onClick={() => unlink('a', 'b')}>Unlink</button>
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

for (const phone of [true, false]) {
  describe(`ticket refresh (${phone ? 'phone' : 'desktop'})`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
      setViewport(phone);
      visibility = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      seen.renders = 0; seen.first = null;
      getTaskTickets.mockReset();
      updateTaskTicket.mockReset();
      addTicketLink.mockReset();
      removeTicketLink.mockReset();
      window.history.replaceState(null, '', '/tickets');
    });
    afterEach(() => { vi.useRealTimers(); window.history.replaceState(null, '', '/'); });

    it('refetches the list every 60 seconds while the tab is visible', async () => {
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'First' }, { id: 'b', subject: 'New one' }]);
      await mount();
      expect(list()).toBe('First');
      await act(async () => { await vi.advanceTimersByTimeAsync(59000); });
      expect(getTaskTickets).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(list()).toBe('First,New one');
    });

    it('does not poll while hidden, and refreshes at once when the tab comes back', async () => {
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
      await mount();
      act(() => setVisibility('hidden'));
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      act(() => setVisibility('visible'));
      await flush();
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(list()).toBe('Changed');
      // Only hidden -> visible counts: a visible -> visible event does nothing.
      act(() => setVisibility('visible'));
      await flush();
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
    });

    it('skips the interval tick that lands right after a tab-return refresh', async () => {
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
      await mount();
      // Hidden 50s into the first cycle, back 8s later: the return refreshes.
      await act(async () => { await vi.advanceTimersByTimeAsync(50000); });
      act(() => setVisibility('hidden'));
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      act(() => setVisibility('visible'));
      await flush();
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      // The 60s tick 2s later is not a second download...
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      // ...but the one after that runs as usual.
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(2);
    });

    it('retries on the next tick after a failure (a failed fetch does not count as fresh)', async () => {
      getTaskTickets.mockRejectedValueOnce(new Error('offline'));
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Back' }]);
      await mount();
      act(() => setVisibility('hidden'));
      await act(async () => { await vi.advanceTimersByTimeAsync(55000); });
      act(() => setVisibility('visible'));
      await flush();
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(list()).toBe('First');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(2);
      expect(list()).toBe('Back');
    });

    it('keeps the old list, and ticketsLoaded, when a refresh fails', async () => {
      getTaskTickets.mockRejectedValue(new Error('offline'));
      await mount();
      expect(screen.getByTestId('loaded').textContent).toBe('yes');
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(list()).toBe('First');
      expect(screen.getByTestId('loaded').textContent).toBe('yes');
    });

    it('keeps the same ticket object, and does not re-render, when nothing changed', async () => {
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'First' }]);
      await mount();
      expect(screen.getByTestId('same').textContent).toBe('same');
      // Past the 45s task poll first (it re-renders on its own), then count
      // only what the 60s ticket refresh does.
      await act(async () => { await vi.advanceTimersByTimeAsync(59000); });
      const before = seen.renders;
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('same').textContent).toBe('same');
      expect(seen.renders).toBe(before);
    });

    it('drops a refresh that was in flight when a local save landed', async () => {
      let answer;
      getTaskTickets.mockImplementation(() => new Promise((r) => { answer = r; }));
      updateTaskTicket.mockResolvedValue({ id: 'a', subject: 'Mine' });
      await mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText('Save'));
      await flush();
      expect(list()).toBe('Mine');
      // The stale answer (read before the save) arrives late: ignored.
      await act(async () => { answer([{ id: 'a', subject: 'First' }]); });
      await flush();
      expect(list()).toBe('Mine');
    });

    it('does not poll, or refresh on tab return, when no ticket surface is showing (Tasks view)', async () => {
      window.history.replaceState(null, '', '/tasks');
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
      await mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
      act(() => setVisibility('hidden'));
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      act(() => setVisibility('visible'));
      await flush();
      expect(getTaskTickets).not.toHaveBeenCalled();
      expect(list()).toBe('First');
    });

    it('does not poll on the dashboard either, and picks up once the page moves to Tickets', async () => {
      window.history.replaceState(null, '', '/');
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
      await mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(getTaskTickets).not.toHaveBeenCalled();
      window.history.pushState(null, '', '/tickets');
      // Arriving refreshes within a second, not at the next minute tick.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(list()).toBe('Changed');
    });

    it('refreshes at once when the page moves from Tasks to Tickets, and only on arrival', async () => {
      window.history.replaceState(null, '', '/tasks');
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
      await mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(getTaskTickets).not.toHaveBeenCalled();
      window.history.pushState(null, '', '/tickets');
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      // Staying on Tickets does not refresh again every second.
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
    });

    it('does not refresh on arrival while the tab is hidden', async () => {
      window.history.replaceState(null, '', '/tasks');
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
      await mount();
      act(() => setVisibility('hidden'));
      window.history.pushState(null, '', '/tickets');
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(getTaskTickets).not.toHaveBeenCalled();
    });

    for (const path of ['/support', '/support/tickets', '/tasks/tickets']) {
      it(`polls and refreshes on tab return on ${path}`, async () => {
        window.history.replaceState(null, '', path);
        getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'Changed' }]);
        await mount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
        expect(getTaskTickets).toHaveBeenCalledTimes(1);
        expect(list()).toBe('Changed');
        // Past the 15s freshness window, a tab return refreshes again.
        await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
        act(() => setVisibility('hidden'));
        act(() => setVisibility('visible'));
        await flush();
        expect(getTaskTickets).toHaveBeenCalledTimes(2);
      });
    }

    it('keeps the list when the refetch after adding or removing a link fails', async () => {
      addTicketLink.mockResolvedValue({ id: 'a' });
      removeTicketLink.mockResolvedValue({ ok: true });
      getTaskTickets.mockRejectedValue(new Error('offline'));
      window.history.replaceState(null, '', '/tasks');
      await mount();
      fireEvent.click(screen.getByText('Link'));
      await flush();
      expect(addTicketLink).toHaveBeenCalledTimes(1);
      expect(getTaskTickets).toHaveBeenCalledTimes(1);
      expect(list()).toBe('First');
      fireEvent.click(screen.getByText('Unlink'));
      await flush();
      expect(removeTicketLink).toHaveBeenCalledTimes(1);
      expect(getTaskTickets).toHaveBeenCalledTimes(2);
      expect(list()).toBe('First');
    });

    it('takes the refetched list after a link change when it succeeds', async () => {
      addTicketLink.mockResolvedValue({ id: 'a' });
      getTaskTickets.mockResolvedValue([{ id: 'a', subject: 'First' }, { id: 'b', subject: 'Linked' }]);
      await mount();
      fireEvent.click(screen.getByText('Link'));
      await flush();
      expect(list()).toBe('First,Linked');
    });
  });
}
