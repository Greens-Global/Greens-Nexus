// "Documentation & Changelog" — a company-wide feed of release notes, reached from
// the top-right profile dropdown (NOT the Tasks module). Standalone: it manages its
// own state via api.js + useRole/useNameResolver, so it needs no TasksProvider.
// Renders as a full-screen overlay.
//
// Ported from the standalone TypeScript changelog (tabbed: What's New / Timeline /
// Version History / Manage, with a status workflow + rich detail card). The SOURCE
// was localStorage-backed; here the backend stores each entry as a free-form
// `payload` dict (+ server-side comments), so every extra field below lives INSIDE
// the payload. `status` (Draft/Pending Review/Scheduled/Released) is a payload field.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, Plus, Bug, Flame, ShieldAlert, TrendingUp, Wrench, ArrowUpCircle,
  Heart, Send, Pencil, Trash2, GitBranch, Layers, CalendarDays,
  CheckCircle2, User, Tag, X, Clock, ClipboardCheck, Search, ChevronRight,
  ChevronDown, Image as ImageIcon, Link2, Maximize2, Minimize2, Eye,
  GitPullRequest, Upload, ArrowRight,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { NX, FONT, chip, card, btn, input as inputStyle } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect } from './components';
import { toast, useConfirm } from './shared';

// ── Change-type metadata (ported from changelogMeta.ts) ──────────────────────
const CHANGE_TYPE_META = {
  'Bug Fix':         { color: NX.red,    tint: '#fde5e5', icon: Bug },
  'Performance':     { color: NX.amber,  tint: '#fdefd7', icon: TrendingUp },
  'New Feature':     { color: NX.green,  tint: '#e3f5ea', icon: Sparkles },
  'Security Update': { color: NX.pink,   tint: '#fbe3ef', icon: ShieldAlert },
  'Hotfix':          { color: '#ea580c', tint: '#ffe4d6', icon: Flame },
  'Maintenance':     { color: NX.purple, tint: '#efe6fd', icon: Wrench },
  'Improvement':     { color: NX.blue,   tint: '#e0eafe', icon: ArrowUpCircle },
};
const CHANGE_TYPES = Object.keys(CHANGE_TYPE_META);
const typeMeta = (t) => CHANGE_TYPE_META[t] || { color: NX.dim, tint: NX.border2, icon: Sparkles };

// Environment → dot colour (ported from changelogMeta.ts ENVIRONMENT_META).
const ENV_META = {
  Production: '#16a34a', // green
  Staging:    '#d97706', // amber
  Beta:       '#2563eb', // blue
};
const ENVIRONMENTS = Object.keys(ENV_META);
const envColor = (env) => ENV_META[env] || NX.green;

// Status workflow (ported from changelogStatus.ts). Stored in payload.status.
const STATUS_META = {
  'Draft':          { color: NX.dim,   tint: '#eef0f3' },
  'Pending Review': { color: NX.amber, tint: '#fdefd7' },
  'Scheduled':      { color: NX.blue,  tint: '#e0eafe' },
  'Released':       { color: NX.green, tint: '#e3f5ea' },
};
const STATUSES = Object.keys(STATUS_META);
// Existing entries authored before the status field default to Released.
const statusOf = (e) => e?.status || 'Released';
const statusMeta = (s) => STATUS_META[s] || STATUS_META.Released;

// The server owns these three; everything else lives inside the payload we author.
function payloadOf(entry) {
  const { id, createdAt, updatedAt, ...rest } = entry || {};
  return rest;
}
// Preferred display timestamp: the authored release time, falling back to server create.
const relISO = (e) => e?.releasedAt || e?.createdAt || '';

// ── Date helpers (ported from changelogDateFormat.ts / relativeDay.ts) ────────
function toLocalDate(iso) {
  if (!iso) return null;
  const [datePart, timePart] = String(iso).split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y) return null;
  if (!timePart) return new Date(y, (m || 1) - 1, d || 1);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
}
function fmtDate(iso) {
  const d = toLocalDate(iso);
  return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}
function fmtDateTime(iso) {
  const d = toLocalDate(iso);
  if (!d || isNaN(d)) return '';
  const hasTime = String(iso).includes('T');
  return d.toLocaleString('en-US', hasTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatTime(iso) {
  if (!String(iso).includes('T')) return '';
  const d = toLocalDate(iso);
  return d && !isNaN(d) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}
function dateKey(iso) { return String(iso || '').split('T')[0]; }
function relativeDayLabel(iso) {
  const key = dateKey(iso);
  if (!key) return '';
  const day = new Date(`${key}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function nowLocalISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const TABS = [
  { key: 'whats-new',       label: "What's New",      icon: Sparkles },
  { key: 'timeline',        label: 'Timeline',        icon: Clock },
  { key: 'version-history', label: 'Version History', icon: Tag },
  { key: 'manage',          label: 'Manage',          icon: ClipboardCheck },
];

export default function Changelog({ onClose }) {
  const { myEmail, can } = useRole();
  const nameOf = useNameResolver();
  const people = usePeople();
  // Managers and above curate/publish (source used store.isAdmin). Everyone else
  // can submit updates, which land in the review queue.
  const isAdmin = typeof can === 'function' ? can('manager') : false;

  const [changelog, setChangelog] = useState([]);
  const [tab, setTab] = useState('whats-new');
  const [openId, setOpenId] = useState(null);          // detail slide-over
  const [expanded, setExpanded] = useState(false);
  const [composer, setComposer] = useState(null);      // null | { entry?, defaultStatus }
  const [confirm, confirmNode] = useConfirm();

  const reload = () => api.getTaskChangelog().then((r) => setChangelog(r || [])).catch(() => {});
  useEffect(() => { reload(); }, []);

  // Self-contained data layer (no TasksProvider): the free-form `payload` body has
  // no camel keys the context would remap, so we call api.js directly.
  const createChangelog = async (d) => { const r = await api.createTaskChangelog(d); setChangelog((p) => [r, ...p]); return r; };
  const updateChangelog = async (id, patch) => { const r = await api.updateTaskChangelog(id, patch); setChangelog((p) => p.map((x) => (x.id === id ? r : x))); return r; };
  const deleteChangelog = async (id) => { await api.deleteTaskChangelog(id); setChangelog((p) => p.filter((x) => x.id !== id)); };
  const getChangelogComments = (id) => api.getTaskChangelogComments(id);
  const addChangelogComment = (id, body) => api.addTaskChangelogComment(id, { body });

  // Esc closes the overlay; when a slide-over/composer is open it closes that first.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (composer) return;                 // its Modal handles its own Esc
      if (openId) { setOpenId(null); return; }
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, composer, onClose]);

  const allEntries = useMemo(
    () => (changelog || []).slice().sort((a, b) => String(relISO(b)).localeCompare(String(relISO(a)))),
    [changelog],
  );
  // Draft + Pending Review stay out of the public-facing tabs.
  const publishedEntries = useMemo(
    () => allEntries.filter((e) => statusOf(e) !== 'Pending Review' && statusOf(e) !== 'Draft'),
    [allEntries],
  );
  const pendingCount = useMemo(() => allEntries.filter((e) => statusOf(e) === 'Pending Review').length, [allEntries]);

  const openEntry = allEntries.find((e) => e.id === openId) || null;
  const openDetail = (id, full = false) => { setOpenId(id); setExpanded(full); };

  // Status change (publish / re-status) — writes payload.status.
  const setStatus = (entry, status) =>
    updateChangelog(entry.id, { payload: { ...payloadOf(entry), status } }).catch(() => {});

  const requestDelete = async (entry) => {
    const ok = await confirm({ title: 'Delete this entry?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    if (openId === entry.id) setOpenId(null);
    await deleteChangelog(entry.id).catch(() => {});
  };

  const detailProps = {
    isAdmin, myEmail, nameOf, people,
    onEdit: (e) => setComposer({ entry: e }),
    onDelete: requestDelete,
    onSetStatus: setStatus,
    updateChangelog, getChangelogComments, addChangelogComment,
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, fontFamily: FONT, color: NX.ink, background: NX.canvas, display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.13s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <Sparkles size={18} style={{ color: NX.blue }} />
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Documentation &amp; changelog</div>
          <div style={{ fontSize: 12, color: NX.dim }}>Track all updates, releases and changes across Nexus.</div>
        </div>
        <button
          style={{ ...btn('primary'), marginLeft: 'auto' }}
          onClick={() => setComposer({ defaultStatus: isAdmin ? 'Released' : 'Pending Review' })}
        ><Plus size={15} />Add new update</button>
        <button onClick={onClose} title="Close" aria-label="Close" style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><X size={18} /></button>
      </div>

      {/* Tabs */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 12px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {TABS.filter((t) => t.key !== 'manage' || isAdmin).map((t) => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 12px', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: FONT,
              color: active ? NX.ink : NX.dim, borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`,
            }}>
              <t.icon size={16} />{t.label}
              {t.key === 'manage' && pendingCount > 0 && (
                <span style={{ ...chip(NX.amber, '#fdefd7'), padding: '1px 7px', fontSize: 11 }}>{pendingCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas }}>
        {tab === 'whats-new' && <WhatsNewTab entries={publishedEntries} onOpen={(id) => openDetail(id)} nameOf={nameOf} />}
        {tab === 'timeline' && <TimelineTab entries={publishedEntries} onOpen={openDetail} {...detailProps} />}
        {tab === 'version-history' && <VersionHistoryTab entries={publishedEntries} onOpen={(id) => openDetail(id)} />}
        {tab === 'manage' && isAdmin && (
          <ManageTab
            entries={allEntries}
            onReview={(id) => openDetail(id)}
            onEdit={(e) => setComposer({ entry: e })}
            onAdd={() => setComposer({ defaultStatus: 'Released' })}
            onPublish={(e) => { setStatus(e, 'Released'); toast('Update published.', 'success'); }}
          />
        )}
      </div>

      {/* Detail slide-over (What's New / Version History / Manage review / Timeline expand) */}
      {openEntry && (
        <SlideOver expanded={expanded} onClose={() => setOpenId(null)}>
          <DetailCard
            entry={openEntry}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
            onClose={() => setOpenId(null)}
            {...detailProps}
          />
        </SlideOver>
      )}

      {composer && (
        <ComposerModal
          entry={composer.entry}
          defaultStatus={composer.defaultStatus}
          isAdmin={isAdmin}
          myEmail={myEmail}
          people={people}
          onClose={() => setComposer(null)}
          createChangelog={createChangelog}
          updateChangelog={updateChangelog}
        />
      )}

      {confirmNode}
    </div>,
    document.body,
  );
}

// ── What's New tab ───────────────────────────────────────────────────────────
function WhatsNewTab({ entries, onOpen, nameOf }) {
  const latest = entries[0];
  return (
    <div style={{ padding: '20px 20px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, maxWidth: 1180, margin: '0 auto 14px' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>What's new</div>
          <div style={{ fontSize: 13, color: NX.dim, marginTop: 2 }}>The single most recent published update.</div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{latest ? '1 update' : '0 updates'}</span>
      </div>

      {!latest ? (
        <EmptyState icon={Sparkles} title="Nothing published yet" hint="Add the first entry to start the changelog." />
      ) : (
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20 }}>
          <div style={{ flex: '1 1 520px', minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint, marginBottom: 8 }}>{relativeDayLabel(relISO(latest))}</div>
            <FeaturedCard entry={latest} nameOf={nameOf} onViewDetails={() => onOpen(latest.id)} />
          </div>
          <div style={{ flex: '0 0 320px', width: 320, maxWidth: '100%' }}>
            <StatsPanel entries={entries} />
          </div>
        </div>
      )}
    </div>
  );
}

function FeaturedCard({ entry, nameOf, onViewDetails }) {
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const thumb = (entry.images || [])[0] || entry.afterImageDataUrl || entry.beforeImageDataUrl;
  const changed = entry.whatsChanged || [];
  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 18, padding: 18, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={chip(meta.color, meta.tint)}><Icon size={12} />{entry.type || 'Update'}</span>
            {entry.module && <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{entry.module}</span>}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{entry.title || 'Untitled'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 12, color: NX.dim }}>
            {entry.version && <span style={{ fontFamily: 'monospace' }}>{entry.version}</span>}
            {entry.environment && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: envColor(entry.environment) }} />{entry.environment}</span>}
          </div>
          {entry.description && <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.6, color: NX.ink, whiteSpace: 'pre-wrap' }}>{entry.description}</p>}

          {entry.businessImpact && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, background: '#e0eafe', color: NX.blue, borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
              <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />{entry.businessImpact}
            </div>
          )}
          {entry.userImpact && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, color: NX.dim, fontSize: 13 }}>
              <User size={15} style={{ color: NX.faint, flexShrink: 0, marginTop: 1 }} />{entry.userImpact}
            </div>
          )}
          {changed.length > 0 && (
            <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {changed.slice(0, 4).map((line, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: NX.ink }}>
                  <CheckCircle2 size={14} style={{ color: NX.green, flexShrink: 0, marginTop: 1 }} />{line}
                </li>
              ))}
            </ul>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: `1px solid ${NX.border}`, fontSize: 12, color: NX.dim }}>
            {entry.authorId && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Avatar email={entry.authorId} name={nameOf(entry.authorId)} size={20} />{nameOf(entry.authorId)}</span>}
            {entry.ticketRef && <><span>·</span><span>{entry.ticketRef}</span></>}
            {entry.prRef && <><span>·</span><span>{entry.prRef}</span></>}
            <button onClick={onViewDetails} style={{ ...btn('ghost'), marginLeft: 'auto', color: NX.blue, padding: '4px 6px' }}>View full details <ArrowRight size={13} /></button>
          </div>
        </div>
        <button onClick={() => onViewDetails()} style={{
          flex: '0 0 220px', width: 220, maxWidth: '100%', aspectRatio: '16 / 9', border: `1px solid ${NX.border}`,
          borderRadius: 10, background: NX.surface2, cursor: 'pointer', overflow: 'hidden', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 0,
        }}>
          {thumb ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
                 : <ImageIcon size={22} style={{ color: NX.faint }} />}
        </button>
      </div>
    </div>
  );
}

// ── Stats panel (ported from ChangelogStatsPanel.tsx) ────────────────────────
function StatsPanel({ entries }) {
  const [period, setPeriod] = useState('week');
  const days = period === 'week' ? 7 : 30;
  const { total, counts } = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const inRange = entries.filter((e) => {
      const key = dateKey(relISO(e));
      if (!key) return false;
      const diff = Math.round((today.getTime() - new Date(`${key}T00:00:00`).getTime()) / 86400000);
      return diff >= 0 && diff < days;
    });
    const byType = {};
    inRange.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1; });
    return { total: inRange.length, counts: byType };
  }, [entries, period, days]);

  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Activity summary</div>
        <div style={{ display: 'flex', border: `1px solid ${NX.border}`, borderRadius: 8, padding: 2, fontSize: 11, fontWeight: 600 }}>
          {['week', 'month'].map((p) => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: FONT, fontWeight: 600,
              background: period === p ? NX.primary : 'transparent', color: period === p ? '#fff' : NX.dim,
            }}>{p === 'week' ? 'Week' : 'Month'}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 12, paddingBottom: 12, borderBottom: `1px solid ${NX.border}` }}>
        <span style={{ fontSize: 24, fontWeight: 800 }}>{total}</span>
        <span style={{ fontSize: 12, color: NX.dim }}>update{total === 1 ? '' : 's'} this {period}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {CHANGE_TYPES.filter((t) => counts[t]).map((t) => {
          const meta = typeMeta(t); const Icon = meta.icon;
          return (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: meta.color, background: meta.tint }}><Icon size={14} /></span>
              <span style={{ flex: 1, fontSize: 13 }}>{t}</span>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{counts[t]}</span>
            </div>
          );
        })}
        {total === 0 && <p style={{ fontSize: 12, color: NX.dim, margin: 0 }}>No updates published this {period}.</p>}
      </div>
    </div>
  );
}

// ── Timeline tab (ported from TimelineTab.tsx) ───────────────────────────────
const ALL = 'all';
function TimelineTab({ entries, onOpen, ...detailProps }) {
  const [query, setQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [envFilter, setEnvFilter] = useState(ALL);
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? null);

  const modules = useMemo(() => [...new Set(entries.map((e) => e.module).filter(Boolean))].sort(), [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (moduleFilter !== ALL && e.module !== moduleFilter) return false;
      if (typeFilter !== ALL && e.type !== typeFilter) return false;
      if (envFilter !== ALL && e.environment !== envFilter) return false;
      if (q && !`${e.title || ''} ${e.description || ''} ${e.ticketRef || ''} ${e.version || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, query, moduleFilter, typeFilter, envFilter]);

  useEffect(() => {
    if (!filtered.some((e) => e.id === selectedId)) setSelectedId(filtered[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  const groups = useMemo(() => {
    const byDay = new Map();
    filtered.forEach((e) => {
      const key = dateKey(relISO(e));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    });
    return [...byDay.entries()];
  }, [filtered]);

  // filtered comes in already sorted desc from the parent → selected is fresh from `entries`
  const selected = entries.find((e) => e.id === selectedId) || null;
  const selectStyle = { ...inputStyle, width: 'auto', minWidth: 150, cursor: 'pointer', padding: '8px 10px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '18px 20px 20px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint, pointerEvents: 'none' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search updates, tags, work items…" style={{ ...inputStyle, paddingLeft: 32 }} />
        </div>
        <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} style={selectStyle}>
          <option value={ALL}>All modules</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value={ALL}>All categories</option>
          {CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)} style={selectStyle}>
          <option value={ALL}>All environments</option>
          {ENVIRONMENTS.map((en) => <option key={en} value={en}>{en}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Activity timeline</div>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{filtered.length} entries</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <div className="nx-scroll" style={{ minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18, paddingRight: 2 }}>
          {groups.map(([key, group]) => (
            <div key={key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{relativeDayLabel(key)}</span>
                <span style={{ ...chip(NX.dim, NX.border2), fontSize: 11 }}>{group.length} update{group.length === 1 ? '' : 's'}</span>
              </div>
              <div style={{ ...card, overflow: 'hidden' }}>
                {group.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} selected={entry.id === selectedId} onClick={() => setSelectedId(entry.id)} />
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <EmptyState icon={Search} title="No updates match your filters" />}
        </div>

        <div style={{ minHeight: 0 }}>
          {selected ? (
            <div style={{ height: '100%', ...card, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <DetailCard entry={selected} expanded={false} onToggleExpand={() => onOpen(selected.id, true)} {...detailProps} />
            </div>
          ) : (
            <div style={{ height: '100%', ...card, borderStyle: 'dashed', display: 'flex', alignItems: 'center', justifyContent: 'center', color: NX.dim, fontSize: 13 }}>
              Select an update to see details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ entry, selected, onClick }) {
  const meta = typeMeta(entry.type); const Icon = meta.icon;
  const thumb = (entry.images || [])[0] || entry.afterImageDataUrl;
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px',
      border: 'none', borderBottom: `1px solid ${NX.border}`, cursor: 'pointer', fontFamily: FONT,
      background: selected ? NX.hover : 'transparent',
    }}>
      <span style={{ width: 46, flexShrink: 0, fontFamily: 'monospace', fontSize: 12, color: NX.dim }}>{formatTime(relISO(entry))}</span>
      <span style={{ width: 8, height: 8, flexShrink: 0, borderRadius: '50%', background: meta.color }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}><Icon size={11} />{entry.type}</span>
          <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title || 'Untitled'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim, overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.module}</span>
          {entry.version && <><span>·</span><span style={{ fontFamily: 'monospace' }}>{entry.version}</span></>}
          {entry.environment && <><span>·</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: envColor(entry.environment) }} />{entry.environment}</span></>}
        </div>
      </div>
      <div style={{ width: 64, flexShrink: 0, aspectRatio: '16 / 9', borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface2, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {thumb ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} /> : <ImageIcon size={15} style={{ color: NX.faint }} />}
      </div>
      <ChevronRight size={16} style={{ flexShrink: 0, color: NX.faint }} />
    </button>
  );
}

// ── Version History tab (ported from VersionHistoryTab.tsx) ──────────────────
function VersionHistoryTab({ entries, onOpen }) {
  const groups = useMemo(() => {
    const byVersion = new Map();
    entries.forEach((e) => {
      const v = e.version || 'Unversioned';
      if (!byVersion.has(v)) byVersion.set(v, { version: v, releasedAt: relISO(e), entries: [] });
      byVersion.get(v).entries.push(e);
    });
    return [...byVersion.values()].sort((a, b) => (a.releasedAt < b.releasedAt ? 1 : -1));
  }, [entries]);

  const [open, setOpen] = useState(groups[0]?.version ?? null);

  return (
    <div style={{ padding: '18px 20px 40px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Release versions</div>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{groups.length} versions</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map((g) => {
          const isOpen = open === g.version;
          const counts = {};
          g.entries.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
          return (
            <div key={g.version} style={{ ...card, overflow: 'hidden' }}>
              <button onClick={() => setOpen(isOpen ? null : g.version)} style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px',
                border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT,
              }}>
                {isOpen ? <ChevronDown size={16} style={{ color: NX.dim }} /> : <ChevronRight size={16} style={{ color: NX.dim }} />}
                <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700 }}>{g.version}</span>
                <span style={{ fontSize: 12, color: NX.dim }}>Released {dateKey(g.releasedAt)}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
                  {Object.entries(counts).map(([t, c]) => {
                    const meta = typeMeta(t);
                    return <span key={t} style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}>{c} {t}</span>;
                  })}
                </div>
              </button>
              {isOpen && (
                <div style={{ borderTop: `1px solid ${NX.border}` }}>
                  {g.entries.map((e) => {
                    const meta = typeMeta(e.type); const sm = statusMeta(statusOf(e));
                    return (
                      <button key={e.id} onClick={() => onOpen(e.id)} style={{
                        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 14px',
                        border: 'none', borderTop: `1px solid ${NX.border2}`, background: 'transparent', cursor: 'pointer', fontFamily: FONT,
                      }}>
                        <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}>{e.type}</span>
                        <span style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || 'Untitled'}</span>
                        <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{e.module}</span>
                        {e.ticketRef && <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{e.ticketRef}</span>}
                        <span style={{ ...chip(sm.color, sm.tint), fontSize: 11 }}>{statusOf(e)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <EmptyState icon={Tag} title="No releases yet" />}
      </div>
    </div>
  );
}

// ── Manage tab (ported from ManageTab.tsx) — admin-gated by the parent ────────
function ManageTab({ entries, onReview, onEdit, onAdd, onPublish }) {
  const withStatus = entries.map((e) => ({ entry: e, status: statusOf(e) }));
  const pending = withStatus.filter((x) => x.status === 'Pending Review');
  const rest = withStatus.filter((x) => x.status !== 'Pending Review');

  return (
    <div style={{ padding: '18px 20px 40px', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Manage</div>
        <button onClick={onAdd} style={btn('primary')}><Plus size={15} />Add new update</button>
      </div>
      <p style={{ fontSize: 13, color: NX.dim, margin: '0 0 20px' }}>
        Review updates submitted by teammates (or incoming from merged PRs), edit them if needed, then publish.
        Updates you add here publish immediately.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Pending review</div>
        {pending.length > 0 && <span style={{ ...chip(NX.amber, '#fdefd7'), fontSize: 11 }}>{pending.length}</span>}
      </div>

      {pending.length === 0 ? (
        <div style={{ ...card, borderStyle: 'dashed', padding: '28px 16px', textAlign: 'center', fontSize: 13, color: NX.dim, marginBottom: 24 }}>
          Nothing waiting on review. Teammate submissions and incoming PR updates will show up here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
          {pending.map(({ entry }) => {
            const meta = typeMeta(entry.type);
            return (
              <div key={entry.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', flexWrap: 'wrap' }}>
                <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}>{entry.type}</span>
                <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title || 'Untitled'}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: NX.faint }}>
                    <span>{entry.module}</span><span>·</span><span>{fmtDateTime(relISO(entry))}</span>
                    {entry.prRef && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><GitPullRequest size={12} />{entry.prRef}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <button onClick={() => onReview(entry.id)} style={{ ...btn('outline'), padding: '6px 10px' }}><Eye size={13} />Review</button>
                  <button onClick={() => onEdit(entry)} style={{ ...btn('outline'), padding: '6px 10px' }}><Pencil size={13} />Edit</button>
                  <button onClick={() => onPublish(entry)} style={{ ...btn('primary'), padding: '6px 10px' }}><CheckCircle2 size={13} />Publish</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>All updates</div>
      <div style={{ ...card, overflow: 'hidden' }}>
        {rest.map(({ entry, status }) => {
          const meta = typeMeta(entry.type); const sm = statusMeta(status);
          return (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: `1px solid ${NX.border2}` }}>
              <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}>{entry.type}</span>
              <span style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title || 'Untitled'}</span>
              <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{entry.module}</span>
              <span style={{ ...chip(sm.color, sm.tint), fontSize: 11 }}>{status}</span>
              <button onClick={() => onEdit(entry)} title="Edit" style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><Pencil size={14} /></button>
            </div>
          );
        })}
        {rest.length === 0 && <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 13, color: NX.dim }}>No other updates yet.</div>}
      </div>
    </div>
  );
}

// ── Slide-over shell (ported from ChangelogSlideOver.tsx) ────────────────────
function SlideOver({ expanded, onClose, children }) {
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 3200, display: 'flex', justifyContent: 'flex-end', background: 'rgba(17,24,39,0.45)', fontFamily: FONT, animation: 'fadeIn 0.13s ease' }}
    >
      <div style={{ height: '100%', width: expanded ? '100%' : 'min(680px, 100%)', background: NX.surface, boxShadow: '-16px 0 48px rgba(0,0,0,0.24)', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  );
}

// ── Detail card with sub-tabs (ported from ChangelogDetailCard.tsx) ──────────
const DETAIL_TABS = ['Overview', 'Technical Details', 'Media', 'Related Links', 'Comments'];

function DetailCard({
  entry, onClose, expanded, onToggleExpand, onEdit, onDelete, onSetStatus,
  isAdmin, myEmail, nameOf, updateChangelog, getChangelogComments, addChangelogComment,
}) {
  const [tab, setTab] = useState('Overview');
  const [statusOpen, setStatusOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [comments, setComments] = useState(null);

  const meta = typeMeta(entry.type); const Icon = meta.icon;
  const status = statusOf(entry); const sm = statusMeta(status);
  const media = [entry.beforeImageDataUrl, entry.afterImageDataUrl, ...(entry.images || [])].filter(Boolean);
  const tags = entry.tags || [];
  const liked = (entry.likedByEmails || []).includes(myEmail);
  const likeCount = (entry.likedByEmails || []).length;

  const loadComments = () => getChangelogComments(entry.id).then((r) => setComments(r || [])).catch(() => setComments([]));
  useEffect(() => { setComments(null); loadComments(); /* eslint-disable-next-line */ }, [entry.id]);

  const toggleLike = () => {
    const set = new Set(entry.likedByEmails || []);
    liked ? set.delete(myEmail) : set.add(myEmail);
    updateChangelog(entry.id, { payload: { ...payloadOf(entry), likedByEmails: [...set] } }).catch(() => {});
  };

  const commentCount = (comments || []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: NX.surface, fontFamily: FONT }}>
      {/* Header actions */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '16px 18px 6px' }}>
        <span style={chip(meta.color, meta.tint)}><Icon size={12} />{entry.type || 'Update'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={toggleLike} title={liked ? 'Liked' : 'Like'} style={{ ...btn('outline'), padding: '5px 9px', color: liked ? NX.red : NX.dim }}>
            <Heart size={13} style={{ fill: liked ? NX.red : 'none' }} />{likeCount || 0}
          </button>
          {onEdit && <button onClick={() => onEdit(entry)} style={{ ...btn('outline'), padding: '5px 9px' }}><Pencil size={13} />Edit</button>}
          {onDelete && <button onClick={() => onDelete(entry)} title="Delete" style={{ ...btn('outline'), padding: '5px 9px', color: NX.red }}><Trash2 size={13} /></button>}
          {/* Status changer — admins only (source used store.isAdmin). */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => isAdmin && setStatusOpen((o) => !o)} style={{ ...chip(sm.color, sm.tint), border: 'none', cursor: isAdmin ? 'pointer' : 'default', padding: '4px 10px' }}>
              {status}{isAdmin && <ChevronDown size={13} />}
            </button>
            {statusOpen && isAdmin && (
              <div style={{ position: 'absolute', right: 0, marginTop: 4, zIndex: 20, width: 160, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.18)', padding: 4 }}>
                {STATUSES.map((s) => (
                  <button key={s} onClick={() => { onSetStatus(entry, s); setStatusOpen(false); }} style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 7, border: 'none',
                    background: s === status ? NX.hover : 'transparent', color: NX.ink, fontSize: 13, cursor: 'pointer', fontFamily: FONT,
                  }}>{s}</button>
                ))}
              </div>
            )}
          </div>
          {onToggleExpand && (
            <button onClick={onToggleExpand} title={expanded ? 'Collapse' : 'Expand'} style={{ ...btn('ghost'), padding: 6, color: NX.dim }}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          {onClose && <button onClick={onClose} title="Close" style={{ ...btn('ghost'), padding: 6, color: NX.dim }}><X size={16} /></button>}
        </div>
      </div>

      {/* Title + meta */}
      <div style={{ padding: '4px 18px 12px' }}>
        <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>{entry.title || 'Untitled'}</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 6, fontSize: 12.5, color: NX.dim }}>
          {entry.module && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Layers size={13} style={{ color: NX.faint }} />{entry.module}</span>}
          {entry.version && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'monospace' }}><GitBranch size={13} style={{ color: NX.faint }} />{entry.version}</span>}
          {entry.environment && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: envColor(entry.environment) }} />{entry.environment}</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><CalendarDays size={13} style={{ color: NX.faint }} />{fmtDateTime(relISO(entry))}</span>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 2, padding: '0 18px', borderBottom: `1px solid ${NX.border}`, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {DETAIL_TABS.map((t) => {
          const active = tab === t;
          const suffix = t === 'Media' ? ` (${media.length})` : t === 'Comments' ? ` (${commentCount})` : '';
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '9px 10px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT, border: 'none',
              background: 'transparent', color: active ? NX.ink : NX.dim, borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`,
            }}>{t}{suffix}</button>
          );
        })}
      </div>

      {/* Sub-tab body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px' }}>
        {tab === 'Overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <SubHead>Description (in plain terms)</SubHead>
              <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{entry.description || '—'}</p>
            </div>
            {entry.whatsChanged?.length > 0 && (
              <div>
                <SubHead>What's changed</SubHead>
                <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {entry.whatsChanged.map((line, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5 }}>
                      <CheckCircle2 size={15} style={{ color: NX.green, flexShrink: 0, marginTop: 1 }} />{line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {entry.businessImpact && (
              <div>
                <SubHead icon={CheckCircle2}>Business impact</SubHead>
                <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6 }}>{entry.businessImpact}</p>
              </div>
            )}
            {entry.userImpact && (
              <div>
                <SubHead icon={User}>User impact</SubHead>
                <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6 }}>{entry.userImpact}</p>
              </div>
            )}
            {(entry.beforeImageDataUrl || entry.afterImageDataUrl) && (
              <div>
                <SubHead>Screenshots</SubHead>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                  {['Before', 'After'].map((lbl) => {
                    const src = lbl === 'Before' ? entry.beforeImageDataUrl : entry.afterImageDataUrl;
                    return (
                      <div key={lbl}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint, marginBottom: 4 }}>{lbl}</div>
                        <button onClick={() => src && setPreview(src)} style={{ width: '100%', aspectRatio: '16 / 9', border: `1px dashed ${NX.border}`, borderRadius: 8, background: NX.surface2, cursor: src ? 'zoom-in' : 'default', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                          {src ? <img src={src} alt={lbl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <ImageIcon size={18} style={{ color: NX.faint }} />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {(entry.authorId || entry.reviewerId || tags.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  {entry.authorId && <PersonInline label="Developer" email={entry.authorId} nameOf={nameOf} />}
                  {entry.reviewerId && <PersonInline label="Reviewer" email={entry.reviewerId} nameOf={nameOf} />}
                </div>
                {tags.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>Tags</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {tags.map((t) => <span key={t} style={{ fontSize: 12, fontWeight: 600, color: NX.ink, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px' }}>{t}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'Technical Details' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <TechField label="Category" value={entry.type} />
            <TechField label="Version" value={entry.version} />
            <TechField label="Environment" value={entry.environment} />
            <TechField label="Released" value={fmtDateTime(relISO(entry))} />
            <TechField label="Work item" value={entry.ticketRef} />
            <TechField label="Pull request" value={entry.prRef} />
            <TechField label="Reviewer" value={entry.reviewerId ? nameOf(entry.reviewerId) : ''} />
            <TechField label="Status" value={status} />
          </div>
        )}

        {tab === 'Media' && (
          media.length === 0 ? (
            <EmptyState icon={ImageIcon} title="No media attached to this update." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {media.map((src, i) => (
                <button key={i} onClick={() => setPreview(src)} style={{ border: `1px solid ${NX.border}`, borderRadius: 8, background: NX.surface2, cursor: 'zoom-in', overflow: 'hidden', padding: 0 }}>
                  <img src={src} alt={`media ${i + 1}`} style={{ width: '100%', height: 130, objectFit: 'cover' }} />
                </button>
              ))}
            </div>
          )
        )}

        {tab === 'Related Links' && (
          !entry.links || entry.links.length === 0 ? (
            <EmptyState icon={Link2} title="No links added." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entry.links.map((link, i) => (
                <a key={i} href={link.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 13, fontWeight: 600, color: NX.blue, textDecoration: 'none' }}>
                  <Link2 size={14} />{link.label || link.url}
                </a>
              ))}
            </div>
          )
        )}

        {tab === 'Comments' && (
          <CommentsPanel comments={comments} nameOf={nameOf} entryId={entry.id} addChangelogComment={addChangelogComment} reload={loadComments} />
        )}
      </div>

      {preview && (
        <Modal title={entry.title || 'Preview'} onClose={() => setPreview(null)} width={760}>
          <img src={preview} alt="preview" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
        </Modal>
      )}
    </div>
  );
}

function SubHead({ label, children, icon: Icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint }}>
      {Icon && <Icon size={13} />}{label || children}
    </div>
  );
}
function TechField({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{value || '—'}</div>
    </div>
  );
}
function PersonInline({ label, email, nameOf }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <Avatar email={email} name={nameOf(email)} size={22} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{nameOf(email)}</span>
      </div>
    </div>
  );
}

// ── Comments (server-backed) ─────────────────────────────────────────────────
function CommentsPanel({ comments, nameOf, entryId, addChangelogComment, reload }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const list = (comments || []).slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const submit = async () => {
    const b = body.trim();
    if (!b || busy) return;
    setBusy(true); setBody('');
    await addChangelogComment(entryId, b).catch(() => {});
    await reload();
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          rows={2} placeholder="Add a comment… (⌘/Ctrl+Enter)" style={{ ...inputStyle, resize: 'vertical', fontSize: 13 }} />
        <button onClick={submit} disabled={!body.trim() || busy} style={{ ...btn('primary'), alignSelf: 'flex-end', opacity: !body.trim() || busy ? 0.5 : 1 }}>
          <Send size={14} />Add
        </button>
      </div>
      {comments === null ? (
        <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>No comments yet. Be the first.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {list.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 10 }}>
              <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{nameOf(c.authorId)}</span>
                  <span style={{ fontSize: 11, color: NX.faint }}>{c.createdAt ? fmtDateTime(c.createdAt) : ''}</span>
                </div>
                <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', fontSize: 13, color: NX.dim }}>{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Composer (ported from AddUpdateModal.tsx) ────────────────────────────────
function ComposerModal({ entry, defaultStatus, isAdmin, myEmail, people, onClose, createChangelog, updateChangelog }) {
  const editing = !!entry;
  const p = payloadOf(entry || {});
  const [title, setTitle] = useState(p.title || '');
  const [description, setDescription] = useState(p.description || '');
  const [type, setType] = useState(p.type || 'New Feature');
  const [module, setModule] = useState(p.module || '');
  const [version, setVersion] = useState(p.version || '');
  const [environment, setEnvironment] = useState(p.environment || 'Production');
  const [ticketRef, setTicketRef] = useState(p.ticketRef || '');
  const [reviewerId, setReviewerId] = useState(p.reviewerId || null);
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
      ...p, // preserve unedited fields (likedByEmails, images, prRef…)
      title: title.trim(),
      description: description.trim(),
      type, module: module.trim(), version: version.trim(), environment,
      ticketRef: ticketRef.trim() || undefined,
      reviewerId: reviewerId || undefined,
      businessImpact: businessImpact.trim() || undefined,
      userImpact: userImpact.trim() || undefined,
      whatsChanged: whatsChanged.split('\n').map((l) => l.trim()).filter(Boolean),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      links: linkLabel.trim() && linkUrl.trim() ? [{ label: linkLabel.trim(), url: linkUrl.trim() }] : undefined,
      beforeImageDataUrl: beforeImg,
      afterImageDataUrl: afterImg,
      authorId: p.authorId || myEmail,
      releasedAt: p.releasedAt || nowLocalISO(),
      status: editing ? statusOf(entry) : (defaultStatus || 'Released'),
    };
    try {
      if (editing) await updateChangelog(entry.id, { payload });
      else await createChangelog({ payload });
      toast(editing ? 'Update saved.' : (isAdmin ? 'Update published.' : 'Submitted for review — an admin will publish it once approved.'), 'success');
      onClose();
    } catch { setSaving(false); }
  };

  const submitLabel = editing ? 'Save changes' : (isAdmin ? 'Publish update' : 'Submit for review');
  const footer = (
    <>
      <button onClick={onClose} style={btn('outline')}>Cancel</button>
      <button onClick={save} disabled={!canSave} style={{ ...btn('primary'), opacity: canSave ? 1 : 0.5 }}>{submitLabel}</button>
    </>
  );

  return (
    <Modal title={editing ? 'Edit update' : 'Add new update'} onClose={onClose} width={640} footer={footer}>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fixed leave balance calculation" style={inputStyle} />
      </Field>
      <Field label="Description" hint="Write it in plain English — this is what everyone reads.">
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
            {ENVIRONMENTS.map((en) => <option key={en} value={en}>{en}</option>)}
          </select>
        </Field>
        <Field label="Ticket / work item" hint="Optional.">
          <input value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} placeholder="e.g. NEX-1250" style={inputStyle} />
        </Field>
        <Field label="Reviewer" hint="Optional.">
          <PersonSelect value={reviewerId} onChange={setReviewerId} people={people} placeholder="No reviewer" />
        </Field>
      </div>

      <Field label="Business impact" hint="Optional — one sentence: the plain-English payoff for the business.">
        <input value={businessImpact} onChange={(e) => setBusinessImpact(e.target.value)} placeholder="e.g. Saves time and reduces manual errors for HR staff." style={inputStyle} />
      </Field>
      <Field label="User impact" hint="Optional — one sentence: what a user will notice or do differently.">
        <input value={userImpact} onChange={(e) => setUserImpact(e.target.value)} placeholder="e.g. Users will see a new option when creating a task." style={inputStyle} />
      </Field>
      <Field label="What's changed" hint="Optional — one bullet per line.">
        <textarea value={whatsChanged} onChange={(e) => setWhatsChanged(e.target.value)} rows={3} placeholder={'Create recurring tasks with custom frequency\nSelect end date or number of occurrences'} style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>
      <Field label="Tags" hint="Optional — comma-separated.">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. UI, Automation, Tasks" style={inputStyle} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Related link label" hint="Optional.">
          <input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder="e.g. Design doc" style={inputStyle} />
        </Field>
        <Field label="Related link URL" hint="Optional.">
          <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" style={inputStyle} />
        </Field>
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 6 }}>Screenshots (optional)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ScreenshotDropzone label="Before" value={beforeImg} onChange={setBeforeImg} />
          <ScreenshotDropzone label="After" value={afterImg} onChange={setAfterImg} />
        </div>
      </div>
    </Modal>
  );
}

function ScreenshotDropzone({ label, value, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint, marginBottom: 4 }}>{label}</div>
      {value ? (
        <div style={{ position: 'relative' }}>
          <img src={value} alt={label} style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, border: `1px solid ${NX.border}`, display: 'block' }} />
          <button onClick={() => onChange(undefined)} style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>Remove</button>
        </div>
      ) : (
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, aspectRatio: '16 / 9', border: `1px dashed ${NX.border}`, borderRadius: 8, cursor: 'pointer', color: NX.dim, fontSize: 12, textAlign: 'center' }}>
          <Upload size={16} />Upload {label.toLowerCase()}
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await readAsDataUrl(f)); }} />
        </label>
      )}
    </div>
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
