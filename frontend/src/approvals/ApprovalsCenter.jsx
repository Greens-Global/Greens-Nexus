// Dashboard > Approvals (Pranshu, Oct 30 2026): the Approvals screen rebuilt
// as a Dashboard tab. Everything waiting on the signed-in person's decision,
// across modules (Neil, Oct 27 2026 - the one-screen rule), in two parts:
//
//   Approvals     other people's requests the person RULES on (scope "decide")
//   Yours To Do   the person's own items (scope "act": sign, accept, a swap)
//
// The rows come from GET /approvals/inbox (backend/approvals_inbox.py, the
// registry the sidebar counts read). Each inline action calls the module's
// EXISTING endpoint (lib/approvalActions.js); a row that needs more than one
// click opens the item in its module. Nothing here is a second approval path.
// A decision the module accepted is then recorded (POST /approvals/decided)
// so the person has a History and the health strip can say "decided today".
//
// What is new here (vs the Oct 27 screen): a health strip (waiting, urgent,
// over 3 days, decided this week) whose tiles filter the list; a rail that
// counts by kind, by department and by company (HR and administrators see
// every department - Pranshu: group it so they can check it); group-by
// sections; a detail panel beside the list on a wide screen (a popup on a
// phone); a History tab; keyboard triage (J / K move, A approve, R reject,
// Enter review, O open). Undo, bulk approve and the Review facts carry over.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, ArrowUpRight, Users, Search, Inbox, Flame, Hourglass, History, ListChecks, Building2, Layers, UserRound, Keyboard, X } from 'lucide-react';
import { PrioritySignal, StatusLabel } from '../components/StatusLabel';
import { useTableValue } from '../tasks/tableCols';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { ForChip } from '../components/DelegateApprovals';
import { NAV } from '../components/Sidebar';
import { Avatar, Modal } from '../tasks/components';
import { dialog } from '../ui/dialog';
import { formatDate, formatDateTime } from '../lib/datetime';
import { openNotificationTarget } from '../lib/openTarget';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { useIsMobile } from '../lib/useIsMobile';
import { UNDO_MS, bulkAction, doneWord, runApproval, runsInline, waited } from '../lib/approvalActions';

const NO_KEYS = new Set(['reject', 'decline', 'deny', 'no']);
const actClass = (a) => (a.tone === 'primary' ? 'primary-btn apv-btn apv-yes'
  : NO_KEYS.has(a.key) ? 'apv-btn apv-no' : 'secondary-btn apv-btn');
const POLL_MS = 60000;
const BULK_MAX = 50;   // one Approve Selected at a time (Workday caps at 100, Kore at 50) - a slip never clears a hundred

const DEFAULT_GROUPS = [
  { key: 'timeoff', label: 'Time Off' }, { key: 'timesheets', label: 'Time Sheets' },
  { key: 'shifts', label: 'Shifts' }, { key: 'money', label: 'Money' },
  { key: 'hiring', label: 'Hiring' }, { key: 'signatures', label: 'Signatures' },
  { key: 'people', label: 'People' }, { key: 'work', label: 'Work' }, { key: 'equipment', label: 'Equipment' },
  { key: 'access', label: 'Access' }, { key: 'workflows', label: 'Workflows' },
];
const NOTE_ASK = {
  reject: { title: 'Reject', message: 'Sent to them with the decision.', placeholder: 'Reason (optional)' },
  decline: { title: 'Decline', message: 'Sent to them with the decision.', placeholder: 'Reason (optional)' },
  send_back: { title: 'Send Back', message: 'Say what needs to change - they see this note.', placeholder: 'What needs to change' },
  yes: { title: 'Vote Yes', message: 'Say why - it goes on the candidate\'s notes in Hiring.', placeholder: 'Why yes' },
  no: { title: 'Vote No', message: 'Say why - it goes on the candidate\'s notes in Hiring.', placeholder: 'Why no' },
};

export function go(link) {
  if (!link?.view) return;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: link.view, sub: link.sub ?? null } }));
  openNotificationTarget(link);
}

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const SORTS = [
  { key: 'oldest', label: 'Oldest First' }, { key: 'newest', label: 'Newest First' },
  { key: 'priority', label: 'Priority' }, { key: 'person', label: 'Name (A-Z)' }, { key: 'kind', label: 'Kind' },
];
const PRIORITY_FILTERS = [
  { key: 'all', label: 'All Priorities' }, { key: 'urgent', label: 'Urgent' },
  { key: 'high', label: 'High And Up' }, { key: 'medium', label: 'Medium' }, { key: 'low', label: 'Low' },
];
// How the list is sectioned (Pranshu, 10/30/2026: HR and Global Admins see
// everything, so let them see it by department).
const GROUP_BYS = [
  { key: 'kind', label: 'Kind', Icon: Layers }, { key: 'department', label: 'Department', Icon: Users },
  { key: 'company', label: 'Company', Icon: Building2 }, { key: 'person', label: 'Person', Icon: UserRound },
  { key: 'none', label: 'No Grouping', Icon: ListChecks },
];
const when = (r) => r.createdAt || '9999';
const SORTERS = {
  oldest: (a, b) => when(a).localeCompare(when(b)),
  newest: (a, b) => when(b).localeCompare(when(a)),
  priority: (a, b) => ((PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)) || when(a).localeCompare(when(b)),
  person: (a, b) => (a.person?.name || '~').localeCompare(b.person?.name || '~') || when(a).localeCompare(when(b)),
  kind: (a, b) => (a.group || '').localeCompare(b.group || '') || when(a).localeCompare(when(b)),
};
const matchesPriority = (r, f) => f === 'all' || (f === 'high' ? (PRIORITY_RANK[r.priority] ?? 2) <= 1 : (r.priority || 'medium') === f);
const daysWaiting = (r) => {
  if (!r.createdAt) return 0;
  const d = (Date.now() - new Date(r.createdAt).getTime()) / 86400e3;
  return Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 0;
};
export const fullName = (person) => {
  const name = String(person?.name || '').trim();
  return name.includes('@') ? name.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : name;
};
const moduleName = (link) => NAV.find((n) => n.view === link?.view)?.label || '';
const ACTION_WORD = { approve: 'Approved', reject: 'Rejected', decline: 'Declined', accept: 'Accepted', send_back: 'Sent Back',
  yes: 'Voted Yes', no: 'Voted No', deny: 'Denied', changes: 'Changes Requested' };
const ACTION_COLOR = { approve: '#16a34a', accept: '#16a34a', yes: '#16a34a', reject: '#dc2626', decline: '#dc2626', deny: '#dc2626', no: '#dc2626' };

// `activeSub` is the Dashboard sub after "approvals": '' | '<group>' | 'history'.
export default function ApprovalsCenter({ activeSub = '', onSubChange }) {
  const phone = useIsMobile('(max-width: 760px)');
  const wide = !useIsMobile('(max-width: 1180px)');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [reviewing, setReviewing] = useState(null);
  const [sortKey, setSortKey] = useTableValue('approvals-inbox', 'sort', 'oldest');
  const [groupBy, setGroupBy] = useTableValue('approvals-inbox', 'groupBy', '');
  const [prioFilter, setPrioFilter] = useState('all');
  const [ageFilter, setAgeFilter] = useState(0);              // 0 | 3 | 7 days waiting at least
  const [query, setQuery] = useState('');
  const [dept, setDept] = useState('');                        // rail: one department
  const [company, setCompany] = useState('');                  // rail: one company
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [focusKey, setFocusKey] = useState('');                // keyboard cursor
  const [history, setHistory] = useState(null);
  const [showKeys, setShowKeys] = useState(false);
  const pending = useRef(new Map());
  const settled = useRef(new Map());
  const toastTimer = useRef(null);
  const reloadTimer = useRef(null);
  const mounted = useRef(true);
  const listRef = useRef(null);

  const tab = activeSub === 'history' ? 'history' : 'waiting';
  const groupLabels = data?.groupLabels?.length ? data.groupLabels : DEFAULT_GROUPS;
  const kind = groupLabels.some((g) => g.key === activeSub) ? activeSub : 'all';
  const setKind = (k) => onSubChange?.(k === 'all' ? '' : k);
  const setTab = (t) => onSubChange?.(t === 'history' ? 'history' : '');

  const load = useCallback(() => {
    const began = Date.now();
    return api.approvalsInbox()
      .then((d) => {
        if (!mounted.current) return;
        setData(d || {});
        setError(false);
        const done = [...settled.current].filter(([, at]) => at <= began).map(([k]) => k);
        if (done.length) {
          done.forEach((k) => settled.current.delete(k));
          setHidden((h) => { const n = new Set(h); done.forEach((k) => { if (!pending.current.has(k)) n.delete(k); }); return n; });
        }
      })
      .catch(() => { if (mounted.current) setError(true); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, []);
  const loadHistory = useCallback(() => api.approvalsHistory(30).then((h) => { if (mounted.current) setHistory(h || { rows: [] }); }).catch(() => { if (mounted.current) setHistory({ rows: [], failed: true }); }), []);

  useEffect(() => { load(); loadHistory(); return pollWhileVisible(load, POLL_MS); }, [load, loadHistory]);

  const say = useCallback((t) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    if (t) toastTimer.current = setTimeout(() => setToast((cur) => (cur === t ? null : cur)), t.kind === 'undo' ? UNDO_MS : t.kind === 'error' ? 7000 : 4500);
  }, []);
  const hide = (key, on) => setHidden((h) => { const n = new Set(h); if (on) n.add(key); else n.delete(key); return n; });
  const reloadSoon = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => { load(); loadHistory(); }, 900); };

  const commit = useCallback(async (key) => {
    const p = pending.current.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(key);
    let opts = {};
    for (;;) {
      try {
        const res = await runApproval(p.row, p.action.key, p.note, opts);
        settled.current.set(key, Date.now());
        // The decider's own record of what they did here - never the module's truth.
        api.approvalsDecided?.({ kind: p.row.kind, id: p.row.id, group: p.row.group, action: p.action.key, note: p.note || '', title: p.row.title,
          personEmail: p.row.person?.email || '', personName: p.row.person?.name || '', department: p.row.department || '',
          company: p.row.company || '', createdAt: p.row.createdAt || '', forEmail: p.row.forEmail || '' })?.catch?.(() => {});
        const left = p.row.kind === 'time_off' && p.action.key === 'approve' ? (res?.conflicts || []).length : 0;
        if (left && mounted.current) {
          say({ kind: 'ok', msg: `Time off approved. ${left} shared shift${left === 1 ? '' : 's'} inside it still stand${left === 1 ? 's' : ''} - remove ${left === 1 ? 'it' : 'them'} in Team > Requests.`, link: { view: 'shifts', sub: 'requests' } });
        }
      } catch (e) {
        if (mounted.current && p.row.kind === 'shift_request' && p.action.key === 'approve' && e?.status === 409 && !opts.force) {
          const ok = await dialog.confirm(`${e.message} Approve anyway?`, { title: 'Approve With A Conflict', confirmText: 'Approve Anyway' });
          if (ok) { opts = { force: true }; continue; }
          hide(key, false);
        } else if (mounted.current) {
          hide(key, false);
          say({ kind: 'error', msg: e?.message || "Couldn't save that decision. Try again, or open it in its module.", link: p.row.link });
        }
      }
      break;
    }
    if (mounted.current) reloadSoon();
  }, [say]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mounted.current = true;
    const flush = () => { [...pending.current.keys()].forEach((k) => commit(k)); };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      mounted.current = false;
      clearTimeout(toastTimer.current);
      clearTimeout(reloadTimer.current);
      flush();
    };
  }, [commit]);

  function queue(row, action, note) {
    hide(row.key, true);
    const timer = setTimeout(() => commit(row.key), UNDO_MS);
    pending.current.set(row.key, { row, action, note, timer });
  }

  async function decide(row, action) {
    if (action.key === 'open' || !runsInline(row, action.key)) { go(row.link); return; }
    let note = '';
    if (action.note && action.note !== 'none') {
      const ask = NOTE_ASK[action.key] || { title: action.label, message: '', placeholder: 'Note' };
      const required = action.note === 'required';
      const v = await dialog.prompt(ask.message, { title: `${ask.title}: ${row.title}`, placeholder: ask.placeholder, confirmText: action.label, required, multiline: true, danger: action.key === 'reject' });
      if (v === null || v === undefined) return;
      note = String(v).trim();
      if (required && !note) return;
    }
    queue(row, action, note);
    setReviewing((cur) => (cur?.key === row.key ? null : cur));
    setSelected((s) => { if (!s.has(row.key)) return s; const n = new Set(s); n.delete(row.key); return n; });
    const who = fullName(row.person);
    say({ kind: 'undo', keys: [row.key], msg: `${doneWord(action.key)}: ${who ? `${who} - ` : ''}${row.title}` });
  }

  async function decideSelected() {
    const batch = picked.slice(0, BULK_MAX);
    if (!batch.length) return;
    if (batch.length > 1) {
      const ok = await dialog.confirm(`Approve ${batch.length} requests together? Each goes to its module as your decision; you have ${Math.round(UNDO_MS / 1000)} seconds to undo.`, { title: 'Approve Selected', confirmText: `Approve ${batch.length}` });
      if (!ok) return;
    }
    batch.forEach((r) => queue(r, bulkAction(r), ''));
    setSelected(new Set());
    say({ kind: 'undo', keys: batch.map((r) => r.key), msg: `Approved ${batch.length} ${batch.length === 1 ? 'request' : 'requests'}` });
  }

  function undo(keys) {
    let any = false;
    (keys || []).forEach((key) => {
      const p = pending.current.get(key);
      if (!p) return;
      clearTimeout(p.timer);
      pending.current.delete(key);
      hide(key, false);
      any = true;
    });
    if (any) say(null);
  }

  // ── the lists ────────────────────────────────────────────────────────────
  const rows = useMemo(() => (data?.rows || []).filter((r) => !hidden.has(r.key)), [data, hidden]);
  const decideRows = useMemo(() => rows.filter((r) => r.scope !== 'act'), [rows]);
  const actRows = useMemo(() => rows.filter((r) => r.scope === 'act'), [rows]);
  const who = data?.who || {};
  const seesAll = !!(who.isHr || who.isAdmin);
  const effectiveGroupBy = groupBy || (seesAll ? 'department' : 'kind');
  const counts = useMemo(() => {
    const c = { all: 0 };
    decideRows.forEach((r) => { const n = r.count || 1; c.all += n; c[r.group] = (c[r.group] || 0) + n; });
    return c;
  }, [decideRows]);
  const deptCounts = useMemo(() => tally(decideRows, (r) => r.department || 'No Department'), [decideRows]);
  const companyCounts = useMemo(() => tally(decideRows, (r) => r.companyName || 'No Company'), [decideRows]);
  const q = query.trim().toLowerCase();
  const passes = (r) => (kind === 'all' || r.group === kind)
    && matchesPriority(r, prioFilter)
    && (!ageFilter || daysWaiting(r) >= ageFilter)
    && (!dept || (r.department || 'No Department') === dept)
    && (!company || (r.companyName || 'No Company') === company)
    && (!q || [r.person?.name, r.title, r.detail, r.forName, r.department].some((s) => (s || '').toLowerCase().includes(q)));
  const shown = useMemo(() => decideRows.filter(passes).sort(SORTERS[sortKey] || SORTERS.oldest), [decideRows, kind, prioFilter, ageFilter, dept, company, q, sortKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const shownAct = useMemo(() => actRows.filter((r) => matchesPriority(r, prioFilter) && (!q || [r.person?.name, r.title, r.detail].some((s) => (s || '').toLowerCase().includes(q)))).sort(SORTERS[sortKey] || SORTERS.oldest), [actRows, prioFilter, q, sortKey]);
  const sections = useMemo(() => sectionize(shown, effectiveGroupBy, groupLabels), [shown, effectiveGroupBy, groupLabels]);
  const filtering = prioFilter !== 'all' || !!q || !!ageFilter || !!dept || !!company;
  const clearFilters = () => { setPrioFilter('all'); setQuery(''); setAgeFilter(0); setDept(''); setCompany(''); };
  const labelOf = (g) => groupLabels.find((x) => x.key === g)?.label || '';
  const bulkable = shown.filter((r) => bulkAction(r));
  const picked = bulkable.filter((r) => selected.has(r.key));
  const allPicked = bulkable.length > 0 && picked.length === bulkable.length;
  const toggle = (key) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(bulkable.map((r) => r.key)));
  const errors = data?.errors || [];
  const aging = data?.aging || {};
  const urgent = decideRows.filter((r) => r.priority === 'urgent').reduce((t, r) => t + (r.count || 1), 0);
  const ordered = useMemo(() => [...sections.flatMap((s) => (collapsed.has(s.key) ? [] : s.rows)), ...shownAct], [sections, collapsed, shownAct]);
  const focused = ordered.find((r) => r.key === focusKey) || null;
  const detailRow = reviewing || (wide ? focused : null);

  // ── keyboard triage (J / K move, A approve, R reject, Enter review, O open, ? keys) ──
  useEffect(() => {
    const onKey = (e) => {
      if (tab !== 'waiting' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('[role=dialog]') && !reviewing) return;
      const i = ordered.findIndex((r) => r.key === focusKey);
      const move = (d) => { const n = ordered[Math.min(ordered.length - 1, Math.max(0, (i < 0 ? (d > 0 ? -1 : 0) : i) + d))]; if (n) { setFocusKey(n.key); listRef.current?.querySelector(`[data-key="${CSS.escape(n.key)}"]`)?.scrollIntoView({ block: 'nearest' }); } };
      const cur = ordered[i];
      const key = e.key.toLowerCase();
      if (key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (key === '?') { setShowKeys((v) => !v); }
      else if (!cur) return;
      else if (key === 'a') { const a = (cur.actions || []).find((x) => x.tone === 'primary' && runsInline(cur, x.key)); if (a) { e.preventDefault(); decide(cur, a); } }
      else if (key === 'r') { const a = (cur.actions || []).find((x) => NO_KEYS.has(x.key) && runsInline(cur, x.key)); if (a) { e.preventDefault(); decide(cur, a); } }
      else if (key === 'o') { e.preventDefault(); go(cur.link); }
      else if (e.key === 'Enter') { e.preventDefault(); setReviewing(cur); }
      else if (e.key === 'Escape') { setReviewing(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const Tile = ({ label, n, Icon, tone, on, onClick, hint }) => (
    <button type="button" className={`apv-tile${on ? ' is-on' : ''}`} data-tone={tone} onClick={onClick} aria-pressed={on} title={hint}>
      <span className="apv-tile-ic"><Icon size={16} /></span>
      <span className="apv-tile-n">{n}</span>
      <span className="apv-tile-l">{label}</span>
    </button>
  );

  const header = (
    <div className="apv-head">
      <div className="apv-tabs" role="tablist" aria-label="Approvals views">
        <button type="button" role="tab" aria-selected={tab === 'waiting'} className={tab === 'waiting' ? 'is-on' : ''} onClick={() => setTab('waiting')}><Inbox size={14} /> Waiting{data ? <b>{counts.all + shownAct.reduce((t, r) => t + (r.count || 1), 0)}</b> : null}</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-on' : ''} onClick={() => setTab('history')}><History size={14} /> History</button>
      </div>
      <div className="apv-tiles">
        <Tile label="Waiting On You" n={counts.all} Icon={Inbox} tone="brand" on={!ageFilter && prioFilter === 'all' && tab === 'waiting'} onClick={() => { setTab('waiting'); clearFilters(); }} hint="Everything you decide" />
        <Tile label="Urgent" n={urgent} Icon={Flame} tone="red" on={prioFilter === 'urgent'} onClick={() => { setTab('waiting'); setPrioFilter(prioFilter === 'urgent' ? 'all' : 'urgent'); }} hint="Due tomorrow or sooner, or the module says urgent" />
        <Tile label="Over 3 Days" n={aging.over3 || 0} Icon={Hourglass} tone="amber" on={ageFilter === 3} onClick={() => { setTab('waiting'); setAgeFilter(ageFilter === 3 ? 0 : 3); }} hint="Waiting three days or more - first come, first served" />
        <Tile label="Decided This Week" n={history?.decidedWeek || 0} Icon={CheckCircle2} tone="green" on={tab === 'history'} onClick={() => setTab('history')} hint="What you decided here in the last 7 days" />
      </div>
    </div>
  );

  if (tab === 'history') {
    return (
      <div className="apv-center">
        {header}
        <HistoryList history={history} onReload={loadHistory} />
      </div>
    );
  }

  const rail = (
    <aside className="apv-rail" aria-label="Approval filters">
      <RailGroup title="By Kind">
        <RailItem on={kind === 'all'} n={counts.all} onClick={() => setKind('all')}>All</RailItem>
        {groupLabels.filter((g) => counts[g.key] || g.key === kind).map((g) => (
          <RailItem key={g.key} on={kind === g.key} n={counts[g.key] || 0} onClick={() => setKind(kind === g.key ? 'all' : g.key)}>{g.label}</RailItem>
        ))}
      </RailGroup>
      {(seesAll || deptCounts.length > 1) && (
        <RailGroup title="By Department">
          {deptCounts.map(([name, n]) => <RailItem key={name} on={dept === name} n={n} onClick={() => setDept(dept === name ? '' : name)}>{name}</RailItem>)}
        </RailGroup>
      )}
      {companyCounts.length > 1 && (
        <RailGroup title="By Company">
          {companyCounts.map(([name, n]) => <RailItem key={name} on={company === name} n={n} onClick={() => setCompany(company === name ? '' : name)}>{name}</RailItem>)}
        </RailGroup>
      )}
    </aside>
  );

  const list = (
    <div className="apv-main" ref={listRef}>
      <div className="apv-tools">
        <div className="apv-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" className="form-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, request, detail or department" aria-label="Search approvals" />
        </div>
        <label>Group by
          <select className="form-select" value={effectiveGroupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label="Group approvals by">
            {GROUP_BYS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </label>
        <label>Priority
          <select className="form-select" value={prioFilter} onChange={(e) => setPrioFilter(e.target.value)} aria-label="Filter by priority">
            {PRIORITY_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
        <label>Sort
          <select className="form-select" value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort approvals">
            {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        {!phone && <button type="button" className="apv-keys-btn" onClick={() => setShowKeys(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Keyboard size={15} /></button>}
      </div>
      {(dept || company || ageFilter > 0) && (
        <div className="apv-active-filters">
          {dept && <StatusLabel label={`Department: ${dept}`} color="#2563eb" size="sm" />}
          {company && <StatusLabel label={`Company: ${company}`} color="#7c3aed" size="sm" />}
          {ageFilter > 0 && <StatusLabel label={`Waiting ${ageFilter}+ days`} color="#d97706" size="sm" />}
          <button type="button" className="apv-link" onClick={clearFilters}>Clear</button>
        </div>
      )}
      {errors.length > 0 && (
        <div role="status" className="apv-errors">
          {errors.map((e) => <span key={e.source}>{`Couldn't load ${e.label}.`}</span>)}
          <button type="button" className="apv-link" onClick={() => load()}>Try Again</button>
        </div>
      )}
      <AsyncSection loading={loading && !data} error={error && !data} onRetry={() => { setLoading(true); load(); }}
        errorMessage="Your approvals couldn't be loaded right now - please try again."
        isEmpty={!shown.length && !shownAct.length}
        skeleton={<SkeletonBlocks count={4} height={64} borderRadius={10} />}
        emptyContent={
          <div className="apv-empty">
            <CheckCircle2 size={30} style={{ color: 'hsl(var(--color-green))' }} />
            <div className="apv-empty-t">{filtering ? 'No approvals match your filters' : kind === 'all' ? 'Nothing waiting on you' : `Nothing in ${labelOf(kind)} waiting on you`}</div>
            <div className="apv-empty-d">{filtering ? 'Clear the search or the filters to see everything waiting on you.' : who.canApprove ? 'Every approval in Nexus that needs your decision shows up here - time off, time sheets, money, tasks, tickets, equipment, hiring and documents.' : 'Anything that needs your signature or acceptance will show up here.'}</div>
            {filtering && <button type="button" className="secondary-btn" onClick={clearFilters} style={{ marginTop: 14 }}>Clear Filters</button>}
          </div>
        }>
        {shown.length > 0 && (
          <section className="apv-card" aria-label="Approvals">
            {bulkable.length > 0 && (
              <div className="apv-bar">
                <input type="checkbox" checked={allPicked} aria-label="Select every request that can be approved in one click"
                  ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked; }} onChange={toggleAll} />
                <span>{picked.length ? `${picked.length} selected${picked.length > BULK_MAX ? ` - ${BULK_MAX} at a time` : ''}` : 'Select requests to approve them together.'}</span>
                <button type="button" className="primary-btn" disabled={!picked.length} onClick={decideSelected}>Approve Selected{picked.length ? ` (${Math.min(picked.length, BULK_MAX)})` : ''}</button>
              </div>
            )}
            {sections.map((s) => (
              <div key={s.key} className="apv-section">
                {effectiveGroupBy !== 'none' && (
                  <button type="button" className="apv-section-h" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })} aria-expanded={!collapsed.has(s.key)}>
                    <ChevronRight size={14} className={`apv-chev${collapsed.has(s.key) ? '' : ' is-open'}`} />
                    <span>{s.label}</span>
                    <b>{s.rows.reduce((t, r) => t + (r.count || 1), 0)}</b>
                    {s.oldest >= 3 && <StatusLabel label={`Oldest ${s.oldest}d`} color={s.oldest >= 7 ? '#dc2626' : '#d97706'} size="sm" />}
                  </button>
                )}
                {!collapsed.has(s.key) && s.rows.map((r) => (
                  <Row key={r.key} row={r} onAct={decide} onReview={() => setReviewing(r)} focused={focusKey === r.key} onFocus={() => setFocusKey(r.key)}
                    selectable={!!bulkAction(r)} selected={selected.has(r.key)} onToggle={() => toggle(r.key)} showDept={effectiveGroupBy !== 'department' && seesAll} />
                ))}
              </div>
            ))}
          </section>
        )}
        {shownAct.length > 0 && (
          <section className="apv-card apv-own" aria-label="Yours To Do">
            <div className="apv-section-h is-static"><ListChecks size={14} /><span>Yours To Do</span><b>{shownAct.reduce((t, r) => t + (r.count || 1), 0)}</b><em>Things only you can do - sign, accept, answer.</em></div>
            {shownAct.map((r) => (
              <Row key={r.key} row={r} onAct={decide} onReview={() => setReviewing(r)} focused={focusKey === r.key} onFocus={() => setFocusKey(r.key)} selectable={false} selected={false} onToggle={() => {}} own />
            ))}
          </section>
        )}
      </AsyncSection>
    </div>
  );

  return (
    <div className="apv-center" data-group-by={effectiveGroupBy}>
      {header}
      <div className={`apv-body${wide ? ' is-wide' : ''}`}>
        {!phone && rail}
        {list}
        {wide && (
          <aside className="apv-detail-col" aria-label="Request details">
            {detailRow ? (
              <Detail row={detailRow} kindLabel={labelOf(detailRow.group)} onClose={() => { setReviewing(null); setFocusKey(''); }}
                onAct={(a) => { if (a.key === 'open' || !runsInline(detailRow, a.key)) setReviewing(null); decide(detailRow, a); }} />
            ) : (
              <div className="apv-detail-empty"><Inbox size={22} /><div>Pick a request to read it here.</div><small>J / K move, A approve, R reject, Enter review, O open in its module.</small></div>
            )}
          </aside>
        )}
      </div>
      {reviewing && !wide && (
        <Modal title={reviewing.title} onClose={() => setReviewing(null)}>
          <Detail row={reviewing} kindLabel={labelOf(reviewing.group)} inModal onClose={() => setReviewing(null)}
            onAct={(a) => { if (a.key === 'open' || !runsInline(reviewing, a.key)) setReviewing(null); decide(reviewing, a); }} />
        </Modal>
      )}
      {showKeys && (
        <Modal title="Keyboard Shortcuts" onClose={() => setShowKeys(false)} minHeight="auto" footer={<button type="button" className="secondary-btn" onClick={() => setShowKeys(false)}>Close</button>}>
          <div className="apv-keys">
            {[['J', 'Next request'], ['K', 'Previous request'], ['A', 'Approve the focused request'], ['R', 'Reject or decline it'], ['Enter', 'Review it'], ['O', 'Open it in its module'], ['Esc', 'Close the review'], ['?', 'This list']].map(([k, d]) => (
              <div key={k}><kbd>{k}</kbd><span>{d}</span></div>
            ))}
            <p>Shortcuts pause while you type in a box.</p>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="status" aria-live="polite" className={`apv-toast${toast.kind === 'error' ? ' is-error' : ''}`}>
          <span>{toast.msg}</span>
          {toast.kind === 'undo' && <button type="button" className="apv-toast-undo" onClick={() => undo(toast.keys)}>Undo</button>}
          {toast.kind !== 'undo' && toast.link?.view && <button type="button" className="apv-toast-open" onClick={() => { go(toast.link); say(null); }}>Open</button>}
        </div>
      )}
    </div>
  );
}

function tally(rows, keyOf) {
  const m = new Map();
  rows.forEach((r) => m.set(keyOf(r), (m.get(keyOf(r)) || 0) + (r.count || 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sectionize(rows, by, groupLabels) {
  if (by === 'none') return [{ key: 'all', label: '', rows, oldest: 0 }];
  const keyOf = by === 'department' ? (r) => r.department || 'No Department'
    : by === 'company' ? (r) => r.companyName || 'No Company'
      : by === 'person' ? (r) => fullName(r.person) || 'Your Team'
        : (r) => r.group || '';
  const labelOfKey = by === 'kind' ? (k) => groupLabels.find((g) => g.key === k)?.label || k : (k) => k;
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  // Sections keep the order the chosen sort gave their first row, so "Priority"
  // or "Newest" still reads top to bottom across sections.
  return [...m.entries()].map(([k, rs]) => ({ key: k, label: labelOfKey(k), rows: rs, oldest: Math.max(0, ...rs.map(daysWaiting)) }));
}

function RailGroup({ title, children }) {
  return <div className="apv-rail-g"><div className="apv-rail-t">{title}</div>{children}</div>;
}
function RailItem({ on, n, onClick, children }) {
  return <button type="button" role="tab" aria-selected={on} className={`apv-rail-i${on ? ' is-on' : ''}`} onClick={onClick}><span>{children}</span><b>{n}</b></button>;
}

function PersonMark({ person, size }) {
  if (person?.email) return <Avatar email={person.email} name={person.name} size={size} />;
  return <span aria-hidden="true" className="apv-mark" style={{ width: size, height: size }}><Users size={Math.round(size * 0.5)} /></span>;
}

function Row({ row, onAct, onReview, selectable, selected, onToggle, focused, onFocus, showDept, own }) {
  const who = fullName(row.person);
  const inline = (row.actions || []).filter((a) => a.key !== 'open' && runsInline(row, a.key));
  const days = daysWaiting(row);
  return (
    <div className={`apv-row nx-row-hover${focused ? ' is-focused' : ''}`} data-key={row.key} data-kind={row.kind} data-priority={row.priority || undefined} onMouseDown={onFocus}>
      <div className="apv-pick">{selectable && <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${row.title}${who ? ` (${who})` : ''}`} />}</div>
      <div className="apv-who" title={row.person?.name || ''}>
        <PersonMark person={row.person} size={32} />
        <span className="apv-who-t">
          <span className="apv-name">{who || (own ? 'You' : '-')}</span>
          {(showDept && row.department) || row.personTitle ? <span className="apv-sub">{[row.personTitle, showDept ? row.department : ''].filter(Boolean).join(' · ')}</span> : null}
        </span>
      </div>
      <div className="apv-what">
        <button type="button" className="apv-title" onClick={onReview} title="Review the details">
          <span>{row.title}</span><ChevronRight size={13} />
        </button>
        {(row.detail || row.forName) && <div className="apv-detail">{row.detail}{row.forName && <ForChip name={row.forName} />}</div>}
      </div>
      <div className="apv-prio">{row.priority && <PrioritySignal priority={row.priority} />}</div>
      <div className={`apv-age${days >= 7 ? ' is-late' : days >= 3 ? ' is-slow' : ''}`} title={row.createdAt ? formatDateTime(row.createdAt) : ''}>{waited(row.createdAt)}</div>
      <div className="apv-act">
        <button type="button" className="apv-btn apv-review" onClick={onReview} aria-label={`Review: ${row.title}${who ? ` (${who})` : ''}`}>Review</button>
        {inline.map((a) => <button key={a.key} type="button" className={actClass(a)} aria-label={`${a.label}: ${row.title}${who ? ` (${who})` : ''}`} onClick={() => onAct(row, a)}>{a.label}</button>)}
      </div>
    </div>
  );
}

// The whole request: who, every fact the module gave, how long it waited, the
// decision buttons, and the way to the item in its module. Lives in the side
// column on a wide screen and in the Modal otherwise.
export function Detail({ row, kindLabel, onClose, onAct, inModal = false }) {
  const person = row.person || {};
  const mod = moduleName(row.link);
  const inline = (row.actions || []).filter((a) => a.key !== 'open' && runsInline(row, a.key));
  const step = (row.actions || []).find((a) => a.key === 'open' || !runsInline(row, a.key));
  const openLabel = step && step.label && !/^(open|review)$/i.test(step.label) ? step.label : mod ? `Open In ${mod}` : 'Open It In Its Module';
  const facts = row.facts || [];
  const days = daysWaiting(row);
  return (
    <div className={`apv-detail-card${inModal ? ' in-modal' : ''}`}>
      {!inModal && (
        <div className="apv-detail-top">
          <span className="apv-detail-kind">{kindLabel || 'Request'}{row.scope === 'act' ? ' · Yours To Do' : ''}</span>
          <button type="button" className="apv-x" onClick={onClose} aria-label="Close details"><X size={15} /></button>
        </div>
      )}
      <div className="apv-detail-who">
        <PersonMark person={person} size={46} />
        <div>
          <div className="apv-detail-name">{person.name || 'Your Team'}{row.forName && <ForChip name={row.forName} />}</div>
          <div className="apv-detail-meta">{[row.personTitle, row.department && row.department !== 'No Department' ? row.department : '', row.companyName && row.companyName !== 'No Company' ? row.companyName : ''].filter(Boolean).join(' · ') || person.email}</div>
        </div>
      </div>
      {!inModal && <h3 className="apv-detail-title">{row.title}</h3>}
      <div className="apv-detail-wait">
        {row.priority && <PrioritySignal priority={row.priority} />}
        {row.createdAt && <span title={formatDateTime(row.createdAt)}>Waiting {waited(row.createdAt)}{days >= 3 ? ` (${days} days)` : ''}</span>}
        {row.due && <span>Matters by {formatDate(row.due)}</span>}
      </div>
      {row.detail && <p className="apv-detail-text">{row.detail}</p>}
      {facts.length > 0 ? (
        <div className="apv-facts nx-fill">{facts.map((f) => [<div key={`${f.label}:l`}>{f.label}</div>, <div key={`${f.label}:v`}>{f.value}</div>])}</div>
      ) : !row.detail ? <div className="apv-detail-text nx-fill" style={{ color: 'var(--muted)' }}>{mod ? `The full request is in ${mod}.` : 'The full request is in its module.'}</div> : <div className="nx-fill" />}
      <div className="apv-foot">
        {row.link?.view && <button type="button" className={`${inline.length ? 'apv-btn apv-review' : 'primary-btn'} apv-open`} onClick={() => { onClose?.(); go(row.link); }}>{openLabel} <ArrowUpRight size={14} /></button>}
        <span style={{ flex: 1 }} />
        {inline.slice().reverse().map((a) => <button key={a.key} type="button" className={actClass(a)} onClick={() => onAct(a)}>{a.label}</button>)}
      </div>
    </div>
  );
}

function HistoryList({ history, onReload }) {
  if (!history) return <SkeletonBlocks count={4} height={56} borderRadius={10} />;
  const rows = history.rows || [];
  return (
    <section className="apv-card apv-history" aria-label="Decisions you made here">
      <div className="apv-section-h is-static"><History size={14} /><span>Decided Here - Last {history.days || 30} Days</span><b>{rows.length}</b>
        <em>{history.avgWaitDays ? `Requests had waited ${history.avgWaitDays} days on average when you decided.` : ''}</em>
        <button type="button" className="apv-link" onClick={onReload}>Refresh</button>
      </div>
      {history.failed && <div className="apv-errors"><span>Your history could not be loaded.</span></div>}
      {!rows.length && !history.failed && <div className="apv-empty"><History size={26} style={{ color: 'var(--muted)' }} /><div className="apv-empty-t">Nothing decided here yet</div><div className="apv-empty-d">Decisions you make from this screen are listed here with when and how long they had waited. Each module keeps its own record too.</div></div>}
      {rows.map((r) => (
        <div key={r.id} className="apv-hrow">
          <PersonMark person={r.person} size={30} />
          <div className="apv-hwhat">
            <div className="apv-htitle">{r.title || r.kind}</div>
            <div className="apv-detail">{[fullName(r.person), r.groupLabel, r.department].filter(Boolean).join(' · ')}{r.note ? ` - "${r.note}"` : ''}</div>
          </div>
          <StatusLabel label={ACTION_WORD[r.action] || r.action} color={ACTION_COLOR[r.action] || '#64748b'} size="sm" />
          <div className="apv-hwhen" title={formatDateTime(r.decidedAt)}>{formatDateTime(r.decidedAt)}<span>{r.waitedDays ? ` · waited ${r.waitedDays}d` : ''}</span></div>
        </div>
      ))}
    </section>
  );
}
