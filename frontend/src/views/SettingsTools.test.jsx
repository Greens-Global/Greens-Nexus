import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Settings -> Tools: each card is gated like its backend route (hidden, never
// disabled). Act As lives in the profile menu (components/ToolsMenu.jsx).

vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve({})) }),
}));

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
    myRole, hrScope, actingAs, can, myGrantedModules,
    canAccessModule: (id, minRole, lvl = 'viewer') => (!minRole || can(minRole)) || (RANK[myGrantedModules.get(id)] ?? 0) >= RANK[lvl],
    startActAs: vi.fn(), stopActAs: vi.fn(() => Promise.resolve()),
  };
}

const SettingsTools = (await import('./SettingsTools')).default;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SettingsTools', () => {
  it('has no troubleshooting card', () => {
    roleState.value = makeRole('administrator');
    render(<SettingsTools />);
    expect(screen.queryByText('Troubleshooting')).not.toBeInTheDocument();
    expect(screen.queryByText(/Diagnostic/)).not.toBeInTheDocument();
  });

  it('has no Act As card - it moved to the profile menu', () => {
    roleState.value = makeRole('manager');
    render(<SettingsTools />);
    expect(screen.queryByTestId('tool-act-as')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-m365')).not.toBeInTheDocument();
    expect(screen.getByText('No tools here for your access.')).toBeInTheDocument();
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
});
