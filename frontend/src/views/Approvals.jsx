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
// Oldest waiting first: an approval queue is first come, first served, and
// the one waiting longest is the one most likely to be late.
//
// A decision leaves the list at once and is sent after a short Undo window
// (UNDO_MS) - the module endpoints cannot be undone once called, so the undo
// is the wait. Leaving the screen sends whatever is still waiting. A refusal
// brings the row back with the module's own message.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, RefreshCw, CheckCircle2, ChevronRight } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { ForChip } from '../components/DelegateApprovals';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { openNotificationTarget } from '../lib/openTarget';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { UNDO_MS, doneWord, runApproval, runsInline, shortName, waited } from '../lib/approvalActions';

const FONT = 'Inter, sans-serif';
const POLL_MS = 60000;

// The chips when the server sends none (an API still deploying).
const DEFAULT_GROUPS = [
  { key: 'timeoff', label: 'Time Off' }, { key: 'timesheets', label: 'Time Sheets' },
  { key: 'shifts', label: 'Shifts' }, { key: 'money', label: 'Money' },
  { key: 'hiring', label: 'Hiring' }, { key: 'signatures', label: 'Signatures' },
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

export default function Approvals({ activeSub, onSubChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());   // keys decided here, waiting out the Undo window or the reload
  const [toast, setToast] = useState(null);                 // { kind: 'undo' | 'ok' | 'error', msg, key?, link? }
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
    // Off the list now; sent when the Undo window closes.
    hide(row.key, true);
    const timer = setTimeout(() => commit(row.key), UNDO_MS);
    pending.current.set(row.key, { row, action, note, timer });
    const who = shortName(row.person);
    say({ kind: 'undo', key: row.key, msg: `${doneWord(action.key)}: ${who ? `${who} - ` : ''}${row.title}` });
  }

  function undo(key) {
    const p = pending.current.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(key);
    hide(key, false);
    say(null);
  }

  const groupLabels = data?.groupLabels?.length ? data.groupLabels : DEFAULT_GROUPS;
  const rows = useMemo(() => (data?.rows || []).filter((r) => !hidden.has(r.key)), [data, hidden]);
  const counts = useMemo(() => {
    const c = { all: 0 };
    rows.forEach((r) => { const n = r.count || 1; c.all += n; c[r.group] = (c[r.group] || 0) + n; });
    return c;
  }, [rows]);
  const shown = group === 'all' ? rows : rows.filter((r) => r.group === group);
  const chips = [{ key: 'all', label: 'All' }, ...groupLabels.filter((g) => counts[g.key] || g.key === group)];
  const errors = data?.errors || [];
  const groupName = groupLabels.find((g) => g.key === group)?.label || '';

  return (
    <div style={{ fontFamily: FONT, color: 'var(--ink)', maxWidth: 1080, margin: '0 auto', padding: '4px 0 48px' }}>
      <style>{`
        .apv-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 76px auto; grid-template-areas: "who what age act";
          gap: 6px 14px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--line); }
        .apv-row:first-child { border-top: none; }
        .apv-who { grid-area: who; min-width: 0; }
        .apv-what { grid-area: what; min-width: 0; }
        .apv-age { grid-area: age; text-align: right; }
        .apv-act { grid-area: act; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
        .apv-title { background: none; border: none; padding: 0; margin: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
        .apv-title:hover { text-decoration: underline; }
        .apv-act button { font-size: 12.5px; padding: 6px 12px; white-space: nowrap; }
        @media (max-width: 720px) {
          .apv-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "who age" "what what" "act act"; padding: 12px 14px; }
          .apv-act { justify-content: flex-start; }
          .apv-act button { flex: 1 1 auto; }
        }
      `}</style>

      <div className="view-header" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Inbox size={19} />
          </span>
          <div className="view-title-group">
            <h2>Approvals</h2>
            <p>Everything waiting on your decision, across Nexus - oldest first.</p>
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
              {group === 'all' ? 'Nothing waiting on you' : `Nothing in ${groupName} waiting on you`}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 460, marginInline: 'auto', lineHeight: 1.5 }}>
              Time off, time sheets, reimbursements, shift requests, hiring votes and documents that need your decision show up here.
            </div>
          </div>
        }
      >
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
          {shown.map((r) => <Row key={r.key} row={r} onAct={decide} />)}
        </div>
      </AsyncSection>

      {toast && (
        <div role="status" aria-live="polite"
          style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1300, maxWidth: 'min(640px, calc(100vw - 32px))',
            display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px 10px 18px', borderRadius: 10, boxShadow: 'var(--shadow-lg)',
            background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'var(--ink)', color: toast.kind === 'error' ? '#fff' : 'var(--paper)',
            fontSize: 13, fontWeight: 600, fontFamily: FONT }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{toast.msg}</span>
          {toast.kind === 'undo' && (
            <button type="button" onClick={() => undo(toast.key)}
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

function Row({ row, onAct }) {
  const who = shortName(row.person);
  return (
    <div className="apv-row" data-kind={row.kind}>
      <div className="apv-who" title={row.person?.name || ''}
        style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {who || '-'}
      </div>
      <div className="apv-what">
        <button type="button" className="apv-title" onClick={() => go(row.link)} title="Open it in its module"
          style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{row.title}</span>
          <ChevronRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        </button>
        {(row.detail || row.forName) && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
            {row.detail}
            {row.forName && <ForChip name={row.forName} />}
          </div>
        )}
      </div>
      <div className="apv-age" title={row.createdAt ? formatDateTime(row.createdAt) : ''}
        style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        {waited(row.createdAt)}
      </div>
      <div className="apv-act">
        {(row.actions || []).map((a) => (
          <button key={a.key} type="button" className={a.tone === 'primary' ? 'primary-btn' : 'secondary-btn'}
            aria-label={`${a.label}: ${row.title}${who ? ` (${who})` : ''}`} onClick={() => onAct(row, a)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
