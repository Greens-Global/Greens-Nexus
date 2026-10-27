import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// HR's people fields use the Tasks people picker (Oct 25 2026): type to
// search, pick, and the field saves exactly what the old dropdown saved -
// the lowercased email for Reports To.

const PEOPLE = [
  { id: 'e1', firstName: 'Val', lastName: 'Top', workEmail: 'Val@X.com', managerEmail: '', status: 'active',
    jobTitle: 'Director', department: 'Operations', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
  { id: 'e2', firstName: 'Mia', lastName: 'Mid', workEmail: 'mia@x.com', managerEmail: 'val@x.com', status: 'active',
    jobTitle: 'Lead', department: 'Maintenance', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
  { id: 'e3', firstName: 'Sam', lastName: 'Field', workEmail: '', managerEmail: 'mia@x.com', status: 'active',
    jobTitle: 'Technician', department: 'Maintenance', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
];

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: false, hrScope: [], can: () => true, canAccessModule: () => true, myEmail: 'val@x.com',
    myRole: 'administrator', myGrantedModules: new Map([['hr', 'full']]), isExternal: false }),
}));
const calls = [];
vi.mock('../api', () => {
  const data = { getEmployees: PEOPLE, getEntities: [{ id: 'co1', name: 'Greens Co' }] };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push([key, args]); return Promise.resolve(key in data ? data[key] : []); },
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); calls.length = 0; try { localStorage.clear(); } catch { /* n/a */ } });

const pick = (trigger, query, name) => {
  fireEvent.click(trigger);
  // The menu's own search box (the org chart has a search of its own).
  fireEvent.change(screen.getByRole('listbox').parentElement.querySelector('input'), { target: { value: query } });
  fireEvent.click(within(screen.getByRole('listbox')).getByText(name));
};

describe('HR people pickers', () => {
  // The People > Leave tab is retired (Oct 27 2026): an old link lands on
  // Time > Time Off, and nothing offers the legacy Log on Behalf form.
  it('an old Leave link lands on Time Off and the Leave tab is gone', async () => {
    const { default: HR } = await import('./HR');
    render(<HR activeSub="hr-leave" onSubChange={() => {}} />);
    // The Time Off view's own controls: Request on Behalf and the calendar.
    expect(await screen.findByRole('button', { name: /Request on Behalf/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Team Leave Calendar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Log on Behalf/ })).toBeNull();
    expect(calls.some(([k]) => k === 'createLeave' || k === 'getLeave')).toBe(false);
  }, 20000);

  it('Reports To on the org chart searches and saves the lowercased work email', async () => {
    const { default: HR } = await import('./HR');
    render(<HR activeSub="hr-org" onSubChange={() => {}} />);
    await screen.findByText('Val Top');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.pointerDown(screen.getByText('Sam Field').closest('[data-orgtile]'), { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    const trigger = screen.getByRole('button', { name: /^Reports To:/ });
    expect(trigger.textContent).toContain('Mia Mid');
    pick(trigger, 'val', 'Val Top');
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    const saved = calls.find(([k]) => k === 'updateEmployee');
    expect(saved[1][0]).toBe('e3');
    expect(saved[1][1].manager_email).toBe('val@x.com');
  }, 20000);
});
