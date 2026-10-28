import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ArrowRight, ArrowDown, Pencil, Plus, X, CheckCircle, Download, AlertTriangle, MapPin, MapPinOff, Info, SlidersHorizontal, Lock, Printer, ClipboardList } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime, formatMonthDayNumeric } from '../lib/datetime';
import { useDisplayTz, formatTimeTz, utcToInputTz, inputToUtcTz, tzOffsetForInput, useOwnZone, useEmployeeZone } from '../lib/displayTz';
import { dialog } from '../ui/dialog';
import { useWorkSites } from '../lib/queries';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { takePendingOpen } from '../lib/pendingOpen';
import { useRole } from '../contexts/RoleContext';
import GuidedTour from './GuidedTour';
import WorkLogDrawer, { WorkLogButton } from './WorkLogDrawer';
import { useIsMobile } from '../lib/useIsMobile';
import { PHONE_QUERY } from '../lib/keys';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import TimesheetReviewPanel from './TimesheetReviewPanel';
import ChoicePills from './ChoicePills';
import { InvoiceCard } from './ContractorInvoices';
import { CreditCell, ExtraTimeCell, ExtraTimeClaimModal, ExtraTimeDecideModal, ReconciliationPanel } from './ExtraTime';
import { hm } from '../lib/extraTime';
import BreakPremiums from './BreakPremiums';
import TimecardBonuses from './TimecardBonuses';
import TimeSheetAdvances, { AskAdvanceButton, useTimeSheetAdvances } from './TimeSheetAdvances';
import GeofencePunchModal from './GeofencePunchModal';
import AddTimeModal from './AddTimeModal';
import AddTimeFromRecordModal from './AddTimeFromRecordModal';
import RecordTag from './RecordTag';
import { recordOf } from '../lib/duplicateDay';
import AnchoredMenu from './AnchoredMenu';
import { Spinner } from './AsyncState';
import { Modal, DateField } from '../tasks/components';
import EmployeeCombobox from './EmployeeCombobox';
import { downloadBlob } from './accounting/reportModel';
import { formatDistance } from '../lib/distance';
import { usePhotoMap } from '../lib/peoplePhotos';
import { moneyPrefix } from '../asset/lib/currency';
import { registerTour } from '../lib/tours';
import { confirmExportReadiness } from '../lib/payrollReadiness';
import { checkLongShift, checkTypedPunches } from '../lib/longShift';
import LongShiftWarning from './LongShiftWarning';
import { readRefresh, saveRefresh } from '../lib/refreshState';

// Launch (Neil, 10/16): the only sign-off is review + Nexus Sign, so the HR
// "Finalize Without Signatures" override is hidden. Flip to true to show it.
// Your OWN card opened from People > Time (Oct 20): the server refuses a
// manager's or HR's approvals and direct edits on their own time
// (_refuse_own_time), so the card hides them and says where fixes go.
const OWN_CARD_HINT = 'Your manager or HR approves your time - send a punch fix request from Workday > Time Sheet.';
function OwnCardHint() {
  return (
    <div data-testid="own-card-hint" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--ink)', background: 'var(--wk-hover)', border: '1px solid var(--wk-line2)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
      <Lock size={13} style={{ flexShrink: 0 }} /> {OWN_CARD_HINT}
    </div>
  );
}
const LEGACY_FINALIZE = false;

// ── Payroll timecard (SwipeClock 1:1, manager-editable) ───────────────────────
// One employee, one pay period (biweekly, SUNDAY-anchored on SwipeClock's real
// payroll calendar - site 47239: 7/26/26–8/8/26). Same column order as the
// SwipeClock card, punch times rounded to the nearest 5 minutes exactly like
// SwipeClock (raw times one toggle away), CA overtime split, wage totals.

const ANCHOR = Date.UTC(2024, 0, 14);  // a Sunday on SwipeClock's period series
const DAY = 86400000;
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
const monthName = (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });   // "October 2026"
const hhmm = (min) => `${Math.floor((min || 0) / 60)}:${String((min || 0) % 60).padStart(2, '0')}`;
const dec = (min) => ((min || 0) / 60).toFixed(2);
const money = (n, cur = 'USD') => `${moneyPrefix(cur)}${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Punch kinds as they read in a request line. Breaks are requestable too
// (BreakFixModal), so nothing here may assume in/out.
const PR_KIND_LABEL = { in: 'clock-in', out: 'clock-out', break_start: 'break start', break_end: 'break end' };
const t12 = (iso) => iso ? formatTimeTz(iso) : '-';
const utcToInput = (iso) => utcToInputTz(iso);
const inputToUtc = (v) => inputToUtcTz(v);
const tzFor = (v) => tzOffsetForInput(v);
// What a block of time IS, picked as its Type (Neil, Oct 13): Regular, Break,
// then the leave types. "Sick", not "Sick Day" - someone can be sick for an
// hour. The server reads the category the same way (_leave_class), so an old
// "Sick Day" category still counts as sick.
const LEAVE_TYPES = ['Sick', 'Vacation', 'Personal'];
const typeOfCategory = (c) => /\bsick\b/i.test(c || '') ? 'Sick'
  : /\b(vacation|pto|paid time off|annual leave)\b/i.test(c || '') ? 'Vacation'
  : /\bpersonal\b/i.test(c || '') ? 'Personal' : 'Regular';

// No California / India toggle (removed Oct 28 2026 - a card flipped to the
// wrong zone kept reading wrong times): a card always shows the EMPLOYEE's
// zone (lib/displayTz.js useEmployeeZone / useOwnZone).

// One switch inside the Options panel: the label, what it does, and the tick.
function OptionSwitch({ checked, label, hint, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', padding: '5px 0' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{hint}</span>}
      </span>
    </label>
  );
}

// Display choices and pay rules behind one button. `children` are the
// company-wide pay rules (admins only); the display choices are everyone's.
function TimecardOptions({ showRaw, setShowRaw, children }) {
  const [open, setOpen] = useState(false);
  // Portaled panel (AnchoredMenu): closes on an outside tap or Escape, and no
  // scrolling toolbar or card can clip it on a phone.
  const btn = useRef(null);
  const rules = [].concat(children || []).filter(Boolean);
  return (
    <div>
      <button ref={btn} type="button" data-tour="pr-rounding" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        title="Unrounded times"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontWeight: 700, fontSize: 12, cursor: 'pointer', color: 'var(--ink)' }}>
        <SlidersHorizontal size={14} /> Options
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" role="dialog" aria-label="Time Sheet options"
        style={{ width: 320, background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '12px 14px' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Display</div>
        <OptionSwitch checked={showRaw} onChange={setShowRaw} label="Show unrounded times"
          hint="See the raw punch times. Totals stay computed from the rounded times." />
        {rules.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 0 4px', paddingTop: 10, borderTop: '1px solid var(--wk-line2)' }}>Pay Rules</div>
            {rules}
          </>
        )}
      </AnchoredMenu>
    </div>
  );
}

// Internal punch markers that are NOT reasons meant for the reader (e.g. the tag
// a +added punch carries). Never surfaced on the card.
const _INTERNAL_NOTES = new Set(['payroll edit']);
const cleanNote = (n) => { const t = (n || '').trim(); return t && !_INTERNAL_NOTES.has(t.toLowerCase()) ? t : ''; };
// The human reason(s) attached to a segment's punches: a pending employee edit,
// an HR adjust note, or a punch note - minus internal markers. Empty = not edited.
// A note the server wrote with an email in it ("approved by x@y.com") reads
// with the person's name (Pranshu, Oct 17); new notes carry the name already.
const namesIn = (text, nameFor) => String(text || '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => nameFor(m) || m);

// The in and the out punch usually carry the SAME note (an approved fix
// stamps both; a note written on a shift lands on both), so each distinct
// text reads once (Pranshu, Oct 17: "why is it coming 2 times?").
const segReasons = (s) => {
  const out = [];
  if (s.inEditStatus === 'pending' && s.inEditReason) out.push(`Proposed in-time: ${s.inEditReason}`);
  if (s.outEditStatus === 'pending' && s.outEditReason) out.push(`Proposed out-time: ${s.outEditReason}`);
  [s.inAdjustNote, s.outAdjustNote, ...String(s.note || '').split(' · ')].forEach(n => { const c = cleanNote(n); if (c && !out.includes(c)) out.push(c); });
  return out;
};

// A break as a row of its own under its shift (Pranshu, Oct 16): Nexus records
// a break's start and end as punches, so the row reads In = start, Out = end
// (Missing when the clock-out closed it). The pseudo-segment lets InlineTime
// show and edit the two break punches like any other.
export const breakSeg = (b) => ({ in: b.start, inR: b.start, inId: b.startId, out: b.implicit ? '' : b.end, outR: b.implicit ? '' : b.end, outId: b.endId, workedMin: b.min, flags: [], breaks: [] });

// The hourly card's shift as SwipeClock punch pairs (Charmi / Visesh, Oct 20):
// one row per stretch of work - In is the clock-in or a break end, Out is a
// break start or the clock-out - with a thin break line between two rows.
// DISPLAY ONLY: the shift's paid minutes (seg.workedMin, from the server) are
// split over its rows so they always add back up to it exactly - rounding and
// a paid CA rest break land on the last complete row - and the shift's OT /
// wage / location / pending edits stay on the shift (r.base). Items:
//   { kind: 'work', seg, k, fromBreak }  a row (fromBreak = its In ended a break)
//   { kind: 'gap', brk }                 the break between two rows
//   { kind: 'open', at, now }            a break with no end and no clock-out yet
//                                        (now = the person's latest shift: on break)
//   { kind: 'auto', min }                an auto-deducted lunch (no punches)
const _minsBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : 0);
const _IN_ONLY = { geo: '', workSite: '', workSiteId: '', distance: 0, inPendingAt: '', inEditStatus: '', inEditReason: '', inAdjustNote: '' };
const _OUT_ONLY = { geoOut: '', workSiteOut: '', workSiteOutId: '', distanceOut: 0, outPendingAt: '', outEditStatus: '', outEditReason: '', outAdjustNote: '', flags: [] };
export const workStretches = (seg, punchMeta = {}) => {
  const brks = seg.in ? (seg.breaks || []) : [];
  // On a break right now: the open shift's last punch is a break start the
  // server has not paired (it lists only closed breaks).
  let open = null;
  if (seg.in && !seg.out) {
    const taken = new Set(brks.map(b => b.startId));
    const t0 = new Date(seg.in).getTime();
    const later = Object.entries(punchMeta).filter(([, m]) => m?.at && new Date(m.at).getTime() > t0)
      .sort((a, b) => new Date(a[1].at) - new Date(b[1].at));
    // ...this shift's punches only: a later clock-in starts another shift.
    const nextIn = later.findIndex(([, m]) => m.kind === 'in');
    const mine = nextIn < 0 ? later : later.slice(0, nextIn);
    const lastP = mine[mine.length - 1];
    if (lastP && lastP[1].kind === 'break_start' && !taken.has(lastP[0])) open = { at: lastP[1].at, id: lastP[0], now: nextIn < 0 };
  }
  if (!brks.length && !open) {
    const one = [{ kind: 'work', seg, k: 0, fromBreak: false }];
    if (seg.deductedMin > 0) one.push({ kind: 'auto', min: seg.deductedMin });
    return one;
  }
  const pts = [{ at: seg.in, atR: seg.inR || seg.in, id: seg.inId }];
  brks.forEach(b => {
    pts.push({ at: b.start, id: b.startId, brk: b });
    pts.push({ at: b.implicit ? '' : b.end, id: b.implicit ? '' : b.endId, fromBreak: true });
  });
  if (open) pts.push({ at: open.at, id: open.id });
  else pts.push({ at: seg.out, atR: seg.outR || seg.out, id: seg.outId, out: true });
  const work = [];
  for (let i = 0; i < pts.length; i += 2) {
    const a = pts[i], b = pts[i + 1];
    const first = i === 0, last = i + 2 >= pts.length && !open;
    // A break punch's own pending edit / change note (punchMeta): without it an
    // employee's proposed time on a break start or end was saved but never
    // showed, so "nothing happened" (Miranda, Oct 20).
    const ma = first ? null : punchMeta[a.id], mb = last ? null : punchMeta[b.id];
    work.push({ ...seg, ...(first ? {} : _IN_ONLY), ...(last ? {} : _OUT_ONLY),
      ...(ma ? { inPendingAt: ma.pendingAt || '', inEditStatus: ma.editStatus || '', inEditReason: ma.editReason || '', inAdjustNote: ma.adjustNote || '' } : {}),
      ...(mb ? { outPendingAt: mb.pendingAt || '', outEditStatus: mb.editStatus || '', outEditReason: mb.editReason || '', outAdjustNote: mb.adjustNote || '' } : {}),
      in: a.at, inR: a.atR || a.at, inId: a.id, out: b.at, outR: b.atR || b.at, outId: b.id,
      // the shift's pay figures ride on the shift, never on a row
      otMin: 0, dtMin: 0, amount: 0, deductedMin: 0, breaks: [],
      workedMin: (a.at && b.at) ? _minsBetween(a.atR || a.at, b.atR || b.at) : 0,
      _fromBreak: !!a.fromBreak, _brkAfter: b.brk || null });
  }
  // Rows add up to the shift's paid minutes, always: the difference (rounding,
  // a paid rest break) goes on the last complete row; a shift paying 0 (no
  // clock-out yet, or held at an auto clock-out) has 0 on every row.
  const paid = Math.max(0, seg.workedMin || 0);
  if (!paid) work.forEach(w => { w.workedMin = 0; });
  else {
    let diff = paid - work.reduce((s, w) => s + w.workedMin, 0);
    for (let j = work.length - 1; j >= 0 && diff !== 0; j--) {
      if (!work[j].in || !work[j].out) continue;
      const nv = Math.max(0, work[j].workedMin + diff);
      diff -= nv - work[j].workedMin;
      work[j].workedMin = nv;
    }
  }
  const items = [];
  work.forEach((w, k) => {
    const { _fromBreak, _brkAfter, ...row } = w;
    items.push({ kind: 'work', seg: row, k, fromBreak: _fromBreak });
    if (_brkAfter) items.push({ kind: 'gap', brk: _brkAfter });
  });
  if (open) items.push({ kind: 'open', at: open.at, now: open.now });
  return items;
};

// "Break 15 min (1:08pm - 1:23pm)": the line between two rows.
const breakLen = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

// Snap any instant onto the pay-period series: the boundary Sunday at-or-before
// it, computed ENTIRELY in UTC. pStart is always one of these UTC instants.
const snapPeriodUTC = (t) => new Date(ANCHOR + Math.floor((t - ANCHOR) / (14 * DAY)) * 14 * DAY);

// One reason on the fixed-salary Missed days line: "Sick ×2", "Sick ×2 + 1 half", "Sick ×1 half".
export const missedText = (m) => (m.full && m.half ? `${m.label} ×${m.full} + ${m.half} half`
  : m.full ? `${m.label} ×${m.full}` : `${m.label} ×${m.half} half`);

function periodStartFor(date) {
  // The viewer's local CALENDAR date, re-expressed as a UTC midnight, then a
  // pure-UTC snap. The old version mixed a LOCAL-midnight Sunday into division
  // against the UTC anchor: the viewer's offset made the quotient fractional,
  // the floor drifted a whole period, and every arrow press re-derived through
  // the same broken round-trip - back skipped the previous period entirely and
  // forward re-floored onto the SAME period, so it looked dead (Beth, Aug 10:
  // could never reach Aug 3-7 to fix a missed clock-out).
  const d = new Date(date);
  return snapPeriodUTC(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

// HR unlocked a finalized period to correct it (Neil, Oct 22 2026): who, when, why.
function CorrectionChip({ review, nameFor }) {
  const c = review.correction || {};
  return (
    <span data-correction title={c.reason ? `Why: ${c.reason}` : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>
      <Lock size={12} /> Unlocked by {nameFor(c.by) || 'HR'}{c.at ? ` on ${formatDate(c.at)}` : ''} - HR Only Until Signed Again
    </span>
  );
}

// Pay period finder (Neil, Oct 21 2026) - SwipeClock's "Select Other Periods".
// The period label is the button; `periods` is newest first ({ key, label,
// current, open, pick }) and `goTo(iso)` jumps to the period holding a date.
// The backend only reads whole periods, so there is no custom range.
function PeriodFinder({ label, minWidth, periods, goTo, fill = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    // The Go to Date calendar is a portal (data-nx-calendar) - a click in it is not outside.
    const onDoc = (e) => { if (!ref.current?.contains(e.target) && !e.target.closest?.('[data-nx-calendar]')) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', ...(fill ? { flex: 1, minWidth: 0 } : {}) }}>
      <button type="button" aria-label="Pick a pay period" aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ fontSize: fill ? 11.5 : 12.5, fontWeight: 700, minWidth: fill ? 0 : minWidth, width: fill ? '100%' : undefined, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: fill ? 2 : 3, padding: fill ? '4px 2px' : '4px 6px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--wk-font)', color: 'var(--ink)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span><ChevronDown size={fill ? 12 : 14} style={{ flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, boxShadow: 'var(--wk-shadow)', zIndex: 50, padding: 10, minWidth: 260 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--muted)', marginBottom: 6 }}>Select a Pay Period</div>
          <div role="radiogroup" aria-label="Pay periods" style={{ maxHeight: 280, overflowY: 'auto' }}>
            {periods.map(p => (
              <button key={p.key} type="button" role="radio" aria-checked={p.open} onClick={() => { p.pick(); setOpen(false); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 'none', borderRadius: 8, fontSize: 12.5, fontFamily: 'var(--wk-font)', cursor: 'pointer', whiteSpace: 'nowrap', background: p.open ? 'var(--wk-brand-tint)' : 'transparent', color: p.open ? 'var(--wk-brand)' : 'var(--ink)', fontWeight: p.open ? 700 : 500 }}>
                {p.label}{p.current ? ' (current)' : ''}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
            <span style={{ fontWeight: 700 }}>Go to Date</span>
            <DateField value="" onChange={(iso) => { if (iso) { goTo(iso); setOpen(false); } }} placeholder="MM/DD/YYYY" title="Go to Date"
              style={{ flex: 1, border: '1px solid var(--wk-line2)', borderRadius: 8, padding: '4px 8px' }} />
          </div>
        </div>
      )}
    </div>
  );
}

// Location cell - the punch's work site + an at-site/off-site pin (SwipeClock "Loc").
// A punch made with location sharing OFF is called out explicitly (the red
// slashed pin Charmi showed from SwipeClock, Aug 21) - not folded into "-".
//
// Every punch is judged on its own coordinates against the sites the person is
// on the company list (Sep 30): inside one -> that site's name; inside none ->
// "Out of Location". The nearest site is only a hint in the tooltip -
// showing it as the location read as "she was at Menifee" when she was not.
const distText = (m) => formatDistance(m);   // miles / feet (lib/distance.js)
function outOfLocationHint(site, dist) {
  return site ? `Not inside any company location. Nearest: ${site}, ${distText(dist || 0)} away.` : 'Not inside any company location.';
}
// Clickable (Sep 30 - "still not able to click on locations"): the cell was
// only ever a tooltip, so nothing happened on click. With `onOpen` every chip -
// a site name, Out of Location, No Location, the Out-punch tail - is one
// button that opens that shift's punches on the Geofence Punch map.
const locChipBtn = {
  background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', textAlign: 'left',
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%',
};
export function LocCell({ seg, onOpen }) {
  if (!seg) return <span style={{ color: 'var(--muted)' }}>-</span>;
  const geo = seg.geo || '';
  const site = seg.workSite || '';
  // The Out punch is judged on its own (Sep 25): call it out when it differs.
  const geoOut = seg.geoOut || '';
  const outDiffers = !!seg.out && geoOut && (geoOut !== geo || (seg.workSiteOut || '') !== site);
  const outTail = outDiffers ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: geoOut === 'out_of_fence' ? '#b45309' : (geoOut === 'no_location' || geoOut === 'location_off') ? '#b91c1c' : 'var(--muted)' }}
      title={geoOut === 'out_of_fence' ? `Out punch: ${outOfLocationHint(seg.workSiteOut, seg.distanceOut)}` : geoOut === 'no_location' ? 'Out punch: no location shared' : geoOut === 'location_off' ? 'Out punch: location was turned off in the browser' : geoOut === 'no_site' ? 'Out punch: none of their locations is on the map yet' : geoOut === 'low_accuracy' ? 'Out punch: only a rough location (no GPS) - too rough to tell which site' : `Out punch: ${seg.workSiteOut || geoOut}`}>
      <ArrowRight size={10} /> {geoOut === 'out_of_fence' ? 'Out of Location' : geoOut === 'no_location' ? 'Out: No Location' : geoOut === 'location_off' ? 'Out: Location Off' : geoOut === 'no_site' ? 'Out: no site mapped' : geoOut === 'low_accuracy' ? 'Out: approx.' : (seg.workSiteOut || (geoOut === 'remote' ? 'Remote' : 'Out'))}
    </span>
  ) : null;
  let chip, title, style = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 };
  if (geo === 'location_off') {
    style = { ...style, color: '#b91c1c', fontWeight: 700 };
    title = 'Location was turned off for Nexus in the browser - the person punched without sharing it.';
    chip = <><MapPinOff size={12} style={{ flexShrink: 0 }} /> <span className="loc-chip-text">Location Off</span>{outTail}</>;
  } else if (geo === 'no_location') {
    style = { ...style, color: '#b91c1c', fontWeight: 700 };
    title = 'No location was shared for this punch - the browser could not get one, or the person skipped it.';
    chip = <><MapPinOff size={12} style={{ flexShrink: 0 }} /> <span className="loc-chip-text">No Location</span>{outTail}</>;
  } else if (geo === 'out_of_fence') {
    style = { ...style, color: '#b45309', fontWeight: 700 };
    title = outOfLocationHint(site, seg.distance);
    chip = <><MapPin size={12} style={{ flexShrink: 0 }} /> <span className="loc-chip-text">Out of Location</span>{outTail}</>;
  } else if (geo === 'no_site') {
    style = { ...style, color: 'var(--muted)' };
    title = 'Location was shared, but none of their locations is on the map yet. Map it under Settings - Companies - Locations.';
    chip = <><MapPin size={12} style={{ flexShrink: 0 }} /> <span className="loc-chip-text">No Site Mapped</span>{outTail}</>;
  } else if (geo === 'low_accuracy') {
    // A rough location (no GPS - a desktop's IP/Wi-Fi fix, worse than ±500 m) is
    // too coarse to put the punch at any site. It used to print the NEAREST site's
    // name here with a grey pin, which read as "she was at Menifee" when she was in
    // Temecula (Charmi, Sep 29). Say what it is; the nearest site is a hint only.
    style = { ...style, color: 'var(--muted)' };
    title = `This punch came with only a rough location (no GPS on the device), too rough to tell which location it was at.${site ? ` Nearest location to that rough point: ${site}.` : ''} Punching from a phone gives a precise location.`;
    chip = <><MapPin size={12} style={{ flexShrink: 0 }} /> <span className="loc-chip-text">Approx. Location</span>{outTail}</>;
  } else if (!site) {
    if (!outTail) return <span style={{ color: 'var(--muted)' }}>-</span>;
    chip = outTail;
    title = '';
  } else {
    const color = geo === 'in_fence' ? 'hsl(var(--color-green))' : 'var(--muted)';
    title = site;
    chip = (
      <>
        <MapPin size={12} style={{ color, flexShrink: 0 }} />
        <span className="loc-chip-text" style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
          {site}
        </span>
        {outTail}
      </>
    );
  }
  if (!onOpen) return <span style={style} title={title || undefined}>{chip}</span>;
  return (
    <button type="button" className="loc-chip" onClick={(e) => { e.stopPropagation(); onOpen(seg); }}
      title={`${title ? `${title} - ` : ''}Click to see this punch on the map`}
      aria-label={`Open the punch location map${site && geo === 'in_fence' ? ` - ${site}` : ''}`}
      style={{ ...locChipBtn, ...style }}>
      {chip}
    </button>
  );
}

// Profile picture in the employee list (Neil, Oct 12) - the curated Nexus
// People photo, initials when there is none. Same source as every avatar.
function SideAvatar({ name, email, photos, size = 24 }) {
  const photo = email ? photos[email.toLowerCase()] : '';
  const initials = (name || email || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  if (photo) return <img src={photo} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.4), fontWeight: 700 }}>
      {initials}
    </span>
  );
}

// Whose Time Sheet this is (Neil, Oct 29 2026): "a larger name, a larger
// profile picture and a clear pay period below it" at the top of the card,
// not a dropdown - picking someone else happens in the list on the left.
function PersonHeader({ name, email, photos, period }) {
  return (
    <div data-testid="timesheet-person" style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <SideAvatar name={name} email={email} photos={photos} size={48} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>Pay Period: <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{period}</strong></div>
      </div>
    </div>
  );
}

// Notes cell (Charmi, Sep 29): a manager/HR note on the day, one per day,
// edited in place. Enter or clicking away saves, Esc cancels, an emptied note
// is removed. The manager/HR note is never shown on the employee's own
// timecard; the employee's OWN note (Neil, Oct 12) uses the same cell with
// `placeholder` / `addLabel` set, and the manager sees it under theirs.
function NoteCell({ date, note, onSave, locked, placeholder = 'Add a note', addLabel = '+ Add Note', lines = 2, maxWidth = 220 }) {
  const saved = note?.note || '';
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  // One save at a time: Enter saves, and the box then losing focus fired a
  // second save of the same note mid-flight - the two raced into a 500.
  const savingRef = useRef(false);
  useEffect(() => { if (!editing) setText(saved); }, [saved, editing]);
  const save = async () => {
    if (savingRef.current) return;
    const t = text.trim();
    if (t === saved) { setEditing(false); return; }
    savingRef.current = true;
    setBusy(true);
    const ok = await onSave(date, t);
    savingRef.current = false;
    setBusy(false);
    if (ok) setEditing(false);
  };
  if (editing) return (
    <textarea className="form-input" autoFocus rows={2} value={text} disabled={busy}
      aria-label={`Note for ${formatDate(date)}`} placeholder={placeholder}
      onChange={e => setText(e.target.value)} onBlur={save}
      onKeyDown={e => {
        if (e.key === 'Escape') { setText(saved); setEditing(false); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      }}
      style={{ fontSize: 12, width: '100%', minWidth: 150, resize: 'vertical', fontFamily: 'inherit', padding: '5px 7px' }} />
  );
  const who = note?.by ? `\n- ${note.by}${note.at ? `, ${formatDate(note.at)}` : ''}` : '';
  return (
    <button type="button" onClick={() => !locked && setEditing(true)} disabled={locked}
      title={saved ? `${saved}${who}` : (locked ? '' : placeholder)}
      style={{ background: 'none', border: 'none', padding: 0, cursor: locked ? 'default' : 'pointer', textAlign: 'left',
        fontFamily: 'inherit', fontSize: 12, lineHeight: 1.35, color: saved ? 'var(--ink)' : 'var(--muted)', opacity: saved ? 1 : 0.6,
        width: '100%', maxWidth, overflow: 'hidden', whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>
      {saved || (locked ? '-' : addLabel)}
    </button>
  );
}

// Add Note from the toolbar (Pranshu, Oct 16 - the per-day pencils cluttered
// the grid): pick the day, write (or rewrite, or clear) its note.
function NoteModal({ dates, dow, self, noteFor, onSave, onClose, toastOk }) {
  const [date, setDate] = useState(dates[0]);
  const [text, setText] = useState(() => noteFor(dates[0]));
  const [busy, setBusy] = useState(false);
  const pick = (d) => { setDate(d); setText(noteFor(d)); };
  const save = async () => {
    setBusy(true);
    const ok = await onSave(date, text.trim());
    setBusy(false);
    if (ok) { toastOk?.(text.trim() ? 'Note saved.' : 'Note removed.'); onClose(); }
  };
  const pill = { borderRadius: 999, padding: '6px 16px', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 700 };
  return (
    <Modal title={self ? 'Add a Note for Your Manager' : 'Add a Note'} onClose={onClose} isDirty={text !== noteFor(date)} onSave={save}
      footer={<>
        <button type="button" onClick={onClose} style={{ ...pill, border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)' }}>Cancel</button>
        <button type="button" onClick={save} disabled={busy} style={{ ...pill, border: 'none', background: 'var(--wk-brand)', color: '#fff' }}>Save Note</button>
      </>}>
      <div className="nx-fill" style={{ gap: 14 }}>
        <label style={{ display: 'grid', gap: 5, fontSize: 12.5, fontWeight: 600 }}>Day
          <select className="form-input" value={date} onChange={e => pick(e.target.value)} style={{ fontWeight: 400 }}>
            {dates.map(d => <option key={d} value={d}>{dow(d)}{noteFor(d) ? ' - has a note' : ''}</option>)}
          </select>
        </label>
        <label className="nx-fill" style={{ gap: 5, fontSize: 12.5, fontWeight: 600 }}>Note
          <textarea className="form-input" rows={4} autoFocus value={text} onChange={e => setText(e.target.value)}
            placeholder={self ? 'Seen by your manager on your time sheet' : 'Seen by managers and HR, not by the employee'}
            style={{ fontWeight: 400, resize: 'vertical', fontFamily: 'inherit' }} />
        </label>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>It shows on its day under the time rows. Save an empty note to remove it.</div>
      </div>
    </Modal>
  );
}

// The employee's own note on a day, as the MANAGER sees it under their Notes
// cell (Oct 12): read-only here, it is the employee's to write.
function EmployeeNoteLine({ note }) {
  const text = note?.employeeNote || '';
  if (!text) return null;
  return (
    <div title={`${text}${note.employeeNoteAt ? `\n- employee, ${formatDate(note.employeeNoteAt)}` : ''}`}
      style={{ fontSize: 11, lineHeight: 1.35, color: 'var(--muted)', fontStyle: 'italic', maxWidth: 220, overflow: 'hidden', whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', marginTop: 2 }}>
      Employee: {text}
    </div>
  );
}

// Last successful payload per (employee|self + period), kept at MODULE scope so it
// survives the component unmounting between tabs. Reopening the Time Sheet paints the
// cached card instantly and refreshes in the background - no loader flash, no snap.
const _timecardCache = new Map();
// Tests render several cards for the same person and period: clear between them,
// or a test briefly sees the previous test's card from this cache (a CI flake).
export const clearTimecardCache = () => _timecardCache.clear();
const _tcKey = (self, email, start, end) => self ? `self:${start}` : (email ? `${email}:${start}:${end}` : '');
// A reload lands back on the same card (Charmi, Oct 16: "it took me back to
// Aarav Mehta's time card"): the last employee and period opened, kept for
// this browser tab. A deep link (?timecard=) still wins over it.
const _LAST_KEY = 'nexus.payroll.last';
const _SELF_KEY = 'timeclock.my-time-sheet';
const _lastOpened = () => { try { return JSON.parse(sessionStorage.getItem(_LAST_KEY) || 'null') || {}; } catch { return {}; } };

// The period anchor for a review's period start (Sep 29): a salaried month
// anchors mid-month (the same UTC-drift-safe day the month snap uses), an
// hourly one on its bi-weekly period.
function anchorForStart(startIso, payType) {
  const [y, m, d] = (startIso || '').split('-').map(Number);
  if (!y) return null;
  return payType === 'fixed' ? new Date(y, m - 1, 15) : periodStartFor(new Date(y, m - 1, d));
}

export default function PayrollTimecard({ toastOk, toastErr, selfMode = false, initialEmail = '', initialStart = '', initialPayType = '', selfTop = null }) {
  const self = selfMode;   // employee viewing their OWN timecard (from /my-payroll)
  const [people, setPeople] = useState([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);   // the team list answered (even empty)
  // My own Time Sheet (Workday > Time Clock) keeps its period across a reload
  // too (Charmi, 10/22, item 17 - lib/refreshState); HR's card keeps its own above.
  const last = useMemo(() => initialEmail ? {} : selfMode ? (readRefresh(_SELF_KEY) || {}) : _lastOpened(), [selfMode, initialEmail]);
  const [email, setEmail] = useState(initialEmail || last.email || '');
  // Jump to a specific employee when the caller changes initialEmail (e.g. the
  // "N to review" badge in TimeAdmin opens that person's card).
  useEffect(() => { if (initialEmail) setEmail(initialEmail); }, [initialEmail]);
  // Opened on a specific period (Timesheets to Review, the bell, the briefing
  // link, the card open before a reload): start there, and don't let the
  // first-load snaps move it.
  const seedStart = initialStart || last.start, seedType = initialPayType || last.payType;
  const selfSeed = selfMode ? anchorForStart(last.start, last.payType) : null;
  const seeded = useRef(selfMode ? !!selfSeed : !!anchorForStart(seedStart, seedType));
  const [pStart, setPStart] = useState(() => (selfMode ? selfSeed : anchorForStart(seedStart, seedType)) || periodStartFor(new Date()));
  // A notice about my own Time Sheet opens its period (lib/openTarget.js).
  // Hourly periods start on a Sunday, so any other start is a salaried month.
  useEffect(() => {
    if (!selfMode) return undefined;
    const go = (d) => {
      const [y, m, dd] = String(d?.start || '').split('-').map(Number);
      if (!y) return;
      const type = d.payType || (new Date(y, m - 1, dd).getDay() === 0 ? 'hourly' : 'fixed');
      fixedSnapped.current = true;   // stay on it - no first-load snap to this month
      setPStart(anchorForStart(d.start, type));
    };
    go(takePendingOpen('myTimecard'));
    const onOpen = (e) => { takePendingOpen('myTimecard'); go(e.detail); };
    window.addEventListener('nexus:open-my-timecard', onOpen);
    return () => window.removeEventListener('nexus:open-my-timecard', onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfMode]);
  // Seed from the module cache so a reopen renders the last card immediately (no loader).
  const [data, setData] = useState(() => {
    const s = isoDate(pStart), e = isoDate(pStart.getTime() + 13 * DAY);
    return _timecardCache.get(_tcKey(selfMode, email, s, e)) || null;
  });
  // No pay or OT controls on the timecard (Charmi, Sep 30): the rate and the
  // OT rule are READ here and written only on Pay & Benefits.
  const [editDay, setEditDay] = useState(null);   // { date, seg? }
  const [addTime, setAddTime] = useState(false);   // Add Time (Oct 14): a run of shifts at once
  const [dupDay, setDupDay] = useState(false);     // Add Time From Record (Oct 27): HR keys in a record kept outside Nexus
  // A missing/wrong BREAK punch. PunchEditModal only ever deals in clock-in and
  // clock-out, so until now a break that never ended (or ended late, the phone
  // case) had no self-service path at all - the card said "never ended" and the
  // employee could do nothing about it. Backend already accepts break kinds
  // (_PR_KINDS); this is the missing front door.
  const [breakFix, setBreakFix] = useState(null);   // { date, breaks, focus } | null
  const [busy, setBusy] = useState(false);
  const [stepLocked, setStepLocked] = useState(false);   // payroll $ needs a fresh step-up
  const [exceptions, setExceptions] = useState([]);      // per-employee missing/exception counts (sidebar)
  const [showRaw, setShowRaw] = useState(false);         // SwipeClock's "Show Unrounded Times"
  useDisplayTz();   // re-render this card (and its time cells) when the tz switch flips
  // Your own timesheet reads in your own zone, so a time you type is the time
  // you mean (Oct 13). After useDisplayTz, so its listener hears the switch.
  // The zone is the EMPLOYEE's (data.zoneKey), not the viewer's browser (Oct 18).
  useOwnZone(self, data?.zoneKey || '');
  // Someone else's card opens in THEIR zone: India time for India-based staff,
  // California for US staff - unless this viewer flipped it before (Oct 20).
  useEmployeeZone(!self, data?.zoneKey || '');
  // A phone gets the day cards instead of the 12-column table (Oct 14) - the
  // table scrolled sideways and hid Hours, OT, Notes and the Work Log.
  const phone = useIsMobile(PHONE_QUERY);
  const [tour, setTour] = useState(false);               // Simulate walkthrough
  // The Help panel's Take the Tour (lib/tours.js) - a manager's timecard only.
  useEffect(() => (self ? undefined : registerTour('timecard', 'Time Sheet', () => setTour(true))), [self]);
  const { can, myEmail } = useRole();
  const isAdmin = can('administrator');
  // Salary advances live on the Time Sheet (Neil, Oct 29 2026): asked for
  // someone from theirs, read-only on your own (TimeSheetAdvances).
  const adv = useTimeSheetAdvances(self ? (myEmail || '') : (email || ''));
  const [workLogDay, setWorkLogDay] = useState(null);   // date string - opens the Work Log drawer for this day
  // Location dot on a punch links to the Locations map, for viewers who can reach it.
  const hourlyLocate = (!self || isAdmin) ? (data?.email || email || '') : '';
  const [geoMap, setGeoMap] = useState('');   // email whose Geofence Punch view is open
  // The Loc chip opens the same map framed on that one shift (Sep 30). Anyone
  // may open their OWN punches there, so it works on the employee's card too.
  const [geoFocus, setGeoFocus] = useState(null);   // { seg, date } | null

  const start = isoDate(pStart);
  const end = isoDate(pStart.getTime() + 13 * DAY);
  const cacheKey = _tcKey(self, email, start, end);
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => isoDate(pStart.getTime() + i * DAY)), [pStart]);

  // employee list (scoped) for the picker - per period, so someone who left
  // before it is not on it (Neil, Oct 22)
  useEffect(() => {
    if (self) return;   // employee self-view has no picker / team list
    api.timeTeam(start, end).then(r => {
      const list = (r.rows || []).map(x => ({ email: x.email, name: x.name || x.email, pendingEdits: x.pendingEdits || 0, department: x.department || '', company: x.company || '', companyId: x.companyId || '' }));
      setPeople(list);
      setPeopleLoaded(true);
      // Someone remembered from before a reload who is no longer in scope
      // falls back to the first person, like an empty start.
      setEmail(e => (e && (initialEmail === e || list.some(p => p.email === e))) ? e : list[0]?.email || '');
    }).catch(() => setPeopleLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self, start, end]);
  useEffect(() => {
    if (self) saveRefresh(_SELF_KEY, { start: isoDate(pStart), payType: data?.payType || '' });
  }, [self, pStart, data?.payType]);
  useEffect(() => {
    if (self || !email) return;
    try { sessionStorage.setItem(_LAST_KEY, JSON.stringify({ email, start: isoDate(pStart), payType: data?.payType || '' })); }
    catch { /* per-tab convenience only */ }
  }, [self, email, pStart, data?.payType]);
  // Per-employee missing/exception counts for the sidebar (re-loads per period).
  useEffect(() => {
    if (self) return;
    api.timeTeamExceptions(start, end).then(r => setExceptions(r || [])).catch(() => setExceptions([]));
  }, [self, start, end]);

  // When the TARGET changes (employee or period) paint the CACHED card for it
  // immediately if we have one - otherwise the neutral loader. Never the previous
  // target's card, or the wrong pay-type shell. A manual refetch after a mutation
  // keeps the current card (no blink, the HR sidebar stays put).
  useEffect(() => { setData(_timecardCache.get(cacheKey) ?? null); }, [cacheKey]);

  // Stale-response guard. The fixed-salary snap moves pStart mid-mount (bi-weekly
  // anchor -> current month), firing a SECOND fetch while the first is still in
  // flight. Without this the slower (wrong-month) response could resolve last and
  // pin the card on the wrong month - which then looks "stuck" because pStart has
  // already moved, so the arrows compute the same month and don't refetch. Stamp
  // each request with its period key and apply only the still-current one.
  const reqKeyRef = useRef('');
  const load = useCallback(() => {
    if (self) {
      // Employee's own timecard - same shape as the HR card, no step-up needed for
      // one's own pay (like a payslip). /my-payroll keys off the period start.
      const key = _tcKey(true, '', start, end);
      reqKeyRef.current = key;
      api.timeMyPayroll(start).then(d => {
        _timecardCache.set(key, d);
        if (reqKeyRef.current !== key) return;   // period moved on before this arrived
        setStepLocked(false); setData(d);
      }).catch(e => { if (reqKeyRef.current === key) { setData(null); toastErr?.(e?.message || 'Could not load your time sheet.'); } });
      return;
    }
    if (!email) return;
    const key = _tcKey(false, email, start, end);
    reqKeyRef.current = key;
    api.timePayroll(email, start, end).then(d => {
      _timecardCache.set(key, d);
      if (reqKeyRef.current !== key) return;
      setStepLocked(false); setData(d);
    }).catch(e => {
      if (reqKeyRef.current !== key) return;
      // Payroll shows $ - the backend requires a fresh step-up MFA. Show the
      // Verify gate (a gesture) rather than popping a challenge on mount.
      if (isStepUpRequired(e)) { setStepLocked(true); return; }
      setData(null); toastErr?.(e?.message || 'Could not load the time sheet.');
    });
    // toastErr is only used in the catch; excluding it keeps `load` stable so a
    // parent that re-creates the callback each render (TimeClock's 1s stopwatch)
    // can't trigger an endless refetch loop that pins the spinner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self, email, start, end]);
  useEffect(load, [load]);
  // Any punch change made elsewhere (the clock widget, My Time, another card)
  // refreshes this card too - no manual reload (Neil, Oct 16).
  useEffect(() => {
    window.addEventListener('nexus:timeclock-changed', load);
    return () => window.removeEventListener('nexus:timeclock-changed', load);
  }, [load]);

  // Fixed employees are paid by MONTH, but the default period anchor is the
  // bi-weekly Sunday (which can fall in the previous month). On the first fixed
  // load, snap to the month of the day in view (today when nobody moved it).
  const fixedSnapped = useRef(seeded.current);
  const focusRef = useRef(null);   // the day the previous employee's card was on
  useEffect(() => {
    if (!data || data.payType !== 'fixed' || fixedSnapped.current) return;
    fixedSnapped.current = true;
    const f = focusRef.current || new Date();
    const wantM = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`;
    const cardM = (data.periodStart || '').slice(0, 7);
    if (cardM && cardM !== wantM) {
      setPStart(new Date(f.getFullYear(), f.getMonth(), 15));   // mid-month: safe from UTC month-boundary drift
    }
  }, [data]);

  // HR switching employees KEEPS the period in view (Neil, Oct 22 - picking
  // the period again for every person was the slow part): the next card opens
  // on the hourly period / month holding the middle of the one just shown
  // (today, if that is still ahead). Re-anchoring through periodStartFor and
  // re-arming the fixed snap keeps an hourly grid on its Sunday series after
  // a fixed employee's month anchor (the 15th) - SwipeClock parity.
  useEffect(() => {
    if (self) return;
    if (seeded.current) { seeded.current = false; return; }   // keep the period we were opened on
    const s = new Date(`${data?.periodStart || start}T00:00`), e = new Date(`${data?.periodEnd || end}T00:00`);
    const mid = new Date((s.getTime() + e.getTime()) / 2), now = new Date();
    focusRef.current = mid > now ? now : mid;
    fixedSnapped.current = false;
    setPStart(periodStartFor(focusRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const byDate = useMemo(() => Object.fromEntries((data?.days || []).map(d => [d.date, d])), [data]);
  const weekTotals = useMemo(() => {
    const w = {};
    (data?.days || []).forEach(d => { (w[d.weekStart] ||= { min: 0 }).min += d.workedMin; });
    return w;
  }, [data]);
  const rate = data?.rate || 0;
  // ALWAYS act on the card's ACTUAL period bounds (bi-weekly for hourly, the calendar
  // month for fixed) - not the frontend bi-weekly `start`/`end`, which are wrong for a
  // fixed employee. Approve/finalize/sign/CSV would otherwise hit the wrong period.
  const perStart = data?.periodStart || start;
  const perEnd = data?.periodEnd || end;

  const rule = data?.overtimeRule || 'ca';   // read-only here; set on Pay & Benefits
  const RULE_LABEL = { ca: 'California', federal: 'Federal', none: 'None' };
  // "Through 10/14 at X · From 10/15 at Y" when the rate changed inside the period.
  const rateSplitText = (splits, key, fmt) => (splits || []).length > 1
    ? splits.map((s, i) => i === 0 ? `Through ${formatDate(s.through)} at ${fmt(s[key])}` : `From ${formatDate(s.from)} at ${fmt(s[key])}`).join(' · ')
    : '';
  // Approve + finalize share the SwipeClock exception gate: a period with a
  // missing or unmatched punch is blocked (the paired total would be wrong), with
  // an explicit "sign off anyway" override - the sign-off is on record either way.
  async function signOff(call, verb, okMsg) {
    setBusy(true);
    try { await call(false); toastOk?.(okMsg); load(); }
    catch (e) {
      if (e?.detail?.code === 'unresolved_exceptions') {
        setBusy(false);
        const go = await dialog.confirm(e.detail.message,
          { title: 'Unresolved punch exceptions', confirmText: `${verb} anyway`, danger: true });
        if (!go) return;
        setBusy(true);
        try { await call(true); toastOk?.(`${okMsg} (exceptions overridden).`); load(); }
        catch (e2) { toastErr?.(e2?.message || `Could not ${verb.toLowerCase()}.`); }
      } else {
        toastErr?.(e?.message || `Could not ${verb.toLowerCase()}.`);
      }
    }
    setBusy(false);
  }

  // Hourly nav MUST stay Sunday-anchored (SwipeClock parity). Step in whole
  // periods on the UTC series - snapPeriodUTC first, so a pStart left
  // off-series by a fixed employee's month snap re-aligns. Never route the
  // step through periodStartFor: that reads the LOCAL calendar, and a UTC
  // boundary lands on Saturday for US viewers, re-flooring a period back.
  const shift = (n) => setPStart(new Date(snapPeriodUTC(pStart.getTime()).getTime() + n * 14 * DAY));
  const isFixed = data?.payType === 'fixed';   // monthly salary employee (not hourly)
  const cur = data?.currency || 'USD';         // any ISO code - see moneyPrefix
  // The manager tier never sees pay (Pranshu, 10/06) - the server sends none
  // and says so (payHidden): the pay columns, rates and totals disappear.
  const showPay = !data?.payHidden;
  const fmtM = (n) => (showPay ? money(n, cur) : '');
  // Fixed employees navigate by MONTH; the backend reads `start` as a month anchor.
  const shiftMonth = (n) => { const base = data?.periodStart ? new Date(data.periodStart + 'T00:00') : pStart; setPStart(new Date(base.getFullYear(), base.getMonth() + n, 15)); };
  // Format from the ISO strings, not the UTC instants - toLocaleDateString on a
  // UTC midnight shows the previous (Saturday) date to any viewer west of UTC.
  const label = `${formatDate(start)} – ${formatDate(end)}`;
  // The period as the employee sees it - a month for fixed, the bi-weekly range for hourly.
  const periodLabel = isFixed && data?.periodStart ? monthName(new Date(data.periodStart + 'T00:00')) : label;
  // The period list for the finder: hourly = one ahead, the current, 12 back
  // on the UTC series (as `shift` steps); fixed = this month and 12 back (as
  // `shiftMonth` steps). Picks set pStart exactly as the arrows would.
  const finderPeriods = () => {
    const today = new Date();
    if (isFixed) {
      const base = data?.periodStart ? new Date(data.periodStart + 'T00:00') : pStart;
      return Array.from({ length: 13 }, (_, i) => {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 15);
        return { key: monthName(d), label: monthName(d), current: i === 0, open: d.getFullYear() === base.getFullYear() && d.getMonth() === base.getMonth(), pick: () => setPStart(d) };
      });
    }
    const curStart = periodStartFor(today).getTime();
    return Array.from({ length: 14 }, (_, i) => {
      const s = curStart + (1 - i) * 14 * DAY, k = isoDate(s);
      return { key: k, label: `${formatDate(k)} - ${formatDate(isoDate(s + 13 * DAY))}`, current: i === 1, open: k === start, pick: () => setPStart(new Date(s)) };
    });
  };
  const periodFinder = <PeriodFinder label={periodLabel} minWidth={isFixed ? 130 : 175} periods={finderPeriods()}
    goTo={(iso) => setPStart(anchorForStart(iso, isFixed ? 'fixed' : 'hourly'))} />;
  // ‹ period › - at the top of the employee sidebar when there is one (Neil,
  // Oct 22: pick the pay period first, then go down the people), else in the
  // card's toolbar (your own sheet, a phone).
  const sideArrow = { width: 26, height: 26, minWidth: 26, padding: 0, flexShrink: 0 };
  const periodNav = (inSidebar) => (
    <div data-tour="pr-period" style={{ display: 'flex', alignItems: 'center', gap: 2, ...(inSidebar ? { border: '1px solid var(--wk-line2)', borderRadius: 8, padding: '1px 2px' } : {}) }}>
      <button className="icon-btn" aria-label="Previous pay period" onClick={() => (isFixed ? shiftMonth(-1) : shift(-1))} style={inSidebar ? sideArrow : { padding: 6 }}><ChevronLeft size={inSidebar ? 14 : 16} /></button>
      {inSidebar
        ? <PeriodFinder label={periodLabel} periods={finderPeriods()} fill
            goTo={(iso) => setPStart(anchorForStart(iso, isFixed ? 'fixed' : 'hourly'))} />
        : periodFinder}
      <button className="icon-btn" aria-label="Next pay period" onClick={() => (isFixed ? shiftMonth(1) : shift(1))} style={inSidebar ? sideArrow : { padding: 6 }}><ChevronRight size={inSidebar ? 14 : 16} /></button>
    </div>
  );
  const T = data?.totals;
  const fin = data?.finalized;         // HR finalization - the period is LOCKED
  const ownCard = !self && !!myEmail && (data?.email || email || '').toLowerCase() === myEmail.toLowerCase();
  // HR is correcting it (Oct 22): only HR changes it until it is signed again.
  const corrLock = !!data?.review?.inCorrection && !data?.review?.isHr;
  const noEdit = !!fin || ownCard || corrLock;     // nothing on the card is editable here (finalized, your own, HR correcting)
  // Full-width rows across the hourly table: Date, Edit, In, Out, Deducted
  // Time, Category, Total Hours, OT, Loc, [Pay Rate], [Wage] - SwipeClock's
  // order (Neil, Oct 16): the actions up front, the outputs at the end.
  const span = 13 - (showPay ? 0 : 2);   // + Hrs/Day (Oct 18 2026)
  const mgrAp = data?.approval;        // manager approval (step 1 of 2)
  // Never surface a raw email - fall back to a name formatted from the local-part.
  const nameFor = (em) => people.find(p => p.email === (em || '').toLowerCase())?.name
    || (em ? em.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');

  async function finalize() {
    if (!await dialog.confirm(`Finalize ${nameFor(email)}'s time sheet for ${periodLabel}? This locks all time records for the period - edits will need an unlock.`, { title: 'Finalize Time Sheet', confirmText: 'Finalize', danger: true })) return;
    await signOff((allow) => api.timeFinalize({ email, start: perStart, end: perEnd, allow_exceptions: allow }),
      'Finalize', 'Time sheet finalized - the period is locked.');
  }
  async function unfinalize() {
    // HR / Global Admin only (Neil, Oct 22): only HR changes it until the employee signs it again.
    const reason = await dialog.prompt(`Why is ${nameFor(email)}'s time sheet for ${periodLabel} being unlocked? Only HR can change it while it is unlocked, and ${nameFor(email)} signs the corrected time sheet again. The reason is printed on it.`,
      { title: 'Unlock Time Sheet', confirmText: 'Unlock', required: true, multiline: true, minLength: 5,
        placeholder: 'e.g. Wrong lunch on 06/08' });   // the server needs 5 characters too
    if (!reason?.trim()) return;
    setBusy(true);
    try { await api.timeUnfinalize({ email, start: perStart, end: perEnd, reason: reason.trim() }); toastOk?.('Unlocked - only HR can change it until it is signed again.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not unlock.'); }
    setBusy(false);
  }

  // Exports (CSV, QuickBooks IIF, Intacct). Oct 2 (Neil: "Payroll Export
  // Nexus to IIF is not working"): the buttons called the API and DROPPED the
  // result - reqBlob hands back { blob, filename } and nobody saved it, so a
  // click did nothing visible. Now: step up first, fetch, save the file,
  // toast; a stale step-up (require_stepup 403 after the session lapsed) is
  // renewed once and the fetch retried.
  const [exporting, setExporting] = useState(false);
  const [intacctOpen, setIntacctOpen] = useState(false);
  const [intacct, setIntacct] = useState(() => {
    try { return { journal: 'PYRJ', expense: '', clearing: '', location: '', ...(JSON.parse(localStorage.getItem('nexus.payroll.intacct') || '{}')) }; }
    catch { return { journal: 'PYRJ', expense: '', clearing: '', location: '' }; }
  });
  const setIntacctField = (k, v) => setIntacct((cur) => {
    const next = { ...cur, [k]: v };
    try { localStorage.setItem('nexus.payroll.intacct', JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  async function exportFile(fetcher, label, range = [perStart, perEnd]) {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) toastErr?.('Identity check didn’t complete.'); return; }
    setExporting(true);
    try {
      // Payroll Readiness (Oct 17): warn, never block, when people in the
      // exported dates are not ready.
      if (!await confirmExportReadiness(range[0], range[1])) return;
      let res;
      try { res = await fetcher(); }
      catch (e) {
        if (!isStepUpRequired(e)) throw e;
        const again = await ensureStepUp();
        if (!again.ok) { if (!again.cancelled) toastErr?.('Identity check didn’t complete.'); return; }
        res = await fetcher();
      }
      downloadBlob(res.filename || `${label}.txt`, res.blob);
      toastOk?.(`${label} downloaded${res.filename ? ` - ${res.filename}` : ''}.`);
    } catch (e) { toastErr?.(e?.message || `Could not export the ${label}.`); }
    finally { setExporting(false); }
  }

  // A leave day (Sick / Vacation / Personal block) reads red across its row
  // (Pranshu, Oct 12) - the pr-leave class, styled in style.css.
  // Numeric columns (Hours, OT, Wage) are right-aligned
  // with tabular numerals so figures line up column by column (Charmi, Sep 30).
  // The SwipeClock grid (Oct 16): every cell ruled, tight rows, centered text.
  const gh = { fontSize: 12, fontWeight: 700, padding: '6px 8px', textAlign: 'center', border: '1px solid var(--line)', background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', whiteSpace: 'nowrap' };
  const gc = { fontSize: 12.5, padding: '3px 8px', textAlign: 'center', border: '1px solid var(--line)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', verticalAlign: 'middle' };
  // A break line between two rows of a shift: thinner and quieter than a row,
  // dashed above and below, in the day's band.
  const lineCell = (r) => ({ fontSize: 11, padding: '1px 8px', lineHeight: 1.45, borderTopStyle: 'dashed', borderBottomStyle: 'dashed',
    background: r.band ? 'color-mix(in srgb, var(--wk-hover) 60%, transparent)' : undefined });
  // Add Note in the toolbar (Pranshu, Oct 16): pick the day, write the note.
  const [noteModal, setNoteModal] = useState(false);
  const noteOf = (ds) => (self ? myNote(ds)?.note : notes[ds]?.note) || '';

  // Day notes: the manager/HR note (Charmi, Sep 29) rides only on the team
  // timecard; the employee's OWN note (Neil, Oct 12) is the one thing the
  // self card carries, and the manager sees it under theirs.
  const [notes, setNotes] = useState({});
  useEffect(() => { setNotes(data?.notes || {}); }, [data]);
  const saveNote = async (date, note) => {
    try {
      const r = await api.timeSetTimecardNote(email, date, note);
      setNotes(n => {
        const next = { ...n };
        const keep = n[date]?.employeeNote ? { employeeNote: n[date].employeeNote, employeeNoteAt: n[date].employeeNoteAt } : {};
        if (r.note || keep.employeeNote) next[date] = { note: r.note, by: r.by, at: r.at, ...keep }; else delete next[date];
        return next;
      });
      return true;
    } catch (e) { toastErr?.(e?.message || 'Could not save the note.'); return false; }
  };
  const saveMyNote = async (date, note) => {
    try {
      const r = await api.timeSetMyTimecardNote(date, note);
      setNotes(n => {
        const next = { ...n };
        if (r.employeeNote) next[date] = { employeeNote: r.employeeNote, employeeNoteAt: r.employeeNoteAt }; else delete next[date];
        return next;
      });
      return true;
    } catch (e) { toastErr?.(e?.message || 'Could not save the note.'); return false; }
  };
  // The self card's NoteCell reads {note, at} - map the employee note onto it.
  const myNote = (ds) => notes[ds]?.employeeNote ? { note: notes[ds].employeeNote, at: notes[ds].employeeNoteAt } : null;
  // Punches the employee ASKED for, not yet decided (Neil, Oct 13): they show on
  // the day they are for, marked Not Yet Approved with the reason - on the
  // employee's own card so they need not remember what they asked for, and on
  // the manager's with Approve / Reject.
  const reqsByDate = {};
  (data?.pendingRequests || []).forEach(q => { (reqsByDate[q.localDate] = reqsByDate[q.localDate] || []).push(q); });
  const decideReq = async (id, status) => {
    let note = '';
    if (status === 'rejected') {
      note = await dialog.prompt('', { title: 'Reject request', message: 'The employee is notified.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (note === null) return;
    }
    try {
      const res = await api.timeDecidePunchRequest(id, { status, note: note || '' });
      const extra = /Replaced|Also added/.test(res?.decisionNote || '') ? ` ${res.decisionNote}` : '';
      toastOk?.(status === 'approved' ? `Punch added to the time sheet.${extra}` : 'Request rejected.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not update the request.'); }
  };
  const photos = usePhotoMap();
  // build rows: for each date, its segments (or one empty row); punch-note lines
  // under their day (SwipeClock); weekly subtotal after each SUNDAY-anchored week
  const rows = [];
  let prevWeek = null;
  let dayIdx = 0;   // zebra banding alternates per DATE, not per punch row
  // A day with no punches has no weekStart from the server: its Sunday is
  // formatted from the LOCAL date (isoDate goes through UTC, which for a
  // viewer east of UTC named the Saturday before and drew a second "week
  // of" line between the served days).
  const localIso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  dates.forEach(ds => {
    const d = byDate[ds];
    const wk = d?.weekStart || (() => { const x = new Date(ds + 'T00:00'); x.setDate(x.getDate() - x.getDay()); return localIso(x); })();
    if (prevWeek && wk !== prevWeek) rows.push({ type: 'wk', week: prevWeek });
    prevWeek = wk;
    const band = (dayIdx++ % 2) === 1;
    const segs = d?.segments || [];
    if (!segs.length) {
      rows.push({ type: 'day', ds, seg: null, band });
      // A company holiday this employee didn't work (see _company_holidays_for_employee):
      // hourly pay has no "missed day" deduction to exempt, so it's credited a paid
      // day instead of just paying $0 for the day.
      if (d?.isHoliday) rows.push({ type: 'holiday', ds, name: d.holidayName, pay: d.holidayPay, holidayType: d.holidayType });
    }
    else {
      // SwipeClock punch pairs (Charmi / Visesh, Oct 20 - replaces Pranshu's
      // Oct 16 Break row): a shift with a lunch is two rows, 8:48am -> 1:08pm
      // and 1:23pm -> 4:45pm, with a thin "Break 15 min" line between them.
      // `seg` is the row (what its In / Out cells show and edit), `base` the
      // whole shift (what the merged Deducted / Category / OT / Loc / Pay Rate
      // / Wage / Log cells read). `rs` = the shift's rows + lines, for rowSpan.
      segs.forEach((seg, i) => {
        const items = workStretches(seg, data?.punchMeta || {});
        const rs = items.length;
        const nWork = items.filter(x => x.kind === 'work').length;
        items.forEach((x, n) => {
          if (x.kind === 'work') rows.push({ type: 'day', ds, seg: x.seg, base: seg, band, k: x.k, fromBreak: x.fromBreak,
            segFirst: n === 0, rs, first: i === 0 && n === 0, last: i === segs.length - 1 && x.k === nWork - 1 });
          else rows.push({ type: 'line', line: x.kind, ds, brk: x.brk, at: x.at, now: x.now, min: x.min, base: seg, band });
        });
      });
      // Hrs/Day (Neil, Oct 18 2026 - SwipeClock's down arrow): the day's
      // total sits on its LAST row; every row above it points down to it.
      for (let j = rows.length - 1; j >= 0; j--) { if (rows[j].type === 'day') { rows[j].dayLast = true; break; } }
      // A shift Nexus auto-closed at end of day (no clock-out was recorded):
      // one loud line under the day - the segment above pays 0 until fixed.
      if (segs.some(s => (s.flags || []).includes('auto_clock_out'))) rows.push({ type: 'auto', ds });
      // CA-rule staff only (Oct 17 2026, backend/ca_breaks.py): the meal check's
      // flag and the day's Meal / Rest Premium - the server sends neither for
      // anyone else, or for a day with nothing to say.
      // The meal check's flag ("Meal Missed") is HR's, never the employee's
      // (Charmi, Oct 20: "I don't want the employee to ever see") - not on My
      // Time Sheet, not on your own card in People > Time. A premium is pay the
      // employee is owed, so its line stays.
      const mealFlag = (self || ownCard) ? null : d?.meal;
      if (mealFlag || d?.mealPremiumMin || d?.restPremiumMin) rows.push({ type: 'meal', ds, d: { ...d, meal: mealFlag } });
      // Same reasons/notes the fixed card shows: employee edit reasons + HR adjust
      // notes + punch notes, visible in the card (not only on the hover Info dot).
      // Internal markers like "payroll edit" are filtered out (segReasons).
      // Add Time From Record (Oct 27 2026): the day's tag and reason, not
      // repeated under "On the punches".
      const recs = recordOf(segs, data?.punchMeta || {});
      const notes = segs.flatMap(segReasons).filter(n => !recs.some(r => r.reason === n));
      // Worked a half-day holiday: the OTHER half is credited on top of the
      // punches above, not instead of them (Pranshu, Sep 22 - "half from
      // holiday and half they worked").
      if (d?.holidayPay) rows.push({ type: 'holiday', ds, name: d.holidayName, pay: d.holidayPay, holidayType: d.holidayType, worked: true });
      // Shift differentials / call-back pay (Oct 17): only on a company that
      // has them on - its own line under the day, never in the hours.
      if (d?.diffMin || d?.callBackMin) rows.push({ type: 'premium', ds, day: d });
      // The day's note line (SwipeClock's pencil line under the day): the
      // manager / employee note, the punch reasons, and the Work Log.
      rows.push({ type: 'note', ds, band, text: notes.join('  ·  '), recs });
    }
    (reqsByDate[ds] || []).forEach(q => rows.push({ type: 'req', ds, req: q }));
  });
  if (prevWeek) rows.push({ type: 'wk', week: prevWeek });

  // Always US month/day (Oct 16): [] took the browser's locale, so an India-locale
  // browser read 'Sun 11/10' for October 11.
  const dow = (ds) => `${new Date(ds + 'T00:00').toLocaleDateString('en-US', { weekday: 'short' })} ${formatMonthDayNumeric(ds, true)}`;
  const pm = data?.punchMeta || {};
  // What a row's Edit opens: the shift's form on the row that starts with the
  // clock-in, the break fixer on a row that starts where a break ended.
  const isBreakRow = (r) => !!r.fromBreak;
  // Hrs/Day: the day's total on its last row, an arrow down to it on the rows above.
  const hrsDay = (r) => (r.dayLast
    ? hhmm(byDate[r.ds]?.workedMin ?? r.base?.workedMin ?? 0)
    : <ArrowDown size={12} aria-label="continues below" style={{ color: 'var(--muted)', verticalAlign: 'middle' }} />);
  // The thin line between two rows of a shift: the break, the break still
  // running, or the lunch Nexus took out of a shift with no break punched.
  const hLine = (r) => {
    if (r.line === 'auto') return <>Auto-Deducted {breakLen(r.min)} - no break was punched</>;
    if (r.line === 'open') return r.now ? <>On Break since {t12(r.at)}</> : <>Break started {t12(r.at)} - never ended, no clock-out</>;
    const b = r.brk;
    const txt = b.implicit
      ? `Break ${breakLen(b.min)} (${t12(b.start)} - clock-out) - the break end was never punched`
      : `Break ${breakLen(b.min)} (${t12(b.start)} - ${t12(b.end)})${b.paidMin > 0 ? ` - ${breakLen(b.paidMin)} paid` : ''}`;
    if (noEdit) return txt;
    return (
      <button type="button" onClick={() => setBreakFix({ date: r.ds, breaks: r.base?.breaks || [], shift: r.base })}
        title={self ? 'Ask your approver to fix or remove this break' : 'Fix the start or end of this break, or delete it'}
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
        {txt}
      </button>
    );
  };
  const editRow = (r) => isBreakRow(r) ? setBreakFix({ date: r.ds, breaks: r.base?.breaks || [], shift: r.base }) : setEditDay({ date: r.ds, seg: r.base || r.seg });

  // ── A day's pieces, drawn by BOTH the desktop table and the phone day cards
  //    (Oct 14) - one copy of each, so the two can never disagree about what a
  //    cell says or offers. ──
  const hIn = (r) => (
    <>
                    {r.seg && !r.seg.in
                    // A clock-out with no clock-in (Oct 1) - see the fixed-salary inCell.
                    ? (((self && fin) || ownCard) ? <span title={ownCard ? OWN_CARD_HINT : 'Period finalized - locked'} style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                        : <button onClick={() => !fin && editRow(r)}
                            title={fin ? 'Period finalized - locked' : isBreakRow(r) ? (self ? 'The break was never ended - ask your approver to add its end' : 'The break was never ended - set its real end, or delete the break')
                              : self ? 'Add the missing clock-in - goes to your approver' : 'Add the missing clock-in, or delete the clock-out'}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>)
                    : r.seg
                    ? <InlineTime seg={r.seg} k="in" meta={pm[r.seg.inId]} showRaw={showRaw} locked={noEdit} onSaved={load} toastErr={toastErr} self={self} locateEmail={hourlyLocate} onLocate={() => setGeoMap(hourlyLocate)} />
                    : '-'}
    </>
  );
  const hOut = (r) => (
    <>
                    {r.seg ? (r.seg.out
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <InlineTime seg={r.seg} k="out" meta={pm[r.seg.outId]} showRaw={showRaw} locked={noEdit} onSaved={load} toastErr={toastErr} self={self} locateEmail={hourlyLocate} onLocate={() => setGeoMap(hourlyLocate)} />
                          {(r.seg.flags || []).includes('auto_clock_out') && (
                            <span title="Nexus closed this shift automatically - no clock-out was recorded. 0 paid hours until the real end time is set."
                              style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#b91c1c', background: 'rgba(185,28,28,0.1)', padding: '2px 7px', borderRadius: 6 }}>
                              auto
                            </span>
                          )}
                        </span>
                      : ((self && fin) || ownCard)
                        ? <span title={ownCard ? OWN_CARD_HINT : 'Period finalized - locked'} style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                        : <button onClick={() => !fin && setEditDay({ date: r.ds, seg: r.base || r.seg })}
                            title={fin ? 'Period finalized - locked' : self ? 'Add the missing clock-out - goes to your approver' : 'Add the missing clock-out'}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>) : '-'}
    </>
  );
  const hCategory = (r) => (
    <>
                    {r.seg?.category || '-'}
                    {r.seg?.payClass && (
                      <span title={`${{ sick: 'Sick', vacation: 'Vacation', personal: 'Personal' }[r.seg.payClass] || 'Leave'} hours - paid at the base rate, not counted toward overtime`}
                        style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', padding: '2px 7px', borderRadius: 6 }}>
                        {r.seg.payClass}
                      </span>
                    )}
    </>
  );
  const hAuto = () => (
    <>
                    <AlertTriangle size={11} style={{ marginRight: 5, verticalAlign: 'middle' }} />
                    Auto-closed at end of day - no clock-out was recorded. The day is held at 0 hours and blocks sign-off; {self ? 'tap the Out time to propose the real end of your shift.' : 'set the real Out time to release it for pay.'}
    </>
  );
  const hPremium = (r) => {
    const parts = [...(r.day.differentials || []).map(x => ({ label: x.name, text: `${hhmm(x.min)} worked in the window`, pay: x.pay })),
      ...(r.day.callBackMin ? [{ label: 'Call-Back Pay', text: `${hhmm(r.day.callBackMin)} short of the minimum, paid at the base rate`, pay: r.day.callBackPay }] : [])];
    const total = (r.day.diffPay || 0) + (r.day.callBackPay || 0);
    return (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span>
                        {parts.map((x, i) => (
                          <span key={i} style={{ marginRight: 10, display: 'inline-block' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: 'rgba(124,58,237,0.12)', color: '#7c3aed', marginRight: 6 }}>{x.label}</span>
                            {x.text}{showPay && x.pay != null ? ` - ${fmtM(x.pay)}` : ''}
                          </span>
                        ))}
                      </span>
                      {showPay && <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{fmtM(total)}</span>}
                    </div>
    );
  };
  const hMeal = (r) => (
    <>
      {r.d.meal && (
        <span style={{ marginRight: 10 }}>
          <AlertTriangle size={11} style={{ marginRight: 5, verticalAlign: 'middle' }} />
          <b>{r.d.meal.chip}</b> - {r.d.meal.label}.
        </span>
      )}
      {[['mealPremiumMin', 'mealPremiumPay', 'Meal Premium'], ['restPremiumMin', 'restPremiumPay', 'Rest Premium']]
        .filter(([m]) => r.d[m]).map(([, pay, label]) => (
          <span key={label} style={{ marginRight: 10, color: '#2563eb' }}>{label}: 1 hour of pay{showPay ? ` (${fmtM(r.d[pay])})` : ''}</span>
        ))}
    </>
  );
  const hHoliday = (r) => (
    <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: 'rgba(37,99,235,0.12)', color: '#2563eb', marginRight: 6 }}>{r.holidayType === 'half_day' ? 'Half-day holiday' : 'Holiday'}</span>
                        {r.name || 'Company holiday'}{r.worked
                          ? <> - worked the half day, plus {showPay ? fmtM(r.pay) : 'the other half'} credited{showPay ? ' for the other half' : ''}.</>
                          : <> - not worked, {showPay ? <>paid {fmtM(r.pay)}</> : 'paid holiday'}{r.holidayType === 'half_day' ? ' (half day)' : ''}.</>}
                      </span>
                      {/* The pay figure under its own text was easy to miss (Pranshu,
                          Sep 22) - repeat it where the Wage column reads for every
                          other row, so it scans the same way. */}
                      <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{fmtM(r.pay)}</span>
                    </div>
    </>
  );
  const hReq = (r) => (
    <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink)', minWidth: 70 }}>{dow(r.ds)}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: 'rgba(180,83,9,0.16)', color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={10} /> Not Yet Approved
                      </span>
                      <span style={{ color: '#b45309', fontWeight: 700 }}>
                        {r.req.action === 'remove' ? 'Remove a punch' : `Add ${PR_KIND_LABEL[r.req.punchKind] || r.req.punchKind}`}{r.req.action === 'add' && r.req.at ? ` at ${t12(r.req.at)}` : ''}{r.req.category ? ` as ${r.req.category}` : ''}
                      </span>
                      {r.req.reason && <span style={{ color: '#b45309', fontStyle: 'italic' }}>{self ? 'Your reason' : (r.req.employeeName || 'Employee')}: “{r.req.reason}”</span>}
                      {r.req.createdAt && <span style={{ color: 'var(--muted)', fontSize: 11 }}>asked {formatDateTime(r.req.createdAt + (r.req.createdAt.endsWith('Z') ? '' : 'Z'))}</span>}
                      <span style={{ flex: 1 }} />
                      {self
                        ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>with your approver - not in your hours yet</span>
                        : !noEdit && (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button onClick={() => decideReq(r.req.id, 'approved')} title="Approve - adds this punch to the time sheet"
                              style={{ borderRadius: 999, padding: '3px 12px', cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, border: 'none', background: 'hsl(var(--color-green))', color: '#fff' }}>Approve</button>
                            <button onClick={() => decideReq(r.req.id, 'rejected')} title="Reject - the employee is notified"
                              style={{ borderRadius: 999, padding: '3px 12px', cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)' }}>Reject</button>
                          </span>
                        )}
                    </div>
    </>
  );
  // SwipeClock's Edit / Add column (Neil, Oct 16), right after the date, in
  // two FIXED slots on every row - Edit on the left, Add on the right - so
  // they line up down the column (Charmi, Oct 20); a slot with nothing to
  // offer stays empty, never shifting the other. Edit opens the shift (times,
  // location, Type, delete) - on a row that starts where a break ended, the
  // break fixer (its missing end, or delete it). Add on any row adds another
  // block of time to that day: Regular, Break, Sick, Vacation or Personal
  // (Neil, Aug 3: "no option to just add a punch"). An employee's Add and
  // break fix go to their approver as requests.
  const btn = { border: '1px solid var(--line-strong,var(--line))', borderRadius: 3, padding: '0 5px', background: 'var(--wk-hover)', color: 'var(--ink)', font: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1.6, width: '100%' };
  const hEdit = (r) => !noEdit && (
    <span className="pr-edit-slots" style={{ display: 'inline-grid', gridTemplateColumns: '36px 36px', gap: 4, alignItems: 'center' }}>
      <span data-slot="edit">
        {r.seg && (!self || isBreakRow(r)) && (
          <button type="button" onClick={() => editRow(r)} style={btn}
            title={isBreakRow(r) ? (self ? 'Ask your approver to fix or remove this break' : 'Fix the start or end of this break, or delete it')
              : 'Edit this shift - its times, location or Type, or delete a punch'}>
            Edit
          </button>
        )}
      </span>
      <span data-slot="add">
        <button type="button" onClick={() => setEditDay({ date: r.ds, seg: null })} style={btn}
          title={self ? 'Ask for time on this day - Regular, Break, Sick, Vacation or Personal - goes to your approver' : 'Add time to this day - Regular, Break, Sick, Vacation or Personal'}>
          Add
        </button>
      </span>
    </span>
  );

  // ── Phone: one card per day (Oct 14). The same rows the table draws, grouped
  //    by date: the date, the day's hours (and OT and wage), each session as
  //    In -> Out with its category and location, then the day's breaks,
  //    holiday, auto-close and pending requests, then the note and Work Log.
  //    The weekly total is a band between the weeks, as on the table. ──
  const hourlyPhoneDays = () => {
    const items = [];
    let cur = null;
    rows.forEach(r => {
      if (r.type === 'wk') { cur = null; items.push(r); return; }
      // The day's note line: the card has its own footer for the note and Work
      // Log, so only the punch reasons follow their day here.
      if (r.type === 'note') { if (r.text || r.recs?.length) cur?.extra.push(r); return; }
      if (!cur || cur.ds !== r.ds) { cur = { type: 'card', ds: r.ds, segs: [], extra: [] }; items.push(cur); }
      // A shift's rows and the break lines between them stay in order.
      if (r.type === 'day' || r.type === 'line') cur.segs.push(r); else cur.extra.push(r);
    });
    const small = { fontSize: 12, color: 'var(--muted)' };
    return (
      <div data-tour="pr-table" className="pr-days">
        {items.map((it, i) => {
          if (it.type === 'wk') {
            const wkEnd = new Date(new Date(it.week + 'T00:00').getTime() + 6 * DAY);
            return (
              <div key={'wk' + i} className="pr-days-week">
                <span>Week of {formatMonthDayNumeric(it.week)} to {formatMonthDayNumeric(wkEnd)}</span>
                <span>{hhmm(weekTotals[it.week]?.min || 0)}</span>
              </div>
            );
          }
          const ds = it.ds;
          const worked = it.segs.filter(r => r.seg);
          // The shift's figures, once per shift (its rows split only the hours).
          const shifts = worked.filter(r => r.segFirst).map(r => r.base);
          const day = byDate[ds];
          const leave = worked.some(r => r.seg.payClass);
          const otMin = shifts.reduce((a, s) => a + (s.otMin || 0), 0);
          const dtMin = shifts.reduce((a, s) => a + (s.dtMin || 0), 0);
          const pay = shifts.reduce((a, s) => a + (s.amount || 0), 0);
          // A day with no punches is one line: its date, Add Note, the Work Log
          // and Add Punch, as the table row offers them. A worked day, or one
          // with a note, carries the note and Work Log in its own footer.
          const foot = worked.length > 0 || !!(self ? myNote(ds) : (notes[ds]?.note || notes[ds]?.employeeNote));
          const inline = !foot;
          const canAdd = !noEdit;
          const noteCell = self
            ? <NoteCell date={ds} note={myNote(ds)} onSave={saveMyNote} placeholder="Add a note for your manager" />
            : <><NoteCell date={ds} note={notes[ds]} onSave={saveNote} /><EmployeeNoteLine note={notes[ds]} /></>;
          return (
            <section key={ds} className={`pr-dcard${leave ? ' pr-dcard-leave' : ''}${worked.length ? '' : ' pr-dcard-empty'}`} aria-label={dow(ds)}>
              <div className="pr-dcard-head">
                <span className="pr-dcard-date" style={{ color: leave ? '#b91c1c' : worked.length ? 'var(--ink)' : 'var(--muted)' }}>{dow(ds)}</span>
                {inline && <span className="pr-dcard-inline-note">{noteCell}</span>}
                <span style={{ flex: 1 }} />
                {inline && <WorkLogButton onClick={() => setWorkLogDay(ds)} title={`View the Work Log for ${dow(ds)}`} />}
                {worked.length > 0 ? (
                  <span className="pr-dcard-total">
                    {(otMin > 0 || dtMin > 0) && (
                      <span style={{ color: dtMin ? '#b91c1c' : '#b45309', fontWeight: 700, fontSize: 11.5 }}>
                        OT {[otMin ? hhmm(otMin) : '', dtMin ? `${hhmm(dtMin)} 2×` : ''].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span>{hhmm(day?.workedMin ?? shifts.reduce((a, s) => a + (s.workedMin || 0), 0))}</span>
                    {showPay && <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{fmtM(pay)}</span>}
                  </span>
                ) : canAdd ? (
                  <button type="button" className="pr-dcard-add" onClick={() => setEditDay({ date: ds, seg: null })}
                    title={self ? 'Add a punch for this day - goes to your approver' : 'Add a punch for this day'}>
                    <Plus size={13} /> Add Punch
                  </button>
                ) : <span style={small}>No Punches</span>}
              </div>
              {it.segs.filter(r => r.seg || r.type === 'line').map((r, si) => r.type === 'line' ? (
                <div key={si} className="pr-dcard-break">{hLine(r)}</div>
              ) : (
                <div key={si} className="pr-dcard-seg">
                  <div className="pr-dcard-times">
                    <span>{hIn(r)}</span>
                    <ArrowRight size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span>{hOut(r)}</span>
                    <span style={{ flex: 1 }} />
                    {worked.length > 1 && <span style={{ ...small, fontVariantNumeric: 'tabular-nums' }}>{hhmm(r.seg.workedMin)}</span>}
                    {(!self || isBreakRow(r)) && !noEdit && (
                      <button type="button" className="pr-dcard-icon" onClick={() => editRow(r)}
                        title={isBreakRow(r) ? 'Fix or delete this break' : 'Edit punch'} aria-label={`Edit the punch on ${dow(ds)}`}>
                        <Pencil size={14} />
                      </button>
                    )}
                  </div>
                  {r.segFirst && (r.seg.category || r.seg.payClass || r.base.deductedMin > 0 || r.base.workSite || r.base.geo || r.base.geoOut) && (
                    <div className="pr-dcard-meta">
                      {(r.seg.category || r.seg.payClass) && <span>{hCategory(r)}</span>}
                      {r.base.deductedMin > 0 && <span style={{ color: '#b45309' }}>−{r.base.deductedMin}m deducted</span>}
                      <LocCell seg={r.base} onOpen={(seg) => { setGeoFocus({ seg, date: ds }); setGeoMap(data?.email || email || myEmail || ''); }} />
                    </div>
                  )}
                </div>
              ))}
              {worked.length > 0 && !self && !noEdit && (
                <button type="button" className="pr-dcard-add pr-dcard-add-more" onClick={() => setEditDay({ date: ds, seg: null })}
                  title="Add another punch for this day">
                  <Plus size={13} /> Add Another Punch
                </button>
              )}
              {it.extra.map((r, xi) => (
                <div key={xi} className={`pr-dcard-extra pr-dcard-${r.type}`}>
                  {r.type === 'auto' ? hAuto()
                    : r.type === 'meal' ? hMeal(r)
                    : r.type === 'holiday' ? hHoliday(r)
                    : r.type === 'premium' ? hPremium(r)
                    : r.type === 'req' ? hReq(r)
                    : <>{r.recs?.length > 0 && <RecordTag recs={r.recs} batches={data?.recordBatches} toastErr={toastErr} />}
                        {r.text && <><Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{r.text}</>}</>}
                </div>
              ))}
              {foot && (
                <div className="pr-dcard-foot">
                  <div style={{ flex: 1, minWidth: 0 }}>{noteCell}</div>
                  <WorkLogButton onClick={() => setWorkLogDay(ds)} title={`View the Work Log for ${dow(ds)}`} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    );
  };

  const exByEmail = Object.fromEntries(exceptions.map(e => [e.email, e]));
  // Filter the list by company and by department (Neil, Oct 16) - the picker
  // above the card follows the same filter. Each select shows only when there
  // is more than one value to choose from.
  const [company, setCompany] = useState('');
  const [dept, setDept] = useState('');
  const byEmail = Object.fromEntries(people.map(p => [p.email, p]));
  const inFilter = (em) => (!company || byEmail[em]?.company === company) && (!dept || byEmail[em]?.department === dept);
  const companies = [...new Set(people.map(p => p.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const depts = [...new Set(people.filter(p => !company || p.company === company).map(p => p.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const pickable = people.filter(p => inFilter(p.email));
  const [onlyMissing, setOnlyMissing] = useState(false);   // sidebar: only people with missing punches
  // Everyone on the period's team list (salaried people too - the exception
  // counts only cover hourly ones), with their counts; most to fix first
  // (Neil, Oct 22: pick the period, then all its people are listed).
  const sidebar = people.map(p => ({ ...p, missing: exByEmail[p.email]?.missing || 0, exceptions: exByEmail[p.email]?.exceptions || 0 }))
    .sort((a, b) => (b.missing + b.exceptions) - (a.missing + a.exceptions) || a.name.localeCompare(b.name))
    .filter(p => inFilter(p.email) && (!onlyMissing || p.missing > 0));
  const filterSel = (value, onChange, label, options) => options.length > 1 && (
    <select className="form-input" value={value} onChange={e => onChange(e.target.value)} aria-label={label}
      style={{ fontSize: 12, padding: '4px 6px', width: '100%' }}>
      <option value="">All {label === 'Company' ? 'companies' : 'departments'}</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  // The QuickBooks IIF batch is one company's finalized time cards (Neil /
  // Charmi, Oct 16): the company picked, or the only one in the list.
  const iifCompany = company || (companies.length === 1 ? companies[0] : '');
  const iifCompanyId = people.find(p => p.company === iifCompany)?.companyId || '';

  // The employee master-detail list - shared by the hourly and fixed-salary views
  // so switching between them never rearranges the screen (hidden in self mode).
  // On a phone the list gives way to the card; the employee picker above the
  // card still switches people.
  const employeeSidebar = (!self && !phone) ? (
    <div data-tour="pr-sidebar" style={{ width: 240, flexShrink: 0, border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }} className="pr-sidebar">
        <div style={{ padding: '8px 10px 6px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 5, borderBottom: '1px solid var(--line)' }}>
          {periodNav(true)}
          {/* The person picker lives here, with the period and the list (Neil, Oct 29 2026). */}
          <EmployeeCombobox people={pickable} value={email} onChange={setEmail} placeholder="Find someone..."
            labelFor={p => `${p.name}${p.pendingEdits ? ` (${p.pendingEdits} to review)` : exByEmail[p.email]?.missing ? ` (${exByEmail[p.email].missing} missing)` : ''}`}
            style={{ minWidth: 0, border: '1px solid var(--wk-line2)', borderRadius: 8, padding: '6px 9px', background: 'var(--card)' }} />
          {filterSel(company, (v) => { setCompany(v); setDept(''); }, 'Company', companies)}
          {filterSel(dept, setDept, 'Department', depts)}
          {showPay && companies.length > 0 && (
            <button type="button" className="secondary-btn" disabled={!iifCompanyId || exporting}
              title={iifCompanyId ? `QuickBooks Desktop time import (IIF) of ${iifCompany}'s finalized time sheets for ${formatDate(perStart)} - ${formatDate(perEnd)}. Employee names and the payroll items must match QuickBooks.` : 'Pick a company - QuickBooks imports one company per file'}
              onClick={() => exportFile(() => api.timeExportIifFinalized(perStart, perEnd, iifCompanyId), 'QuickBooks IIF')}
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}><Download size={13} /> QuickBooks IIF</button>
          )}
        </div>
      <div style={{ maxHeight: 560, overflowY: 'auto', borderRadius: '0 0 14px 14px' }}>
      {exceptions.length > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', fontSize: 11.5, fontWeight: 500, color: 'var(--ink)', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} /> Only People With Missing Punches
        </label>
      )}
      <div style={{ padding: '9px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 500, color: 'var(--wk-dim)', display: 'flex' }}>
        <span style={{ flex: 1 }}>Employee</span><span title="Missing punches">M</span><span style={{ width: 22, textAlign: 'right' }} title="Exceptions">E</span>
      </div>
      {!sidebar.length && <div style={{ padding: '12px', fontSize: 12, color: 'var(--muted)' }}>Nobody matches this filter.</div>}
      {sidebar.map(p => {
        const sel = p.email === email;
        return (
          <button key={p.email} onClick={() => setEmail(p.email)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderTop: '1px solid var(--line)', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 12.5, background: sel ? 'var(--wk-brand-tint)' : 'transparent', fontWeight: sel ? 700 : 500, color: sel ? 'var(--wk-brand)' : 'var(--ink)' }}>
            <SideAvatar name={p.name} email={p.email} photos={photos} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            <span style={{ width: 16, textAlign: 'center', color: '#b91c1c', fontWeight: 800 }}>{p.missing || ''}</span>
            <span style={{ width: 22, textAlign: 'right', color: '#b45309', fontWeight: 800 }}>{p.exceptions || ''}</span>
          </button>
        );
      })}
    </div>
    </div>
  ) : null;

  // Fixed-salary employees get a dedicated MONTHLY card - the hourly SwipeClock
  // grid (OT split, weekly subtotals, $/hr) does not apply to them - but it lives
  // inside the SAME master-detail layout as the hourly view.
  if (isFixed && data) {
    const fixedCard = (
      <FixedTimecard data={data} self={self} email={email} people={people} setEmail={setEmail} photos={photos}
        nameFor={nameFor} cur={cur} fmtM={fmtM} showRaw={showRaw} setShowRaw={setShowRaw}
        isAdmin={isAdmin} busy={busy} setBusy={setBusy}
        periodNav={employeeSidebar ? null : periodNav(false)}
        onFinalize={finalize} onUnfinalize={unfinalize}
        editDay={editDay} setEditDay={setEditDay} load={load} toastOk={toastOk} toastErr={toastErr}
        setWorkLogDay={setWorkLogDay} dayNotes={notes} saveNote={saveNote} saveMyNote={saveMyNote} myNote={myNote} selfTop={selfTop} ownCard={ownCard}
        adv={adv} me={myEmail} />
    );
    return (
      <>
        {self ? fixedCard : (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', fontFamily: 'var(--wk-font)' }}>
            {employeeSidebar}
            <div style={{ flex: 1, minWidth: 0 }}>{fixedCard}</div>
          </div>
        )}
        {workLogDay && (
          <WorkLogDrawer email={self ? myEmail : email} date={workLogDay}
            name={self ? '' : (people.find(p => p.email === email)?.name || email)}
            onClose={() => setWorkLogDay(null)} />
        )}
      </>
    );
  }
  // Loading (first open, or switching employee/period): a neutral loader so the card
  // never flashes the wrong pay-type shell (the hourly bi-weekly toolbar + $0.00)
  // before the data reveals whether this employee is hourly or salaried. The HR
  // sidebar stays so switching employees doesn't rearrange the screen.
  if (data === null && !stepLocked) {
    // Team mode with nobody in scope: say so instead of spinning forever
    // (Oct 16: a manager with no reports yet saw an endless loader).
    const spinner = (!self && !email && peopleLoaded && people.length === 0) ? (
      <div style={{ fontFamily: 'var(--wk-font)', padding: '52px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        No one on your team yet. People whose manager is you, or who you back up, show here.
      </div>
    ) : (
      <div style={{ fontFamily: 'var(--wk-font)', padding: '52px 0', textAlign: 'center', color: 'var(--muted)' }}>
        <Spinner size="section" />
      </div>
    );
    return self ? spinner : (
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', fontFamily: 'var(--wk-font)' }}>
        {employeeSidebar}
        <div style={{ flex: 1, minWidth: 0 }}>{spinner}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', fontFamily: 'var(--wk-font)' }}>
      {/* Employee sidebar - who has missing punches / exceptions this period */}
      {employeeSidebar}

      <div style={{ flex: 1, minWidth: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {self
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 180 }}>My Time Sheet</span>
          : employeeSidebar
            ? (email && <PersonHeader name={nameFor(email)} email={email} photos={photos} period={label} />)
            : <EmployeeCombobox people={pickable} value={email} onChange={setEmail}
                labelFor={p => `${p.name}${p.pendingEdits ? ` (${p.pendingEdits} to review)` : exByEmail[p.email]?.missing ? ` (${exByEmail[p.email].missing} missing)` : ''}`} />}
        {!employeeSidebar && periodNav(false)}
        {!self && email && !noEdit && (
        <button data-tour="pr-add-time" onClick={() => setAddTime(true)} title="Add a shift, or several days of them, for someone who did not clock in right"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' }}>
          <Plus size={14} /> Add Time
        </button>
        )}
        {!self && email && !noEdit && data?.review?.isHr && (
        <AddTimeFromRecordButton onClick={() => setDupDay(true)} />
        )}
        {!self && email && <AskAdvanceButton adv={adv} toastOk={toastOk} toastErr={toastErr} />}
        {!fin && (self || email) && (
        <button onClick={() => setNoteModal(true)} title={self ? 'Leave a note on a day for your manager' : 'Leave a note on a day - seen by managers and HR, not the employee'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' }}>
          <Pencil size={13} /> Add Note
        </button>
        )}
        {mayPrint(self, ownCard, fin, data?.review) && <PrintTimeSheetButton email={email} start={perStart} toastErr={toastErr} />}
        <div style={{ flex: 1 }} />
        {/* Options holds only display choices now: unrounded
            times. The pay rules that used to sit here (rounding, auto-lunch,
            CA paid breaks) are company settings under Settings > Global
            Settings > Time Clock, and the OT rule + rate are set on the
            person's Pay & Benefits tab - never on the timecard (Charmi, Sep 30). */}
        <TimecardOptions showRaw={showRaw} setShowRaw={setShowRaw} />
      </div>

      {/* The employee's own sheet leads with what they have to do (Neil, Oct
          18 2026): approve and sign first, then this period's change requests -
          not at the bottom under the grid, and not every period's requests. */}
      {self && T && (
        <TimesheetReviewPanel review={data.review} self={self} anchor={perStart} periodLabel={label}
          nameFor={nameFor} onChanged={load} toastOk={toastOk} toastErr={toastErr}
          below={data.contractor ? <InvoiceCard invoice={data.invoice} toastOk={toastOk} toastErr={toastErr} onSent={load} /> : null} />
      )}
      {self && data && selfTop?.(perStart, perEnd)}
      {self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
          <Pencil size={13} style={{ flexShrink: 0 }} /> Tap any clock-in or clock-out time to request a change. It goes to your approver, and your pay stays the same until they approve it.
        </div>
      )}
      {ownCard && <OwnCardHint />}
      {!stepLocked && data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {data.dept && <span><strong style={{ color: 'var(--ink)' }}>Department:</strong> {data.dept}</span>}
          {/* The OT rule is for managers and HR, never on the employee's own
              time sheet (Neil, Oct 18 2026). */}
          {self ? (showPay && <span><strong style={{ color: 'var(--ink)' }}>{data.contractor ? 'Rate' : 'Pay rate'}:</strong> {fmtM(rate)}/hr</span>) : (
          <span title="Set on the Pay & Benefits tab of this person's profile">
            {showPay && <><strong style={{ color: 'var(--ink)' }}>{data.contractor ? 'Rate' : 'Pay rate'}:</strong> {fmtM(rate)}/hr · </>}<strong style={{ color: 'var(--ink)' }}>OT rule:</strong> {RULE_LABEL[rule] || 'None'}
          </span>
          )}
          {showPay && rateSplitText(data.rateSplits, 'rate', v => `${fmtM(v)}/hr`) && (
            <span title="The rate changed inside this period - each day is paid at the rate in effect that day" style={{ color: 'var(--wk-brand)', fontWeight: 600 }}>
              {rateSplitText(data.rateSplits, 'rate', v => `${fmtM(v)}/hr`)}
            </span>
          )}
          {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}>
            <CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
          {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}>
            <CheckCircle size={12} /> Finalized · {nameFor(fin.by)} - period locked</span>}
          {data.review?.inCorrection && <CorrectionChip review={data.review} nameFor={nameFor} />}
        </div>
      )}
      {!stepLocked && showPay && !data?.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No pay rate set for this employee - wages show {fmtM(0)} until you set one.
        </div>
      )}

      {stepLocked ? (
        <StepUpNeeded label="Payroll shows employees’ pay figures." onVerified={load} />
      ) : data === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="inline" /></div>
      ) : phone ? (
        hourlyPhoneDays()
      ) : (
        <>
        {!self && <TimeColorKey />}
        <div data-tour="pr-table" style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 8, background: 'var(--card)' }}>
          {/* SwipeClock's card, cell for cell (Neil / Pranshu, Oct 16): a tight
              bordered grid - Date, Edit / Add, In, Out, Deducted Time, Category,
              Hours, OT, Loc, Pay Rate, Wage, Log. One row per punch pair (a
              lunch splits the shift in two, Oct 20), a thin break line between
              them. The note pencil sits in the
              Date cell; a note line appears under the day only when there is
              a note. Nothing else rides under a day. */}
          <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...gh, textAlign: 'left' }}>Date</th>
                <th data-tour="pr-edit" style={gh}>Edit</th>
                <th style={gh}>In</th>
                <th style={gh}>Out</th>
                <th title="Lunch taken out of a long shift that recorded no break" style={gh}>Deducted Time</th>
                <th style={gh}>Category</th>
                <th title="Hours on this row - its In to its Out; a shift's rows add up to its paid time" style={gh}>Total Hours</th>
                <th title="The day's total, on its last row - the rows above point down to it" style={gh}>Hrs/Day</th>
                <th title="Overtime in this shift - 1.5× and, in California past 12 hours, 2×" style={gh}>OT</th>
                <th style={gh}>Location</th>
                {showPay && <th title="The rate in effect that day" style={gh}>{data.contractor ? 'Rate' : 'Pay Rate'}</th>}
                {showPay && <th style={gh}>{data.contractor ? 'Amount' : 'Wage'}</th>}
                <th title="What was planned, done, and left pending that day" style={gh}>Log</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => r.type === 'wk' ? (
                <tr key={i}>
                  {/* The week's total stands out in a yellow tint (Pranshu, Oct 16). */}
                  <td colSpan={span} style={{ ...gc, background: 'rgba(234,179,8,0.18)', fontWeight: 700, fontSize: 12 }}>
                    Total hours clocked for week of {formatMonthDayNumeric(r.week)} to {formatMonthDayNumeric(new Date(new Date(r.week + 'T00:00').getTime() + 6 * DAY))}: {hhmm(weekTotals[r.week]?.min || 0)}
                  </td>
                </tr>
              ) : r.type === 'auto' ? (
                <tr key={i}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', color: '#b91c1c', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    {hAuto()}
                  </td>
                </tr>
              ) : r.type === 'meal' ? (
                <tr key={i}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', color: '#b45309', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    {hMeal(r)}
                  </td>
                </tr>
              ) : r.type === 'holiday' ? (
                <tr key={i} style={{ background: 'rgba(37,99,235,0.06)' }}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', color: '#2563eb', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    {hHoliday(r)}
                  </td>
                </tr>
              ) : r.type === 'premium' ? (
                <tr key={i} style={{ background: 'rgba(124,58,237,0.05)' }}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', color: '#6d28d9', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    {hPremium(r)}
                  </td>
                </tr>
              ) : r.type === 'req' ? (
                <tr key={i} style={{ background: 'rgba(180,83,9,0.07)' }}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', whiteSpace: 'normal', fontSize: 12 }}>
                    {hReq(r)}
                  </td>
                </tr>
              ) : r.type === 'note' ? (
                /* SwipeClock's note line under a day ("Took lunch from
                   12:05-1:05"): only when there is a note, an employee note
                   or a punch reason. */
                (r.text || r.recs?.length || noteOf(r.ds) || notes[r.ds]?.employeeNote) ? (
                  <tr key={i} className={`pr-day-row${r.band ? ' pr-band' : ''}`}>
                    <td colSpan={span} style={{ ...gc, textAlign: 'left', whiteSpace: 'normal', fontSize: 12, paddingLeft: 26 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        {/* One line each (Pranshu, Oct 16): the employee's note,
                            then HR's, then what was written on the punches - just
                            "Note by employee" / "Note by HR", no name, no date
                            (the who and when stay on hover). */}
                        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                          {!self && notes[r.ds]?.employeeNote && (
                            <span title={`${nameFor(email)}${notes[r.ds].employeeNoteAt ? `, ${formatDate(notes[r.ds].employeeNoteAt)}` : ''}`}
                              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <strong>Note by employee:</strong> {notes[r.ds].employeeNote}
                            </span>
                          )}
                          {noteOf(r.ds) && (
                            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                              <strong style={{ whiteSpace: 'nowrap' }}>{self ? 'Your note' : 'Note by HR'}:</strong>
                              {self
                                ? <NoteCell date={r.ds} note={myNote(r.ds)} onSave={saveMyNote} placeholder="Add a note for your manager" lines={1} maxWidth="none" />
                                : <NoteCell date={r.ds} note={notes[r.ds]} onSave={saveNote} lines={1} maxWidth="none" />}
                            </span>
                          )}
                          {r.recs?.length > 0 && <RecordTag recs={r.recs} batches={data?.recordBatches} toastErr={toastErr} />}
                          {r.text && <span><strong>On the punches:</strong> <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{namesIn(r.text, nameFor)}</span></span>}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null
              ) : r.type === 'line' ? (
                /* The thin line between a shift's rows (Charmi / Visesh, Oct 20):
                   "Break 15 min (1:08pm - 1:23pm)", the break still running, or
                   an auto-deducted lunch. Deducted Time, Category and the
                   shift's columns from OT on are merged down across it. */
                <tr key={i} className="pr-break-line">
                  <td colSpan={2} style={{ ...gc, ...lineCell(r) }}></td>
                  {/* Left-aligned at one indent: centered, each line started
                      somewhere else depending on its length (Pranshu, Oct 22). */}
                  <td colSpan={2} style={{ ...gc, ...lineCell(r), textAlign: 'left', paddingLeft: 28, color: r.line === 'open' ? '#b45309' : 'var(--muted)', fontStyle: 'italic', fontWeight: 600 }}>{hLine(r)}</td>
                  <td style={{ ...gc, ...lineCell(r) }}></td>
                  <td style={{ ...gc, ...lineCell(r) }}></td>
                </tr>
              ) : (() => { const rs = r.rs || 1; const head = !r.seg || r.segFirst; return (
                /* Alternate days, not rows (Pranshu, Oct 16): the shift, its
                   rows, its break lines and its note line read as one block. */
                <tr key={i} className={`pr-row pr-day-row${r.band ? ' pr-band' : ''}${r.seg?.payClass ? ' pr-leave' : ''}`}
                  title={r.seg?.payClass ? `${{ sick: 'Sick', vacation: 'Vacation', personal: 'Personal' }[r.seg.payClass] || 'Leave'} day` : undefined}>
                  <td style={{ ...gc, textAlign: 'left', fontWeight: 600, color: r.seg?.payClass ? '#b91c1c' : r.seg ? 'var(--wk-brand)' : 'var(--muted)' }}>
                    {r.first !== false && dow(r.ds)}
                  </td>
                  <td style={gc}>{hEdit(r)}</td>
                  {r.seg ? (
                    <>
                      <td style={gc}>{hIn(r)}</td>
                      <td style={gc}>{hOut(r)}</td>
                      {/* The shift's own columns, merged down over its rows and break lines. */}
                      {head && <td rowSpan={rs} style={{ ...gc, color: r.base.deductedMin ? '#b45309' : undefined }}>{r.base.deductedMin ? `−${r.base.deductedMin}m` : '-'}</td>}
                      {head && <td rowSpan={rs} style={gc}>{r.base.category || '-'}</td>}
                      {/* Each row's own hours - the rows of a shift add up to its paid time. */}
                      <td style={{ ...gc, fontWeight: 700 }}>{hhmm(r.seg.workedMin)}</td>
                      <td style={{ ...gc, fontWeight: 700 }}>{hrsDay(r)}</td>
                      {head && (
                        <>
                          <td rowSpan={rs} style={{ ...gc, color: r.base.dtMin ? '#b91c1c' : r.base.otMin ? '#b45309' : undefined, fontWeight: (r.base.otMin || r.base.dtMin) ? 700 : 400 }}>
                            {(r.base.otMin || r.base.dtMin)
                              ? [r.base.otMin ? hhmm(r.base.otMin) : '', r.base.dtMin ? `${hhmm(r.base.dtMin)} 2×` : ''].filter(Boolean).join(' · ')
                              : '-'}
                          </td>
                          <td rowSpan={rs} style={gc}>
                            {/* Location Off shows (Pranshu, Oct 21: a skipped location ask must read on the card); No Location stays a dash. */}
                            {r.base.geo && r.base.geo !== 'no_location'
                              ? <LocCell seg={r.base} onOpen={(seg) => { setGeoFocus({ seg, date: r.ds }); setGeoMap(data?.email || email || myEmail || ''); }} />
                              : '-'}
                          </td>
                          {showPay && <td rowSpan={rs} style={gc}>{fmtM(byDate[r.ds]?.rate ?? rate)}/hr</td>}
                          {showPay && <td rowSpan={rs} style={{ ...gc, fontWeight: 700 }}>{fmtM(r.base.amount)}</td>}
                        </>
                      )}
                    </>
                  ) : Array.from({ length: span - 3 }, (_, k) => <td key={k} style={gc}>-</td>)}
                  {/* The Work Log, at the far right of the day's first row (Pranshu, Oct 16). */}
                  {head && <td rowSpan={rs} style={gc}>{r.first !== false && <WorkLogButton onClick={() => setWorkLogDay(r.ds)} title={`View the Work Log for ${dow(r.ds)}`} />}</td>}
                </tr>
              ); })())}
            </tbody>
            {T && (
              /* Totals (Pranshu, Oct 16): the hours worked on their own line,
                 then each kind of time off taken with its hours and pay. */
              <tfoot>
                <tr style={{ background: 'var(--wk-hover)', fontWeight: 700 }}>
                  <td colSpan={4} style={{ ...gc, textAlign: 'left' }}>Total Worked</td>
                  <td style={{ ...gc, color: T.deductedMin ? '#b45309' : undefined }}>{T.deductedMin ? `−${T.deductedMin}m` : '-'}</td>
                  <td style={gc}></td>
                  <td style={gc}>{hhmm((T.regMin || 0) + (T.otMin || 0) + (T.dtMin || 0))}</td>
                  <td style={gc}></td>
                  <td style={gc}>{(T.otMin || T.dtMin) ? [T.otMin ? hhmm(T.otMin) : '', T.dtMin ? `${hhmm(T.dtMin)} 2×` : ''].filter(Boolean).join(' · ') : '-'}</td>
                  <td style={gc}></td>
                  {showPay && <td style={gc}></td>}
                  {showPay && <td style={gc}>{fmtM((T.regPay || 0) + (T.otPay || 0) + (T.dtPay || 0))}</td>}
                  <td style={gc}></td>
                </tr>
                {[['Sick', T.sickMin, T.sickPay], ['Vacation', T.vacationMin, T.vacationPay], ['Personal', T.personalMin, T.personalPay]]
                  .filter(([, min]) => min > 0).map(([label, min, pay]) => (
                  <tr key={label} style={{ background: 'var(--wk-hover)', fontWeight: 600 }}>
                    <td colSpan={4} style={{ ...gc, textAlign: 'left', color: '#b91c1c' }}>Time Off - {label}</td>
                    <td style={gc}></td>
                    <td style={gc}>{label}</td>
                    <td style={gc}>{hhmm(min)}</td>
                    <td style={gc}></td>
                    <td style={gc}></td>
                    <td style={gc}></td>
                    {showPay && <td style={gc}></td>}
                    {showPay && <td style={gc}>{fmtM(pay)}</td>}
                    <td style={gc}></td>
                  </tr>
                ))}
              </tfoot>
            )}
          </table>
        </div>
        </>
      )}

      {/* Summary + acknowledgment */}
      {T && (
        <div style={{ marginTop: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div data-tour="pr-summary" style={{ flex: '0 1 620px', minWidth: 300, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
            {(() => {
              // SwipeClock shows both clock time and decimal - "58:30 (58.50)" -
              // so payroll can be keyed either way without converting by hand.
              const hd = (min) => `${hhmm(min)} (${dec(min)})`;
              // With a rate change inside the period each day is priced at its
              // own rate, so the lines name no single rate; the strip above shows the split.
              const split = (data.rateSplits || []).length > 1;
              const at = (mult) => (split || !showPay) ? '' : ` at ${fmtM(rate * mult)}/hr`;
              const rows = [
                [`Total Regular hours${at(1)}`, hd(T.regMin), fmtM(T.regPay)],
                [`Total Overtime hours${at(1.5)}`, hd(T.otMin), fmtM(T.otPay)],
                ...(T.dtMin ? [[`Total Double-time hours${at(2)}`, hd(T.dtMin), fmtM(T.dtPay)]] : []),
                // Paid leave entered on the card as a Sick / Vacation category punch -
                // its own line at the base rate, like SwipeClock (Charmi, Sep 21).
                ...(T.sickMin ? [[`Total Sick hours${at(1)}`, hd(T.sickMin), fmtM(T.sickPay)]] : []),
                ...(T.vacationMin ? [[`Total Vacation hours${at(1)}`, hd(T.vacationMin), fmtM(T.vacationPay)]] : []),
                ...(T.personalMin ? [[`Total Personal hours${at(1)}`, hd(T.personalMin), fmtM(T.personalPay)]] : []),
                // Shift differentials, one line per rule, and call-back pay (Oct 17):
                // on top of the hours, never counted in them.
                ...(T.differentials || []).map(x => [`${x.name} (shift differential)`, hd(x.min), fmtM(x.pay)]),
                ...(T.callBackMin ? [[`Call-Back Pay (minimum not worked)${at(1)}`, hd(T.callBackMin), fmtM(T.callBackPay)]] : []),
                ...(T.holidayDays ? [[`Company holiday${T.holidayDays === 1 ? '' : 's'} (${T.holidayDays} day${T.holidayDays === 1 ? '' : 's'}, not worked)`, '-', fmtM(T.holidayPay)]] : []),
                // CA meal / rest premiums: 1 hour of pay each, not hours worked.
                ...(T.mealPremiumMin ? [[`Meal Premium (${T.mealPremiumMin / 60} x 1 hour of pay)`, '-', fmtM(T.mealPremiumPay)]] : []),
                ...(T.restPremiumMin ? [[`Rest Premium (${T.restPremiumMin / 60} x 1 hour of pay)`, '-', fmtM(T.restPremiumPay)]] : []),
                // Bonuses (Neil, Oct 22): one line each, with why; in totalPay.
                ...(data.bonuses || []).map(b => [`Bonus: ${b.description}`, '-', showPay ? `+${fmtM(b.amount)}` : '']),
                ['Totals', hd(T.workedMin ?? (T.regMin + T.otMin + (T.dtMin || 0))), fmtM(T.totalPay)],
                // Salary advance repayments (Oct 27 2026): off what is paid out, not the wages.
                ...(T.advanceRepayment !== undefined ? [
                  ...(data.advanceRepayments || []).filter(x => x.applied > 0).map(x => ['Salary Advance Repayment', '-', `-${fmtM(x.applied)}`]),
                  ['Net Pay', '', fmtM(T.netPay)],
                ] : []),
              ];
              const last = rows.length - 1;
              return rows.map(([lbl, hrs, amt], i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 100px', gap: 8, padding: '8px 12px', borderTop: i ? '1px solid var(--line)' : 'none', background: i === last ? 'var(--wk-hover)' : 'transparent', fontWeight: i === last ? 700 : 500, fontSize: 12.5 }}>
                  <span style={{ color: i === last ? 'var(--ink)' : 'var(--muted)' }}>{lbl}</span>
                  <span style={{ textAlign: 'right' }}>{hrs}</span>
                  <span style={{ textAlign: 'right' }}>{amt}</span>
                </div>
              ));
            })()}
          </div>
          <BreakPremiums card={data} self={self} locked={!!fin} onChanged={load} toastOk={toastOk} toastErr={toastErr} />
          {(data?.byCategory || []).length > 1 && (
            <div style={{ minWidth: 240, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
              <div style={{ padding: '8px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 500, color: 'var(--wk-dim)' }}>By category (job costing)</div>
              {data.byCategory.map((c, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px', gap: 8, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <span style={{ color: c.category === 'Uncategorised' ? 'var(--muted)' : 'var(--ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.category}</span>
                  <span style={{ textAlign: 'right' }}>{hhmm(c.workedMin)}</span>
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>{fmtM(c.pay)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ minWidth: 200, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
              <span>Missing punches</span><span style={{ fontWeight: 700, color: T.missingPunches ? '#b91c1c' : 'var(--ink)' }}>{T.missingPunches}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
              <span>Edited punches</span><span style={{ fontWeight: 700 }}>{T.editedPunches}</span>
            </div>
            {T.pendingEdits > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: '#b45309', fontWeight: 700 }} title={self ? 'Your edits waiting for approval - not counted in pay yet' : 'Employee edits awaiting your review - approve/reject each in the In/Out column'}>
                <span>Pending edits</span><span>{T.pendingEdits}</span>
              </div>
            )}
            {T.deductedMin > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
                <span>Auto-lunch deducted</span><span style={{ fontWeight: 700, color: '#b45309' }}>−{T.deductedMin}m</span>
              </div>
            )}
            {T.breakMin > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
                <span>Break time</span><span style={{ fontWeight: 700 }}>{hhmm(T.breakMin)}</span>
              </div>
            )}
            {T.paidBreakMin > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}
                title="CA rest-break credit - these break minutes stayed on the clock as paid time.">
                <span>Paid breaks</span><span style={{ fontWeight: 700, color: 'hsl(var(--color-green))' }}>+{T.paidBreakMin}m</span>
              </div>
            )}
            {!self && showPay && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="secondary-btn" disabled={exporting} onClick={() => exportFile(() => api.timeExportCsv(start, end, 'punches'), 'CSV', [start, end])} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> CSV</button>
              <button className="secondary-btn" disabled={exporting} title="Intacct General Ledger import of this period's payroll by employee - wages by pay class, with department and entity as dimensions. Same file layout as the accounting app's bank import."
                onClick={() => setIntacctOpen((v) => !v)} aria-expanded={intacctOpen}
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export for Intacct</button>
              {intacctOpen && (
                <form onSubmit={(e) => { e.preventDefault(); setIntacctOpen(false); exportFile(() => api.timeExportIntacct(perStart, perEnd, intacct), 'Intacct GL import'); }}
                  style={{ flexBasis: '100%', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                  {[['journal', 'Journal', 'PYRJ'], ['expense', 'Wage Expense Account', '60100'], ['clearing', 'Payroll Clearing Account', '21500'], ['location', 'Entity (Location ID)', '12000']].map(([k, lbl, ph]) => (
                    <label key={k} style={{ fontSize: 11, color: 'var(--muted)', display: 'grid', gap: 3 }}>
                      {lbl}
                      <input type="text" value={intacct[k] || ''} placeholder={ph} aria-label={lbl} onChange={(e) => setIntacctField(k, e.target.value)}
                        style={{ fontSize: 12, padding: '4px 6px', width: k === 'journal' ? 70 : 130 }} />
                    </label>
                  ))}
                  <button type="submit" className="primary-btn" style={{ fontSize: 12 }}>Download</button>
                  <span style={{ fontSize: 11, color: 'var(--muted)', flexBasis: '100%' }}>One entry for {formatDate(perStart)} to {formatDate(perEnd)}: a debit per employee per pay class, one credit per employee to the clearing account. Blank accounts are left for Intacct to ask.</span>
                </form>
              )}
              {/* Approving is now "Agree" in the review panel below; HR's
                  signature there finalizes. Finalize Without Signatures is
                  hidden for launch (Neil, 10/16: review + Nexus Sign is the
                  only sign-off) - LEGACY_FINALIZE brings it back. Unlock stays
                  as HR's correction path for a signed period. */}
              {fin && data.review?.canUnlock && (
                <button className="secondary-btn" onClick={unfinalize} disabled={busy} title="HR: unlock this finalized period to correct it - the employee signs it again"
                  style={{ fontSize: 12.5 }}>Unlock</button>)}
              {isAdmin && !fin && !ownCard && LEGACY_FINALIZE && (
                <button className="secondary-btn" onClick={finalize} disabled={busy} title="HR override: finalize for payroll without the review and signatures"
                  style={{ fontSize: 12.5 }}>Finalize Without Signatures</button>)}
            </div>
            )}
          </div>
        </div>
      )}
      {T && !self && (
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, fontStyle: 'italic' }}>
          Overtime rule: {rule === 'ca' ? 'California - over 8h/day (1.5×), over 12h/day (2×), the 7th consecutive day, and over 40h/week'
            : rule === 'federal' ? 'Federal - over 40 hours per week (1.5×)'
            : 'None - no US overtime premium applied'}. Set on the person's Pay & Benefits tab, with the pay rate. Each day is paid at the rate in effect that day. Corrections keep the original punch on record.
        </p>
      )}

      {T && <TimecardBonuses card={data} periodStart={perStart} self={self} locked={ownCard || (!!fin && !data.review?.isHr)} fmtM={fmtM} showPay={showPay}
        onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
      {T && <TimeSheetAdvances adv={adv} self={self} me={myEmail} toastOk={toastOk} toastErr={toastErr} />}

      {/* Review + Nexus Sign (Sep 2026): the employee submits, the manager sends
          back or agrees, then employee -> manager -> HR sign in Nexus Sign. */}
      {T && !self && (
        <TimesheetReviewPanel review={data.review} self={self} anchor={perStart} periodLabel={label}
          nameFor={nameFor} onChanged={load} toastOk={toastOk} toastErr={toastErr}
          below={data.contractor ? <InvoiceCard invoice={data.invoice} toastOk={toastOk} toastErr={toastErr} onSent={load} /> : null} />
      )}

      {noteModal && (
        <NoteModal dates={dates} dow={dow} self={self} noteFor={noteOf} onSave={self ? saveMyNote : saveNote} toastOk={toastOk} onClose={() => setNoteModal(false)} />
      )}
      {addTime && !self && email && !ownCard && (
        <AddTimeModal email={email} name={nameFor(email)} start={start} end={end} onClose={() => setAddTime(false)}
          onDone={() => { _timecardCache.clear(); load(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
      {dupDay && !self && email && !ownCard && data?.review?.isHr && (
        <AddTimeFromRecordModal email={email} name={nameFor(email)} start={start} end={end} onClose={() => setDupDay(false)}
          onDone={() => { _timecardCache.clear(); load(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
      {editDay && (
        <PunchEditModal day={editDay} email={email} busy={busy} setBusy={setBusy}
          categories={[...new Set(['Sick', 'Vacation', 'Personal', ...(data?.byCategory || []).map(c => c.category).filter(c => c && c !== 'Uncategorised')])]}
          onDone={() => { setEditDay(null); load(); }} onClose={() => setEditDay(null)}
          toastOk={toastOk} toastErr={toastErr} self={self} />
      )}
      {breakFix && (
        <BreakFixModal day={breakFix} email={email} self={self} busy={busy} setBusy={setBusy}
          onDone={() => { setBreakFix(null); load(); }} onClose={() => setBreakFix(null)}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      {geoMap && (
        <GeofencePunchModal email={geoMap} name={data?.name || nameFor?.(geoMap) || geoMap} start={perStart} end={perEnd}
          onClose={() => { setGeoMap(''); setGeoFocus(null); }}
          focusIds={geoFocus ? [geoFocus.seg.inId, geoFocus.seg.outId] : null}
          focusLabel={geoFocus ? `the ${dow(geoFocus.date)} shift` : ''}
          /* Managers reassign the punch's work site in the punch editor (work_site_id). */
          onEditSite={geoFocus && !self && !fin && geoFocus.seg.inId
            ? () => { const f = geoFocus; setGeoMap(''); setGeoFocus(null); setEditDay({ date: f.date, seg: f.seg }); }
            : null} />
      )}
      {tour && <GuidedTour onClose={() => setTour(false)} steps={[
        { target: 'pr-sidebar', title: 'Start with the employee list',
          body: 'Everyone in this pay period. M = missing punches, E = exceptions - the red numbers are your to-do list each morning. Click a name to open their card.' },
        { target: 'pr-period', title: 'The pay period',
          body: 'Bi-weekly, Sunday to Saturday - the SAME calendar as SwipeClock (current period 7/26–8/8), so the two cards always cover identical days. Arrows move one period; click the dates to pick one. Pick it first - every employee you open stays on it.' },
        { target: 'pr-table', title: 'The time sheet - same columns as SwipeClock',
          body: 'Date, Edit, In, Out, Deducted Time, Category, Total Hours, OT (1.5× and, past 12 hours in California, 2×), Location, Pay Rate and Wage. A shift with a break reads as punch pairs, like SwipeClock - one row from the clock-in to the break, the next from the break end to the clock-out, each with its own hours - and a thin line between them gives the length and times of the break. Hrs/Day shows the total for the day on its last row. Hover a time for its punch history - where it came from, the exact time, who entered or changed it. Add Note in the toolbar leaves a note on a day; it reads on the line under that day. Weekly total rows appear after each week.' },
        { target: 'pr-rounding', title: 'Options: rounded vs raw times',
          body: 'SwipeClock computes pay from rounded times but keeps the raw punch - so does Nexus. Open Options to peek at raw times. During the comparison week, leave the rounding setting ON so the numbers can match 1:1.' },
        { target: 'pr-edit', title: 'Fix punches here',
          body: 'Edit on a row opens that shift - set the real in/out, location and Type, or delete a punch; on a row that starts where a break ended (or on the break line itself) it fixes or deletes the break. Add on any row adds Regular, Break, Sick, Vacation or Personal time for someone. Originals stay on record with who changed what, like SwipeClock\'s audit log.' },
        { target: 'pr-summary', title: 'Totals, in both formats',
          body: 'Regular, overtime (1.5×), and double-time (2×) hours with wages - shown as clock time AND decimal ("58:30 (58.50)"), matching SwipeClock\'s summary, so payroll can key either format.' },
        { target: 'pr-approve', title: 'Review and sign',
          body: 'The employee submits the period, their approver sends it back or agrees, then the employee signs it in Nexus Sign. That signature locks the period (no more edits, like SwipeClock\'s "finalized" periods) and payroll runs from it. Unlock reopens it if a correction is truly needed. CSV exports the punches for records.' },
      // On a phone there is no employee list and no edit column (the day
      // cards replace the table), so those two steps would point at nothing.
      ].filter(st => !phone || (st.target !== 'pr-sidebar' && st.target !== 'pr-edit'))} />}
      <style>{`.pr-row:hover { background: var(--bg); } .pr-sidebar button:hover { background: var(--bg); } .loc-chip .loc-chip-text { border-bottom: 1px dashed currentColor; } .loc-chip:hover .loc-chip-text { border-bottom-style: solid; } .loc-chip:hover { opacity: 0.85; } .loc-chip:focus-visible { outline: 2px solid var(--wk-brand); outline-offset: 2px; border-radius: 4px; }`}</style>
      </div>
      {workLogDay && (
        <WorkLogDrawer email={self ? myEmail : email} date={workLogDay}
          name={self ? '' : (people.find(p => p.email === email)?.name || email)}
          onClose={() => setWorkLogDay(null)} />
      )}
    </div>
  );
}

const t12s = (iso) => iso ? formatTimeTz(iso, { seconds: true }) : '';

// A punch time you can edit right in the sheet (SwipeClock-style): click the
// time → it becomes an input, Enter/blur saves via the audited adjust endpoint.
// Shows the geo dot (green in-fence / red off-site) and, when "Show unrounded
// times" is on, the raw seconds-precision time in small italics beside it -
// exactly how SwipeClock renders its unrounded overlay.
// One signature line in the sign-off block. `sig` is the backend sign-off record
// ({by, at, name?, stale}); `action` (employee only) shows the Sign button;
// `pending` is the hint shown to others before that party has acted.
// Monthly card for a FIXED-salary employee. Same day grid + inline edit/add +
// signatures as the hourly card, but the pay math is the fixed model: salary,
// per-day present/half/absent/weekend status, deductions and weekend overtime.
function FixedTimecard({ data, self, email, people, setEmail, photos = {}, nameFor, cur, fmtM, showRaw, setShowRaw, isAdmin, busy, setBusy, periodNav, onFinalize, onUnfinalize, editDay, setEditDay, load, toastOk, toastErr, setWorkLogDay, dayNotes = {}, saveNote, saveMyNote, myNote = () => null, selfTop = null, ownCard = false, adv = null, me = '' }) {
  const showPay = !data.payHidden;   // the manager tier never sees pay
  const [geoMap, setGeoMap] = useState('');   // email whose Geofence Punch view is open
  useDisplayTz();   // re-render this card (and its time cells) when the tz switch flips
  const T = data.totals || {};
  const fin = data.finalized;
  const corrLock = !!data.review?.inCorrection && !data.review?.isHr;   // HR is correcting it (Oct 22)
  const noEdit = !!fin || ownCard || corrLock;   // finalized, your own card (Oct 20), or HR correcting
  const mgrAp = data.approval;
  const [breakFix, setBreakFix] = useState(null);       // { date, breaks } - fixing a break punch
  const [noteModal, setNoteModal] = useState(false);    // Add Note in the toolbar
  const [dupDay, setDupDay] = useState(false);          // Add Time From Record (Oct 27): HR only
  const byDate = Object.fromEntries((data.days || []).map(d => [d.date, d]));
  const fixedDays = data.fixedDays || [];
  const pm = data.punchMeta || {};
  // The same ruled grid and boxed buttons as the hourly card.
  const gh = { fontSize: 12, fontWeight: 700, padding: '6px 8px', textAlign: 'center', border: '1px solid var(--line)', background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', whiteSpace: 'nowrap' };
  const gc = { fontSize: 12.5, padding: '3px 8px', textAlign: 'center', border: '1px solid var(--line)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', verticalAlign: 'middle' };
  const btn = { border: '1px solid var(--line-strong,var(--line))', borderRadius: 3, padding: '0 5px', background: 'var(--wk-hover)', color: 'var(--ink)', font: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1.6 };
  // Policy as the server computed it (A4-A6, Charmi Sep 30) - shown on the strip
  // so the formula is on screen, never a guess.
  const bands = data.bands || { fullMin: 420, halfMin: 240 };
  const fixedSplit = (data.rateSplits || []).length > 1
    ? data.rateSplits.map((s, i) => i === 0 ? `Through ${formatDate(s.through)} at ${fmtM(s.monthlySalary)}/mo` : `From ${formatDate(s.from)} at ${fmtM(s.monthlySalary)}/mo`).join(' · ')
    : '';
  const monthLabel = data.periodStart ? monthName(new Date(data.periodStart + 'T00:00')) : '';
  // Always US month/day (Oct 16): [] took the browser's locale, so an India-locale
  // browser read 'Sun 11/10' for October 11.
  const dow = (ds) => `${new Date(ds + 'T00:00').toLocaleDateString('en-US', { weekday: 'short' })} ${formatMonthDayNumeric(ds, true)}`;
  const STATUS = {
    working: { label: 'Working', bg: 'var(--wk-brand-tint)', fg: 'var(--wk-brand)' },
    present: { label: 'Present', bg: 'hsla(var(--color-green),0.12)', fg: 'hsl(var(--color-green))' },
    late: { label: 'Late', bg: 'rgba(217,119,6,0.15)', fg: '#c2410c' },   // shift start passed, not clocked in yet (today only, no deduction)
    half: { label: 'Half day', bg: 'rgba(180,83,9,0.12)', fg: '#b45309' },
    absent: { label: 'Absent', bg: 'rgba(185,28,28,0.1)', fg: '#b91c1c' },
    // Leave entered for the day (Pranshu, Oct 12) - on salary the day is
    // deducted like an absence unless hours were also worked; the row reads
    // red like the hourly card's.
    sick: { label: 'Sick', bg: 'rgba(185,28,28,0.1)', fg: '#b91c1c' },
    vacation: { label: 'Vacation', bg: 'rgba(185,28,28,0.1)', fg: '#b91c1c' },
    personal: { label: 'Personal', bg: 'rgba(185,28,28,0.1)', fg: '#b91c1c' },
    holiday: { label: 'Holiday', bg: 'rgba(37,99,235,0.12)', fg: '#2563eb' },   // company holiday on the employee's own calendar - never deducted
    holiday_half: { label: 'Half-day holiday', bg: 'rgba(37,99,235,0.12)', fg: '#2563eb' },   // didn't work at all - half a day's pay
    holiday_half_worked: { label: 'Half-day holiday', bg: 'hsla(var(--color-green),0.12)', fg: 'hsl(var(--color-green))' },   // worked their half - full pay, no deduction
    weekend: { label: 'Weekend', bg: 'var(--mist)', fg: 'var(--muted)' },
    weekend_worked: { label: 'Weekend OT', bg: 'var(--wk-brand-tint)', fg: 'var(--wk-brand)' },
    upcoming: { label: 'Upcoming', bg: 'transparent', fg: 'var(--muted)' },
    // India Contractor policy (Oct 27 2026): a full holiday with hours on it.
    holiday_worked: { label: 'Holiday Worked', bg: 'rgba(37,99,235,0.12)', fg: '#2563eb' },
  };
  // India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026):
  // each day's credit, its pool hours and Extra Time instead of weekend pay,
  // and the Month-End Reconciliation under the grid - all from the server.
  const icp = data.indiaPolicy?.applies ? data.indiaPolicy : null;
  if (icp) STATUS.weekend_worked = { ...STATUS.weekend_worked, label: 'Weekend Worked' };
  const cols = icp ? 12 : 9;
  const filingOpen = self && !!data.extraTimeFiling?.open && !ownCard;
  const canDecideXt = !self && !!data.extraTimeCanDecide && !fin;
  const [xtClaim, setXtClaim] = useState(null);     // the day whose Extra Time the contractor is claiming
  const [xtDecide, setXtDecide] = useState(null);   // the day whose claim HR is deciding
  const effect = (fd) => fd.deduct ? <span style={{ color: '#b91c1c', fontWeight: 700 }}>−{fmtM(fd.deduct)}</span>
    : fd.bonus ? <span style={{ color: 'var(--wk-brand)', fontWeight: 700 }}>+{fmtM(fd.bonus)}</span>
    : (icp && fd.extraPay) ? <span style={{ color: 'var(--wk-brand)', fontWeight: 700 }}>+{fmtM(fd.extraPay)}</span>
    : <span style={{ color: 'var(--muted)' }}>no change</span>;

  // Pending add/remove punch requests, grouped by their local date so they render
  // on the right day of the card (HR approves/rejects in-context, not in a side tab).
  const reqsByDate = {};
  (data.pendingRequests || []).forEach(r => { (reqsByDate[r.localDate] = reqsByDate[r.localDate] || []).push(r); });
  const reqBtn = { borderRadius: 999, padding: '3px 12px', cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700 };
  const decideReq = async (id, status) => {
    let note = '';
    if (status === 'rejected') {
      note = await dialog.prompt('', { title: 'Reject request', message: 'The employee is notified.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true });
      if (note === null) return;
    }
    try {
      const res = await api.timeDecidePunchRequest(id, { status, note: note || '' });
      // Approving can also set aside a punch the fix replaces - say which (Oct 7).
      const extra = /Replaced|Also added/.test(res?.decisionNote || '') ? ` ${res.decisionNote}` : '';
      toastOk?.(status === 'approved' ? `Punch added to the time sheet.${extra}` : 'Request rejected.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not update the request.'); }
  };

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      {/* Toolbar - month nav (fixed pay is by calendar month, no work-week) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {self
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 160 }}>My Time Sheet</span>
          : !periodNav   // the list on the left has the picker and the period (Oct 29 2026)
            ? (email && <PersonHeader name={nameFor(email)} email={email} photos={photos}
                period={`${monthName(new Date(data.periodStart + 'T00:00'))} (${formatDate(data.periodStart)} – ${formatDate(data.periodEnd)})`} />)
            : <EmployeeCombobox people={people} value={email} onChange={setEmail}
                labelFor={p => `${p.name}${p.pendingEdits ? ` (${p.pendingEdits} to review)` : ''}`} />}
        {periodNav}
        {!fin && (
        <button onClick={() => setNoteModal(true)} title={self ? 'Leave a note on a day for your manager' : 'Leave a note on a day - seen by managers and HR, not the employee'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' }}>
          <Pencil size={13} /> Add Note
        </button>
        )}
        {!self && email && !noEdit && data.review?.isHr && <AddTimeFromRecordButton onClick={() => setDupDay(true)} />}
        {!self && email && <AskAdvanceButton adv={adv} toastOk={toastOk} toastErr={toastErr} />}
        {mayPrint(self, ownCard, fin, data.review) && <PrintTimeSheetButton email={email} start={data.periodStart} toastErr={toastErr} />}
        <div style={{ flex: 1 }} />
        {/* No rounding toggle - salary pay is day-based, so times show exactly as punched. */}
      </div>

      {/* Employee's own sheet: approve and sign first, then this month's
          change requests (Neil, Oct 18 2026). */}
      {self && (
        <TimesheetReviewPanel review={data.review} self={self} anchor={data.periodStart} periodLabel={monthLabel}
          nameFor={nameFor} onChanged={load} toastOk={toastOk} toastErr={toastErr}
          below={data.contractor ? <InvoiceCard invoice={data.invoice} toastOk={toastOk} toastErr={toastErr} onSent={load} /> : null} />
      )}
      {self && selfTop?.(data.periodStart, data.periodEnd)}

      {/* Fixed-pay strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontWeight: 700 }}>{data.contractor ? 'Fixed fee' : 'Fixed salary'}</span>
        {data.dept && <span><strong style={{ color: 'var(--ink)' }}>Department:</strong> {data.dept}</span>}
        {showPay && <span title="Set on the Pay & Benefits tab of this person's profile"><strong style={{ color: 'var(--ink)' }}>{data.contractor ? 'Monthly fee' : 'Salary'}:</strong> {fmtM(data.monthlySalary)}/mo</span>}
        {showPay && fixedSplit && (
          <span title="The salary changed inside this month - each day is paid at the salary in effect that day" style={{ color: 'var(--wk-brand)', fontWeight: 600 }}>{fixedSplit}</span>
        )}
        {showPay && <span title="Monthly salary x 12, divided by the working days in this calendar year (days minus Saturdays and Sundays; company holidays stay in)">
          <strong style={{ color: 'var(--ink)' }}>Daily:</strong> {fmtM(data.dailyRate)} (annual / {data.workingDaysInYear || T.workingDaysInYear || 261} working days)
        </span>}
        {/* How the pay is worked out (weekend rate, day bands) is for the
            reviewer, not the employee's own time sheet (Neil, Oct 18 2026). */}
        {!self && !icp && <span title="Weekend pay = max(minimum, 1.35 x daily x hours worked / full-day hours). Calculated, never typed per person.">
          <strong style={{ color: 'var(--ink)' }}>Weekend:</strong> {data.weekendMultiplier || 1.35} × daily, pro-rated by hours{data.weekendFloor ? `, min ${fmtM(data.weekendFloor)}` : ''}
        </span>}
        {!self && !icp && <span title="A weekday is a full day at this many hours worked (full-day hours minus an hour), a half day from 4 hours, absent below that">
          <strong style={{ color: 'var(--ink)' }}>Bands:</strong> Full Day ≥ {hhmm(bands.fullMin)} · Half Day ≥ {hhmm(bands.halfMin)} · Absent below
        </span>}
        {icp && <span title="Settings > Time & Pay > India Contractor Policy. Scheduled 9 hours a day, Monday - Friday; full credit at 8 hours, half at 4; the month-end reconciliation recovers missing days from the pool.">
          <strong style={{ color: 'var(--ink)' }}>India Contractor Policy</strong>
        </span>}
        {icp && showPay && <span title="Approved Extra Time is paid at 1.35 x the hourly equivalent of the daily rate (daily / 9), with no minimum">
          <strong style={{ color: 'var(--ink)' }}>Extra Time:</strong> {fmtM(icp.extraTime?.rate)}/hr (1.35 × {fmtM(icp.extraTime?.hourlyEquivalent)})
        </span>}
        {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}><CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
        {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}><CheckCircle size={12} /> Finalized · period locked</span>}
        {data.review?.inCorrection && <CorrectionChip review={data.review} nameFor={nameFor} />}
      </div>

      {self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
          <Pencil size={13} style={{ flexShrink: 0 }} /> Tap a time to change it, or "+ add" on a past day to log a missed punch - it goes to your approver.
        </div>
      )}
      {ownCard && <OwnCardHint />}
      {showPay && !data.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No salary set - set it on this person's Pay &amp; Benefits tab. Pay shows {fmtM(0)} until then.
        </div>
      )}

      {/* Day grid - the same ruled grid as the hourly card (Neil, Oct 16:
          "bring that for salaried also"): one row per shift, a Break row under
          it for each break punched, the note line only when there is a note.
          Day and Effect on pay are the salaried card's own columns. */}
      {!self && <TimeColorKey />}
      <div style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 8, background: 'var(--card)' }}>
        <table style={{ width: '100%', minWidth: icp ? 1060 : 820, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...gh, textAlign: 'left' }}>Date</th>
              <th style={gh}>Day</th>
              <th style={gh}>Edit</th>
              <th style={gh}>In</th>
              <th style={gh}>Out</th>
              <th style={gh}>Category</th>
              <th title="Hours paid for the shift - clock-in to clock-out, minus its breaks" style={gh}>Total Hours</th>
              {icp && <th title="The day's credit: Full at 8 hours worked, Half at 4, None below - or paid leave from the balance" style={gh}>Credit</th>}
              {icp && <th title="Hours this day adds to the month-end pool: past 9 on a full day, past 4 on a half day, every hour of a day with no credit, weekend and holiday hours not paid as Extra Time" style={gh}>Pool</th>}
              {icp && <th title="Hours claimed with a note to be paid at 1.35x - only hours past 9 on a workday, every hour on a weekend or holiday" style={gh}>Extra Time</th>}
              <th style={gh}>{showPay ? 'Effect on Pay' : ''}</th>
              <th title="What was planned, done, and left pending that day" style={gh}>Log</th>
            </tr>
          </thead>
          <tbody>
            {fixedDays.map((fd, fi) => {
              const d = byDate[fd.date];
              const segs = d?.segments || [];
              const baseSt = STATUS[fd.status] || STATUS.upcoming;
              // A missed day covered by approved time off is named after it ("Personal",
              // "Personal · Half Day") - requests are not punched, so it would read Absent.
              const timeOffDay = fd.timeOff && (fd.status === 'absent' || fd.status === 'half');
              const st = timeOffDay ? { ...STATUS.personal, label: fd.status === 'half' ? `${fd.timeOff} · Half Day` : fd.timeOff } : baseSt;
              const onLeave = !!fd.leaveClass;
              const band = fi % 2 === 1;
              const rowCls = `pr-day-row${band ? ' pr-band' : ''}${onLeave ? ' pr-leave' : ''}`;

              const formal = segs.flatMap(s => s.breaks || []);
              const dayRows = segs.length + formal.length;   // the shift rows and their Break rows
              const locateEmail = (!self || isAdmin) ? (data.email || '') : '';
              const recs = recordOf(segs, pm);   // Add Time From Record's tag (Oct 27 2026)
              const notes = segs.flatMap(segReasons).filter(n => !recs.some(r => r.reason === n));
              const note = dayNotes[fd.date];
              const myN = myNote(fd.date);
              const hrNote = self ? (myN?.note || '') : (note?.note || '');

              const missing = (seg, side) => ((self && fin) || ownCard)
                ? <span title={ownCard ? OWN_CARD_HINT : undefined} style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                : <button onClick={() => !fin && (side === 'brk' ? setBreakFix({ date: fd.date, breaks: formal }) : setEditDay({ date: fd.date, seg }))}
                    title={fin ? 'Locked' : side === 'brk' ? (self ? 'The break was never ended - ask your approver to add its end' : 'The break was never ended - set its real end, or delete the break')
                      : side === 'in' ? (self ? 'Add the missing clock-in - goes to your approver' : 'Add the missing clock-in, or delete the clock-out') : 'Add the missing clock-out'}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>;
              const timeCell = (seg, k) => {
                const at = k === 'in' ? seg.in : seg.out;
                if (!at) return missing(seg, k);
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <InlineTime seg={seg} k={k} meta={pm[k === 'in' ? seg.inId : seg.outId]} showRaw={showRaw} locked={noEdit} onSaved={load} toastErr={toastErr} self={self} locateEmail={locateEmail} onLocate={() => setGeoMap(locateEmail)} />
                    {k === 'out' && (seg.flags || []).includes('auto_clock_out') && (
                      <span title="Nexus closed this shift automatically - no clock-out was recorded. The day is held until the real end time is set."
                        style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#b91c1c', background: 'rgba(185,28,28,0.1)', padding: '2px 7px', borderRadius: 6 }}>
                        auto
                      </span>
                    )}
                  </span>
                );
              };
              const addBtn = (!noEdit && !fd.future) && (
                <button type="button" onClick={() => setEditDay({ date: fd.date, seg: null })} style={btn}
                  title={self ? 'Ask for time on this day - Regular, Break, Sick, Vacation or Personal - goes to your approver' : 'Add time to this day - Regular, Break, Sick, Vacation or Personal'}>Add</button>
              );
              // The Date is merged down the day; the Day column carries the status
              // pill on the first row and the "Break" label on a Break row.
              const dayCells = (
                <td rowSpan={dayRows || 1} style={{ ...gc, textAlign: 'left', fontWeight: 600, color: onLeave ? '#b91c1c' : segs.length ? 'var(--wk-brand)' : 'var(--muted)' }}>{dow(fd.date)}</td>
              );
              const dayPill = (
                <span title={onLeave ? 'Leave - the day is deducted unless hours were also worked' : timeOffDay ? `Approved time off (${fd.timeOff}) - the missed time is deducted` : (fd.holidayName || undefined)}
                  style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: st.bg, color: st.fg, whiteSpace: 'nowrap' }}>{st.label}</span>
              );
              const tailCells = (
                <>
                  {icp && <td rowSpan={dayRows || 1} style={gc}><CreditCell fd={fd} /></td>}
                  {icp && <td rowSpan={dayRows || 1} style={gc}>{fd.poolMin ? hm(fd.poolMin) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>}
                  {icp && (
                    <td rowSpan={dayRows || 1} style={gc}>
                      <ExtraTimeCell fd={fd} self={self} filingOpen={filingOpen} canDecide={canDecideXt}
                        onClaim={setXtClaim} onDecide={setXtDecide} />
                    </td>
                  )}
                  <td rowSpan={dayRows || 1} style={gc}>{showPay ? effect(fd) : ''}</td>
                  <td rowSpan={dayRows || 1} style={gc}><WorkLogButton onClick={() => setWorkLogDay(fd.date)} title={`View the Work Log for ${dow(fd.date)}`} /></td>
                </>
              );

              const rows = [];
              if (!segs.length) {
                rows.push(
                  <tr key={fd.date} className={rowCls}>
                    {dayCells}
                    <td style={gc}>{dayPill}</td>
                    <td style={gc}>{addBtn || ''}</td>
                    <td style={gc}>-</td><td style={gc}>-</td><td style={gc}>-</td><td style={gc}>-</td>
                    {tailCells}
                  </tr>
                );
              }
              segs.forEach((seg, si) => {
                const brks = seg.breaks || [];
                const rs = 1 + brks.length;
                rows.push(
                  <tr key={fd.date + '-s' + si} className={rowCls}>
                    {si === 0 && dayCells}
                    <td style={gc}>{si === 0 && dayPill}</td>
                    <td style={gc}>
                      {!noEdit && (
                        <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                          {!self && <button type="button" onClick={() => setEditDay({ date: fd.date, seg })} style={btn} title="Edit this shift - its times, location or Type, or delete a punch">Edit</button>}
                          {si === segs.length - 1 && addBtn}
                        </span>
                      )}
                    </td>
                    <td style={gc}>{timeCell(seg, 'in')}</td>
                    <td style={gc}>{timeCell(seg, 'out')}</td>
                    <td rowSpan={rs} style={gc}>{seg.category || '-'}</td>
                    <td rowSpan={rs} style={{ ...gc, fontWeight: 700 }}>{hhmm(seg.workedMin)}</td>
                    {si === 0 && tailCells}
                  </tr>
                );
                brks.forEach((b, bi) => {
                  const bseg = breakSeg(b);
                  rows.push(
                    <tr key={fd.date + '-s' + si + '-b' + bi} className={rowCls}>
                      <td style={{ ...gc, color: 'var(--muted)', fontStyle: 'italic' }}>Break</td>
                      <td style={gc}>
                        {!noEdit && <button type="button" onClick={() => setBreakFix({ date: fd.date, breaks: formal })} style={btn}
                          title={self ? 'Ask your approver to fix or remove this break' : 'Fix the start or end of this break, or delete it'}>Edit</button>}
                      </td>
                      <td style={gc}><InlineTime seg={bseg} k="in" meta={pm[b.startId]} showRaw={showRaw} locked={noEdit} onSaved={load} toastErr={toastErr} self={self} /></td>
                      <td style={gc} title={`${hhmm(b.min)} break`}>{bseg.out ? <InlineTime seg={bseg} k="out" meta={pm[b.endId]} showRaw={showRaw} locked={noEdit} onSaved={load} toastErr={toastErr} self={self} /> : missing(seg, 'brk')}</td>
                    </tr>
                  );
                });
              });

              // ── Auto-closed day (no clock-out was recorded): the same loud line
              //    the hourly card gets, so 'Absent' / 0 hours never reads as unexplained ──
              if (segs.some(s => (s.flags || []).includes('auto_clock_out'))) rows.push(
                <tr key={fd.date + '-auto'} className={rowCls}>
                  <td colSpan={cols} style={{ ...gc, textAlign: 'left', color: '#b91c1c', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    <AlertTriangle size={11} style={{ marginRight: 5, verticalAlign: 'middle' }} />
                    Auto-closed at end of day - no clock-out was recorded. The day is held until the real Out time is set{self ? ' - tap the Out time to propose the real end of your shift.' : '.'}
                  </td>
                </tr>
              );

              // ── The note line: the employee's note, HR's, what is on the punches ──
              if (notes.length || recs.length || hrNote || (!self && note?.employeeNote)) rows.push(
                <tr key={fd.date + '-notes'} className={rowCls}>
                  <td colSpan={cols} style={{ ...gc, textAlign: 'left', whiteSpace: 'normal', fontSize: 12, paddingLeft: 26 }}>
                    <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                      {!self && note?.employeeNote && (
                        <span title={note.employeeNoteAt ? `Written ${formatDate(note.employeeNoteAt)}` : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <strong>Note by employee:</strong> {note.employeeNote}
                        </span>
                      )}
                      {hrNote && (
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                          <strong style={{ whiteSpace: 'nowrap' }}>{self ? 'Your note' : 'Note by HR'}:</strong>
                          {self
                            ? <NoteCell date={fd.date} note={myN} onSave={saveMyNote} placeholder="Add a note for your manager" lines={1} maxWidth="none" />
                            : <NoteCell date={fd.date} note={note} onSave={saveNote} lines={1} maxWidth="none" />}
                        </span>
                      )}
                      {recs.length > 0 && <RecordTag recs={recs} batches={data.recordBatches} toastErr={toastErr} />}
                      {notes.length > 0 && <span><strong>On the punches:</strong> <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{namesIn(notes.join('  ·  '), nameFor)}</span></span>}
                    </div>
                  </td>
                </tr>
              );

              // ── Pending add/remove requests on this day - HR approves/rejects here ──
              (reqsByDate[fd.date] || []).forEach(r => {
                const kindLabel = r.action === 'remove' ? 'Remove a punch'
                  : `Add ${PR_KIND_LABEL[r.punchKind] || r.punchKind}${r.category ? ` as ${r.category}` : ''}`;
                rows.push(
                  <tr key={fd.date + '-req-' + r.id} style={{ background: 'rgba(180,83,9,0.07)' }}>
                    <td colSpan={cols} style={{ ...gc, textAlign: 'left', whiteSpace: 'normal', fontSize: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: 'rgba(180,83,9,0.16)', color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={10} /> Not Yet Approved</span>
                        <span style={{ color: '#b45309', fontWeight: 700 }}>{kindLabel}{r.action === 'add' && r.at ? ` at ${t12(r.at)}` : ''}</span>
                        {r.reason && <span style={{ color: '#b45309', fontStyle: 'italic' }}>{self ? 'Your reason' : (r.employeeName || 'Employee')}: “{r.reason}”</span>}
                        <span style={{ flex: 1 }} />
                        {self
                          ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>with your approver - not in your hours yet</span>
                          : !noEdit && (
                            <span style={{ display: 'inline-flex', gap: 6 }}>
                              <button onClick={() => decideReq(r.id, 'approved')} title="Approve - adds this punch to the time sheet" style={{ ...reqBtn, border: 'none', background: 'hsl(var(--color-green))', color: '#fff' }}>Approve</button>
                              <button onClick={() => decideReq(r.id, 'rejected')} title="Reject - the employee is notified" style={{ ...reqBtn, border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)' }}>Reject</button>
                            </span>
                          )}
                      </div>
                    </td>
                  </tr>
                );
              });
              return rows;
            })}
          </tbody>
        </table>
      </div>

      {/* Monthly pay summary - payroll's, never the manager tier's */}
      <div style={{ marginTop: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '0 1 620px', minWidth: 300, display: showPay ? undefined : 'none', border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
          {(() => {
            const rows = [
              [data.contractor ? (fixedSplit ? 'Fee this month (pro-rated by day)' : 'Monthly fee') : (fixedSplit ? 'Salary this month (pro-rated by day)' : 'Monthly salary'), fmtM(T.salaryForPeriod ?? T.monthlySalary)],
              // Why the days were missed (Charmi, Oct 15 2026): "Sick ×2 · Personal ×8"
              // instead of only a count - the server sends missedReasons.
              [<span key="missed">
                {`${icp ? 'Unpaid days after reconciliation' : 'Missed days'} (${T.missedFullDays} full${T.missedHalfDays ? `, ${T.missedHalfDays} half` : ''})`}
                {(T.missedReasons || []).length > 0 && (
                  <span data-missed-reasons style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--ink)', fontWeight: 600 }}>
                    {T.missedReasons.map((m, i) => (
                      <span key={m.reason}>
                        {i > 0 && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · </span>}
                        {missedText(m)}
                      </span>
                    ))}
                  </span>
                )}
              </span>, T.deduction ? `−${fmtM(T.deduction)}` : fmtM(0)],
              icp
                ? [`Extra Time (${hm(T.extraTimeMin)} approved at ${fmtM(icp.extraTime?.rate)}/hr)`, T.extraTimePay ? `+${fmtM(T.extraTimePay)}` : fmtM(0)]
                : [`Weekend pay (${T.weekendDaysWorked} day${T.weekendDaysWorked === 1 ? '' : 's'}, ${data.weekendMultiplier || 1.35} × daily by hours)`, T.weekendBonus ? `+${fmtM(T.weekendBonus)}` : fmtM(0)],
              ...(data.bonuses || []).map(b => [`Bonus: ${b.description}`, `+${fmtM(b.amount)}`]),
              // Salary advance repayments (Oct 27 2026): off what is paid out.
              ...(data.advanceRepayments || []).filter(x => x.applied > 0).map(x => ['Salary Advance Repayment', `-${fmtM(x.applied)}`]),
              [data.contractor ? 'Invoice amount this month' : 'Net pay this month', fmtM(T.netPay ?? T.totalPay)],
            ];
            const last = rows.length - 1;
            return rows.map(([lbl, amt], i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 8, padding: '9px 14px', borderTop: i ? '1px solid var(--line)' : 'none', background: i === last ? 'var(--wk-hover)' : 'transparent', fontWeight: i === last ? 800 : 500, fontSize: i === last ? 14 : 12.5 }}>
                <span style={{ color: i === last ? 'var(--ink)' : 'var(--muted)' }}>{lbl}</span>
                <span style={{ textAlign: 'right', color: i === last ? 'var(--wk-brand)' : 'var(--ink)' }}>{amt}</span>
              </div>
            ));
          })()}
        </div>
        {icp && <ReconciliationPanel data={data} fmtM={fmtM} showPay={showPay} />}
        <div style={{ minWidth: 200, fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
            <span>Missing punches</span><span style={{ fontWeight: 700, color: T.missingPunches ? '#b91c1c' : 'var(--ink)' }}>{T.missingPunches}</span>
          </div>
          {T.pendingEdits > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: '#b45309', fontWeight: 700 }} title={self ? 'Your edits waiting for approval' : 'Employee edits awaiting your review'}>
              <span>Pending edits</span><span>{T.pendingEdits}</span>
            </div>
          )}
          {!self && ((fin && data.review?.canUnlock) || (isAdmin && LEGACY_FINALIZE)) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {fin && data.review?.canUnlock && (
                <button className="secondary-btn" onClick={onUnfinalize} disabled={busy} style={{ fontSize: 12.5 }}>Unlock</button>)}
              {isAdmin && !fin && !ownCard && LEGACY_FINALIZE && (
                <button className="secondary-btn" onClick={onFinalize} disabled={busy} title="HR override: finalize for payroll without the review and signatures"
                  style={{ fontSize: 12.5 }}>Finalize Without Signatures</button>)}
            </div>
          )}
        </div>
      </div>

      <TimecardBonuses card={data} periodStart={data.periodStart} self={self} locked={ownCard || (!!fin && !data.review?.isHr)} fmtM={fmtM} showPay={showPay}
        onChanged={load} toastOk={toastOk} toastErr={toastErr} />
      <TimeSheetAdvances adv={adv} self={self} me={me} toastOk={toastOk} toastErr={toastErr} />

      {/* Review + Nexus Sign (same as hourly) - at the top on the employee's own sheet */}
      {!self && <TimesheetReviewPanel review={data.review} self={self} anchor={data.periodStart} periodLabel={monthLabel}
        nameFor={nameFor} onChanged={load} toastOk={toastOk} toastErr={toastErr}
          below={data.contractor ? <InvoiceCard invoice={data.invoice} toastOk={toastOk} toastErr={toastErr} onSent={load} /> : null} />}

      {editDay && (
        <PunchEditModal day={editDay} email={email} busy={busy} setBusy={setBusy}
          onDone={() => { setEditDay(null); load(); }} onClose={() => setEditDay(null)}
          toastOk={toastOk} toastErr={toastErr} self={self} />
      )}
      {breakFix && (
        <BreakFixModal day={breakFix} email={email} self={self} busy={busy} setBusy={setBusy}
          onDone={() => { setBreakFix(null); load(); }} onClose={() => setBreakFix(null)}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      {noteModal && (
        <NoteModal dates={fixedDays.map(fd => fd.date)} dow={dow} self={self}
          noteFor={(ds) => (self ? myNote(ds)?.note : dayNotes[ds]?.note) || ''}
          onSave={self ? saveMyNote : saveNote} toastOk={toastOk} onClose={() => setNoteModal(false)} />
      )}
      {dupDay && !self && email && !ownCard && data.review?.isHr && (
        <AddTimeFromRecordModal email={email} name={nameFor(email)} start={data.periodStart} end={data.periodEnd} onClose={() => setDupDay(false)}
          onDone={() => { _timecardCache.clear(); load(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
      {geoMap && (
        <GeofencePunchModal email={geoMap} name={data?.name || nameFor?.(geoMap) || geoMap} start={data?.periodStart || ''} end={data?.periodEnd || ''} onClose={() => setGeoMap('')} />
      )}
      {xtClaim && (
        <ExtraTimeClaimModal fd={xtClaim} onClose={() => setXtClaim(null)} onDone={() => { setXtClaim(null); load(); }}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      {xtDecide && (
        <ExtraTimeDecideModal fd={xtDecide} name={data?.name || nameFor?.(email) || ''} onClose={() => setXtDecide(null)}
          onDone={() => { setXtDecide(null); load(); }} toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}

// The key to the In / Out color banding (Pranshu, Oct 19), above the grid on
// the manager / HR card. Classes live in style.css so dark mode has its own shades.
// Add Time From Record (Oct 27 2026; was Duplicate Day): HR keys in a time
// sheet kept outside Nexus - one day laid over a range, every day reviewed.
// Shown to HR only (review.isHr); the server refuses anyone else either way.
function AddTimeFromRecordButton({ onClick }) {
  return (
    <button type="button" data-record-time onClick={onClick} title="HR: add time from a paper time sheet or another record - set one day, lay it over a range of days, then review each day"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' }}>
      <ClipboardList size={13} /> Add Time From Record
    </button>
  );
}

// Print Time Sheet (Neil, Oct 23 2026): print the period to be signed on
// paper, not through Nexus Sign, hourly or salaried. Manager and HR, once the
// manager has approved it (Oct 28 2026) - the server refuses anyone else and
// any earlier stage either way. The tab opens before the fetch so the browser
// does not treat it as a pop-up.
const PRINT_STATUSES = new Set(['approved', 'signing', 'completed', 'correcting']);
const mayPrint = (self, ownCard, fin, review) => !self && !ownCard && (!!fin || PRINT_STATUSES.has(review?.status));
function PrintTimeSheetButton({ email, start, toastErr }) {
  const [printing, setPrinting] = useState(false);
  async function printSheet() {
    const tab = window.open('', '_blank');
    setPrinting(true);
    try {
      const res = await api.printTimeSheet(email, start);
      const url = URL.createObjectURL(res.blob);
      if (tab) tab.location.href = url;
      else downloadBlob(res.filename || 'Time Sheet.pdf', res.blob);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      toastErr?.(e?.message || 'Could not print the time sheet.');
    } finally { setPrinting(false); }
  }
  return (
    <button type="button" disabled={printing} onClick={printSheet}
      title="A PDF of this period to print and sign on paper, not through Nexus Sign. Managers and HR, once the manager has approved it."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: printing ? 'default' : 'pointer' }}>
      {printing ? <Spinner size={13} /> : <Printer size={13} />} Print Time Sheet
    </button>
  );
}

function TimeColorKey() {
  return (
    <div className="pt-time-key" aria-label="Time colors">
      <span><i className="pt-time-key-dot pt-time-clock" /> Clock Punch</span>
      <span><i className="pt-time-key-dot pt-time-hr" /> <b className="pt-time-hr">Edited by HR</b></span>
    </div>
  );
}

// SwipeClock's Punch History (Neil, Oct 16), on hover: the exact time and what
// it was rounded to, where the punch came from (app, browser, a manager's
// entry) with its site and IP, who entered or changed it and when.
const _z = (iso) => iso ? formatDateTime(iso + (iso.endsWith('Z') ? '' : 'Z')) : '';
const punchHistory = (meta, rounded) => !meta ? '' : [
  `${{ in: 'Clock-in', out: 'Clock-out', break_start: 'Break start', break_end: 'Break end' }[meta.kind] || meta.kind} at ${t12s(meta.at)}`
    + (rounded && t12(rounded) !== t12(meta.at) ? ` - counted as ${t12(rounded)} (rounded)` : ''),
  [meta.source, meta.site, meta.ip ? `IP ${meta.ip}` : ''].filter(Boolean).join(' · '),
  meta.manual && meta.createdBy ? `Entered by ${meta.createdBy} on ${_z(meta.createdAt)}` : '',
  meta.adjustedAt ? `Changed by ${meta.adjustedBy} on ${_z(meta.adjustedAt)}${meta.originalAt ? ` - was ${t12s(meta.originalAt)}` : ''}${meta.adjustNote ? `: ${meta.adjustNote}` : ''}` : '',
].filter(Boolean).join('\n');

function InlineTime({ seg, k, meta, showRaw, locked, onSaved, toastErr, self, locateEmail, onLocate }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [warn, setWarn] = useState(null);   // the AM / PM warning for the typed time
  const inputRef = useRef(null);
  const punchId = k === 'in' ? seg?.inId : seg?.outId;   // always available (for approve/reject)
  const id = (locked ? '' : punchId);                    // editable id (blank when locked)
  const raw = k === 'in' ? seg?.in : seg?.out;
  const rounded = k === 'in' ? (seg?.inR || seg?.in) : (seg?.outR || seg?.out);
  const pendingAt = k === 'in' ? seg?.inPendingAt : seg?.outPendingAt;
  const pendReason = k === 'in' ? seg?.inEditReason : seg?.outEditReason;
  const isPending = (k === 'in' ? seg?.inEditStatus : seg?.outEditStatus) === 'pending' && pendingAt;
  const adjustNote = k === 'in' ? seg?.inAdjustNote : seg?.outAdjustNote;   // why this punch was changed
  if (!raw) return <span style={{ color: 'var(--muted)' }}>-</span>;

  async function commit(atUtc, confirmLong = false) {
    if (self) {
      // Employee edit: goes to the approver, and does NOT change pay until approved.
      // A confirmed long shift needs the reason (the server refuses it without one).
      const reason = await dialog.prompt('', {
        title: `Change Your ${{ break_start: 'Break Start', break_end: 'Break End' }[meta?.kind] || (k === 'in' ? 'Clock-In' : 'Clock-Out')} Time`,
        message: confirmLong ? 'Say why the shift is this long - your approver reads it. Your pay is unchanged until they approve it.'
          : 'This is sent to your approver. Your pay is unchanged until they approve it.',
        placeholder: confirmLong ? 'Reason (required)' : 'Reason (optional)', confirmText: 'Send for Approval', required: confirmLong,
      });
      if (reason === null) return;   // cancelled
      try { await api.timePunchEditCreate({ punch_id: id, at: atUtc, reason: reason || '', ...(confirmLong ? { confirm_long: true } : {}) }); onSaved?.(); }
      catch (err) { toastErr?.(err?.message || 'Could not send the edit.'); }
    } else {
      try { await api.timeAdjustPunch(id, { at: atUtc }); onSaved?.(); }
      catch (err) { toastErr?.(err?.message || 'Could not save the time.'); }
    }
  }
  // AM / PM guard (Charmi, Oct 21): the other end of this shift, to judge the typed time against.
  const otherEnd = k === 'in' ? (seg?.out && { kind: 'out', at: utcToInput(seg.out) }) : (seg?.in && { kind: 'in', at: utcToInput(seg.in) });
  const finish = (v, confirmLong = false) => { setWarn(null); setEditing(false); return commit(inputToUtc(v), confirmLong); };

  if (editing) return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <input ref={inputRef} autoFocus type="datetime-local" className="form-input" value={val}
        onChange={e => { setVal(e.target.value); setWarn(null); }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setVal(''); setWarn(null); setEditing(false); } }}
        onBlur={async () => {
          const orig = utcToInput(raw);
          if (!val || val === orig) { setWarn(null); setEditing(false); return; }
          if (warn) return;   // the warning's buttons decide
          const issue = checkLongShift(otherEnd ? [otherEnd] : [], k, val);
          if (issue) { setWarn(issue); return; }
          await finish(val);
        }}
        style={{ fontSize: 12, padding: '2px 4px', width: 172 }} />
      <LongShiftWarning issue={warn} manager={!self} compact
        onFix={() => { setWarn(null); inputRef.current?.focus(); }}
        onUseSuggestion={(w) => { setVal(w.suggest); finish(w.suggest); }}
        onConfirm={() => finish(val, true)} />
    </span>
  );
  // Each punch is judged on its own: the In dot is the in punch, the Out dot the out punch.
  const geo = (k === 'out' ? seg.geoOut : seg.geo) || '';
  const siteName = (k === 'out' ? seg.workSiteOut : seg.workSite) || '';
  const mini = { border: 'none', background: 'none', cursor: 'pointer', padding: '0 2px', fontWeight: 800, fontSize: 12, lineHeight: 1 };
  const dotColor = geo === 'in_fence' ? 'hsl(var(--color-green))' : geo === 'out_of_fence' ? '#b91c1c' : 'var(--line-strong,var(--line))';
  // Clicking the location dot opens the Geofence Punch view for this person and
  // period (SwipeClock-style map + punch table, Charmi Sep 25).
  const openMap = (e) => { e.stopPropagation(); if (!locateEmail) return; onLocate?.(); };
  const dotTitle = (geo === 'in_fence' ? `On site${siteName ? ` - ${siteName}` : ''}` : geo === 'out_of_fence' ? `Out of Location${siteName ? ` - nearest ${siteName}` : ''}` : geo === 'no_site' ? 'No location mapped' : geo === 'low_accuracy' ? 'Approx. location - no GPS, too rough to tell which site' : geo === 'remote' ? 'Remote' : geo === 'no_location' ? 'No location shared' : geo === 'location_off' ? 'Location turned off' : 'GPS only');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {geo && geo !== 'no_location' && geo !== 'location_off' && (locateEmail
        // The dot is drawn INSIDE the button: a phone card gives every button
        // in the row a 32px tap height (style.css .pr-dcard-times button), and
        // a button that was itself the 10px dot stretched into an oval (Neil,
        // Oct 18). The button is the tap target; the span stays a circle.
        ? <button onClick={openMap} aria-label="Open the geofence punch map" title={`${dotTitle} - click for the punch map`}
            className="pr-geo-dot"
            style={{ width: 20, height: 20, margin: -5, flexShrink: 0, padding: 0, cursor: 'pointer', border: 'none', background: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: dotColor, boxShadow: `0 0 0 2px var(--card), 0 0 0 3px ${dotColor}` }} />
          </button>
        : <span title={dotTitle}
            style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: dotColor }} />)}
      <button onClick={() => { if (!id) return; setVal(utcToInput(raw)); setEditing(true); }}
        title={[punchHistory(meta, rounded), id ? (self ? 'Click to propose a new time - goes to your approver; pay unchanged until approved' : 'Click to edit this punch time - the original stays on record') : ''].filter(Boolean).join('\n')}
        style={{ background: 'none', border: 'none', padding: 0, cursor: id ? 'pointer' : 'default', font: 'inherit', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {/* A punch someone entered or changed reads bold, as on SwipeClock; on
            the manager / HR card it is also color-banded: green straight off the
            clock, blue entered or changed by HR (punchMeta.clock / .byHr). */}
        <span className={!self ? (meta?.byHr ? 'pt-time-hr' : meta?.clock ? 'pt-time-clock' : undefined) : undefined}
          style={{ borderBottom: id ? `1px dashed ${self ? 'var(--wk-brand)' : 'var(--line-strong,var(--line))'}` : '1px dashed var(--line-strong,var(--line))', color: self && id ? 'var(--wk-brand)' : undefined, fontWeight: (meta?.manual || meta?.adjustedAt) ? 800 : self && id ? 600 : undefined }}>{t12(rounded)}</span>
        {self && id && <Pencil size={10} style={{ opacity: 0.7, flexShrink: 0, color: 'var(--wk-brand)' }} />}
        {showRaw && <span style={{ fontSize: 10.5, fontStyle: 'italic', color: 'var(--muted)' }}>{t12s(raw)}</span>}
      </button>
      {!isPending && adjustNote && (
        /* This punch time was changed - hover the info dot for the reason on record. */
        <span title={`Time changed: ${adjustNote}`} aria-label={`Time changed: ${adjustNote}`}
          style={{ display: 'inline-flex', color: '#b45309', cursor: 'help', flexShrink: 0 }}>
          <Info size={12} />
        </span>
      )}
      {isPending && (
        <span className={self ? undefined : 'nx-needs-you--inline'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: '#b45309', fontWeight: 700 }}
          title={`${self ? 'Your proposed time' : 'Proposed by employee'}${pendReason ? ': ' + pendReason : ''} - not counted until approved`}>
          &rarr; {t12(pendingAt)} <span style={{ fontStyle: 'italic' }}>pending</span>
          {!self && !locked && punchId && (
            <>
              <button title="Approve this time" aria-label="Approve this edited time" style={{ ...mini, color: 'hsl(var(--color-green))' }}
                onClick={async () => { try { await api.timePunchEditDecide(punchId, { status: 'approved' }); onSaved?.(); } catch (e) { toastErr?.(e?.message || 'Could not approve.'); } }}>&#10003;</button>
              <button title="Reject this time" aria-label="Reject this edited time" style={{ ...mini, color: '#b91c1c' }}
                onClick={async () => { const note = await dialog.prompt('', { title: 'Reject edit', message: 'Sent to the employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true }); if (note === null) return; try { await api.timePunchEditDecide(punchId, { status: 'rejected', note: note || '' }); onSaved?.(); } catch (e) { toastErr?.(e?.message || 'Could not reject.'); } }}>&#10007;</button>
            </>
          )}
        </span>
      )}
    </span>
  );
}

// Ask an approver for a BREAK punch that never recorded. Breaks are the half of
// the timecard PunchEditModal has never covered: it works from seg.inId/seg.outId
// and so can only ever offer clock-in and clock-out. A break punch lost on the
// way to the server (see lib/punchQueue.js) therefore left the employee with a
// day they could see was wrong and no way to say so - which is exactly what got
// reported. Same gated route as every other fix: a PunchRequest, nothing moves
// on pay until it is approved.
// Sep 29: a manager (self = false) fixes the break straight on the card - the
// same POST /timeclock/punches their "+ add" uses, so the employee is told and
// the change is on record. An employee (self) still sends a request for their
// approver, as before. Before this a break that never ended could not be fixed
// by a manager at all, and it blocks sign-off.
// "YYYY-MM-DDTHH:mm" (a datetime-local value) plus m minutes, in local time.
function addMinutesInput(v, m) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  d.setMinutes(d.getMinutes() + m);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const BREAK_REASONS_SELF = ['Forgot to punch back in', 'A customer came in', 'Took a call', "It didn't record"];
const BREAK_REASONS_MANAGER = ['Confirmed with the employee', 'Forgot to punch back in', 'A customer came in'];
const QUICK_CHIP = { fontSize: 11.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' };
const QUICK_CHIP_ON = { borderColor: 'var(--wk-brand)', color: 'var(--wk-brand)', background: 'hsla(var(--color-green),0.08)' };

export function BreakFixModal({ day, email = '', self = true, busy, setBusy, onDone, onClose, toastOk, toastErr }) {
  // A break the day's clock-out closed (implicit) is one whose END never landed -
  // by far the common case, so open on it with its start time already known.
  const unended = (day.breaks || []).find(b => b.implicit);
  // Adding a WHOLE break is the Add punch form with Type = Break (Neil, Oct 13).
  const [kind, setKind] = useState(unended ? 'break_end' : 'break_start');
  const [endAt, setEndAt] = useState(`${day.date}T12:30`);
  // A break that never ended opens on 30 minutes after it started, with one-tap
  // 30 min / 45 min / 1 hour - the weekly "I went to lunch, a customer came in,
  // I never punched back in" (Charmi, Oct 19). It used to open on the break's
  // own start time, which can never be saved, so every fix began with typing.
  const unendedStart = unended?.start ? utcToInput(unended.start) : '';
  const [at, setAt] = useState(() => {
    if (unendedStart) return addMinutesInput(unendedStart, 30);
    const anchor = (day.breaks || [])[0]?.end || '';
    return anchor ? utcToInput(anchor) : `${day.date}T12:00`;
  });
  const [reason, setReason] = useState('');
  const label = kind === 'break_end' ? 'End Break' : 'Start Break';
  // Delete a break (Charmi, Oct 15 2026): a break punched by mistake, or one
  // that should never have counted. A manager voids its punches on the spot
  // (kept on record with the reason, like any punch edit); an employee asks
  // their approver to remove them. Only breaks the server named punches for.
  const deletable = (day.breaks || []).filter(b => b.startId);
  const [delIdx, setDelIdx] = useState(() => Math.max(0, deletable.findIndex(b => b.implicit)));
  const isDelete = kind === 'delete';
  const brLabel = (b) => `${t12(b.start)} - ${t12(b.end)} (${hhmm(b.min)})${b.implicit ? ' - never ended' : ''}`;

  async function removeBreak() {
    const b = deletable[delIdx];
    if (!b) return;
    // A manager's delete is immediate, so it asks first and says how to put it
    // back (Charmi, Oct 19: "then I won't be able to add it back").
    if (!self && !await dialog.confirm(
      `Delete the ${brLabel(b)} break? Its punches come off the time sheet (the record keeps them). To put a break back later, use Add Punch with Type Break.`,
      { title: 'Delete Break', confirmText: 'Delete Break', cancelText: 'Keep It', danger: true })) return;
    // End first, then start: never leave a lone break_end behind.
    const ids = [b.endId, b.startId].filter(Boolean);
    setBusy(true);
    try {
      for (const id of ids) {
        if (self) await api.timePunchRequestCreate({ action: 'remove', target_punch_id: id, reason: reason.trim() });
        else await api.timeAdjustPunch(id, { void: true, adjust_note: reason.trim() });
      }
      toastOk?.(self ? 'Request sent - your approver decides whether the break comes off.' : 'Break deleted - the time sheet is updated.');
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
      onDone();
    } catch (e) { toastErr?.(e?.message || 'Could not delete the break.'); }
    setBusy(false);
  }

  // AM / PM guard (Charmi, Oct 21): a break time more than 11 hours from the
  // shift's clock-in (12:30 AM for 12:30 PM) is shown before it saves.
  const [longWarn, setLongWarn] = useState(null);
  useEffect(() => { setLongWarn(null); }, [at, endAt, kind]);
  const shiftPunches = [day.shift?.in && { kind: 'in', at: utcToInput(day.shift.in) },
    day.shift?.out && { kind: 'out', at: utcToInput(day.shift.out) }].filter(Boolean);

  async function save(opts) {
    if (!reason.trim()) { toastErr?.(self ? 'Add a reason so your approver can confirm it.' : 'Add a reason - it is kept on record.'); return; }
    if (isDelete) { await removeBreak(); return; }
    const confirmLong = opts?.confirmLong === true;
    if (!confirmLong) {
      const issue = checkTypedPunches(shiftPunches, kind === 'both'
        ? [{ kind: 'break_start', at }, { kind: 'break_end', at: endAt }] : [{ kind, at }]);
      if (issue) { setLongWarn(issue); return; }
    }
    setLongWarn(null);
    if (kind === 'both') {
      if (new Date(endAt) <= new Date(at)) { toastErr?.('The break end has to be after the break started.'); return; }
      setBusy(true);
      try {
        await api.timeAddPunch({ employee_email: email, kind: 'break_start', at: inputToUtc(at), tz_offset_min: tzFor(at), note: reason.trim() });
        await api.timeAddPunch({ employee_email: email, kind: 'break_end', at: inputToUtc(endAt), tz_offset_min: tzFor(endAt), note: reason.trim() });
        toastOk?.('Break added - the time sheet is updated.');
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        onDone();
      } catch (e) { toastErr?.(e?.message || 'Could not add the break.'); }
      setBusy(false);
      return;
    }
    // An end that isn't after its start can't be approved (the server re-checks
    // the sequence), so catch it here rather than after a round trip.
    if (kind === 'break_end' && unended?.start && new Date(at) <= new Date(utcToInput(unended.start))) {
      toastErr?.('The break end has to be after the break started.'); return;
    }
    setBusy(true);
    try {
      if (self) {
        await api.timePunchRequestCreate({ action: 'add', punch_kind: kind, at: inputToUtc(at), tz_offset_min: tzFor(at), reason: reason.trim(),
          ...(confirmLong ? { confirm_long: true } : {}) });
        toastOk?.('Request sent to your approver - it shows on your time sheet as Not Yet Approved until they decide.');
      } else {
        await api.timeAddPunch({ employee_email: email, kind, at: inputToUtc(at), tz_offset_min: tzFor(at), note: reason.trim() });
        toastOk?.(kind === 'break_end' ? 'Break end added - the time sheet is updated.' : 'Break start added - the time sheet is updated.');
      }
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
      onDone();
    } catch (e) { toastErr?.(e?.message || 'Could not send the request.'); }
    setBusy(false);
  }

  const dirty = reason.trim() !== '';
  const guard = useUnsavedGuard(dirty, onClose, save);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div role="dialog" aria-modal="true" aria-label={isDelete ? (self ? 'Ask to remove a break' : 'Delete a break') : self ? 'Request a missing break punch' : kind === 'both' ? 'Add a break' : 'Fix a break punch'}
        className="nx-popup" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: 20, boxShadow: '0 24px 70px rgba(17,24,39,0.30)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{isDelete ? (self ? 'Ask to Remove a Break' : 'Delete a Break') : self ? 'Request a Missing Break Punch' : kind === 'both' ? 'Add a Break' : 'Fix a Break Punch'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        {unended && !isDelete && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: '#b45309', background: 'rgba(180,83,9,0.09)', border: '1px solid rgba(180,83,9,0.25)', borderRadius: 10, padding: '9px 12px', marginBottom: 12 }}>
            {self ? 'Your' : 'The'} break started at {t12(unended.start)} and was never ended, so the clock-out closed it
            and all {hhmm(unended.min)} of it counts as unpaid break. Set the time {self ? 'you' : 'they'} actually came back.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>What needs fixing
            <select className="form-input" value={kind} onChange={e => setKind(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
              <option value="break_end">{self ? 'End Break - I came back and it didn\'t record' : 'End Break - the break end is missing'}</option>
              <option value="break_start">{self ? 'Start Break - my break start didn\'t record' : 'Start Break - the break start is missing'}</option>
              {deletable.length > 0 && (
                <option value="delete">{self ? 'Remove a break - it should not be there' : 'Delete a break - it should not be there'}</option>
              )}
            </select>
          </label>
          {isDelete ? (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Which break
              <select className="form-input" value={delIdx} onChange={e => setDelIdx(Number(e.target.value))} style={{ width: '100%', fontSize: 13 }}>
                {deletable.map((b, i) => <option key={b.startId} value={i}>{brLabel(b)}</option>)}
              </select>
              <span style={{ display: 'block', marginTop: 5, fontSize: 11.5, color: 'var(--muted)' }}>
                {self ? 'Your approver decides; nothing changes until they approve.' : 'Its start and end punches come off the time sheet. The audit record keeps them, with who deleted them and why.'}
              </span>
            </label>
          ) : (
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>{kind === 'both' ? 'Break start' : label} time
            <input autoFocus type="datetime-local" className="form-input" value={at} onChange={e => setAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
            {kind === 'break_end' && unendedStart && (
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {[30, 45, 60].map(m => {
                  const v = addMinutesInput(unendedStart, m);
                  return (
                    <button key={m} type="button" onClick={() => setAt(v)} aria-pressed={at === v}
                      style={{ ...QUICK_CHIP, ...(at === v ? QUICK_CHIP_ON : {}) }}>
                      Back After {m === 60 ? '1 Hour' : `${m} Min`}
                    </button>
                  );
                })}
              </span>
            )}
          </label>
          )}
          {kind === 'both' && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Break end time
              <input type="datetime-local" className="form-input" value={endAt} onChange={e => setEndAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
            </label>
          )}
          <label className="nx-fill" style={{ fontSize: 11, color: 'var(--muted)' }}>{self ? 'Reason (sent to your approver - not the time)' : 'Reason (kept on record and shown to the employee)'}
            <textarea className="form-input" rows={3} value={reason} onChange={e => setReason(e.target.value)}
              placeholder={self ? "Why it's missing - e.g. ended my break on my phone and it didn't record" : 'Why - e.g. confirmed with them they were back at 1:00 PM'} style={{ width: '100%', fontSize: 13, fontFamily: 'inherit' }} />
            {!isDelete && (
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {(self ? BREAK_REASONS_SELF : BREAK_REASONS_MANAGER).map(r => (
                  <button key={r} type="button" onClick={() => setReason(r)} aria-pressed={reason === r}
                    style={{ ...QUICK_CHIP, ...(reason === r ? QUICK_CHIP_ON : {}) }}>{r}</button>
                ))}
              </span>
            )}
          </label>
        </div>
        <LongShiftWarning issue={longWarn} manager={!self} busy={busy}
          onFix={() => setLongWarn(null)}
          onUseSuggestion={(w) => { if (kind === 'both' && w.index === 1) setEndAt(w.suggest); else setAt(w.suggest); }}
          onConfirm={() => save({ confirmLong: true })} />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy}
            style={isDelete && !self ? { background: '#b91c1c', borderColor: '#b91c1c' } : undefined}>
            {busy ? '…' : self ? 'Send Request' : isDelete ? 'Delete Break' : kind === 'both' ? 'Add Break' : 'Save Break'}
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </div>
  );
}

function PunchEditModal({ day, email, categories = [], busy, setBusy, onDone, onClose, toastOk, toastErr, self = false }) {
  const seg = day.seg;
  // Defaults: keep an existing time; when ADDING the missing half of a pair, seed it
  // from the known half (a missing clock-out starts at the clock-in, not a random
  // 17:00 that silently books an 8-hour shift) so the user only nudges it.
  const [inAt, setInAt] = useState(seg?.in ? utcToInput(seg.in) : (seg?.out ? utcToInput(seg.out) : `${day.date}T09:00`));
  const [outAt, setOutAt] = useState(seg?.out ? utcToInput(seg.out) : (seg?.in ? utcToInput(seg.in) : `${day.date}T17:00`));
  const { data: sites = [] } = useWorkSites();
  const [siteId, setSiteId] = useState(seg?.workSiteId || '');
  const [cat, setCat] = useState(seg?.category || '');
  const [reason, setReason] = useState('');   // self mode: justification for the approver
  // A refused save says why INSIDE the form (Pranshu, Oct 13): the toast sat
  // behind the dialog, so "Send Request" looked like it did nothing.
  const [err, setErr] = useState('');
  const fail = (m) => { setErr(m); toastErr?.(m); };
  // Type (Neil, Oct 13): what this block of time is. Break is offered only when
  // ADDING - its start and end are the two times above, saved as a Start Break /
  // End Break pair. The leave types set the category.
  const initialType = day.type || typeOfCategory(seg?.category);
  const [type, setType] = useState(initialType);
  const isBreak = type === 'Break';
  // What's missing on this day and therefore addable (self can only ADD, not overwrite).
  const needIn = !seg?.inId, needOut = !seg?.outId;
  // Which missing punch to add (Pranshu, Oct 26): each one is ticked to be
  // added, so someone still at work asks for - or a manager adds - only the
  // clock-in. Today starts with the clock-out unticked: it is still to come,
  // and a time in the future is refused (Miranda, Oct 26: her 5 PM clock-out
  // sank the whole request).
  const nowInput = utcToInput(new Date().toISOString().slice(0, 19));
  const isToday = day.date === nowInput.slice(0, 10);
  const [addIn, setAddIn] = useState(true);
  const [addOut, setAddOut] = useState(!isToday);
  const hasIn = !needIn || addIn, hasOut = !needOut || addOut;   // a time the save ends up with
  // Type is offered when adding a whole block - a manager on any new pair, an
  // employee on a day they ask to add time to (Pranshu, Oct 13).
  const canAddBreak = !seg;
  const showType = self ? !seg : !!(seg?.inId || needIn);
  // AM / PM guard (Charmi, Oct 21): a pair longer than 11 hours is shown
  // in the form before anything saves. Any time change clears it.
  const [longWarn, setLongWarn] = useState(null);
  useEffect(() => { setLongWarn(null); }, [inAt, outAt, type]);

  async function save(opts) {
    setErr('');
    const confirmLong = opts?.confirmLong === true;
    if (!isBreak && !(needIn && addIn) && !(needOut && addOut) && (self || !seg)) {
      fail(self ? 'Tick Clock In or Clock Out - whichever you are asking for.' : 'Tick Clock In or Clock Out to add.'); return;
    }
    // A punch is never in the future (the server refuses it too): that one is
    // still to come - leave it unticked and punch it as usual.
    const ahead = (v) => Date.parse(`${inputToUtc(v)}Z`) > Date.now() + 5 * 60000;
    if (isBreak ? ahead(inAt) || ahead(outAt) : (hasIn && ahead(inAt)) || (hasOut && ahead(outAt))) {
      fail(!isBreak && hasOut && ahead(outAt) && !(hasIn && ahead(inAt))
        ? 'That clock-out is still to come. Untick Clock Out and punch out as usual, or add it once it has happened.'
        : 'A punch cannot be in the future.');
      return;
    }
    if (!isBreak && !confirmLong && hasIn && hasOut) {
      const issue = checkTypedPunches([], [{ kind: 'in', at: inAt }, { kind: 'out', at: outAt }]);
      if (issue) { setLongWarn(issue); return; }
    }
    if (confirmLong && self && !reason.trim()) { fail('Say why the shift is this long in the reason - your approver reads it.'); return; }
    setLongWarn(null);
    // A clock-out must be after the clock-in it pairs with. With the out now
    // defaulting to the in-time, leaving it unchanged trips this - forcing the real
    // time in - and it also catches a time accidentally typed into the reason field.
    const inRef = (seg?.inId && !needIn) ? utcToInput(seg.in) : inAt;
    if (needOut && addOut && hasIn && inRef && new Date(outAt) <= new Date(inRef)) {
      fail('Set the clock-out time - it has to be after the clock-in.'); return;
    }
    // ...and a clock-in added in front of an existing clock-out comes first (Oct 1).
    if (needIn && addIn && !needOut && seg?.out && new Date(inAt) >= new Date(utcToInput(seg.out))) {
      fail('Set the clock-in time - it has to be before the clock-out.'); return;
    }
    // Whichever side changed, the clock-out never ends up before the clock-in
    // (Oct 1) - the server refuses it too (_guard_punch_order).
    if (hasIn && hasOut && inAt && outAt && new Date(outAt) <= new Date(inAt)) {
      fail('The clock-out has to be after the clock-in.'); return;
    }
    // A pair of requests goes in whole or not at all: when the second half is
    // refused, the first is taken back, so closing the popup after the error
    // really leaves nothing behind (Miranda, Oct 18: the clock-in stayed
    // pending and blocked her next try as "already asked").
    const sendRequests = async (bodies) => {
      const sent = [];
      try {
        for (const b of bodies) sent.push(await api.timePunchRequestCreate(b));
      } catch (err) {
        for (const r of sent) { if (r?.id) await api.timeCancelPunchRequest(r.id).catch(() => {}); }
        if (sent.length) window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        throw err;
      }
    };
    // A break: the two times are its start and end, inside a shift that day.
    if (isBreak && canAddBreak && self) {
      if (!reason.trim()) { fail('Add a reason so your approver can confirm it.'); return; }
      setBusy(true);
      try {
        await sendRequests([
          { action: 'add', punch_kind: 'break_start', at: inputToUtc(inAt), tz_offset_min: tzFor(inAt), reason: reason.trim() },
          { action: 'add', punch_kind: 'break_end', at: inputToUtc(outAt), tz_offset_min: tzFor(outAt), reason: reason.trim() },
        ]);
        toastOk?.('Request sent to your approver - it shows on your time sheet as Not Yet Approved until they decide.');
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        onDone();
      } catch (e) { fail(e?.message || 'Could not send the request.'); }
      setBusy(false);
      return;
    }
    if (isBreak && canAddBreak) {
      setBusy(true);
      try {
        await api.timeAddPunch({ employee_email: email, kind: 'break_start', at: inputToUtc(inAt), tz_offset_min: tzFor(inAt), note: 'payroll edit' });
        await api.timeAddPunch({ employee_email: email, kind: 'break_end', at: inputToUtc(outAt), tz_offset_min: tzFor(outAt), note: 'payroll edit' });
        toastOk?.('Break added - the time sheet is updated.');
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
        onDone();
      } catch (e) { fail(e?.message || 'Could not add the break - it has to fall inside a shift that day.'); }
      setBusy(false);
      return;
    }
    // Employees don't write the timecard directly - a missing punch becomes an
    // approver-confirmed REQUEST. Nothing moves on pay until it's approved.
    if (self) {
      if (!reason.trim()) { fail('Add a reason so your approver can confirm it.'); return; }
      setBusy(true);
      try {
        const adds = [];
        if (needIn && addIn) adds.push(['in', inAt]);
        if (needOut && addOut) adds.push(['out', outAt]);
        await sendRequests(adds.map(([kind, at]) => ({ action: 'add', punch_kind: kind, at: inputToUtc(at), tz_offset_min: tzFor(at), reason: reason.trim(),
          category: kind === 'in' && LEAVE_TYPES.includes(type) ? type : '', ...(confirmLong ? { confirm_long: true } : {}) })));
        toastOk?.(needIn && addIn && !(needOut && addOut) && !seg
          ? 'Request sent. Once your approver approves it you are clocked in - punch out as usual.'
          : 'Request sent to your approver - it shows on your time sheet as Not Yet Approved until they decide.');
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));   // refresh the request stack
        onDone();
      } catch (e) { fail(e?.message || 'Could not send the request.'); }
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      // Edit existing in-punch, or add one
      const saveIn = async () => {
        if (seg?.inId) {
          if (utcToInput(seg.in) !== inAt) await api.timeAdjustPunch(seg.inId, { at: inputToUtc(inAt) });
          // Reassign location (work site) on the in-punch if it changed.
          if (siteId !== (seg.workSiteId || '')) await api.timeAdjustPunch(seg.inId, { work_site_id: siteId });
          // Job-costing category on the in-punch.
          if (cat !== (seg.category || '')) await api.timeAdjustPunch(seg.inId, { category: cat });
        } else {
          // A new in-punch carries the category - so "Sick" / "Vacation" /
          // "Personal" entered for someone lands as paid leave in one save.
          await api.timeAddPunch({ employee_email: email, kind: 'in', at: inputToUtc(inAt), tz_offset_min: tzFor(inAt), note: 'payroll edit', category: cat });
        }
      };
      // Edit existing out-punch, or add one
      const saveOut = async () => {
        if (seg?.outId) { if (utcToInput(seg.out) !== outAt) await api.timeAdjustPunch(seg.outId, { at: inputToUtc(outAt) }); }
        else await api.timeAddPunch({ employee_email: email, kind: 'out', at: inputToUtc(outAt), tz_offset_min: tzFor(outAt), note: 'payroll edit' });
      };
      // Moving a whole shift later (9-5 -> 6-10 PM): saving the new in first
      // would sit it after the old out for a moment, which the server refuses
      // as a clock-out before a clock-in. Then the out goes first.
      const outFirst = !!(seg?.outId && seg?.out && new Date(inAt) >= new Date(utcToInput(seg.out)));
      // An unticked missing punch is left out (an open shift stays open).
      const doIn = hasIn ? saveIn : async () => {}, doOut = hasOut ? saveOut : async () => {};
      if (outFirst) { await doOut(); await doIn(); } else { await doIn(); await doOut(); }
      toastOk?.('Time sheet updated - original times stay on record.'); onDone();
    } catch (e) { fail(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  // Delete one punch or the whole pair (Neil, Oct 12-13 - SwipeClock's
  // "delete"). The punch is voided server-side: it leaves the hours but stays
  // on record with who deleted it, so nothing is physically lost.
  async function voidPunches(ids, what) {
    const list = ids.filter(Boolean);
    if (!list.length) return;
    if (!await dialog.confirm(`Delete ${what}? It comes off the time sheet and out of the hours. The audit record keeps it, with who deleted it.`,
      { title: 'Delete punch', confirmText: 'Delete', danger: true })) return;
    setBusy(true);
    try {
      for (const id of list) await api.timeAdjustPunch(id, { void: true });
      toastOk?.(list.length > 1 ? 'Punches deleted.' : 'Punch deleted.'); onDone();
    } catch (e) { fail(e?.message || 'Could not delete.'); }
    setBusy(false);
  }
  const removeOut = () => voidPunches([seg?.outId], 'the clock-out');
  const removeIn = () => voidPunches([seg?.inId], 'the clock-in');
  const removePair = () => voidPunches([seg?.inId, seg?.outId], 'this whole punch pair');
  // Picking a Type: a leave type sets the category; Regular clears a leave
  // category (a job code stays); Break swaps the two times to a break window.
  const pickType = (t) => {
    setType(t);
    if (LEAVE_TYPES.includes(t)) setCat(t);
    else if (typeOfCategory(cat) !== 'Regular') setCat('');
    if (t === 'Break' && inAt === initialInAt && outAt === initialOutAt) {
      setInAt(`${day.date}T12:00`); setOutAt(`${day.date}T12:30`);
    }
  };

  // seg/day are fixed for this modal instance's lifetime, so recomputing the
  // same expressions the useState initializers used gives the baseline.
  const initialInAt = seg?.in ? utcToInput(seg.in) : (seg?.out ? utcToInput(seg.out) : `${day.date}T09:00`);
  const initialOutAt = seg?.out ? utcToInput(seg.out) : (seg?.in ? utcToInput(seg.in) : `${day.date}T17:00`);
  const dirty = inAt !== initialInAt || outAt !== initialOutAt || siteId !== (seg?.workSiteId || '')
    || cat !== (seg?.category || '') || reason.trim() !== '' || type !== initialType;
  const guard = useUnsavedGuard(dirty, onClose, save);

  // A time box; a MISSING punch gets a tick to add it, and unticked it is
  // left out of the save (a break is always both times).
  const timeRow = ({ text, pickText, value, set, missing, on, setOn, autoFocus, off = 'Not added.' }) => {
    const locked = self && !missing;
    const box = (
      <input aria-label={text} autoFocus={autoFocus} type="datetime-local" className="form-input" value={value} disabled={locked}
        onChange={e => set(e.target.value)} style={{ width: '100%', fontSize: 13, opacity: locked ? 0.6 : 1 }} />
    );
    if (!missing) return <label style={{ fontSize: 11, color: 'var(--muted)' }}>{text}{box}</label>;
    // One shape with or without the tick, so picking Break never remounts the box.
    return (
      <div style={{ fontSize: 11, color: 'var(--muted)', display: 'grid', gap: 4 }}>
        {isBreak ? <span>{text}</span> : (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
            <input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} style={{ margin: 0 }} /> {pickText}
          </label>
        )}
        {on || isBreak ? box : <span style={{ fontSize: 12 }}>{off}</span>}
      </div>
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div role="dialog" aria-modal="true" aria-label={self ? 'Request a missing punch' : seg ? 'Edit punch' : isBreak ? 'Add break' : 'Add punch'}
        className="nx-popup" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: 20, boxShadow: '0 24px 70px rgba(17,24,39,0.30)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{self ? 'Request a Missing Punch' : seg ? 'Edit Punch' : isBreak ? 'Add Break' : 'Add Punch'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {/* In self mode only the MISSING punch is editable - an existing time stays
              shown (disabled) for context but can't be silently overwritten here. */}
          {showType && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Type
              <ChoicePills label="Type" value={type} onChange={pickType}
                options={['Regular', ...(canAddBreak ? ['Break'] : []), ...LEAVE_TYPES]} />
            </div>
          )}
          {(!self || needIn) && timeRow({ text: isBreak ? 'Break start time' : 'Clock in time', pickText: 'Clock In', value: inAt, set: setInAt, missing: needIn, on: addIn, setOn: setAddIn, autoFocus: self && needIn })}
          {(!self || needOut) && timeRow({ text: isBreak ? 'Break end time' : 'Clock out time', pickText: 'Clock Out', value: outAt, set: setOutAt, missing: needOut, on: addOut, setOn: setAddOut, autoFocus: self && needOut && !needIn,
            off: isToday ? 'Not added - it is still to come. Punch out as usual, or tick it once it has happened.' : 'Not added.' })}
          {self && (
            <label className="nx-fill" style={{ fontSize: 11, color: 'var(--muted)' }}>Reason (sent to your approver - not the time)
              <textarea className="form-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why you're adding it - e.g. forgot to clock out" style={{ width: '100%', fontSize: 13, fontFamily: 'inherit' }} />
            </label>
          )}
          {!self && seg?.inId && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Location
              <select className="form-input" value={siteId} onChange={e => setSiteId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="">- No location -</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Reassigning marks the punch as on-site at the chosen location.</span>
            </label>
          )}
          {!self && !isBreak && (seg?.inId || needIn) && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Category (job / cost code)
              <input list="pr-cats" className="form-input" value={cat} onChange={e => { setCat(e.target.value); setType(typeOfCategory(e.target.value)); }}
                placeholder="e.g. Operations-GS" style={{ width: '100%', fontSize: 13 }} />
              <datalist id="pr-cats">{categories.map(c => <option key={c} value={c} />)}</datalist>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Sick, Vacation or Personal makes this block paid leave - base rate, not counted toward overtime.</span>
            </label>
          )}
          {isBreak && (
            <span style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: -6 }}>An unpaid break. It has to fall inside a shift that day - add the shift first if there is none.</span>
          )}
        </div>
        {err && (
          <div role="alert" style={{ marginTop: 12, padding: '8px 12px', borderRadius: 9, background: 'rgba(185,28,28,0.08)', border: '1px solid rgba(185,28,28,0.3)', color: '#b91c1c', fontSize: 12.5, fontWeight: 600 }}>
            {err}
          </div>
        )}
        <LongShiftWarning issue={longWarn} manager={!self} busy={busy}
          onFix={() => setLongWarn(null)}
          onUseSuggestion={(w) => { if (w.index === 0) setInAt(w.suggest); else setOutAt(w.suggest); }}
          onConfirm={() => save({ confirmLong: true })} />
        <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {!self && seg?.inId && <button onClick={removeIn} disabled={busy} style={{ background: 'none', border: 'none', padding: 0, color: '#b91c1c', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>Delete In-Punch</button>}
          {!self && seg?.outId && <button onClick={removeOut} disabled={busy} style={{ background: 'none', border: 'none', padding: 0, color: '#b91c1c', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>Delete Out-Punch</button>}
          {!self && seg?.inId && seg?.outId && <button onClick={removePair} disabled={busy} style={{ background: 'none', border: 'none', padding: 0, color: '#b91c1c', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>Delete Both</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy}>{busy ? '…' : self ? 'Send Request' : isBreak ? 'Add Break' : 'Save'}</button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </div>
  );
}
