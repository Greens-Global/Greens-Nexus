import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Property Tickets (Neil, 10/05): a ticket for a building or site team can
// name the Asset Management property it is about; other teams are never
// asked. Raised from a property, the form starts on the building team with
// the property set. Resolving a property ticket takes an optional vendor and
// cost for the property's maintenance record.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const DEPTS = [{ id: 'd-hr', name: 'Human Resources' }, { id: 'd-fac', name: 'Facilities' }];
const PROPS = { properties: [{ id: 'gst', name: 'Greens Storage Temecula', parentId: null, parentName: null, city: 'Temecula', state: 'CA', units: [] }], canWalkthrough: false };
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    getMyTicketDepartments: () => Promise.resolve(DEPTS), getTicketDepartments: () => Promise.resolve(DEPTS),
    getTicketProperties: () => Promise.resolve(PROPS),
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
const createTicket = vi.fn(() => Promise.resolve({ id: 'tk1', propertyAssetId: 'gst' }));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }),
}));

const { CreateTicketModal, TicketActionDialog } = await import('./TicketsView');
const { HELP_TOPICS } = await import('./ticketMeta');
// Normally loaded from the admin's taxonomy (ticketConfig.js): the building
// team's topics file under the facilities area, HR's under none.
HELP_TOPICS.push(
  { label: 'Construction & Maintenance', departments: ['facilities'], topics: [{ name: 'Painting', area: 'facilities' }] },
  { label: 'HR', departments: ['human resources'], topics: [{ name: 'Benefits', area: 'general' }] },
);

afterEach(() => { cleanup(); createTicket.mockClear(); });

const pickDept = async (name) => {
  fireEvent.click(await screen.findByText('Select department'));
  fireEvent.click(await screen.findByText(name));
};

describe('Property on a ticket', () => {
  it('is asked only for a building or site team', async () => {
    render(<CreateTicketModal onClose={vi.fn()} />);
    await screen.findByPlaceholderText(/What is the issue\?/);
    expect(screen.queryByText('Property')).toBeNull();
    await pickDept('Human Resources');
    expect(screen.queryByText('Property')).toBeNull();
    fireEvent.click(screen.getByText('Human Resources'));
    fireEvent.click(await screen.findByText('Facilities'));
    expect(await screen.findByText('Property')).toBeTruthy();
    expect(screen.getByText(/shows on that property in Asset Management/)).toBeTruthy();
  });

  it('raised from a property: starts on the building team and links the ticket', async () => {
    const onClose = vi.fn();
    render(<CreateTicketModal onClose={onClose} forProperty={{ id: 'gst', name: 'Greens Storage Temecula' }} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    expect(await screen.findByText(/Shows on Greens Storage Temecula's Maintenance/)).toBeTruthy();
    fireEvent.change(title, { target: { value: 'Broken handrail' } });
    fireEvent.click(screen.getByText('Select one'));
    fireEvent.click(await screen.findByText('Painting'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0]).toMatchObject({ hrDepartmentId: 'd-fac', propertyAssetId: 'gst' });
  });
});

describe('Resolving a property ticket', () => {
  const TICKET = { id: 'tk1', code: '000412', subject: 'Leak', propertyAssetId: 'gst', propertyName: 'Greens Storage Temecula' };

  it('takes an optional vendor and cost for the maintenance record', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<TicketActionDialog mode="resolve" ticket={TICKET} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/What was done to fix it/), { target: { value: 'Replaced the trap' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. ABC Plumbing'), { target: { value: 'ABC Plumbing' } });
    const cost = screen.getByPlaceholderText('$0.00');
    fireEvent.change(cost, { target: { value: 'about 300' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Resolved' })); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('An amount like 1250.50')).toBeTruthy();
    fireEvent.change(cost, { target: { value: '$1,250.50' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Resolved' })); });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'resolved', resolutionNote: 'Replaced the trap', maintenanceVendor: 'ABC Plumbing', maintenanceCost: '$1,250.50',
    }));
  });

  it('asks nothing extra for a ticket with no property', () => {
    render(<TicketActionDialog mode="resolve" ticket={{ ...TICKET, propertyAssetId: '' }} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByPlaceholderText('$0.00')).toBeNull();
  });
});
