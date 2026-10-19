import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SlaBadge, FirstResponseIndicator } from './TicketAtoms';

// Honest SLA (Oct 2026): the drawer's first-response line and the soft
// Paused label while a ticket waits on the requester.
afterEach(() => { cleanup(); vi.useRealTimers(); });

const at = (iso) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

describe('SLA atoms', () => {
  it('shows Paused as a soft label', () => {
    at('2026-11-01T00:00:00Z');
    render(<SlaBadge t={{ slaDueAt: '2026-10-20T16:00:00+00:00', status: 'waiting_user', slaPaused: true }} />);
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('says Respond By, then Response Overdue, then Responded', () => {
    const t = { firstResponseDueAt: '2026-10-19T20:00:00+00:00', status: 'open' };
    at('2026-10-19T19:00:00Z');
    const { rerender } = render(<FirstResponseIndicator t={t} />);
    expect(screen.getByTestId('ticket-first-response').textContent).toMatch(/^Respond By 10\/19\/2026 /);
    at('2026-10-19T21:00:00Z');
    rerender(<FirstResponseIndicator t={{ ...t }} />);
    expect(screen.getByTestId('ticket-first-response').textContent).toMatch(/^Response Overdue/);
    rerender(<FirstResponseIndicator t={{ ...t, firstResponseAt: '2026-10-19T20:30:00+00:00' }} />);
    expect(screen.getByTestId('ticket-first-response').textContent).toMatch(/^Responded 10\/19\/2026 /);
  });

  it('shows nothing once resolved without a reply', () => {
    render(<FirstResponseIndicator t={{ firstResponseDueAt: '2026-10-19T20:00:00+00:00', status: 'resolved' }} />);
    expect(screen.queryByTestId('ticket-first-response')).toBeNull();
  });
});
