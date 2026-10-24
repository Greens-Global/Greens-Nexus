import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Build Mode render-smoke (Oct 24 2026): nothing for people without it or
// with the mode off; the overlay and the tools strip when it is on; a pin
// on the current screen renders with its number and status.

let enabled = false;
let pins = [];
vi.mock('../api', () => ({
  api: {
    devNotesEnabled: vi.fn(() => Promise.resolve(enabled ? { enabled: true, settings: { sendInstantly: false, dispatchTarget: 'local', pinsOnLoad: true }, blockedRoutes: ['pfs', 'credvault'] } : { enabled: false })),
    devNotesPins: vi.fn(() => Promise.resolve(pins)),
    devNotesList: vi.fn(() => Promise.resolve([])),
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
afterEach(() => { cleanup(); enabled = false; pins = []; });

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
    const strip = await screen.findByRole('toolbar', { name: 'Build Mode tools' }, { timeout: 4000 });
    expect(strip).toBeTruthy();
    expect(screen.getByTestId('bm-overlay')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Pin/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Redact/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(sessionStorage.getItem('nexus:build-mode')).toBe('0');
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

  it('a blocked route shows the off-on-this-screen bar and no overlay', async () => {
    enabled = true;
    sessionStorage.setItem('nexus:build-mode', '1');
    const BuildMode = (await import('./BuildMode')).default;
    render(<BuildMode view="pfs" sub={null} />);
    await screen.findByText(/Build Mode is off on this screen/, {}, { timeout: 4000 });
    expect(screen.queryByTestId('bm-overlay')).toBeNull();
  });
});
