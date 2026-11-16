import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The People bug pass (11/16/2026): the Access tab's change no longer throws
// into the list's save handler, the org chart keeps people whose manager is
// only off screen out of No Manager and leaves Inactive people off, a failed
// Deleted list says so (and Retry reloads it), a stat card clears the other
// filters, and search folds accents.

const person = (o) => ({ status: 'active', company: 'co1', identityType: 'internal', employmentType: 'full_time',
  compliance: {}, contractor: {}, personal: {}, jobTitle: '', department: '', managerEmail: '', ...o });
const PEOPLE = [
  person({ id: 'e1', firstName: 'Val', lastName: 'Top', workEmail: 'val@x.com', jobTitle: 'Director' }),
  person({ id: 'e2', firstName: 'Mia', lastName: 'Mid', workEmail: 'mia@x.com', managerEmail: 'val@x.com' }),
  person({ id: 'e3', firstName: 'José', lastName: 'Núñez', workEmail: 'jose@x.com', managerEmail: 'val@x.com' }),
  person({ id: 'e4', firstName: 'Nora', lastName: 'None', workEmail: 'nora@x.com' }),
  // Reports to an external - off the chart while External Users is off.
  person({ id: 'e5', firstName: 'Ned', lastName: 'Hidden', workEmail: 'ned@x.com', managerEmail: 'jane@acme.com' }),
  person({ id: 'e6', firstName: 'Ina', lastName: 'Gone', workEmail: 'ina@x.com', status: 'inactive' }),
  person({ id: 'x1', firstName: 'Jane', lastName: 'Doe', workEmail: 'jane@acme.com', identityType: 'guest', company: '' }),
];

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: false, hrScope: [], can: () => true, canAccessModule: () => true, myEmail: 'val@x.com',
    myRole: 'administrator', myGrantedModules: new Map([['hr', 'full']]), isExternal: false }),
}));
// The Access tab stands in for any access change: it calls onChanged() with
// nothing, the way people/AccessTab.jsx's refresh() does.
vi.mock('../people/AccessTab', () => ({
  default: ({ onChanged }) => <button type="button" onClick={() => onChanged?.()}>Fake Access Change</button>,
}));
const calls = [];
const fail = new Set();
vi.mock('../api', () => {
  const data = { getEmployees: PEOPLE, getEntities: [{ id: 'co1', name: 'Greens Co' }] };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      calls.push(key);
      if (fail.has(key)) return Promise.reject(new Error(`${key} failed`));
      return Promise.resolve(key in data ? data[key] : []);
    },
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); calls.length = 0; fail.clear(); try { localStorage.clear(); } catch { /* n/a */ } });

async function renderPeople() {
  const { default: HR } = await import('./HR');
  render(<HR activeSub="hr-people" onSubChange={() => {}} />);
  await screen.findAllByText('Mia Mid');
}
const count = (key) => calls.filter(k => k === key).length;

describe('People fixes (11/16/2026)', () => {
  it('an Access tab change re-reads the list instead of throwing into the save handler', async () => {
    await renderPeople();
    fireEvent.click(screen.getAllByText('Mia Mid')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    const before = count('getEmployees');
    fireEvent.click(await screen.findByRole('button', { name: 'Fake Access Change' }));
    await waitFor(() => expect(count('getEmployees')).toBeGreaterThan(before));
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  }, 20000);

  it('search folds accents: "jose nunez" finds José Núñez', async () => {
    await renderPeople();
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'jose nunez' } });
    expect(screen.getAllByText('José Núñez').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Mia Mid')).toHaveLength(0);
  }, 20000);

  it('a stat card clears the other filters, so the list matches the number clicked', async () => {
    await renderPeople();
    const box = screen.getByPlaceholderText('Search people…');
    fireEvent.change(box, { target: { value: 'nora' } });
    expect(screen.queryAllByText('Mia Mid')).toHaveLength(0);
    fireEvent.click(screen.getByTitle('See the directory'));                          // the People tile
    expect(box.value).toBe('');
    expect(screen.getAllByText('Mia Mid').length).toBeGreaterThan(0);
  }, 20000);

  it('a failed Deleted list shows the error, not "Nobody has been removed.", and Retry reloads that list', async () => {
    fail.add('getDeletedEmployees');
    await renderPeople();
    fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: '__deleted__' } });
    expect(await screen.findByText('getDeletedEmployees failed')).toBeTruthy();
    expect(screen.queryByText('Nobody has been removed.')).toBeNull();
    fail.clear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nobody has been removed.')).toBeTruthy();
    expect(count('getDeletedEmployees')).toBe(2);
  }, 20000);

  it('org chart: no Inactive people, and a manager off screen is not "no manager"', async () => {
    const { default: HR } = await import('./HR');
    render(<HR activeSub="hr-org" onSubChange={() => {}} />);
    await screen.findByText('Val Top');
    expect(screen.queryByText('Ina Gone')).toBeNull();                                // Inactive is off the chart
    const picker = (name) => document.querySelector(`[aria-label^="Reports To for ${name}:"]`);
    expect(picker('Nora None')).toBeTruthy();                                         // truly no manager: a picker
    expect(picker('Ned Hidden')).toBeNull();                                          // has a manager: no picker
    const hidden = screen.getByTestId('org-manager-hidden');
    expect(hidden.textContent).toContain('Manager Not Shown');
    expect(hidden.textContent).toContain('Ned Hidden');
    expect(screen.getByText(/1 with no manager/)).toBeTruthy();                       // Nora only
  }, 20000);
});
