import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Saved Replies picker (Oct 2026): render smoke, the topic's replies first,
// placeholders filled in the preview, and Insert hands the filled text to the
// composer (and counts the use) without sending anything.

const REPLIES = [
  { id: 'r1', title: 'Welcome', body: '<p>Hello {requester_first_name}</p>', helpTopic: '', shared: true, useCount: 5, canEdit: false },
  { id: 'r2', title: 'Printer Fix', body: '<p>Hi {requester_first_name}, {ticket_number} is being looked at by {agent_name}. {order_no}</p>',
    helpTopic: 'Printer or Scanner', shared: false, useCount: 0, canEdit: true },
];

vi.mock('../api', () => ({
  api: {
    getTicketSavedReplies: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(REPLIES)))),
    countTicketSavedReplyUse: vi.fn(() => Promise.resolve()),
    getMyTicketAccess: vi.fn(() => Promise.resolve({ canWorkQueue: true, canManageDesk: false })),
    getTicketTaxonomySettings: vi.fn(() => Promise.resolve({ helpTopics: [] })),
    getTicketCompanies: vi.fn(() => Promise.resolve([])),
    getPeopleDirectory: vi.fn(() => Promise.resolve([])),
  },
}));

const { api } = await import('../api');
const SavedReplyPicker = (await import('./SavedReplyPicker')).default;

const ticket = { id: 't1', code: '000042', subject: 'Jam', requesterId: 'maria.lopez@x.com', companyId: 'c1', application: 'Printer or Scanner' };
const nameOf = (e) => ({ 'maria.lopez@x.com': 'Maria Lopez', 'sam@x.com': 'Sam Patel' }[e] || e);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('SavedReplyPicker', () => {
  it('renders, lists the ticket topic first and previews it filled in', async () => {
    render(<SavedReplyPicker ticket={ticket} agentEmail="sam@x.com" nameOf={nameOf} onInsert={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('saved-reply-picker')).toBeTruthy();
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Printer Fix'), expect.stringContaining('Welcome')]);
    expect(api.getTicketSavedReplies).toHaveBeenCalledWith('c1');
    expect(screen.getByTestId('saved-reply-preview').textContent)
      .toBe('Hi Maria, Ticket #42 is being looked at by Sam Patel. {order_no}');
  });

  it('inserts the filled reply, counts the use and closes - never sends', async () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SavedReplyPicker ticket={ticket} agentEmail="sam@x.com" nameOf={nameOf} onInsert={onInsert} onClose={onClose} />);
    const options = await screen.findAllByRole('option');
    fireEvent.click(options[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Insert Reply' }));
    expect(onInsert).toHaveBeenCalledWith('<p>Hello Maria</p>');
    expect(api.countTicketSavedReplyUse).toHaveBeenCalledWith('r1');
    expect(onClose).toHaveBeenCalled();
  });

  it('searches', async () => {
    render(<SavedReplyPicker ticket={ticket} agentEmail="sam@x.com" nameOf={nameOf} onInsert={() => {}} onClose={() => {}} />);
    await screen.findAllByRole('option');
    fireEvent.change(screen.getByLabelText('Search saved replies'), { target: { value: 'hello' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Welcome')]);
    fireEvent.change(screen.getByLabelText('Search saved replies'), { target: { value: 'zzz' } });
    expect(screen.getByText('No saved replies match your search.')).toBeTruthy();
  });

  it('opens Manage in place', async () => {
    render(<SavedReplyPicker ticket={ticket} agentEmail="sam@x.com" nameOf={nameOf} onInsert={() => {}} onClose={() => {}} />);
    await screen.findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    await waitFor(() => expect(screen.getByTestId('saved-replies-settings')).toBeTruthy());
    expect(screen.getByRole('button', { name: /New Saved Reply/ })).toBeTruthy();
    // Shared ones are a supervisor's: no edit controls on them for an agent.
    expect(screen.queryByRole('button', { name: 'Edit Welcome' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Printer Fix' })).toBeTruthy();
  });
});
