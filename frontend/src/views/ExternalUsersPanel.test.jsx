import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the external-user pieces that live inside the Roles &
// Access People tab (Aug 18 rework): the invite modal (no grant checkboxes -
// access flows through normal roles/groups) and the person-panel section with
// invite status + Resend Invite / Deactivate / Remove.

const createExternalUser = vi.fn(() => Promise.resolve({ inviteStatus: 'sent', email: 'jane.doe@acmeconstruction.com' }));
const updateExternalUser = vi.fn(() => Promise.resolve({}));
const resendExternalInvite = vi.fn(() => Promise.resolve({ inviteStatus: 'sent', inviteMessage: 'Invitation email sent.' }));
const removeExternalUser = vi.fn(() => Promise.resolve({ removed: 'jane.doe@acmeconstruction.com' }));
const getExternalUsers = vi.fn(() => Promise.resolve([]));
vi.mock('../api', () => ({
  api: {
    createExternalUser: (...a) => createExternalUser(...a),
    updateExternalUser: (...a) => updateExternalUser(...a),
    resendExternalInvite: (...a) => resendExternalInvite(...a),
    removeExternalUser: (...a) => removeExternalUser(...a),
    getExternalUsers: (...a) => getExternalUsers(...a),
  },
}));
const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmMock(...a) } }));

const mod = await import('./ExternalUsersPanel');
const { InviteExternalModal, ExternalPersonSection } = mod;
const ExternalUsersPanel = mod.default;

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
    // Find the first-name input by its label span, not by position - the field
    // order in the modal has changed before and silently broke inputs[N].
    const firstNameInput = screen.getByText('First name').parentElement.querySelector('input');
    fireEvent.change(firstNameInput, { target: { value: 'Jane' } });
    // Staged-by-default (Neil, Aug 25): the primary action creates WITHOUT
    // sending anything; flipping the radio restores the one-step invite.
    fireEvent.click(screen.getByText('Create for Testing'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createExternalUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'jane.doe@acmeconstruction.com', first_name: 'Jane', send_invite: false,
    }));
    expect(createExternalUser.mock.calls[0][0].modules).toBeUndefined();
  });

  it('flipping to send-now submits send_invite true via the Send Invite button', async () => {
    const onSaved = vi.fn();
    render(<InviteExternalModal initial={null} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText('name@partnercompany.com'), { target: { value: 'jane.doe@acmeconstruction.com' } });
    const firstNameInput = screen.getByText('First name').parentElement.querySelector('input');
    fireEvent.change(firstNameInput, { target: { value: 'Jane' } });
    fireEvent.click(screen.getByText('Create and send the invite now'));
    fireEvent.click(screen.getByText('Send Invite'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createExternalUser).toHaveBeenLastCalledWith(expect.objectContaining({ send_invite: true }));
  });
});

describe('Staged lifecycle', () => {
  it('a staged person shows Release + Test Sign-In Code instead of Resend/Deactivate', () => {
    render(<ExternalPersonSection ext={{ ...ext, status: 'staged' }} />);
    expect(screen.getByText('Staged - Not Released')).toBeTruthy();
    expect(screen.getByText('Release & Send Invite')).toBeTruthy();
    expect(screen.getByText('Test Sign-In Code')).toBeTruthy();
    expect(screen.queryByText('Resend Invite')).toBeNull();
    expect(screen.queryByText('Deactivate')).toBeNull();
    expect(screen.getByText('Remove')).toBeTruthy();
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

describe('ExternalUsersPanel (People module External tab)', () => {
  it('renders the list with rows, pills, and actions', async () => {
    getExternalUsers.mockResolvedValueOnce([ext, {
      ...ext, id: 'e2', email: 'raj@osm.example', name: 'Raj Mehta',
      status: 'inactive', inviteStatus: 'sent', company: 'OSM',
      phone: '+15550001111', phoneVerifiedAt: '2026-08-18T00:00:00Z',
    }]);
    const onChanged = vi.fn();
    render(<ExternalUsersPanel onChanged={onChanged} />);
    expect(await screen.findByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('Raj Mehta')).toBeTruthy();
    expect(screen.getByText('Invite External User')).toBeTruthy();
    expect(screen.getByText('Invite Failed')).toBeTruthy();
    expect(screen.getByText('Invite Sent')).toBeTruthy();
    expect(screen.getByText('Deactivate')).toBeTruthy();
    expect(screen.getByText('Reactivate')).toBeTruthy();
    expect(screen.getAllByText('Remove').length).toBe(2);
    expect(onChanged).toHaveBeenCalled();   // feeds the External tab count badge
  });

  it('paints the empty state, never blank', async () => {
    getExternalUsers.mockResolvedValueOnce([]);
    render(<ExternalUsersPanel />);
    expect(await screen.findByText('No external users yet')).toBeTruthy();
  });
});
