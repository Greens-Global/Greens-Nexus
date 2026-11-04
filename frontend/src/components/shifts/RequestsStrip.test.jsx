import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The Shift Planner's requests line (Neil, 11/04/2026): nothing when no
// request touches the dates on screen; a request you decide opens it in
// Approvals; one waiting on someone else is words only.

const role = { manager: true };
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => r === 'manager' && role.manager }) }));
const data = { inbox: null, timeoff: [] };
vi.mock('./useManagerInbox', () => ({ useManagerInbox: () => data, INBOX_CHANGED: 'x' }));
vi.mock('../../lib/useNameResolver', () => ({ useNameResolver: () => (email, name) => name || email }));
const openApproval = vi.fn();
vi.mock('../../approvals/focus', () => ({ openApproval: (...a) => openApproval(...a) }));

const { default: RequestsStrip, requestsInRange } = await import('./RequestsStrip');

const OFF = { id: 't1', email: 'amy@x.com', name: 'Amy Test', startDate: '2026-11-16', endDate: '2026-11-17', canDecide: true };
const SWAP = { id: 's1', kind: 'swap', requester: { email: 'bo@x.com', name: 'Bo Test' }, shift: { date: '2026-11-18' } };
const PEER = { id: 'p1', kind: 'offer', requester: { email: 'cy@x.com', name: 'Cy Test' }, shift: { date: '2026-11-19' } };

beforeEach(() => {
  role.manager = true;
  data.inbox = { pending: [], waitingOnPeer: [], recent: [] };
  data.timeoff = [];
  openApproval.mockReset();
});

describe('RequestsStrip', () => {
  it('draws nothing when no request touches the dates on screen', () => {
    data.timeoff = [{ ...OFF, startDate: '2026-12-01', endDate: '2026-12-01' }];
    const { container } = render(<RequestsStrip start="2026-11-15" end="2026-11-21" />);
    expect(container.innerHTML).toBe('');
  });

  it('draws nothing for someone below manager', () => {
    role.manager = false;
    data.timeoff = [OFF];
    const { container } = render(<RequestsStrip start="2026-11-15" end="2026-11-21" />);
    expect(container.innerHTML).toBe('');
  });

  it('names each request, links the ones you decide and words the rest', () => {
    data.timeoff = [OFF];
    data.inbox = { pending: [SWAP], waitingOnPeer: [PEER], recent: [] };
    render(<RequestsStrip start="2026-11-15" end="2026-11-21" />);
    expect(screen.getByText(/3 requests touch these dates - 2 need you/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Amy Test - Time Off 11/16/2026 - 11/17/2026' }));
    expect(openApproval).toHaveBeenCalledWith('time_off:t1', 'timeoff');
    fireEvent.click(screen.getByRole('button', { name: 'Bo Test - Swap 11/18/2026' }));
    expect(openApproval).toHaveBeenLastCalledWith('shift_request:s1', 'shifts');
    expect(screen.getByText('Cy Test - Offer 11/19/2026 (Waiting On Teammate)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cy Test/ })).toBeNull();
  });

  it('puts what needs you first, and says who decides the rest', () => {
    const items = requestsInRange({ pending: [], waitingOnPeer: [PEER] },
      [{ ...OFF, canDecide: false, reviewer: 'Val Test' }, { ...OFF, id: 't2', awaitingHr: true }, { ...OFF, id: 't3', startDate: '2026-11-20', endDate: '' }],
      '2026-11-15', '2026-11-21');
    expect(items.map((i) => [i.key, i.wait])).toEqual([
      ['time_off:t3', ''], ['time_off:t1', 'Waiting On Val Test'], ['time_off:t2', 'Waiting On HR'], ['shift_peer:p1', 'Waiting On Teammate'],
    ]);
  });
});
