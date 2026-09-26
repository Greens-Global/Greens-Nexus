import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings -> Tools: each card is gated like its backend route (hidden, never
// disabled), the API check runs on arrival, and Copy Diagnostic Info never
// carries secrets.

vi.mock('../api', () => ({
  API_BASE: 'https://api.example.test',
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve({})) }),
}));
vi.mock('../components/ActAsModal', () => ({ ActAsPicker: () => <div>Person picker</div> }));

const roleState = { value: null };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => roleState.value };
});

const LEVEL = { employee: 1, supervisor: 2, manager: 3, administrator: 4, owner: 5 };
function makeRole(myRole, { grants = {}, hrScope = null, actingAs = null } = {}) {
  const myGrantedModules = new Map(Object.entries(grants));
  const can = (min) => LEVEL[myRole] >= (LEVEL[min] ?? 1);
  const RANK = { viewer: 1, editor: 2, full: 3, owner: 4 };
  return {
    myRole, realEmail: 'pat@example.com', isExternal: false, hrScope, actingAs,
    can, myGrantedModules,
    canAccessModule: (id, minRole, lvl = 'viewer') => (!minRole || can(minRole)) || (RANK[myGrantedModules.get(id)] ?? 0) >= RANK[lvl],
    startActAs: vi.fn(), stopActAs: vi.fn(() => Promise.resolve()),
  };
}

const SettingsTools = (await import('./SettingsTools')).default;

beforeEach(() => {
  globalThis.fetch = vi.fn((url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(String(url).endsWith('/version') ? { version: '2.0.0' } : { status: 'ok' }),
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SettingsTools', () => {
  it('shows a supervisor only Troubleshooting', async () => {
    roleState.value = makeRole('supervisor');
    render(<SettingsTools />);
    expect(screen.queryByTestId('tool-act-as')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-m365')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-troubleshooting')).toBeInTheDocument();
    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText('2.0.0')).toBeInTheDocument();
  });

  it('gives a manager Act As, but not the directory sync', async () => {
    roleState.value = makeRole('manager');
    render(<SettingsTools />);
    expect(screen.getByTestId('tool-act-as')).toBeInTheDocument();
    expect(await screen.findByText('Person picker')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-m365')).not.toBeInTheDocument();
  });

  it('gives an IT Admin the directory sync, unless their People access is company-limited', () => {
    roleState.value = makeRole('administrator');
    render(<SettingsTools />);
    expect(screen.getByRole('button', { name: /Sync Now/ })).toBeEnabled();
    cleanup();
    roleState.value = makeRole('administrator', { hrScope: ['ent-a'] });
    render(<SettingsTools />);
    expect(screen.queryByTestId('tool-m365')).not.toBeInTheDocument();
  });

  it('lets someone who is acting as another person exit', async () => {
    roleState.value = makeRole('manager', { actingAs: { targetName: 'Sam Lee', targetEmail: 'sam@example.com' } });
    render(<SettingsTools />);
    fireEvent.click(screen.getByRole('button', { name: /Exit Act As/ }));
    await waitFor(() => expect(roleState.value.stopActAs).toHaveBeenCalled());
  });

  it('copies diagnostic info without cookies, query strings or tokens', async () => {
    roleState.value = makeRole('administrator');
    window.history.pushState({}, '', '/admin-console/tools?request=secret-token#frag');
    document.cookie = 'session=abc123';
    let copied = '';
    const writeText = vi.fn((t) => { copied = t; return Promise.resolve(); });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const prevItem = window.ClipboardItem;
    window.ClipboardItem = undefined;
    const toastOk = vi.fn();
    render(<SettingsTools toastOk={toastOk} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy Diagnostic Info/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(copied).toContain('Nexus Diagnostic Info');
    expect(copied).toContain('Signed in as: pat@example.com');
    expect(copied).toContain('Page: /admin-console/tools');
    expect(copied).not.toMatch(/secret-token|abc123|session=|Bearer|token/i);
    expect(toastOk).toHaveBeenCalled();
    window.ClipboardItem = prevItem;
    window.history.pushState({}, '', '/');
  });
});
