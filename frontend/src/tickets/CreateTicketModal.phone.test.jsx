import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// Create a Ticket on a touch screen (Oct 3):
//   - the photo / attach / scan row has 40px targets;
//   - a phone on its side (wider than 640px) gets the desktop Modal, but a
//     touch screen keeps the capture row there too;
//   - sheet vs Modal is decided once, so rotating mid-entry does not remount;
//   - no Ctrl+V hint on a phone (no keyboard), and the sticky footer clears
//     the home indicator.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket: vi.fn(), projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');

// A matchMedia whose answers can change mid-test, firing `change` the way a
// rotating phone does.
function screenOf(state) {
  const listeners = new Set();
  const answer = (q) => (q.includes('max-width: 640px') ? state.narrow : q.includes('pointer: coarse') ? state.coarse : false);
  window.matchMedia = (q) => ({
    get matches() { return answer(q); }, media: q, onchange: null,
    addEventListener(_, fn) { listeners.add({ q, fn }); }, removeEventListener(_, fn) { listeners.forEach((l) => { if (l.fn === fn) listeners.delete(l); }); },
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  return {
    set(next) {
      Object.assign(state, next);
      act(() => { listeners.forEach(({ q, fn }) => fn({ matches: answer(q), media: q })); });
    },
  };
}

const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup(); window.matchMedia = realMatchMedia;
});

const panel = () => document.querySelector('.nx-tasks-portal > div');

describe('CreateTicketModal on a touch screen', () => {
  it('gives the capture row 40px targets in the phone sheet', async () => {
    screenOf({ narrow: true, coarse: true });
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    for (const name of ['Add photo', 'Attach file', 'Scan text']) {
      const b = screen.getByRole('button', { name });
      expect(b.style.minHeight).toBe('40px');
      expect(b.style.minWidth).toBe('40px');
    }
    expect(screen.getByRole('button', { name: 'Create Ticket' })).toBeTruthy();
  });

  it('keeps the camera row in the Modal on a phone held sideways', async () => {
    screenOf({ narrow: false, coarse: true });
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    // Desktop Modal shape (rounded card), with the capture row in its footer.
    expect(panel().style.borderRadius).toBe('16px');
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeTruthy();
    expect(document.querySelector('input[type="file"][capture="environment"]')).toBeTruthy();
  });

  it('does not show the capture row on a desktop', async () => {
    screenOf({ narrow: false, coarse: false });
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    expect(screen.queryByRole('button', { name: 'Add photo' })).toBeNull();
  });

  it('does not swap the sheet for the Modal when the phone rotates mid-entry', async () => {
    const s = screenOf({ narrow: true, coarse: true });
    render(<CreateTicketModal onClose={vi.fn()} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    expect(panel().style.borderTopLeftRadius).toBe('18px');   // the bottom sheet
    s.set({ narrow: false });
    expect(panel().style.borderTopLeftRadius).toBe('18px');
    expect(title.isConnected).toBe(true);                   // same field, not remounted
    expect(screen.getByPlaceholderText(/What is the issue\?/)).toBe(title);
  });

  it('drops the Ctrl+V paste hint on a phone and keeps it on a desktop', async () => {
    screenOf({ narrow: true, coarse: true });
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    expect(screen.queryByText(/or press Ctrl\+V to paste a screenshot/)).toBeNull();
    cleanup();

    screenOf({ narrow: false, coarse: false });
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    expect(screen.getByText(/or press Ctrl\+V to paste a screenshot/)).toBeTruthy();
  });

  it('keeps the sheet footer clear of the iPhone home indicator', async () => {
    screenOf({ narrow: true, coarse: true });
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    const bar = screen.getByRole('button', { name: 'Create Ticket' }).parentElement.parentElement;
    expect(bar.style.position).toBe('sticky');
    expect(bar.getAttribute('style')).toContain('safe-area-inset-bottom');
  });
});
