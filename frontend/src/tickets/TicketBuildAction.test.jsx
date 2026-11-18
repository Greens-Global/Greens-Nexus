import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Send To Claude Code on a ticket (11/12/2026): only for someone with the
// Build Mode grant; one click makes one pin; the button then opens that pin.
vi.mock('../api', () => ({ api: { devNotesFromTicket: vi.fn() } }));
const { api } = await import('../api');
const { store } = await import('../devnotes/store');
const { dialog } = await import('../ui/dialog');
const TicketBuildAction = (await import('./TicketBuildAction')).default;

afterEach(() => { cleanup(); vi.clearAllMocks(); store.set({ enabled: false, pendingPin: null }); });

describe('TicketBuildAction', () => {
  it('draws nothing without the Build Mode grant', () => {
    store.set({ enabled: false });
    render(<TicketBuildAction ticketId="t1" />);
    expect(screen.queryByTestId('ticket-build-send')).toBeNull();
  });

  it('one click makes the pin, then the button opens it', async () => {
    store.set({ enabled: true });
    api.devNotesFromTicket.mockResolvedValueOnce({ id: 'p9', number: 4, status: 'open' });
    render(<TicketBuildAction ticketId="t1" />);
    fireEvent.click(screen.getByTestId('ticket-build-send'));
    await waitFor(() => expect(screen.getByTestId('ticket-build-open').textContent).toContain('Open Pin #4'));
    expect(api.devNotesFromTicket).toHaveBeenCalledWith('t1');
    expect(screen.queryByTestId('ticket-build-send')).toBeNull();          // not sent twice
    fireEvent.click(screen.getByTestId('ticket-build-open'));
    expect(store.get().pendingPin).toBe('p9');
  });

  it('a refusal says why and leaves the button', async () => {
    store.set({ enabled: true });
    const alert = vi.spyOn(dialog, 'alert').mockImplementation(() => Promise.resolve());
    api.devNotesFromTicket.mockRejectedValueOnce(new Error('This ticket is already in Build Mode as Pin #2 (Building)'));
    render(<TicketBuildAction ticketId="t1" />);
    fireEvent.click(screen.getByTestId('ticket-build-send'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('This ticket is already in Build Mode as Pin #2 (Building)', { title: 'Not Sent' }));
    expect(screen.getByTestId('ticket-build-send')).toBeTruthy();
    alert.mockRestore();
  });
});
