import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Header Tools menu: role/grant gating (hide, never disable), open/close
// behavior, and Copy Diagnostic Info never carrying secrets.

vi.mock('../api', () => ({
  API_BASE: 'https://api.example.test',
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve({})) }),
}));

const roleState = { value: null };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => roleState.value };
});

const LEVEL = { employee: 1, supervisor: 2, manager: 3, administrator: 4, owner: 5 };
function makeRole(myRole, { grants = {}, hrScope = null, actingAs = null, isExternal = false } = {}) {
  const myGrantedModules = new Map(Object.entries(grants));
  const can = (min) => LEVEL[myRole] >= (LEVEL[min] ?? 1);
  const RANK = { viewer: 1, editor: 2, full: 3, owner: 4 };
  return {
    myRole, realEmail: 'pat@example.com', myEmail: 'pat@example.com', isExternal, hrScope, actingAs,
    can, myGrantedModules,
    canAccessModule: (id, minRole, lvl = 'viewer') => (!minRole || can(minRole)) || (RANK[myGrantedModules.get(id)] ?? 0) >= RANK[lvl],
    startActAs: vi.fn(), stopActAs: vi.fn(() => Promise.resolve()),
  };
}

const ToolsMenu = (await import('./ToolsMenu')).default;

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
const item = (name) => screen.queryByRole('menuitem', { name: new RegExp(name) });

beforeEach(() => {
  globalThis.fetch = vi.fn((url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(String(url).endsWith('/version') ? { version: '2.0.0' } : { status: 'ok', secrets: { vault_key: true } }),
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ToolsMenu', () => {
  it('shows an employee only the everyday and troubleshooting tools', () => {
    roleState.value = makeRole('employee');
    render(<ToolsMenu />);
    open();
    expect(screen.getByRole('menu', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    expect(item('Act As')).toBeNull();
    expect(item('Sync Microsoft 365')).toBeNull();
    expect(item('Audit Logs')).toBeNull();
    // Documents is supervisor + grant, and sending needs People editor.
    expect(item('Send for Signature')).toBeNull();
    expect(item('PDF Editor')).toBeInTheDocument();
    expect(item('System Status')).toBeInTheDocument();
    expect(item('Copy Diagnostic Info')).toBeInTheDocument();
  });

  it('shows a manager Act As, but not the admin-only tools', () => {
    roleState.value = makeRole('manager');
    render(<ToolsMenu />);
    open();
    expect(item('Act As')).toBeInTheDocument();
    expect(item('Sync Microsoft 365')).toBeNull();
    expect(item('Audit Logs')).toBeNull();
  });

  it('shows an IT Admin every tool, and hides the sync from company-scoped People access', () => {
    roleState.value = makeRole('administrator');
    render(<ToolsMenu />);
    open();
    for (const n of ['Act As', 'Sync Microsoft 365', 'Audit Logs', 'PDF Editor', 'Send for Signature', 'System Status']) {
      expect(item(n)).toBeInTheDocument();
    }
    cleanup();
    roleState.value = makeRole('administrator', { hrScope: ['entity-1'] });
    render(<ToolsMenu />);
    open();
    expect(item('Sync Microsoft 365')).toBeNull();
  });

  it('offers Exit Act As while acting as someone', () => {
    roleState.value = makeRole('employee', { actingAs: { targetName: 'Sam Lee', targetEmail: 'sam@example.com' } });
    render(<ToolsMenu />);
    open();
    expect(item('Exit Act As')).toBeInTheDocument();
    fireEvent.click(item('Exit Act As'));
    expect(roleState.value.stopActAs).toHaveBeenCalled();
  });

  it('opens and closes with a click, Esc and an outside click', () => {
    roleState.value = makeRole('employee');
    render(<ToolsMenu />);
    const trigger = screen.getByRole('button', { name: 'Tools' });
    open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('moves between rows with the arrow keys', async () => {
    roleState.value = makeRole('employee');
    render(<ToolsMenu />);
    open();
    const rows = screen.getAllByRole('menuitem');
    await waitFor(() => expect(rows[0]).toHaveFocus());
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();
  });

  it('navigates to the tool with nexus:navigate', () => {
    roleState.value = makeRole('administrator');
    const seen = [];
    const onNav = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    render(<ToolsMenu />);
    open();
    fireEvent.click(item('Send for Signature'));
    open();
    fireEvent.click(item('Audit Logs'));
    window.removeEventListener('nexus:navigate', onNav);
    expect(seen).toEqual([
      { view: 'documents', sub: 'documents-esign-new' },
      { view: 'admin-console', sub: 'audit' },
    ]);
  });

  it('shows a live System Status check', async () => {
    roleState.value = makeRole('employee');
    render(<ToolsMenu />);
    open();
    fireEvent.click(item('System Status'));
    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText('2.0.0')).toBeInTheDocument();
    expect(screen.getByText(/^\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2} (AM|PM)$/)).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.example.test/health', expect.objectContaining({ credentials: 'omit' }));
  });

  it('opens from the phone menu event', () => {
    roleState.value = makeRole('employee');
    render(<ToolsMenu />);
    fireEvent(window, new CustomEvent('nexus:tools-open'));
    expect(screen.getByRole('menu', { name: 'Tools' })).toBeInTheDocument();
  });

  it('copies diagnostic info without tokens, cookies or secrets', async () => {
    roleState.value = makeRole('manager', { actingAs: null });
    document.cookie = 'session=super-secret-cookie';
    try { sessionStorage.setItem('nexus:act-as-session', 'secret-session-id'); } catch { /* ignore */ }
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    window.history.replaceState({}, '', '/documents/documents-esign?request=abc123&token=xyz');

    render(<ToolsMenu />);
    open();
    fireEvent.click(item('Copy Diagnostic Info'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0][0];

    expect(text).toMatch(/^Nexus Diagnostic Info/);
    expect(text).toMatch(/Captured: \d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2} (AM|PM)/);
    expect(text).toContain('Signed in as: pat@example.com');
    expect(text).toContain('Access level: Manager');
    expect(text).toContain('Page: /documents/documents-esign (view: documents, sub: documents-esign)');
    expect(text).toContain('API: Reachable');
    expect(text).toContain('version 2.0.0');
    expect(text).toContain('Acting as: No');
    for (const bad of ['super-secret-cookie', 'secret-session-id', 'abc123', 'xyz', 'token', 'Bearer', 'vault_key', 'cookie']) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    expect(await screen.findByText(/Diagnostic info copied/)).toBeInTheDocument();
    window.history.replaceState({}, '', '/');
  });
});
