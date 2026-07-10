// "Documentation & Changelog" — a company-wide feed of release notes, reached from
// the top-right profile dropdown (NOT the Tasks module). Standalone: it manages its
// own state via api.js + useRole/useNameResolver, so it needs no TasksProvider.
// Renders as a full-screen overlay.
//
// This is a 1:1 port of the standalone export's changelog feature (src/nexus/changelog/*):
//   • three public tabs — What's New, Timeline, Version History (+ an admin-only Manage tab)
//   • a rich detail card with five sub-tabs (Overview / Technical Details / Media / Related Links / Comments)
//   • a status workflow (Pending Review → Released / Scheduled / Draft)
//   • an author form with before/after screenshots, reviewer, work-item/PR refs and related links
//
// The backend stores each entry as a free-form `payload` dict (task_changelog_entries),
// so every field below lives inside that payload; the server owns only id/createdAt/updatedAt.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, Clock, Tag, ClipboardCheck, Plus, X, ArrowRight, CheckCircle2, User,
  ImageIcon, Search, ChevronRight, ChevronDown, GitBranch, Layers, CalendarDays,
  Link2, Maximize2, Minimize2, Pencil, Send, Bug, Flame, ShieldAlert, TrendingUp,
  Wrench, ArrowUpCircle, Upload, Eye, GitPullRequest, Trash2,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { NX, FONT, chip, card, btn, input as inputStyle } from './theme';
import { Avatar, Modal, usePeople, PersonSelect } from './components';

// ── Change-type / environment / status metadata (ported from changelogMeta.ts) ──
const CHANGE_TYPE_META = {
  'Bug Fix':         { label: 'Bug Fix',         color: '#dc2626', tint: '#fde5e5', icon: Bug },
  'Performance':     { label: 'Performance',     color: '#d97706', tint: '#fdefd7', icon: TrendingUp },
  'New Feature':     { label: 'New Feature',     color: '#16a34a', tint: '#e3f5ea', icon: Sparkles },
  'Security Update': { label: 'Security Update', color: '#db2777', tint: '#fbe3ef', icon: ShieldAlert },
  'Hotfix':          { label: 'Hotfix',          color: '#ea580c', tint: '#ffe4d6', icon: Flame },
  'Maintenance':     { label: 'Maintenance',     color: '#7c3aed', tint: '#efe6fd', icon: Wrench },
  'Improvement':     { label: 'Improvement',     color: '#2563eb', tint: '#e0eafe', icon: ArrowUpCircle },
};
const CHANGE_TYPES = ['Bug Fix', 'Performance', 'New Feature', 'Security Update', 'Hotfix', 'Maintenance', 'Improvement'];
const ENVIRONMENT_META = {
  Production: { color: '#16a34a' },
  Staging:    { color: '#d97706' },
  Beta:       { color: '#2563eb' },
};
const ENVIRONMENTS = ['Production', 'Staging', 'Beta'];
const STATUS_META = {
  'Pending Review': { color: '#d97706', tint: '#fdefd7' },
  'Released':       { color: '#16a34a', tint: '#e3f5ea' },
  'Scheduled':      { color: '#2563eb', tint: '#e0eafe' },
  'Draft':          { color: '#5b6472', tint: '#eef0f3' },
};
const STATUSES = ['Pending Review', 'Released', 'Scheduled', 'Draft'];
const typeMeta = (t) => CHANGE_TYPE_META[t] || { label: t || 'Update', color: NX.dim, tint: NX.border2, icon: Sparkles };
const envColor = (e) => (ENVIRONMENT_META[e] || {}).color || NX.green;

// ── Date helpers (ported from changelogDateFormat.ts / relativeDay.ts) ─────────
function toLocalDate(iso) {
  if (!iso) return null;
  const [datePart, timePart] = String(iso).split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!timePart) return new Date(y, (m || 1) - 1, d || 1);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
}
function formatFullDate(iso) {
  const d = toLocalDate(iso);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}
function formatTime(iso) {
  if (!iso || !String(iso).includes('T')) return '';
  const d = toLocalDate(iso);
  return d && !isNaN(d) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}
function formatDateTime(iso) {
  const t = formatTime(iso);
  return t ? `${formatFullDate(iso)}, ${t}` : formatFullDate(iso);
}
function dateKey(iso) {
  return String(iso || '').split('T')[0];
}
function relativeDayLabel(iso) {
  const day = toLocalDate(dateKey(iso));
  if (!day || isNaN(day)) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function isWithinDays(iso, days) {
  const day = toLocalDate(dateKey(iso));
  if (!day || isNaN(day)) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  return diff >= 0 && diff < days;
}
function nowLocalISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The server owns id/createdAt/updatedAt; everything else lives in the payload we author.
function payloadOf(entry) {
  const { id, createdAt, updatedAt, ...rest } = entry || {};
  return rest;
}
// PR-sourced entries land as "Pending Review"; everything else defaults to "Released".
function statusOf(entry) {
  return entry?.status || (entry?.origin === 'pr' ? 'Pending Review' : 'Released');
}
function releasedKey(entry) {
  return entry?.releasedAt || entry?.createdAt || '';
}

// ── Small badge (ported from NxBadge) ─────────────────────────────────────────
function Badge({ label, color, tint }) {
  if (color) return <span style={chip(color, tint)}>{label}</span>;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color: NX.dim, background: NX.border2, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Root overlay
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'whats-new', label: "What's New", icon: Sparkles },
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'version-history', label: 'Version History', icon: Tag },
];

export default function Changelog({ onClose }) {
  const { myEmail, can } = useRole();
  const nameOf = useNameResolver();
  const isAdmin = !!can?.('manager');

  const [entries, setEntries] = useState([]);
  const [tab, setTab] = useState('whats-new');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // entry being edited
  const [toast, setToast] = useState('');

  const reload = () => api.getTaskChangelog().then((r) => setEntries(r || [])).catch(() => {});
  useEffect(() => { reload(); }, []);

  const flash = (msg) => { setToast(msg); window.setTimeout(() => setToast(''), 3200); };

  // Self-contained data layer (the free-form payload has no camel keys the Tasks
  // context would remap, so we call api.js directly and reconcile locally).
  const createEntry = async (payload) => { const r = await api.createTaskChangelog({ payload }); setEntries((p) => [r, ...p]); return r; };
  const updateEntry = async (id, payload) => { const r = await api.updateTaskChangelog(id, { payload }); setEntries((p) => p.map((x) => (x.id === id ? r : x))); return r; };
  const deleteEntry = async (id) => { await api.deleteTaskChangelog(id); setEntries((p) => p.filter((x) => x.id !== id)); };
  const setStatus = (entry, next) => updateEntry(entry.id, { ...payloadOf(entry), status: next }).catch(() => {});

  // Admins publish immediately; anyone else goes into the review queue for an admin
  // to publish from the Manage tab.
  const handleAdd = async (payload) => {
    const status = isAdmin ? (payload.status || 'Released') : 'Pending Review';
    await createEntry({ ...payload, status, origin: payload.origin || 'manual' }).catch(() => {});
    flash(isAdmin ? 'Update published.' : 'Submitted for review — an admin will publish it once approved.');
  };
  const handleEditSave = async (payload) => {
    await updateEntry(editing.id, payload).catch(() => {});
    setEditing(null);
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !adding && !editing) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adding, editing, onClose]);

  const sorted = useMemo(
    () => (entries || []).slice().sort((a, b) => String(releasedKey(b)).localeCompare(String(releasedKey(a)))),
    [entries],
  );
  // Pending-review / draft entries stay out of the public-facing tabs.
  const published = useMemo(
    () => sorted.filter((e) => { const s = statusOf(e); return s !== 'Pending Review' && s !== 'Draft'; }),
    [sorted],
  );
  const pendingCount = useMemo(() => sorted.filter((e) => statusOf(e) === 'Pending Review').length, [sorted]);

  const tabs = isAdmin
    ? [...TABS, { key: 'manage', label: 'Manage', icon: ClipboardCheck, badge: pendingCount }]
    : TABS;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, fontFamily: FONT, color: NX.ink, background: NX.canvas, display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.13s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <Sparkles size={20} style={{ color: NX.blue, flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Documentation &amp; Changelog</div>
          <div style={{ fontSize: 13, color: NX.dim }}>Track all updates, releases and changes across Nexus.</div>
        </div>
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setAdding(true)}><Plus size={15} />Add new update</button>
        <button onClick={onClose} title="Close" aria-label="Close" style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><X size={18} /></button>
      </div>

      {/* Tab strip */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', whiteSpace: 'nowrap', borderBottom: `1px solid ${NX.border}`, background: NX.surface, padding: '0 12px' }}>
        {tabs.map((t) => {
          const active = tab === t.key;
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer',
              borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`, background: 'transparent',
              padding: '12px 12px', fontSize: 14, fontWeight: 600, fontFamily: FONT,
              color: active ? NX.ink : NX.dim,
            }}>
              <Icon size={16} />{t.label}
              {t.badge > 0 && <Badge label={String(t.badge)} color="#d97706" tint="#fdefd7" />}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas }}>
        {tab === 'whats-new' && <WhatsNewTab entries={published} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin} onSetStatus={setStatus} onEdit={setEditing} />}
        {tab === 'timeline' && <TimelineTab entries={published} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin} onSetStatus={setStatus} onEdit={setEditing} />}
        {tab === 'version-history' && <VersionHistoryTab entries={published} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin} onSetStatus={setStatus} onEdit={setEditing} />}
        {tab === 'manage' && (
          <ManageTab entries={sorted} nameOf={nameOf} myEmail={myEmail} onSetStatus={setStatus} onEdit={setEditing}
            onAdd={() => setAdding(true)} onDelete={async (id) => { if (window.confirm('Delete this entry? This cannot be undone.')) await deleteEntry(id).catch(() => {}); }} />
        )}
      </div>

      {(adding || editing) && (
        <AddUpdateModal
          entry={editing}
          submitLabel={editing ? 'Save changes' : (isAdmin ? 'Publish update' : 'Submit for review')}
          myEmail={myEmail}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSave={editing ? handleEditSave : handleAdd}
        />
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4100,
          background: NX.primary, color: '#fff', padding: '10px 16px', borderRadius: 10, fontSize: 13, fontWeight: 500,
          boxShadow: '0 12px 32px rgba(0,0,0,0.28)', maxWidth: '90vw' }}>{toast}</div>
      )}
    </div>,
    document.body,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// What's New tab — latest single published entry + activity summary
// ═══════════════════════════════════════════════════════════════════════════
function WhatsNewTab({ entries, nameOf, myEmail, isAdmin, onSetStatus, onEdit }) {
  const latest = entries[0];
  const [details, setDetails] = useState(null);
  return (
    <div style={{ padding: '20px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: NX.ink }}>What's New</h1>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: NX.dim }}>The single most recent published update.</p>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{latest ? '1 update' : '0 updates'}</span>
      </div>

      {latest ? (
        <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0, flex: '1 1 520px' }}>
            <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint }}>{relativeDayLabel(releasedKey(latest))}</div>
            <EntryCard entry={latest} nameOf={nameOf} onViewDetails={() => setDetails(latest)} />
          </div>
          <div style={{ width: '100%', maxWidth: 320, flex: '1 1 280px' }}>
            <StatsPanel entries={entries} />
          </div>
        </div>
      ) : (
        <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '64px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
          No updates published yet.
        </div>
      )}

      {details && (
        <SlideOver entry={details} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
          onClose={() => setDetails(null)} onSetStatus={onSetStatus}
          onEdit={isAdmin ? () => { onEdit(details); setDetails(null); } : undefined} />
      )}
    </div>
  );
}

// ── Activity summary panel (ported from ChangelogStatsPanel) ──────────────────
function StatsPanel({ entries }) {
  const [period, setPeriod] = useState('week');
  const days = period === 'week' ? 7 : 30;
  const { total, counts } = useMemo(() => {
    const inRange = entries.filter((e) => isWithinDays(releasedKey(e), days));
    const byType = new Map();
    for (const e of inRange) byType.set(e.type, (byType.get(e.type) || 0) + 1);
    return { total: inRange.length, counts: byType };
  }, [entries, days]);

  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: NX.ink }}>Activity Summary</h3>
        <div style={{ display: 'flex', border: `1px solid ${NX.border}`, borderRadius: 8, padding: 2, fontSize: 11, fontWeight: 600 }}>
          {['week', 'month'].map((p) => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              borderRadius: 6, padding: '4px 8px', cursor: 'pointer', border: 'none', fontFamily: FONT,
              background: period === p ? NX.primary : 'transparent', color: period === p ? '#fff' : NX.dim,
            }}>{p === 'week' ? 'Week' : 'Month'}</button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 6, borderBottom: `1px solid ${NX.border}`, paddingBottom: 12 }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: NX.ink }}>{total}</span>
        <span style={{ fontSize: 12, color: NX.dim }}>update{total === 1 ? '' : 's'} this {period}</span>
      </div>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {CHANGE_TYPES.filter((t) => counts.get(t)).map((type) => {
          const meta = CHANGE_TYPE_META[type];
          const Icon = meta.icon;
          return (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, color: meta.color, background: meta.tint, flexShrink: 0 }}><Icon size={14} /></span>
              <span style={{ flex: 1, fontSize: 13, color: NX.ink }}>{meta.label}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{counts.get(type)}</span>
            </div>
          );
        })}
        {total === 0 && <p style={{ margin: 0, fontSize: 12, color: NX.dim }}>No updates published this {period}.</p>}
      </div>
    </div>
  );
}

// ── Feed card (ported from ChangelogEntryCard) ────────────────────────────────
function EntryCard({ entry, nameOf, onViewDetails }) {
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const [preview, setPreview] = useState(false);
  const thumbnail = (entry.images && entry.images[0]) || entry.afterImageDataUrl;
  const whatsChanged = entry.whatsChanged || [];
  return (
    <div style={{ ...card, overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20, padding: 20 }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={chip(meta.color, meta.tint)}><Icon size={12} />{meta.label}</span>
            {entry.module && <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{entry.module}</span>}
          </div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: NX.ink }}>{entry.title || 'Untitled'}</h3>
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: NX.dim }}>
            {entry.version && <span style={{ fontFamily: 'monospace' }}>{entry.version}</span>}
            {entry.environment && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: envColor(entry.environment) }} />{entry.environment}
              </span>
            )}
          </div>
          {entry.description && <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: NX.ink }}>{entry.description}</p>}

          {entry.businessImpact && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 8, background: '#e0eafe', color: NX.blue, padding: '10px 12px', fontSize: 13 }}>
              <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>{entry.businessImpact}</span>
            </div>
          )}
          {entry.userImpact && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: NX.dim }}>
              <User size={15} style={{ flexShrink: 0, marginTop: 1, color: NX.faint }} /><span>{entry.userImpact}</span>
            </div>
          )}

          {whatsChanged.length > 0 && (
            <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {whatsChanged.slice(0, 4).map((line, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: NX.ink }}>
                  <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 2, color: NX.green }} />{line}
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: `1px solid ${NX.border}`, paddingTop: 12, fontSize: 12, color: NX.dim }}>
            {entry.authorId && <Avatar email={entry.authorId} name={nameOf(entry.authorId)} size={20} />}
            <span>{entry.authorId ? nameOf(entry.authorId) : 'Unknown'}</span>
            {entry.ticketRef && (<><span>·</span><span>{entry.ticketRef}</span></>)}
            {entry.prRef && (<><span>·</span><span>{entry.prRef}</span></>)}
            {onViewDetails && (
              <button onClick={onViewDetails} style={{ ...btn('ghost'), marginLeft: 'auto', color: NX.blue, padding: 0 }}>
                View full details <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>

        <button onClick={() => thumbnail && setPreview(true)} aria-label={thumbnail ? 'View screenshot' : undefined} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 224, maxWidth: '100%',
          aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 10, border: `1px solid ${NX.border}`,
          background: NX.surface2, cursor: thumbnail ? 'zoom-in' : 'default', padding: 0,
        }}>
          {thumbnail
            ? <img src={thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
            : <ImageIcon size={22} style={{ color: NX.faint }} />}
        </button>
      </div>

      {preview && thumbnail && (
        <Modal title={entry.title || 'Screenshot'} onClose={() => setPreview(false)} width={720}>
          <img src={thumbnail} alt="" style={{ width: '100%', borderRadius: 8 }} />
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Timeline tab — searchable/filterable, grouped by day, master + detail
// ═══════════════════════════════════════════════════════════════════════════
const ALL = 'all';
function TimelineTab({ entries, nameOf, myEmail, isAdmin, onSetStatus, onEdit }) {
  const [query, setQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [envFilter, setEnvFilter] = useState(ALL);
  const [selectedId, setSelectedId] = useState(entries[0]?.id || null);
  const [expanded, setExpanded] = useState(false);

  const modules = useMemo(() => Array.from(new Set(entries.map((e) => e.module).filter(Boolean))).sort(), [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (moduleFilter !== ALL && e.module !== moduleFilter) return false;
      if (typeFilter !== ALL && e.type !== typeFilter) return false;
      if (envFilter !== ALL && e.environment !== envFilter) return false;
      if (q && !`${e.title} ${e.description} ${e.ticketRef || ''} ${e.version || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, query, moduleFilter, typeFilter, envFilter]);

  useEffect(() => {
    if (!filtered.some((e) => e.id === selectedId)) setSelectedId(filtered[0]?.id || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  const groups = useMemo(() => {
    const byDay = new Map();
    for (const e of filtered) {
      const k = dateKey(releasedKey(e));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    return [...byDay.entries()];
  }, [filtered]);

  const selected = filtered.find((e) => e.id === selectedId) || null;
  const selStyle = { ...inputStyle, width: 'auto', minWidth: 150, cursor: 'pointer' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '20px 16px', height: '100%' }}>
      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint, pointerEvents: 'none' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search updates, tags, work items…" style={{ ...inputStyle, paddingLeft: 30 }} />
        </div>
        <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} style={selStyle}>
          <option value={ALL}>All Modules</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selStyle}>
          <option value={ALL}>All Categories</option>
          {CHANGE_TYPES.map((t) => <option key={t} value={t}>{CHANGE_TYPE_META[t].label}</option>)}
        </select>
        <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)} style={selStyle}>
          <option value={ALL}>All Environments</option>
          {ENVIRONMENTS.map((e2) => <option key={e2} value={e2}>{e2}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: NX.ink }}>Activity Timeline</h2>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{filtered.length} entries</span>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', minHeight: 0, flex: 1 }}>
        {/* Master list */}
        <div className="nx-scroll" style={{ minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20, paddingRight: 4 }}>
          {groups.map(([k, group]) => (
            <div key={k}>
              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{formatFullDate(releasedKey(group[0]))}</span>
                <Badge label={`${group.length} update${group.length === 1 ? '' : 's'}`} />
              </div>
              <div style={{ ...card, overflow: 'hidden' }}>
                {group.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} selected={entry.id === selectedId} onClick={() => { setSelectedId(entry.id); }} />
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '64px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
              No updates match your filters.
            </div>
          )}
        </div>

        {/* Detail pane */}
        <div style={{ minHeight: 0 }}>
          {selected && !expanded ? (
            <div style={{ height: '100%', overflow: 'hidden', borderRadius: 12, border: `1px solid ${NX.border}` }}>
              <DetailCard entry={selected} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
                expanded={false} onToggleExpand={() => setExpanded(true)} onSetStatus={onSetStatus}
                onEdit={isAdmin ? () => onEdit(selected) : undefined} />
            </div>
          ) : !selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200, borderRadius: 12, border: `1px dashed ${NX.border}`, fontSize: 13, color: NX.dim }}>
              Select an update to see details.
            </div>
          ) : null}
        </div>
      </div>

      {expanded && selected && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3200, background: NX.surface }}>
          <DetailCard entry={selected} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
            expanded onToggleExpand={() => setExpanded(false)} onClose={() => setExpanded(false)}
            onSetStatus={onSetStatus} onEdit={isAdmin ? () => { setExpanded(false); onEdit(selected); } : undefined} />
        </div>
      )}
    </div>
  );
}

function TimelineRow({ entry, selected, onClick }) {
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const thumbnail = (entry.images && entry.images[0]) || entry.afterImageDataUrl;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 16, width: '100%', textAlign: 'left', cursor: 'pointer',
      borderBottom: `1px solid ${NX.border}`, borderLeft: 'none', borderRight: 'none', borderTop: 'none',
      padding: '14px 16px', background: selected ? '#eef4ff' : 'transparent', fontFamily: FONT,
    }}>
      <span style={{ width: 48, flexShrink: 0, fontFamily: 'monospace', fontSize: 12, color: NX.dim }}>{formatTime(releasedKey(entry))}</span>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: meta.color }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}><Icon size={11} />{meta.label}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 700, color: NX.ink }}>{entry.title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.module}</span>
          <span>·</span>
          <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{entry.version}</span>
          {entry.environment && (<><span>·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: envColor(entry.environment) }} />{entry.environment}
            </span></>)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 80, flexShrink: 0, aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface2 }}>
        {thumbnail ? <img src={thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} /> : <ImageIcon size={16} style={{ color: NX.faint }} />}
      </div>
      <ChevronRight size={16} style={{ flexShrink: 0, color: NX.faint }} />
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Version History tab — grouped by version, expandable
// ═══════════════════════════════════════════════════════════════════════════
function VersionHistoryTab({ entries, nameOf, myEmail, isAdmin, onSetStatus, onEdit }) {
  const groups = useMemo(() => {
    const byVersion = new Map();
    for (const e of entries) {
      const v = e.version || '—';
      if (!byVersion.has(v)) byVersion.set(v, { version: v, releasedAt: releasedKey(e), entries: [] });
      byVersion.get(v).entries.push(e);
    }
    return [...byVersion.values()].sort((a, b) => (a.releasedAt < b.releasedAt ? 1 : -1));
  }, [entries]);

  const [open, setOpen] = useState(groups[0]?.version || null);
  const [selected, setSelected] = useState(null);

  const summarize = (list) => {
    const counts = new Map();
    for (const e of list) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    return [...counts.entries()];
  };

  return (
    <div style={{ padding: '20px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: NX.ink }}>Release Versions</h2>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{groups.length} versions</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map((group) => {
          const isOpen = open === group.version;
          return (
            <div key={group.version} style={{ ...card, overflow: 'hidden' }}>
              <button onClick={() => setOpen(isOpen ? null : group.version)} style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', cursor: 'pointer',
                border: 'none', background: 'transparent', padding: '12px 16px', fontFamily: FONT,
              }}>
                {isOpen ? <ChevronDown size={16} style={{ color: NX.dim }} /> : <ChevronRight size={16} style={{ color: NX.dim }} />}
                <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: NX.ink }}>{group.version}</span>
                <span style={{ fontSize: 12, color: NX.dim }}>Released {dateKey(group.releasedAt)}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  {summarize(group.entries).map(([type, count]) => {
                    const meta = typeMeta(type);
                    return <Badge key={type} label={`${count} ${meta.label}`} color={meta.color} tint={meta.tint} />;
                  })}
                </div>
              </button>

              {isOpen && (
                <div style={{ borderTop: `1px solid ${NX.border}` }}>
                  {group.entries.map((entry) => {
                    const meta = typeMeta(entry.type);
                    const st = statusOf(entry);
                    const sm = STATUS_META[st] || { color: NX.dim, tint: NX.border2 };
                    return (
                      <button key={entry.id} onClick={() => setSelected(entry)} style={{
                        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', cursor: 'pointer',
                        borderTop: `1px solid ${NX.border2}`, borderLeft: 'none', borderRight: 'none', borderBottom: 'none',
                        background: 'transparent', padding: '12px 16px', fontFamily: FONT,
                      }}>
                        <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
                        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink }}>{entry.title}</span>
                        <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{entry.module}</span>
                        {entry.ticketRef && <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{entry.ticketRef}</span>}
                        <Badge label={st} color={sm.color} tint={sm.tint} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '64px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
            No releases yet.
          </div>
        )}
      </div>

      {selected && (
        <SlideOver entry={selected} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
          onClose={() => setSelected(null)} onSetStatus={onSetStatus}
          onEdit={isAdmin ? () => { onEdit(selected); setSelected(null); } : undefined} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Manage tab (admin) — pending-review queue + all updates
// ═══════════════════════════════════════════════════════════════════════════
function ManageTab({ entries, nameOf, myEmail, onSetStatus, onEdit, onAdd, onDelete }) {
  const [reviewing, setReviewing] = useState(null);
  const withStatus = useMemo(() => entries.map((e) => ({ entry: e, status: statusOf(e) })), [entries]);
  const pending = withStatus.filter((x) => x.status === 'Pending Review');
  const rest = withStatus.filter((x) => x.status !== 'Pending Review');

  return (
    <div style={{ padding: '20px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: NX.ink }}>Manage</h1>
        <button style={btn('primary')} onClick={onAdd}><Plus size={15} />Add new update</button>
      </div>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: NX.dim }}>
        Review updates that came in automatically from merged PRs (or submitted by teammates), edit them if needed, then
        publish. Updates you add here from Manage publish immediately.
      </p>

      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NX.ink }}>Pending review</h2>
        {pending.length > 0 && <Badge label={String(pending.length)} color="#d97706" tint="#fdefd7" />}
      </div>

      {pending.length === 0 ? (
        <div style={{ marginBottom: 24, borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '40px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
          Nothing waiting on review. Incoming PR updates and teammate submissions will show up here.
        </div>
      ) : (
        <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pending.map(({ entry }) => {
            const meta = typeMeta(entry.type);
            return (
              <div key={entry.id} style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
                <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
                <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink }}>{entry.title}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: NX.faint }}>
                    <span>{entry.module}</span><span>·</span><span>{formatDateTime(releasedKey(entry))}</span>
                    {entry.prRef && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><GitPullRequest size={12} />{entry.prRef}</span>}
                  </div>
                </div>
                <button style={btn('outline')} onClick={() => setReviewing(entry)}><Eye size={13} />Review</button>
                <button style={btn('outline')} onClick={() => onEdit(entry)}><Pencil size={13} />Edit</button>
                <button style={btn('primary')} onClick={() => onSetStatus(entry, 'Released')}><CheckCircle2 size={13} />Publish</button>
              </div>
            );
          })}
        </div>
      )}

      <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: NX.ink }}>All updates</h2>
      <div style={{ ...card, overflow: 'hidden' }}>
        {rest.map(({ entry, status }) => {
          const meta = typeMeta(entry.type);
          const sm = STATUS_META[status] || { color: NX.dim, tint: NX.border2 };
          return (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${NX.border2}`, padding: '10px 16px' }}>
              <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
              <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink }}>{entry.title}</span>
              <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{entry.module}</span>
              <Badge label={status} color={sm.color} tint={sm.tint} />
              <button onClick={() => onEdit(entry)} title="Edit" style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><Pencil size={14} /></button>
              <button onClick={() => onDelete(entry.id)} title="Delete" style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><Trash2 size={14} /></button>
            </div>
          );
        })}
        {rest.length === 0 && <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>No other updates yet.</div>}
      </div>

      {reviewing && (
        <div onMouseDown={(e) => e.target === e.currentTarget && setReviewing(null)} style={{ position: 'fixed', inset: 0, zIndex: 3200, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,0.4)' }}>
          <div style={{ height: '100%', width: 'min(760px, 90vw)', boxShadow: '-8px 0 40px rgba(0,0,0,0.28)' }}>
            <DetailCard entry={reviewing} nameOf={nameOf} myEmail={myEmail} isAdmin
              onClose={() => setReviewing(null)} onSetStatus={onSetStatus}
              onEdit={() => { onEdit(reviewing); setReviewing(null); }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Detail card — five sub-tabs (Overview / Technical Details / Media / Links / Comments)
// ═══════════════════════════════════════════════════════════════════════════
const DETAIL_TABS = ['Overview', 'Technical Details', 'Media', 'Related Links', 'Comments'];

function DetailCard({ entry, nameOf, myEmail, isAdmin, onClose, expanded, onToggleExpand, onEdit, onSetStatus }) {
  const [tab, setTab] = useState('Overview');
  const [status, setStatusLocal] = useState(() => statusOf(entry));
  const [statusOpen, setStatusOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState('');

  useEffect(() => { setStatusLocal(statusOf(entry)); }, [entry]);
  useEffect(() => {
    let alive = true;
    api.getTaskChangelogComments(entry.id).then((r) => { if (alive) setComments(r || []); }).catch(() => { if (alive) setComments([]); });
    return () => { alive = false; };
  }, [entry.id]);

  const meta = typeMeta(entry.type);
  const statusMeta = STATUS_META[status] || { color: NX.dim, tint: NX.border2 };
  const media = [entry.beforeImageDataUrl, entry.afterImageDataUrl, ...(entry.images || [])].filter(Boolean);
  const tags = entry.tags || [];
  const commentList = (comments || []).slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const changeStatus = (next) => { setStatusLocal(next); setStatusOpen(false); onSetStatus?.(entry, next); };
  const postComment = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await api.addTaskChangelogComment(entry.id, { body: text }).catch(() => {});
    api.getTaskChangelogComments(entry.id).then((r) => setComments(r || [])).catch(() => {});
  };

  const label11 = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: NX.surface, fontFamily: FONT }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 24px 0' }}>
        <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onEdit && <button onClick={onEdit} style={btn('outline')}><Pencil size={13} />Edit</button>}
          {isAdmin ? (
            <div style={{ position: 'relative' }}>
              <button onClick={() => setStatusOpen((o) => !o)} style={{ ...chip(statusMeta.color, statusMeta.tint), border: 'none', cursor: 'pointer', padding: '5px 11px' }}>
                {status}<ChevronDown size={13} />
              </button>
              {statusOpen && (
                <div style={{ position: 'absolute', right: 0, marginTop: 4, width: 160, zIndex: 10, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '4px 0', boxShadow: '0 12px 32px rgba(0,0,0,0.18)' }}>
                  {STATUSES.map((s) => (
                    <button key={s} onClick={() => changeStatus(s)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '7px 12px', fontSize: 13, color: NX.ink, fontFamily: FONT }}>{s}</button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span style={chip(statusMeta.color, statusMeta.tint)}>{status}</span>
          )}
          {onToggleExpand && (
            <button onClick={onToggleExpand} title={expanded ? 'Collapse' : 'Expand to full page'} style={{ ...btn('ghost'), padding: 6, color: NX.dim }}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          {onClose && <button onClick={onClose} aria-label="Close" style={{ ...btn('ghost'), padding: 6, color: NX.dim }}><X size={16} /></button>}
        </div>
      </div>

      {/* Title + meta */}
      <div style={{ padding: '8px 24px 16px' }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: NX.ink }}>{entry.title}</h2>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, fontSize: 13, color: NX.dim }}>
          {entry.module && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Layers size={13} style={{ color: NX.faint }} />{entry.module}</span>}
          {entry.version && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><GitBranch size={13} style={{ color: NX.faint }} /><span style={{ fontFamily: 'monospace' }}>{entry.version}</span></span>}
          {entry.environment && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: envColor(entry.environment) }} />{entry.environment}</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={13} style={{ color: NX.faint }} />{formatDateTime(releasedKey(entry))}</span>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', whiteSpace: 'nowrap', borderBottom: `1px solid ${NX.border}`, padding: '0 24px' }}>
        {DETAIL_TABS.map((t) => {
          const active = tab === t;
          const suffix = t === 'Media' ? ` (${media.length})` : t === 'Comments' ? ` (${commentList.length})` : '';
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              flexShrink: 0, cursor: 'pointer', border: 'none', borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`,
              background: 'transparent', padding: '10px 10px', fontSize: 13, fontWeight: 600, fontFamily: FONT,
              color: active ? NX.ink : NX.dim,
            }}>{t}{suffix}</button>
          );
        })}
      </div>

      {/* Sub-tab body */}
      <div className="nx-scroll" style={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {tab === 'Overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <h3 style={label11}>Description (Layman's Terms)</h3>
              <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, color: NX.ink, whiteSpace: 'pre-wrap' }}>{entry.description}</p>
            </div>
            {entry.businessImpact && (
              <div>
                <h3 style={{ ...label11, display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={13} />Business Impact</h3>
                <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6, color: NX.ink }}>{entry.businessImpact}</p>
              </div>
            )}
            {entry.userImpact && (
              <div>
                <h3 style={{ ...label11, display: 'flex', alignItems: 'center', gap: 6 }}><User size={13} />User Impact</h3>
                <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6, color: NX.ink }}>{entry.userImpact}</p>
              </div>
            )}
            {entry.whatsChanged && entry.whatsChanged.length > 0 && (
              <div>
                <h3 style={label11}>What's Changed</h3>
                <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {entry.whatsChanged.map((line, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, color: NX.ink }}>
                      <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1, color: NX.green }} />{line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(entry.beforeImageDataUrl || entry.afterImageDataUrl) && (
              <div>
                <h3 style={label11}>Screenshots</h3>
                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[['Before', entry.beforeImageDataUrl], ['After', entry.afterImageDataUrl]].map(([lbl, src]) => (
                    <div key={lbl}>
                      <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 600, color: NX.faint }}>{lbl}</div>
                      <button onClick={() => src && setPreview(src)} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', aspectRatio: '16 / 9',
                        overflow: 'hidden', borderRadius: 8, border: `1px dashed ${NX.border}`, background: NX.surface2, cursor: src ? 'zoom-in' : 'default', padding: 0,
                      }}>
                        {src ? <img src={src} alt={lbl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ImageIcon size={18} style={{ color: NX.faint }} />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(entry.authorId || entry.reviewerId || tags.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
                <div style={{ display: 'flex', gap: 24 }}>
                  {entry.authorId && <PersonInline label="Developer" email={entry.authorId} nameOf={nameOf} />}
                  {entry.reviewerId && <PersonInline label="Reviewer" email={entry.reviewerId} nameOf={nameOf} />}
                </div>
                {tags.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>Tags</div>
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {tags.slice(0, 3).map((t) => <span key={t} style={{ borderRadius: 999, border: `1px solid ${NX.border}`, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: NX.ink }}>{t}</span>)}
                      {tags.length > 3 && <span style={{ borderRadius: 999, border: `1px solid ${NX.border}`, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: NX.dim }}>+{tags.length - 3}</span>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'Technical Details' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[['Category', entry.type], ['Version', entry.version], ['Environment', entry.environment], ['Released', formatDateTime(releasedKey(entry))], ['Work Item', entry.ticketRef || '—'], ['Pull Request', entry.prRef || '—']].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>{k}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{v || '—'}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'Media' && (
          media.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '56px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
              <ImageIcon size={22} style={{ color: NX.faint }} />No media attached to this update.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {media.map((src, i) => (
                <button key={i} onClick={() => setPreview(src)} style={{ cursor: 'zoom-in', overflow: 'hidden', borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface2, padding: 0 }}>
                  <img src={src} alt="" style={{ width: '100%', height: 128, objectFit: 'cover' }} />
                </button>
              ))}
            </div>
          )
        )}

        {tab === 'Related Links' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!entry.links || entry.links.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '56px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
                <Link2 size={22} style={{ color: NX.faint }} />No links added.
              </div>
            ) : (
              entry.links.map((link) => (
                <a key={link.url} href={link.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, border: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, fontWeight: 600, color: NX.blue, textDecoration: 'none' }}>
                  <Link2 size={14} />{link.label}
                </a>
              ))
            )}
          </div>
        )}

        {tab === 'Comments' && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {comments === null ? (
                <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: NX.faint }}>Loading…</div>
              ) : commentList.length === 0 ? (
                <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '40px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>No comments yet. Be the first to add one.</div>
              ) : (
                commentList.map((c) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
                    <div style={{ minWidth: 0, flex: 1, borderRadius: 8, background: NX.surface2, padding: '8px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId)}</span>
                        {c.createdAt && <span style={{ fontSize: 11, color: NX.faint }}>{formatDateTime(c.createdAt)}</span>}
                      </div>
                      <div style={{ marginTop: 2, fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap' }}>{c.body}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${NX.border}`, paddingTop: 12 }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') postComment(); }} placeholder="Add a comment…" style={inputStyle} />
              <button onClick={postComment} disabled={!draft.trim()} aria-label="Post comment" style={{ ...btn('primary'), padding: 9, opacity: draft.trim() ? 1 : 0.4 }}><Send size={15} /></button>
            </div>
          </div>
        )}
      </div>

      {preview && (
        <Modal title={entry.title || 'Preview'} onClose={() => setPreview(null)} width={720}>
          <img src={preview} alt="" style={{ width: '100%', borderRadius: 8 }} />
        </Modal>
      )}
    </div>
  );
}

function PersonInline({ label, email, nameOf }) {
  const name = nameOf(email);
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>{label}</div>
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Avatar email={email} name={name} size={24} />
        <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{name}</span>
      </div>
    </div>
  );
}

// ── Slide-over wrapper (ported from ChangelogSlideOver) ───────────────────────
function SlideOver({ entry, nameOf, myEmail, isAdmin, onClose, onSetStatus, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 3200, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,0.4)' }}>
      <div style={{ height: '100%', width: expanded ? '100%' : 'min(760px, 92vw)', transition: 'width 0.18s ease', boxShadow: '-8px 0 40px rgba(0,0,0,0.28)' }}>
        <DetailCard entry={entry} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
          onClose={onClose} expanded={expanded} onToggleExpand={() => setExpanded((e) => !e)}
          onSetStatus={onSetStatus} onEdit={onEdit} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Add / edit modal (ported from AddUpdateModal)
// ═══════════════════════════════════════════════════════════════════════════
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function ScreenshotDropzone({ label, value, onChange }) {
  return (
    <div>
      <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 600, color: NX.faint }}>{label}</div>
      {value ? (
        <div style={{ position: 'relative' }}>
          <img src={value} alt={`${label} preview`} style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, border: `1px solid ${NX.border}` }} />
          <button onClick={() => onChange(undefined)} style={{ position: 'absolute', right: 8, top: 8, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '4px 8px', fontSize: 11, fontWeight: 600, fontFamily: FONT }}>Remove</button>
        </div>
      ) : (
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, aspectRatio: '16 / 9', cursor: 'pointer', borderRadius: 8, border: `1px dashed ${NX.border}`, textAlign: 'center', fontSize: 12, color: NX.dim }}>
          <Upload size={16} />Upload {label.toLowerCase()}
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await readAsDataUrl(f)); }} />
        </label>
      )}
    </div>
  );
}

function AddUpdateModal({ entry, submitLabel, myEmail, onClose, onSave }) {
  const p = payloadOf(entry || {});
  const people = usePeople();
  const [title, setTitle] = useState(p.title || '');
  const [description, setDescription] = useState(p.description || '');
  const [type, setType] = useState(p.type || 'New Feature');
  const [module, setModule] = useState(p.module || '');
  const [version, setVersion] = useState(p.version || '');
  const [environment, setEnvironment] = useState(p.environment || 'Production');
  const [ticketRef, setTicketRef] = useState(p.ticketRef || '');
  const [reviewerId, setReviewerId] = useState(p.reviewerId || '');
  const [businessImpact, setBusinessImpact] = useState(p.businessImpact || '');
  const [userImpact, setUserImpact] = useState(p.userImpact || '');
  const [whatsChanged, setWhatsChanged] = useState((p.whatsChanged || []).join('\n'));
  const [tags, setTags] = useState((p.tags || []).join(', '));
  const [linkLabel, setLinkLabel] = useState(p.links?.[0]?.label || '');
  const [linkUrl, setLinkUrl] = useState(p.links?.[0]?.url || '');
  const [beforeImg, setBeforeImg] = useState(p.beforeImageDataUrl);
  const [afterImg, setAfterImg] = useState(p.afterImageDataUrl);
  const [saving, setSaving] = useState(false);

  const canSave = title.trim() && description.trim() && module.trim() && version.trim() && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const payload = {
      ...p, // preserve fields we don't edit (status, origin, images, likedByEmails…)
      title: title.trim(),
      description: description.trim(),
      type,
      module: module.trim(),
      version: version.trim(),
      environment,
      releasedAt: p.releasedAt || nowLocalISO(),
      authorId: p.authorId || myEmail,
      reviewerId: reviewerId || undefined,
      ticketRef: ticketRef.trim() || undefined,
      businessImpact: businessImpact.trim() || undefined,
      userImpact: userImpact.trim() || undefined,
      whatsChanged: whatsChanged.split('\n').map((l) => l.trim()).filter(Boolean),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      links: linkLabel.trim() && linkUrl.trim() ? [{ label: linkLabel.trim(), url: linkUrl.trim() }] : undefined,
      beforeImageDataUrl: beforeImg,
      afterImageDataUrl: afterImg,
    };
    try { await onSave(payload); onClose(); } catch { setSaving(false); }
  };

  const footer = (
    <>
      <button onClick={onClose} style={btn('outline')}>Cancel</button>
      <button onClick={save} disabled={!canSave} style={{ ...btn('primary'), opacity: canSave ? 1 : 0.5 }}>{submitLabel || (entry ? 'Save changes' : 'Publish update')}</button>
    </>
  );

  return (
    <Modal title={entry ? 'Edit update' : 'Add new update'} onClose={onClose} width={640} footer={footer}>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fixed leave balance calculation" style={inputStyle} />
      </Field>
      <Field label="Description" hint="Write it in plain English — this is what everyone will read.">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="What changed, and why it matters to the people using it." style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Category">
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Module">
          <input value={module} onChange={(e) => setModule(e.target.value)} placeholder="e.g. HR, Dashboard, Tasks" style={inputStyle} />
        </Field>
        <Field label="Version">
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. v2.8.1" style={inputStyle} />
        </Field>
        <Field label="Environment">
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {ENVIRONMENTS.map((e2) => <option key={e2} value={e2}>{e2}</option>)}
          </select>
        </Field>
        <Field label="Ticket / work item (optional)">
          <input value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} placeholder="e.g. NEX-1250" style={inputStyle} />
        </Field>
        <Field label="Reviewer (optional)">
          <PersonSelect value={reviewerId || null} onChange={(v) => setReviewerId(v || '')} people={people} placeholder="No reviewer" />
        </Field>
      </div>

      <Field label="Business impact (optional)" hint="One sentence: the plain-English payoff for the business.">
        <input value={businessImpact} onChange={(e) => setBusinessImpact(e.target.value)} placeholder="e.g. Saves time and reduces manual errors for HR staff." style={inputStyle} />
      </Field>
      <Field label="User impact (optional)" hint="One sentence: what a user will notice or do differently.">
        <input value={userImpact} onChange={(e) => setUserImpact(e.target.value)} placeholder="e.g. Users will see a new option when creating a task." style={inputStyle} />
      </Field>
      <Field label="What's changed (optional)" hint="One bullet point per line.">
        <textarea value={whatsChanged} onChange={(e) => setWhatsChanged(e.target.value)} rows={3} placeholder={'Create recurring tasks with custom frequency\nSelect end date or number of occurrences'} style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>
      <Field label="Tags (optional)" hint="Comma-separated.">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. UI, Automation, Tasks" style={inputStyle} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Related link label (optional)">
          <input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder="e.g. Design doc" style={inputStyle} />
        </Field>
        <Field label="Related link URL (optional)">
          <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" style={inputStyle} />
        </Field>
      </div>

      <div style={{ marginBottom: 4 }}>
        <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 600, color: NX.dim }}>Screenshots (optional)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ScreenshotDropzone label="Before" value={beforeImg} onChange={setBeforeImg} />
          <ScreenshotDropzone label="After" value={afterImg} onChange={setAfterImg} />
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: NX.faint, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
