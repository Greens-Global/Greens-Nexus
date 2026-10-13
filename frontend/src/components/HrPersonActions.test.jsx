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
const changeRole = vi.fn(() => Promise.resolve({ employee: { id: 'e1', jobTitle: 'IT Dev Associate II' }, warning: '' }));
vi.mock('../api', () => ({
  api: {
    hiringOptions: () => Promise.resolve({ roles: [{ id: 'jr-2', name: 'IT Dev Associate II', department: 'IT' }] }),
    previewPromotion: () => Promise.resolve(preview),
    sendPromotion: (...a) => send(...a),
    changeRole: (...a) => changeRole(...a),
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

// Change Role asks first (Pranshu, Oct 13): without a promotion it just
// switches the role; Promotion hands over to the letter.
describe('RoleChangeModal', () => {
  it('changes the role directly when it is not a promotion', async () => {
    const onChanged = vi.fn();
    render(<RoleChangeModal employee={erin} onClose={() => {}} onPromote={() => {}} onChanged={onChanged} toastErr={() => {}} />);
    fireEvent.click(screen.getByText('Role Change Without Promotion'));
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    const btn = screen.getByRole('button', { name: /Change Role$/ });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.click(btn);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(changeRole).toHaveBeenCalledWith('e1', { role_id: 'jr-2', reason: '' });
  });

  it('Promotion goes to the promotion letter', () => {
    const onPromote = vi.fn();
    render(<RoleChangeModal employee={erin} onClose={() => {}} onPromote={onPromote} onChanged={() => {}} toastErr={() => {}} />);
    fireEvent.click(screen.getByText('Promotion'));
    expect(onPromote).toHaveBeenCalled();
  });
});
