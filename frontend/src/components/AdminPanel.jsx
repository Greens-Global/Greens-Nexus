import { useState, useEffect, useCallback, useRef, Fragment } from 'react';

const FragmentRow = Fragment;   // expanded audit rows render as <tr> pairs
import { X, Shield, Activity, Search, RefreshCw, ChevronDown, Users, Clock } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { useNameResolver } from '../lib/useNameResolver';
import Admin from '../views/Admin';
import TimeTrackingAdmin from './TimeTrackingAdmin';

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
  item_name: 'item', quantity: 'qty', days: 'days',
  reason: 'reason', reject_reason: 'reject reason', condition_note: 'condition',
  resolved_by: 'by', allocated_by: 'by', name: 'name', category: 'category',
  assigned_to: 'assigned to', dept: 'dept', serial_number: 'serial',
};
function parseDetails(raw) {
  if (!raw) return {};
  try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}
function summarizeDetails(raw) {
  const parsed = parseDetails(raw);
  const parts = [];
  for (const [key, label] of Object.entries(_DETAIL_LABELS)) {
    const v = parsed[key];
    if (v === undefined || v === null || v === '') continue;
    const display = typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}…` : v;
    parts.push(`${label}: ${typeof v === 'string' ? `"${display}"` : display}`);
  }
  return parts.join('  ·  ');
}

// Older rows were logged as raw HTTP ("PUT /myhr") before the describer knew
// those modules — translate them (and the security events) into plain English.
const _LEGACY_MAP = [
  [/PUT myhr profile/,            'Updated their own profile (My HR)'],
  [/POST myhr requests/,          'Sent a request to HR'],
  [/POST timeclock punch/,        'Punched the time clock'],
  [/POST timeclock screenshot/,   'Desktop agent saved a screenshot'],
  [/POST timeclock bod/,          'Posted a start/end-of-day update'],
  [/POST timeclock timeoff/,      'Requested time off'],
  [/PATCH timeclock timeoff/,     'Decided a time-off request'],
  [/POST timeclock approvals/,    'Approved a timesheet'],
  [/(POST|PATCH) timeclock punches/, 'Adjusted a punch'],
  [/(POST|PATCH) timeclock agent/, 'Monitoring device activity'],
  [/(POST|PATCH|DELETE) timeclock shift/, 'Updated shifts'],
  [/POST dashboards views/,       'Created a dashboard view'],
  [/PUT dashboards views/,        'Updated a dashboard view'],
  [/DELETE dashboards views/,     'Deleted a dashboard view'],
  [/PUT property-assets workspace/, 'Saved the asset portfolio'],
  [/POST property-assets/,        'Asset portfolio activity'],
  [/POST esign templates/,        'Created an e-sign template'],
  [/PUT esign templates/,         'Updated an e-sign template'],
  [/POST esign requests/,         'Sent a document for signature'],
  [/\w+ esign/,                   'E-sign activity'],
  [/POST hr employees/,           'Added or updated an employee'],
  [/PATCH hr employees/,          'Updated an employee profile'],
  [/POST hr sync/,                'Synced people from M365'],
  [/\w+ hr/,                      'HR admin activity'],
  [/\w+ knowledge-base/,          'Knowledge base activity'],
  [/POST help/,                   'Updated page help'],
  [/\w+ groups/,                  'Updated access groups'],
];
function humanizeAction(r) {
  const a = r.action || '';
  if (a === 'Authentication failed')
    return { title: 'Failed sign-in', hint: 'A request arrived without a valid login — usually an expired session.', danger: true };
  if (a === 'Authorization denied')
    return { title: 'Access denied', hint: "Tried to open something their role doesn't allow.", danger: true };
  const m = a.match(/^(GET|POST|PUT|PATCH|DELETE)\s+\/?(.*)$/);
  if (!m) return { title: a };   // already human (new describer or older friendly labels)
  const key = `${m[1]} ${r.resource_type || m[2]} ${(r.resource_id || '').toLowerCase()}`;
  for (const [re, title] of _LEGACY_MAP) if (re.test(key)) return { title };
  const verb = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[m[1]] || m[1];
  return { title: `${verb} ${(r.resource_type || m[2]).replace(/-/g, ' ')}` };
}

function StatusChip({ status }) {
  if (!status) return null;
  const ok = status >= 200 && status < 300;
  const label = ok ? 'OK' : status === 401 ? 'Sign-in failed' : status === 403 ? 'Denied' : status >= 500 ? 'Server error' : `Error ${status}`;
  const fg = ok ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))';
  const bg = ok ? 'hsla(var(--color-green),0.1)' : 'hsla(var(--color-red),0.1)';
  return <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 10.5, fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>{label}</span>;
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
  { value: 'punch',       label: 'Time clock' },
  { value: 'time off',    label: 'Time off' },
  { value: 'hr',          label: 'HR' },
  { value: 'sign',        label: 'E-sign' },
  { value: 'dashboard',   label: 'Dashboards' },
  { value: 'group',       label: 'Access groups' },
  { value: 'employee',    label: 'Employees' },
  { value: 'auth',        label: 'Security (failed access)' },
];

// ── Audit Logs tab ────────────────────────────────────────────────────────────

function AuditLogs() {
  const nameOf = useNameResolver();
  const [rows,       setRows]       = useState([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [emailQ,     setEmailQ]     = useState('');
  const [actionQ,    setActionQ]    = useState('');
  const [offset,     setOffset]     = useState(0);
  const [openId,     setOpenId]     = useState(null);   // expanded row
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
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>What happened</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Details</th>
                <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Result</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const h = humanizeAction(r);
                const d = parseDetails(r.details);
                const isOpen = openId === r.id;
                const biz = summarizeDetails(r.details);
                return (
                  <FragmentRow key={r.id}>
                    <tr onClick={() => setOpenId(isOpen ? null : r.id)}
                      style={{ borderBottom: isOpen ? 'none' : '1px solid var(--line)', background: isOpen ? 'hsla(var(--color-blue),0.04)' : i % 2 === 1 ? 'hsla(0,0%,50%,.025)' : 'transparent', cursor: 'pointer' }}>
                      <td data-th="When" style={{ padding: '10px 14px', color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: 12 }}>
                        {fmtTime(r.timestamp)}
                      </td>
                      <td style={{ padding: '10px 14px', maxWidth: 200 }}>
                        <div title={r.user_email} style={{ fontSize: 12.5, fontWeight: 500, color: r.user_email === 'anonymous' ? 'var(--muted)' : 'var(--ink)', fontStyle: r.user_email === 'anonymous' ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.user_email === 'anonymous' ? 'Not signed in' : nameOf(r.user_email, r.user_name)}
                        </div>
                        {r.user_role && (
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{r.user_role}</div>
                        )}
                      </td>
                      <td data-th="What happened" style={{ padding: '10px 14px' }}>
                        <span style={{ fontWeight: 600, color: h.danger ? 'hsl(var(--color-red))' : actionColor(h.title), fontSize: 12.5 }}>
                          {h.title}
                        </span>
                        {h.hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, fontWeight: 400 }}>{h.hint}</div>}
                      </td>
                      <td data-th="Details" style={{ padding: '10px 14px', color: 'var(--muted)', fontSize: 11.5, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={biz}>
                        {biz || '—'}
                      </td>
                      <td data-th="Result" style={{ padding: '10px 14px' }}>
                        <StatusChip status={d.status || (h.danger ? 401 : 0)} />
                      </td>
                      <td style={{ padding: '10px 8px', color: 'var(--muted)' }}>
                        <ChevronDown size={13} style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ borderBottom: '1px solid var(--line)', background: 'hsla(var(--color-blue),0.04)' }}>
                        <td colSpan={6} style={{ padding: '2px 14px 12px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '6px 20px', fontSize: 11.5 }}>
                            {[
                              ['Signed in as', r.user_email],
                              ['Endpoint', d.path ? `${(r.action.match(/^(GET|POST|PUT|PATCH|DELETE)/) || [d.method || ''])[0]} ${d.path}`.trim() : (r.action.startsWith('GET') || r.action.match(/^(POST|PUT|PATCH|DELETE)/) ? r.action : '')],
                              ['Record', r.resource_id || r.resource_type],
                              ['Status code', d.status],
                              ['IP address', r.ip_address],
                              ['Exact time (UTC)', r.timestamp?.replace('T', ' ').slice(0, 19)],
                              ...Object.entries(d).filter(([k]) => !['path', 'status', 'method'].includes(k)).map(([k, v]) => [k.replace(/_/g, ' '), String(v)]),
                            ].filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => (
                              <div key={k} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                                <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}:</span>
                                <span style={{ color: 'var(--ink)', fontFamily: k === 'IP address' || k === 'Endpoint' ? 'monospace' : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
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
    { id: 'timetracking', icon: <Clock size={14} />, label: 'Time Tracking' },
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
          boxShadow: open ? '-12px 0 48px rgba(0,0,0,0.22)' : 'none',
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
          {tab === 'timetracking' && <TimeTrackingAdmin />}
        </div>
      </div>
    </>
  );
}
