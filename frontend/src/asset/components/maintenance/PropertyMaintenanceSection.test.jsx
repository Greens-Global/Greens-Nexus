import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Property Tickets (Neil 10/05, Pranshu 10/06): a property's Maintenance shows
// what needs the asset manager's action (resolved, not yet recorded), its open
// and closed tickets, recorded tickets as read-only rows in the log, and each
// recurring service with its child tickets - and raises new tickets for THIS
// property only.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const base = { location: '', propertyId: 'gst', propertyName: 'Greens Storage Temecula', onParcel: false, approvalStatus: 'none', photoCount: 0, canOpen: false, parentTicketId: '', parentCodeLabel: '' };
const OPEN = { ...base, id: 't1', codeLabel: 'Ticket #101', subject: 'Broken handrail', status: 'open', priority: 'high', category: 'Railings or Stairs', assigneeName: '', createdAt: '2026-10-06T10:00:00Z', resolvedAt: '', maintenanceRecord: false };
const LOGGED = { ...base, id: 't2', codeLabel: 'Ticket #100', subject: 'Leak under sink', status: 'closed', priority: 'medium', category: 'Plumbing or Water Leak', system: 'Plumbing', assigneeName: 'Visesh', createdAt: '2026-10-01T10:00:00Z', resolvedAt: '2026-10-02T10:00:00Z', resolutionNote: 'Replaced the trap', vendor: 'ABC Plumbing', cost: '180.00', maintenanceRecord: true, logged: true, needsAction: false };
const WAITING = { ...base, id: 't3', codeLabel: 'Ticket #102', subject: 'Office AC warm', status: 'resolved', priority: 'urgent', category: 'Heating or Cooling (HVAC)', system: 'HVAC', assigneeName: 'Sagar', createdAt: '2026-10-03T10:00:00Z', resolvedAt: '2026-10-04T10:00:00Z', resolutionNote: 'Recharged refrigerant', vendor: 'CoolAir', cost: '1240.50', maintenanceRecord: true, logged: false, needsAction: true };
const DATA = {
  property: { id: 'gst', name: 'Greens Storage Temecula', parcels: [] },
  open: [OPEN], history: [WAITING, LOGGED], needsAction: [WAITING],
  records: [{ id: 'r1', ticketId: 't2', codeLabel: 'Ticket #100', subject: 'Leak under sink', propertyId: 'gst', date: '2026-10-02', system: 'Plumbing', description: 'Leak under sink - Replaced the trap', vendor: 'ABC Plumbing', cost: '180.00', docUrl: '', docName: '', notes: '', parentTicketId: '', parentCodeLabel: '' }],
  services: [{ id: 's1', parentTicketId: 't2', parentCodeLabel: 'Ticket #100', subject: 'Leak under sink', system: 'Plumbing', nextDue: '2027-10-02', recurrenceUnit: 'year', recurrenceEvery: 1, recurrenceLabel: 'Every Year', active: true, totalCost: '380.00',
    tickets: [{ id: 't2', codeLabel: 'Ticket #100', status: 'closed', isParent: true, date: '2026-10-02', cost: '180.00', vendor: 'ABC Plumbing', logged: true },
      { id: 't9', codeLabel: 'Ticket #140', status: 'closed', isParent: false, date: '2027-10-02', cost: '200.00', vendor: 'ABC Plumbing', logged: true }] }],
  spend: '180.00', canWalkthrough: true, canFollow: true, canManage: true,
};
const addMaintenanceRecord = vi.fn(() => Promise.resolve({ recordId: 'r2' }));
vi.mock('../../../api.js', () => {
  const named = { getPropertyTickets: () => Promise.resolve(DATA), addMaintenanceRecord };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) }) };
});
vi.mock('../shared/CollectionTable.jsx', () => ({
  CollectionTable: ({ rows, onEdit }) => (
    <div data-testid="log">{rows.map((r) => <button key={r.id} onClick={() => onEdit(r.id)}>{r.description}</button>)}</div>
  ),
}));

const { PropertyMaintenanceSection } = await import('./PropertyMaintenanceSection.jsx');
const GST = { id: 'gst', name: 'Greens Storage Temecula', tenantUnits: [] };
const props = { p: GST, rows: [{ id: 'm1', description: 'Replaced HVAC filter' }], filters: {}, setFilters: vi.fn(),
  onAdd: vi.fn(), onEdit: vi.fn(), onSaveUnits: vi.fn(), onQuickAdd: vi.fn() };

afterEach(cleanup);

describe('Property Maintenance with tickets', () => {
  it('shows recorded tickets in the log as read-only rows, next to hand-logged ones', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    expect(await screen.findByText('Leak under sink - Replaced the trap')).toBeTruthy();
    expect(screen.getByText('Replaced HVAC filter')).toBeTruthy();
    expect(screen.queryByText(/Office AC warm/)).toBeNull();       // resolved but not recorded: not in the log
    fireEvent.click(screen.getByText('Leak under sink - Replaced the trap'));
    expect(props.onEdit).not.toHaveBeenCalled();                    // a ticket row never opens the record editor
    expect(await screen.findByText('Ticket #100 · Leak under sink')).toBeTruthy();
  });

  it('Needs Action adds a resolved ticket to the record - no status, schedule optional', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Needs Action/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Maintenance Record' }));
    expect(await screen.findByText('Add to Maintenance Record · Ticket #102')).toBeTruthy();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.getByDisplayValue('CoolAir')).toBeTruthy();       // prefilled from the ticket
    expect(screen.getByText('Next Service Due')).toBeTruthy();       // the original ticket may schedule the next
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Add to Maintenance Record' }).at(-1)); });
    expect(addMaintenanceRecord).toHaveBeenCalledWith('gst', 't3', expect.objectContaining({ system: 'HVAC', vendor: 'CoolAir', cost: '1240.50' }));
    expect(addMaintenanceRecord.mock.calls[0][2].next_service_due).toBeUndefined();
  });

  it('a recurring service lists the original and every child with date, cost and total', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Recurring Services/ }));
    expect(screen.getByText('Every Year')).toBeTruthy();
    expect(screen.getByText('(Original)')).toBeTruthy();
    expect(screen.getByText('Ticket #140')).toBeTruthy();
    expect(screen.getAllByText('$380.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open Ticket Now' })).toBeTruthy();
  });

  it('lists open and closed tickets, and offers create and walkthrough', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Open Tickets (1)' }));
    expect(screen.getByText('Broken handrail')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Closed Tickets (2)' }));
    expect(screen.getAllByText('Recorded').length).toBe(2);         // the count, and the chip on Ticket #100
    expect(screen.getAllByText('Needs Action').length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Create New Ticket' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Walkthrough' })).toBeTruthy();
  });

  it('a "needs action" bell link opens the property on Needs Action', async () => {
    render(<PropertyMaintenanceSection {...props} ticketFocus={{ propertyId: 'gst', ticketId: null, tab: 'needs-action', at: 1 }} />);
    expect((await screen.findByRole('tab', { name: /Needs Action/ })).getAttribute('aria-selected')).toBe('true');
  });
});
