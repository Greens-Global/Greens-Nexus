import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Every property-related ticket lands on the property and its unit (Neil,
// Ops review Oct 20): a building ticket must name its property, the form
// suggests it from the ticket's own words, a Cubby store's ticket names a
// unit, and the drawer has View Property.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const DEPTS = [{ id: 'd-fac', name: 'Facilities' }];
const PROPS = { properties: [{ id: 'pal', name: 'Palisades Self Storage', parentId: null, parentName: null, city: 'Dana Point', state: 'CA', units: [] }], canWalkthrough: false };
const suggestTicketProperty = vi.fn(() => Promise.resolve({ suggestions: [
  { id: 'pal', name: 'Palisades Self Storage', reason: '"26382" is in its address', unit: 'A101' }] }));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    getMyTicketDepartments: () => Promise.resolve(DEPTS), getTicketDepartments: () => Promise.resolve(DEPTS),
    getTicketProperties: () => Promise.resolve(PROPS),
    getTicketPropertyRules: () => Promise.resolve({ requiredServiceAreas: ['facilities'], requiredTopics: [] }),
    getTicketPropertyUnits: () => Promise.resolve({ units: ['A101', 'A102'], strict: true, required: true, source: 'cubby' }),
    getMyTicketAccess: () => Promise.resolve({ canWorkQueue: false }),
    suggestTicketProperty,
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 'tk1', propertyAssetId: 'pal' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal } = await import('./TicketsView');
const { TicketPropertyDetail } = await import('./TicketPropertyFields');
const { propertyRequiredFor } = await import('./ticketPropertyLink');
const { HELP_TOPICS } = await import('./ticketMeta');
HELP_TOPICS.push({ label: 'Construction & Maintenance', departments: ['facilities'],
  topics: [{ name: 'Heating or Cooling (HVAC)', area: 'facilities' }, { name: 'Signs', area: 'general' }] });

afterEach(() => { cleanup(); createTicket.mockClear(); });

describe('Property and Unit on Create a Ticket', () => {
  it('a building ticket must name its property, suggested from its words, with its unit', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    fireEvent.click(await screen.findByText('Select department'));
    fireEvent.click(await screen.findByText('Facilities'));
    fireEvent.change(title, { target: { value: 'AC not working - 26382 palisades cabana tenant' } });
    fireEvent.click(screen.getByText('Select one'));
    fireEvent.click(await screen.findByText('Heating or Cooling (HVAC)'));
    expect(screen.getByText(/Required for building and maintenance tickets/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).not.toHaveBeenCalled();                 // no property yet
    // "Looks like" from the title - one click takes the property and the unit.
    expect(await screen.findByText(/Looks like/, {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByText(/"26382" is in its address/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use It' }));
    expect(await screen.findByText(/From the store's units in Cubby/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0]).toMatchObject({ hrDepartmentId: 'd-fac', propertyAssetId: 'pal', propertyUnit: 'A101' });
  });

  it('the rule follows the config list', () => {
    const rules = { requiredServiceAreas: ['facilities'], requiredTopics: ['Signs'] };
    expect(propertyRequiredFor(rules, 'Heating or Cooling (HVAC)')).toBe(true);
    expect(propertyRequiredFor(rules, 'signs')).toBe(true);
    expect(propertyRequiredFor({ requiredServiceAreas: [], requiredTopics: [] }, 'Heating or Cooling (HVAC)')).toBe(false);
    expect(propertyRequiredFor(rules, '')).toBe(false);
  });
});

describe('The ticket drawer', () => {
  it('shows the unit and opens the property', async () => {
    const seen = vi.fn();
    window.addEventListener('nexus:navigate', seen);
    render(<TicketPropertyDetail v={{ id: 'tk1', status: 'in_progress', propertyAssetId: 'pal', propertyName: 'Palisades Self Storage', propertyUnit: 'A101' }} />);
    expect(screen.getByText('A101')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /View Property - Palisades Self Storage/ }));
    expect(seen.mock.calls[0][0].detail).toEqual({ view: 'property-asset', sub: 'tickets:pal' });
    window.removeEventListener('nexus:navigate', seen);
  });

  it('shows nothing for a ticket with no property', () => {
    const { container } = render(<TicketPropertyDetail v={{ id: 'tk2', status: 'open' }} />);
    expect(container.textContent).toBe('');
  });
});
