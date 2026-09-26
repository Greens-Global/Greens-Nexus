import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings -> Tools: each card is gated like its backend route (hidden, never
// disabled), and the Act As list pages ten people at a time.

const people = Array.from({ length: 23 }, (_, i) => ({
  name: `Person ${String(i + 1).padStart(2, '0')}`, email: `p${i + 1}@example.com`,
}));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => (key === 'getActAsEligibleTargets'
      ? vi.fn(() => Promise.resolve(people))
      : vi.fn(() => Promise.resolve({}))),
  }),
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

  it('shows a supervisor neither Act As nor the directory sync', () => {
    roleState.value = makeRole('supervisor');
    render(<SettingsTools />);
    expect(screen.queryByTestId('tool-act-as')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-m365')).not.toBeInTheDocument();
  });

  it('gives a manager Act As, but not the directory sync', () => {
    roleState.value = makeRole('manager');
    render(<SettingsTools />);
    expect(screen.getByTestId('tool-act-as')).toBeInTheDocument();
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

  it('pages the Act As list ten at a time', async () => {
    roleState.value = makeRole('manager');
    render(<SettingsTools />);
    expect(await screen.findByText('Person 01')).toBeInTheDocument();
    expect(screen.getByText('Person 10')).toBeInTheDocument();
    expect(screen.queryByText('Person 11')).not.toBeInTheDocument();
    expect(screen.getByText('1-10 of 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Person 11')).toBeInTheDocument();
    expect(screen.queryByText('Person 01')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('21-23 of 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    // A search starts again from the first page.
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'Person 0' } });
    expect(screen.getByText('Person 01')).toBeInTheDocument();
    expect(screen.queryByText(/of 9/)).not.toBeInTheDocument();   // 9 matches fit on one page
  });

  it('lets someone who is acting as another person exit', async () => {
    roleState.value = makeRole('manager', { actingAs: { targetName: 'Sam Lee', targetEmail: 'sam@example.com' } });
    render(<SettingsTools />);
    fireEvent.click(screen.getByRole('button', { name: /Exit Act As/ }));
    await waitFor(() => expect(roleState.value.stopActAs).toHaveBeenCalled());
  });
});
