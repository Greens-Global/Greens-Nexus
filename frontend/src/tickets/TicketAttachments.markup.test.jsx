// A ticket's attachments open in the shared viewer (11/02/2026), so a
// picture on a ticket offers Mark Up and the board remembers the ticket.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getTicketAttachments: vi.fn(), addTicketAttachment: vi.fn(), deleteTicketAttachment: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../lib/supabase', () => ({ supabase: null }));
const markup = vi.hoisted(() => ({ openMarkup: vi.fn() }));
vi.mock('../lib/markup', async (importOriginal) => ({ ...(await importOriginal()), openMarkup: markup.openMarkup }));

import { TicketAttachments } from './TicketAttachments';

const IMG = 'https://x.supabase.co/storage/v1/object/public/ticket-evidence/leak.png';
const SRC = { kind: 'ticket', id: 't1', label: 'Ticket #4 Leak', url: '/tickets?ticket=t1' };

beforeEach(() => { Object.values(apiMock).forEach((f) => f.mockReset()); markup.openMarkup.mockReset(); markup.openMarkup.mockResolvedValue({ id: 'note_1' }); });
afterEach(() => { cleanup(); });

describe('ticket attachments Mark Up', () => {
  it('a ticket image attachment shows Mark Up, which starts a board pointing back at the ticket', async () => {
    apiMock.getTicketAttachments.mockResolvedValue([{ id: 'a1', name: 'leak.png', size: '40 KB', kind: 'image', url: IMG }]);
    render(<TicketAttachments ticketId="t1" ticketType="it" markupSource={SRC} />);
    fireEvent.click(await screen.findByTitle('View leak.png'));
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    await waitFor(() => expect(markup.openMarkup).toHaveBeenCalledTimes(1));
    expect(markup.openMarkup.mock.calls[0][0]).toMatchObject({ imageUrl: IMG, source: SRC });
  });

  it('without a source the ticket itself is the place the markup goes back to', async () => {
    apiMock.getTicketAttachments.mockResolvedValue([{ id: 'a1', name: 'leak.png', size: '40 KB', kind: 'image', url: IMG }]);
    render(<TicketAttachments ticketId="t9" ticketType="it" />);
    fireEvent.click(await screen.findByTitle('View leak.png'));
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    await waitFor(() => expect(markup.openMarkup).toHaveBeenCalled());
    expect(markup.openMarkup.mock.calls[0][0].source).toMatchObject({ kind: 'ticket', id: 't9' });
  });

  it('a voice note has no Mark Up', async () => {
    apiMock.getTicketAttachments.mockResolvedValue([{ id: 'a2', name: 'voice-note-1.m4a', size: '40 KB', kind: 'audio', url: IMG.replace('leak.png', 'v.m4a') }]);
    render(<TicketAttachments ticketId="t1" ticketType="it" />);
    fireEvent.click(await screen.findByTitle('View voice-note-1.m4a'));
    expect(screen.queryByRole('button', { name: /Mark Up/ })).toBeNull();
  });
});
