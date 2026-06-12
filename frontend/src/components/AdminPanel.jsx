import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Shield, Activity, Search, RefreshCw, ChevronDown, Users } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import Admin from '../views/Admin';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso + 'Z');
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return iso.slice(0, 16).replace('T', ' '); }
}

// Renders the JSON `details` payload as a compact, human-scannable line —
// e.g. `qty: 2 · reason: "Replacing cracked screen" · condition: damaged`.
// Falls back silently to nothing for path/status-only entries (older rows,
// or routes that don't carry a meaningful business payload).
const _DETAIL_LABELS = {
  status: 'status', item_name: 'item', quantity: 'qty', days: 'days',
  reason: 'reason', reject_reason: 'reject reason', condition_note: 'condition',
  resolved_by: 'by', allocated_by: 'by', name: 'name', category: 'category',
  assigned_to: 'assigned to', dept: 'dept',
};
function summarizeDetails(raw) {
  if (!raw) return '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return ''; }
  if (!parsed || typeof parsed !== 'object') return '';
  const parts = [];
  for (const [key, label] of Object.entries(_DETAIL_LABELS)) {
    const v = parsed[key];
    if (v === undefined || v === null || v === '') continue;
    const display = typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}…` : v;
    parts.push(`${label}: ${typeof v === 'string' ? `"${display}"` : display}`);
  }
  return parts.join('  ·  ');
}

function actionColor(action) {
  const a = action.toLowerCase();
  if (a.includes('approved') || a.includes('confirmed') || a.includes('synced')) return 'hsl(var(--color-green))';
  if (a.includes('rejected') || a.includes('lost') || a.includes('deleted'))    return 'hsl(var(--color-red, 220 60% 55%))';
  if (a.includes('allocated') || a.includes('assigned') || a.includes('replied')) return 'hsl(var(--color-orange))';
  if (a.includes('created'))  return 'hsl(var(--color-blue))';
  if (a.includes('updated') || a.includes('initiated')) return 'hsl(var(--color-purple))';
  return 'var(--muted)';
}

const ACTION_CATEGORIES = [
  { value: '',            label: 'All actions' },
  { value: 'requisition', label: 'Requisitions' },
  { value: 'inventory',   label: 'Inventory' },
  { value: 'role',        label: 'Roles' },
  { value: 'task',        label: 'Tasks' },
  { value: 'review',      label: 'Reviews' },
  { value: 'asset',       label: 'Assets' },
  { value: 'purchase',    label: 'Purchases' },
];

// ── Audit Logs tab ────────────────────────────────────────────────────────────

function AuditLogs() {
  const [rows,       setRows]       = useState([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [emailQ,     setEmailQ]     = useState('');
  const [actionQ,    setActionQ]    = useState('');
  const [offset,     setOffset]     = useState(0);
  const debounceRef = useRef(null);

  const LIMIT = 50;

  const fetchLogs = useCallback((params) => {
    setLoading(true);
    setError('');
    api.getAuditLogs(params)
      .then(data => {
        setRows(data.rows ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(() => setError('Failed to load audit logs'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchLogs({ limit: LIMIT, offset: 0, action: actionQ, user_email: emailQ });
    setOffset(0);
  }, [actionQ, fetchLogs]);

  // Debounce email filter
  function handleEmailChange(val) {
    setEmailQ(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchLogs({ limit: LIMIT, offset: 0, action: actionQ, user_email: val });
      setOffset(0);
    }, 400);
  }

  function loadPage(newOffset) {
    setOffset(newOffset);
    fetchLogs({ limit: LIMIT, offset: newOffset, action: actionQ, user_email: emailQ });
  }

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, padding: '0 0 16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="search-bar" style={{ width: 240 }}>
          <Search size={13} style={{ flexShrink: 0 }} />
          <input
            placeholder="Filter by email…"
            value={emailQ}
            onChange={e => handleEmailChange(e.target.value)}
          />
        </div>

        <div style={{ position: 'relative' }}>
          <select
            value={actionQ}
            onChange={e => setActionQ(e.target.value)}
            className="form-input"
            style={{ paddingRight: 28, fontSize: 12.5, height: 34, minWidth: 160, appearance: 'none' }}>
            {ACTION_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <ChevronDown size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--muted)' }} />
        </div>

        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
          {loading ? 'Loading…' : `${total.toLocaleString()} event${total !== 1 ? 's' : ''}`}
        </span>
        <button
          onClick={() => fetchLogs({ limit: LIMIT, offset, action: actionQ, user_email: emailQ })}
          style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--muted)' }}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 12, minHeight: 0 }}>
        {error ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{error}</div>
        ) : loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12 }}>
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{ height: 44, background: 'var(--mist)', borderRadius: 8, opacity: 1 - i * 0.1, animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '56px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            <Activity size={28} style={{ opacity: .15, display: 'block', margin: '0 auto 10px' }} />
            No activity recorded yet
          </div>
        ) : (
          <table className="stack-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--mist)', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>When</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Who</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Action</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Resource</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Details</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)', background: i % 2 === 1 ? 'hsla(0,0%,50%,.025)' : 'transparent' }}>
                  <td data-th="When" style={{ padding: '10px 14px', color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {fmtTime(r.timestamp)}
                  </td>
                  <td style={{ padding: '10px 14px', maxWidth: 200 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.user_email}
                    </div>
                    {r.user_role && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{r.user_role}</div>
                    )}
                  </td>
                  <td data-th="Action" style={{ padding: '10px 14px' }}>
                    <span style={{ fontWeight: 600, color: actionColor(r.action), fontSize: 12.5 }}>
                      {r.action}
                    </span>
                  </td>
                  <td data-th="Resource" style={{ padding: '10px 14px', color: 'var(--muted)', fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.resource_id || r.resource_type || '—'}
                  </td>
                  <td data-th="Details" style={{ padding: '10px 14px', color: 'var(--muted)', fontSize: 11.5, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={summarizeDetails(r.details)}>
                    {summarizeDetails(r.details) || '—'}
                  </td>
                  <td data-th="IP" style={{ padding: '10px 14px', color: 'var(--muted)', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {r.ip_address || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 14 }}>
          <button
            disabled={offset === 0}
            onClick={() => loadPage(Math.max(0, offset - LIMIT))}
            style={{ padding: '5px 14px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', cursor: offset === 0 ? 'default' : 'pointer', opacity: offset === 0 ? .4 : 1, fontSize: 12, fontFamily: 'Inter, sans-serif' }}>
            ← Prev
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            disabled={offset + LIMIT >= total}
            onClick={() => loadPage(offset + LIMIT)}
            style={{ padding: '5px 14px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', cursor: offset + LIMIT >= total ? 'default' : 'pointer', opacity: offset + LIMIT >= total ? .4 : 1, fontSize: 12, fontFamily: 'Inter, sans-serif' }}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ── AdminPanel ────────────────────────────────────────────────────────────────

export default function AdminPanel({ open, initialTab = 'access', onClose }) {
  const { can } = useRole();
  const [tab, setTab] = useState(initialTab);
  const panelRef = useRef(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!can('administrator')) return null;

  const tabs = [
    { id: 'access', icon: <Users size={14} />,    label: 'Access Manager' },
    { id: 'audit',  icon: <Activity size={14} />, label: 'Audit Logs' },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          zIndex: 1200, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.25s ease',
        }}
      />

      {/* Drawer */}
      <div
        ref={panelRef}
        className="admin-drawer"
        style={{
          position: 'fixed', top: 0, right: 0, height: '100vh',
          width: 'min(900px, 92vw)',
          background: 'var(--card)',
          boxShadow: '-12px 0 48px rgba(0,0,0,0.22)',
          zIndex: 1201,
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Panel header */}
        <div style={{
          display: 'flex', alignItems: 'center', padding: '18px 24px',
          borderBottom: '1px solid var(--line)', gap: 12, flexShrink: 0,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'hsla(var(--color-purple),0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Shield size={17} style={{ color: 'hsl(var(--color-purple))' }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>Admin Settings</div>
            <div className="admin-drawer-sub" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>Access manager &amp; activity logs</div>
          </div>

          {/* Tab strip */}
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', marginRight: 8 }}>
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: tab === t.id ? 700 : 500,
                  background: tab === t.id ? 'hsla(var(--color-purple),0.12)' : 'transparent',
                  color: tab === t.id ? 'hsl(var(--color-purple))' : 'var(--muted)',
                  transition: 'background .15s, color .15s',
                }}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 6, borderRadius: 8, display: 'flex', flexShrink: 0 }}
            title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {tab === 'access' && <Admin />}
          {tab === 'audit'  && <AuditLogs />}
        </div>
      </div>
    </>
  );
}
