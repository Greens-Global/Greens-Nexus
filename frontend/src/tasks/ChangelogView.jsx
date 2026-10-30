// "What's New" (was "Documentation & Changelog") - a company-wide feed of release notes, reached from
// the top-right profile dropdown (NOT the Tasks module). Standalone: it manages its
// own state via api.js + useRole/useNameResolver, so it needs no TasksProvider.
// Renders as a full-screen overlay.
//
// This is a 1:1 port of the standalone export's changelog feature (src/nexus/changelog/*):
//   • two public tabs - What's New and Timeline (Version History was folded into the
//     Timeline, Pranshu Oct 16 2026: each day names its versions, and there is a Version filter)
//   • Manage is a header button for admins, not a tab (Pranshu, Oct 16 2026)
//   • a rich detail card with sub-tabs (Overview / Technical Details / Media / Related Links / Comments,
//     + Analytics for admins)
//   • a status workflow (Pending Review → Released / Scheduled / Draft). Merged work is
//     published automatically; publishing a teammate's submission and re-publishing an
//     edited update go through POST /task-changelog/{id}/publish, which stamps the release time
//   • reactions for every reader, and reach / response analytics for admins
//   • an author form with before/after screenshots, reviewer, work-item/PR refs and related links
//
// The backend stores each entry as a free-form `payload` dict (task_changelog_entries),
// so every field below lives inside that payload; the server owns only id/createdAt/updatedAt.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../lib/useDialogFocus';
import { LoadingState } from '../components/AsyncState';
import {
  Sparkles, Clock, ClipboardCheck, Plus, X, ArrowRight, CheckCircle2, User,
  ImageIcon, Search, ChevronRight, ChevronDown, GitBranch, Layers, CalendarDays,
  Link2, Maximize2, Minimize2, Pencil, Send, Bug, Flame, ShieldAlert, TrendingUp,
  Wrench, ArrowUpCircle, Upload, Eye, GitPullRequest, Trash2, AlertTriangle,
  ArrowLeft, RefreshCw, MessageSquare, Pin, Copy, Lightbulb, Server,
  SlidersHorizontal, MoreHorizontal, ChevronLeft, Bell, BellRing,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { filesFromPaste } from './lib';
import { localDayKey, formatFullDate, formatTime, formatDateTime, relativeDayLabel, isWithinDays } from './changelogDates';
import { useBackToClose } from '../lib/useBackToClose';
import { useVisualViewport } from '../lib/useVisualViewport';
import { BottomSheet } from './MobileTaskBar';
import { canEditWhatsNew } from '../lib/whatsNewAccess';
import { NX, FONT, chip, card, btn, input as inputStyle } from './theme';
import { Avatar, Modal, usePeople, PersonSelect, useClickOutside, useIsMobile, DateField, TimeField, localTodayISO } from './components';
import { MODULES } from '../contexts/RoleContext';
import {
  RichText, VideoEmbed, ActionRequired, CopyLinkButton, CommentThread, FeedbackRow, RelatedUpdates, RELATION_LABELS,
  HistoryList, FollowDialog, FollowButton, AudiencePicker, InsightsPanel, FeedbackList, ExportButtons, exportCsv, buildPrintReport, nextVersions, plural,
} from './changelogExtras';
import {
  MyRequestsDialog, IssueChip, IssueBanner, IssueDialog, issueOf, DeprecationChip, DeprecationNotice, StageChip, stageOf,
  AttentionStrip, MediaEditor, AttachmentList, TourEditor, TakeTourButton, uploadWhatsNewFile, readAsDataUrl as readFileAsDataUrl,
} from './changelogLifecycle';

// ── Change-type / environment / status metadata (ported from changelogMeta.ts) ──
const CHANGE_TYPE_META = {
  'Bug Fix':         { label: 'Bug Fix',         color: '#dc2626', tint: 'rgba(220,38,38,0.15)', icon: Bug },
  'Performance':     { label: 'Performance',     color: '#d97706', tint: 'rgba(217,119,6,0.16)', icon: TrendingUp },
  'New Feature':     { label: 'New Feature',     color: '#16a34a', tint: 'rgba(22,163,74,0.15)', icon: Sparkles },
  'Security Update': { label: 'Security Update', color: '#db2777', tint: 'rgba(219,39,119,0.15)', icon: ShieldAlert },
  'Hotfix':          { label: 'Hotfix',          color: '#ea580c', tint: 'rgba(217,119,6,0.16)', icon: Flame },
  'Maintenance':     { label: 'Maintenance',     color: '#7c3aed', tint: 'rgba(124,58,237,0.15)', icon: Wrench },
  'Improvement':     { label: 'Improvement',     color: '#2563eb', tint: 'rgba(37,99,235,0.15)', icon: ArrowUpCircle },
};
const CHANGE_TYPES = ['Bug Fix', 'Performance', 'New Feature', 'Security Update', 'Hotfix', 'Maintenance', 'Improvement'];
// Their colors and the Dev Only / In Production labels: changelogLifecycle stageOf.
const ENVIRONMENTS = ['Production', 'Staging', 'Beta'];
const STATUS_META = {
  'Pending Review': { color: '#d97706', tint: 'rgba(217,119,6,0.16)' },
  'Released':       { color: '#16a34a', tint: 'rgba(22,163,74,0.15)' },
  'Scheduled':      { color: '#2563eb', tint: 'rgba(37,99,235,0.15)' },
  'Draft':          { color: '#5b6472', tint: 'rgba(128,140,160,0.16)' },
};
const STATUSES = ['Pending Review', 'Released', 'Scheduled', 'Draft'];
const typeMeta = (t) => CHANGE_TYPE_META[t] || { label: t || 'Update', color: NX.dim, tint: NX.border2, icon: Sparkles };

// Date helpers live in changelogDates.js (they read UTC release times right).

// Reactions (Pranshu, Oct 16 2026) - the same keys, in the same order, as the
// server's task_config.CHANGELOG_REACTIONS.
const REACTIONS = [
  { key: 'like', emoji: '👍', label: 'Like' },
  { key: 'celebrate', emoji: '🎉', label: 'Celebrate' },
  { key: 'love', emoji: '❤️', label: 'Love' },
  { key: 'helpful', emoji: '💡', label: 'Helpful' },
  { key: 'confused', emoji: '😕', label: 'Confused' },
];

// The server owns id/createdAt/updatedAt and reads out the reactions and the
// comment count; everything else lives in the payload we author.
function payloadOf(entry) {
  const { id, createdAt, updatedAt, reactions, myReactions, commentCount, ...rest } = entry || {};
  return rest;
}

// What the screen's rows and cards need from the root without passing it
// through every tab: reacting, publishing, and whether this reader is an admin.
// sinceAt: updates released after it are new since this reader's last visit.
// all: every update this reader can see (related updates, version numbers).
// forYou(entry): is it about a module this reader uses. openEntry(id): show
// one update in full, from anywhere on the page.
const ChangelogActions = createContext({
  isAdmin: false, onReact: () => {}, onPublish: undefined, onCommented: () => {},
  sinceAt: '', all: [], forYou: () => true, openEntry: () => {}, flash: () => {},
});
const isNew = (entry, sinceAt) => !!sinceAt && instant(releasedKey(entry)) > instant(sinceAt);

// Filters and the open update live in the address bar, so a filtered view or
// one update can be shared as a link (Oct 16 2026).
function readQuery() {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}
function writeQuery(patch) {
  try {
    const q = readQuery();
    Object.entries(patch).forEach(([k, v]) => { if (v === undefined || v === null || v === '' || v === 'all' || v === false) q.delete(k); else q.set(k, String(v)); });
    const qs = q.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  } catch { /* the page still works without it */ }
}

// Updates already counted as seen in this tab: a view is recorded once per
// update per page load, not on every re-render or tab switch.
const viewedThisLoad = new Set();
function recordViews(ids) {
  const fresh = (ids || []).filter((id) => id && !viewedThisLoad.has(id));
  if (!fresh.length) return;
  fresh.forEach((id) => viewedThisLoad.add(id));
  api.recordTaskChangelogViews?.(fresh)?.catch?.(() => {});
}
// PR-sourced entries land as "Pending Review"; everything else defaults to "Released".
function statusOf(entry) {
  return entry?.status || (entry?.origin === 'pr' ? 'Pending Review' : 'Released');
}
function releasedKey(entry) {
  return entry?.releasedAt || entry?.createdAt || '';
}
// Latest on top. Entries published by one automatic run share a releasedAt,
// so they fall back to when each change merged (mergedAt), then the PR number
// for entries published before mergedAt existed.
function instant(iso) {
  const t = new Date(iso || '').getTime();
  return isNaN(t) ? 0 : t;
}
function newestFirst(a, b) {
  return (instant(releasedKey(b)) - instant(releasedKey(a)))
    || (instant(b.mergedAt) - instant(a.mergedAt))
    || ((b.prNumber || 0) - (a.prNumber || 0));
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
  // "Latest", not a fourth "What's New" under the breadcrumb and the page
  // title (Pranshu, Oct 16 2026).
  { key: 'whats-new', label: 'Latest', icon: Sparkles },
  { key: 'timeline', label: 'Timeline', icon: Clock },
];

// What's New is a normal Nexus view (Neil, Oct 12 2026): the sidebar and
// header stay, and you navigate away like from any module. It used to cover
// the whole app as an overlay with its own close button. It is mounted the way
// Tasks and Tickets are - App.jsx gives it the full-height `viewport-flush`
// and it fills that, so the Timeline's two panes scroll on their own. The
// root is `.nx-tasks` (the module's phone styles), NOT `.nx-tasks-portal`:
// lib/dialogGuard treats that class as a popup backdrop, and on a page every
// filter change or comment keystroke would then read as unsaved work.
export default function Changelog({ activeSub = null, onSubChange } = {}) {
  const role = useRole();
  const { myEmail, can } = role;
  // Reading is everyone's; adding, editing, reviewing and commenting follow
  // the server's grant (lib/whatsNewAccess.js), so nobody is offered a
  // control that would only answer 403.
  const canEdit = canEditWhatsNew(role);
  // Phones (Neil, Oct 12 2026): a compact header, tabs that fit without
  // icons, one column everywhere, details as a full-screen sheet.
  const isMobile = useIsMobile();
  const nameOf = useNameResolver();
  const isAdmin = canEdit && !!can?.('manager');

  const [entries, setEntries] = useState([]);
  const [tab, setTabState] = useState(() => (readQuery().get('tab') === 'timeline' ? 'timeline' : 'whats-new'));
  const setTab = (t) => { setTabState(t); writeQuery({ tab: t === 'timeline' ? 'timeline' : '' }); };
  // This reader: since when updates are new to them, and what they follow.
  const [me, setMe] = useState({ sinceAt: '', subscription: { modules: [], categories: [], digest: false } });
  useEffect(() => { api.getTaskChangelogMe?.()?.then?.((r) => r && setMe(r))?.catch?.(() => {}); }, []);
  const [following, setFollowing] = useState(false);
  // Feature requests and their status (Oct 18 2026).
  const [requesting, setRequesting] = useState(false);
  // One update open in full - from a shared link (?entry=), a related
  // update, the Most Reacted list, or a screen's "See What's Changed".
  // A bell notice opens /whats-new/<id> (the update is the view's sub).
  const [openId, setOpenId] = useState(() => readQuery().get('entry') || activeSub || null);
  useEffect(() => { if (activeSub) setOpenId(activeSub); }, [activeSub]);
  const openEntry = (id) => { setOpenId(id); writeQuery({ entry: id }); };
  const closeEntry = () => { setOpenId(null); writeQuery({ entry: '' }); if (activeSub) onSubChange?.(null); };
  // Manage is a button, not a tab (Pranshu, Oct 16 2026): it swaps the page
  // body for the admin screen, and Back returns to the tab you were on.
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // entry being edited
  const [toast, setToast] = useState(null);   // { text, error }

  // Loaded once: until then the Timeline shows a skeleton, not "no updates".
  const [loaded, setLoaded] = useState(false);
  const reload = () => api.getTaskChangelog().then((r) => setEntries(r || [])).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { reload(); }, []);

  // An error stays red and up longer: it usually needs reading (a server
  // reason such as an Anthropic billing refusal), unlike "Update published."
  const flash = (msg, error = false) => {
    setToast({ text: msg, error });
    window.setTimeout(() => setToast(null), error ? 8000 : 3200);
  };

  // Self-contained data layer (the free-form payload has no camel keys the Tasks
  // context would remap, so we call api.js directly and reconcile locally).
  // A saved or published entry comes back without the read-out reactions and
  // comment count, so the ones on screen are kept.
  const replaceEntry = (r) => setEntries((p) => p.map((x) => (x.id === r.id ? { ...x, ...r } : x)));
  const createEntry = async (payload) => { const r = await api.createTaskChangelog({ payload }); setEntries((p) => [r, ...p]); return r; };
  const updateEntry = async (id, payload) => { const r = await api.updateTaskChangelog(id, { payload }); replaceEntry(r); return r; };
  const deleteEntry = async (id) => { await api.deleteTaskChangelog(id); setEntries((p) => p.filter((x) => x.id !== id)); };
  // Publishing is the server's: it stamps the release time (so the update
  // leads the feed) and, for a merge, the day's version.
  const publishEntry = async (entry) => {
    const again = statusOf(entry) === 'Released';
    try {
      replaceEntry(await api.publishTaskChangelog(entry.id));
      flash(again ? 'Update re-published.' : 'Update published.');
    } catch (e) { flash(e?.message || 'Could not publish the update.', true); }
  };
  const publishAll = async () => {
    try {
      const r = await api.publishPendingTaskChangelog();
      (r?.entries || []).forEach(replaceEntry);
      flash(`Published ${r?.published || 0} update${r?.published === 1 ? '' : 's'}.`);
    } catch (e) { flash(e?.message || 'Could not publish the updates.', true); }
  };
  // Several at once from Manage (Oct 16 2026): publish, pin, hide, re-file, delete.
  const bulk = async (ids, action, value) => {
    try {
      const r = await api.bulkTaskChangelog({ ids, action, ...(value ? { value } : {}) });
      if (r?.deleted) setEntries((p) => p.filter((x) => !r.deleted.includes(x.id)));
      (r?.entries || []).forEach(replaceEntry);
      flash(action === 'pin' ? 'Pinned to the top.' : action === 'unpin' ? 'Unpinned.' : `Done - ${plural(r?.done || 0, 'update')}.`);
      return true;
    } catch (e) { flash(e?.message || 'Could not do that.', true); return false; }
  };
  const setStatus = (entry, next) => (next === 'Released'
    ? publishEntry(entry)
    : updateEntry(entry.id, { ...payloadOf(entry), status: next }).catch(() => {}));

  // Everyone who reads What's New can react - ONE reaction per person
  // (Pranshu, Oct 16 2026): another kind replaces yours, yours again takes it
  // back. Shown at once, then squared with the server's counts.
  // Quick clicks on one update go to the server one at a time, in order (the
  // server toggles, so out-of-order requests could land on the wrong
  // reaction), and only the last answer is drawn - an earlier one would undo
  // the clicks after it on screen.
  const reactQueue = useRef({});   // entry id -> { chain, seq }
  const react = (entry, kind) => {
    setEntries((p) => p.map((x) => {
      if (x.id !== entry.id) return x;
      const counts = { ...(x.reactions || {}) };
      const had = (x.myReactions || [])[0];
      if (had) counts[had] = Math.max(0, (counts[had] || 1) - 1);
      const mine = had === kind ? [] : [kind];
      if (mine.length) counts[kind] = (counts[kind] || 0) + 1;
      return { ...x, reactions: counts, myReactions: mine };
    }));
    const q = reactQueue.current[entry.id] || (reactQueue.current[entry.id] = { chain: Promise.resolve(), seq: 0 });
    const seq = ++q.seq;
    const apply = (r) => setEntries((p) => p.map((x) => (x.id === entry.id ? { ...x, reactions: r.reactions || {}, myReactions: r.myReactions || [] } : x)));
    q.chain = q.chain.then(() => api.reactTaskChangelog(entry.id, kind))
      .then((r) => { if (seq === q.seq) apply(r); })
      // A failed click: redraw what the server holds now.
      .catch(() => api.getTaskChangelog().then((rows) => {
        const now = (rows || []).find((x) => x.id === entry.id);
        if (now && seq === q.seq) apply(now);
      }).catch(() => {}));
  };

  // Admins publish immediately; anyone else goes into the review queue for an admin
  // to publish from Manage.
  const handleAdd = async (payload) => {
    const status = isAdmin ? (payload.status || 'Released') : 'Pending Review';
    await createEntry({ ...payload, status, origin: payload.origin || 'manual' }).catch(() => {});
    flash(!isAdmin ? 'Submitted for review - an admin will publish it once approved.'
      : status === 'Scheduled' ? `Scheduled for ${formatDateTime(payload.scheduledFor)}.`
        : status === 'Draft' ? 'Saved as a draft.' : 'Update published.');
  };
  // Edit, then optionally (re-)publish (Pranshu, Oct 16 2026).
  const handleEditSave = async (payload, { publish = false } = {}) => {
    const saved = await updateEntry(editing.id, payload).catch(() => null);
    if (saved && publish) await publishEntry(saved);
    else if (saved) flash('Changes saved.');
    setEditing(null);
  };

  // Publish one entry per change merged since the last check (the same run the
  // server does on its own after every merge). Surfaces a toast either way.
  const handleGenerate = async () => {
    try {
      const r = await api.generateTaskChangelog();
      await reload();
      if (r?.created) flash(`Published ${r.created} update${r.created === 1 ? '' : 's'} from merged work.`);
      else flash(r?.message || 'No new changes since the last update.');
    } catch (e) {
      // The server says why (GitHub unreachable, a missing token, ...) -
      // pass it on rather than a generic line nobody can act on.
      flash(e?.message || 'Could not check for updates.', true);
    }
  };

  const sorted = useMemo(
    () => (entries || []).slice().sort(newestFirst),
    [entries],
  );
  // Pending-review / draft entries stay out of the public-facing tabs.
  const published = useMemo(
    () => sorted.filter((e) => { const s = statusOf(e); return s !== 'Pending Review' && s !== 'Draft'; }),
    [sorted],
  );
  const pendingCount = useMemo(() => sorted.filter((e) => statusOf(e) === 'Pending Review').length, [sorted]);

  const setCommentCount = (id, n) => setEntries((p) => p.map((x) => (x.id === id ? { ...x, commentCount: n } : x)));
  // "For You": an update about a module this person has (by its Module name,
  // or the modules it is aimed at). Administrators have everything.
  const myModules = useMemo(() => {
    const ids = new Set(role.myGrantedModules?.keys ? [...role.myGrantedModules.keys()] : []);
    const names = new Set(MODULES.filter((m) => ids.has(m.id)).flatMap((m) => [m.label.toLowerCase(), m.id]));
    return { ids, names, all: !!can?.('administrator') };
  }, [role.myGrantedModules, can]);
  const forYou = (e) => {
    if (myModules.all) return true;
    const aud = e.audience?.modules || [];
    if (aud.length) return aud.some((m) => myModules.ids.has(m));
    const mod = (e.module || '').toLowerCase();
    return !mod || myModules.names.has(mod);
  };
  const actions = useMemo(() => ({
    isAdmin, onReact: react, onPublish: isAdmin ? publishEntry : undefined, onCommented: setCommentCount,
    sinceAt: me.sinceAt, all: sorted, forYou, openEntry, flash,
    // Pin / Unpin right on the card and in the details (Oct 16 2026).
    onPin: isAdmin ? (e) => bulk([e.id], e.pinned ? 'unpin' : 'pin') : undefined,
    // An issue reported / resolved comes back as the saved entry (Oct 18 2026).
    onEntryChanged: replaceEntry,
  }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, entries, me.sinceAt, myModules]);
  const openOne = openId ? entries.find((x) => x.id === openId) : null;

  return (
    <ChangelogActions.Provider value={actions}>
    <div className="nx-tasks" data-whats-new-view style={{ fontFamily: FONT, color: NX.ink, background: NX.canvas, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 12, padding: isMobile ? '10px 12px' : '14px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <Sparkles size={isMobile ? 18 : 20} style={{ color: NX.blue, flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700 }}>What&apos;s New</div>
          {!isMobile && <div style={{ fontSize: 13, color: NX.dim }}>Track all updates, releases and changes across Nexus.</div>}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {!managing && !isMobile && (
            <button type="button" onClick={() => setRequesting(true)} style={btn('outline')}><Lightbulb size={15} />Feature Request</button>
          )}
          {!managing && !isMobile && (
            <FollowButton onClick={() => setFollowing(true)}
              following={(me.subscription?.modules?.length || 0) + (me.subscription?.categories?.length || 0) > 0 || me.subscription?.digest} />
          )}
          {isAdmin && !managing && (
            <button style={{ ...btn('outline'), ...(isMobile ? { minHeight: 36 } : null) }} onClick={() => setManaging(true)} aria-label="Manage">
              <ClipboardCheck size={15} />Manage
              {pendingCount > 0 && <Badge label={String(pendingCount)} color="#d97706" tint="#fdefd7" />}
            </button>
          )}
          {canEdit && (
            <button style={{ ...btn('primary'), ...(isMobile ? { minHeight: 36 } : null) }} onClick={() => setAdding(true)}
              aria-label="Add New Update"><Plus size={15} />{isMobile ? 'Add' : 'Add New Update'}</button>
          )}
        </div>
      </div>

      {/* Tab strip - or, in Manage, the way back */}
      {managing ? (
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${NX.border}`, background: NX.surface, padding: isMobile ? '6px 8px' : '6px 12px' }}>
          <button onClick={() => setManaging(false)} style={{ ...btn('ghost'), color: NX.dim, ...(isMobile ? { minHeight: 40 } : null) }}>
            <ArrowLeft size={15} />Back to What&apos;s New
          </button>
        </div>
      ) : (
        // Phones (Oct 28 2026): Feature Request and Follow sit at the end of
        // the tab strip as icons - their own row above the content pushed
        // every update a row further down the screen.
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <div className="scroll-tabs" role="tablist" style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 0 : 2, overflowX: 'auto', whiteSpace: 'nowrap', flex: 1, minWidth: 0, padding: isMobile ? '0 4px' : '0 16px' }}>
          {TABS.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              // border: none first - without it every tab wore the browser's
              // default button border, a heavy box around each label.
              <button key={t.key} role="tab" aria-selected={active} onClick={() => setTab(t.key)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer',
                border: 'none', borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`, background: 'transparent',
                padding: isMobile ? '12px 10px' : '12px 12px', fontSize: 14, fontWeight: 600, fontFamily: FONT,
                color: active ? NX.ink : NX.dim,
              }}>
                {!isMobile && <Icon size={16} />}{isMobile && t.short ? t.short : t.label}
              </button>
            );
          })}
        </div>
        {isMobile && (() => {
          const followingOn = (me.subscription?.modules?.length || 0) + (me.subscription?.categories?.length || 0) > 0 || !!me.subscription?.digest;
          const iconBtn = { ...btn('ghost'), width: 44, height: 44, padding: 0, justifyContent: 'center', flexShrink: 0 };
          return (
            <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4, flexShrink: 0 }}>
              <button type="button" onClick={() => setRequesting(true)} aria-label="Feature Request" title="Feature Request" style={{ ...iconBtn, color: NX.dim }}>
                <Lightbulb size={19} />
              </button>
              <button type="button" onClick={() => setFollowing(true)} aria-label="Follow" aria-pressed={followingOn} title={followingOn ? 'Following' : 'Follow'}
                style={{ ...iconBtn, color: followingOn ? NX.blue : NX.dim }}>
                {followingOn ? <BellRing size={19} /> : <Bell size={19} />}
              </button>
            </div>
          );
        })()}
        </div>
      )}

      {/* Body */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : undefined, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          {!managing && tab === 'whats-new' && <WhatsNewTab entries={published} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin} onSetStatus={setStatus} onEdit={setEditing} />}
          {!managing && tab === 'timeline' && <TimelineTab entries={published} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin} onSetStatus={setStatus} onEdit={setEditing} loading={!loaded} />}
          {managing && (
            <ManageTab entries={sorted} nameOf={nameOf} myEmail={myEmail} onSetStatus={setStatus} onEdit={setEditing} flash={flash}
              onAdd={() => setAdding(true)} onGenerate={handleGenerate} onPublish={publishEntry} onPublishAll={publishAll} onBulk={bulk}
              onDelete={async (id) => { if (window.confirm('Delete this entry? This cannot be undone.')) await deleteEntry(id).catch(() => {}); }} />
          )}
        </div>
      </div>

      {(adding || editing) && (
        <AddUpdateModal
          entry={editing}
          submitLabel={editing ? 'Save Changes' : (isAdmin ? 'Publish Update' : 'Submit for Review')}
          // Edit and re-publish (Pranshu, Oct 16 2026): an admin can send an
          // edited update out again as new, or publish a draft as they save it.
          publishLabel={editing && isAdmin ? (statusOf(editing) === 'Released' ? 'Save & Re-publish' : 'Save & Publish') : undefined}
          myEmail={myEmail}
          isAdmin={isAdmin}
          allEntries={sorted}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSave={editing ? handleEditSave : handleAdd}
        />
      )}

      {openOne && (
        <SlideOver entry={openOne} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
          onClose={closeEntry} onSetStatus={setStatus}
          onEdit={isAdmin ? () => { setEditing(openOne); closeEntry(); } : undefined} />
      )}

      {requesting && <MyRequestsDialog onClose={() => setRequesting(false)} onOpenEntry={openEntry} nameOf={nameOf} />}

      {following && (
        <FollowDialog entries={sorted} categories={CHANGE_TYPES} initial={me.subscription}
          onClose={() => setFollowing(false)}
          onSaved={(sub) => { setMe((m) => ({ ...m, subscription: sub })); flash('Saved - matching updates will come to your bell.'); }} />
      )}

      {toast && (
        <div role={toast.error ? 'alert' : 'status'} style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4100,
          background: toast.error ? NX.red : NX.primary, color: '#fff', padding: '10px 16px', borderRadius: 10, fontSize: 13, fontWeight: 500,
          boxShadow: '0 12px 32px rgba(0,0,0,0.28)', maxWidth: '90vw' }}>{toast.text}</div>
      )}
    </div>
    </ChangelogActions.Provider>
  );
}

// Reactions under an update. One per person; pressing yours again takes it
// back. Animated (Pranshu, Oct 16 2026): the emoji lifts on hover, and the
// picked pill pops while its emoji floats up (style.css .nx-react*).
function ReactionBar({ entry, compact = false }) {
  const { onReact } = useContext(ChangelogActions);
  const counts = entry.reactions || {};
  const mine = new Set(entry.myReactions || []);
  const isMobile = useIsMobile();
  const [burst, setBurst] = useState(null);   // { key, n } - n restarts the animation
  const burstTimer = useRef(null);
  useEffect(() => () => window.clearTimeout(burstTimer.current), []);
  return (
    <div role="group" aria-label="Reactions" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {REACTIONS.map((r) => {
        const n = counts[r.key] || 0;
        const on = mine.has(r.key);
        if (compact && !n && !on) return null;
        return (
          <button key={r.key} type="button" aria-pressed={on} aria-label={`${r.label}${n ? ` (${n})` : ''}`} title={r.label}
            className={`nx-react${burst?.key === r.key ? ' is-popping' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              // Only picking one celebrates; taking yours back is quiet.
              setBurst(on ? null : { key: r.key, n: Date.now() });
              // animationend never comes in a background tab - don't leave it hanging.
              window.clearTimeout(burstTimer.current);
              burstTimer.current = window.setTimeout(() => setBurst(null), 900);
              onReact(entry, r.key);
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontFamily: FONT,
              borderRadius: 999, padding: isMobile ? '6px 10px' : '3px 9px', minHeight: isMobile ? 34 : undefined,
              fontSize: 12, fontWeight: 600, lineHeight: 1.2,
              border: `1px solid ${on ? NX.blue : NX.border}`,
              background: on ? 'rgba(37,99,235,0.12)' : 'transparent', color: on ? NX.blue : NX.dim,
            }}>
            <span aria-hidden className="nx-react-emoji" style={{ fontSize: 13 }}>{r.emoji}</span>{n > 0 && <span>{n}</span>}
            {burst?.key === r.key && <span key={burst.n} aria-hidden className="nx-react-float" onAnimationEnd={(e) => e.stopPropagation()}>{r.emoji}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// What's New tab - latest single published entry + activity summary
// ═══════════════════════════════════════════════════════════════════════════
// The day an entry went out, in the viewer's time zone. Server-published
// entries carry a UTC timestamp, so the date part of the string alone would
// put an evening release on the next day.

// What's New shows the whole latest release day, newest first. It showed one
// entry, which was fine while updates were typed by hand - with every merged
// PR published automatically, the next merge would push a hand-written
// announcement off the tab within hours (Oct 2026).
function WhatsNewTab({ entries: allPublished, nameOf, myEmail, isAdmin, onSetStatus, onEdit }) {
  const { sinceAt, forYou, openEntry } = useContext(ChangelogActions);
  // For You (the modules you use) and New Since Your Last Visit (Oct 16 2026).
  const [mineOnly, setMineOnly] = useState(() => readQuery().get('for') === 'me');
  const [newOnly, setNewOnly] = useState(false);
  const newCount = useMemo(() => allPublished.filter((e) => isNew(e, sinceAt)).length, [allPublished, sinceAt]);
  const entries = useMemo(() => allPublished.filter((e) => (!mineOnly || forYou(e)) && (!newOnly || isNew(e, sinceAt))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allPublished, mineOnly, newOnly, sinceAt]);
  // Pinned updates sit on top, whatever their day; they are not repeated below.
  const pinned = useMemo(() => entries.filter((e) => e.pinned)
    .sort((a, b) => instant(b.pinnedAt) - instant(a.pinnedAt)), [entries]);
  const latestDay = useMemo(() => {
    const rest = entries.filter((e) => !e.pinned);
    if (!rest.length) return [];
    // "New only" shows every new update, not just the latest day's.
    if (newOnly) return rest;
    const day = localDayKey(releasedKey(rest[0]));
    return rest.filter((e) => localDayKey(releasedKey(e)) === day);
  }, [entries, newOnly]);
  const latest = latestDay[0];
  const [details, setDetails] = useState(null);
  // The latest day's cards are read right here - they count as seen.
  useEffect(() => { recordViews([...pinned, ...latestDay].map((e) => e.id)); }, [latestDay, pinned]);
  const isMobile = useIsMobile();
  // One edge for everything (Neil, Oct 12 2026): the title, the day label and
  // the cards start on the same 16px line as the header and the tab strip
  // above; the update count ends on the Activity Summary's right edge; the
  // summary's top is the first card's top. The day label used to live INSIDE
  // the cards' column, which pushed the first card one label lower than the
  // summary beside it, and the cards were centered at 1400px while the title
  // stayed at the far left. The content fills the page, like other modules.
  // "3 Updates" (Neil, Oct 12 2026): a count you can read at a glance, Title Case.
  const count = `${latestDay.length} Update${latestDay.length === 1 ? '' : 's'}`;
  // The page header already says What's New, so the tab has no title of its
  // own (it repeated it a fourth time, Pranshu Oct 16 2026): the day and the
  // count share one line above the cards.
  const toggle = (on) => ({
    ...btn('outline'), padding: isMobile ? '7px 12px' : '4px 11px', fontSize: 12.5, borderRadius: 999,
    ...(on ? { borderColor: NX.blue, color: NX.blue, background: 'rgba(37,99,235,0.10)' } : null),
  });
  const sectionLabel = {
    height: 20, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint,
  };
  const countStyle = { textTransform: 'none', letterSpacing: 0, fontSize: isMobile ? 14 : 15, fontWeight: 700, color: NX.ink };
  const renderCard = (e) => <EntryCard key={e.id} entry={e} nameOf={nameOf} onViewDetails={() => setDetails(e)}
    onEdit={isAdmin ? () => onEdit(e) : undefined} />;
  return (
    <div style={{ padding: isMobile ? '14px 12px' : '16px 16px 20px' }}>
      {/* Open known issues and coming removals, whatever their day (Oct 18 2026). */}
      <AttentionStrip entries={allPublished} onOpen={openEntry} />
      <div role="group" aria-label="Show" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <button type="button" aria-pressed={mineOnly} onClick={() => { setMineOnly((v) => !v); writeQuery({ for: mineOnly ? '' : 'me' }); }} style={toggle(mineOnly)}>
          <User size={13} />For You
        </button>
        {(newCount > 0 || newOnly) && (
          <button type="button" aria-pressed={newOnly} onClick={() => setNewOnly((v) => !v)} style={toggle(newOnly)}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: NX.blue }} />{plural(newCount, 'New Update')} Since Your Last Visit
          </button>
        )}
      </div>

      {/* Two columns (Oct 16 2026): the updates - pinned first, then the
          latest day - on the left, the Activity Summary beside them from the
          top. Pinned updates used to sit above both columns, which pushed the
          summary down to the first of the day's cards. Each column starts
          with a 20px line (a section label / the day's count), so the first
          card and the summary still start on the same line, and the count
          still ends on the summary's right edge. */}
      {(latest || pinned.length > 0) ? (
        <div data-whats-new-row style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? 12 : 20, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0, flex: '1 1 520px', display: 'flex', flexDirection: 'column' }}>
            {pinned.length > 0 && (
              <div data-whats-new-pinned style={{ marginBottom: 18 }}>
                <div data-col-label style={sectionLabel}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Pin size={12} />Pinned</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{pinned.map(renderCard)}</div>
              </div>
            )}
            {latest && (<>
              <div data-col-label style={sectionLabel}>
                <span>{newOnly ? 'New Since Your Last Visit' : relativeDayLabel(releasedKey(latest))}</span>
                {/* Phones: one column, so the count rides on the day's line. */}
                {isMobile && <span style={countStyle}>{count}</span>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{latestDay.map(renderCard)}</div>
            </>)}
          </div>
          <div style={{ width: '100%', maxWidth: isMobile ? 'none' : 320, flex: '1 1 280px', ...(isMobile ? null : { position: 'sticky', top: 0 }) }}>
            {!isMobile && <div data-col-label style={{ ...sectionLabel, justifyContent: 'flex-end' }}>{latest && <span style={countStyle}>{count}</span>}</div>}
            <StatsPanel entries={entries} />
          </div>
        </div>
      ) : (
        <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '64px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
          {mineOnly || newOnly ? 'Nothing here with these filters.' : 'No updates published yet.'}
        </div>
      )}

      {details && (
        <SlideOver entry={entries.find((x) => x.id === details.id) || details} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
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
function EntryCard({ entry, nameOf, onViewDetails, onEdit }) {
  const { sinceAt, flash, onPin, all, openEntry } = useContext(ChangelogActions);
  const pinButton = (style) => onPin && (
    <button type="button" onClick={() => onPin(entry)} aria-pressed={!!entry.pinned}
      aria-label={`${entry.pinned ? 'Unpin' : 'Pin'} ${entry.title || 'update'}`} style={style}>
      <Pin size={13} />{entry.pinned ? 'Unpin' : 'Pin'}
    </button>
  );
  const fresh = isNew(entry, sinceAt);
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const [preview, setPreview] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const canComment = canEditWhatsNew(useRole());
  const { onCommented } = useContext(ChangelogActions);
  const thumbnail = (entry.images && entry.images[0]) || entry.afterImageDataUrl;
  const whatsChanged = entry.whatsChanged || [];
  const isMobile = useIsMobile();
  return (
    <div style={{ ...card, overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: isMobile ? 14 : 20, padding: isMobile ? 16 : 20 }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={chip(meta.color, meta.tint)}><Icon size={12} />{meta.label}</span>
            {entry.module && <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{entry.module}</span>}
            {entry.breaking && <span style={chip('#b91c1c', 'rgba(220,38,38,0.12)')}><AlertTriangle size={12} />Breaking Change</span>}
            <IssueChip entry={entry} />
            <DeprecationChip entry={entry} />
            {entry.pinned && <span title="Pinned" style={{ display: 'inline-flex', color: NX.faint }}><Pin size={13} /></span>}
            {fresh && <span style={chip(NX.blue, 'rgba(37,99,235,0.12)')}>New</span>}
          </div>
          <h3 style={{ margin: 0, fontSize: isMobile ? 17 : 18, lineHeight: 1.3, fontWeight: 700, color: NX.ink }}>{entry.title || 'Untitled'}</h3>
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: NX.dim }}>
            {entry.version && <span style={{ fontFamily: 'monospace' }}>{entry.version}</span>}
            <StageChip entry={entry} />
          </div>
          <IssueBanner entry={entry} all={all} onOpen={openEntry} />
          {entry.description && <RichText text={entry.description} style={{ marginTop: 12, fontSize: 13 }} />}
          <ActionRequired entry={entry} />
          <DeprecationNotice entry={entry} />
          {entry.videoUrl && <div style={{ marginTop: 12 }}><VideoEmbed url={entry.videoUrl} /></div>}

          {entry.businessImpact && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 8, background: 'rgba(37,99,235,0.15)', color: NX.blue, padding: '10px 12px', fontSize: 13 }}>
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
            {entry.developers?.length ? (
              <>
                {entry.developers.map((d) => <Avatar key={d.login} email={d.email} name={d.name || d.login} size={20} />)}
                <span>{entry.developers.map((d) => d.name || d.login).join(', ')}</span>
              </>
            ) : (
              <>
                {entry.authorId && <Avatar email={entry.authorId} name={nameOf(entry.authorId)} size={20} />}
                <span>{entry.authorId ? nameOf(entry.authorId) : 'Unknown'}</span>
              </>
            )}
            {entry.ticketRef && (<><span>·</span><span>{entry.ticketRef}</span></>)}
            {entry.prRef && (<><span>·</span><span>{entry.prRef}</span></>)}
            {!isMobile && (onEdit || onViewDetails) && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                <CopyLinkButton entryId={entry.id} onCopied={(ok) => flash(ok ? 'Link copied.' : 'Could not copy the link.', !ok)} />
                {pinButton({ ...btn('ghost'), color: entry.pinned ? NX.blue : NX.dim, padding: 0 })}
                {onEdit && (
                  <button onClick={onEdit} aria-label={`Edit ${entry.title || 'update'}`} style={{ ...btn('ghost'), color: NX.dim, padding: 0 }}>
                    <Pencil size={13} />Edit
                  </button>
                )}
                {entry.tour?.length > 0 && <TakeTourButton entry={entry} style={{ ...btn('ghost'), color: NX.blue, padding: 0, border: 'none' }} />}
                {onViewDetails && (
                  <button onClick={onViewDetails} style={{ ...btn('ghost'), color: NX.blue, padding: 0 }}>
                    View Full Details <ArrowRight size={13} />
                  </button>
                )}
              </span>
            )}
          </div>
          {/* Reactions, and the comments - read and posted right on the card
              (Pranshu, Oct 16 2026). */}
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <ReactionBar entry={entry} />
            {/* The count is always shown, 0 included (Pranshu, Oct 16 2026). */}
            {(() => {
              const n = entry.commentCount || 0;
              const label = `${n} comment${n === 1 ? '' : 's'}`;
              return (
                <button onClick={() => setShowComments((v) => !v)} aria-expanded={showComments}
                  aria-label={showComments ? `Hide comments (${n})` : label} title={showComments ? 'Hide comments' : 'Show comments'}
                  style={{ ...btn('ghost'), padding: 0, fontSize: 12, color: showComments ? NX.blue : NX.dim }}>
                  <MessageSquare size={13} />{label}{showComments ? <ChevronDown size={12} style={{ transform: 'rotate(180deg)' }} /> : <ChevronDown size={12} />}
                </button>
              );
            })()}
          </div>
          {(canComment || showComments) && (
            <CommentThread entryId={entry.id} canComment={canComment} nameOf={nameOf} compact
              open={showComments} onPosted={() => setShowComments(true)} onCount={(n) => onCommented(entry.id, n)} />
          )}
          {/* Phones: a full-width button, a real tap target, under the names. */}
          {onViewDetails && isMobile && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {pinButton({ ...btn('outline'), justifyContent: 'center', minHeight: 40, color: entry.pinned ? NX.blue : NX.dim })}
              {onEdit && (
                <button onClick={onEdit} aria-label={`Edit ${entry.title || 'update'}`} style={{ ...btn('outline'), justifyContent: 'center', minHeight: 40, color: NX.dim }}>
                  <Pencil size={14} />Edit
                </button>
              )}
              <button onClick={onViewDetails} style={{ ...btn('outline'), flex: 1, width: '100%', justifyContent: 'center', minHeight: 40, color: NX.blue }}>
                View Full Details <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>

        {/* No screenshot, no box (Neil, Oct 19): an empty grey frame reads as a missing image. */}
        {thumbnail && <button onClick={() => setPreview(true)} aria-label="View screenshot" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: isMobile ? '100%' : 224, maxWidth: '100%',
          aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 10, border: `1px solid ${NX.border}`,
          background: NX.surface2, cursor: 'zoom-in', padding: 0,
        }}>
          <img src={thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
        </button>}
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
// Timeline tab - searchable/filterable, grouped by day, master + detail
// ═══════════════════════════════════════════════════════════════════════════
const ALL = 'all';
// How an environment reads in a filter.
const envLabel = (e2) => (e2 === 'Production' ? 'In Production' : e2 === 'Staging' ? 'Dev Only / Staging' : e2);
// A filter whose value starts from, and is written back to, the address bar.
function useLinkedState(key, fallback = ALL) {
  const [v, set] = useState(() => readQuery().get(key) ?? fallback);
  return [v, (next) => { set(next); writeQuery({ [key]: next }); }];
}

function TimelineTab({ entries, nameOf, myEmail, isAdmin, onSetStatus, onEdit, loading = false }) {
  const { forYou, flash } = useContext(ChangelogActions);
  // Every filter starts from the address bar and writes back to it, so a
  // filtered Timeline is a link you can share (Oct 16 2026).
  const q0 = useMemo(() => readQuery(), []);
  const [query, setQuery] = useLinkedState('q', '');
  const [moduleFilter, setModuleFilter] = useLinkedState('module');
  const [typeFilter, setTypeFilter] = useLinkedState('category');
  const [envFilter, setEnvFilter] = useLinkedState('env');
  // Version History lives here now (Pranshu, Oct 16 2026): each day names its
  // versions and counts its categories, and this filter picks one version.
  const [versionFilter, setVersionFilter] = useLinkedState('version');
  // A date range, and comparing two versions: everything released after the
  // first one, up to and including the second.
  const [fromDate, setFromDate] = useLinkedState('from', '');
  const [toDate, setToDate] = useLinkedState('to', '');
  const [compareFrom, setCompareFrom] = useLinkedState('cmpFrom', '');
  const [compareTo, setCompareTo] = useLinkedState('cmpTo', '');
  const [comparing, setComparing] = useState(!!(q0.get('cmpFrom') || q0.get('cmpTo')));
  const [breakingOnly, setBreakingOnly] = useLinkedState('breaking', '');
  const [mineOnly, setMineOnly] = useLinkedState('for', '');
  const [selectedId, setSelectedId] = useState(entries[0]?.id || null);
  const [expanded, setExpanded] = useState(false);

  const modules = useMemo(() => Array.from(new Set(entries.map((e) => e.module).filter(Boolean))).sort(), [entries]);
  // Newest release first, as Version History listed them.
  const versions = useMemo(() => Array.from(new Set(entries.map((e) => e.version).filter(Boolean))), [entries]);
  // When each version went out: its latest update's release time.
  const versionAt = useMemo(() => {
    const m = new Map();
    for (const e of entries) if (e.version) m.set(e.version, Math.max(m.get(e.version) || 0, instant(releasedKey(e))));
    return m;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (moduleFilter !== ALL && e.module !== moduleFilter) return false;
      if (typeFilter !== ALL && e.type !== typeFilter) return false;
      if (envFilter !== ALL && stageOf(e)?.key !== envFilter) return false;
      if (versionFilter !== ALL && e.version !== versionFilter) return false;
      if (q && !`${e.title} ${e.description} ${e.ticketRef || ''} ${e.version || ''}`.toLowerCase().includes(q)) return false;
      const day = localDayKey(releasedKey(e));
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      if (comparing && (compareFrom || compareTo)) {
        const at = instant(releasedKey(e));
        if (compareFrom && at <= (versionAt.get(compareFrom) || 0)) return false;
        if (compareTo && at > (versionAt.get(compareTo) || Infinity)) return false;
      }
      if (breakingOnly && !(e.breaking || e.actionRequired)) return false;
      if (mineOnly && !forYou(e)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query, moduleFilter, typeFilter, envFilter, versionFilter, fromDate, toDate, comparing, compareFrom, compareTo, breakingOnly, mineOnly, versionAt]);
  const anyFilter = query || moduleFilter !== ALL || typeFilter !== ALL || envFilter !== ALL || versionFilter !== ALL
    || fromDate || toDate || (comparing && (compareFrom || compareTo)) || breakingOnly || mineOnly;
  const clearAll = () => {
    [setQuery, setFromDate, setToDate, setCompareFrom, setCompareTo, setBreakingOnly, setMineOnly].forEach((fn) => fn(''));
    [setModuleFilter, setTypeFilter, setEnvFilter, setVersionFilter].forEach((fn) => fn(ALL));
    setComparing(false);
  };

  useEffect(() => {
    if (!filtered.some((e) => e.id === selectedId)) setSelectedId(filtered[0]?.id || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  const groups = useMemo(() => {
    const byDay = new Map();
    for (const e of filtered) {
      const k = localDayKey(releasedKey(e));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    return [...byDay.entries()];
  }, [filtered]);

  const selected = filtered.find((e) => e.id === selectedId) || null;
  const isMobile = useIsMobile();
  // Phones: one list that scrolls with the page, and a tapped row opens as a
  // full-screen sheet - the side-by-side panes left each row a sliver.
  const [sheet, setSheet] = useState(null);
  // Below 1100px the list column is too narrow for the desktop row (time
  // column + thumbnail left an iPad's titles one letter wide), so it uses the
  // two-line row too - the detail pane stays beside it on a tablet.
  const compactRows = useIsMobile('(max-width: 1100px)');
  const selStyle = { ...inputStyle, width: 'auto', minWidth: isMobile ? 0 : 150, cursor: 'pointer', flexShrink: 0 };
  const narrow = useIsMobile('(max-width: 1023px)');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Phones and tablets (Neil, Oct 28 2026: "the mobile UI and UX on that
  // sucks"). Below 1024px the Timeline is ONE column: a search box and a
  // Filter button stay pinned at the top, the chosen filters sit under them
  // as chips you can take off one at a time, the days scroll underneath with
  // their date pinned while you are in them, and a tapped update opens as a
  // screen of its own. The two side-by-side panes left a tablet each half
  // too narrow, and the eleven inline filter controls pushed the first update
  // most of a phone screen down.
  if (narrow) {
    const chips = [
      mineOnly && { key: 'for', label: 'For You', clear: () => setMineOnly('') },
      breakingOnly && { key: 'breaking', label: 'Breaking / Action Required', clear: () => setBreakingOnly('') },
      moduleFilter !== ALL && { key: 'module', label: moduleFilter, clear: () => setModuleFilter(ALL) },
      typeFilter !== ALL && { key: 'category', label: typeMeta(typeFilter).label, clear: () => setTypeFilter(ALL) },
      envFilter !== ALL && { key: 'env', label: envLabel(envFilter), clear: () => setEnvFilter(ALL) },
      versionFilter !== ALL && { key: 'version', label: `Version ${versionFilter}`, clear: () => setVersionFilter(ALL) },
      fromDate && { key: 'from', label: `From ${formatFullDate(fromDate)}`, clear: () => setFromDate('') },
      toDate && { key: 'to', label: `To ${formatFullDate(toDate)}`, clear: () => setToDate('') },
      comparing && (compareFrom || compareTo) && {
        key: 'compare',
        label: `${compareFrom ? `After ${compareFrom}` : 'From the Start'} to ${compareTo || 'Now'}`,
        clear: () => { setCompareFrom(''); setCompareTo(''); setComparing(false); },
      },
    ].filter(Boolean);
    const filterState = {
      modules, versions, moduleFilter, setModuleFilter, typeFilter, setTypeFilter, envFilter, setEnvFilter,
      versionFilter, setVersionFilter, fromDate, setFromDate, toDate, setToDate, comparing, setComparing,
      compareFrom, setCompareFrom, compareTo, setCompareTo, breakingOnly, setBreakingOnly, mineOnly, setMineOnly,
    };
    return (
      <div data-timeline-narrow style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {/* Search and Filter: pinned above the list, never scrolled away. */}
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', background: NX.surface, borderBottom: `1px solid ${NX.border}` }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
              <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: NX.faint, pointerEvents: 'none' }} />
              {/* 16px text: iOS zooms the whole page into a smaller field. */}
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search updates"
                aria-label="Search updates" enterKeyHint="search"
                style={{ ...inputStyle, height: 44, paddingLeft: 36, paddingRight: query ? 40 : 12, fontSize: 16, borderRadius: 10 }} />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search"
                  style={{ position: 'absolute', right: 2, top: 2, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: NX.faint, cursor: 'pointer' }}>
                  <X size={16} />
                </button>
              )}
            </div>
            <button type="button" onClick={() => setFiltersOpen(true)} aria-label={chips.length ? `Filter (${chips.length} on)` : 'Filter'}
              aria-haspopup="dialog" data-timeline-filter
              style={{ ...btn('outline'), minHeight: 44, padding: '0 14px', borderRadius: 10, fontSize: 14, flexShrink: 0,
                ...(chips.length ? { borderColor: NX.blue, color: NX.blue } : null) }}>
              <SlidersHorizontal size={16} />Filter
              {chips.length > 0 && (
                <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, background: NX.blue, color: '#fff', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{chips.length}</span>
              )}
            </button>
          </div>
          {chips.length > 0 && (
            <div className="scroll-tabs" aria-label="Filters on" style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -12px', padding: '0 12px' }}>
              {chips.map((c) => (
                <button key={c.key} type="button" onClick={c.clear} aria-label={`Remove filter: ${c.label}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, minHeight: 34, padding: '0 8px 0 12px', borderRadius: 999,
                    border: `1px solid ${NX.border}`, background: NX.surface2, color: NX.ink, fontSize: 13, fontWeight: 600, fontFamily: FONT, cursor: 'pointer' }}>
                  {c.label}<X size={14} style={{ color: NX.dim }} />
                </button>
              ))}
              <button type="button" onClick={clearAll}
                style={{ flexShrink: 0, minHeight: 34, padding: '0 10px', border: 'none', background: 'transparent', color: NX.blue, fontSize: 13, fontWeight: 600, fontFamily: FONT, cursor: 'pointer' }}>
                Clear All
              </button>
            </div>
          )}
        </div>

        {/* The days. Room at the foot so the last update clears the Time
            Clock capsule and the browser's bottom bar. */}
        <div className="nx-scroll" data-timeline-list style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 12px calc(96px + env(safe-area-inset-bottom))' }}>
          {loading ? (
            <div style={{ paddingTop: 14 }} aria-busy="true" aria-label="Loading updates">
              {[0, 1].map((i) => (
                <div key={i} style={{ marginBottom: 18 }}>
                  <div style={{ width: 120, height: 14, borderRadius: 6, marginBottom: 10, background: NX.border2 }} />
                  <div style={{ ...card, overflow: 'hidden' }}>
                    {[0, 1, 2].map((j) => (
                      <div key={j} style={{ padding: 14, borderBottom: `1px solid ${NX.border}` }}>
                        <div style={{ height: 14, width: '80%', borderRadius: 6, background: NX.border2 }} />
                        <div style={{ height: 11, width: '45%', borderRadius: 6, marginTop: 8, background: NX.border2 }} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (<>
            {anyFilter && filtered.length > 0 && (
              <div style={{ padding: '12px 2px 0', fontSize: 12.5, fontWeight: 600, color: NX.dim }}>{plural(filtered.length, 'update')} match</div>
            )}
            {groups.map(([k, group]) => (
              <section key={k} aria-label={formatFullDate(releasedKey(group[0]))}>
                <StickyDayHeader group={group} />
                <div style={{ ...card, overflow: 'hidden' }}>
                  {group.map((entry) => (
                    <TimelineRow key={entry.id} entry={entry} compact onClick={() => setSheet(entry)} />
                  ))}
                </div>
              </section>
            ))}
            {filtered.length === 0 && (
              <div style={{ margin: '24px 0', borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '40px 16px', textAlign: 'center', fontSize: 14, color: NX.dim }}>
                {anyFilter ? (<>
                  <div style={{ fontWeight: 700, color: NX.ink, marginBottom: 4 }}>No Matching Updates</div>
                  <div>Nothing matches these filters.</div>
                  <button type="button" onClick={clearAll} style={{ ...btn('outline'), minHeight: 44, marginTop: 14 }}>Clear All Filters</button>
                </>) : (<>
                  <div style={{ fontWeight: 700, color: NX.ink, marginBottom: 4 }}>No Updates Yet</div>
                  <div>Published updates will show up here.</div>
                </>)}
              </div>
            )}
          </>)}
        </div>

        {filtersOpen && (
          <TimelineFilterSheet f={filterState} count={filtered.length} anyFilter={!!anyFilter}
            onClearAll={clearAll} onClose={() => setFiltersOpen(false)} flash={flash} />
        )}
        {sheet && (
          <SlideOver entry={entries.find((x) => x.id === sheet.id) || sheet} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
            onClose={() => setSheet(null)} onSetStatus={onSetStatus}
            onEdit={isAdmin ? () => { onEdit(sheet); setSheet(null); } : undefined} />
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: isMobile ? '14px 12px' : '20px 16px', height: isMobile ? 'auto' : '100%' }}>
      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: isMobile ? 12 : 16 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: isMobile ? '100%' : 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint, pointerEvents: 'none' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search updates, tags, work items…" style={{ ...inputStyle, paddingLeft: 30 }} />
        </div>
        {/* Phones: the three filters share one row that swipes sideways. */}
        <div className={isMobile ? 'scroll-tabs' : undefined} style={isMobile ? { display: 'flex', gap: 8, overflowX: 'auto', width: '100%' } : { display: 'contents' }}>
          <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} style={selStyle} aria-label="Module">
            <option value={ALL}>All Modules</option>
            {modules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selStyle} aria-label="Category">
            <option value={ALL}>All Categories</option>
            {CHANGE_TYPES.map((t) => <option key={t} value={t}>{CHANGE_TYPE_META[t].label}</option>)}
          </select>
          <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)} style={selStyle} aria-label="Environment">
            <option value={ALL}>All Environments</option>
            {/* Live in Production (Oct 18 2026): a merge on the dev site counts as Staging until it reaches main. */}
            {ENVIRONMENTS.map((e2) => <option key={e2} value={e2}>{envLabel(e2)}</option>)}
          </select>
          <select value={versionFilter} onChange={(e) => setVersionFilter(e.target.value)} style={selStyle} aria-label="Version">
            <option value={ALL}>All Versions</option>
            {versions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
      {/* Date range, version comparison, quick toggles, and the link to this view */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: isMobile ? -4 : -8, marginBottom: isMobile ? 12 : 14, fontSize: 12.5, color: NX.dim }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>From
          {/* The app's own calendar, MM/DD/YYYY whatever the computer's locale (a native date box said dd-mm-yyyy). */}
          <DateField value={fromDate || null} onChange={(v) => setFromDate(v || '')} placeholder="MM/DD/YYYY" title="From date" style={{ ...inputStyle, width: 'auto', minWidth: 132, padding: '6px 10px', display: 'inline-flex' }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>To
          <DateField value={toDate || null} onChange={(v) => setToDate(v || '')} placeholder="MM/DD/YYYY" title="To date" style={{ ...inputStyle, width: 'auto', minWidth: 132, padding: '6px 10px', display: 'inline-flex' }} />
        </label>
        <button type="button" aria-pressed={comparing} onClick={() => { if (comparing) { setCompareFrom(''); setCompareTo(''); } setComparing(!comparing); }}
          style={{ ...btn('outline'), padding: '5px 10px', ...(comparing ? { borderColor: NX.blue, color: NX.blue } : null) }}>
          <GitBranch size={13} />Compare Versions
        </button>
        {comparing && (<>
          <select value={compareFrom} onChange={(e) => setCompareFrom(e.target.value)} aria-label="Compare from version" style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
            <option value="">From the start</option>
            {versions.map((v) => <option key={v} value={v}>after {v}</option>)}
          </select>
          <ArrowRight size={13} />
          <select value={compareTo} onChange={(e) => setCompareTo(e.target.value)} aria-label="Compare to version" style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
            <option value="">Up to now</option>
            {versions.map((v) => <option key={v} value={v}>up to {v}</option>)}
          </select>
        </>)}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!breakingOnly} onChange={(e) => setBreakingOnly(e.target.checked ? '1' : '')} />Breaking / Action Required
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!mineOnly} onChange={(e) => setMineOnly(e.target.checked ? 'me' : '')} />For You
        </label>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12 }}>
          {anyFilter && <button type="button" onClick={clearAll} style={{ ...btn('ghost'), padding: 0, fontSize: 12.5, color: NX.dim }}><X size={13} />Clear Filters</button>}
          <button type="button" onClick={async () => {
            let ok = false;
            try { await navigator.clipboard.writeText(window.location.href); ok = true; } catch { ok = false; }
            flash(ok ? 'Link to this view copied.' : 'Could not copy the link.', !ok);
          }} style={{ ...btn('ghost'), padding: 0, fontSize: 12.5, color: NX.blue }}><Copy size={13} />Copy Link to This View</button>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: NX.ink }}>Activity Timeline</h2>
        <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{plural(filtered.length, 'entry', 'entries')}</span>
      </div>

      <div style={isMobile ? undefined : { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', minHeight: 0, flex: 1 }}>
        {/* Master list */}
        <div className="nx-scroll" style={isMobile
          ? { display: 'flex', flexDirection: 'column', gap: 16 }
          : { minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20, paddingRight: 4 }}>
          {groups.map(([k, group]) => (
            <div key={k}>
              <DayHeader group={group} />
              <div style={{ ...card, overflow: 'hidden' }}>
                {group.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} compact={compactRows} selected={!isMobile && entry.id === selectedId}
                    onClick={() => (isMobile ? setSheet(entry) : setSelectedId(entry.id))} />
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

        {/* Detail pane (wider screens; a phone opens the sheet below) */}
        {!isMobile && <div style={{ minHeight: 0 }}>
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
        </div>}
      </div>

      {isMobile && sheet && (
        <SlideOver entry={entries.find((x) => x.id === sheet.id) || sheet} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
          onClose={() => setSheet(null)} onSetStatus={onSetStatus}
          onEdit={isAdmin ? () => { onEdit(sheet); setSheet(null); } : undefined} />
      )}

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

// A Timeline row's reactions and comments, at a glance (Pranshu, Oct 16 2026).
function RowResponse({ entry }) {
  const reactions = Object.values(entry.reactions || {}).reduce((a, b) => a + b, 0);
  const comments = entry.commentCount || 0;
  if (!reactions && !comments) return null;
  const top = Object.entries(entry.reactions || {}).sort((a, b) => b[1] - a[1])[0];
  const emoji = top ? (REACTIONS.find((r) => r.key === top[0]) || {}).emoji : null;
  return (
    <span title={`${plural(reactions, 'reaction')}, ${plural(comments, 'comment')}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0, color: NX.faint }}>
      {reactions > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span aria-hidden>{emoji}</span>{reactions}</span>}
      {comments > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MessageSquare size={11} />{comments}</span>}
    </span>
  );
}

function TimelineRow({ entry, selected, onClick, compact = false }) {
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const thumbnail = (entry.images && entry.images[0]) || entry.afterImageDataUrl;
  if (compact) {
    // Phones and tablets: the title gets the full width (two lines), the
    // category, module and time sit under it - the desktop row's time column
    // and thumbnail left the title one letter wide.
    return (
      <button onClick={onClick} style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', cursor: 'pointer',
        border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '12px 14px', minHeight: 56,
        background: selected ? 'rgba(37,99,235,0.10)' : 'transparent', fontFamily: FONT,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="nx-clamp-2" style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.35, color: NX.ink }}>{entry.title}</div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim }}>
            <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}><Icon size={11} />{meta.label}</span>
            <IssueChip entry={entry} />
            {entry.module && <span>{entry.module}</span>}
            <span style={{ color: NX.faint }}>{formatTime(releasedKey(entry))}</span>
            <RowResponse entry={entry} />
          </div>
        </div>
        <ChevronRight size={16} style={{ flexShrink: 0, color: NX.faint }} />
      </button>
    );
  }
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 16, width: '100%', textAlign: 'left', cursor: 'pointer',
      borderBottom: `1px solid ${NX.border}`, borderLeft: 'none', borderRight: 'none', borderTop: 'none',
      padding: '14px 16px', background: selected ? 'rgba(37,99,235,0.10)' : 'transparent', fontFamily: FONT,
    }}>
      <span style={{ width: 48, flexShrink: 0, fontFamily: 'monospace', fontSize: 12, color: NX.dim }}>{formatTime(releasedKey(entry))}</span>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: meta.color }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...chip(meta.color, meta.tint), fontSize: 11 }}><Icon size={11} />{meta.label}</span>
          {issueOf(entry)?.active && <IssueChip entry={entry} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 700, color: NX.ink }}>{entry.title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.module}</span>
          <span>·</span>
          <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{entry.version}</span>
          {stageOf(entry) && (<><span>·</span><StageChip entry={entry} /></>)}
          <RowResponse entry={entry} />
        </div>
      </div>
      {thumbnail && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 80, flexShrink: 0, aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface2 }}>
        <img src={thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
      </div>}
      <ChevronRight size={16} style={{ flexShrink: 0, color: NX.faint }} />
    </button>
  );
}

// A Timeline day: its date, the versions released on it, and how many of each
// category - what the Version History tab used to show per version.
function DayHeader({ group }) {
  const date = formatFullDate(releasedKey(group[0]));
  // A merge's version is its release day (MM/DD/YYYY); only a typed one adds anything.
  const versions = Array.from(new Set(group.map((e) => e.version).filter((v) => v && !/^\d{2}\/\d{2}\/\d{4}$/.test(v))));
  const counts = new Map();
  for (const e of group) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  return (
    <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{date}</span>
      {versions.map((v) => (
        <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: NX.dim }}>
          <GitBranch size={12} />{v}
        </span>
      ))}
      <Badge label={`${group.length} update${group.length === 1 ? '' : 's'}`} />
      {[...counts.entries()].map(([type, n]) => {
        const meta = typeMeta(type);
        return <Badge key={type} label={`${n} ${meta.label}`} color={meta.color} tint={meta.tint} />;
      })}
    </div>
  );
}

// A day on the phone and tablet Timeline: pinned to the top of the list while
// you scroll through it, its date said the way people say it (Today,
// Yesterday, then the date), and its categories as colored dots rather than
// a second row of pills.
function StickyDayHeader({ group }) {
  const iso = releasedKey(group[0]);
  const date = formatFullDate(iso);
  const rel = relativeDayLabel(iso);
  // A merge's version is its release day (MM/DD/YYYY); only a typed one adds anything.
  const versions = Array.from(new Set(group.map((e) => e.version).filter((v) => v && !/^\d{2}\/\d{2}\/\d{4}$/.test(v))));
  const counts = new Map();
  for (const e of group) counts.set(e.type, (counts.get(e.type) || 0) + 1);
  const summary = [...counts.entries()].map(([t, n]) => `${n} ${typeMeta(t).label}`).join(', ');
  return (
    <div data-day-header style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '14px 2px 8px', background: NX.canvas }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: NX.ink, whiteSpace: 'nowrap' }}>{rel || date}</span>
      {rel && rel !== date && <span style={{ fontSize: 12.5, color: NX.dim, whiteSpace: 'nowrap' }}>{date}</span>}
      {versions.map((v) => (
        <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: NX.dim }}>
          <GitBranch size={12} style={{ flexShrink: 0 }} />{v}
        </span>
      ))}
      <span title={summary} aria-label={`${plural(group.length, 'update')}: ${summary}`}
        style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: 12, fontWeight: 600, color: NX.dim }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', gap: 3 }}>
          {[...counts.keys()].map((t) => <span key={t} style={{ width: 7, height: 7, borderRadius: '50%', background: typeMeta(t).color }} />)}
        </span>
        {group.length} {group.length === 1 ? 'Update' : 'Updates'}
      </span>
    </div>
  );
}

// The phone and tablet Timeline's filters, in one bottom sheet behind the
// Filter button. Every control is the desktop bar's own state, so the address
// bar still carries them and a filtered Timeline is still a link to share.
function TimelineFilterSheet({ f, count, anyFilter, onClearAll, onClose, flash }) {
  const lab = { display: 'block', fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint, marginBottom: 6 };
  const sel = { ...inputStyle, height: 44, fontSize: 16, width: '100%', cursor: 'pointer' };
  // A select that reads as one on every phone: its own chevron, not the
  // browser's (the app's select styling hides that one in some browsers).
  const pick = (value, onChange, label, children) => (
    <div style={{ position: 'relative' }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        style={{ ...sel, appearance: 'none', WebkitAppearance: 'none', paddingRight: 36 }}>{children}</select>
      <ChevronDown size={16} aria-hidden="true" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: NX.dim, pointerEvents: 'none' }} />
    </div>
  );
  const field = { marginBottom: 16 };
  const toggle = (checked, onChange, title, hint) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, padding: '6px 0', borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: NX.ink }}>{title}</span>
        {hint && <span style={{ display: 'block', fontSize: 12.5, color: NX.dim, marginTop: 2 }}>{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 22, height: 22, accentColor: NX.blue, flexShrink: 0, cursor: 'pointer' }} />
    </label>
  );
  const copyLink = async () => {
    let ok = true;
    try { await navigator.clipboard.writeText(window.location.href); } catch { ok = false; }
    flash?.(ok ? 'Link to this view copied.' : 'Could not copy the link.', !ok);
  };
  return (
    <BottomSheet title="Filter Updates" onClose={onClose}>
      <div style={{ marginTop: -8, marginBottom: 16 }}>
        {toggle(!!f.mineOnly, (on) => f.setMineOnly(on ? 'me' : ''), 'For You', 'Only updates about the modules you use')}
        {toggle(!!f.breakingOnly, (on) => f.setBreakingOnly(on ? '1' : ''), 'Breaking / Action Required', 'Changes you may need to act on')}
      </div>
      <div style={field}>
        <span style={lab}>Module</span>
        {pick(f.moduleFilter, f.setModuleFilter, 'Module', <>
          <option value={ALL}>All Modules</option>
          {f.modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </>)}
      </div>
      <div style={field}>
        <span style={lab}>Category</span>
        {pick(f.typeFilter, f.setTypeFilter, 'Category', <>
          <option value={ALL}>All Categories</option>
          {CHANGE_TYPES.map((t) => <option key={t} value={t}>{CHANGE_TYPE_META[t].label}</option>)}
        </>)}
      </div>
      <div style={{ ...field, display: 'flex', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={lab}>Environment</span>
          {pick(f.envFilter, f.setEnvFilter, 'Environment', <>
            <option value={ALL}>All</option>
            {ENVIRONMENTS.map((e2) => <option key={e2} value={e2}>{envLabel(e2)}</option>)}
          </>)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={lab}>Version</span>
          {pick(f.versionFilter, f.setVersionFilter, 'Version', <>
            <option value={ALL}>All</option>
            {f.versions.map((v) => <option key={v} value={v}>{v}</option>)}
          </>)}
        </div>
      </div>
      <div style={field}>
        <span style={lab}>Released</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {/* The app's own calendar, MM/DD/YYYY whatever the phone's region. */}
          <DateField value={f.fromDate || null} onChange={(v) => f.setFromDate(v || '')} placeholder="From" title="From date"
            style={{ ...inputStyle, height: 44, flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center' }} />
          <DateField value={f.toDate || null} onChange={(v) => f.setToDate(v || '')} placeholder="To" title="To date"
            style={{ ...inputStyle, height: 44, flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center' }} />
        </div>
      </div>
      <div style={field}>
        {toggle(f.comparing, (on) => { if (!on) { f.setCompareFrom(''); f.setCompareTo(''); } f.setComparing(on); },
          'Compare Versions', 'Everything released after one version, up to another')}
        {f.comparing && (
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            {pick(f.compareFrom, f.setCompareFrom, 'Compare from version', <>
              <option value="">From the start</option>
              {f.versions.map((v) => <option key={v} value={v}>after {v}</option>)}
            </>)}
            {pick(f.compareTo, f.setCompareTo, 'Compare to version', <>
              <option value="">Up to now</option>
              {f.versions.map((v) => <option key={v} value={v}>up to {v}</option>)}
            </>)}
          </div>
        )}
      </div>
      <button type="button" onClick={copyLink} style={{ ...btn('outline'), width: '100%', justifyContent: 'center', minHeight: 44, marginBottom: 6 }}>
        <Copy size={15} />Copy Link to This View
      </button>
      {/* The sheet's own padding is 16px plus the safe area; the bar cancels
          both so it reaches the sheet's edges with nothing scrolling under it. */}
      <div style={{
        position: 'sticky', bottom: 'calc(-16px - env(safe-area-inset-bottom))', zIndex: 2, background: NX.surface,
        borderTop: `1px solid ${NX.border2}`, marginTop: 10,
        marginLeft: -16, marginRight: -16, marginBottom: 'calc(-16px - env(safe-area-inset-bottom))',
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {anyFilter && (
          <button type="button" onClick={onClearAll} style={{ ...btn('outline'), justifyContent: 'center', minHeight: 46, padding: '0 16px', fontSize: 15 }}>Clear All</button>
        )}
        <button type="button" onClick={onClose} style={{ ...btn('primary'), flex: 1, justifyContent: 'center', minHeight: 46, fontSize: 15 }}>
          {count === 0 ? 'No Matching Updates' : `Show ${count} ${count === 1 ? 'Update' : 'Updates'}`}
        </button>
      </div>
    </BottomSheet>
  );
}

// Automatic publishing's health (GET /task-changelog/auto-status). A failing
// sweep used to leave no trace outside the server log, so What's New just
// stopped filling and looked like a quiet few weeks (Oct 2026).
function AutoDraftStatus({ refreshKey }) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let live = true;
    api.getTaskChangelogAutoStatus().then((s) => { if (live) setSt(s); }).catch(() => { if (live) setSt(null); });
    return () => { live = false; };
  }, [refreshKey]);
  if (!st) return null;
  const line = { margin: '-12px 0 20px', fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 6 };
  if (!st.enabled) {
    return <p style={{ ...line, color: NX.dim }}>Automatic publishing is turned off on this server.</p>;
  }
  if (st.lastError) {
    return (
      <p role="alert" style={{ ...line, color: NX.red }}>
        <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Automatic publishing failed {formatDateTime(st.lastErrorAt)}: {st.lastError}
          {st.nextRunAt && <> Next try {formatDateTime(st.nextRunAt)}.</>}
        </span>
      </p>
    );
  }
  if (!st.lastRunAt) {
    return <p style={{ ...line, color: NX.dim }}>Automatic publishing has not run on this server yet{st.nextRunAt ? ` - next run ${formatDateTime(st.nextRunAt)}` : ''}.</p>;
  }
  return (
    <>
      <p style={{ ...line, color: NX.dim }}>
        Automatic publishing last ran {formatDateTime(st.lastRunAt)} ({st.lastCreated} published) - next run {formatDateTime(st.nextRunAt)}.
      </p>
      {/* Claude only rewrites the wording; when it can't, the PR's own words go out. */}
      {st.polishNote && (
        <p style={{ ...line, color: '#b45309' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Published with the pull request's own wording - AI rewording unavailable: {st.polishNote}</span>
        </p>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Manage (admin, opened from the header's Manage button) - the publish queue,
// reach and response, and every update
// ═══════════════════════════════════════════════════════════════════════════
function ManageTab({ entries, nameOf, myEmail, onSetStatus, onEdit, onAdd, onGenerate, onPublish, onPublishAll, onDelete, onBulk, flash }) {
  const { openEntry } = useContext(ChangelogActions);
  // Read rate, weekly trends, most reacted, helpful votes (changelog_extras.insights).
  const [insights, setInsights] = useState(null);
  // Rows ticked for a bulk action.
  const [picked, setPicked] = useState(() => new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [reviewing, setReviewing] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [publishingAll, setPublishingAll] = useState(false);
  const withStatus = useMemo(() => entries.map((e) => ({ entry: e, status: statusOf(e) })), [entries]);
  const pending = withStatus.filter((x) => x.status === 'Pending Review');
  const rest = withStatus.filter((x) => x.status !== 'Pending Review');
  const publishedCount = rest.filter((x) => x.status === 'Released').length;

  const [statusKey, setStatusKey] = useState(0);
  // Reach and response (Pranshu, Oct 16 2026): who saw each update, and how
  // people reacted and commented.
  const [analytics, setAnalytics] = useState(null);
  useEffect(() => {
    let live = true;
    api.getTaskChangelogAnalytics?.()?.then?.((a) => { if (live) setAnalytics(a); })?.catch?.(() => {});
    api.getTaskChangelogInsights?.()?.then?.((a) => { if (live) setInsights(a); })?.catch?.(() => {});
    return () => { live = false; };
  }, [statusKey]);
  const stat = (id) => analytics?.entries?.[id] || { viewers: 0, views: 0, reactionTotal: 0, comments: 0 };

  const isMobile = useIsMobile();
  const pendingBtn = isMobile ? { flex: 1, justifyContent: 'center', minHeight: 40 } : null;
  const generate = async () => {
    setGenerating(true);
    try { await onGenerate?.(); } finally { setGenerating(false); setStatusKey((k) => k + 1); }
  };
  const publishAll = async () => {
    setPublishingAll(true);
    try { await onPublishAll?.(); } finally { setPublishingAll(false); }
  };
  // Live in Production (Oct 18 2026): the dev site asks GitHub which merged
  // updates are on main now; the loop does it every 10 minutes anyway.
  const [checkingProd, setCheckingProd] = useState(false);
  const checkProduction = async () => {
    setCheckingProd(true);
    try {
      const r = await api.checkChangelogProduction();
      flash?.(r?.message || 'Checked.');
      if (r?.live) window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) { flash?.(e?.message || 'Could not check production.', true); } finally { setCheckingProd(false); }
  };

  const totals = analytics?.totals;
  const tiles = [
    ['Published', publishedCount],
    ['People Reached', totals?.peopleReached ?? '-'],
    ['Views', totals?.views ?? '-'],
    ['Reactions', totals?.reactions ?? '-'],
    ['Comments', totals?.comments ?? '-'],
  ];

  return (
    <div style={{ padding: isMobile ? '14px 12px' : '20px 16px' }}>
      {/* Phones: the title, then the two actions sharing a full-width row. */}
      <div style={{ display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', alignItems: 'center', justifyContent: 'space-between', gap: isMobile ? 10 : 8, marginBottom: isMobile ? 10 : 4 }}>
        <h1 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 700, color: NX.ink }}>Manage</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...(isMobile ? { width: '100%' } : null) }}>
          {onGenerate && (
            <button style={{ ...btn('outline'), opacity: generating ? 0.6 : 1, ...(isMobile ? { flex: 1, justifyContent: 'center', minHeight: 40 } : null) }} disabled={generating} onClick={generate}>
              <GitBranch size={15} style={generating ? { animation: 'spin 0.9s linear infinite' } : undefined} />
              {generating ? 'Checking…' : 'Check for Updates'}
            </button>
          )}
          <button style={{ ...btn('primary'), ...(isMobile ? { flex: 1, justifyContent: 'center', minHeight: 40 } : null) }} onClick={onAdd}><Plus size={15} />{isMobile ? 'Add Update' : 'Add New Update'}</button>
          {!isMobile && (
            <button type="button" style={{ ...btn('outline'), opacity: checkingProd ? 0.6 : 1 }} disabled={checkingProd} onClick={checkProduction}
              title="Which merged updates have reached production">
              <Server size={15} />{checkingProd ? 'Checking…' : 'Check Production'}
            </button>
          )}
          {!isMobile && <ExportButtons onCsv={() => exportCsv(entries, analytics, insights, statusOf)} onPrint={() => buildPrintReport(entries, analytics, insights, statusOf)} />}
        </div>
      </div>
      <p style={{ margin: '0 0 20px', fontSize: 13, lineHeight: 1.55, color: NX.dim }}>
        Everything merged into this site's branch - pull requests, branches merged by hand and commits pushed straight
        to it - is published to What's New automatically a few minutes after it lands. <strong>Check for Updates</strong> runs
        that now instead of waiting. Edit any update below; <strong>Re-publish</strong> sends an edited one out again as new.
        Updates you add here publish immediately; teammate submissions wait in Pending Review.
      </p>
      <AutoDraftStatus refreshKey={statusKey} />

      {/* Reach and response, all updates */}
      <div data-whats-new-analytics style={{ marginBottom: 24, display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
        {tiles.map(([label, value]) => (
          <div key={label} style={{ ...card, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint }}>{label}</div>
            <div style={{ marginTop: 4, fontSize: 22, fontWeight: 700, color: NX.ink }}>{value}</div>
          </div>
        ))}
      </div>

      <InsightsPanel insights={insights} onOpen={(id) => openEntry(id)} />

      {/* Pending Review shows only while something waits (Oct 16 2026): merges
          publish themselves, so an empty box here was the usual sight. The
          Manage button's count says when a submission arrives. */}
      {pending.length > 0 && (<>
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NX.ink }}>Pending Review</h2>
        {pending.length > 0 && <Badge label={String(pending.length)} color="#d97706" tint="#fdefd7" />}
        {pending.length > 1 && onPublishAll && (
          <button disabled={publishingAll} onClick={publishAll} style={{ ...btn('primary'), marginLeft: 'auto', opacity: publishingAll ? 0.6 : 1, ...(isMobile ? { minHeight: 40 } : null) }}>
            <CheckCircle2 size={13} />Publish All
          </button>
        )}
      </div>

        <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pending.map(({ entry }) => {
            const meta = typeMeta(entry.type);
            return (
              // Phones: the title across the top, the category in the line under
              // it, and the three actions sharing one full-width row.
              <div key={entry.id} style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: isMobile ? 10 : 12, padding: isMobile ? '12px 14px' : '12px 16px' }}>
                {!isMobile && <span style={chip(meta.color, meta.tint)}>{meta.label}</span>}
                <div style={{ minWidth: 0, flex: isMobile ? '1 1 100%' : '1 1 200px' }}>
                  <div className={isMobile ? 'nx-clamp-2' : undefined} style={isMobile
                    ? { fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, color: NX.ink }
                    : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink }}>{entry.title}</div>
                  <div style={{ marginTop: isMobile ? 6 : 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: NX.faint }}>
                    {isMobile && <span style={chip(meta.color, meta.tint)}>{meta.label}</span>}
                    <span>{entry.module}</span><span>·</span><span>{formatDateTime(releasedKey(entry))}</span>
                    {entry.prRef && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><GitPullRequest size={12} />{entry.prRef}</span>}
                  </div>
                </div>
                <button style={{ ...btn('outline'), ...pendingBtn }} onClick={() => setReviewing(entry)}><Eye size={13} />Review</button>
                <button style={{ ...btn('outline'), ...pendingBtn }} onClick={() => onEdit(entry)}><Pencil size={13} />Edit</button>
                <button style={{ ...btn('primary'), ...pendingBtn }} onClick={() => (onPublish ? onPublish(entry) : onSetStatus(entry, 'Released'))}><CheckCircle2 size={13} />Publish</button>
              </div>
            );
          })}
        </div>
      </>)}

      <FeedbackList nameOf={nameOf} entries={entries} flash={flash} />

      <div style={{ margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NX.ink }}>All Updates</h2>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim, cursor: 'pointer' }}>
          <input type="checkbox" aria-label="Select all updates" checked={rest.length > 0 && picked.size === rest.length}
            onChange={(e) => setPicked(e.target.checked ? new Set(rest.map((x) => x.entry.id)) : new Set())} />Select All
        </label>
      </div>
      {picked.size > 0 && (
        <div role="toolbar" aria-label="Bulk actions" style={{ ...card, marginBottom: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13 }}>
          <strong style={{ marginRight: 4 }}>{plural(picked.size, 'selected', 'selected')}</strong>
          {[['publish', 'Publish'], ['pin', 'Pin'], ['unpin', 'Unpin'], ['hide', 'Hide'], ['show', 'Show']].map(([a, label]) => (
            <button key={a} type="button" onClick={async () => { if (await onBulk([...picked], a)) setPicked(new Set()); }} style={{ ...btn('outline'), padding: '4px 10px' }}>{label}</button>
          ))}
          <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} aria-label="New category" style={{ ...inputStyle, width: 'auto', padding: '4px 8px' }}>
            <option value="">Change Category…</option>
            {CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {bulkCategory && <button type="button" onClick={async () => { if (await onBulk([...picked], 'category', bulkCategory)) { setPicked(new Set()); setBulkCategory(''); } }} style={{ ...btn('outline'), padding: '4px 10px' }}>Apply</button>}
          <button type="button" onClick={async () => {
            if (window.confirm(`Delete ${plural(picked.size, 'update')}? This cannot be undone.`) && await onBulk([...picked], 'delete')) setPicked(new Set());
          }} style={{ ...btn('outline'), padding: '4px 10px', color: NX.red }}><Trash2 size={13} />Delete</button>
          <button type="button" onClick={() => setPicked(new Set())} style={{ ...btn('ghost'), padding: '4px 6px', marginLeft: 'auto', color: NX.dim }}>Clear</button>
        </div>
      )}
      <div style={{ ...card, overflow: 'hidden' }}>
        {rest.map(({ entry, status }) => {
          const meta = typeMeta(entry.type);
          const sm = STATUS_META[status] || { color: NX.dim, tint: NX.border2 };
          const st = stat(entry.id);
          const rate = insights?.entries?.[entry.id]?.readRate;
          const tick = (
            <input type="checkbox" aria-label={`Select ${entry.title}`} checked={picked.has(entry.id)} style={{ flexShrink: 0 }}
              onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(entry.id) : n.delete(entry.id); return n; })} />
          );
          const flags = (<>
            {entry.pinned && <span title="Pinned" style={{ display: 'inline-flex', color: NX.faint, flexShrink: 0 }}><Pin size={12} /></span>}
            {entry.hidden && <Badge label="Hidden" />}
            {entry.breaking && <Badge label="Breaking" color="#b91c1c" tint="rgba(220,38,38,0.12)" />}
            {issueOf(entry)?.active && <IssueChip entry={entry} />}
            {entry.deprecation?.removeOn && <DeprecationChip entry={entry} />}
          </>);
          // flexShrink: 0 on the icon buttons - a long title squeezed them to
          // specks. Phones: the title on its own line, the rest beneath it,
          // and 40px icon targets.
          const iconBtn = { ...btn('ghost'), padding: 6, color: NX.faint, flexShrink: 0, ...(isMobile ? { width: 40, height: 40, justifyContent: 'center' } : null) };
          const again = status === 'Released';
          const actions = (<>
            <button onClick={() => onEdit(entry)} title="Edit" aria-label={`Edit ${entry.title}`} style={iconBtn}><Pencil size={isMobile ? 16 : 14} /></button>
            {onPublish && (
              <button onClick={() => onPublish(entry)} title={again ? 'Re-publish' : 'Publish'} aria-label={`${again ? 'Re-publish' : 'Publish'} ${entry.title}`} style={iconBtn}>
                {again ? <RefreshCw size={isMobile ? 16 : 14} /> : <Send size={isMobile ? 16 : 14} />}
              </button>
            )}
            <button onClick={() => onDelete(entry.id)} title="Delete" aria-label={`Delete ${entry.title}`} style={iconBtn}><Trash2 size={isMobile ? 16 : 14} /></button>
          </>);
          // Reach and response for the row: people who saw it, reactions, comments.
          const numbers = again && (
            <span title={`Seen by ${plural(st.viewers, 'person', 'people')} (${plural(st.views, 'view')}), ${plural(st.reactionTotal, 'reaction')}, ${plural(st.comments, 'comment')}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0, fontSize: 12, color: NX.faint }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Eye size={12} />{st.viewers}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span aria-hidden>👍</span>{st.reactionTotal}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MessageSquare size={12} />{st.comments}</span>
              {rate != null && <span title="Read rate: the people it is for who have seen it">{rate}% read</span>}
            </span>
          );
          return isMobile ? (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid ${NX.border2}`, padding: '10px 6px 10px 14px' }}>
              {tick}
              <button onClick={() => setReviewing(entry)} style={{ minWidth: 0, flex: 1, textAlign: 'left', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: FONT }}>
                <div className="nx-clamp-2" style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, color: NX.ink }}>{entry.title}</div>
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: NX.faint }}>
                  <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
                  {entry.module && <span>{entry.module}</span>}
                  <Badge label={status} color={sm.color} tint={sm.tint} />
                  {flags}
                  {numbers}
                </div>
              </button>
              {actions}
            </div>
          ) : (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${NX.border2}`, padding: '10px 16px' }}>
              {tick}
              <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
              <button onClick={() => setReviewing(entry)} style={{ minWidth: 0, flex: 1, textAlign: 'left', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600, color: NX.ink }}>{entry.title}</button>
              <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{entry.module}</span>
              {flags}
              {numbers}
              <Badge label={status} color={sm.color} tint={sm.tint} />
              {actions}
            </div>
          );
        })}
        {rest.length === 0 && <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>No other updates yet.</div>}
      </div>

      {reviewing && (
        <div onMouseDown={(e) => e.target === e.currentTarget && setReviewing(null)} style={{ position: 'fixed', inset: 0, zIndex: 3200, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,0.4)' }}>
          <div style={{ height: '100%', width: isMobile ? '100%' : 'min(760px, 90vw)', boxShadow: '-8px 0 40px rgba(0,0,0,0.28)' }}>
            <DetailCard entry={entries.find((x) => x.id === reviewing.id) || reviewing} nameOf={nameOf} myEmail={myEmail} isAdmin
              onClose={() => setReviewing(null)} onSetStatus={onSetStatus}
              onEdit={() => { onEdit(reviewing); setReviewing(null); }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Detail card - sub-tabs (Overview / Technical Details / Media / Links / Comments,
// + Analytics for admins)
// ═══════════════════════════════════════════════════════════════════════════
const DETAIL_TABS = ['Overview', 'Technical Details', 'Media', 'Related Links', 'Comments'];
// What a phone's narrower sub-tab strip calls them.
const SHORT_DETAIL_TAB = { 'Technical Details': 'Technical', 'Related Links': 'Links' };

function DetailCard({ entry, nameOf, myEmail, isAdmin, onClose, expanded, onToggleExpand, onEdit, onSetStatus }) {
  const [tab, setTab] = useState('Overview');
  // Everyone reads the comments; posting one is behind the same grant as editing.
  const canComment = canEditWhatsNew(useRole());
  const [status, setStatusLocal] = useState(() => statusOf(entry));
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef(null);
  useClickOutside(statusRef, () => setStatusOpen(false), statusOpen);
  const [preview, setPreview] = useState(null);



  useEffect(() => { setStatusLocal(statusOf(entry)); }, [entry]);
  // Opened in full = seen (the analytics in Manage).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (statusOf(entry) === 'Released') recordViews([entry.id]); }, [entry.id]);
  const detailTabs = isAdmin ? [...DETAIL_TABS, 'Analytics', 'History'] : DETAIL_TABS;
  const { all, openEntry, flash, onCommented, onPin, onEntryChanged } = useContext(ChangelogActions);
  const [issueOpen, setIssueOpen] = useState(false);

  const meta = typeMeta(entry.type);
  const statusMeta = STATUS_META[status] || { color: NX.dim, tint: NX.border2 };
  const media = [entry.beforeImageDataUrl, entry.afterImageDataUrl, ...(entry.images || [])].filter(Boolean);
  const files = entry.attachments || [];
  const tags = entry.tags || [];


  const changeStatus = (next) => { setStatusLocal(next); setStatusOpen(false); onSetStatus?.(entry, next); };

  const label11 = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint };
  const isMobile = useIsMobile();
  const padX = isMobile ? 16 : 24;
  // Phones: the admin actions live in one sheet behind More.
  const [actionsOpen, setActionsOpen] = useState(false);
  const phoneActions = isMobile && !!(isAdmin || onEdit || onPin);
  // Phones: one column - two side by side left each half too narrow to read.
  const twoCol = isMobile ? '1fr' : '1fr 1fr';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: NX.surface, fontFamily: FONT }}>
      {/* Top bar. A phone gets a pushed screen's bar (Oct 28 2026): Back on
          the left, everything an admin can do behind one More button - the
          row of Pin / Report Issue / Edit / status ran off the right edge
          and took the close button with it. */}
      {isMobile ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 'calc(4px + env(safe-area-inset-top)) 8px 0' }}>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Back"
              style={{ ...btn('ghost'), minHeight: 44, padding: '0 12px 0 4px', gap: 2, color: NX.blue, fontSize: 16, fontWeight: 600 }}>
              <ChevronLeft size={24} />Back
            </button>
          )}
          {phoneActions && (
            <button type="button" onClick={() => setActionsOpen(true)} aria-label="More Actions" aria-haspopup="dialog"
              style={{ ...btn('ghost'), marginLeft: 'auto', width: 44, height: 44, padding: 0, justifyContent: 'center', color: NX.ink }}>
              <MoreHorizontal size={22} />
            </button>
          )}
          {actionsOpen && (() => {
            const row = (Icon, label, run, on = false) => (
              <button key={label} type="button" onClick={() => { setActionsOpen(false); run(); }} aria-pressed={on || undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 52, padding: '0 4px', border: 'none',
                  borderBottom: `1px solid ${NX.border2}`, background: 'transparent', cursor: 'pointer', fontFamily: FONT, fontSize: 15,
                  fontWeight: on ? 700 : 500, color: NX.ink, textAlign: 'left' }}>
                {Icon ? <Icon size={18} style={{ color: NX.dim, flexShrink: 0 }} /> : <span style={{ width: 18, flexShrink: 0 }} />}
                <span style={{ flex: 1 }}>{label}</span>
                {on && <CheckCircle2 size={18} style={{ color: NX.blue, flexShrink: 0 }} />}
              </button>
            );
            return (
              <BottomSheet title="Update Actions" onClose={() => setActionsOpen(false)}>
                <div style={{ display: 'flex', flexDirection: 'column', marginTop: -8 }}>
                  {onPin && status === 'Released' && row(Pin, entry.pinned ? 'Unpin' : 'Pin to Top', () => onPin(entry))}
                  {isAdmin && status === 'Released' && row(AlertTriangle, issueOf(entry)?.active ? 'Known Issue' : 'Report Issue', () => setIssueOpen(true))}
                  {onEdit && row(Pencil, 'Edit', onEdit)}
                </div>
                {isAdmin && (<>
                  <div style={{ ...label11, margin: '18px 0 4px' }}>Status</div>
                  {STATUSES.map((st) => row(null, st, () => changeStatus(st), st === status))}
                </>)}
              </BottomSheet>
            );
          })()}
        </div>
      ) : (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: isMobile ? `calc(12px + env(safe-area-inset-top)) ${padX}px 0` : `18px ${padX}px 0` }}>
        <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          {onPin && status === 'Released' && (
            <button type="button" onClick={() => onPin(entry)} aria-pressed={!!entry.pinned} style={{ ...btn('outline'), ...(entry.pinned ? { color: NX.blue, borderColor: NX.blue } : null) }}>
              <Pin size={13} />{entry.pinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {isAdmin && status === 'Released' && (
            <button type="button" onClick={() => setIssueOpen(true)} style={{ ...btn('outline'), ...(issueOf(entry)?.active ? { color: '#b45309', borderColor: '#b45309' } : null) }}>
              <AlertTriangle size={13} />{issueOf(entry)?.active ? 'Known Issue' : 'Report Issue'}
            </button>
          )}
          {onEdit && <button onClick={onEdit} style={btn('outline')}><Pencil size={13} />Edit</button>}
          {isAdmin ? (
            <div ref={statusRef} style={{ position: 'relative' }}>
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
          {onToggleExpand && !isMobile && (
            <button onClick={onToggleExpand} title={expanded ? 'Collapse' : 'Expand to full page'} style={{ ...btn('ghost'), padding: 6, color: NX.dim }}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          {onClose && <button onClick={onClose} aria-label="Close" style={{ ...btn('ghost'), padding: 6, color: NX.dim, ...(isMobile ? { width: 40, height: 40, justifyContent: 'center' } : null) }}><X size={isMobile ? 20 : 16} /></button>}
        </div>
      </div>
      )}

      {/* Title + meta */}
      <div style={{ padding: `8px ${padX}px ${isMobile ? 12 : 16}px` }}>
        {isMobile && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={chip(meta.color, meta.tint)}>{meta.label}</span>
            {status !== 'Released' && <span style={chip(statusMeta.color, statusMeta.tint)}>{status}</span>}
            {entry.pinned && <span style={chip(NX.blue, 'rgba(37,99,235,0.10)')}><Pin size={11} />Pinned</span>}
          </div>
        )}
        <h2 style={{ margin: 0, fontSize: isMobile ? 21 : 22, lineHeight: 1.3, fontWeight: 700, color: NX.ink }}>{entry.title}</h2>
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: isMobile ? '6px 12px' : 12, fontSize: 13, color: NX.dim }}>
          {entry.module && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Layers size={13} style={{ color: NX.faint }} />{entry.module}</span>}
          {entry.version && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><GitBranch size={13} style={{ color: NX.faint }} /><span style={{ fontFamily: 'monospace' }}>{entry.version}</span></span>}
          <StageChip entry={entry} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={13} style={{ color: NX.faint }} />{formatDateTime(releasedKey(entry))}</span>
          {entry.republishedAt && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RefreshCw size={12} style={{ color: NX.faint }} />Re-published</span>}
        </div>
        {(issueOf(entry) || entry.deprecation?.removeOn) && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}><IssueChip entry={entry} /><DeprecationChip entry={entry} /></div>
        )}
        {status === 'Released' && <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <ReactionBar entry={entry} />
          <TakeTourButton entry={entry} style={{ marginLeft: 'auto' }} />
        </div>}
      </div>

      {/* Sub-tabs */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', whiteSpace: 'nowrap', borderBottom: `1px solid ${NX.border}`, padding: `0 ${isMobile ? 6 : padX}px` }}>
        {detailTabs.map((t) => {
          const active = tab === t;
          const suffix = t === 'Media' ? ` (${media.length + files.length})` : t === 'Comments' ? ` (${entry.commentCount || 0})` : '';
          return (
            <button key={t} onClick={() => setTab(t)} aria-label={`${t}${suffix}`} style={{
              flexShrink: 0, cursor: 'pointer', border: 'none', borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`,
              background: 'transparent', padding: isMobile ? '13px 11px' : '10px 10px', fontSize: isMobile ? 14 : 13, fontWeight: 600, fontFamily: FONT,
              color: active ? NX.ink : NX.dim,
            }}>{isMobile ? (SHORT_DETAIL_TAB[t] || t) : t}{suffix}</button>
          );
        })}
      </div>

      {/* Sub-tab body */}
      <div className="nx-scroll" style={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: isMobile ? `16px ${padX}px calc(24px + env(safe-area-inset-bottom))` : `20px ${padX}px` }}>
        {tab === 'Overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <IssueBanner entry={entry} all={all} onOpen={openEntry} />
              <h3 style={{ ...label11, ...(issueOf(entry) ? { marginTop: 16 } : null) }}>Description (Layman's Terms)</h3>
              <RichText text={entry.description} style={{ marginTop: 8, fontSize: 14 }} />
              <ActionRequired entry={entry} />
              <DeprecationNotice entry={entry} />
            </div>
            {entry.videoUrl && <VideoEmbed url={entry.videoUrl} />}
            <RelatedUpdates entry={entry} all={all} onOpen={(o) => openEntry(o.id)} />
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
                  {[['Before', entry.beforeImageDataUrl], ['After', entry.afterImageDataUrl]].filter(([, src]) => src).map(([lbl, src]) => (
                    <div key={lbl}>
                      <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 600, color: NX.faint }}>{lbl}</div>
                      <button onClick={() => setPreview(src)} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', aspectRatio: '16 / 9',
                        overflow: 'hidden', borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface2, cursor: 'zoom-in', padding: 0,
                      }}>
                        <img src={src} alt={lbl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(entry.authorId || entry.developers?.length > 0 || entry.reviewerId || tags.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: twoCol, gap: 16, borderTop: `1px solid ${NX.border}`, paddingTop: 16 }}>
                <div style={{ display: 'flex', gap: 24 }}>
                  {entry.developers?.length > 0
                    ? <GithubDevelopers developers={entry.developers} />
                    : entry.authorId && <PersonInline label="Developer" email={entry.authorId} nameOf={nameOf} />}
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

        {tab === 'Overview' && status === 'Released' && (
          <div style={{ marginTop: 24, borderTop: `1px solid ${NX.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <FeedbackRow entry={entry} onDone={(msg) => flash(msg)} />
            <div><CopyLinkButton entryId={entry.id} label="Copy Link to This Update" onCopied={(ok) => flash(ok ? 'Link copied.' : 'Could not copy the link.', !ok)} /></div>
          </div>
        )}

        {tab === 'Technical Details' && (
          <div style={{ display: 'grid', gridTemplateColumns: twoCol, gap: isMobile ? 12 : 16 }}>
            {[['Category', entry.type], ['Version', entry.version], ['Environment', entry.environment], ['Released', formatDateTime(releasedKey(entry))], ['Work Item', entry.ticketRef || '-'], ['Pull Request', entry.prRef || '-'],
              ...(entry.scheduledFor ? [['Scheduled For', formatDateTime(entry.scheduledFor)]] : []),
              ['Audience', audienceWords(entry.audience)], ['Screen', entry.screen ? (MODULES.find((m) => m.id === entry.screen)?.label || entry.screen) : '-'],
              ['Live', stageOf(entry)?.label || '-'], ...(entry.prodAt ? [['Reached Production', formatDateTime(entry.prodAt)]] : []),
              ...(entry.deprecation?.removeOn ? [['Going Away', formatFullDate(entry.deprecation.removeOn)]] : []),
              ...(entry.tour?.length ? [['Guided Tour', plural(entry.tour.length, 'step')]] : [])].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>{k}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{v || '-'}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'Media' && files.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ ...label11, marginBottom: 8 }}>Attachments</h3>
            <AttachmentList attachments={files} />
          </div>
        )}
        {tab === 'Media' && (
          media.length === 0 ? (files.length > 0 ? null : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '56px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>
              <ImageIcon size={22} style={{ color: NX.faint }} />No media attached to this update.
            </div>
          )) : (
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

        {tab === 'Analytics' && isAdmin && <EntryAnalytics entryId={entry.id} nameOf={nameOf} />}

        {tab === 'History' && isAdmin && <HistoryList entryId={entry.id} nameOf={nameOf} />}

        {tab === 'Comments' && (
          <CommentThread entryId={entry.id} canComment={canComment} nameOf={nameOf} onCount={(n) => onCommented(entry.id, n)} />
        )}
      </div>

      {preview && (
        <Modal title={entry.title || 'Preview'} onClose={() => setPreview(null)} width={720}>
          <img src={preview} alt="" style={{ width: '100%', borderRadius: 8 }} />
        </Modal>
      )}
      {issueOpen && (
        <IssueDialog entry={entry} all={all} onClose={() => setIssueOpen(false)} flash={flash}
          onSaved={(saved) => saved && onEntryChanged?.(saved)} />
      )}
    </div>
  );
}

// Who saw one update and how they reacted (admins, Pranshu Oct 16 2026).
function EntryAnalytics({ entryId, nameOf }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    api.getTaskChangelogEntryAnalytics(entryId).then((d) => { if (live) setData(d || { viewers: [], reactions: [] }); })
      .catch(() => { if (live) setData({ viewers: [], reactions: [] }); });
    return () => { live = false; };
  }, [entryId]);
  if (!data) return <LoadingState />;
  const views = data.viewers.reduce((n, v) => n + (v.views || 0), 0);
  const byKind = REACTIONS.map((r) => ({ ...r, people: data.reactions.filter((x) => x.reaction === r.key) })).filter((r) => r.people.length);
  const label11 = { margin: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        {[['People Reached', data.viewers.length], ['Views', views], ['Reactions', data.reactions.length]].map(([k, v]) => (
          <div key={k} style={{ ...card, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint }}>{k}</div>
            <div style={{ marginTop: 2, fontSize: 20, fontWeight: 700, color: NX.ink }}>{v}</div>
          </div>
        ))}
      </div>
      <div>
        <h3 style={label11}>Reactions</h3>
        {byKind.length === 0 ? (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: NX.dim }}>No reactions yet.</p>
        ) : byKind.map((r) => (
          <div key={r.key} style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: NX.ink }}>
            <span aria-hidden style={{ fontSize: 15 }}>{r.emoji}</span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{r.label} ({r.people.length})</span>
            <span style={{ color: NX.dim }}>{r.people.map((p) => nameOf(p.email)).join(', ')}</span>
          </div>
        ))}
      </div>
      <div>
        <h3 style={label11}>Seen By</h3>
        {data.viewers.length === 0 ? (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: NX.dim }}>Nobody has seen it yet.</p>
        ) : (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.viewers.map((v) => (
              <div key={v.email} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <Avatar email={v.email} name={nameOf(v.email)} size={22} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: NX.ink }}>{nameOf(v.email)}</span>
                <span style={{ flexShrink: 0, fontSize: 12, color: NX.faint }}>{v.views} view{v.views === 1 ? '' : 's'} · last {formatDateTime(v.lastAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const audienceWords = (a) => {
  const mods = (a?.modules || []).map((m) => MODULES.find((x) => x.id === m)?.label || m);
  const comps = a?.companies || [];
  if (!mods.length && !comps.length) return 'Everyone';
  return [mods.length ? `People with ${mods.join(', ')}` : '', comps.length ? plural(comps.length, 'company', 'companies') : ''].filter(Boolean).join(' · ');
};

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

// Updates published from a merged PR name their developers as GitHub knows
// them (the PR author, then other commit authors) - never the Nexus user who
// ran the check or edited the entry.
function GithubDevelopers({ developers }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: NX.faint }}>{developers.length > 1 ? 'Developers' : 'Developer'}</div>
      {developers.map((d) => (
        <a key={d.login} href={d.url} target="_blank" rel="noreferrer" title={`@${d.login} on GitHub`}
          style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
          {/* `email` (set by the server for our own developers) brings the
              profile photo. card={false}: this sits inside a GitHub link, and
              the hover card's own click would open People on top of it. */}
          <Avatar email={d.email} name={d.name || d.login} size={24} card={false} />
          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{d.name || d.login}</span>
        </a>
      ))}
    </div>
  );
}

// ── Slide-over wrapper (ported from ChangelogSlideOver) ───────────────────────

// A left-edge swipe closes the phone update screen - unless it started on a
// field, a code block, a sideways strip, or anything already scrolled sideways.
function swipeBlocked(target, root) {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.matches?.('input, textarea, select, pre, [contenteditable="true"], .scroll-tabs')) return true;
    if (el.scrollLeft > 0 || el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return !(root && root.contains(target));   // touches from a portaled sheet
}

function SlideOver({ entry, nameOf, myEmail, isAdmin, onClose, onSetStatus, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  // On a phone this is a screen of its own, so the phone's Back closes it
  // rather than leaving What's New (the same hook the task sheets use).
  useBackToClose(isMobile, onClose);
  // Phones (Oct 28 2026): pinned to the part of the screen you can see, so
  // with the keyboard up the comment box sits above it, not behind it; it
  // slides in like a pushed screen, and a swipe in from the left edge goes
  // back, the way every other phone screen does.
  const vv = useVisualViewport(isMobile);
  const swipe = useRef(null);
  // The phone screen takes focus when it opens and hands it back on close.
  const pushRef = useRef(null);
  useDialogFocus(pushRef);
  if (isMobile) {
    return (
      <div ref={pushRef} tabIndex={-1} className="nx-wn-push" role="dialog" aria-modal="true" aria-label={entry.title}
        onTouchStart={(e) => {
          const t = e.touches[0];
          // Not from something that scrolls or takes text - a drag there is
          // scrolling the sub-tabs back or selecting, never Back.
          swipe.current = t && t.clientX < 28 && !swipeBlocked(e.target, e.currentTarget) ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const s0 = swipe.current; swipe.current = null;
          const t = e.changedTouches[0];
          if (s0 && t && t.clientX - s0.x > 80 && Math.abs(t.clientY - s0.y) < 60) onClose();
        }}
        style={{ position: 'fixed', left: 0, right: 0, zIndex: 3200, background: NX.surface, ...(vv ? { top: vv.top, height: vv.height, paddingBottom: vv.clear || 0, boxSizing: 'border-box' } : { top: 0, bottom: 0 }) }}>
        <DetailCard entry={entry} nameOf={nameOf} myEmail={myEmail} isAdmin={isAdmin}
          onClose={onClose} expanded onSetStatus={onSetStatus} onEdit={onEdit} />
      </div>
    );
  }
  return (
    <div onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 3200, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,0.4)' }}>
      <div style={{ height: '100%', width: expanded || isMobile ? '100%' : 'min(760px, 92vw)', transition: 'width 0.18s ease', boxShadow: isMobile ? 'none' : '-8px 0 40px rgba(0,0,0,0.28)' }}>
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
// Screenshots go to storage now (Oct 18 2026) - they used to ride inside the
// update as data: URLs, which every reader downloaded with the whole feed.
// With no storage configured (a laptop) the data: URL is still the fallback.
async function keepImage(file) {
  try { return (await uploadWhatsNewFile(file)) || await readFileAsDataUrl(file); } catch { return readFileAsDataUrl(file); }
}

function ScreenshotDropzone({ label, value, onChange }) {
  const onPaste = async (e) => { const [f] = filesFromPaste(e); if (f) { e.preventDefault(); onChange(await keepImage(f)); } };
  return (
    <div onPaste={onPaste} tabIndex={0}>
      <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 600, color: NX.faint }}>{label}</div>
      {value ? (
        <div style={{ position: 'relative' }}>
          <img src={value} alt={`${label} preview`} style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, border: `1px solid ${NX.border}` }} />
          <button onClick={() => onChange(undefined)} style={{ position: 'absolute', right: 8, top: 8, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '4px 8px', fontSize: 11, fontWeight: 600, fontFamily: FONT }}>Remove</button>
        </div>
      ) : (
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, aspectRatio: '16 / 9', cursor: 'pointer', borderRadius: 8, border: `1px dashed ${NX.border}`, textAlign: 'center', fontSize: 12, color: NX.dim }}>
          <Upload size={16} />Upload {label.toLowerCase()}
          <span style={{ fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await keepImage(f)); }} />
        </label>
      )}
    </div>
  );
}

// The form keeps "YYYY-MM-DDTHH:mm" in the browser's own time (a DateField
// and a 12-hour TimeField edit its two halves); the payload keeps an instant.
const toLocalInput = (iso) => {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v) => { const d = new Date(v || ''); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };

function AddUpdateModal({ entry, submitLabel, publishLabel, myEmail, onClose, onSave, isAdmin = false, allEntries = [] }) {
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
  // Oct 16 2026: release status and schedule, video, breaking change, where
  // it shows (pinned / hidden / the screen it changed / who it is for), and
  // the updates it relates to.
  const initialStatus = entry ? statusOf(entry) : 'Released';
  const [status, setStatusField] = useState(initialStatus);
  const [scheduledFor, setScheduledFor] = useState(toLocalInput(p.scheduledFor));
  const [videoUrl, setVideoUrl] = useState(p.videoUrl || '');
  const [breaking, setBreaking] = useState(!!p.breaking);
  const [actionRequired, setActionRequired] = useState(p.actionRequired || '');
  const [pinned, setPinned] = useState(!!p.pinned);
  const [hidden, setHidden] = useState(!!p.hidden);
  const [screen, setScreen] = useState(p.screen || '');
  const [audience, setAudience] = useState(p.audience || { modules: [], companies: [] });
  const [related, setRelated] = useState(p.relatedIds || []);
  const [relPick, setRelPick] = useState('');
  const [relKind, setRelKind] = useState('related');
  const [previewMd, setPreviewMd] = useState(false);
  // Oct 18 2026: more screenshots and files, a removal date, a guided tour.
  const [images, setImages] = useState(p.images || []);
  const [attachments, setAttachments] = useState(p.attachments || []);
  const [removeOn, setRemoveOn] = useState(p.deprecation?.removeOn || '');
  const [removeWhat, setRemoveWhat] = useState(p.deprecation?.what || '');
  const [replacement, setReplacement] = useState(p.deprecation?.replacement || '');
  const [tour, setTour] = useState(p.tour || []);
  const bump = useMemo(() => nextVersions(allEntries), [allEntries]);
  const relatable = allEntries.filter((x) => x.id !== entry?.id && !related.some((r) => r.id === x.id));
  const scheduleBad = status === 'Scheduled' && !(scheduledFor && new Date(scheduledFor).getTime() > Date.now());

  const canSave = title.trim() && description.trim() && module.trim() && version.trim() && !saving && !scheduleBad;
  const dirty = title !== (p.title || '') || description !== (p.description || '') || type !== (p.type || 'New Feature')
    || module !== (p.module || '') || version !== (p.version || '') || environment !== (p.environment || 'Production')
    || ticketRef !== (p.ticketRef || '') || reviewerId !== (p.reviewerId || '')
    || businessImpact !== (p.businessImpact || '') || userImpact !== (p.userImpact || '')
    || whatsChanged !== (p.whatsChanged || []).join('\n') || tags !== (p.tags || []).join(', ')
    || linkLabel !== (p.links?.[0]?.label || '') || linkUrl !== (p.links?.[0]?.url || '')
    || beforeImg !== p.beforeImageDataUrl || afterImg !== p.afterImageDataUrl
    || status !== initialStatus || scheduledFor !== toLocalInput(p.scheduledFor) || videoUrl !== (p.videoUrl || '')
    || breaking !== !!p.breaking || actionRequired !== (p.actionRequired || '') || pinned !== !!p.pinned || hidden !== !!p.hidden
    || screen !== (p.screen || '') || JSON.stringify(audience) !== JSON.stringify(p.audience || { modules: [], companies: [] })
    || JSON.stringify(related) !== JSON.stringify(p.relatedIds || [])
    || JSON.stringify(images) !== JSON.stringify(p.images || []) || JSON.stringify(attachments) !== JSON.stringify(p.attachments || [])
    || removeOn !== (p.deprecation?.removeOn || '') || removeWhat !== (p.deprecation?.what || '') || replacement !== (p.deprecation?.replacement || '')
    || JSON.stringify(tour) !== JSON.stringify(p.tour || []);

  // publish: save, then (re-)publish it - the release time moves to now.
  const save = async (publish = false) => {
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
      // An instant, not browser wall time: the server compares release times
      // across zones (the weekly bar, the update popup).
      releasedAt: p.releasedAt || new Date().toISOString(),
      // A PR's developers come from GitHub; editing its wording must not make
      // the editor its developer (that put Neil on every update).
      authorId: p.authorId || (p.origin === 'pr' ? '' : myEmail),
      reviewerId: reviewerId || undefined,
      ticketRef: ticketRef.trim() || undefined,
      businessImpact: businessImpact.trim() || undefined,
      userImpact: userImpact.trim() || undefined,
      whatsChanged: whatsChanged.split('\n').map((l) => l.trim()).filter(Boolean),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      links: linkLabel.trim() && linkUrl.trim() ? [{ label: linkLabel.trim(), url: linkUrl.trim() }] : undefined,
      beforeImageDataUrl: beforeImg,
      afterImageDataUrl: afterImg,
      videoUrl: videoUrl.trim() || undefined,
      breaking: breaking || undefined,
      actionRequired: actionRequired.trim() || undefined,
      screen: screen || undefined,
      audience: (audience.modules?.length || audience.companies?.length) ? audience : undefined,
      relatedIds: related.length ? related : undefined,
      images: images.length ? images : undefined,
      attachments: attachments.length ? attachments : undefined,
      deprecation: removeOn ? { removeOn, what: removeWhat.trim(), replacement: replacement.trim() } : undefined,
      tour: tour.filter((st) => (st.title || '').trim() || (st.body || '').trim()).length
        ? tour.filter((st) => (st.title || '').trim() || (st.body || '').trim()) : undefined,
      ...(isAdmin ? {
        status,
        scheduledFor: status === 'Scheduled' ? fromLocalInput(scheduledFor) : undefined,
        pinned: pinned || undefined,
        pinnedAt: pinned ? (p.pinnedAt || new Date().toISOString()) : undefined,
        hidden: hidden || undefined,
      } : {}),
    };
    try { await onSave(payload, { publish }); onClose(); } catch { setSaving(false); }
  };

  const footer = (
    <>
      <button onClick={onClose} style={btn('outline')}>Cancel</button>
      {publishLabel ? (<>
        <button onClick={() => save(false)} disabled={!canSave} style={{ ...btn('outline'), opacity: canSave ? 1 : 0.5 }}>{submitLabel || 'Save Changes'}</button>
        <button onClick={() => save(true)} disabled={!canSave} style={{ ...btn('primary'), opacity: canSave ? 1 : 0.5 }}><Send size={13} />{publishLabel}</button>
      </>) : (
        <button onClick={() => save(false)} disabled={!canSave} style={{ ...btn('primary'), opacity: canSave ? 1 : 0.5 }}>{submitLabel || (entry ? 'Save Changes' : 'Publish Update')}</button>
      )}
    </>
  );

  return (
    <Modal title={entry ? 'Edit Update' : 'Add New Update'} onClose={onClose} footer={footer}
      isDirty={dirty} onSave={canSave ? () => save(false) : undefined}>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fixed leave balance calculation" style={inputStyle} />
      </Field>
      <Field label="Description" hint="Write it in plain English - this is what everyone will read. Markdown works: **bold**, - lists, [links](https://…).">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -22, marginBottom: 4 }}>
          <button type="button" onClick={() => setPreviewMd((v) => !v)} style={{ ...btn('ghost'), padding: 0, fontSize: 12, color: NX.blue }}>{previewMd ? 'Edit' : 'Preview'}</button>
        </div>
        {previewMd
          ? <div style={{ ...inputStyle, minHeight: 96, height: 'auto' }}><RichText text={description || '_Nothing yet._'} /></div>
          : <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="What changed, and why it matters to the people using it." style={{ ...inputStyle, resize: 'vertical' }} />}
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
          {/* The next numbers after the highest vX.Y.Z so far. */}
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['Patch', bump.patch], ['Minor', bump.minor], ['Major', bump.major]].map(([k, v]) => (
              <button key={k} type="button" onClick={() => setVersion(v)} title={`Next ${k.toLowerCase()} version`}
                style={{ ...btn('outline'), padding: '2px 8px', fontSize: 11.5 }}>{k} {v}</button>
            ))}
          </div>
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

      {isAdmin && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatusField(e.target.value)} aria-label="Status" style={{ ...inputStyle, cursor: 'pointer' }}>
              {(entry ? STATUSES : ['Released', 'Scheduled', 'Draft']).map((x) => <option key={x} value={x}>{x === 'Released' && !entry ? 'Publish Now' : x}</option>)}
            </select>
          </Field>
          {status === 'Scheduled' ? (
            <Field label="Goes Out On" hint={scheduleBad ? 'Pick a time in the future.' : 'It publishes itself then - the bell and the weekly bar follow.'}>
              {/* A date box and a 12-hour time box, never a native
                  datetime-local (it follows the computer's region). */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <DateField value={(scheduledFor || '').slice(0, 10)} noPast title="Scheduled for" placeholder="Pick a date"
                  onChange={(d) => setScheduledFor(d ? `${d}T${(scheduledFor || '').slice(11, 16) || '09:00'}` : '')}
                  style={{ ...inputStyle, flex: 1, minWidth: 0, cursor: 'pointer' }} />
                <TimeField value={(scheduledFor || '').slice(11, 16)} ariaLabel="Scheduled time"
                  onChange={(t) => setScheduledFor(`${(scheduledFor || '').slice(0, 10) || localTodayISO()}T${t}`)}
                  style={{ width: 128, flexShrink: 0 }} />
              </div>
            </Field>
          ) : (
            <Field label="Show">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginTop: 6 }}><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />Pin to the top</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginTop: 4 }}><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />Hide from readers (internal only)</label>
            </Field>
          )}
        </div>
      )}

      <Field label="Breaking change or action required (optional)">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={breaking} onChange={(e) => setBreaking(e.target.checked)} />This is a breaking change
        </label>
        <input value={actionRequired} onChange={(e) => setActionRequired(e.target.value)} placeholder="e.g. Re-sign your timecards from 10/01 onward" aria-label="Action required" style={inputStyle} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Demo video (optional)" hint="YouTube, Vimeo or Loom link, or a video file in Nexus storage. A GIF goes in Screenshots.">
          <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://www.loom.com/share/…" aria-label="Demo video" style={inputStyle} />
        </Field>
        <Field label="Screen it changed (optional)" hint="People opening that screen see a New on This Screen card.">
          <select value={screen} onChange={(e) => setScreen(e.target.value)} aria-label="Screen it changed" style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">None</option>
            {MODULES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Who it is for (optional)">
        <AudiencePicker value={audience} onChange={setAudience} />
      </Field>

      <Field label="Related updates (optional)">
        {related.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {related.map((r) => {
              const other = allEntries.find((x) => x.id === r.id);
              return (
                <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, border: `1px solid ${NX.border}`, padding: '3px 6px 3px 10px', fontSize: 12 }}>
                  <strong style={{ color: NX.faint }}>{RELATION_LABELS[r.kind] || 'Related'}</strong>{other?.title || 'Removed update'}
                  <button type="button" aria-label={`Remove ${other?.title || 'link'}`} onClick={() => setRelated((x) => x.filter((y) => y.id !== r.id))} style={{ ...btn('ghost'), padding: 2 }}><X size={12} /></button>
                </span>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={relKind} onChange={(e) => setRelKind(e.target.value)} aria-label="Relation" style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
            {Object.entries(RELATION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={relPick} onChange={(e) => setRelPick(e.target.value)} aria-label="Related update" style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">Pick an update…</option>
            {relatable.slice(0, 200).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
          <button type="button" disabled={!relPick} onClick={() => { setRelated((x) => [...x, { id: relPick, kind: relKind }]); setRelPick(''); }}
            style={{ ...btn('outline'), opacity: relPick ? 1 : 0.5 }}>Add</button>
        </div>
      </Field>

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

      <div style={{ marginBottom: 14 }}>
        <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 600, color: NX.dim }}>Screenshots (optional)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ScreenshotDropzone label="Before" value={beforeImg} onChange={setBeforeImg} />
          <ScreenshotDropzone label="After" value={afterImg} onChange={setAfterImg} />
        </div>
      </div>

      <Field label="More screenshots and files (optional)" hint="Up to 12 pictures and 10 files (PDFs, guides, spreadsheets), 25 MB each.">
        <MediaEditor images={images} onImages={setImages} attachments={attachments} onAttachments={setAttachments} />
      </Field>

      <Field label="Going away (optional)" hint="For something being removed: a countdown shows on the update and its screen, and the bell reminds people 7 days and 1 day before.">
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: 8 }}>
          <DateField value={removeOn || null} onChange={(v) => setRemoveOn(v || '')} placeholder="MM/DD/YYYY" title="Removal date"
            style={{ ...inputStyle, display: 'inline-flex' }} />
          <input value={removeWhat} onChange={(e) => setRemoveWhat(e.target.value)} placeholder="What goes away, e.g. The Old Payroll Export" aria-label="What goes away" style={inputStyle} />
          <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Use instead, e.g. Payroll > Export" aria-label="Use instead" style={inputStyle} />
        </div>
      </Field>

      <Field label="Guided tour (optional)" hint="Steps people can click through on the screen this update changed. Point at something with a CSS selector, or leave it empty for a step in the middle of the screen.">
        <TourEditor value={tour} onChange={setTour} />
      </Field>
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
