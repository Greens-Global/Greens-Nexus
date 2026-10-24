import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Workday > Reimbursements (Oct 18 2026): file one (category, currency, a
// pasted receipt, the approver), the approver sends back / rejects with a
// note, the employee fixes and resubmits, HR approves and marks it paid, and
// People > person > Reimbursements lists the claims.

const overview = vi.fn();
const create = vi.fn();
const resubmit = vi.fn();
const upload = vi.fn();
const decide = vi.fn();
const pay = vi.fn();
const person = vi.fn();
const people = vi.fn();
vi.mock('../api', () => ({
  api: {
    getReimbursements: (...a) => overview(...a),
    createReimbursement: (...a) => create(...a),
    resubmitReimbursement: (...a) => resubmit(...a),
    uploadReimbursementReceipt: (...a) => upload(...a),
    decideReimbursement: (...a) => decide(...a),
    payReimbursement: (...a) => pay(...a),
    personReimbursements: (...a) => person(...a),
    cancelReimbursement: vi.fn(),
    addReimbursementReceipts: vi.fn(),
    reimbursementReceiptUrl: vi.fn(),
    getPeopleDirectory: (...a) => people(...a),
  },
}));

const { default: ReimbursementsTile, PersonReimbursements, OPEN_REIMBURSEMENTS } = await import('./Reimbursements');

const row = (over) => ({
  id: 'r1', email: 'amy@x.com', name: 'Amy Test', item: 'Monitor', category: 'equipment', categoryOther: '',
  details: 'Home office', vendor: 'Best Buy', amount: 249.99, currency: 'USD', purchaseDate: '2026-10-17',
  approverEmail: 'neil@x.com', approverName: 'Neil Test', receipts: [{ name: 'r.pdf' }],
  status: 'submitted', statusLabel: 'Waiting for Approval', paidOn: '', paymentMethod: '', paymentRef: '',
  history: [{ at: '2026-10-18T10:00:00Z', by: 'amy@x.com', byName: 'Amy Test', action: 'submitted', label: 'Submitted', note: '' }],
  createdAt: '2026-10-18T10:00:00Z', ...over,
});
const none = { mine: [], toApprove: [], hr: [], canHr: false };

beforeEach(() => {
  overview.mockReset().mockResolvedValue(none);
  create.mockReset().mockImplementation(async (b) => row({ item: b.item, amount: b.amount, currency: b.currency }));
  resubmit.mockReset().mockImplementation(async (id, b) => row({ vendor: b.vendor }));
  upload.mockReset().mockResolvedValue({ path: 'reimbursements/me/x.png', name: 'x.png' });
  decide.mockReset().mockImplementation(async (id, b) => row({
    status: b.action === 'approve' ? 'hr_approved' : b.action === 'reject' ? 'rejected' : 'sent_back',
    statusLabel: b.action === 'approve' ? 'Approved - To Pay' : b.action === 'reject' ? 'Rejected' : 'Sent Back' }));
  pay.mockReset().mockImplementation(async (id, b) => row({ status: 'paid', statusLabel: 'Paid', paidOn: b.paid_on, paymentMethod: b.payment_method, paymentRef: b.payment_ref }));
  person.mockReset().mockResolvedValue([row({ status: 'paid', statusLabel: 'Paid' })]);
  people.mockReset().mockResolvedValue([{ email: 'neil@x.com', name: 'Neil Test' }]);
});

describe('Reimbursements', () => {
  it('files one with a category, currency, pasted receipt and the default approver', async () => {
    const flash = vi.fn();
    render(<ReimbursementsTile flash={flash} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reimbursements' }));
    fireEvent.click(screen.getByRole('button', { name: /New Reimbursement/ }));
    expect(screen.getByRole('dialog', { name: 'Reimbursements' }).style.width).toBe('60vw');
    const send = screen.getByRole('button', { name: 'Send for Approval' });
    expect(screen.queryByLabelText('Amount Paid')).toBeNull();          // the kind of expense comes first
    // The fields are worded for the kind: a meal is a Meal at a Restaurant.
    fireEvent.click(screen.getByRole('radio', { name: /Meals/ }));
    expect(screen.getByLabelText('Meal')).toBeTruthy();
    expect(screen.getByLabelText('Restaurant')).toBeTruthy();
    expect(screen.getByLabelText('Who Attended and Why')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Other/ }));
    fireEvent.change(screen.getByLabelText('What Was It?'), { target: { value: 'Parking' } });
    fireEvent.change(screen.getByLabelText('Amount Paid'), { target: { value: '12.5' } });
    expect(send.disabled).toBe(true);                                   // the purpose is required
    fireEvent.change(screen.getByLabelText('Business Purpose'), { target: { value: 'Client visit' } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'EUR' } });
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText(/press Ctrl\+V/), { clipboardData: { items: [{ type: 'image/png', getAsFile: () => png }] } });
    expect(screen.getByText('shot.png')).toBeTruthy();
    await act(async () => { fireEvent.click(send); });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      item: 'Parking', amount: 12.5, currency: 'EUR', category: 'other', category_other: 'Parking',
      details: 'Client visit', approver_email: '', receipts: [{ path: 'reimbursements/me/x.png', name: 'x.png' }] }));
    expect(flash).toHaveBeenCalledWith('Sent to Neil Test for approval');
  });

  it('the approver sends it back with a note; the employee fixes and resubmits', async () => {
    overview.mockResolvedValue({ ...none, toApprove: [row()] });
    const { unmount } = render(<ReimbursementsTile />);
    expect(await screen.findByText('1 to approve')).toBeTruthy();
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_REIMBURSEMENTS)); });   // the bell's way in
    await waitFor(() => expect(screen.getByRole('tab', { name: 'To Approve (1)' }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Send Back' }));
    const confirm = screen.getAllByRole('button', { name: 'Send Back' }).at(-1);
    expect(confirm.disabled).toBe(true);                                // a note is required
    fireEvent.change(screen.getByLabelText('What to fix'), { target: { value: 'Which store?' } });
    await act(async () => { fireEvent.click(confirm); });
    expect(decide).toHaveBeenCalledWith('r1', { action: 'send_back', note: 'Which store?' });
    unmount();

    overview.mockResolvedValue({ ...none, mine: [row({ status: 'sent_back', statusLabel: 'Sent Back' })] });
    render(<ReimbursementsTile autoOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix and Resubmit' }));
    expect(screen.getByLabelText('Item').value).toBe('Monitor');   // prefilled, worded for Equipment
    fireEvent.change(screen.getByLabelText('Store or Website'), { target: { value: 'Costco' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resubmit' })); });
    expect(resubmit).toHaveBeenCalledWith('r1', expect.objectContaining({ vendor: 'Costco', item: 'Monitor' }));
  });

  it('HR approves, then marks it paid with the date, method and reference; history shows', async () => {
    overview.mockResolvedValue({ ...none, canHr: true, hr: [row({ status: 'approver_approved', statusLabel: 'With HR' })] });
    render(<ReimbursementsTile autoOpen />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'HR (1)' }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: /History/ }));
    expect(screen.getByText('Submitted')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Approve/ })); });
    expect(decide).toHaveBeenCalledWith('r1', { action: 'approve', note: '' });
    fireEvent.click(screen.getByRole('tab', { name: /To Pay/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Paid' }));
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'PR-1031' } });
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Mark Paid' }).at(-1)); });
    expect(pay).toHaveBeenCalledWith('r1', expect.objectContaining({ payment_method: 'payroll', payment_ref: 'PR-1031' }));
  });

  it('People > person > Reimbursements lists their claims', async () => {
    render(<PersonReimbursements email="amy@x.com" />);
    expect(await screen.findByText('Monitor')).toBeTruthy();
    expect(person).toHaveBeenCalledWith('amy@x.com');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();     // read only there
  });
});
