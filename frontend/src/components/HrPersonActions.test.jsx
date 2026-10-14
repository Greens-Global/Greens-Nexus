import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Promote / Change Role (Neil, Oct 8): pick the new role,
// see the change and the signing order, and send only once confirmed.

const preview = {
  title: 'Promotion Letter - Erin Lee', templateName: 'Promotion Letter', egnyteSubfolder: 'Promotion Documents',
  recipients: [{ order: 1, role: 'employee', name: 'Erin Lee', email: 'erin@x.com', who: 'employee' },
               { order: 2, role: 'manager', name: 'Max', email: 'max@x.com', who: 'manager' }],
  fromTitle: 'IT Dev Associate I', toTitle: 'IT Dev Associate II', effectiveDate: '2026-09-01',
  salaryText: '$40.00 per hour', unresolved: [], signedPeriods: [{ label: '09/06/2026 - 09/19/2026' }],
};
const send = vi.fn(() => Promise.resolve({ id: 'ev1' }));
const requestRoleChange = vi.fn(() => Promise.resolve({ id: 'rq1', approvers: [{ email: 'max@x.com', name: 'Max', as: 'manager' }], warning: '' }));
const changeRoleNow = vi.fn(() => Promise.resolve({ employeeId: 'e1', roleName: 'IT Dev Associate II', warning: '' }));
vi.mock('../api', () => ({
  api: {
    hiringOptions: () => Promise.resolve({ roles: [{ id: 'jr-2', name: 'IT Dev Associate II', department: 'IT' }] }),
    previewPromotion: () => Promise.resolve(preview),
    sendPromotion: (...a) => send(...a),
    requestRoleChange: (...a) => requestRoleChange(...a),
    changeRoleNow: (...a) => changeRoleNow(...a),
  },
}));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [['salary', 'Salary']] }));

const { PromoteModal, RoleChangeModal } = await import('./HrPersonActions');
const erin = { id: 'e1', firstName: 'Erin', lastName: 'Lee', company: 'c1', jobTitle: 'IT Dev Associate I' };

describe('PromoteModal', () => {
  it('reviews the letter, flags signed timesheets, and sends once confirmed', async () => {
    const onSent = vi.fn();
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.click(screen.getByText('Review Letter'));
    await waitFor(() => expect(screen.getByText('Promotion Letter - Erin Lee')).toBeTruthy());
    expect(screen.getByText(/2\. Max \(manager\)/)).toBeTruthy();
    expect(screen.getByText(/09\/06\/2026 - 09\/19\/2026/)).toBeTruthy();
    const btn = screen.getByText('Send For Signature').closest('button');
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(btn);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(send.mock.calls[0][1].inputs.change_type).toBe('promotion');
  });

  it('without pay access asks for the pay as written', () => {
    render(<PromoteModal employee={erin} canSeePay={false} onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(screen.getByText('Promote - Erin Lee')).toBeTruthy();
    expect(screen.getByPlaceholderText(/unchanged/)).toBeTruthy();
  });

  it('offers any currency, not only USD and INR', () => {
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(screen.getByRole('option', { name: /^EUR/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^AUD/ })).toBeTruthy();
  });
});

// Change Role (Pranshu, Oct 13-14): in People it asks first - without a
// promotion HR changes the role directly; Promotion hands over to the letter.
// From Settings > Access there is no promotion: it sends a request, with a
// reason, for the manager or HR to approve.
describe('RoleChangeModal', () => {
  it('in People changes the role directly, the reason optional', async () => {
    const onChanged = vi.fn();
    render(<RoleChangeModal employee={erin} onClose={() => {}} onPromote={() => {}} onChanged={onChanged} toastErr={() => {}} />);
    fireEvent.click(screen.getByText('Role Change Without Promotion'));
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.click(screen.getByRole('button', { name: /Change Role/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(changeRoleNow).toHaveBeenCalledWith('e1', { role_id: 'jr-2', reason: '' });
    expect(requestRoleChange).not.toHaveBeenCalled();
  });

  it('from Settings asks for approval, with a reason, and offers no promotion', async () => {
    const onChanged = vi.fn();
    render(<RoleChangeModal employee={erin} approval onClose={() => {}} onChanged={onChanged} toastErr={() => {}} />);
    expect(screen.queryByText('Promotion')).toBeNull();
    expect(screen.queryByText('Role Change Without Promotion')).toBeNull();
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    const btn = screen.getByRole('button', { name: /Send For Approval/ });
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    expect(btn).toBeDisabled();                                       // the reason is required
    fireEvent.change(screen.getByPlaceholderText(/Accounting team/), { target: { value: 'Covers month-end' } });
    fireEvent.click(btn);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(requestRoleChange).toHaveBeenCalledWith({ employee_id: 'e1', email: '', role_id: 'jr-2', reason: 'Covers month-end' });
  });

  it('Promotion goes to the promotion letter', () => {
    const onPromote = vi.fn();
    render(<RoleChangeModal employee={erin} onClose={() => {}} onPromote={onPromote} onChanged={() => {}} toastErr={() => {}} />);
    fireEvent.click(screen.getByText('Promotion'));
    expect(onPromote).toHaveBeenCalled();
  });
});
