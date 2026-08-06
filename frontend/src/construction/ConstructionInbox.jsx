// Construction - what is waiting for you on the jobsites you work.
//
// The module's notifications are rows in `nexus_notifications` (the shared
// table the Items module also writes), typed `construction_*`. This component
// is the module's OWN view of them, for two reasons:
//
//   1. The global bell (components/NotificationBell.jsx) is Visesh's file per
//      CLAUDE.md's ownership table, so this module cannot add itself to the
//      TYPE_META map that drives its icons - it has to be asked for.
//   2. In-module is where the reader can act anyway. A manager who sees
//      "3 logs ready to review" is one click from the review queue, which is on
//      this screen. The bell is for cross-module noticing; this is the queue.
//
// Read-only and self-contained: it fetches, filters and marks read. Nothing
// else on the dashboard depends on it, so a failure here degrades to a hidden
// strip rather than taking the dashboard with it.
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bell, CheckCircle, ClipboardList, FileText, X } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';

// Mirrors the kinds construction_notify.py emits. Unknown kinds fall back
// rather than throwing - which is precisely the bug this module must not
// reproduce: the global bell indexes its map with no fallback and crashes on a
// type it has not been taught.
const KIND = {
  construction_log_submitted:  { Icon: ClipboardList, color: 'var(--color-orange)', label: 'Ready to review' },
  construction_log_needs_info: { Icon: AlertCircle,   color: 'var(--color-red)',    label: 'Sent back' },
  construction_log_approved:   { Icon: CheckCircle,   color: 'var(--color-green)',  label: 'Approved' },
  construction_report_draft:   { Icon: FileText,      color: 'var(--color-blue)',   label: 'Draft ready' },
  construction_report_published: { Icon: FileText,    color: 'var(--color-green)',  label: 'Published' },
};
const FALLBACK = { Icon: Bell, color: 'var(--color-blue)', label: 'Update' };

export default function ConstructionInbox() {
  const [rows, setRows] = useState([]);
  const [dismissed, setDismissed] = useState(() => new Set());

  const load = useCallback(() => {
    // try/catch as well as .catch(): a rejected promise is not the only way this
    // fails. If api.getNotifications is ever missing the CALL itself throws,
    // synchronously, straight through the effect and into the dashboard - which
    // would make this strip the thing that breaks the screen it is decorating.
    try {
      api.getNotifications()
        // The endpoint is the whole company's bell feed, already scoped to this
        // user server-side. This module only shows its own.
        .then((all) => setRows((all || []).filter(
          (n) => typeof n.type === 'string' && n.type.startsWith('construction_'))))
        // Silent: this strip is an extra, and an error banner about
        // notifications above a working dashboard is noise the reader cannot
        // act on.
        .catch(() => setRows([]));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(load, [load]);

  const unread = rows.filter((n) => !n.read && !dismissed.has(n.id));
  if (unread.length === 0) return null;   // nothing waiting: take up no space

  const dismiss = (id) => {
    // Optimistic: the row leaves on click. A failed mark-read means it comes
    // back on the next load, which is the harmless direction to be wrong in.
    setDismissed((prev) => new Set(prev).add(id));
    api.markNotifRead(id).catch(() => {});
  };

  return (
    <div style={{
      backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
      borderLeft: '3px solid hsl(var(--color-orange))', borderRadius: 12,
      padding: 20, marginBottom: 24, boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Bell size={16} style={{ color: 'hsl(var(--color-orange))' }} />
        <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
          Needs Your Attention
        </span>
        <span style={{
          fontSize: '0.7rem', fontWeight: 800, color: '#fff', borderRadius: 999,
          background: 'hsl(var(--color-orange))', padding: '2px 8px',
        }}>{unread.length}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {unread.slice(0, 8).map((n) => {
          const meta = KIND[n.type] || FALLBACK;
          return (
            <div key={n.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px',
              backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)',
              borderRadius: 8,
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `hsla(${meta.color},0.12)`,
              }}>
                <meta.Icon size={16} color={`hsl(${meta.color})`} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                  {n.title}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {n.body}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 4, opacity: 0.8 }}>
                  {meta.label}
                  {n.timestamp || n.created_at ? ` - ${formatDateTime(n.timestamp || n.created_at)}` : ''}
                </div>
              </div>
              <button type="button" onClick={() => dismiss(n.id)} title="Mark as read"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                  color: 'var(--text-secondary)', flexShrink: 0,
                }}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {unread.length > 8 && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 10 }}>
          and {unread.length - 8} more
        </div>
      )}
    </div>
  );
}
