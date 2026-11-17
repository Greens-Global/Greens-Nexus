// The ONE unread rule (11/05/2026): the bell badge, the dashboard's
// Notifications card and the Unread Notifications tile all read bellLists.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const who = vi.hoisted(() => ({ role: {}, rows: [] }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Ada Admin', username: 'Ada.Admin@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ notifications: who.rows, notificationsLoaded: true }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => who.role }));

const { bellLists, useBellLists } = await import('./notificationCounts');

const ME = 'me@greensglobal.com';
const n = (id, extra = {}) => ({ id, type: 'approved', recipient: ME, read: false, actioned: false, closed: false, ...extra });

describe('bellLists', () => {
  it('counts unread open rows addressed to me or broadcast', () => {
    const rows = [n('a'), n('b', { read: true }), n('c', { closed: true }), n('d', { recipient: '' }), n('e', { recipient: 'other@x.com' })];
    expect(bellLists(rows, { isManager: false, myEmail: ME, myName: 'Me' }).unread).toBe(2);
  });

  it('drops actioned approvals and folds duplicate order cards into one (managers only)', () => {
    const rows = [
      n('a', { type: 'checkout_pending', refId: 'O1' }),
      n('b', { type: 'checkout_pending', refId: 'O1' }),          // same order
      n('c', { type: 'checkout_pending', refId: 'O2', actioned: true }),
    ];
    expect(bellLists(rows, { isManager: true, myEmail: ME, myName: 'Me' }).unread).toBe(1);
    expect(bellLists(rows, { isManager: false, myEmail: ME, myName: 'Me' }).unread).toBe(0);
  });

  it('keeps a broadcast return out of an employee bell', () => {
    const rows = [n('a', { type: 'item_returned', recipient: '' }), n('b', { type: 'perm_return', recipient: '' })];
    expect(bellLists(rows, { isManager: false, myEmail: ME, myName: 'Me' }).unread).toBe(0);
    expect(bellLists(rows, { isManager: true, myEmail: ME, myName: 'Me' }).unread).toBe(2);
  });

  it('copes with no rows', () => {
    expect(bellLists(undefined, { isManager: true, myEmail: ME, myName: '' }).unread).toBe(0);
  });
});

// Under Act As the server sends the acted-as person's rows; counted against
// the real account, the dashboard card, the tile and the app badge read 0.
describe('useBellLists', () => {
  const rows = [
    n('p1', { recipient: 'pat@greensglobal.com' }), n('p2', { recipient: 'Pat Target' }),
    n('a1', { recipient: 'ada.admin@greensglobal.com' }), n('a2', { recipient: 'Ada Admin' }),
  ];

  it('counts for the signed-in account', () => {
    who.rows = rows;
    who.role = { can: () => false, myEmail: 'ada.admin@greensglobal.com', actingAs: null };
    const { result } = renderHook(() => useBellLists());
    expect(result.current.updates.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(result.current.unread).toBe(2);
  });

  it('counts for the acted-as person, never the real account, under Act As', () => {
    who.rows = rows;
    who.role = { can: () => false, myEmail: 'pat@greensglobal.com', actingAs: { targetEmail: 'pat@greensglobal.com', targetName: 'Pat Target' } };
    const { result } = renderHook(() => useBellLists());
    expect(result.current.updates.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(result.current.unread).toBe(2);
  });

  it('falls back to the account when the role carries no email yet', () => {
    who.rows = rows;
    who.role = { can: () => false };
    const { result } = renderHook(() => useBellLists());
    expect(result.current.updates.map((r) => r.id)).toEqual(['a1', 'a2']);
  });
});
