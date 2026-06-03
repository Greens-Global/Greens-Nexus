/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback } from 'react';

const NotificationCtx = createContext(null);

let counter = 1;
const genId = () => `N${Date.now()}-${counter++}`;

// ── Types ─────────────────────────────────────────────────────────────────────
// 'inv_request'   → manager bell: new inventory request needing approval
// 'req_pending'   → manager bell: new purchase requisition needing approval
// 'item_returned' → manager bell: item returned (informational)
// 'approved'      → employee bell: your request was approved
// 'rejected'      → employee bell: your request was rejected
// 'overdue'       → PERSISTENT employee alert (not in bell, separate banner)

export function NotificationProvider({ children }) {
  const [notifications,  setNotifications]  = useState([]);
  const [overdueAlerts,  setOverdueAlerts]  = useState([]);  // persistent per employee

  const addNotification = useCallback((n) => {
    setNotifications(prev => [{
      id: genId(),
      read: false,
      timestamp: new Date().toISOString(),
      ...n,
    }, ...prev.slice(0, 49)]); // keep max 50
  }, []);

  const markRead      = useCallback((id) =>
    setNotifications(p => p.map(n => n.id === id ? { ...n, read: true } : n)), []);
  const markAllRead   = useCallback(() =>
    setNotifications(p => p.map(n => ({ ...n, read: true }))), []);
  const dismiss       = useCallback((id) =>
    setNotifications(p => p.filter(n => n.id !== id)), []);
  const clearRead     = useCallback(() =>
    setNotifications(p => p.filter(n => !n.read)), []);

  // Persistent overdue alerts — only dismissed manually by the employee
  const sendOverdueAlert = useCallback((reqId, employeeName, itemName) => {
    setOverdueAlerts(prev => {
      if (prev.some(a => a.reqId === reqId && !a.dismissed)) return prev;
      return [{ id: genId(), reqId, employeeName, itemName, sentAt: new Date().toISOString(), dismissed: false }, ...prev];
    });
  }, []);

  const dismissOverdueAlert = useCallback((id) =>
    setOverdueAlerts(p => p.map(a => a.id === id ? { ...a, dismissed: true } : a)), []);

  const unreadCount       = notifications.filter(n => !n.read).length;
  const actionableCount   = notifications.filter(n => !n.read && (n.type === 'inv_request' || n.type === 'req_pending')).length;
  const activeOverdueAlerts = overdueAlerts.filter(a => !a.dismissed);

  return (
    <NotificationCtx.Provider value={{
      notifications, overdueAlerts, activeOverdueAlerts,
      unreadCount, actionableCount,
      addNotification, markRead, markAllRead, dismiss, clearRead,
      sendOverdueAlert, dismissOverdueAlert,
    }}>
      {children}
    </NotificationCtx.Provider>
  );
}

export function useNotifications() { return useContext(NotificationCtx); }
