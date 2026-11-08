// The ONE unread rule (11/05/2026): the bell badge, the dashboard's
// Notifications card and the Unread Notifications tile all read bellLists.
import { describe, it, expect } from 'vitest';
import { bellLists } from './notificationCounts';

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
