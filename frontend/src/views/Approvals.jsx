// Approvals (Neil, Oct 27 2026): one screen listing everything waiting on the
// signed-in person's decision, across modules - time off, punch fixes, time
// sheets to review or sign, reimbursements, purchase requests, shift
// requests, hiring votes and Nexus Sign documents.
//
// The rows come from GET /approvals/inbox (backend/approvals_inbox.py, the
// same registry the sidebar's "waiting on you" counts read). Each inline
// action calls the module's EXISTING endpoint (lib/approvalActions.js); a row
// that needs more than one click opens the item in its module. Nothing here
// is a second approval path.
//
// Oldest waiting first by default: an approval queue is first come, first
// served, and the one waiting longest is the one most likely to be late. The
// person can sort by priority, newest, name or kind and filter by priority or
// a search (Neil, 10/28/2026); `priority` is the server's (approvals_inbox
// `_priority`: the module's own, raised by a close date or a long wait).
//
// A decision leaves the list at once and is sent after a short Undo window
// (UNDO_MS) - the module endpoints cannot be undone once called, so the undo
// is the wait. Leaving the screen sends whatever is still waiting. A refusal
// brings the row back with the module's own message.
//
// Neil, 10/28/2026: "easy for anyone to clear the approvals", a profile
// picture by every name, and a Review on every row that shows the detail and
// takes them to the item. So each row has the person's photo, a Review that
// opens the full request (its `facts`, the decision buttons, and Open In
// <module> for the item itself), and a checkbox: rows whose yes is one click
// can be approved together, with the same single Undo.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, RefreshCw, CheckCircle2, ChevronRight, ArrowUpRight, Users, Search } from 'lucide-react';
import { PrioritySignal } from '../components/StatusLabel';
import { useTableValue } from '../tasks/tableCols';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { ForChip } from '../components/DelegateApprovals';
import { NAV } from '../components/Sidebar';
import { Avatar, Modal } from '../tasks/components';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { openNotificationTarget } from '../lib/openTarget';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { UNDO_MS, bulkAction, doneWord, runApproval, runsInline, waited } from '../lib/approvalActions';

// How each decision button looks (Neil, 10/29/2026: "reject should be red
// background, Review should be grey background"): the yes is the primary,
// a no (Reject, Decline, Deny, No) is solid red, Review is filled grey and
// anything else (Send Back, Request Changes) stays the plain secondary.
const NO_KEYS = new Set(['reject', 'decline', 'deny', 'no']);
const actClass = (a) => (a.tone === 'primary' ? 'primary-btn apv-btn apv-yes'
  : NO_KEYS.has(a.key) ? 'apv-btn apv-no' : 'secondary-btn apv-btn');

const FONT = 'Inter, sans-serif';
const POLL_MS = 60000;

// The chips when the server sends none (an API still deploying).
const DEFAULT_GROUPS = [
  { key: 'timeoff', label: 'Time Off' }, { key: 'timesheets', label: 'Time Sheets' },
  { key: 'shifts', label: 'Shifts' }, { key: 'money', label: 'Money' },
  { key: 'hiring', label: 'Hiring' }, { key: 'signatures', label: 'Signatures' },
  { key: 'people', label: 'People' },
];

// What the note box asks, per action.
const NOTE_ASK = {
  reject: { title: 'Reject', message: 'Sent to them with the decision.', placeholder: 'Reason (optional)' },
  decline: { title: 'Decline', message: 'Sent to them with the decision.', placeholder: 'Reason (optional)' },
  send_back: { title: 'Send Back', message: 'Say what needs to change - they see this note.', placeholder: 'What needs to change' },
  yes: { title: 'Vote Yes', message: 'Say why - it goes on the candidate\'s notes in Hiring.', placeholder: 'Why yes' },
  no: { title: 'Vote No', message: 'Say why - it goes on the candidate\'s notes in Hiring.', placeholder: 'Why no' },
};

function go(link) {
  if (!link?.view) return;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: link.view, sub: link.sub ?? null } }));
  openNotificationTarget(link);
}

// Sorts and filters (Neil, 10/28/2026: "allow a sort by priority ... add
// sorts and filters"). The person's choice follows them (their table prefs).
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const SORTS = [
  { key: 'oldest', label: 'Oldest First' },
  { key: 'newest', label: 'Newest First' },
  { key: 'priority', label: 'Priority' },
  { key: 'person', label: 'Name (A-Z)' },
  { key: 'kind', label: 'Kind' },
];
const PRIORITY_FILTERS = [
  { key: 'all', label: 'All Priorities' },
  { key: 'urgent', label: 'Urgent' },
  { key: 'high', label: 'High And Up' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];
const when = (r) => r.createdAt || '9999';
const SORTERS = {
  oldest: (a, b) => when(a).localeCompare(when(b)),
  newest: (a, b) => when(b).localeCompare(when(a)),
  priority: (a, b) => ((PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)) || when(a).localeCompare(when(b)),
  person: (a, b) => (a.person?.name || '~').localeCompare(b.person?.name || '~') || when(a).localeCompare(when(b)),
  kind: (a, b) => (a.group || '').localeCompare(b.group || '') || when(a).localeCompare(when(b)),
};
const matchesPriority = (r, f) => f === 'all' || (f === 'high'
  ? (PRIORITY_RANK[r.priority] ?? 2) <= 1 : (r.priority || 'medium') === f);

// The whole name (Neil, 10/28/2026) - never "Priya S."; a bare address reads
// as the name in it.
const fullName = (person) => {
  const name = String(person?.name || '').trim();
  return name.includes('@') ? name.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : name;
};

// "Open In Team" - the module's name as the left menu shows it.
const moduleName = (link) => NAV.find((n) => n.view === link?.view)?.label || '';

export default function Approvals({ activeSub, onSubChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());   // keys decided here, waiting out the Undo window or the reload
  const [toast, setToast] = useState(null);                 // { kind: 'undo' | 'ok' | 'error', msg, keys?, link? }
  const [selected, setSelected] = useState(() => new Set()); // keys checked for Approve Selected
  const [reviewing, setReviewing] = useState(null);         // the row whose Review panel is open
  const [sortKey, setSortKey] = useTableValue('approvals-inbox', 'sort', 'oldest');
  const [prioFilter, setPrioFilter] = useState('all');
  const [query, setQuery] = useState('');
  const pending = useRef(new Map());                        // key -> { row, action, note, timer }
  const settled = useRef(new Map());                        // key -> when it was sent; un-hidden by a load begun after that (a claim can come back for HR)
  const toastTimer = useRef(null);
  const reloadTimer = useRef(null);
  const mounted = useRef(true);
  const group = DEFAULT_GROUPS.some((g) => g.key === activeSub) || (data?.groupLabels || []).some((g) => g.key === activeSub)
    ? activeSub : 'all';
  const setGroup = (k) => onSubChange?.(k === 'all' ? null : k);

  const load = useCallback(() => {
    const began = Date.now();
    return api.approvalsInbox()
      .then((d) => {
        if (!mounted.current) return;
        setData(d || {});
        setError(false);
        // Only a list read AFTER a decision was sent may show its row again;
        // one already on its way back still has the row in it.
        const done = [...settled.current].filter(([, at]) => at <= began).map(([k]) => k);
        if (done.length) {
          done.forEach((k) => settled.current.delete(k));
          setHidden((h) => { const n = new Set(h); done.forEach((k) => { if (!pending.current.has(k)) n.delete(k); }); return n; });
        }
      })
      .catch(() => { if (mounted.current) setError(true); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, []);

  useEffect(() => { load(); return pollWhileVisible(load, POLL_MS); }, [load]);

  const say = useCallback((t) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    if (t) toastTimer.current = setTimeout(() => setToast((cur) => (cur === t ? null : cur)), t.kind === 'undo' ? UNDO_MS : t.kind === 'error' ? 7000 : 4500);
  }, []);

  const hide = (key, on) => setHidden((h) => { const n = new Set(h); if (on) n.add(key); else n.delete(key); return n; });
  const reloadSoon = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 900); };

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
        // Approving leave over shared shifts keeps them unless asked (Team >
        // Requests offers the removal) - say so rather than leave it unseen.
        const left = p.row.kind === 'time_off' && p.action.key === 'approve' ? (res?.conflicts || []).length : 0;
        if (left && mounted.current) {
          say({ kind: 'ok', msg: `Time off approved. ${left} shared shift${left === 1 ? '' : 's'} inside it still stand${left === 1 ? 's' : ''} - remove ${left === 1 ? 'it' : 'them'} in Team > Requests.`, link: { view: 'shifts', sub: 'requests' } });
        }
      } catch (e) {
        // The new owner of a shift would clash (the module's own 409): ask,
        // as Team > Requests does, then approve over it.
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

  // Leaving the screen (or the page) sends every decision still in its Undo
  // window - a decision made is never dropped.
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

  // Queue one decision: off the list now, sent when the Undo window closes.
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
      const v = await dialog.prompt(ask.message, {
        title: `${ask.title}: ${row.title}`, placeholder: ask.placeholder, confirmText: action.label,
        required, multiline: true, danger: action.key === 'reject',
      });
      if (v === null || v === undefined) return;   // cancelled - nothing is decided
      note = String(v).trim();
      if (required && !note) return;
    }
    queue(row, action, note);
    setReviewing((cur) => (cur?.key === row.key ? null : cur));
    setSelected((s) => { if (!s.has(row.key)) return s; const n = new Set(s); n.delete(row.key); return n; });
    const who = fullName(row.person);
    say({ kind: 'undo', keys: [row.key], msg: `${doneWord(action.key)}: ${who ? `${who} - ` : ''}${row.title}` });
  }

  // Approve Selected: every checked row's one-click yes, one Undo for all.
  function decideSelected() {
    // Only what is on screen: a row a filter hides is never approved unseen.
    const batch = picked.slice();
    if (!batch.length) return;
    batch.forEach((r) => queue(r, bulkAction(r), ''));
    setSelected(new Set());
    say({ kind: 'undo', keys: batch.map((r) => r.key),
      msg: `Approved ${batch.length} ${batch.length === 1 ? 'request' : 'requests'}` });
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

  const groupLabels = data?.groupLabels?.length ? data.groupLabels : DEFAULT_GROUPS;
  const rows = useMemo(() => (data?.rows || []).filter((r) => !hidden.has(r.key)), [data, hidden]);
  const counts = useMemo(() => {
    const c = { all: 0 };
    rows.forEach((r) => { const n = r.count || 1; c.all += n; c[r.group] = (c[r.group] || 0) + n; });
    return c;
  }, [rows]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => rows
    .filter((r) => group === 'all' || r.group === group)
    .filter((r) => matchesPriority(r, prioFilter))
    .filter((r) => !q || [r.person?.name, r.title, r.detail, r.forName].some((s) => (s || '').toLowerCase().includes(q)))
    .sort(SORTERS[sortKey] || SORTERS.oldest), [rows, group, prioFilter, q, sortKey]);
  const filtering = prioFilter !== 'all' || !!q;
  const clearFilters = () => { setPrioFilter('all'); setQuery(''); };
  const chips = [{ key: 'all', label: 'All' }, ...groupLabels.filter((g) => counts[g.key] || g.key === group)];
  const errors = data?.errors || [];
  const groupName = groupLabels.find((g) => g.key === group)?.label || '';
  const labelOf = (g) => groupLabels.find((x) => x.key === g)?.label || '';
  // Approve Selected covers what is on screen: switching chips never approves
  // a row the person cannot see.
  const bulkable = shown.filter((r) => bulkAction(r));
  const picked = bulkable.filter((r) => selected.has(r.key));
  const allPicked = bulkable.length > 0 && picked.length === bulkable.length;
  const toggle = (key) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(bulkable.map((r) => r.key)));

  return (
    <div style={{ fontFamily: FONT, color: 'var(--ink)', maxWidth: 1080, margin: '0 auto', padding: '4px 0 48px' }}>
      <style>{`
        .apv-row { display: grid; grid-template-columns: 20px minmax(150px, 220px) minmax(0, 1fr) 92px 76px auto; grid-template-areas: "pick who what prio age act";
          gap: 6px 14px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--card); }
        .apv-row:first-child { border-top: none; }
        .apv-list > .apv-row:nth-child(even) { background: var(--nx-zebra); }
        .apv-prio { grid-area: prio; font-size: 12.5px; }
        .apv-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .apv-search { position: relative; flex: 1 1 260px; min-width: 200px; }
        .apv-search input { width: 100%; padding-left: 32px; }
        .apv-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
        .apv-tools label { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
        .apv-tools select { width: auto; min-width: 150px; }
        .apv-pick { grid-area: pick; display: flex; align-items: center; }
        .apv-pick input, .apv-bar input { width: 16px; height: 16px; margin: 0; accent-color: var(--wk-brand); cursor: pointer; }
        .apv-who { grid-area: who; min-width: 0; display: flex; align-items: center; gap: 10px; }
        .apv-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--surface-2, var(--card)); }
        .apv-facts { display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); border-top: 1px solid var(--line); }
        .apv-facts > div { padding: 11px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; line-height: 1.5; }
        .apv-facts > div:nth-child(odd) { color: var(--muted); padding-right: 16px; }
        .apv-facts > div:nth-child(even) { color: var(--ink); font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }
        .apv-what { grid-area: what; min-width: 0; }
        .apv-age { grid-area: age; text-align: right; }
        .apv-act { grid-area: act; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
        .apv-title { background: none; border: none; padding: 0; margin: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
        .apv-title:hover { text-decoration: underline; }
        .apv-act button { font-size: 12.5px; padding: 6px 12px; white-space: nowrap; }
        .apv-name { font-size: 13.5px; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .apv-title { font-size: 13.5px; font-weight: 600; line-height: 1.35; display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
        .apv-detail { font-size: 12.5px; color: var(--muted); margin-top: 2px; line-height: 1.4; overflow-wrap: anywhere; }
        /* Reject and Review are not primary-btn / secondary-btn, so they get
           the same box here (the Review panel's footer included). */
        .apv-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 8px; }
        .apv-no, .apv-review { padding: 7px 14px; font-size: 13px; line-height: 1.3; white-space: nowrap; }
        .apv-no { background: var(--apv-red, #dc2626); color: #fff; border: 1px solid var(--apv-red, #dc2626); font-family: inherit; font-weight: 600; cursor: pointer; }
        .apv-no:hover:not(:disabled) { filter: brightness(.92); }
        .apv-review { background: color-mix(in srgb, var(--ink) 9%, var(--card)); color: var(--ink); border: 1px solid transparent; font-family: inherit; font-weight: 600; cursor: pointer; }
        .apv-review:hover:not(:disabled) { background: color-mix(in srgb, var(--ink) 14%, var(--card)); }
        .apv-no:focus-visible, .apv-review:focus-visible { outline: 2px solid var(--wk-brand, #2b45e1); outline-offset: 2px; }
        @media (max-width: 720px) {
          /* A phone card (Neil, 10/29/2026): who and the priority on top,
             what they asked, how long it has waited, then a full-width row
             of 44px decision buttons. High and Urgent carry a colored rule
             down the left edge and a tinted priority label. */
          .apv-row { grid-template-columns: 22px minmax(0, 1fr) auto; grid-template-areas: "pick who prio" ". what what" ". age age" "act act act";
            gap: 8px 10px; align-items: start; padding: 14px 16px; }
          .apv-row[data-priority="urgent"] { box-shadow: inset 4px 0 0 #dc2626; }
          .apv-row[data-priority="high"] { box-shadow: inset 4px 0 0 #d97706; }
          .apv-who, .apv-pick { min-height: 30px; }
          .apv-pick input { width: 20px; height: 20px; }
          .apv-name { font-size: 15px; }
          .apv-title { font-size: 15px; }
          .apv-detail { font-size: 13.5px; }
          .apv-age { text-align: left; font-size: 12.5px !important; }
          .apv-prio { align-self: center; }
          .apv-prio .nx-prio { font-size: 13px; padding: 4px 10px; border-radius: 999px; background: color-mix(in srgb, var(--c) 13%, transparent); }
          .apv-prio .nx-prio-loud { font-weight: 700; }
          /* Priority and Sort side by side, each label over a full-width
             44px box; 16px text so iOS does not zoom in on a tap. */
          .apv-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
          .apv-search { grid-column: 1 / -1; min-width: 0; }
          .apv-search input { font-size: 16px; min-height: 44px; }
          .apv-tools label { flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; }
          .apv-tools select { width: 100%; min-width: 0; min-height: 44px; font-size: 16px; }
          .apv-facts { grid-template-columns: minmax(0, 1fr); }
          .apv-facts > div:nth-child(odd) { border-bottom: none; padding-bottom: 0; }
          /* Up to three decisions share a row; a fourth (Request Changes)
             wraps to its own full-width line instead of spilling over. */
          .apv-act { justify-content: stretch; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
          .apv-act button { flex: 1 1 92px; min-width: 0; min-height: 44px; padding: 0 10px; font-size: 14px; border-radius: 10px;
            overflow: hidden; text-overflow: ellipsis; }
          .apv-foot { flex-wrap: wrap; }
          .apv-foot > span { display: none; }
          .apv-foot button { flex: 1 1 92px; min-width: 0; min-height: 44px; justify-content: center; font-size: 14px; border-radius: 10px; }
          .apv-foot .apv-open { flex-basis: 100%; }
        }
      `}</style>

      <div className="view-header" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Inbox size={19} />
          </span>
          <div className="view-title-group">
            <h2>Approvals</h2>
            <p>Everything waiting on your decision, across Nexus.</p>
          </div>
        </div>
        <button type="button" className="secondary-btn" onClick={() => { setLoading(!data); load(); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="scroll-tabs" role="tablist" aria-label="Approval kinds"
        style={{ display: 'flex', gap: 8, marginBottom: 14, paddingBottom: 2 }}>
        {chips.map((c) => {
          const on = group === c.key;
          const n = counts[c.key] || 0;
          return (
            <button key={c.key} type="button" role="tab" aria-selected={on} onClick={() => setGroup(c.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 13px', borderRadius: 999,
                border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--line)'}`, background: on ? 'var(--wk-brand-tint)' : 'var(--card)',
                color: on ? 'var(--wk-brand)' : 'var(--ink)', fontFamily: FONT, fontSize: 13, fontWeight: on ? 700 : 600,
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {c.label}
              {data && <span style={{ fontSize: 12, fontWeight: 700, color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {(rows.length > 0 || filtering) && (
        <div className="apv-tools">
          <div className="apv-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" className="form-input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, request or detail" aria-label="Search approvals" />
          </div>
          <label>
            Priority
            <select className="form-select" value={prioFilter} onChange={(e) => setPrioFilter(e.target.value)} aria-label="Filter by priority">
              {PRIORITY_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
          <label>
            Sort
            <select className="form-select" value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort approvals">
              {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
        </div>
      )}

      {errors.length > 0 && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {errors.map((e) => <span key={e.source}>{`Couldn't load ${e.label}.`}</span>)}
          <button type="button" onClick={() => load()} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--wk-brand)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: FONT }}>
            Try Again
          </button>
        </div>
      )}

      <AsyncSection
        loading={loading && !data}
        error={error && !data}
        onRetry={() => { setLoading(true); load(); }}
        errorMessage="Your approvals couldn't be loaded right now - please try again."
        isEmpty={!shown.length}
        skeleton={<SkeletonBlocks count={4} height={64} borderRadius={10} />}
        emptyContent={
          <div style={{ padding: '48px 20px', textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 12, background: 'var(--card)' }}>
            <CheckCircle2 size={30} style={{ color: 'hsl(var(--color-green))' }} />
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>
              {filtering ? 'No approvals match your filters' : group === 'all' ? 'Nothing waiting on you' : `Nothing in ${groupName} waiting on you`}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              {filtering
                ? 'Clear the search or the priority filter to see everything waiting on you.'
                : 'Every approval in Nexus that needs your decision shows up here - time off, time sheets, money, tasks, tickets, equipment, hiring and documents.'}
            </div>
            {filtering && (
              <button type="button" className="secondary-btn" onClick={clearFilters} style={{ marginTop: 14 }}>Clear Filters</button>
            )}
          </div>
        }
      >
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          {bulkable.length > 0 && (
            <div className="apv-bar">
              <input type="checkbox" checked={allPicked} aria-label="Select every request that can be approved in one click"
                ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked; }} onChange={toggleAll} />
              <span style={{ fontSize: 13, color: 'var(--muted)', flex: 1, minWidth: 0 }}>
                {picked.length ? `${picked.length} selected` : 'Select requests to approve them together.'}
              </span>
              <button type="button" className="primary-btn" disabled={!picked.length} onClick={decideSelected}
                style={{ fontSize: 12.5, padding: '6px 14px', whiteSpace: 'nowrap' }}>
                Approve Selected{picked.length ? ` (${picked.length})` : ''}
              </button>
            </div>
          )}
          <div className="apv-list">
            {shown.map((r) => (
              <Row key={r.key} row={r} onAct={decide} onReview={() => setReviewing(r)}
                selectable={!!bulkAction(r)} selected={selected.has(r.key)} onToggle={() => toggle(r.key)} />
            ))}
          </div>
        </div>
      </AsyncSection>

      {reviewing && (
        <ReviewPanel row={reviewing} kindLabel={labelOf(reviewing.group)} onClose={() => setReviewing(null)}
          onAct={(a) => { if (a.key === 'open' || !runsInline(reviewing, a.key)) setReviewing(null); decide(reviewing, a); }} />
      )}

      {toast && (
        <div role="status" aria-live="polite"
          style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1300, maxWidth: 'min(640px, calc(100vw - 32px))',
            display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px 10px 18px', borderRadius: 10, boxShadow: 'var(--shadow-lg)',
            background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'var(--ink)', color: toast.kind === 'error' ? '#fff' : 'var(--paper)',
            fontSize: 13, fontWeight: 600, fontFamily: FONT }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{toast.msg}</span>
          {toast.kind === 'undo' && (
            <button type="button" onClick={() => undo(toast.keys)}
              style={{ background: 'none', border: 'none', color: 'hsl(var(--color-green))', fontWeight: 800, fontSize: 13, cursor: 'pointer', padding: '2px 4px', fontFamily: FONT }}>
              Undo
            </button>
          )}
          {toast.kind !== 'undo' && toast.link?.view && (
            <button type="button" onClick={() => { go(toast.link); say(null); }}
              style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', fontWeight: 700, fontSize: 13, cursor: 'pointer', padding: '2px 4px', fontFamily: FONT, whiteSpace: 'nowrap' }}>
              Open
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The person's photo (the shared Avatar: their Nexus photo, else initials).
// A row about a team, a role or a workflow subject has no one person, so it
// gets a plain group mark instead of made-up initials.
function PersonMark({ person, size }) {
  if (person?.email) return <Avatar email={person.email} name={person.name} size={size} />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', background: 'var(--line)', color: 'var(--muted)' }}>
      <Users size={Math.round(size * 0.5)} />
    </span>
  );
}

function Row({ row, onAct, onReview, selectable, selected, onToggle }) {
  const who = fullName(row.person);
  // Decisions run here; a step that opens the module lives in Review, so a
  // row never shows two buttons that both read "Review".
  const inline = (row.actions || []).filter((a) => a.key !== 'open' && runsInline(row, a.key));
  return (
    <div className="apv-row nx-row-hover" data-kind={row.kind} data-priority={row.priority || undefined}>
      <div className="apv-pick">
        {selectable && (
          <input type="checkbox" checked={selected} onChange={onToggle}
            aria-label={`Select ${row.title}${who ? ` (${who})` : ''}`} />
        )}
      </div>
      <div className="apv-who" title={row.person?.name || ''}>
        <PersonMark person={row.person} size={30} />
        <span className="apv-name">{who || '-'}</span>
      </div>
      <div className="apv-what">
        <button type="button" className="apv-title" onClick={onReview} title="Review the details">
          <span style={{ overflowWrap: 'anywhere' }}>{row.title}</span>
          <ChevronRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        </button>
        {(row.detail || row.forName) && (
          <div className="apv-detail">
            {row.detail}
            {row.forName && <ForChip name={row.forName} />}
          </div>
        )}
      </div>
      <div className="apv-prio">
        {row.priority && <PrioritySignal priority={row.priority} />}
      </div>
      <div className="apv-age" title={row.createdAt ? formatDateTime(row.createdAt) : ''}
        style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        {waited(row.createdAt)}
      </div>
      <div className="apv-act">
        <button type="button" className="apv-btn apv-review" onClick={onReview}
          aria-label={`Review: ${row.title}${who ? ` (${who})` : ''}`}>
          Review
        </button>
        {inline.map((a) => (
          <button key={a.key} type="button" className={actClass(a)}
            aria-label={`${a.label}: ${row.title}${who ? ` (${who})` : ''}`} onClick={() => onAct(row, a)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Review (Neil, 10/28/2026): the whole request - who, what, every detail the
// module gave (`facts`), how long it has waited - with the decision buttons,
// and the way to the item itself in its module.
function ReviewPanel({ row, kindLabel, onClose, onAct }) {
  const person = row.person || {};
  const mod = moduleName(row.link);
  const inline = (row.actions || []).filter((a) => a.key !== 'open' && runsInline(row, a.key));
  // A row whose next step happens in the module ("Review & Sign", "Pay Out")
  // keeps its own words on that button.
  const step = (row.actions || []).find((a) => a.key === 'open' || !runsInline(row, a.key));
  const openLabel = step && step.label && !/^(open|review)$/i.test(step.label)
    ? step.label : mod ? `Open In ${mod}` : 'Open It In Its Module';
  const facts = row.facts || [];
  const footer = (
    <div className="apv-foot" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: '100%' }}>
      {row.link?.view && (
        <button type="button" className={`${inline.length ? 'apv-btn apv-review' : 'primary-btn'} apv-open`} onClick={() => { onClose(); go(row.link); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {openLabel} <ArrowUpRight size={14} />
        </button>
      )}
      <span style={{ flex: 1 }} />
      {inline.slice().reverse().map((a) => (
        <button key={a.key} type="button" className={actClass(a)} onClick={() => onAct(a)}>
          {a.label}
        </button>
      ))}
    </div>
  );
  return (
    <Modal title={row.title} onClose={onClose} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: FONT, color: 'var(--ink)', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px 14px', flexWrap: 'wrap' }}>
          <PersonMark person={person} size={48} />
          <div style={{ minWidth: 180, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, overflowWrap: 'anywhere' }}>
              {person.name || 'Your Team'}
              {row.forName && <ForChip name={row.forName} />}
            </div>
            {person.email && person.email !== person.name && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{person.email}</div>
            )}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            {kindLabel && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{kindLabel}</div>}
            {row.createdAt && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }} title={formatDateTime(row.createdAt)}>
                Waiting since {formatDateTime(row.createdAt)}
              </div>
            )}
          </div>
        </div>
        {row.detail && <div style={{ fontSize: 14, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{row.detail}</div>}
        {facts.length > 0 && (
          // The wrapper takes the popup's spare height; the list inside keeps
          // its rows at their own height instead of stretching to fill it.
          <div className="nx-fill">
            <div className="apv-facts" style={{ alignContent: 'start' }}>
              {facts.map((f) => [
                <div key={`${f.label}:l`}>{f.label}</div>,
                <div key={`${f.label}:v`}>{f.value}</div>,
              ])}
            </div>
          </div>
        )}
        {!facts.length && !row.detail && (
          <div className="nx-fill" style={{ fontSize: 13.5, color: 'var(--muted)' }}>
            {mod ? `The full request is in ${mod}.` : 'The full request is in its module.'}
          </div>
        )}
      </div>
    </Modal>
  );
}
