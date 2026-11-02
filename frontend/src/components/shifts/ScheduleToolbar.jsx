// The Shift Planner toolbar (Oct 2026, Teams parity; reworked Oct 28 2026
// after Neil's walk-through, and Oct 30 2026): ONE row at 1440px -
// [‹ date ›  Today] [Day Week Month] ...... [Fill Automatically] [Add]
// [Print] [⋯] | [Discard] [Save & Share N]. Print stays its own button
// (Neil). Discard shows only once there is something to discard; Customize,
// Export to Excel and Import live under ⋯ with Copy Week, Clear Week and
// Keyboard Shortcuts - Requests has its own tab. The team picker and the
// team's facts (hours, unshared changes, "0 of 17 Confirmed") sit on their
// own line right above the schedule. On a phone: [‹ date ›] [+] [⋯] over
// [Team ▾] [Week ▾]; Discard, Fill, Import, Export and Customize move under
// ⋯ and Save & Share is a bar at the foot of the screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Plus, Send, MoreHorizontal, Clock, CalendarRange, CalendarOff, StickyNote, Copy, Wand2, Trash2, Upload, Download, Printer, RotateCcw, SlidersHorizontal, X, Search, Keyboard, CircleCheck, BellRing } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime, formatWeekday, formatHHMM } from '../../lib/datetime';
import { MenuButton, POP, HEAD, useAnchor, useDismissBoth } from './Menu';
import DateBlock from './DateBlock';
import { RollingNumber } from './motion';
import { addDaysIso } from './shiftLib';
import { DateField } from '../../tasks/components';

const VIEWS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
export const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
// Size comes from className="nx-popup" (CLAUDE.md popup rule), which also keeps the phone sheet.
export const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, padding: 20 };
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
  unsharedCount = 0, onAdd, onShare, actions, phone = false }) {
  const viewName = VIEWS.find(([k]) => k === view)?.[1] || (view === 'twoweeks' ? 'Two Weeks' : 'Week');
  const addItems = [
    { key: 'shift', label: 'Shift', Icon: Clock, onClick: () => onAdd('shift') },
    ...(actions.canOpen === false ? [] : [{ key: 'open', label: 'Open Shift', Icon: CalendarRange, onClick: () => onAdd('open') }]),
    ...(actions.canTimeOff ? [{ key: 'timeoff', label: 'Time Off', Icon: CalendarOff, onClick: () => onAdd('timeoff') }] : []),
    { key: 'note', label: 'Day Note', Icon: StickyNote, onClick: () => onAdd('note') },
  ];
  // Print is its own button on a desktop; Export to Excel sits under ⋯.
  const exportItem = { key: 'export', label: 'Export to Excel', Icon: Download, onClick: actions.exportFile, disabled: !ready };
  const printItem = { key: 'print', label: 'Print', Icon: Printer, onClick: actions.print, disabled: !ready };
  const saveTitle = unsharedCount ? `${unsharedCount} change${unsharedCount === 1 ? '' : 's'} your team has not seen yet. Save & Share sends them and tells the people affected.` : 'Everything is saved and shared with the team';
  // ⋯ keeps only what is used now and then (Neil, Oct 28 2026: "the 3 dots
  // is hiding too many options"). On a phone it also carries what has no
  // room on the row.
  const moreItems = [
    ...(phone && canManage ? [
      { key: 'share', label: `Save & Share${unsharedCount ? ` (${unsharedCount})` : ''}`, Icon: Send, onClick: onShare, disabled: busy || !ready, title: saveTitle },
      ...(unsharedCount ? [{ key: 'discard', label: 'Discard Changes', Icon: RotateCcw, onClick: actions.discard, disabled: busy }] : []),
      'sep',
      { key: 'fill', label: 'Fill Automatically', Icon: Wand2, onClick: actions.fill, disabled: !ready },
      { key: 'import', label: 'Import', Icon: Upload, onClick: actions.importFile, disabled: !ready },
    ] : []),
    { key: 'customize', label: 'Customize', Icon: SlidersHorizontal, onClick: actions.viewOptions },
    exportItem,
    ...(phone ? [printItem] : []),
    ...(!phone && canManage ? [{ key: 'import', label: 'Import', Icon: Upload, onClick: actions.importFile, disabled: !ready }] : []),
    'sep',
    ...(canManage ? [
      { key: 'copy', label: 'Copy Week', Icon: Copy, onClick: actions.copy, disabled: !ready },
      { key: 'clear', label: 'Clear Week', Icon: Trash2, onClick: actions.clear, disabled: !ready },
    ] : []),
    ...(!phone && actions.shortcuts ? ['sep', { key: 'keys', label: 'Keyboard Shortcuts', Icon: Keyboard, onClick: actions.shortcuts }] : []),
  ].filter((x, i, all) => x !== 'sep' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'sep'));
  const unit = viewName.toLowerCase();
  const dateNav = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <button type="button" className="sched-arrow" onClick={onPrev} aria-label={`Previous ${unit}`} title={`Previous ${unit} (Left arrow)`} style={ARROW}><ChevronLeft size={16} /></button>
      <DateBlock view={view} first={range.first} last={range.last} weekStart={range.weekStart} onPick={onJump} compact={phone} slide={slide} />
      <button type="button" className="sched-arrow" onClick={onNext} aria-label={`Next ${unit}`} title={`Next ${unit} (Right arrow)`} style={ARROW}><ChevronRight size={16} /></button>
      {showToday && <button type="button" className="sched-today" onClick={onToday} title="Today (T)" style={TODAY_BTN}>Today</button>}
    </div>
  );
  const more = moreItems.length ? (
    <MenuButton label="" Icon={MoreHorizontal} items={moreItems} ariaLabel="More" align="right" width={220} style={{ padding: phone ? '7px 9px' : '6px 8px', height: phone ? 36 : undefined }}
      badge={phone && unsharedCount > 0 ? <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--wk-brand)', marginLeft: -4 }} /> : null} />
  ) : null;
  if (phone) {
    const viewItems = VIEWS.map(([k, label]) => ({ key: k, label, hint: (view === k || (k === 'week' && view === 'twoweeks')) ? '✓' : '', onClick: () => onView(k) }));
    return (
      <div role="toolbar" aria-label="Shift Planner" style={{ marginBottom: 10, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {dateNav}
          <div style={{ flex: 1 }} />
          {canManage && <MenuButton label="" Icon={Plus} items={addItems} ariaLabel="Add" primary width={190} disabled={!ready} align="right" style={{ padding: '7px 10px', height: 36 }} />}
          {more}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {teamSwitcher}
          {!teamSwitcher && <div style={{ flex: 1 }} />}
          <MenuButton label={viewName} items={viewItems} ariaLabel="View" width={150} align="right" style={{ padding: '6px 10px', fontWeight: 700 }} />
        </div>
      </div>
    );
  }
  const BTN = { fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 };
  return (
    <div role="toolbar" aria-label="Shift Planner" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap', rowGap: 10 }}>
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
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {canManage && (
          <button type="button" className="secondary-btn" onClick={actions.fill} disabled={!ready} title="Place each person's usual hours across the dates you pick" style={BTN}>
            <Wand2 size={13} /> Fill Automatically
          </button>
        )}
        {canManage && <MenuButton label="Add" Icon={Plus} items={addItems} ariaLabel="Add" width={190} disabled={!ready} />}
        <button type="button" className="secondary-btn" onClick={actions.print} disabled={!ready} title="Print what is on screen" style={BTN}>
          <Printer size={13} /> Print
        </button>
        {more}
        {canManage && (
          <>
            <span aria-hidden="true" style={{ width: 1, height: 26, background: 'var(--line)', margin: '0 2px' }} />
            {unsharedCount > 0 && (
              <button type="button" className="secondary-btn" onClick={actions.discard} disabled={busy || !ready}
                title="Throw away the changes your team has not seen yet" style={BTN}>
                <RotateCcw size={13} /> Discard
              </button>
            )}
            <button type="button" className={unsharedCount ? 'primary-btn' : 'secondary-btn'} onClick={onShare} disabled={busy || !ready}
              title={saveTitle} aria-label={`Save & Share${unsharedCount ? `, ${unsharedCount} unsaved` : ''}`} style={BTN}>
              <Send size={13} /> Save &amp; Share
              {unsharedCount > 0 && <span style={{ fontWeight: 800, paddingLeft: 7, marginLeft: 1, borderLeft: '1px solid rgba(255,255,255,0.45)', fontVariantNumeric: 'tabular-nums' }}><RollingNumber value={unsharedCount} /></span>}
            </button>
          </>
        )}
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
  // Plain words on the team line (Neil, Oct 30 2026): "0 of 17 Confirmed ·
  // Nudge" - no chip. The count opens the list; Nudge reminds everyone
  // waiting who has not been nudged yet.
  const label = `${c.confirmed} of ${c.total} Confirmed`;
  const PLAIN = { border: 'none', background: 'none', padding: compact ? '12px 0' : '2px 0', fontFamily: 'inherit', fontSize: compact ? 12.5 : 12.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button ref={btnRef} type="button" data-confirm-chip="" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={label}
        title={all ? 'Everyone has confirmed the shared schedule' : `${c.pending.length} ${c.pending.length === 1 ? 'person has' : 'people have'} not confirmed the shared schedule yet`}
        style={{ ...PLAIN, display: 'inline-flex', alignItems: 'center', gap: 5, color: all ? 'hsl(var(--color-green))' : 'var(--ink)' }}>
        {all && <CircleCheck size={13} aria-hidden="true" />}{label}
      </button>
      {!all && waiting.length > 0 && onNudge && (
        <>
          <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
          <button type="button" data-confirm-nudge="" onClick={() => send(waiting, 'all')} disabled={!!busy} title={`Remind the ${waiting.length === 1 ? 'person' : `${waiting.length} people`} who have not confirmed`}
            style={{ ...PLAIN, color: 'var(--wk-brand)' }}>Nudge</button>
        </>
      )}
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

// Save & Share (Teams "Share with team"). Over 50 waiting changes (10/02):
// the dialog says where they are - "This week: 4 · Next week: 8 · Other
// weeks: 230" - beside the dates on screen.
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
export const REASON_MAX = 300;   // the server keeps 300 (routers/timeclock publish, shift_log)
const CHANGE_WORD = { added: 'New', changed: 'Changed', removed: 'Removed' };
const LINKISH = { background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--wk-brand)', padding: 0 };
const TH = { textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', padding: '6px 10px 6px 0', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--card)' };
const TD = { fontSize: 12.5, padding: '6px 10px 6px 0', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
// What a person sees for one change, before and after: "7:00 AM - 3:30 PM · GSV".
const seenText = (start, end, label) => `${spanText(start, end)}${label ? ` · ${label}` : ''}`;
// A warning's kind in one plain word (Oct 30 2026: no uppercase pills).
const warnWord = (w) => (w.kind !== 'conflict' ? 'Rule' : w.soft === true ? 'Heads Up' : 'Conflict');

// Save & Share, ONE dialog (Neil, Oct 30 2026): the dates and team at the
// top with Change; every change as a before / after row (Person, Day, Team
// Sees Now, After Sharing, Change); the warnings these dates carry, in
// words, each with Show On Schedule; the reason box only when the warned
// person's company asks for one (rule warnings and approved-off / holiday
// conflicts - never a heads-up); who hears about it; and one "Share next
// week too" box when the team has changes waiting right after the dates.
// The review is fetched on open and again whenever the dates or the team
// change; Share sends exactly what it shows. `memo` / `onMemo`: a Show On
// Schedule jump closes the dialog to show the cell and hands back what was
// picked and typed, restored when it reopens.
export function ShareDialog({ defaultStart, defaultEnd, defaultGroupId = '', lastPublishedAt, totalCount = 0, thisWeek = null, groups = [], busy, onPublish, onJump, onClose,
  memo = null, onMemo = null }) {
  const big = totalCount > SHARE_SUMMARY_OVER && !!thisWeek && !memo;
  // The dates on screen, always (Neil, Oct 28 2026: sharing the week he was
  // looking at opened this week instead and said there was nothing to share).
  const [from, setFrom] = useState(memo?.from || defaultStart);
  const [to, setTo] = useState(memo?.to || defaultEnd);
  const [groupId, setGroupId] = useState(memo?.groupId ?? defaultGroupId);
  const [notify, setNotify] = useState(memo?.notify || 'changed');
  const [reason, setReason] = useState(memo?.reason || '');
  const [editing, setEditing] = useState(false);   // the dates / team row open for Change
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
  // Recent shares made with warnings (Oct 15), at the foot. An older API
  // without the route: nothing shown.
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
  const badRange = !from || !to || to < from || tooLong;
  // Mounted or not: the review and the share land on a dialog that may have
  // closed. Set on mount as well as cleared on unmount - StrictMode runs the
  // cleanup once on mount, and a flag only ever cleared left the review stuck
  // with the answer thrown away.
  const liveRef = useRef(true);
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);
  // The review of exactly the dates and team picked, fetched on open and on
  // every change of them (the latest answer wins).
  const [review, setReview] = useState(memo?.review || null);     // { changes, people, warnings, reasonRequired }
  const [reviewErr, setReviewErr] = useState('');
  const [reviewing, setReviewing] = useState(!memo?.review);
  const asked = useRef(memo?.review ? `${memo.from}|${memo.to}|${memo.groupId ?? ''}` : '');
  const ticket = useRef(0);
  const loadReview = useCallback(async () => {
    const key = `${from}|${to}|${groupId}`;
    asked.current = key;
    const mine = ++ticket.current;
    setReviewing(true); setReviewErr('');
    try {
      const r = await Promise.resolve().then(() => api.timeSchedPublishReview({ start: from, end: to, ...(groupId ? { group_id: groupId } : {}) }));
      if (!liveRef.current || mine !== ticket.current) return;
      setReview({ changes: Array.isArray(r?.changes) ? r.changes : [], people: Number(r?.people) || 0, warnings: Array.isArray(r?.warnings) ? r.warnings : [], reasonRequired: r?.reasonRequired === true });
    } catch (e) {
      if (liveRef.current && mine === ticket.current) { setReview(null); setReviewErr(e?.message || 'Could not review these dates.'); }
    } finally { if (liveRef.current && mine === ticket.current) setReviewing(false); }
  }, [from, to, groupId]);
  useEffect(() => {
    if (badRange) { setReviewing(false); return; }
    if (asked.current === `${from}|${to}|${groupId}`) return;
    loadReview();
  }, [from, to, groupId, badRange, loadReview]);
  // "Share next week too": the team's changes in the 7 days after the dates.
  const [after, setAfter] = useState(null);   // { count, from, to } | null
  useEffect(() => {
    if (badRange) { setAfter(null); return undefined; }
    let live = true;
    const a = addDaysIso(to, 1), b = addDaysIso(to, 7);
    Promise.resolve().then(() => api.timeSchedUnshared(a, b, groupId))
      .then((r) => { if (live) setAfter({ count: Number(r?.count) || 0, from: a, to: b }); })
      .catch(() => { if (live) setAfter(null); });
    return () => { live = false; };
  }, [from, to, groupId, badRange]);
  const [extended, setExtended] = useState(null);   // the end date before "next week too" was ticked
  const toggleAfter = (on) => {
    if (on && after) { setExtended(to); setTo(after.to); } else if (!on && extended) { setTo(extended); setExtended(null); }
  };
  const jump = (email, date, shiftId) => {
    onMemo?.({ from, to, notify, groupId, reason, review });
    onJump?.(email, date, shiftId);
  };
  const [shareErr, setShareErr] = useState('');
  async function share() {
    setShareErr('');
    const r = await onPublish({ start_date: from, end_date: to, notify, ...(groupId ? { group_id: groupId } : {}), reason: reason.trim().slice(0, REASON_MAX) });
    if (liveRef.current && r?.error) setShareErr(r.error);
    else if (liveRef.current && r && !r.error) onMemo?.(null);
  }
  const cancel = () => { onMemo?.(null); onClose(); };
  const teamName = groupId ? (groups.find((g) => g.id === groupId)?.name || 'One team') : (groups.length ? 'Every team' : '');
  const changes = review?.changes || [];
  const warnings = review?.warnings || [];
  const needReason = !!review?.reasonRequired && warnings.length > 0;
  const ready = !!review && !reviewing && !badRange;
  const opt = (value, title, hint) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
      <input type="radio" name="share-notify" checked={notify === value} onChange={() => setNotify(value)} style={{ marginTop: 3 }} />
      <span><div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div><div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div></span>
    </label>
  );
  const SECTION = { borderTop: '1px solid var(--line)', paddingTop: 12 };
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && cancel()}>
      <div role="dialog" aria-label="Save & Share" className="nx-popup" style={{ ...MODAL_CARD, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <DialogHead title="Save & Share" onClose={cancel} />
        <div className="nx-fill" style={{ overflowY: 'auto', gap: 14, paddingTop: 6, marginRight: -8, paddingRight: 8 }}>
          {/* The dates and the team, with Change. */}
          <div data-share-scope="">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{from ? `${formatWeekday(from, 'short')} ${formatDate(from)}` : '-'} - {to ? `${formatWeekday(to, 'short')} ${formatDate(to)}` : '-'}</span>
              {teamName && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{teamName}</span>}
              <button type="button" onClick={() => setEditing((o) => !o)} aria-expanded={editing} style={LINKISH}>{editing ? 'Done' : 'Change'}</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              The team sees new, edited and removed shifts in these dates once you share.
              {lastPublishedAt ? ` Last shared ${formatDateTime(lastPublishedAt)}.` : ' Not shared yet.'}
            </div>
            {big && (
              <div data-share-summary="" style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
                <strong style={{ color: 'var(--ink)' }}>{totalCount} changes are waiting.</strong>{' '}
                {byWeek ? `This week: ${byWeek.tw} · Next week: ${byWeek.nw} · Other weeks: ${byWeek.other}` : 'Counting by week...'}
              </div>
            )}
            {editing && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <label style={{ flex: '1 1 160px' }}><div style={LBL}>From</div>
                  <DateField value={from} onChange={(v) => { setFrom(v || ''); setExtended(null); }} placeholder="MM/DD/YYYY" title="Share from" style={{ width: '100%', fontSize: 13 }} /></label>
                <label style={{ flex: '1 1 160px' }}><div style={LBL}>To</div>
                  <DateField value={to} onChange={(v) => { setTo(v || ''); setExtended(null); }} placeholder="MM/DD/YYYY" title="Share to" style={{ width: '100%', fontSize: 13 }} /></label>
                {groups.length > 0 && (
                  <label style={{ flex: '1 1 200px' }}><div style={LBL}>Team</div>
                    <select className="form-input" aria-label="Share group" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                      <option value="">Every team</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            {(tooLong || (from && to && to < from)) && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginTop: 6 }}>{tooLong ? 'Share at most 92 days at a time.' : 'The end is before the start.'}</div>}
          </div>

          {reviewErr && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{reviewErr}</div>}
          {!review && reviewing && <div aria-busy="true" style={{ fontSize: 12.5, color: 'var(--muted)' }}>Reviewing the changes...</div>}

          {review && (
            <div style={{ ...SECTION, opacity: reviewing ? 0.6 : 1 }}>
              <div data-review-summary="" style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{reviewSummary(changes, review.people)}</div>
              {changes.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table data-review-changes="" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr><th style={TH}>Person</th><th style={TH}>Day</th><th style={TH}>Team Sees Now</th><th style={TH}>After Sharing</th><th style={TH}>Change</th></tr>
                    </thead>
                    <tbody>
                      {changes.map((c, i) => {
                        const before = c.kind === 'added' ? '' : c.kind === 'removed' ? seenText(c.start, c.end, c.label) : c.was ? seenText(c.was.start, c.was.end, c.was.label) : '';
                        const afterText = c.kind === 'removed' ? '' : seenText(c.start, c.end, c.label);
                        return (
                          <tr key={`${c.shiftId || ''}|${c.date}|${c.kind}|${i}`} data-change={c.kind}>
                            <td style={{ ...TD, fontWeight: 600 }}>{c.name}</td>
                            <td style={{ ...TD, whiteSpace: 'nowrap' }}>{dayText(c.date)}</td>
                            <td style={{ ...TD, color: before ? 'var(--ink)' : 'var(--muted)', textDecoration: c.kind === 'removed' ? 'line-through' : undefined }}>{before || 'Nothing'}</td>
                            <td style={{ ...TD, color: afterText ? 'var(--ink)' : 'var(--muted)' }}>{afterText || 'Nothing'}</td>
                            <td style={{ ...TD, fontWeight: 700, whiteSpace: 'nowrap' }}>{CHANGE_WORD[c.kind] || c.kind}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {review && (
            <div data-review-warnings-box="" style={SECTION}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{warnings.length ? `Warnings (${warnings.length})` : 'Warnings'}</div>
              {warnings.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No warnings.</div>
              ) : (
                <>
                  <div data-review-warnings="" style={{ display: 'grid' }}>
                    {warnings.map((w, i) => {
                      const word = warnWord(w);
                      return (
                        <div key={`${w.date}|${w.shiftId || ''}|${i}`} data-warning={word} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
                          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, alignSelf: 'center', background: word === 'Heads Up' ? 'var(--muted)' : 'hsl(var(--color-orange))' }} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <strong>{w.name}</strong> <span style={{ color: 'var(--muted)' }}>· {dayText(w.date)} · {word}</span>
                            <div>{w.text}</div>
                          </span>
                          {onJump && <button type="button" onClick={() => jump(w.email, w.date, w.shiftId)} style={{ ...LINKISH, whiteSpace: 'nowrap', flexShrink: 0 }}>Show On Schedule</button>}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Warnings never block sharing.</div>
                </>
              )}
            </div>
          )}

          {needReason && (
            <label style={{ ...SECTION, display: 'block' }}><div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Reason For Sharing With Warnings</div>
              <textarea className="form-input" rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))} required aria-label="Reason for sharing with warnings"
                placeholder="e.g. Short-staffed this week; overtime approved" style={{ width: '100%', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                <span style={{ flex: 1 }}>Managers see this reason in the history of the shifts it applies to.</span>
                {reason.length >= REASON_MAX - 50 && <span data-reason-count="" style={{ color: reason.length >= REASON_MAX ? 'hsl(var(--color-red))' : 'var(--muted)', flexShrink: 0 }}>{reason.length}/{REASON_MAX}</span>}
              </div>
            </label>
          )}

          <div style={SECTION} role="radiogroup" aria-label="Who hears about it">
            <div style={{ fontSize: 13, fontWeight: 700 }}>Who Hears About It</div>
            {opt('changed', 'Only people whose shifts changed', 'Each gets a notification and an email listing their own changes.')}
            {opt('team', 'The whole team', 'The same, plus a short notification to everyone else on the schedule for these dates.')}
          </div>

          {(after?.count > 0 || extended) && (
            <label data-share-after="" style={{ ...SECTION, display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={!!extended} onChange={(e) => toggleAfter(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                <span style={{ fontWeight: 700 }}>Share next week too</span>
                {!extended && after && <span style={{ color: 'var(--muted)' }}> - {after.count} change{after.count === 1 ? '' : 's'} ({[teamName, `${formatDate(after.from)} - ${formatDate(after.to)}`].filter(Boolean).join(', ')})</span>}
                {extended && <span style={{ color: 'var(--muted)' }}> - the dates now run to {formatDate(to)}</span>}
              </span>
            </label>
          )}

          {recent?.length > 0 && <div style={SECTION}><RecentShares shares={recent} /></div>}
          {shareErr && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{shareErr}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, paddingTop: 14, marginTop: 4, borderTop: '1px solid var(--line)', justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={cancel}>Cancel</button>
          <button type="button" className="primary-btn" onClick={share}
            disabled={busy || !ready || changes.length === 0 || (needReason && !reason.trim())}>{busy ? '…' : 'Share'}</button>
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
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Recent Shares</div>
      <div style={{ display: 'grid', gap: 5, maxHeight: 150, overflowY: 'auto' }}>
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

// A note on one day, for the whole team or one group (Teams "day notes").
export function DayNoteDialog({ date, groups = [], notes = [], busy, onSave, onClose, onDateChange }) {
  const [groupId, setGroupId] = useState('');
  const existing = notes.find((n) => n.date === date && (n.groupId || '') === groupId);
  const [text, setText] = useState(existing?.note || '');
  useEffect(() => { setText(existing?.note || ''); }, [existing?.note, groupId, date]);
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Day Note" className="nx-popup" style={{ ...MODAL_CARD, display: 'flex', flexDirection: 'column' }}>
        <DialogHead title="Day Note" onClose={onClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Everyone on the schedule sees this on the day, here and in My Shifts.</div>
        <div className="nx-fill" style={{ gap: 12 }}>
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
// Customize (Neil, Oct 28 2026: "a Customize button that allows for all
// customizations"): everything about what the schedule shows, in one place -
// Hide People Without Shifts and Show Coverage moved here from ⋯.
export function ViewOptionsDialog({ prefs, onPrefs, query, onQuery, groupBy, onGroupBy, presetFilter, onPresetFilter, presets = [], twoWeeks, onTwoWeeks, canViewByShift,
  coverage = null, onCoverage = null, onClose }) {
  const set = (k, v) => onPrefs({ ...prefs, [k]: v });
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Customize" className="nx-popup" style={MODAL_CARD}>
        <DialogHead title="Customize" onClose={onClose} />
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
              <label style={CHECK}><input type="checkbox" checked={!prefs.hideEmpty} onChange={(e) => set('hideEmpty', !e.target.checked)} aria-label="Show people without shifts" /> People Without Shifts</label>
              {onCoverage && <label style={CHECK}><input type="checkbox" checked={!!coverage} onChange={(e) => onCoverage(e.target.checked)} aria-label="Show coverage" /> Coverage</label>}
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
