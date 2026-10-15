// The schedule toolbar (Oct 2026, Teams parity; tightened 10/02): ONE row -
// [Team ▾] [‹ date ›  Today] [Day Week Month] ...... [+ Add] [Share N] [⋯].
// The team switcher leads (one team at a time), the decorated date block is
// the anchor ("Sep 28 - Oct 4" over "2026 · Week 40 · This Week", a click
// jumps to any date), and "Today" is a small text button that shows only
// when today is out of view. Everything that used to be a button of its own
// (Fill, Copy, Clear, Import, Export, Print, Discard, Requests, the View
// menu, the filters) lives under + Add or ⋯. On a phone: [Team ▾] [+] [⋯]
// over [‹ date ›] [Today] [Week ▾]; Share moves under ⋯.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Plus, Send, MoreHorizontal, Clock, CalendarRange, CalendarOff, StickyNote, Copy, CalendarDays, Trash2, Upload, Download, Printer, RotateCcw, Inbox, SlidersHorizontal, X, Search, EyeOff, Keyboard, Gauge, ChevronDown, ChevronUp, AlertTriangle, CircleCheck, BellRing } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime, formatWeekday, formatHHMM } from '../../lib/datetime';
import { MenuButton, POP, HEAD, useAnchor, useDismissBoth } from './Menu';
import DateBlock from './DateBlock';
import { RollingNumber } from './motion';
import { addDaysIso } from './shiftLib';

const VIEWS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
export const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
export const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '92dvh', overflowY: 'auto' };
export const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
export const CHECK = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' };

export function DialogHead({ title, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
      <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{title}</span>
      <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
    </div>
  );
}

const ARROW = { width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)', borderRadius: 8,
  background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', padding: 0, flexShrink: 0 };
const TODAY_BTN = { border: 'none', background: 'none', padding: '6px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--wk-brand)', borderRadius: 7, whiteSpace: 'nowrap' };

export function ScheduleToolbar({ view, onView, onPrev, onNext, onToday, range, onJump, showToday = false, slide = 0, teamSwitcher = null, canManage, busy, ready,
  unsharedCount = 0, onAdd, onShare, actions, phone = false, confirmations = null, onNudge = null }) {
  const viewName = VIEWS.find(([k]) => k === view)?.[1] || (view === 'twoweeks' ? 'Two Weeks' : 'Week');
  const addItems = [
    { key: 'shift', label: 'Shift', Icon: Clock, onClick: () => onAdd('shift') },
    { key: 'open', label: 'Open Shift', Icon: CalendarRange, onClick: () => onAdd('open') },
    ...(actions.canTimeOff ? [{ key: 'timeoff', label: 'Time Off', Icon: CalendarOff, onClick: () => onAdd('timeoff') }] : []),
    { key: 'note', label: 'Day Note', Icon: StickyNote, onClick: () => onAdd('note') },
  ];
  // On a phone, Share lives under ⋯ so the rows stay short; nothing is lost.
  const moreItems = [
    ...(phone && canManage ? [
      { key: 'share', label: `Share${unsharedCount ? ` (${unsharedCount})` : ''}`, Icon: Send, onClick: onShare, disabled: busy || !ready, title: unsharedCount ? `${unsharedCount} change${unsharedCount === 1 ? '' : 's'} your team has not seen yet` : 'Everything is shared with the team' },
      'sep',
    ] : []),
    ...(canManage ? [
      { key: 'copy', label: 'Copy Week', Icon: Copy, onClick: actions.copy, disabled: !ready },
      { key: 'fill', label: 'Fill From Usual Hours', Icon: CalendarDays, onClick: actions.fill, disabled: !ready },
      { key: 'clear', label: 'Clear Week', Icon: Trash2, onClick: actions.clear, disabled: !ready },
      'sep',
      { key: 'import', label: 'Import', Icon: Upload, onClick: actions.importFile, disabled: !ready },
    ] : []),
    { key: 'export', label: 'Export', Icon: Download, onClick: actions.exportFile, disabled: !ready },
    { key: 'print', label: 'Print', Icon: Printer, onClick: actions.print, disabled: !ready },
    'sep',
    { key: 'view', label: 'View Options', Icon: SlidersHorizontal, onClick: actions.viewOptions },
    { key: 'hideEmpty', label: 'Hide People Without Shifts', Icon: EyeOff, checked: !!actions.hideEmpty, onClick: actions.toggleHideEmpty },
    ...(actions.toggleCoverage ? [{ key: 'coverage', label: 'Show Coverage', Icon: Gauge, checked: !!actions.coverage, onClick: actions.toggleCoverage }] : []),
    ...(canManage ? [
      'sep',
      { key: 'discard', label: `Discard Changes${actions.discardCount ? ` (${actions.discardCount})` : ''}`, Icon: RotateCcw, onClick: actions.discard, disabled: !actions.discardCount || busy,
        title: 'Undo edits and removals that are not shared yet' },
      { key: 'requests', label: 'Requests', Icon: Inbox, onClick: actions.requests },
    ] : []),
    ...(!phone && actions.shortcuts ? ['sep', { key: 'keys', label: 'Keyboard Shortcuts', Icon: Keyboard, onClick: actions.shortcuts }] : []),
  ];
  const unit = viewName.toLowerCase();
  const dateNav = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <button type="button" className="sched-arrow" onClick={onPrev} aria-label={`Previous ${unit}`} title={`Previous ${unit} (Left arrow)`} style={ARROW}><ChevronLeft size={16} /></button>
      <DateBlock view={view} first={range.first} last={range.last} weekStart={range.weekStart} onPick={onJump} compact={phone} slide={slide} />
      <button type="button" className="sched-arrow" onClick={onNext} aria-label={`Next ${unit}`} title={`Next ${unit} (Right arrow)`} style={ARROW}><ChevronRight size={16} /></button>
      {showToday && <button type="button" className="sched-today" onClick={onToday} title="Today (T)" style={TODAY_BTN}>Today</button>}
    </div>
  );
  const more = (
    <MenuButton label="" Icon={MoreHorizontal} items={moreItems} ariaLabel="More" align="right" width={240} style={{ padding: phone ? '7px 9px' : '6px 8px', height: phone ? 36 : undefined }}
      badge={phone && unsharedCount > 0 ? <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--wk-brand)', marginLeft: -4 }} /> : null} />
  );
  // "5 Of 8 Confirmed" (Phase 3a): only when a share in view asked someone to confirm.
  const confirmChip = canManage && confirmations && confirmations.total > 0 ? <ConfirmChip c={confirmations} onNudge={onNudge} compact={phone} /> : null;
  if (phone) {
    const viewItems = VIEWS.map(([k, label]) => ({ key: k, label, hint: (view === k || (k === 'week' && view === 'twoweeks')) ? '✓' : '', onClick: () => onView(k) }));
    return (
      <div role="toolbar" aria-label="Schedule" style={{ marginBottom: 10, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {teamSwitcher}
          {!teamSwitcher && <div style={{ flex: 1 }} />}
          {canManage && <MenuButton label="" Icon={Plus} items={addItems} ariaLabel="Add" primary width={190} disabled={!ready} align="right" style={{ padding: '7px 10px', height: 36 }} />}
          {more}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {dateNav}
          <div style={{ flex: 1 }} />
          {confirmChip}
          <MenuButton label={viewName} items={viewItems} ariaLabel="View" width={150} align="right" style={{ padding: '6px 10px', fontWeight: 700 }} />
        </div>
      </div>
    );
  }
  return (
    <div role="toolbar" aria-label="Schedule" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap', rowGap: 10 }}>
      {teamSwitcher}
      {teamSwitcher && <span aria-hidden="true" style={{ width: 1, height: 26, background: 'var(--line)' }} />}
      {dateNav}
      <div role="group" aria-label="View" style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden', background: 'var(--card)' }}>
        {VIEWS.map(([k, label]) => {
          const on = view === k || (k === 'week' && view === 'twoweeks');
          return (
            <button key={k} type="button" onClick={() => onView(k)} aria-pressed={on}
              style={{ border: 'none', padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                background: on ? 'var(--wk-brand-tint)' : 'transparent', color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>{label}</button>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {confirmChip}
        {canManage && <MenuButton label="Add" Icon={Plus} items={addItems} ariaLabel="Add" primary width={190} disabled={!ready} />}
        {canManage && (
          <button type="button" className={unsharedCount ? 'primary-btn' : 'secondary-btn'} onClick={onShare} disabled={busy || !ready}
            title={unsharedCount ? `${unsharedCount} change${unsharedCount === 1 ? '' : 's'} your team has not seen yet` : 'Everything is shared with the team'}
            aria-label={`Share${unsharedCount ? `, ${unsharedCount} unshared` : ''}`}
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Send size={13} /> Share
            {unsharedCount > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: '#fff', color: 'var(--wk-brand)', borderRadius: 10, padding: '0 6px', minWidth: 18, textAlign: 'center' }}><RollingNumber value={unsharedCount} /></span>}
          </button>
        )}
        {more}
      </div>
    </div>
  );
}

// The confirmations chip (Shifts Phase 3a, Oct 14): "5 Of 8 Confirmed" for
// the people a share in this range asked to confirm. A click lists who has
// not, each with Nudge (or "Nudged 10/14" once they were), and Nudge
// Everyone - one reminder per person about their latest share.
const nudgedDay = (iso) => formatDate(iso).slice(0, 5);
export function ConfirmChip({ c, onNudge, compact = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  useDismissBoth(open, [btnRef, listRef], close);
  const pos = useAnchor(open, btnRef, 300, 'right');
  const all = c.confirmed >= c.total;
  const waiting = c.pending.filter((p) => !p.nudgedAt);
  async function send(people, key) {
    if (!onNudge || !people.length) return;
    setBusy(key);
    try { await onNudge(people); } finally { setBusy(''); }
  }
  const label = `${c.confirmed} Of ${c.total} Confirmed`;
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={btnRef} type="button" data-confirm-chip="" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={label}
        title={all ? 'Everyone has confirmed the shared schedule' : `${c.pending.length} ${c.pending.length === 1 ? 'person has' : 'people have'} not confirmed the shared schedule yet`}
        style={{ border: '1px solid transparent', borderRadius: 999, padding: compact ? '4px 9px' : '5px 10px', fontFamily: 'inherit', fontSize: compact ? 11.5 : 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
          display: 'inline-flex', alignItems: 'center', gap: 5, height: compact ? 36 : undefined,
          background: all ? 'hsla(var(--color-green),0.12)' : 'var(--wk-brand-tint)', color: all ? 'hsl(var(--color-green))' : 'var(--wk-brand)' }}>
        <CircleCheck size={13} />{compact ? `${c.confirmed}/${c.total}` : label}
      </button>
      {open && pos && createPortal(
        <div ref={listRef} role="dialog" aria-label="Schedule confirmations" style={{ ...POP, ...pos, zIndex: 1350, padding: '4px 0 8px', maxHeight: `calc(100vh - ${Math.round(pos.top) + 12}px)`, overflowY: 'auto' }}>
          <div style={HEAD}>{all ? 'Everyone Has Confirmed' : 'Not Confirmed Yet'}</div>
          {c.pending.map((p) => (
            <div key={p.email} data-confirm-pending={p.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: compact ? '4px 12px' : '5px 12px', fontSize: 12.5 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{p.name}</span>
              {p.nudgedAt ? (
                <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }} title={`Nudged ${formatDateTime(p.nudgedAt)}`}>Nudged {nudgedDay(p.nudgedAt)}</span>
              ) : (
                <button type="button" onClick={() => send([p], p.email)} disabled={!!busy || !onNudge} aria-label={`Nudge ${p.name}`}
                  style={{ border: '1px solid var(--line)', background: 'var(--card)', borderRadius: 7, padding: compact ? '8px 12px' : '2px 8px', minHeight: compact ? 36 : undefined,
                    fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <BellRing size={11} /> Nudge
                </button>
              )}
            </div>
          ))}
          {all && <div style={{ padding: '2px 12px 4px', fontSize: 12, color: 'var(--muted)' }}>{c.total} {c.total === 1 ? 'person' : 'people'} confirmed the shared schedule.</div>}
          {!all && (
            <div style={{ padding: '6px 12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, fontSize: 11.5, color: 'var(--muted)' }}>{waiting.length ? 'A nudge is one notification and email.' : 'Everyone waiting has been nudged.'}</span>
              <button type="button" className="primary-btn" onClick={() => send(waiting, 'all')} disabled={!!busy || !waiting.length || !onNudge}
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: compact ? 36 : undefined }}>
                <BellRing size={12} /> Nudge Everyone
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}

// Share (Teams "Share with team"): pick a date range - the visible week by
// default - and who hears about it; says when the schedule was last shared
// and how many changes in that range are waiting.
// Over 50 waiting changes (10/02): the dialog leads with where they are -
// "This week: 4 · Next week: 8 · Other weeks: 230" - and picks this week and
// next rather than everything.
// Shifts Phase 2 (Oct 14): two steps. Step 1 is the pick above and ends in
// Review; step 2 (Review And Share) lists every change per person and the
// rule / conflict warnings per person, each a jump to its cell on the grid,
// and asks for a reason when the company requires one to share with
// warnings. The reason travels with the publish and lands in the history of
// every shift it shares. A server refusal shows in the dialog itself.
export const SHARE_SUMMARY_OVER = 50;
const KIND_WORD = { added: 'new', changed: 'changed', removed: 'removed' };
// "Tue 10/20"
const dayText = (iso) => `${formatWeekday(iso, 'short')} ${formatDate(iso).slice(0, 5)}`;
const spanText = (start, end) => `${formatHHMM(start, '?')} - ${formatHHMM(end, '?')}`;
export function changeLine(c) {
  const bits = [dayText(c.date), spanText(c.start, c.end)];
  if (c.label) bits.push(c.label);
  let tail = '';
  if (c.kind === 'removed') tail = ' (removed)';
  else if (c.kind === 'added') tail = ' (new)';
  else if (c.was) {
    // The API's `was` is {start, end, label}: the published version.
    const { start: ws, end: we, label: wl } = c.was;
    tail = ` (was ${spanText(ws, we)}${wl && wl !== c.label ? ` · ${wl}` : ''})`;
  }
  return `${bits.join(' · ')}${tail}`;
}
export function reviewSummary(changes = [], people = 0) {
  const n = changes.length;
  if (!n) return 'No changes in these dates.';
  const counts = ['added', 'changed', 'removed'].map((k) => [k, changes.filter((c) => c.kind === k).length]).filter(([, v]) => v > 0);
  return `${n} change${n === 1 ? '' : 's'} for ${people} ${people === 1 ? 'person' : 'people'}: ${counts.map(([k, v]) => `${v} ${KIND_WORD[k]}`).join(', ')}`;
}
// Rows grouped by person, in the order they first appear.
function byPerson(rows) {
  const out = [];
  const idx = new Map();
  for (const r of rows) {
    const key = (r.email || '').toLowerCase();
    if (!idx.has(key)) { idx.set(key, out.length); out.push({ email: r.email, name: r.name || r.email, rows: [] }); }
    out[idx.get(key)].rows.push(r);
  }
  return out;
}
const WARN_CHIP = (rule) => ({ fontSize: 10, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 999, flexShrink: 0,
  background: rule ? 'hsla(var(--color-orange),0.14)' : 'hsla(var(--color-red),0.12)', color: rule ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))' });

export const REASON_MAX = 300;   // the server keeps 300 (routers/timeclock publish, shift_log)
// `memo` / `onMemo` (Oct 15): a warning jump closes the dialog to show the
// cell; what was picked and typed - and the review itself - is handed back
// to the schedule and restored when the dialog reopens, on Review And Share.
export function ShareDialog({ defaultStart, defaultEnd, lastPublishedAt, localCount = 0, totalCount = 0, thisWeek = null, groups = [], busy, onPublish, onJump, onClose,
  memo = null, onMemo = null }) {
  const big = totalCount > SHARE_SUMMARY_OVER && !!thisWeek && !memo;
  const [from, setFrom] = useState(memo?.from || (big ? thisWeek.start : defaultStart));
  const [to, setTo] = useState(memo?.to || (big ? addDaysIso(thisWeek.start, 13) : defaultEnd));
  const [byWeek, setByWeek] = useState(null);
  useEffect(() => {
    if (!big) return undefined;
    let live = true;
    const a = thisWeek.start, b = addDaysIso(thisWeek.start, 6), c = addDaysIso(thisWeek.start, 7), d = addDaysIso(thisWeek.start, 13);
    Promise.all([api.timeSchedUnshared(a, b), api.timeSchedUnshared(c, d)]).then(([x, y]) => {
      if (!live) return;
      const tw = Number(x?.count) || 0, nw = Number(y?.count) || 0;
      setByWeek({ tw, nw, other: Math.max(0, totalCount - tw - nw) });
    }).catch(() => { if (live) setByWeek(null); });
    return () => { live = false; };
  }, [big]); // eslint-disable-line react-hooks/exhaustive-deps
  const [notify, setNotify] = useState(memo?.notify || 'changed');
  const [groupId, setGroupId] = useState(memo?.groupId || '');
  const [count, setCount] = useState(null);    // null = unknown (older API)
  // Recent shares made with warnings (Oct 15), under step 1 - the reason in
  // quotes. An older API without the route: nothing shown.
  const [recent, setRecent] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.timeSchedShares?.({ limit: 10 }))
      .then((r) => { if (live) setRecent(Array.isArray(r?.shares) ? r.shares : []); })
      .catch(() => { if (live) setRecent([]); });
    return () => { live = false; };
  }, []);
  const days = from && to ? Math.round((new Date(to) - new Date(from)) / 86400000) + 1 : 0;
  const tooLong = days > 92;
  useEffect(() => {
    if (!from || !to || to < from) return undefined;
    let live = true;
    api.timeSchedUnshared(from, to).then((r) => { if (live) setCount(Number(r?.count) || 0); }).catch(() => { if (live) setCount(null); });
    return () => { live = false; };
  }, [from, to]);
  const n = count ?? localCount;
  // Step 2: the review of exactly what step 1 picked.
  const [review, setReview] = useState(memo?.review || null);     // { changes, people, warnings, reasonRequired }
  const [reviewing, setReviewing] = useState(false);
  const [reviewErr, setReviewErr] = useState('');
  const [reason, setReason] = useState(memo?.reason || '');
  const jump = (email, date, shiftId) => {
    onMemo?.({ from, to, notify, groupId, reason, review });
    onJump?.(email, date, shiftId);
  };
  const [shareErr, setShareErr] = useState('');
  const [showChanges, setShowChanges] = useState(null);   // null = open when the list is short
  // Mounted or not: the review and the share land on a dialog that may have
  // closed. Set on mount as well as cleared on unmount - StrictMode runs the
  // cleanup once on mount, and a flag only ever cleared left Review stuck on
  // "…" with the answer thrown away.
  const liveRef = useRef(true);
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);
  async function loadReview() {
    setReviewing(true); setReviewErr(''); setShareErr('');
    try {
      const r = await Promise.resolve().then(() => api.timeSchedPublishReview({ start: from, end: to, ...(groupId ? { group_id: groupId } : {}) }));
      if (!liveRef.current) return;
      setReview({ changes: Array.isArray(r?.changes) ? r.changes : [], people: Number(r?.people) || 0, warnings: Array.isArray(r?.warnings) ? r.warnings : [], reasonRequired: r?.reasonRequired === true });
      setShowChanges(null);
    } catch (e) {
      if (liveRef.current) setReviewErr(e?.message || 'Could not review these dates.');
    } finally { if (liveRef.current) setReviewing(false); }
  }
  async function share() {
    setShareErr('');
    const r = await onPublish({ start_date: from, end_date: to, notify, ...(groupId ? { group_id: groupId } : {}), reason: reason.trim().slice(0, REASON_MAX) });
    if (liveRef.current && r?.error) setShareErr(r.error);
    else if (liveRef.current && r && !r.error) onMemo?.(null);
  }
  const cancel = () => { onMemo?.(null); onClose(); };
  const opt = (value, title, hint) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
      border: `1px solid ${notify === value ? 'var(--wk-brand)' : 'var(--line)'}`, background: notify === value ? 'var(--wk-brand-tint)' : 'transparent' }}>
      <input type="radio" name="share-notify" checked={notify === value} onChange={() => setNotify(value)} style={{ marginTop: 3 }} />
      <span><div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div><div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div></span>
    </label>
  );
  const step2 = !!review;
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && cancel()}>
      <div role="dialog" aria-label="Share Schedule" style={{ ...MODAL_CARD, maxWidth: step2 ? 520 : 440 }}>
        <DialogHead title={step2 ? 'Review And Share' : 'Share Schedule'} onClose={cancel} />
        {step2 ? (
          <ReviewStep review={review} from={from} to={to} reason={reason} onReason={setReason} showChanges={showChanges} onShowChanges={setShowChanges}
            shareErr={shareErr} onJump={onJump ? jump : null} />
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              The team sees drafts, edits and removals in these dates once you share.
              {lastPublishedAt ? ` Last shared ${formatDateTime(lastPublishedAt)}.` : ' Not shared yet.'}
            </div>
            {big && (
              <div data-share-summary="" style={{ border: '1px solid var(--line)', background: 'var(--bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{totalCount} changes are waiting</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
                  {byWeek ? `This week: ${byWeek.tw} · Next week: ${byWeek.nw} · Other weeks: ${byWeek.other}` : 'Counting by week...'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>This week and next are picked. Widen the dates to share the rest.</div>
              </div>
            )}
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="date" className="form-input" aria-label="Share from" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
                <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="date" className="form-input" aria-label="Share to" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              </div>
              {groups.length > 0 && (
                <label><div style={LBL}>Group</div>
                  <select className="form-input" aria-label="Share group" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                    <option value="">Every group</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
              )}
              <div style={{ fontSize: 12.5, fontWeight: 700, color: tooLong ? 'hsl(var(--color-red))' : 'var(--ink)' }}>
                {tooLong ? 'Share at most 92 days at a time.' : to < from ? 'The end is before the start.' : `${n} change${n === 1 ? '' : 's'} to share in these dates.`}
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {opt('changed', 'Only people whose shifts changed', 'Each gets a notification and an email listing their own changes.')}
                {opt('team', 'The whole team', 'The same, plus a short notification to everyone else on the schedule for these dates.')}
              </div>
              {reviewErr && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{reviewErr}</div>}
              {recent?.length > 0 && <RecentShares shares={recent} />}
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          {step2 && <button type="button" className="secondary-btn" onClick={() => { setReview(null); setShareErr(''); }} disabled={busy}>Back</button>}
          <button type="button" className="secondary-btn" onClick={cancel}>Cancel</button>
          {step2 ? (
            <button type="button" className="primary-btn" onClick={share}
              disabled={busy || review.changes.length === 0 || (review.reasonRequired && review.warnings.length > 0 && !reason.trim())}>{busy ? '…' : 'Share'}</button>
          ) : (
            <button type="button" className="primary-btn" disabled={busy || reviewing || tooLong || !from || !to || to < from || n === 0} onClick={loadReview}>{reviewing ? '…' : 'Review'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// "Recent Shares": the last shares that carried a warning, with who, when,
// how many people and warnings, and the reason in quotes.
function RecentShares({ shares }) {
  return (
    <div data-recent-shares="">
      <div style={LBL}>Recent Shares</div>
      <div style={{ display: 'grid', gap: 5, maxHeight: 150, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px' }}>
        {shares.slice(0, 10).map((x) => (
          <div key={x.publishId} style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 700 }}>{x.byName || x.by}</span>
            <span style={{ color: 'var(--muted)' }}> · {formatDateTime(x.at)} · {x.people} {x.people === 1 ? 'person' : 'people'} · {x.warnings} warning{x.warnings === 1 ? '' : 's'}</span>
            {x.reason && <div style={{ color: 'var(--muted)', fontStyle: 'italic' }}>"{x.reason}"</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewStep({ review, from, to, reason, onReason, showChanges, onShowChanges, shareErr, onJump }) {
  const { changes, people, warnings, reasonRequired } = review;
  const changesOpen = showChanges ?? changes.length <= 12;
  const changePeople = byPerson(changes);
  const warnPeople = byPerson(warnings);
  const needReason = reasonRequired && warnings.length > 0;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{formatDate(from)} - {formatDate(to)}. Nothing is shared until you press Share.</div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span data-review-summary="" style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{reviewSummary(changes, people)}</span>
          {changes.length > 0 && (
            <button type="button" onClick={() => onShowChanges(!changesOpen)} aria-expanded={changesOpen}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0 }}>
              {changesOpen ? 'Hide Changes' : 'Show Changes'} {changesOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>
        {changesOpen && changes.length > 0 && (
          <div data-review-changes="" style={{ marginTop: 8, display: 'grid', gap: 8, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px' }}>
            {changePeople.map((p) => (
              <div key={p.email}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{p.name}</div>
                {p.rows.map((c, i) => (
                  <div key={`${c.date}|${c.start}|${c.kind}|${i}`} style={{ fontSize: 12, color: c.kind === 'removed' ? 'var(--muted)' : 'var(--ink)', textDecoration: c.kind === 'removed' ? 'line-through' : 'none', padding: '1px 0' }}>{changeLine(c)}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div style={{ ...LBL, display: 'flex', alignItems: 'center', gap: 6 }}>
          {warnings.length > 0 && <AlertTriangle size={12} color="hsl(var(--color-orange))" />}
          Warnings{warnings.length ? ` (${warnings.length})` : ''}
        </div>
        {warnings.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No warnings.</div>
        ) : (
          <div data-review-warnings="" style={{ display: 'grid', gap: 8, maxHeight: 220, overflowY: 'auto', border: '1px solid hsla(var(--color-orange),0.4)', background: 'hsla(var(--color-orange),0.06)', borderRadius: 10, padding: '8px 12px' }}>
            {warnPeople.map((p) => (
              <div key={p.email}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{p.name}</div>
                {p.rows.map((w, i) => {
                  const rule = w.kind !== 'conflict';
                  // A pending request, availability or an overlap is a heads-up: shown, never a reason (Oct 15).
                  const soft = !rule && w.soft === true;
                  return (
                    <button key={`${w.date}|${w.shiftId || ''}|${i}`} type="button" onClick={() => onJump?.(w.email, w.date, w.shiftId)} title="Show this shift on the schedule"
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: onJump ? 'pointer' : 'default', padding: '2px 0', fontFamily: 'inherit', color: 'var(--ink)', fontSize: 12 }}>
                      <span style={{ ...WARN_CHIP(rule || soft), marginTop: 1, ...(soft ? { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' } : {}) }}>{rule ? 'Rule' : soft ? 'Heads Up' : 'Conflict'}</span>
                      <span><span style={{ color: 'var(--muted)' }}>{dayText(w.date)} · </span>{w.text}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {warnings.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Click a warning to see that shift on the schedule. Warnings never block sharing.</div>}
      </div>
      {needReason && (
        <label><div style={LBL}>Reason For Sharing With Warnings</div>
          <textarea className="form-input" rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => onReason(e.target.value.slice(0, REASON_MAX))} required aria-label="Reason for sharing with warnings"
            placeholder="e.g. Short-staffed this week; overtime approved" style={{ width: '100%', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
            <span style={{ flex: 1 }}>Managers see this reason in the history of the shifts it applies to.</span>
            {reason.length >= REASON_MAX - 50 && <span data-reason-count="" style={{ color: reason.length >= REASON_MAX ? 'hsl(var(--color-red))' : 'var(--muted)', flexShrink: 0 }}>{reason.length}/{REASON_MAX}</span>}
          </div>
        </label>
      )}
      {shareErr && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{shareErr}</div>}
    </div>
  );
}

// A note on one day, for the whole team or one group (Teams "day notes").
export function DayNoteDialog({ date, groups = [], notes = [], busy, onSave, onClose, onDateChange }) {
  const [groupId, setGroupId] = useState('');
  const existing = notes.find((n) => n.date === date && (n.groupId || '') === groupId);
  const [text, setText] = useState(existing?.note || '');
  useEffect(() => { setText(existing?.note || ''); }, [existing?.note, groupId, date]);
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Day Note" style={{ ...MODAL_CARD, maxWidth: 420 }}>
        <DialogHead title="Day Note" onClose={onClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Everyone on the schedule sees this on the day, here and in My Shifts.</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label><div style={LBL}>Day</div>
            {onDateChange ? <input type="date" className="form-input" aria-label="Note day" value={date} onChange={(e) => onDateChange(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
              : <div style={{ fontSize: 13, fontWeight: 700 }}>{formatWeekday(date)}, {formatDate(date)}</div>}
          </label>
          {groups.length > 0 && (
            <label><div style={LBL}>For</div>
              <select className="form-input" aria-label="Note group" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="">Everyone</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          )}
          <textarea className="form-input" rows={3} maxLength={200} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Inventory day - all hands" aria-label="Day note" style={{ width: '100%', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          {existing?.note && <button type="button" onClick={() => onSave(date, '', groupId)} disabled={busy} style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>Remove</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => onSave(date, text, groupId)} disabled={busy || !text.trim()} style={{ opacity: text.trim() ? 1 : 0.55 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// View Options (under ⋯): the filters and switches that used to crowd the
// toolbar - search, rows by team or location, one shift type, Teams' Show
// list, your own shifts only, and two weeks at a time.
export const SHOW_OPTIONS = [['teams', 'Groups'], ['open', 'Open Shifts'], ['conflicts', 'Shift Conflicts'], ['availability', 'Availability'], ['photos', 'Profile Pictures'], ['sunday', 'Sunday'], ['actuals', 'Actuals']];
export function ViewOptionsDialog({ prefs, onPrefs, query, onQuery, groupBy, onGroupBy, presetFilter, onPresetFilter, presets = [], twoWeeks, onTwoWeeks, canViewByShift, onClose }) {
  const set = (k, v) => onPrefs({ ...prefs, [k]: v });
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="View Options" style={{ ...MODAL_CARD, maxWidth: 420 }}>
        <DialogHead title="View Options" onClose={onClose} />
        <div style={{ display: 'grid', gap: 14, marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px' }}>
            <Search size={13} color="var(--muted)" />
            <input className="nx-inline-edit" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search people" aria-label="Search people"
              style={{ border: 'none', fontSize: 13, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 150 }}><div style={LBL}>Rows By</div>
              <select className="form-input" value={groupBy} onChange={(e) => onGroupBy(e.target.value)} aria-label="Group people by" style={{ width: '100%', fontSize: 13 }}>
                <option value="group">Group</option>
                <option value="location">Location</option>
                {canViewByShift && <option value="shift">Shift Type</option>}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 150 }}><div style={LBL}>Shift Type</div>
              <select className="form-input" value={presetFilter} onChange={(e) => onPresetFilter(e.target.value)} aria-label="Filter by shift type" style={{ width: '100%', fontSize: 13 }}>
                <option value="">All Shift Types</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name || p.code}</option>)}
              </select>
            </label>
          </div>
          <div>
            <div style={LBL}>Show</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {SHOW_OPTIONS.map(([k, label]) => (
                <label key={k} style={CHECK}><input type="checkbox" checked={prefs[k] !== false} onChange={(e) => set(k, e.target.checked)} aria-label={`Show ${label}`} /> {label}</label>
              ))}
              <label style={CHECK}><input type="checkbox" checked={!!prefs.mine} onChange={(e) => set('mine', e.target.checked)} aria-label="Your shifts only" /> Your Shifts Only</label>
              <label style={CHECK}><input type="checkbox" checked={!!twoWeeks} onChange={(e) => onTwoWeeks(e.target.checked)} aria-label="Two weeks at a time" /> Two Weeks At A Time</label>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={() => { onQuery(''); onPresetFilter(''); onPrefs({ ...prefs, mine: false }); }}>Clear Filters</button>
          <button type="button" className="primary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export { addDaysIso };
