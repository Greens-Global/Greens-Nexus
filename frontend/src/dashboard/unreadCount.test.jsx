// One unread count (11/05/2026): the Unread Notifications tile and the
// Notifications card read the bell's rule (lib/notificationCounts.js), never
// the server's KPI - they read 92, 60 and 9+ side by side. Until the first
// fetch lands the tile shows a placeholder, never a 0.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const ctx = vi.hoisted(() => ({ value: { notifications: [], notificationsLoaded: false, openPanel: () => {} } }));
vi.mock('../api', () => ({ api: {} }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Me', username: 'me@greensglobal.com' }] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ctx.value }));

import { WIDGETS } from './widgets.jsx';

afterEach(cleanup);
const ME = 'me@greensglobal.com';
const row = (id, extra = {}) => ({ id, type: 'approved', recipient: ME, read: false, closed: false, timestamp: '2026-11-05T10:00:00Z', ...extra });
const tile = () => {
  const Comp = WIDGETS.kpi.render;
  // The server's figure is ignored on purpose.
  return render(<Comp config={{ metric: 'unread_notifications' }} kpis={{ unread_notifications: 92 }} />);
};

describe('Unread Notifications', () => {
  it('shows a placeholder until the notifications have loaded', () => {
    ctx.value = { notifications: [], notificationsLoaded: false, openPanel: () => {} };
    tile();
    expect(document.querySelector('.dk-stat-num [data-count-skeleton]')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('92')).toBeNull();
  });

  it('reads the bell count on the tile and the card alike', () => {
    ctx.value = {
      notificationsLoaded: true, openPanel: () => {},
      notifications: [row('a'), row('b'), row('c', { read: true }), row('d', { closed: true }), row('e', { recipient: 'other@x.com' })],
    };
    tile();
    expect(document.querySelector('.dk-stat-num').textContent).toBe('2');
    cleanup();
    const Card = WIDGETS.notifications.render;
    render(<Card config={{}} notifications={ctx.value.notifications} />);
    expect(screen.getByText('2 unread')).toBeTruthy();
  });
});

// 11/17/2026: bell bodies carry **bold** markers; the tile's one-line preview
// is plain text, like Home's attention queue.
describe('The Notifications tile', () => {
  it('shows a body without its ** markers', () => {
    ctx.value = { notificationsLoaded: true, openPanel: () => {}, notifications: [row('a', { title: 'Task Assigned', body: '**Priya Shah** assigned you **Gate Repair**' })] };
    const Card = WIDGETS.notifications.render;
    render(<Card config={{}} notifications={ctx.value.notifications} />);
    expect(screen.getByText('Priya Shah assigned you Gate Repair')).toBeTruthy();
    expect(document.body.textContent).not.toContain('**');
  });
});

// 11/17/2026: a failed /dashboards/kpis read used to show 0 on every tile.
describe('A KPI tile whose count did not load', () => {
  it('says so with Try Again - never a 0, never a placeholder that stays', () => {
    const reloadKpis = vi.fn();
    const Comp = WIDGETS.kpi.render;
    render(<Comp config={{ metric: 'my_checkouts' }} kpis={{}} kpisError={{ kpis: true, signatures: false }} reloadKpis={reloadKpis} />);
    expect(document.querySelector('.dk-stat-num').textContent).toBe('-');
    expect(document.querySelector('.dk-stat-num [data-count-skeleton]')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load.");
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(reloadKpis).toHaveBeenCalledTimes(1);
  });

  it('only the signature count failed: the other tiles keep their numbers', () => {
    const Comp = WIDGETS.kpi.render;
    const err = { kpis: false, signatures: true };
    render(<Comp config={{ metric: 'my_checkouts' }} kpis={{ my_checkouts: 4 }} kpisError={err} />);
    expect(document.querySelector('.dk-stat-num').textContent).toBe('4');
    cleanup();
    render(<Comp config={{ metric: 'signatures_needed' }} kpis={{ my_checkouts: 4 }} kpisError={err} />);
    expect(document.querySelector('.dk-stat-num').textContent).toBe('-');
  });

  it('the bell count is never the server\'s, so it is never marked failed', () => {
    ctx.value = { notificationsLoaded: true, openPanel: () => {}, notifications: [row('a')] };
    const Comp = WIDGETS.kpi.render;
    render(<Comp config={{ metric: 'unread_notifications' }} kpis={{}} kpisError={{ kpis: true, signatures: true }} />);
    expect(document.querySelector('.dk-stat-num').textContent).toBe('1');
  });
});
