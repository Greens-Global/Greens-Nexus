import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// People > Time > Invoices (Oct 21): a contractor's invoice is drafted when
// their Time Sheet is finalized; HR previews it and clicks Approve & Send.

const INVOICES = [
  { id: 'i1', employeeEmail: 'ravi@x.com', employeeName: 'Ravi Kumar', companyId: 'c1', companyName: 'Greens India', periodStart: '2026-09-01', periodEnd: '2026-09-30',
    number: 'INV-2026-0007', currency: 'INR', amount: 85000, status: 'draft', recipients: ['ap@greensglobal.com'] },
  { id: 'i2', employeeEmail: 'meera@x.com', employeeName: 'Meera Shah', companyId: 'c2', companyName: 'Greens Pune', periodStart: '2026-09-01', periodEnd: '2026-09-30',
    number: 'INV-2026-0008', currency: 'INR', amount: 42000, status: 'draft', recipients: [] },
];
const list = vi.fn();
const send = vi.fn();
const confirm = vi.fn();
vi.mock('../api', () => ({
  api: {
    timeTeam: () => Promise.resolve({ rows: [] }),
    timeOffList: () => Promise.resolve([]),
    timeMonitoringAlerts: () => Promise.resolve({ alerts: [] }),
    timesheetReviewWaiting: () => Promise.resolve({ reviews: [] }),
    timePunchRequests: () => Promise.resolve([]),
    timeExceptions: () => Promise.resolve([]),
    getPeopleDirectory: () => Promise.resolve([]),
    contractorInvoices: (...a) => list(...a),
    contractorInvoiceSend: (...a) => send(...a),
  },
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));
vi.mock('./PayrollTimecard', () => ({ default: () => <div>timecard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ hrTeam: false }) }));

const TimeAdmin = (await import('./TimeAdmin')).default;

beforeEach(() => {
  list.mockReset().mockResolvedValue({ invoices: INVOICES });
  send.mockReset().mockResolvedValue({ sent: true, emailed: true });
  confirm.mockReset().mockResolvedValue(true);
});

const rowOf = (name) => screen.getByText(name).closest('tr');

describe('People > Time > Invoices', () => {
  it('lists drafts with Awaiting Approval chips, US dates and a tab badge', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="invoices" />);
    expect(await screen.findByText('Ravi Kumar')).toBeTruthy();
    expect(screen.getAllByText('Awaiting Approval').length).toBeGreaterThanOrEqual(2);   // the filter + two chips
    expect(screen.getByText('INV-2026-0007')).toBeTruthy();
    expect(screen.getAllByText('09/01/2026 - 09/30/2026')).toHaveLength(2);
    expect(within(screen.getByText('Invoices').closest('button')).getByText('2')).toBeTruthy();
    expect(list).toHaveBeenCalledWith('draft');
  });

  it('disables Approve & Send and says why when the company has no recipients', async () => {
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="invoices" />);
    await screen.findByText('Meera Shah');
    const row = rowOf('Meera Shah');
    expect(within(row).getByText('Approve & Send').closest('button').disabled).toBe(true);
    expect(within(row).getByText('No recipients set for Greens Pune - add Contractor Invoice Recipients in Settings > Companies.')).toBeTruthy();
    expect(within(rowOf('Ravi Kumar')).getByText('Approve & Send').closest('button').disabled).toBe(false);
  });

  it('confirms with the recipients, sends, toasts and reloads', async () => {
    const toastOk = vi.fn();
    render(<TimeAdmin toastOk={toastOk} toastErr={() => {}} initialView="invoices" />);
    await screen.findByText('Ravi Kumar');
    list.mockResolvedValue({ invoices: [INVOICES[1]] });
    fireEvent.click(within(rowOf('Ravi Kumar')).getByText('Approve & Send'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('i1'));
    expect(confirm.mock.calls[0][0]).toContain('ap@greensglobal.com');
    expect(toastOk).toHaveBeenCalledWith('Invoice INV-2026-0007 sent to ap@greensglobal.com');
    await waitFor(() => expect(screen.queryByText('Ravi Kumar')).toBeNull());
  });

  it('says so when the email is not configured', async () => {
    const toastOk = vi.fn();
    send.mockResolvedValue({ sent: true, emailed: false });
    render(<TimeAdmin toastOk={toastOk} toastErr={() => {}} initialView="invoices" />);
    await screen.findByText('Ravi Kumar');
    fireEvent.click(within(rowOf('Ravi Kumar')).getByText('Approve & Send'));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Invoice INV-2026-0007 recorded - email is not configured here'));
  });

  it('shows the empty state', async () => {
    list.mockResolvedValue({ invoices: [] });
    render(<TimeAdmin toastOk={() => {}} toastErr={() => {}} initialView="invoices" />);
    expect(await screen.findByText('No invoices yet.')).toBeTruthy();
  });
});
