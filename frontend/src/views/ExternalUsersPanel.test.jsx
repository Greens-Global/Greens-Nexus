import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the external-user pieces that live inside the Roles &
// Access People tab (Aug 18 rework): the invite modal (no grant checkboxes -
// access flows through normal roles/groups) and the person-panel section with
// invite status + Resend Invite / Deactivate / Remove.

const createExternalUser = vi.fn(() => Promise.resolve({ inviteStatus: 'sent', email: 'jane.doe@acmeconstruction.com' }));
const updateExternalUser = vi.fn(() => Promise.resolve({}));
const resendExternalInvite = vi.fn(() => Promise.resolve({ inviteStatus: 'sent', inviteMessage: 'Invitation email sent by Microsoft.' }));
const removeExternalUser = vi.fn(() => Promise.resolve({ removed: 'jane.doe@acmeconstruction.com' }));
vi.mock('../api', () => ({
  api: {
    createExternalUser: (...a) => createExternalUser(...a),
    updateExternalUser: (...a) => updateExternalUser(...a),
    resendExternalInvite: (...a) => resendExternalInvite(...a),
    removeExternalUser: (...a) => removeExternalUser(...a),
  },
}));
const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmMock(...a) } }));

const { InviteExternalModal, ExternalPersonSection } = await import('./ExternalUsersPanel');

const ext = {
  id: 'e1', email: 'jane.doe@acmeconstruction.com', firstName: 'Jane', lastName: 'Doe',
  name: 'Jane Doe', company: 'Acme Construction', status: 'active', identityType: 'guest',
  invitedBy: 'admin@greensglobal.com', inviteStatus: 'failed', expiresAt: '2026-12-31',
  createdAt: '2026-08-18T00:00:00Z',
};

describe('InviteExternalModal', () => {
  it('renders invite fields with NO grant checkboxes and sends the invite', async () => {
    const onSaved = vi.fn();
    render(<InviteExternalModal initial={null} onClose={() => {}} onSaved={onSaved} />);
    expect(screen.getByText('Invite External User')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox').length).toBe(0);   // grants live in Roles & Access now
    fireEvent.change(screen.getByPlaceholderText('name@partnercompany.com'), { target: { value: 'jane.doe@acmeconstruction.com' } });
    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[1], { target: { value: 'Jane' } });   // first name
    fireEvent.click(screen.getByText('Send Invite'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createExternalUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'jane.doe@acmeconstruction.com', first_name: 'Jane',
    }));
    expect(createExternalUser.mock.calls[0][0].modules).toBeUndefined();
  });
});

describe('ExternalPersonSection', () => {
  it('shows badge, invite state, and lifecycle actions', () => {
    render(<ExternalPersonSection ext={ext} />);
    expect(screen.getByText('External')).toBeTruthy();
    expect(screen.getByText('Invite Failed')).toBeTruthy();
    expect(screen.getByText('Resend Invite')).toBeTruthy();
    expect(screen.getByText('Deactivate')).toBeTruthy();
    expect(screen.getByText('Remove')).toBeTruthy();
  });

  it('resends the invitation', async () => {
    render(<ExternalPersonSection ext={ext} />);
    fireEvent.click(screen.getByText('Resend Invite'));
    await waitFor(() => expect(resendExternalInvite).toHaveBeenCalledWith(ext.email));
  });

  it('removes only after the confirm dialog', async () => {
    const onRemoved = vi.fn();
    render(<ExternalPersonSection ext={ext} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(removeExternalUser).toHaveBeenCalledWith(ext.email));
    expect(confirmMock).toHaveBeenCalled();
    expect(String(confirmMock.mock.calls[0][0])).toContain('re-invited from scratch');
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });
});
