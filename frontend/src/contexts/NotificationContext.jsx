/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { api }     from '../api';
import { supabase } from '../lib/supabase';

const NotificationCtx = createContext(null);

let counter = 1;
const genId = () => `N${Date.now()}-${counter++}`;

const FALLBACK_POLL = 8000; // 8s fallback in case realtime misses anything

function rowToNotif(r) {
  return {
    id:          r.id,
    type:        r.type,
    recipient:   r.recipient,
    title:       r.title,
    body:        r.body,
    refId:       r.ref_id,
    itemName:    r.item_name,
    requestedBy: r.requested_by,
    action:      r.action,
    actioned:    r.actioned,
    read:        r.read,
    timestamp:   r.created_at,
  };
}

export function NotificationProvider({ children }) {
  const { accounts } = useMsal();
  const myEmail      = (accounts[0]?.username ?? '').toLowerCase();

  const [notifications, setNotifications] = useState([]);
  const [overdueAlerts, setOverdueAlerts] = useState([]);
  const pollRef    = useRef(null);
  const channelRef = useRef(null);

  // ── Full fetch from backend ───────────────────────────────────────────────
  const fetchNotifications = useCallback(() => {
    if (!myEmail) return;
    api.getNotifications(myEmail)
      .then(rows => setNotifications(rows.map(rowToNotif)))
      .catch(() => {});
  }, [myEmail]);

  // ── Supabase Realtime subscription ────────────────────────────────────────
  useEffect(() => {
    if (!myEmail) return;

    // Initial load
    fetchNotifications();

    if (supabase) {
      // Subscribe to new inserts on nexus_notifications
      channelRef.current = supabase
        .channel(`notifs:${myEmail}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'nexus_notifications' },
          payload => {
            const r = payload.new;
            const rec = (r.recipient ?? '').toLowerCase();
            // Only process if it's a broadcast or addressed to me
            if (rec === '' || rec === myEmail) {
              const readList = (r.read_by ?? '').split(',').filter(Boolean);
              setNotifications(prev => {
                // Deduplicate — realtime and poll can both fire
                if (prev.some(n => n.id === r.id)) return prev;
                return [rowToNotif({ ...r, read: readList.includes(myEmail) }), ...prev.slice(0, 49)];
              });
            }
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'nexus_notifications' },
          payload => {
            const r = payload.new;
            setNotifications(prev => prev.map(n => {
              if (n.id !== r.id) return n;
              const readList = (r.read_by ?? '').split(',').filter(Boolean);
              return rowToNotif({ ...r, read: readList.includes(myEmail) });
            }));
          }
        )
        .subscribe();

      // 60s fallback poll to catch anything realtime missed
      pollRef.current = setInterval(fetchNotifications, FALLBACK_POLL);
    } else {
      // No Supabase client — fall back to 5s polling
      pollRef.current = setInterval(fetchNotifications, 5000);
    }

    return () => {
      if (channelRef.current) supabase?.removeChannel(channelRef.current);
      clearInterval(pollRef.current);
    };
  }, [myEmail, fetchNotifications]);

  // ── Add notification — writes to backend (realtime pushes it back) ────────
  const addNotification = useCallback((n) => {
    const id = n.id ?? genId();
    const notif = {
      id,
      type:        n.type,
      recipient:   n.recipient ?? null,
      title:       n.title,
      body:        n.body,
      refId:       n.refId ?? n.ref_id ?? '',
      itemName:    n.itemName ?? n.item_name ?? '',
      requestedBy: n.requestedBy ?? n.requested_by ?? '',
      action:      n.action ?? null,
      actioned:    false,
      read:        false,
      timestamp:   new Date().toISOString(),
    };
    // Optimistic update for sender (realtime will echo it back, dedup logic handles it)
    setNotifications(prev => {
      if (prev.some(x => x.id === id)) return prev;
      return [notif, ...prev.slice(0, 49)];
    });
    // Persist to backend — realtime subscription on other devices picks it up instantly
    api.pushNotification({
      id,
      type:         notif.type,
      recipient:    notif.recipient,
      title:        notif.title,
      body:         notif.body,
      ref_id:       notif.refId,
      item_name:    notif.itemName,
      requested_by: notif.requestedBy,
      action:       notif.action,
    }).catch(() => {});
  }, []);

  const markRead = useCallback((id) => {
    setNotifications(p => p.map(n => n.id === id ? { ...n, read: true } : n));
    if (myEmail) api.markNotifRead(id, myEmail).catch(() => {});
  }, [myEmail]);

  const markAllRead = useCallback(() => {
    setNotifications(p => p.map(n => {
      if (!n.read) api.markNotifRead(n.id, myEmail).catch(() => {});
      return { ...n, read: true };
    }));
  }, [myEmail]);

  const dismiss = useCallback((id) => {
    setNotifications(p => p.filter(n => n.id !== id));
    api.deleteNotif(id).catch(() => {});
  }, []);

  const clearRead = useCallback(() => {
    setNotifications(p => {
      p.filter(n => n.read).forEach(n => api.deleteNotif(n.id).catch(() => {}));
      return p.filter(n => !n.read);
    });
  }, []);

  const markActioned = useCallback((id) => {
    setNotifications(p => p.map(n => n.id === id ? { ...n, actioned: true } : n));
    api.markNotifActioned(id).catch(() => {});
  }, []);

  const sendOverdueAlert = useCallback((reqId, employeeName, itemName) => {
    setOverdueAlerts(prev => {
      if (prev.some(a => a.reqId === reqId && !a.dismissed)) return prev;
      return [{ id: genId(), reqId, employeeName, itemName, sentAt: new Date().toISOString(), dismissed: false }, ...prev];
    });
    addNotification({
      type:      'overdue',
      recipient: employeeName.toLowerCase(),
      title:     'Item Overdue',
      body:      `${itemName} is overdue and must be returned immediately.`,
    });
  }, [addNotification]);

  const dismissOverdueAlert = useCallback((id) =>
    setOverdueAlerts(p => p.map(a => a.id === id ? { ...a, dismissed: true } : a)), []);

  const unreadCount         = notifications.filter(n => !n.read && !n.actioned).length;
  const activeOverdueAlerts = overdueAlerts.filter(a => !a.dismissed);

  return (
    <NotificationCtx.Provider value={{
      notifications, overdueAlerts, activeOverdueAlerts, unreadCount,
      addNotification, markRead, markAllRead, dismiss, clearRead, markActioned,
      sendOverdueAlert, dismissOverdueAlert,
      refreshNotifications: fetchNotifications,
    }}>
      {children}
    </NotificationCtx.Provider>
  );
}

export function useNotifications() { return useContext(NotificationCtx); }
