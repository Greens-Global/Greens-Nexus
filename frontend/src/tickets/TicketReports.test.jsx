import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// Tickets > Reports (Oct 2026): render smoke over a server report, the list's
// filters passed through, the sortable agent table, retry on error, CSV
// export, and the date presets.

const REPORT = {
  range: { start: '2026-09-20', end: '2026-10-19', label: '09/20/2026 - 10/19/2026', zone: 'America/Los_Angeles', granularity: 'day' },
  filters: {},
  kpis: {
    created: 12, resolved: 9, openNow: 7, backlogChange: 3, firstResponseMedianHours: 2.5, firstResponseAvgHours: 3.1,
    firstResponseCount: 10, resolutionMedianHours: 30, slaMetPct: 78, slaMeasured: 9, firstResponseMetPct: 90,
    firstResponseMeasured: 10, breachedNow: 2, reopened: 1, csatAvg: 4.5, csatCount: 4,
  },
  aging: {
    priorities: ['urgent', 'high', 'medium', 'low'],
    buckets: [
      { key: '0-1', label: '0-1 Days', total: 2, byPriority: { urgent: 1, high: 1, medium: 0, low: 0 } },
      { key: '30+', label: '30+ Days', total: 1, byPriority: { urgent: 0, high: 0, medium: 1, low: 0 } },
    ],
    paused: { total: 3, byPriority: { urgent: 0, high: 1, medium: 2, low: 0 }, waitingOnRequester: 2, pendingApproval: 1 },
  },
  trend: [
    { key: '2026-10-18', label: '10/18/2026', created: 2, resolved: 1, breached: 0 },
    { key: '2026-10-19', label: '10/19/2026', created: 3, resolved: 2, breached: 1 },
  ],
  agents: [
    { email: 'sam@x.com', name: 'Sam Patel', kind: 'agent', open: 2, resolved: 5, firstResponseMedianHours: 1, resolutionMedianHours: 20, slaMetPct: 80, csatAvg: 4.5, oldestOpenDays: 3 },
    { email: 'ana@x.com', name: 'Ana Ruiz', kind: 'agent', open: 4, resolved: 1, firstResponseMedianHours: null, resolutionMedianHours: 60, slaMetPct: 100, csatAvg: null, oldestOpenDays: 12 },
    { email: '', name: 'Unassigned', kind: 'unassigned', open: 1, resolved: 0, firstResponseMedianHours: null, resolutionMedianHours: null, slaMetPct: null, csatAvg: null, oldestOpenDays: 1 },
  ],
  breakdowns: {
    type: [{ key: 'incident', label: 'Incident', created: 8, resolved: 6, open: 4 }],
    priority: [{ key: 'high', label: 'High', created: 4, resolved: 3, open: 2 }],
    department: [], helpTopic: [], serviceArea: [], company: [],
    source: [{ key: 'in_app', label: 'In-App', created: 12, resolved: 9, open: 7 }],
  },
  recurring: [{ label: 'VPN down', count: 3 }],
  hasTickets: true,
};

vi.mock('../api', () => ({
  api: {
    getTicketReport: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(REPORT)))),
    ticketReportCsv: vi.fn(() => Promise.resolve({ blob: new Blob(['a,b']), filename: 'ticket-report.csv' })),
    getTicketWeeklyEmail: vi.fn(() => Promise.resolve({ on: true, eligible: true, deskEnabled: true })),
    setTicketWeeklyEmail: vi.fn((on) => Promise.resolve({ on, eligible: true, deskEnabled: true })),
  },
}));

const { api } = await import('../api');
const TicketReports = (await import('./TicketReports')).default;
const { presetRange, fmtHours } = await import('./ticketReportRange');

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('TicketReports', () => {
  it('renders the server report with the list filters passed through', async () => {
    render(<TicketReports listFilters={{ priority: 'high', type: '', department: 'd1', assignee: '', service_area: '' }}
      filterLabels={['Priority: High']} companies={[]} />);
    expect(screen.getByTestId('ticket-reports')).toBeTruthy();
    expect(await screen.findByText('Sam Patel')).toBeTruthy();
    const params = api.getTicketReport.mock.calls[0][0];
    expect(params).toMatchObject({ priority: 'high', department: 'd1' });
    expect(params).not.toHaveProperty('type');
    expect(params.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText('09/20/2026 - 10/19/2026')).toBeTruthy();
    expect(screen.getByText('Priority: High')).toBeTruthy();
    expect(screen.getByText('78%')).toBeTruthy();                 // SLA Met
    expect(screen.getByText('Paused')).toBeTruthy();              // aging's own line
    expect(screen.getByText('VPN down')).toBeTruthy();
    expect(screen.getByRole('img', { name: /created, resolved and breached/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Weekly Email: On/ })).toBeTruthy();
  });

  it('sorts the agent table by a clicked column', async () => {
    render(<TicketReports />);
    await screen.findByText('Sam Patel');
    const table = screen.getByText('Sam Patel').closest('table');
    const names = () => within(table).getAllByRole('row').slice(1).map((r) => r.cells[0].textContent);
    expect(names()).toEqual(['Ana Ruiz', 'Sam Patel', 'Unassigned']);          // Open, most first
    fireEvent.click(within(table).getByRole('button', { name: /Resolved/ }));
    expect(names()).toEqual(['Sam Patel', 'Ana Ruiz', 'Unassigned']);
    fireEvent.click(within(table).getByRole('button', { name: /Median First Response/ }));
    expect(names()[2]).toBe('Unassigned');                                       // no value always last
  });

  it('shows a retry on error and reloads', async () => {
    api.getTicketReport.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    render(<TicketReports />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(await screen.findByText('Sam Patel')).toBeTruthy();
    expect(api.getTicketReport).toHaveBeenCalledTimes(2);
  });

  it('switches range and exports the CSV with the same parameters', async () => {
    render(<TicketReports />);
    await screen.findByText('Sam Patel');
    fireEvent.click(screen.getByRole('tab', { name: 'Last Week' }));
    await waitFor(() => expect(api.getTicketReport).toHaveBeenCalledTimes(2));
    const params = api.getTicketReport.mock.calls[1][0];
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(api.ticketReportCsv).toHaveBeenCalledWith(params));
  });

  it('shows an empty state when the range has no tickets', async () => {
    api.getTicketReport.mockImplementationOnce(() => Promise.resolve({ ...REPORT, hasTickets: false }));
    render(<TicketReports />);
    expect(await screen.findByText('No tickets in this range.')).toBeTruthy();
  });
});

describe('ticketReportRange', () => {
  const mon = new Date(2026, 9, 19);   // Monday 10/19/2026
  it('builds the presets', () => {
    expect(presetRange('this_week', mon)).toEqual(['2026-10-19', '2026-10-19']);
    expect(presetRange('last_week', mon)).toEqual(['2026-10-12', '2026-10-18']);
    expect(presetRange('last_30', mon)).toEqual(['2026-09-20', '2026-10-19']);
    expect(presetRange('this_quarter', mon)).toEqual(['2026-10-01', '2026-10-19']);
    expect(presetRange('last_week', new Date(2026, 9, 25))).toEqual(['2026-10-12', '2026-10-18']);   // a Sunday
  });
  it('words durations', () => {
    expect(fmtHours(null)).toBe('-');
    expect(fmtHours(2.5)).toBe('2.5 hrs');
    expect(fmtHours(72)).toBe('3.0 days');
  });
});
