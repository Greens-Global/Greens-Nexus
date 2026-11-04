import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// The org chart (Neil, Oct 14 2026): every card is four lines - Name, Role,
// Department, Company - and external users are an option on the chart
// ("External Users", off by default, remembered per device) with a clear
// External designation on their card and their own company on the company
// line. The side panel only shows; the record edits.

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

  // The side panel is read only (Neil, 11/03/2026): changes are made on the
  // record, which Open Record opens on its Job tab.
  const rowValue = (label) => screen.getByText(label, { selector: 'span' }).nextElementSibling.textContent;
  it('the option is remembered, and an external shows their own company - read only, with Open Record', async () => {
    localStorage.setItem('nx-orgchart-externals', 'true');
    const onSubChange = vi.fn();
    const { default: HR } = await import('./HR');
    render(<HR activeSub="hr-org" onSubChange={onSubChange} />);
    await screen.findByText('Val Top');
    fireEvent.click(screen.getByRole('button', { name: 'Expand All' }));   // seeded view folds the second level once it has reports
    // A tap = pointer down on the card, pointer up with no movement.
    fireEvent.pointerDown(cardOf('Jane Doe'), { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(rowValue('Reports To')).toContain('Mia Mid');
    expect(rowValue('Company')).toBe('Acme Construction');
    expect(screen.queryByRole('button', { name: /Save changes/i })).toBeNull();
    expect(screen.queryByDisplayValue('Acme Construction')).toBeNull();   // nothing to type into
    fireEvent.click(screen.getByRole('button', { name: /Open Record/ }));
    expect(onSubChange).toHaveBeenCalledWith('hr-people');
    expect(calls.some(([k]) => k === 'updateEmployee')).toBe(false);
  }, 20000);

  it('the company filter keeps an external with the company they report into; an internal shows its company by name', async () => {
    localStorage.setItem('nx-orgchart-externals', 'true');
    await renderChart();
    fireEvent.change(screen.getByDisplayValue('All Companies'), { target: { value: 'co1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand All' }));
    expect(screen.getByText('Jane Doe')).toBeTruthy();                       // reports into Greens Co
    fireEvent.pointerDown(cardOf('Mia Mid'), { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(rowValue('Company')).toBe('Greens Co');
    expect(rowValue('Job Title')).toBe('Lead');
    expect(screen.getByText('Direct Reports (1)')).toBeTruthy();
  }, 20000);

  it('with the option off, an internal who reports to an external still shows that manager', async () => {
    PEOPLE[1].managerEmail = 'jane@acme.com';   // Mia reports to Jane
    try {
      await renderChart();
      fireEvent.pointerDown(cardOf('Mia Mid'), { clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
      expect(rowValue('Reports To')).toContain('Jane');
    } finally { PEOPLE[1].managerEmail = 'val@x.com'; }
  }, 20000);
});

// The pass of 11/03/2026 (Neil: "still very average").
describe('Organizational Chart pass', () => {
  it('a division reaches everyone under its lead - on the panel and in the legend count', async () => {
    PEOPLE[0].division = 'Operations';   // Val leads Operations; Mia reports to Val
    try {
      await renderChart();
      const legend = screen.getByRole('group', { name: 'Divisions' });
      expect(within(legend).getByRole('button', { name: /Operations/ }).textContent).toContain('2');   // Val and Mia, not 1
      fireEvent.pointerDown(cardOf('Mia Mid'), { clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
      expect(screen.getByText('Division', { selector: 'span' }).nextElementSibling.textContent).toBe('Operations (from their manager)');
    } finally { delete PEOPLE[0].division; }
  }, 20000);

  it('search finds by name or title and Enter steps through every match', async () => {
    await renderChart();
    const box = screen.getByRole('textbox', { name: 'Find a person on the chart' });
    fireEvent.change(box, { target: { value: 'i' } });           // Val (Director), Mia
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText('2 of 2')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No match')).toBeTruthy();
  }, 20000);

  it('a card is a keyboard stop: Enter opens the person, and the open person stays marked', async () => {
    await renderChart();
    const card = cardOf('Val Top');
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /Open Record/ })).toBeTruthy();
    expect(card.getAttribute('aria-pressed')).toBe('true');
  }, 20000);
});
