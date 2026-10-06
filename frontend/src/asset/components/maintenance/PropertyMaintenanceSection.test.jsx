import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Property Tickets (Neil, 10/05): a property's Maintenance shows its open
// tickets, its closed ones as maintenance history (and as read-only rows in
// the Maintenance Log), and raises new tickets for THIS property only.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const DATA = {
  property: { id: 'gst', name: 'Greens Storage Temecula', parcels: [] },
  open: [{ id: 't1', codeLabel: 'Ticket #101', subject: 'Broken handrail', status: 'open', priority: 'high', category: 'Railings or Stairs',
    location: '', propertyId: 'gst', propertyName: 'Greens Storage Temecula', onParcel: false, assigneeName: '', approvalStatus: 'none',
    createdAt: '2026-10-06T10:00:00Z', resolvedAt: '', photoCount: 0, maintenanceRecord: false, canOpen: false }],
  history: [{ id: 't2', codeLabel: 'Ticket #100', subject: 'Leak under sink', status: 'resolved', priority: 'medium', category: 'Plumbing or Water Leak',
    system: 'Plumbing', location: '', propertyId: 'gst', propertyName: 'Greens Storage Temecula', onParcel: false, assigneeName: 'Visesh',
    approvalStatus: 'none', createdAt: '2026-10-01T10:00:00Z', resolvedAt: '2026-10-02T10:00:00Z', resolutionNote: 'Replaced the trap',
    vendor: 'ABC Plumbing', cost: '180.00', photoCount: 1, maintenanceRecord: true, canOpen: false }],
  spend: '180.00', canWalkthrough: true, canFollow: false,
};
vi.mock('../../../api.js', () => {
  const named = { getPropertyTickets: () => Promise.resolve(DATA) };
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
  it('merges closed tickets into the log as read-only maintenance records', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    expect(await screen.findByText('Leak under sink - Replaced the trap')).toBeTruthy();
    expect(screen.getByText('Replaced HVAC filter')).toBeTruthy();
    fireEvent.click(screen.getByText('Leak under sink - Replaced the trap'));
    expect(props.onEdit).not.toHaveBeenCalled();                 // a ticket row never opens the record editor
    expect(await screen.findByText('Ticket #100 · Leak under sink')).toBeTruthy();   // its summary instead
  });

  it('lists open and closed tickets with counts, and offers create and walkthrough', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Open Tickets (1)' }));
    expect(screen.getByText('Broken handrail')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Closed Tickets (1)' }));
    expect(screen.getByText('Replaced the trap')).toBeTruthy();
    expect(screen.getByText('$180.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create New Ticket' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Walkthrough' })).toBeTruthy();
  });

  it('a viewer who cannot open a ticket gets its summary, without Follow', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Open Tickets (1)' }));
    fireEvent.click(screen.getByText('Broken handrail'));
    expect(await screen.findByText('Ticket #101 · Broken handrail')).toBeTruthy();
    expect(screen.queryByText('Follow This Ticket')).toBeNull();
  });

  it('a bell deep link opens the property on its open tickets', async () => {
    render(<PropertyMaintenanceSection {...props} ticketFocus={{ propertyId: 'gst', ticketId: 't1', at: 1 }} />);
    expect(await screen.findByText('Ticket #101 · Broken handrail')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Open Tickets (1)' }).getAttribute('aria-selected')).toBe('true');
  });
});
