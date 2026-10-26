import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Build Mode render-smoke (Oct 24 2026): nothing for people without it or
// with the mode off; the overlay and the tools strip when it is on; a pin
// on the current screen renders with its number and status.

let enabled = false;
let pins = [];
let mine = [];
vi.mock('../api', () => ({
  api: {
    devNotesEnabled: vi.fn(() => Promise.resolve(enabled ? { enabled: true, settings: { sendInstantly: false, dispatchTarget: 'local', pinsOnLoad: true }, blockedRoutes: ['pfs', 'credvault'] } : { enabled: false })),
    devNotesPins: vi.fn(() => Promise.resolve(pins)),
    devNotesList: vi.fn((p = {}) => Promise.resolve(p.mine ? mine : [])),
    devNotesSessions: vi.fn(() => Promise.resolve([])),
    devNotesStats: vi.fn(() => Promise.resolve(null)),
    devNotesGet: vi.fn(() => Promise.reject(new Error('Pin not found'))),
    devNotesSaveSettings: vi.fn((p) => Promise.resolve(p)),
  },
  onApiRequest: vi.fn(() => () => {}),
  setApiBodyCapture: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: null, supabaseUrl: '', supabaseAnonKey: '' }));

const pin = (over = {}) => ({
  id: 'p1', number: 3, kind: 'bug', priority: 'normal', status: 'fixed', comment: 'The button is the wrong color', thread: [],
  route: 'tasks', sub: 'home', target: { selector: '#target', tag: 'button', text: 'Mark All Read', rect: { x: 10, y: 10, w: 100, h: 30, pageX: 10, pageY: 10 }, mode: 'element', headings: [] },
  markup: { items: [], rel: { ox: 10, oy: 10 } }, createdBy: 'neil@greensglobal.com', createdAt: '2026-10-24T15:00:00Z', fixedBuildId: 'abc', fixedAt: '2026-10-24T16:00:00Z', ...over,
});

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); localStorage.clear(); document.body.innerHTML = '<main><button id="target">Mark All Read</button></main>'; });
afterEach(() => { cleanup(); enabled = false; pins = []; mine = []; });

const mount = async () => {
  const BuildMode = (await import('./BuildMode')).default;
  return render(<BuildMode view="tasks" sub="home" />);
};

describe('BuildMode', () => {
  it('renders nothing for someone without Build Mode, even with the mode flag set', async () => {
    sessionStorage.setItem('nexus:build-mode', '1');
    const { container } = await mount();
    const { api } = await import('../api');
    await waitFor(() => expect(api.devNotesEnabled).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing while the mode is off, even when enabled', async () => {
    enabled = true;
    const { container } = await mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(container.innerHTML).toBe('');
  });

  it('enabled + on: the overlay and the tools strip come up, and Esc turns it off', async () => {
    enabled = true;
    sessionStorage.setItem('nexus:build-mode', '1');
    const { container } = await mount();
    // The first mount pays for transforming the lazy module: under a full parallel run that passed 4 s.
    const strip = await screen.findByRole('toolbar', { name: 'Build Mode tools' }, { timeout: 10000 });
    expect(strip).toBeTruthy();
    expect(screen.getByTestId('bm-overlay')).toBeTruthy();
    // The simple strip: Comment up front, the drawing tools folded under Draw.
    expect(screen.getByRole('button', { name: /^Comment/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Redact/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(screen.getByRole('button', { name: /Redact/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Draw Tools' }));
    expect(screen.queryByRole('button', { name: /Redact/ })).toBeNull();
    // Esc inside a Nexus dialog (or a field) is that dialog's - the mode stays on.
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="host-dialog"><input id="host-field" /></div>');
    fireEvent.keyDown(document.getElementById('host-field'), { key: 'Escape' });
    fireEvent.keyDown(document.getElementById('host-dialog'), { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('bm-overlay')).toBeTruthy();
    // Esc on the page itself, with nothing of ours open, turns it off.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(sessionStorage.getItem('nexus:build-mode')).toBe('0');
  });

  it('finishing a box opens the comment box on it, and the box stays on the comment (Pranshu, Oct 27)', async () => {
    enabled = true;
    sessionStorage.setItem('nexus:build-mode', '1');
    await mount();
    await screen.findByRole('toolbar', { name: 'Build Mode tools' }, { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    fireEvent.click(screen.getByRole('button', { name: /^Rect/ }));
    // jsdom has no PointerEvent - without one the coordinates never reach the
    // Overlay (same shim as Overlay.test.jsx).
    if (typeof window.PointerEvent === 'undefined') {
      window.PointerEvent = class PointerEvent extends window.MouseEvent {
        constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType || 'mouse'; }
      };
    }
    const overlay = screen.getByTestId('bm-overlay');
    const at = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerDown(overlay, at(20, 20));
    fireEvent.pointerMove(overlay, at(120, 80));
    fireEvent.pointerUp(overlay, at(120, 80));
    expect(await screen.findByTestId('bm-composer', {}, { timeout: 4000 })).toBeTruthy();
    const { store } = await import('./store');
    expect(store.get().pick.mode).toBe('region');
    expect(store.get().pick.rect).toMatchObject({ x: 20, y: 20, w: 100, h: 60 });
    expect(store.get().markup).toHaveLength(1);
  });

  it('Browse lets clicks through to Nexus with the mode still on; Pin takes them back', async () => {
    enabled = true;
    sessionStorage.setItem('nexus:build-mode', '1');
    await mount();
    await screen.findByRole('toolbar', { name: 'Build Mode tools' }, { timeout: 4000 });
    expect(screen.getByTestId('bm-overlay').style.pointerEvents).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: /^Browse/ }));
    expect(screen.getByTestId('bm-overlay').style.pointerEvents).toBe('none');
    expect(screen.getByText(/Browse: use Nexus as usual/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Comment/ }));
    expect(screen.getByTestId('bm-overlay').style.pointerEvents).toBe('auto');
  });

  it('Done counts my open comments on every screen, by module, and opens the Queue', async () => {
    enabled = true;
    mine = [pin({ id: 'a', status: 'open', route: 'tasks' }), pin({ id: 'b', status: 'open', route: 'tasks' }), pin({ id: 'c', status: 'open', route: 'tickets' })];
    sessionStorage.setItem('nexus:build-mode', '1');
    await mount();
    const done = await screen.findByRole('button', { name: 'Done - 3 comments' }, { timeout: 4000 });
    expect(done.getAttribute('title')).toMatch(/Tasks.* 2 · .*Tickets.* 1|tasks 2 · tickets 1/i);
    fireEvent.click(done);
    expect(await screen.findByRole('dialog', {}, { timeout: 4000 })).toBeTruthy();
  });

  it('Show All Tools (per browser) brings back the whole strip: Pin, Redact and the Queue, no Done', async () => {
    enabled = true;
    localStorage.setItem('nexus:build-mode:all-tools', '1');
    sessionStorage.setItem('nexus:build-mode', '1');
    await mount();
    await screen.findByRole('toolbar', { name: 'Build Mode tools' }, { timeout: 4000 });
    expect(screen.getByRole('button', { name: /^Pin/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Redact/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Queue/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Done/ })).toBeNull();
  });

  it('a pin on this screen renders with its number and status; click opens its thread with Accept / Reopen', async () => {
    enabled = true;
    pins = [pin()];
    sessionStorage.setItem('nexus:build-mode', '1');
    await mount();
    const marker = await screen.findByTestId('bm-pin', {}, { timeout: 4000 });
    expect(marker.textContent).toContain('3');
    expect(marker.getAttribute('aria-label')).toContain('Fixed - Verify');
    fireEvent.click(marker);
    const thread = await screen.findByTestId('bm-thread');
    expect(thread.textContent).toContain('Fixed - Verify');
    expect(thread.textContent).toContain('The button is the wrong color');
    expect(screen.getByRole('button', { name: /Accept/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Reopen/ })).toBeTruthy();
  });

  it('a dev_note_owner bell (action { view: dev-notes, sub: pin:<id> }) opens the pin through the store listener', async () => {
    const { store } = await import('./store');
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'dev-notes', sub: 'pin:held-1' } }));
    expect(store.get().pendingPin).toBe('held-1');
    expect(sessionStorage.getItem('nexus:build-mode:open-pin')).toBe('held-1');
  });

  it('a blocked route shows the off-on-this-screen bar and no overlay', async () => {
    enabled = true;
    sessionStorage.setItem('nexus:build-mode', '1');
    const BuildMode = (await import('./BuildMode')).default;
    render(<BuildMode view="pfs" sub={null} />);
    await screen.findByText(/Build Mode is off on this screen/, {}, { timeout: 4000 });
    expect(screen.queryByTestId('bm-overlay')).toBeNull();
  });
});
