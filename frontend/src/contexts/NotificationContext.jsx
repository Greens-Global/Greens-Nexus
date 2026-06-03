/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { api }     from '../api';

const NotificationCtx = createContext(null);

let counter = 1;
const genId = () => `N${Date.now()}-${counter++}`;

const POLL_INTERVAL = 30000; // 30 seconds

export function NotificationProvider({ children }) {
  const { accounts }  = useMsal();
  const myEmail       = (accounts[0]?.username ?? '').toLowerCase();

  const [notifications,  setNotifications]  = useState([]);
  const [overdueAlerts,  setOverdueAlerts]  = useState([]);
  const pollRef = useRef(null);

  // ── Fetch notifications from backend ─────────────────────────────────────
  const fetchNotifications = useCallback(() => {
    if (!myEmail) return;
    api.getNotifications(myEmail)
      .then(rows => {
        setNotifications(rows.map(r => ({
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
        })));
      })
      .catch(() => {});
  }, [myEmail]);

  // Poll on mount + every 30s
  useEffect(() => {
    fetchNotifications();
    pollRef.current = setInterval(fetchNotifications, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [fetchNotifications]);

  // ── Add notification — writes to backend + local state ───────────────────
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
    // Optimistic local update
    setNotifications(prev => [notif, ...prev.slice(0, 49)]);
    // Persist to backend
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

  // ── Persistent overdue alerts (in-memory, dismissable) ───────────────────
  const sendOverdueAlert = useCallback((reqId, employeeName, itemName) => {
    setOverdueAlerts(prev => {
      if (prev.some(a => a.reqId === reqId && !a.dismissed)) return prev;
      return [{ id: genId(), reqId, employeeName, itemName, sentAt: new Date().toISOString(), dismissed: false }, ...prev];
    });
    // Also push as a targeted notification so the employee's bell shows it
    addNotification({
      type:      'overdue',
      recipient: employeeName.toLowerCase(),
      title:     'Item Overdue',
      body:      `${itemName} is overdue and must be returned immediately.`,
    });
  }, [addNotification]);

  const dismissOverdueAlert = useCallback((id) =>
    setOverdueAlerts(p => p.map(a => a.id === id ? { ...a, dismissed: true } : a)), []);

  const unreadCount       = notifications.filter(n => !n.read && !n.actioned).length;
  const activeOverdueAlerts = overdueAlerts.filter(a => !a.dismissed);

  return (
    <NotificationCtx.Provider value={{
      notifications, overdueAlerts, activeOverdueAlerts,
      unreadCount,
      addNotification, markRead, markAllRead, dismiss, clearRead, markActioned,
      sendOverdueAlert, dismissOverdueAlert,
      refreshNotifications: fetchNotifications,
    }}>
      {children}
    </NotificationCtx.Provider>
  );
}

export function useNotifications() { return useContext(NotificationCtx); }
