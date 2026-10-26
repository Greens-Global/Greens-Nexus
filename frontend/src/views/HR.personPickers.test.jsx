import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// HR's people fields use the Tasks people picker (Oct 25 2026): type to
// search, pick, and the field saves exactly what the old dropdown saved -
// the employee id for Log on Behalf (someone with no work email included),
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
  const data = { getEmployees: PEOPLE, getEntities: [{ id: 'co1', name: 'Greens Co' }], createLeave: { id: 'l1', status: 'pending' } };
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
  it('Log on Behalf finds a person by search and saves their employee id, work email or not', async () => {
    const { default: HR } = await import('./HR');
    render(<HR activeSub="hr-leave" onSubChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Log on Behalf/ }));
    const trigger = screen.getByRole('button', { name: /^Employee:/ });
    pick(trigger, 'sa', 'Sam Field');
    expect(trigger.textContent).toContain('Sam Field');
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2026-11-02' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    const saved = calls.find(([k]) => k === 'createLeave');
    expect(saved[1][0].employee_id).toBe('e3');
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
