import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Email to Ticket: the Inbound Email log renders every outcome (and an empty
// mailbox) without crashing, links a row to its ticket, and the settings block
// offers each company's own departments as its default.

const ROWS = [
  { id: 'r1', outcome: 'created', status: 'posted', ticketId: 't1', ticketCode: '000012', from: 'req@greensglobal.com',
    subject: 'Printer jam', reason: '', attachmentCount: 2, receivedAt: '2026-10-19T16:00:00Z', processedAt: '2026-10-19T16:00:05Z' },
  { id: 'r2', outcome: 'comment', status: 'posted', ticketId: 't1', ticketCode: '000012', from: 'agent@greensglobal.com',
    subject: 'RE: Ticket #12', reason: '', attachmentCount: 0, receivedAt: '2026-10-19T17:00:00Z', processedAt: '' },
  { id: 'r3', outcome: 'refused', status: 'rejected', ticketId: null, ticketCode: '', from: 'stranger@evil.example',
    subject: 'Hello', reason: 'sender is not a known Nexus person', attachmentCount: 0, receivedAt: '2026-10-19T18:00:00Z', processedAt: '' },
  { id: 'r4', outcome: 'mystery', status: 'failed', ticketId: null, ticketCode: '', from: '', subject: '', reason: '', attachmentCount: 0 },
];

vi.mock('../api', () => ({
  api: {
    getTicketInboundLog: vi.fn(() => Promise.resolve({ rows: ROWS, total: ROWS.length })),
    drainTicketInbox: vi.fn(() => Promise.resolve({ seen: 0 })),
    getTicketCompanies: vi.fn(() => Promise.resolve([{ id: 'co1', name: 'Greens' }, { id: 'co2', name: 'Greens India' }])),
    getTicketDepartments: vi.fn(() => Promise.resolve([
      { id: 'dIT', name: 'IT', companyId: 'co1' },
      { id: 'dOps', name: 'Operations', companyId: 'co2' },
      { id: 'dOld', name: 'Old', companyId: 'co1', removed: true },
    ])),
  },
}));

const { api } = await import('../api');
const mod = await import('./TicketInboundEmail');
const TicketInboundLog = mod.default;
const { TicketInboundSettings } = mod;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TicketInboundLog', () => {
  it('renders every outcome with its reason and links rows to their ticket', async () => {
    const opened = vi.fn();
    window.addEventListener('nexus:navigate', opened);
    render(<TicketInboundLog enabled mailbox="support@greensglobal.com" />);
    expect(await screen.findByText('Ticket Created')).toBeInTheDocument();
    expect(screen.getByText('Comment Added')).toBeInTheDocument();
    expect(screen.getByText('Refused')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();          // an unknown outcome still renders
    expect(screen.getByText('Unknown Sender')).toBeInTheDocument();
    expect(screen.getByText('sender is not a known Nexus person')).toBeInTheDocument();
    expect(screen.getByText('(No Subject)')).toBeInTheDocument();
    // Received time in the viewer's own zone, US format (MM/DD/YYYY, 12-hour).
    expect(screen.getAllByText(/^10\/19\/2026, \d{1,2}:\d{2} (AM|PM)$/).length).toBeGreaterThan(0);
    expect(api.getTicketInboundLog).toHaveBeenCalledWith({ limit: 100 });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ticket #12' })[0]);
    expect(opened).toHaveBeenCalled();
    window.removeEventListener('nexus:navigate', opened);
  });

  it('says so when nothing has arrived and the switch is off', async () => {
    api.getTicketInboundLog.mockImplementationOnce(() => Promise.resolve({ rows: [], total: 0 }));
    render(<TicketInboundLog enabled={false} mailbox="support@greensglobal.com" />);
    expect(await screen.findByText('Nothing has been received yet at support@greensglobal.com.')).toBeInTheDocument();
    expect(screen.getByText(/not being read right now/)).toBeInTheDocument();
  });

  it('shows the error rather than a blank panel when the log will not load', async () => {
    api.getTicketInboundLog.mockImplementationOnce(() => Promise.reject(new Error('Forbidden')));
    render(<TicketInboundLog />);
    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
  });
});

describe('TicketInboundSettings', () => {
  it('stays closed while off, and opens on the switch', () => {
    const set = vi.fn();
    render(<TicketInboundSettings cfg={{ inboundEnabled: false }} set={set} />);
    expect(screen.queryByText('Support Mailbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Email to Ticket' }));
    expect(set).toHaveBeenCalledWith('inboundEnabled', true);
    expect(api.getTicketCompanies).not.toHaveBeenCalled();
  });

  it('lists every company with its own departments as the default', async () => {
    const set = vi.fn();
    render(<TicketInboundSettings cfg={{ inboundEnabled: true, inboundMailbox: 'support@greensglobal.com',
      inboundDefaultDepartment: { co1: 'dIT' } }} set={set} />);
    expect(await screen.findByText('Greens India')).toBeInTheDocument();
    expect(screen.getByText('IT')).toBeInTheDocument();                     // co1's chosen default
    expect(screen.getByText('None (refuse new emails)')).toBeInTheDocument(); // co2 has none
    expect(screen.getByText(/support\+t1a2b/)).toBeInTheDocument();
    await waitFor(() => expect(api.getTicketDepartments).toHaveBeenCalledTimes(1));
  });
});
