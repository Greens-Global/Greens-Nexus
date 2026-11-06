// The ONE unread-notification rule (11/05/2026): the bell's badge, the
// dashboard's Notifications card and the Unread Notifications tile all read
// it, so they can never disagree again (they read 9+, 60 and 92: the tile
// counted every row ever addressed to you on the server, read or not; the
// card counted rows the bell hides - actioned approvals, duplicate order
// cards). Approval badges have their own single source (approvals_inbox).
import { useMsal } from '@azure/msal-react';
import { useNotifications } from '../contexts/NotificationContext.jsx';
import { useRole } from '../contexts/RoleContext';

// Needs Action: only managers+. checkout_pending = new Items module;
// inv_request/req_pending = older systems.
export const ACTIONABLE_TYPES = new Set(['inv_request', 'req_pending', 'checkout_pending', 'extension_pending']);

/** The bell's two lists over the open (not closed) notifications, and how
 *  many of them are unread. */
export function bellLists(all, { isManager, myEmail, myName }) {
  const open = (all || []).filter(n => !n.closed);
  // Broadcast (no recipient) or addressed to me; deduplicated by refId -
  // parallel cart submissions can create N notifications for one order.
  const seen = new Set();
  const actionable = isManager ? open.filter(n => {
    if (!ACTIONABLE_TYPES.has(n.type) || (n.recipient && n.recipient !== myEmail) || n.actioned) return false;
    const key = n.refId || n.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) : [];
  // Updates: everything else, scoped to me or broadcast. A return with no
  // recipient is manager-only - never someone else's return in an employee's bell.
  const updates = open.filter(n =>
    !ACTIONABLE_TYPES.has(n.type) &&
    (!n.recipient || n.recipient === myEmail || n.recipient === myName) &&
    !((n.type === 'item_returned' || n.type === 'perm_return') && !n.recipient && !isManager));
  const unread = actionable.filter(n => !n.read).length + updates.filter(n => !n.read).length;
  return { actionable, updates, unread };
}

/** bellLists for the signed-in person (over `all` when given, else the
 *  context's rows); `unread` is null until the first fetch has landed, so a
 *  count tile shows a placeholder, never a 0. */
export function useBellLists(all) {
  const ctx = useNotifications() || {};
  const { accounts } = useMsal();
  const role = useRole();
  const lists = bellLists(all ?? ctx.notifications, {
    isManager: !!role?.can?.('manager'),
    myEmail: (accounts?.[0]?.username ?? '').toLowerCase(),
    myName: accounts?.[0]?.name ?? '',
  });
  return { ...lists, unread: ctx.notificationsLoaded ? lists.unread : null };
}
