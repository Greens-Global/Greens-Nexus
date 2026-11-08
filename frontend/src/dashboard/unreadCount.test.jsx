// One unread count (11/05/2026): the Unread Notifications tile and the
// Notifications card read the bell's rule (lib/notificationCounts.js), never
// the server's KPI - they read 92, 60 and 9+ side by side. Until the first
// fetch lands the tile shows a placeholder, never a 0.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

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
