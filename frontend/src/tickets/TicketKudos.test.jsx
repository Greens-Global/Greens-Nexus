import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Kudos for whoever worked your ticket (11/12/2026): a quiet line, offered
// only to the requester of a closed ticket they rated 4 or 5 stars.
vi.mock('../performance/Kudos', () => ({
  GiveKudosModal: ({ to, placeholder, onGiven, onClose }) => (
    <div data-testid="give-kudos" data-to={to} data-placeholder={placeholder}>
      <button type="button" onClick={() => onGiven({ id: 'k1' })}>Send</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  ),
}));
const { default: TicketKudos, kudosOffered } = await import('./TicketKudos');

const ME = 'ana@greensglobal.com';
const T = { id: 't1', code: '000012', subject: 'Gate keypad dead', status: 'resolved', requesterId: ME, assigneeId: 'bo.lee@greensglobal.com' };
const nameOf = (e) => (e === T.assigneeId ? 'Bo Lee' : e);

afterEach(() => { cleanup(); localStorage.clear(); });

describe('kudosOffered', () => {
  it('only for the requester of a closed ticket rated 4 or 5, worked by someone else on the team', () => {
    expect(kudosOffered({ ticket: T, rating: 5, myEmail: ME })).toBe(true);
    expect(kudosOffered({ ticket: T, rating: 4, myEmail: 'ANA@greensglobal.com' })).toBe(true);
    expect(kudosOffered({ ticket: T, rating: 3, myEmail: ME })).toBe(false);            // not a good rating
    expect(kudosOffered({ ticket: T, rating: 0, myEmail: ME })).toBe(false);            // not rated yet
    expect(kudosOffered({ ticket: { ...T, status: 'open' }, rating: 5, myEmail: ME })).toBe(false);
    expect(kudosOffered({ ticket: T, rating: 5, myEmail: 'someone@greensglobal.com' })).toBe(false); // not the requester
    expect(kudosOffered({ ticket: { ...T, assigneeId: '' }, rating: 5, myEmail: ME })).toBe(false);
    expect(kudosOffered({ ticket: { ...T, assigneeId: ME }, rating: 5, myEmail: ME })).toBe(false);  // worked it yourself
    expect(kudosOffered({ ticket: T, rating: 5, myEmail: ME, assigneeExternal: true })).toBe(false);
    expect(kudosOffered({ ticket: { ...T, confidentialDesk: 'hr' }, rating: 5, myEmail: ME })).toBe(false); // Ask HR
    expect(kudosOffered({ ticket: { ...T, status: 'closed' }, rating: 5, myEmail: ME })).toBe(true);
  });
});

describe('TicketKudos', () => {
  it('a quiet line opens Give Kudos with the assignee picked; once sent it says so and stays sent', async () => {
    render(<TicketKudos ticket={T} rating={5} myEmail={ME} nameOf={nameOf} />);
    expect(screen.getByTestId('ticket-kudos').textContent).toContain('Bo took care of this.');
    fireEvent.click(screen.getByRole('button', { name: 'Give Kudos' }));
    const form = screen.getByTestId('give-kudos');
    expect(form.dataset.to).toBe(T.assigneeId);
    expect(form.dataset.placeholder).toBe('Sorted out Ticket #12 - Gate keypad dead');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByTestId('ticket-kudos-sent').textContent).toContain('Kudos sent to Bo.'));
    cleanup();
    render(<TicketKudos ticket={T} rating={5} myEmail={ME} nameOf={nameOf} />);
    expect(screen.getByTestId('ticket-kudos-sent')).toBeTruthy();       // remembered in this browser
  });

  it('nothing at all when it is not offered', () => {
    const { container } = render(<TicketKudos ticket={T} rating={3} myEmail={ME} nameOf={nameOf} />);
    expect(container.innerHTML).toBe('');
  });
});
