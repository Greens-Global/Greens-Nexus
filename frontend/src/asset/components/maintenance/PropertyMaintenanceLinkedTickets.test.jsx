import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Ops review (Neil, Oct 20): a ticket linked to the property shows on its
// Maintenance - Open Tickets AND the Maintenance Log, next to the hand-logged
// entries - with its unit, and an open ticket never moves Last Service or
// Total Spend.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const base = { location: '', propertyId: 'pal', propertyName: 'Palisades Self Storage', onParcel: false, approvalStatus: 'none', photoCount: 0, canOpen: false, parentTicketId: '', parentCodeLabel: '' };
const AC = { ...base, id: 't29', codeLabel: 'Ticket #29', subject: 'AC not working', status: 'in_progress', priority: 'high', category: 'Heating or Cooling (HVAC)', system: 'HVAC', unit: 'Office', assigneeName: 'Rajesh', createdAt: '2026-10-18T10:00:00Z', resolvedAt: '', maintenanceRecord: false };
const DATA = { property: { id: 'pal', name: 'Palisades Self Storage', parcels: [] }, open: [AC], history: [], needsAction: [], records: [], services: [],
  spend: '0.00', spendTotals: [], canWalkthrough: false, canFollow: false, canManage: false };
vi.mock('../../../api.js', () => {
  const named = { getPropertyTickets: () => Promise.resolve(DATA) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) }) };
});
vi.mock('../shared/CollectionTable.jsx', () => ({
  CollectionTable: ({ rows, onEdit, summaryOverride }) => (
    <div data-testid="log">
      {(summaryOverride || []).map(([k, v]) => <span key={k}>{`${k}: ${v}`}</span>)}
      {rows.map((r) => (
        <div key={r.id} data-testid="log-row">
          <span>{r.ticketLabel || '-'}</span><span>{r.status}</span><span>{`unit:${r.unit || ''}`}</span>
          <button onClick={() => onEdit(r.id)}>{r.description}</button>
        </div>
      ))}
    </div>
  ),
}));

const { PropertyMaintenanceSection } = await import('./PropertyMaintenanceSection.jsx');
const PAL = { id: 'pal', name: 'Palisades Self Storage', tenantUnits: [{ label: 'Office' }] };
const props = { p: PAL, rows: [{ id: 'm1', date: '2026-09-12', system: 'HVAC', description: 'Replaced HVAC filter', cost: '$240.00', status: 'Completed' }],
  filters: {}, setFilters: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(), onSaveUnits: vi.fn(), onQuickAdd: vi.fn() };

afterEach(cleanup);

describe('Linked tickets on the property Maintenance tab', () => {
  it('an open linked ticket is in the Maintenance Log with the manual entries, with its unit', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    const row = await screen.findByText('AC not working');
    expect(screen.getByText('Replaced HVAC filter')).toBeTruthy();
    expect(screen.getByText('Ticket #29')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.getByText('unit:Office')).toBeTruthy();
    expect(screen.getByText('Records: 1')).toBeTruthy();             // the summary counts the record only
    expect(screen.getByText('Total Spend: $240.00')).toBeTruthy();
    fireEvent.click(row);
    expect(props.onEdit).not.toHaveBeenCalled();                     // opens the ticket, never the record editor
    expect(await screen.findByText('Ticket #29 · AC not working')).toBeTruthy();
    expect(screen.getAllByText('Office').length).toBeGreaterThan(0);  // the summary card's Unit
  });

  it('the Open Tickets tab lists it', async () => {
    render(<PropertyMaintenanceSection {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Open Tickets (1)' }));
    expect(screen.getByText('AC not working')).toBeTruthy();
  });
});
