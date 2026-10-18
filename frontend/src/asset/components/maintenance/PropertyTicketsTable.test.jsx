import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// A property's tickets for a read-only viewer (backend #643): latestComment
// comes back null and resolutionNote / vendor / cost blank or null. The table
// and the summary must render them as nothing - never "null", never a crash.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../../../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../../../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));

const { PropertyTicketsTable } = await import('./PropertyTicketsTable');
const { TicketSummaryModal } = await import('./PropertyTicketsPanel');
const { historyCsv } = await import('../../lib/propertyTickets.js');

afterEach(() => cleanup());

const ROW = {
  id: 't1', code: '000012', codeLabel: 'Ticket #12', subject: 'Leaking roof', status: 'closed',
  assigneeEmail: null, assigneeName: null, createdAt: '2026-10-01T10:00:00', modifiedAt: null,
  latestComment: null, resolutionNote: null, vendor: '', cost: null, resolvedAt: null, maintenanceRecord: true,
};

describe('Property tickets - read-only fields', () => {
  it('renders a row with a null latest comment and blank resolution fields', () => {
    const { container } = render(<PropertyTicketsTable rows={[ROW]} onOpen={() => {}} tableKey="test-property-tickets" />);
    expect(screen.getByText('Leaking roof')).toBeTruthy();
    expect(screen.getByText('No comments yet')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(container.textContent).not.toMatch(/null|undefined/);
  });

  it('leaves blank resolution, vendor and cost out of the summary', () => {
    render(<TicketSummaryModal t={ROW} propertyId="p1" onClose={() => {}} onFollowed={() => {}} />);
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.queryByText('Resolution')).toBeNull();
    expect(screen.queryByText('Vendor')).toBeNull();
    expect(screen.queryByText('Cost')).toBeNull();
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });

  it('exports blank, not "null", for those fields', () => {
    const csv = historyCsv({ history: [ROW] }, 'Austin');
    expect(csv).not.toMatch(/null|undefined/);
  });
});
