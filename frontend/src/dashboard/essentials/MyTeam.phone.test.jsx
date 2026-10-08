// Phone pass on the My Team tile: the number tiles fall into a 2x2 grid, every
// tap target is at least 44px (tiles, Message), and the status word gives way
// to the room a 390px-wide card actually has.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyTeamToday: vi.fn(), getMyTeamOverdue: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({
  myEmail: 'neil@greensglobal.com', can: () => true, myGrantedModules: new Set(['tasks']),
}) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyTeam from './MyTeam.jsx';

function setViewport(isMobile) {
  window.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

const TODAY = {
  date: '2026-10-08', scheduleAvailable: true,
  in: [{ email: 'amy@greensglobal.com', name: 'Amy Adams', since: '2026-10-08T14:02:00Z', detail: 'Clocked in' }],
  out: [], onLeave: [], late: [],
  counts: { in: 1, out: 0, onLeave: 0, late: 0 },
};
const PEOPLE = [{ email: 'p1@greensglobal.com', name: 'Person 1', overdueTasks: 1, breachedTickets: 0,
                  worst: { kind: 'task', id: 't1', code: 'T-1', title: 'Budget', dueOn: '2026-10-01' } }];

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  apiMock.getMyTeamToday.mockResolvedValue(TODAY);
  apiMock.getMyTeamOverdue.mockResolvedValue({ people: PEOPLE, total: 1 });
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe('My Team on a phone', () => {
  it('lays the tiles out 2x2 with 44px targets and drops the status word', async () => {
    setViewport(true);
    render(<MyTeam />);
    const tile = await screen.findByRole('button', { name: 'In: 1' });
    expect(screen.getByTestId('team-tiles').style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(screen.getAllByRole('button', { name: /^(In|Out|On Leave|Late):/ })).toHaveLength(4);
    expect(tile.style.minHeight).toBe('44px');
    const msg = screen.getByLabelText('Message Person 1 on Teams');
    expect(msg.style.width).toBe('44px');
    expect(msg.style.height).toBe('44px');
    expect(screen.queryByText('Overdue')).toBeNull();
    fireEvent.click(tile);
    expect(screen.getByText('Amy Adams')).toBeTruthy();
  });

  it('spreads the tiles in one row on a desk', async () => {
    setViewport(false);
    render(<MyTeam />);
    await screen.findByRole('button', { name: 'In: 1' });
    expect(screen.getByTestId('team-tiles').style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    expect(screen.getByText('Overdue')).toBeTruthy();
  });
});
