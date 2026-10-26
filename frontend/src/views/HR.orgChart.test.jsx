import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// The org chart (Neil, Oct 14 2026): every card is four lines - Name, Role,
// Department, Company - and external users are an option on the chart
// ("External Users", off by default, remembered per device) with a clear
// External designation on their card and their own company on the company
// line. Their reporting line is edited like anyone else's.

const PEOPLE = [
  { id: 'e1', firstName: 'Val', lastName: 'Top', workEmail: 'val@x.com', managerEmail: '', status: 'active',
    jobTitle: 'Director', department: 'Operations', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
  { id: 'e2', firstName: 'Mia', lastName: 'Mid', workEmail: 'mia@x.com', managerEmail: 'val@x.com', status: 'active',
    jobTitle: 'Lead', department: 'Maintenance', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
  { id: 'x1', firstName: 'Jane', lastName: 'Doe', workEmail: 'jane@acme.com', managerEmail: 'mia@x.com', status: 'active',
    jobTitle: 'Site Foreman', department: 'Field', company: '', externalCompany: 'Acme Construction', identityType: 'guest', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
  { id: 'x2', firstName: 'Gone', lastName: 'Guest', workEmail: 'gone@acme.com', managerEmail: '', status: 'inactive',
    jobTitle: '', department: '', company: '', externalCompany: 'Acme Construction', identityType: 'external', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} },
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

async function renderChart() {
  const { default: HR } = await import('./HR');
  render(<HR activeSub="hr-org" onSubChange={() => {}} />);
  await screen.findByText('Val Top');
}
const cardOf = (name) => screen.getByText(name).closest('[data-orgtile]');   // the tappable tile, not the subtree wrapper

describe('Org chart externals and four-line cards', () => {
  it('a card is four lines: name, role, department, company', async () => {
    await renderChart();
    const card = cardOf('Mia Mid');
    const lines = within(card);
    expect(lines.getByText('Lead')).toBeTruthy();
    expect(lines.getByText('Maintenance')).toBeTruthy();
    expect(lines.getByText('Greens Co')).toBeTruthy();
    expect(within(card).queryByText(/Maintenance · Greens Co/)).toBeNull();   // no longer joined on one line
  }, 20000);

  it('externals are off the chart until the External Users option is on, then wear the designation and their own company', async () => {
    await renderChart();
    expect(screen.queryByText('Jane Doe')).toBeNull();
    const toggle = screen.getByRole('checkbox', { name: /External Users/ });
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('1', { selector: 'label span' })).toBeTruthy();   // one active external; the deactivated one is not counted
    fireEvent.click(toggle);
    const card = cardOf('Jane Doe');
    expect(within(card).getByText('External')).toBeTruthy();
    expect(within(card).getByText('Site Foreman')).toBeTruthy();
    expect(within(card).getByText('Field')).toBeTruthy();
    expect(within(card).getByText('Acme Construction')).toBeTruthy();
    expect(screen.queryByText('Gone Guest')).toBeNull();
    expect(localStorage.getItem('nx-orgchart-externals')).toBe('true');       // remembered per device
  }, 20000);

  it('the option is remembered, and an external edits like anyone else - with their own company as text', async () => {
    localStorage.setItem('nx-orgchart-externals', 'true');
    await renderChart();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));   // seeded view folds the second level once it has reports
    // A tap = pointer down on the card, pointer up with no movement.
    fireEvent.pointerDown(cardOf('Jane Doe'), { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    const panel = screen.getByText('Reports to').closest('div');
    expect(within(panel).getByDisplayValue('Acme Construction')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^Reports To:/ }).textContent).toContain('Mia Mid');
    fireEvent.change(within(panel).getByDisplayValue('Acme Construction'), { target: { value: 'Acme Builders' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    const saved = calls.find(([k]) => k === 'updateEmployee');
    expect(saved[1][0]).toBe('x1');
    expect(saved[1][1].external_company).toBe('Acme Builders');
  }, 20000);

  it('the company filter keeps an external with the company they report into; an internal save carries no outside company', async () => {
    localStorage.setItem('nx-orgchart-externals', 'true');
    await renderChart();
    fireEvent.change(screen.getByDisplayValue('All companies'), { target: { value: 'co1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('Jane Doe')).toBeTruthy();                       // reports into Greens Co
    fireEvent.pointerDown(cardOf('Mia Mid'), { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    const panel = screen.getByText('Reports to').closest('div');
    expect(within(panel).queryByDisplayValue('Acme Construction')).toBeNull();   // entity picker, not free text
    fireEvent.change(within(panel).getByDisplayValue('Lead'), { target: { value: 'Senior Lead' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    const saved = calls.find(([k]) => k === 'updateEmployee');
    expect(saved[1][1].job_title).toBe('Senior Lead');
    expect('external_company' in saved[1][1]).toBe(false);
  }, 20000);

  it('with the option off, an internal who reports to an external keeps that manager selectable', async () => {
    PEOPLE[1].managerEmail = 'jane@acme.com';   // Mia reports to Jane
    try {
      await renderChart();
      fireEvent.pointerDown(cardOf('Mia Mid'), { clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
      const panel = screen.getByText('Reports to').closest('div');
      const trigger = within(panel).getByRole('button', { name: /^Reports To:/ });
      expect(trigger.textContent).toContain('Jane Doe');
      fireEvent.click(trigger);
      expect(within(screen.getByRole('listbox')).getByText('Jane Doe')).toBeTruthy();
    } finally { PEOPLE[1].managerEmail = 'val@x.com'; }
  }, 20000);
});
