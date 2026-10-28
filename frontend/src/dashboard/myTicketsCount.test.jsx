// My Open Tickets (Neil, Oct 26 2026): the ticket twin of My Open Tasks - the
// number is the open tickets assigned to you, the line under it what is past
// SLA and (for the desk) what waits to be assigned; a click lands on the
// desk's own list. The counts are the server's (backend
// test_ticket_assign_alerts.py).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: {} }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myEmail: 'desk@greensglobal.com' }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));
vi.mock('./QuickActionModals.jsx', () => ({ default: () => null }));

import { myTicketsFootnote, myTicketsFilter, MY_TICKETS_RULE } from './myTicketsCount';
import { WIDGETS, widgetAllowed } from './widgets.jsx';
import { takePendingOpen, __clearPendingOpen } from '../lib/pendingOpen';
import { openNotificationTarget } from '../lib/openTarget';

afterEach(() => { cleanup(); __clearPendingOpen(); vi.useRealTimers(); });

describe('myTicketsFootnote', () => {
  it('names what is late and what waits to be assigned', () => {
    expect(myTicketsFootnote({ my_open_tickets_breached: 2, my_open_tickets_unassigned: 5 })).toBe('2 past SLA, +5 waiting to be assigned');
    expect(myTicketsFootnote({ my_open_tickets_breached: 1 })).toBe('1 past SLA');
    expect(myTicketsFootnote({ my_open_tickets_unassigned: 3 })).toBe('+3 waiting to be assigned');
    expect(myTicketsFootnote({ my_open_tickets_breached: 2, my_open_tickets_unassigned: 5 }, true)).toBe('2 late, +5 to assign');
  });
  it('is null when there is nothing to name, or the server is older', () => {
    expect(myTicketsFootnote({ my_open_tickets_breached: 0, my_open_tickets_unassigned: 0 })).toBeNull();
    expect(myTicketsFootnote({})).toBeNull();
    expect(myTicketsFootnote(null)).toBeNull();
  });
});

describe('myTicketsFilter', () => {
  it('opens your own queue, or Unassigned when that is all there is', () => {
    expect(myTicketsFilter({ my_open_tickets: 3, my_open_tickets_unassigned: 4 })).toBe('assigned');
    expect(myTicketsFilter({ my_open_tickets: 0, my_open_tickets_unassigned: 4 })).toBe('unassigned');
    expect(myTicketsFilter({})).toBe('assigned');
  });
});

describe('My Open Tickets tile', () => {
  const mount = (kpis) => {
    const Comp = WIDGETS['my-tickets'].render;
    return render(<Comp config={{}} updateConfig={vi.fn()} kpis={kpis} />);
  };

  it('shows the number with the footnote and the rule in its tooltip', () => {
    mount({ my_open_tickets: 4, my_open_tickets_breached: 1, my_open_tickets_unassigned: 6 });
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('My Open Tickets')).toBeTruthy();
    const tile = document.querySelector('.dk-stat');
    expect(tile.getAttribute('title')).toBe(`My Open Tickets - ${MY_TICKETS_RULE}. 1 past SLA, +6 waiting to be assigned`);
    expect(tile.querySelector('.dk-sub-short').textContent).toBe('1 late, +6 to assign');
  });

  it('keeps the plain hint when nothing needs naming', () => {
    mount({ my_open_tickets: 2 });
    expect(screen.getByText('Assigned to you')).toBeTruthy();
  });

  it('lands on the desk list it names', () => {
    vi.useFakeTimers();
    const seen = [];
    const onNav = (e) => seen.push(['nav', e.detail]);
    const onFilter = (e) => seen.push(['filter', e.detail]);
    window.addEventListener('nexus:navigate', onNav);
    window.addEventListener('nexus:ticket-filter', onFilter);
    mount({ my_open_tickets: 0, my_open_tickets_unassigned: 3 });
    fireEvent.click(document.querySelector('.dk-stat'));
    vi.runAllTimers();
    window.removeEventListener('nexus:navigate', onNav);
    window.removeEventListener('nexus:ticket-filter', onFilter);
    expect(seen).toEqual([['nav', { view: 'tickets', sub: null }], ['filter', { filter: 'unassigned' }]]);
    expect(takePendingOpen('ticketFilter')).toBe('unassigned');   // for a first visit
  });

  it('is offered to whoever can open Tickets, like the screen itself', () => {
    const def = WIDGETS['my-tickets'];
    const grant = (has) => ({ can: () => false, myGrantedModules: new Map(has ? [['tickets', 'viewer']] : []),
      canAccessModule: (m) => has && m === 'tickets' });
    expect(widgetAllowed(def, grant(true))).toBe(true);
    expect(widgetAllowed(def, grant(false))).toBe(false);
  });
});

describe('Tickets to Assign notice', () => {
  it('opens the desk on its Unassigned list', () => {
    vi.useFakeTimers();
    const seen = [];
    const onFilter = (e) => seen.push(e.detail);
    window.addEventListener('nexus:ticket-filter', onFilter);
    openNotificationTarget({ view: 'tickets', ticketFilter: 'unassigned', ticketIds: ['a', 'b'] });
    vi.runAllTimers();
    window.removeEventListener('nexus:ticket-filter', onFilter);
    expect(seen).toEqual([{ filter: 'unassigned' }]);
    expect(takePendingOpen('ticketFilter')).toBe('unassigned');
  });
});
