import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the External Users panel (new admin surface, Aug 17) - per
// CLAUDE.md a new high-risk view gets a test that catches crash-on-render.

const users = [
  {
    id: 'e1', email: 'jane.doe@acmeconstruction.com', firstName: 'Jane', lastName: 'Doe',
    name: 'Jane Doe', company: 'Acme Construction', status: 'active', identityType: 'guest',
    invitedBy: 'admin@greensglobal.com', inviteStatus: 'sent', expiresAt: '', createdAt: '2026-08-17T00:00:00Z',
    modules: [{ id: 'tasks', level: 'editor' }, { id: 'documents', level: 'viewer' }],
  },
  {
    id: 'e2', email: 'raj@osm.com', firstName: 'Raj', lastName: '', name: 'Raj',
    company: 'OSM', status: 'inactive', identityType: 'guest', invitedBy: '',
    inviteStatus: 'failed', expiresAt: '2026-12-31', createdAt: '2026-08-17T00:00:00Z', modules: [],
  },
];

const meta = {
  modules: [
    { id: 'tasks', label: 'Tasks' }, { id: 'tickets', label: 'Tickets' },
    { id: 'documents', label: 'Documents' }, { id: 'sop', label: 'Knowledge Base' },
    { id: 'external-links', label: 'External Links' },
  ],
  levels: ['viewer', 'editor'],
  defaults: [{ id: 'tasks', level: 'editor' }, { id: 'tickets', level: 'editor' }],
  internalDomains: ['greensglobal.com'],
};

const resendExternalInvite = vi.fn(() => Promise.resolve({ inviteStatus: 'sent', inviteMessage: 'Invitation email sent by Microsoft.' }));
vi.mock('../api', () => ({
  api: {
    getExternalUsers: () => Promise.resolve(users),
    getExternalUsersMeta: () => Promise.resolve(meta),
    updateExternalUser: vi.fn(() => Promise.resolve({})),
    createExternalUser: vi.fn(() => Promise.resolve({ inviteStatus: 'sent', email: 'x@y.com' })),
    resendExternalInvite: (...a) => resendExternalInvite(...a),
  },
}));

const ExternalUsersPanel = (await import('./ExternalUsersPanel')).default;

describe('ExternalUsersPanel', () => {
  it('renders the list without crashing', async () => {
    render(<ExternalUsersPanel />);
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeTruthy());
    expect(screen.getByText('Raj')).toBeTruthy();
    expect(screen.getByText('Tasks')).toBeTruthy();
    expect(screen.getByText('Deactivate')).toBeTruthy();
    expect(screen.getByText('Reactivate')).toBeTruthy();
    // Invite delivery states are visible per row
    expect(screen.getByText('Invite Sent')).toBeTruthy();
    expect(screen.getByText('Invite Failed')).toBeTruthy();
    expect(screen.getAllByText('Resend Invite').length).toBe(2);
  });

  it('resends an invitation from the row action', async () => {
    render(<ExternalUsersPanel />);
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Resend Invite')[0]);
    await waitFor(() => expect(resendExternalInvite).toHaveBeenCalledWith('jane.doe@acmeconstruction.com'));
  });

  it('opens the invite modal with the default grant set', async () => {
    render(<ExternalUsersPanel />);
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeTruthy());
    fireEvent.click(screen.getByText('Invite External User'));
    expect(await screen.findByPlaceholderText('name@partnercompany.com')).toBeTruthy();
    // Default proposal pre-checked: tasks + tickets (editor)
    const checks = screen.getAllByRole('checkbox');
    expect(checks.filter(c => c.checked).length).toBe(2);
  });
});
