import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Build Mode v2 composer (Oct 24 2026): the server says whose area a pick is
// on (GET /dev-notes/owner-of -> { owner, held }). Held = the owner line and
// Save For <Owner> only (no Save And Send); not held = the v1 buttons. One
// lookup per file, cached.

const ANSWERS = {
  'src/components/NotificationBell.jsx': { owner: { name: 'Visesh', email: 'visesh.lodha@greensglobal.com' }, held: true },
  'src/views/InventoryManagement.jsx': { owner: { name: 'Visesh', email: 'visesh.lodha@greensglobal.com' }, held: true },
  'src/asset/AssetShell.jsx': { owner: { name: 'Neil', email: 'neil@greensglobal.com' }, held: false },
  'src/tasks/Home.jsx': { owner: null, held: false },
};
vi.mock('../api', () => ({
  api: { devNotesOwnerOf: vi.fn((path) => Promise.resolve(ANSWERS[path] || { owner: null, held: false })) },
  onApiRequest: vi.fn(() => () => {}),
  setApiBodyCapture: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: null, supabaseUrl: '', supabaseAnonKey: '' }));

const Composer = (await import('./Composer')).default;
const { api } = await import('../api');

const pickAt = (file) => ({ target: { tag: 'button', text: 'Mark All Read', selector: '#x', headings: [], components: ['Bell'], source: file ? { file, line: 12, col: 3 } : undefined }, rect: { x: 10, y: 10, w: 100, h: 30 }, mode: 'element' });
const draft = { id: 'd1', kind: 'bug', priority: 'normal', comment: '', attachments: [] };

const mount = (file, { sendInstantly = false, onSave = vi.fn() } = {}) => {
  const utils = render(<Composer pick={pickAt(file)} draft={draft} onChange={vi.fn()} onCancel={vi.fn()} onSave={onSave} settings={{ sendInstantly }} view="inventory" />);
  return { onSave, ...utils };
};

afterEach(() => { cleanup(); });

describe('Composer - ownership', () => {
  it("held for someone else: the owner line and Save For <Owner>, no Save And Send", async () => {
    const { onSave } = mount('src/components/NotificationBell.jsx');
    const line = await screen.findByTestId('bm-owner-line');
    expect(line.textContent).toBe("This is Visesh's area - it goes to Visesh, not Claude Code.");
    expect(screen.queryByRole('button', { name: /Save And Send/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save Pin/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Save For Visesh/ }));
    expect(onSave).toHaveBeenCalledWith(false);
  });

  it('Send Instantly does not turn a held pin into Save And Send, and Ctrl+Enter only saves', async () => {
    const { onSave } = mount('src/views/InventoryManagement.jsx', { sendInstantly: true });
    await screen.findByRole('button', { name: /Save For Visesh/ });
    expect(screen.queryByRole('button', { name: /Save And Send/ })).toBeNull();
    fireEvent.keyDown(screen.getByTestId('bm-composer'), { key: 'Enter', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith(false);
  });

  it('an owner who is me (held false): as before - Save Pin and Save And Send, no owner line', async () => {
    mount('src/asset/AssetShell.jsx');
    await waitFor(() => expect(api.devNotesOwnerOf).toHaveBeenCalledWith('src/asset/AssetShell.jsx'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('bm-owner-line')).toBeNull();
    expect(screen.getByRole('button', { name: /Save Pin/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save And Send/ })).toBeTruthy();
  });

  it('no source stamp: no lookup, the v1 buttons', async () => {
    api.devNotesOwnerOf.mockClear();
    mount(null);
    await new Promise((r) => setTimeout(r, 350));
    expect(api.devNotesOwnerOf).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bm-owner-line')).toBeNull();
    expect(screen.getByRole('button', { name: /Save And Send/ })).toBeTruthy();
  });

  it('asks once per file: a second pick on the same file uses the cache', async () => {
    mount('src/tasks/Home.jsx');
    await waitFor(() => expect(api.devNotesOwnerOf).toHaveBeenCalledWith('src/tasks/Home.jsx'));
    const calls = api.devNotesOwnerOf.mock.calls.filter(([p]) => p === 'src/tasks/Home.jsx').length;
    cleanup();
    mount('src/tasks/Home.jsx');
    await new Promise((r) => setTimeout(r, 350));
    expect(api.devNotesOwnerOf.mock.calls.filter(([p]) => p === 'src/tasks/Home.jsx').length).toBe(calls);
    expect(screen.queryByTestId('bm-owner-line')).toBeNull();
  });
});
