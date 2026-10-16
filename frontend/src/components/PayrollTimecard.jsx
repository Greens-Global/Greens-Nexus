import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowRight, Pencil, Plus, X, CheckCircle, Download, AlertTriangle, MapPin, MapPinOff, PlayCircle, Info, SlidersHorizontal } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { TZ_OPTIONS, useDisplayTz, setDisplayTz, formatTimeTz, utcToInputTz, inputToUtcTz, tzOffsetForInput, useOwnZone } from '../lib/displayTz';
import { dialog } from '../ui/dialog';
import { useWorkSites } from '../lib/queries';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { useRole } from '../contexts/RoleContext';
import GuidedTour from './GuidedTour';
import WorkLogDrawer, { WorkLogButton } from './WorkLogDrawer';
import { useIsMobile } from '../lib/useIsMobile';
import { PHONE_QUERY } from '../lib/keys';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import TimesheetReviewPanel from './TimesheetReviewPanel';
import GeofencePunchModal from './GeofencePunchModal';
import AddTimeModal from './AddTimeModal';
import AnchoredMenu from './AnchoredMenu';
import { Spinner } from './AsyncState';
import { Modal } from '../tasks/components';
import EmployeeCombobox from './EmployeeCombobox';
import { downloadBlob } from './accounting/reportModel';
import { formatDistance } from '../lib/distance';
import { usePhotoMap } from '../lib/peoplePhotos';
import { moneyPrefix } from '../asset/lib/currency';
import { registerTour } from '../lib/tours';

// Launch (Neil, 10/16): the only sign-off is review + Nexus Sign, so the HR
// "Finalize Without Signatures" override is hidden. Flip to true to show it.
const LEGACY_FINALIZE = false;

// ── Payroll timecard (SwipeClock 1:1, manager-editable) ───────────────────────
// One employee, one pay period (biweekly, SUNDAY-anchored on SwipeClock's real
// payroll calendar - site 47239: 7/26/26–8/8/26). Same column order as the
// SwipeClock card, punch times rounded to the nearest 5 minutes exactly like
// SwipeClock (raw times one toggle away), CA overtime split, wage totals.

const ANCHOR = Date.UTC(2024, 0, 14);  // a Sunday on SwipeClock's period series
const DAY = 86400000;
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
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

// California / India toggle for punch-time display. Default California to line up
// 1:1 with SwipeClock (its site clock is Pacific); flip to India for local time.
function TzSwitch() {
  const cur = useDisplayTz();
  return (
    <div title="Timezone for punch times on this timecard. California matches SwipeClock; India shows local time for India-based staff."
      style={{ display: 'inline-flex', border: '1px solid var(--wk-line2)', borderRadius: 999, overflow: 'hidden' }}>
      {TZ_OPTIONS.map((o) => {
        const on = o.key === cur.key;
        return (
          <button key={o.key} onClick={() => setDisplayTz(o.key)} title={`Show times in ${o.label} time (${o.abbr})`}
            style={{ border: 'none', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 11.5, fontWeight: 700, padding: '5px 11px',
              background: on ? 'var(--wk-brand)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

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
function TimecardOptions({ self, showRaw, setShowRaw, children }) {
  const [open, setOpen] = useState(false);
  // Portaled panel (AnchoredMenu): closes on an outside tap or Escape, and no
  // scrolling toolbar or card can clip it on a phone.
  const btn = useRef(null);
  const rules = [].concat(children || []).filter(Boolean);
  return (
    <div>
      <button ref={btn} type="button" data-tour="pr-rounding" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        title="Timezone and unrounded times"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontWeight: 700, fontSize: 12, cursor: 'pointer', color: 'var(--ink)' }}>
        <SlidersHorizontal size={14} /> Options
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" role="dialog" aria-label="Timecard options"
        style={{ width: 320, background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '12px 14px' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Display</div>
        {!self && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>Times Shown In</span>
            <TzSwitch />
          </div>
        )}
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
const segReasons = (s) => {
  const out = [];
  if (s.inEditStatus === 'pending' && s.inEditReason) out.push(`Proposed in-time: ${s.inEditReason}`);
  if (s.outEditStatus === 'pending' && s.outEditReason) out.push(`Proposed out-time: ${s.outEditReason}`);
  [s.inAdjustNote, s.outAdjustNote, s.note].forEach(n => { const c = cleanNote(n); if (c) out.push(c); });
  return out;
};

// A break as a row of its own under its shift (Pranshu, Oct 16): Nexus records
// a break's start and end as punches, so the row reads In = start, Out = end
// (Missing when the clock-out closed it). The pseudo-segment lets InlineTime
// show and edit the two break punches like any other.
export const breakSeg = (b) => ({ in: b.start, inR: b.start, inId: b.startId, out: b.implicit ? '' : b.end, outR: b.implicit ? '' : b.end, outId: b.endId, workedMin: b.min, flags: [], breaks: [] });

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
// a site name, Out of Location, Location off, the Out-punch tail - is one
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: geoOut === 'out_of_fence' ? '#b45309' : geoOut === 'no_location' ? '#b91c1c' : 'var(--muted)' }}
      title={geoOut === 'out_of_fence' ? `Out punch: ${outOfLocationHint(seg.workSiteOut, seg.distanceOut)}` : geoOut === 'no_location' ? 'Out punch: no location shared' : geoOut === 'no_site' ? 'Out punch: none of their locations is on the map yet' : geoOut === 'low_accuracy' ? 'Out punch: only a rough location (no GPS) - too rough to tell which site' : `Out punch: ${seg.workSiteOut || geoOut}`}>
      <ArrowRight size={10} /> {geoOut === 'out_of_fence' ? 'Out of Location' : geoOut === 'no_location' ? 'Out: location off' : geoOut === 'no_site' ? 'Out: no site mapped' : geoOut === 'low_accuracy' ? 'Out: approx.' : (seg.workSiteOut || (geoOut === 'remote' ? 'Remote' : 'Out'))}
    </span>
  ) : null;
  let chip, title, style = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 };
  if (geo === 'no_location') {
    style = { ...style, color: '#b91c1c', fontWeight: 700 };
    title = 'No location was shared for this punch - turned off or not allowed in the browser.';
    chip = <><MapPinOff size={12} style={{ flexShrink: 0 }} /> <span className="loc-chip-text">Location off</span>{outTail}</>;
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
function SideAvatar({ name, email, photos }) {
  const photo = email ? photos[email.toLowerCase()] : '';
  const initials = (name || email || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  if (photo) return <img src={photo} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  return (
    <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>
      {initials}
    </span>
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
      <div style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'grid', gap: 5, fontSize: 12.5, fontWeight: 600 }}>Day
          <select className="form-input" value={date} onChange={e => pick(e.target.value)} style={{ fontWeight: 400 }}>
            {dates.map(d => <option key={d} value={d}>{dow(d)}{noteFor(d) ? ' - has a note' : ''}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 5, fontSize: 12.5, fontWeight: 600 }}>Note
          <textarea className="form-input" rows={4} autoFocus value={text} onChange={e => setText(e.target.value)}
            placeholder={self ? 'Seen by your manager on your timecard' : 'Seen by managers and HR, not by the employee'}
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
const _tcKey = (self, email, start, end) => self ? `self:${start}` : (email ? `${email}:${start}:${end}` : '');
// A reload lands back on the same card (Charmi, Oct 16: "it took me back to
// Aarav Mehta's time card"): the last employee and period opened, kept for
// this browser tab. A deep link (?timecard=) still wins over it.
const _LAST_KEY = 'nexus.payroll.last';
const _lastOpened = () => { try { return JSON.parse(sessionStorage.getItem(_LAST_KEY) || 'null') || {}; } catch { return {}; } };

// The period anchor for a review's period start (Sep 29): a salaried month
// anchors mid-month (the same UTC-drift-safe day the month snap uses), an
// hourly one on its bi-weekly period.
function anchorForStart(startIso, payType) {
  const [y, m, d] = (startIso || '').split('-').map(Number);
  if (!y) return null;
  return payType === 'fixed' ? new Date(y, m - 1, 15) : periodStartFor(new Date(y, m - 1, d));
}

export default function PayrollTimecard({ toastOk, toastErr, selfMode = false, initialEmail = '', initialStart = '', initialPayType = '' }) {
  const self = selfMode;   // employee viewing their OWN timecard (from /my-payroll)
  const [people, setPeople] = useState([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);   // the team list answered (even empty)
  const last = useMemo(() => (selfMode || initialEmail) ? {} : _lastOpened(), [selfMode, initialEmail]);
  const [email, setEmail] = useState(initialEmail || last.email || '');
  // Jump to a specific employee when the caller changes initialEmail (e.g. the
  // "N to review" badge in TimeAdmin opens that person's card).
  useEffect(() => { if (initialEmail) setEmail(initialEmail); }, [initialEmail]);
  // Opened on a specific period (Timesheets to Review, the bell, the briefing
  // link, the card open before a reload): start there, and don't let the
  // first-load snaps move it.
  const seedStart = initialStart || last.start, seedType = initialPayType || last.payType;
  const seeded = useRef(!selfMode && !!anchorForStart(seedStart, seedType));
  const [pStart, setPStart] = useState(() => (!selfMode && anchorForStart(seedStart, seedType)) || periodStartFor(new Date()));
  // Seed from the module cache so a reopen renders the last card immediately (no loader).
  const [data, setData] = useState(() => {
    const s = isoDate(pStart), e = isoDate(pStart.getTime() + 13 * DAY);
    return _timecardCache.get(_tcKey(selfMode, email, s, e)) || null;
  });
  // No pay or OT controls on the timecard (Charmi, Sep 30): the rate and the
  // OT rule are READ here and written only on Pay & Benefits.
  const [editDay, setEditDay] = useState(null);   // { date, seg? }
  const [addTime, setAddTime] = useState(false);   // Add Time (Oct 14): a run of shifts at once
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
  useOwnZone(self);
  // A phone gets the day cards instead of the 12-column table (Oct 14) - the
  // table scrolled sideways and hid Hours, OT, Notes and the Work Log.
  const phone = useIsMobile(PHONE_QUERY);
  const [tour, setTour] = useState(false);               // Simulate walkthrough
  // The Help panel's Take the Tour (lib/tours.js) - a manager's timecard only.
  useEffect(() => (self ? undefined : registerTour('timecard', 'Timecard', () => setTour(true))), [self]);
  const { can, myEmail } = useRole();
  const isAdmin = can('administrator');
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

  // employee list (scoped) for the picker
  useEffect(() => {
    if (self) return;   // employee self-view has no picker / team list
    api.timeTeam(start, end).then(r => {
      const list = (r.rows || []).map(x => ({ email: x.email, name: x.name || x.email, pendingEdits: x.pendingEdits || 0, department: x.department || '', company: x.company || '' }));
      setPeople(list);
      setPeopleLoaded(true);
      // Someone remembered from before a reload who is no longer in scope
      // falls back to the first person, like an empty start.
      setEmail(e => (e && (initialEmail === e || list.some(p => p.email === e))) ? e : list[0]?.email || '');
    }).catch(() => setPeopleLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      }).catch(e => { if (reqKeyRef.current === key) { setData(null); toastErr?.(e?.message || 'Could not load your timecard.'); } });
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
      setData(null); toastErr?.(e?.message || 'Could not load the timecard.');
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
  // load, snap to the CURRENT month so they don't open on last month by default.
  const fixedSnapped = useRef(seeded.current);
  useEffect(() => {
    if (!data || data.payType !== 'fixed' || fixedSnapped.current) return;
    fixedSnapped.current = true;
    const todayM = new Date().toISOString().slice(0, 7);
    const cardM = (data.periodStart || '').slice(0, 7);
    if (cardM && cardM !== todayM) {
      const [y, m] = todayM.split('-').map(Number);
      setPStart(new Date(y, m - 1, 15));   // mid-month: safe from UTC month-boundary drift
    }
  }, [data]);

  // HR switching employees: re-anchor to the current period and re-arm the fixed snap,
  // so a fixed employee's month anchor (the 15th) can't leave the NEXT (hourly)
  // employee's grid off its Sunday anchor and break SwipeClock parity for the session.
  useEffect(() => {
    if (self) return;
    if (seeded.current) { seeded.current = false; return; }   // keep the period we were opened on
    fixedSnapped.current = false;
    setPStart(periodStartFor(new Date()));
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
  const periodLabel = isFixed && data?.periodStart
    ? new Date(data.periodStart + 'T00:00').toLocaleDateString([], { month: 'long', year: 'numeric' })
    : label;
  const T = data?.totals;
  const fin = data?.finalized;         // HR finalization - the period is LOCKED
  // Full-width rows across the hourly table: Date, Edit, In, Out, Deducted
  // Time, Category, Total Hours, OT, Loc, [Pay Rate], [Wage] - SwipeClock's
  // order (Neil, Oct 16): the actions up front, the outputs at the end.
  const span = 12 - (showPay ? 0 : 2);
  const mgrAp = data?.approval;        // manager approval (step 1 of 2)
  // Never surface a raw email - fall back to a name formatted from the local-part.
  const nameFor = (em) => people.find(p => p.email === (em || '').toLowerCase())?.name
    || (em ? em.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');

  async function finalize() {
    if (!await dialog.confirm(`Finalize ${nameFor(email)}'s timecard for ${periodLabel}? This locks all time records for the period - edits will need an unlock.`, { title: 'Finalize timecard', confirmText: 'Finalize', danger: true })) return;
    await signOff((allow) => api.timeFinalize({ email, start: perStart, end: perEnd, allow_exceptions: allow }),
      'Finalize', 'Timecard finalized - the period is locked.');
  }
  async function unfinalize() {
    if (!await dialog.confirm(`Unlock ${nameFor(email)}'s finalized timecard for ${periodLabel}? Edits become possible again; re-finalize when done.`, { title: 'Unlock period', confirmText: 'Unlock' })) return;
    setBusy(true);
    try { await api.timeUnfinalize({ email, start: perStart, end: perEnd }); toastOk?.('Period unlocked.'); load(); }
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
  async function exportFile(fetcher, label) {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) toastErr?.('Identity check didn’t complete.'); return; }
    setExporting(true);
    try {
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
      toastOk?.(status === 'approved' ? `Punch added to the timecard.${extra}` : 'Request rejected.');
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
      // One row per shift (In -> Out), then a Break row under it for each break
      // the person punched (Pranshu, Oct 16) - not a chip under the day.
      // `base` is the shift a Break row belongs to (what its Edit fixes).
      segs.forEach((seg, i) => {
        rows.push({ type: 'day', ds, seg, base: seg, band, first: i === 0, last: i === segs.length - 1, segLast: true, brkCount: (seg.breaks || []).length });
        (seg.breaks || []).forEach(b => rows.push({ type: 'break', ds, seg: breakSeg(b), brk: b, base: seg, band, first: false }));
      });
      // A shift Nexus auto-closed at end of day (no clock-out was recorded):
      // one loud line under the day - the segment above pays 0 until fixed.
      if (segs.some(s => (s.flags || []).includes('auto_clock_out'))) rows.push({ type: 'auto', ds });
      // Same reasons/notes the fixed card shows: employee edit reasons + HR adjust
      // notes + punch notes, visible in the card (not only on the hover Info dot).
      // Internal markers like "payroll edit" are filtered out (segReasons).
      const notes = segs.flatMap(segReasons);
      // Worked a half-day holiday: the OTHER half is credited on top of the
      // punches above, not instead of them (Pranshu, Sep 22 - "half from
      // holiday and half they worked").
      if (d?.holidayPay) rows.push({ type: 'holiday', ds, name: d.holidayName, pay: d.holidayPay, holidayType: d.holidayType, worked: true });
      // The day's note line (SwipeClock's pencil line under the day): the
      // manager / employee note, the punch reasons, and the Work Log.
      rows.push({ type: 'note', ds, band, text: notes.join('  ·  ') });
    }
    (reqsByDate[ds] || []).forEach(q => rows.push({ type: 'req', ds, req: q }));
  });
  if (prevWeek) rows.push({ type: 'wk', week: prevWeek });

  const dow = (ds) => new Date(ds + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
  const pm = data?.punchMeta || {};
  // What a row's Edit opens: the shift's form, or the break fixer on a Break row.
  const isBreakRow = (r) => r.type === 'break';
  const editRow = (r) => isBreakRow(r) ? setBreakFix({ date: r.ds, breaks: r.base?.breaks || [] }) : setEditDay({ date: r.ds, seg: r.base || r.seg });

  // ── A day's pieces, drawn by BOTH the desktop table and the phone day cards
  //    (Oct 14) - one copy of each, so the two can never disagree about what a
  //    cell says or offers. ──
  const hIn = (r) => (
    <>
                    {r.seg && !r.seg.in
                    // A clock-out with no clock-in (Oct 1) - see the fixed-salary inCell.
                    ? ((self && fin) ? <span title="Period finalized - locked" style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                        : <button onClick={() => !fin && editRow(r)}
                            title={fin ? 'Period finalized - locked' : self ? 'Add the missing clock-in - goes to your approver' : 'Add the missing clock-in, or delete the clock-out'}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>)
                    : r.seg
                    ? <InlineTime seg={r.seg} k="in" meta={pm[r.seg.inId]} showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={hourlyLocate} onLocate={() => setGeoMap(hourlyLocate)} />
                    : '-'}
    </>
  );
  const hOut = (r) => (
    <>
                    {r.seg ? (r.seg.out
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <InlineTime seg={r.seg} k="out" meta={pm[r.seg.outId]} showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={hourlyLocate} onLocate={() => setGeoMap(hourlyLocate)} />
                          {(r.seg.flags || []).includes('auto_clock_out') && (
                            <span title="Nexus closed this shift automatically - no clock-out was recorded. 0 paid hours until the real end time is set."
                              style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#b91c1c', background: 'rgba(185,28,28,0.1)', padding: '2px 7px', borderRadius: 6 }}>
                              auto
                            </span>
                          )}
                        </span>
                      : (self && fin)
                        ? <span title="Period finalized - locked" style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                        : <button onClick={() => !fin && editRow(r)}
                            title={fin ? 'Period finalized - locked' : isBreakRow(r) ? (self ? 'The break was never ended - ask your approver to add its end' : 'The break was never ended - set its real end, or delete the break')
                              : self ? 'Add the missing clock-out - goes to your approver' : 'Add the missing clock-out'}
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
                        : !fin && (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <button onClick={() => decideReq(r.req.id, 'approved')} title="Approve - adds this punch to the timecard"
                              style={{ borderRadius: 999, padding: '3px 12px', cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, border: 'none', background: 'hsl(var(--color-green))', color: '#fff' }}>Approve</button>
                            <button onClick={() => decideReq(r.req.id, 'rejected')} title="Reject - the employee is notified"
                              style={{ borderRadius: 999, padding: '3px 12px', cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)' }}>Reject</button>
                          </span>
                        )}
                    </div>
    </>
  );
  // SwipeClock's Edit / Add column (Neil, Oct 16), right after the date. Edit
  // opens the shift (times, location, Type, delete) - on a row that starts
  // where a break ended, the break fixer (its missing end, or delete it). Add
  // on the day's last row adds another block of time: Regular, Break, Sick,
  // Vacation or Personal (Neil, Aug 3: "no option to just add a punch"). An
  // employee's Add and break fix go to their approver as requests.
  const btn = { border: '1px solid var(--line-strong,var(--line))', borderRadius: 3, padding: '0 5px', background: 'var(--wk-hover)', color: 'var(--ink)', font: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1.6 };
  const hEdit = (r) => !fin && (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {r.seg && (!self || isBreakRow(r)) && (
        <button type="button" onClick={() => editRow(r)} style={btn}
          title={isBreakRow(r) ? (self ? 'Ask your approver to fix or remove this break' : 'Fix the start or end of this break, or delete it')
            : 'Edit this shift - its times, location or Type, or delete a punch'}>
          Edit
        </button>
      )}
      {(!r.seg || r.last) && (
        <button type="button" onClick={() => setEditDay({ date: r.ds, seg: null })} style={btn}
          title={self ? 'Ask for time on this day - Regular, Break, Sick, Vacation or Personal - goes to your approver' : 'Add time to this day - Regular, Break, Sick, Vacation or Personal'}>
          Add
        </button>
      )}
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
      if (r.type === 'note') { if (r.text) cur?.extra.push(r); return; }
      if (!cur || cur.ds !== r.ds) { cur = { type: 'card', ds: r.ds, segs: [], extra: [] }; items.push(cur); }
      if (r.type === 'day') cur.segs.push(r); else cur.extra.push(r);
    });
    const small = { fontSize: 12, color: 'var(--muted)' };
    return (
      <div data-tour="pr-table" className="pr-days">
        {items.map((it, i) => {
          if (it.type === 'wk') {
            const wkEnd = new Date(new Date(it.week + 'T00:00').getTime() + 6 * DAY);
            return (
              <div key={'wk' + i} className="pr-days-week">
                <span>Week of {new Date(it.week + 'T00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })} to {wkEnd.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>
                <span>{hhmm(weekTotals[it.week]?.min || 0)}</span>
              </div>
            );
          }
          const ds = it.ds;
          const worked = it.segs.filter(r => r.seg);
          const day = byDate[ds];
          const leave = worked.some(r => r.seg.payClass);
          const otMin = worked.reduce((a, r) => a + (r.seg.otMin || 0), 0);
          const dtMin = worked.reduce((a, r) => a + (r.seg.dtMin || 0), 0);
          const pay = worked.reduce((a, r) => a + (r.seg.amount || 0), 0);
          // A day with no punches is one line: its date, Add Note, the Work Log
          // and Add Punch, as the table row offers them. A worked day, or one
          // with a note, carries the note and Work Log in its own footer.
          const foot = worked.length > 0 || !!(self ? myNote(ds) : (notes[ds]?.note || notes[ds]?.employeeNote));
          const inline = !foot;
          const canAdd = !fin;
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
                    <span>{hhmm(day?.workedMin ?? worked.reduce((a, r) => a + (r.seg.workedMin || 0), 0))}</span>
                    {showPay && <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{fmtM(pay)}</span>}
                  </span>
                ) : canAdd ? (
                  <button type="button" className="pr-dcard-add" onClick={() => setEditDay({ date: ds, seg: null })}
                    title={self ? 'Add a punch for this day - goes to your approver' : 'Add a punch for this day'}>
                    <Plus size={13} /> Add Punch
                  </button>
                ) : <span style={small}>No Punches</span>}
              </div>
              {worked.map((r, si) => (
                <div key={si} className="pr-dcard-seg">
                  <div className="pr-dcard-times">
                    <span>{hIn(r)}</span>
                    <ArrowRight size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span>{hOut(r)}</span>
                    <span style={{ flex: 1 }} />
                    {worked.length > 1 && <span style={{ ...small, fontVariantNumeric: 'tabular-nums' }}>{hhmm(r.seg.workedMin)}</span>}
                    {(!self || isBreakRow(r)) && !fin && (
                      <button type="button" className="pr-dcard-icon" onClick={() => editRow(r)}
                        title={isBreakRow(r) ? 'Fix or delete this break' : 'Edit punch'} aria-label={`Edit the punch on ${dow(ds)}`}>
                        <Pencil size={14} />
                      </button>
                    )}
                  </div>
                  {(r.seg.category || r.seg.payClass || r.seg.deductedMin > 0 || r.seg.workSite || r.seg.geo || r.seg.geoOut) && (
                    <div className="pr-dcard-meta">
                      {(r.seg.category || r.seg.payClass) && <span>{hCategory(r)}</span>}
                      {r.seg.deductedMin > 0 && <span style={{ color: '#b45309' }}>−{r.seg.deductedMin}m deducted</span>}
                      <LocCell seg={r.base} onOpen={(seg) => { setGeoFocus({ seg, date: ds }); setGeoMap(data?.email || email || myEmail || ''); }} />
                    </div>
                  )}
                </div>
              ))}
              {worked.length > 0 && !self && !fin && (
                <button type="button" className="pr-dcard-add pr-dcard-add-more" onClick={() => setEditDay({ date: ds, seg: null })}
                  title="Add another punch for this day">
                  <Plus size={13} /> Add Another Punch
                </button>
              )}
              {it.extra.map((r, xi) => (
                <div key={xi} className={`pr-dcard-extra pr-dcard-${r.type}`}>
                  {r.type === 'break' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Break {hIn(r)} <ArrowRight size={11} style={{ color: 'var(--muted)' }} /> {hOut(r)} <span style={{ color: 'var(--muted)' }}>({hhmm(r.brk.min)})</span></span>
                    : r.type === 'auto' ? hAuto()
                    : r.type === 'holiday' ? hHoliday(r)
                    : r.type === 'req' ? hReq(r)
                    : <><Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{r.text}</>}
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
  const sidebar = (exceptions.length ? exceptions : people.map(p => ({ ...p, missing: 0, exceptions: 0 }))).filter(p => inFilter(p.email));
  const filterSel = (value, onChange, label, options) => options.length > 1 && (
    <select className="form-input" value={value} onChange={e => onChange(e.target.value)} aria-label={label}
      style={{ fontSize: 12, padding: '4px 6px', width: '100%' }}>
      <option value="">All {label === 'Company' ? 'companies' : 'departments'}</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  // The employee master-detail list - shared by the hourly and fixed-salary views
  // so switching between them never rearranges the screen (hidden in self mode).
  // On a phone the list gives way to the card; the employee picker above the
  // card still switches people.
  const employeeSidebar = (!self && !phone) ? (
    <div data-tour="pr-sidebar" style={{ width: 210, flexShrink: 0, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', maxHeight: 620, overflowY: 'auto', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }} className="pr-sidebar">
      {(companies.length > 1 || depts.length > 1) && (
        <div style={{ padding: '8px 10px 6px', display: 'grid', gap: 5, borderBottom: '1px solid var(--line)' }}>
          {filterSel(company, (v) => { setCompany(v); setDept(''); }, 'Company', companies)}
          {filterSel(dept, setDept, 'Department', depts)}
        </div>
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
  ) : null;

  // Fixed-salary employees get a dedicated MONTHLY card - the hourly SwipeClock
  // grid (OT split, weekly subtotals, $/hr) does not apply to them - but it lives
  // inside the SAME master-detail layout as the hourly view.
  if (isFixed && data) {
    const fixedCard = (
      <FixedTimecard data={data} self={self} email={email} people={people} setEmail={setEmail}
        nameFor={nameFor} cur={cur} fmtM={fmtM} showRaw={showRaw} setShowRaw={setShowRaw}
        isAdmin={isAdmin} busy={busy} setBusy={setBusy}
        onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)}
        onFinalize={finalize} onUnfinalize={unfinalize}
        editDay={editDay} setEditDay={setEditDay} load={load} toastOk={toastOk} toastErr={toastErr}
        setWorkLogDay={setWorkLogDay} dayNotes={notes} saveNote={saveNote} saveMyNote={saveMyNote} myNote={myNote} />
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
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 180 }}>My Timesheet</span>
          : <EmployeeCombobox people={pickable} value={email} onChange={setEmail} title="Also selectable from the sidebar"
              labelFor={p => `${p.name}${p.pendingEdits ? ` (${p.pendingEdits} to review)` : exByEmail[p.email]?.missing ? ` (${exByEmail[p.email].missing} missing)` : ''}`} />}
        <div data-tour="pr-period" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button className="icon-btn" onClick={() => shift(-1)} style={{ padding: 6 }}><ChevronLeft size={16} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 175, textAlign: 'center' }}>{label}</span>
          <button className="icon-btn" onClick={() => shift(1)} style={{ padding: 6 }}><ChevronRight size={16} /></button>
        </div>
        {!self && (
        <button onClick={() => setTour(true)} title="A guided walkthrough of this screen - nothing is changed while it runs."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontWeight: 700, fontSize: 12, cursor: 'pointer', color: 'var(--ink)' }}>
          <PlayCircle size={14} /> Simulate
        </button>
        )}
        {!self && email && (
        <button data-tour="pr-add-time" onClick={() => setAddTime(true)} title="Add a shift, or several days of them, for someone who did not clock in right"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' }}>
          <Plus size={14} /> Add Time
        </button>
        )}
        {!fin && (self || email) && (
        <button onClick={() => setNoteModal(true)} title={self ? 'Leave a note on a day for your manager' : 'Leave a note on a day - seen by managers and HR, not the employee'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--wk-line2)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--wk-font)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer' }}>
          <Pencil size={13} /> Add Note
        </button>
        )}
        <div style={{ flex: 1 }} />
        {/* Options holds only display choices now: the timezone and unrounded
            times. The pay rules that used to sit here (rounding, auto-lunch,
            CA paid breaks) are company settings under Settings > Global
            Settings > Time Clock, and the OT rule + rate are set on the
            person's Pay & Benefits tab - never on the timecard (Charmi, Sep 30). */}
        <TimecardOptions self={self} showRaw={showRaw} setShowRaw={setShowRaw} />
      </div>

      {self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
          <Pencil size={13} style={{ flexShrink: 0 }} /> Tap any clock-in or clock-out time to request a change. It goes to your approver, and your pay stays the same until they approve it.
        </div>
      )}
      {!stepLocked && data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {data.dept && <span><strong style={{ color: 'var(--ink)' }}>Department:</strong> {data.dept}</span>}
          <span title={self ? undefined : 'Set on the Pay & Benefits tab of this person\'s profile'}>
            {showPay && <><strong style={{ color: 'var(--ink)' }}>Pay rate:</strong> {fmtM(rate)}/hr · </>}<strong style={{ color: 'var(--ink)' }}>OT rule:</strong> {RULE_LABEL[rule] || 'None'}
          </span>
          {showPay && rateSplitText(data.rateSplits, 'rate', v => `${fmtM(v)}/hr`) && (
            <span title="The rate changed inside this period - each day is paid at the rate in effect that day" style={{ color: 'var(--wk-brand)', fontWeight: 600 }}>
              {rateSplitText(data.rateSplits, 'rate', v => `${fmtM(v)}/hr`)}
            </span>
          )}
          {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}>
            <CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
          {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}>
            <CheckCircle size={12} /> Finalized · {nameFor(fin.by)} - period locked</span>}
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
        <div data-tour="pr-table" style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 8, background: 'var(--card)' }}>
          {/* SwipeClock's card, cell for cell (Neil / Pranshu, Oct 16): a tight
              bordered grid - Date, Edit / Add, In, Out, Deducted Time, Category,
              Hours, OT, Loc, Pay Rate, Wage, Log. One row per shift, then a
              Break row for each break punched. The note pencil sits in the
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
                <th title="Hours paid for the shift - the time between clock-in and clock-out, minus its breaks" style={gh}>Total Hours</th>
                <th title="Overtime in this shift - 1.5× and, in California past 12 hours, 2×" style={gh}>OT</th>
                <th style={gh}>Loc</th>
                {showPay && <th title="The rate in effect that day" style={gh}>Pay Rate</th>}
                {showPay && <th style={gh}>Wage</th>}
                <th title="What was planned, done, and left pending that day" style={gh}>Log</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => r.type === 'wk' ? (
                <tr key={i}>
                  {/* The week's total stands out in a yellow tint (Pranshu, Oct 16). */}
                  <td colSpan={span} style={{ ...gc, background: 'rgba(234,179,8,0.18)', fontWeight: 700, fontSize: 12 }}>
                    Total hours clocked for week of {new Date(r.week + 'T00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })} to {new Date(new Date(r.week + 'T00:00').getTime() + 6 * DAY).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}: {hhmm(weekTotals[r.week]?.min || 0)}
                  </td>
                </tr>
              ) : r.type === 'auto' ? (
                <tr key={i}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', color: '#b91c1c', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    {hAuto()}
                  </td>
                </tr>
              ) : r.type === 'holiday' ? (
                <tr key={i} style={{ background: 'rgba(37,99,235,0.06)' }}>
                  <td colSpan={span} style={{ ...gc, textAlign: 'left', color: '#2563eb', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    {hHoliday(r)}
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
                (r.text || noteOf(r.ds) || notes[r.ds]?.employeeNote) ? (
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
                          {r.text && <span><strong>On the punches:</strong> <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{r.text}</span></span>}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null
              ) : r.type === 'break' ? (
                /* The break the person punched, under its shift: start, end, length. */
                <tr key={i} className={`pr-row pr-day-row${r.band ? ' pr-band' : ''}`}>
                  <td style={{ ...gc, textAlign: 'left', paddingLeft: 26, color: 'var(--muted)', fontStyle: 'italic' }}>Break</td>
                  <td style={gc}>{hEdit(r)}</td>
                  <td style={gc}>{hIn(r)}</td>
                  <td style={gc} title={`${hhmm(r.brk.min)} break${r.brk.paidMin > 0 ? ` - ${r.brk.paidMin}m of it paid` : ''}`}>{hOut(r)}</td>
                  {/* The columns from Deducted Time on are the shift's, merged down over its breaks. */}
                </tr>
              ) : (() => { const rs = 1 + (r.brkCount || 0); return (
                /* Alternate days, not rows (Pranshu, Oct 16): the shift, its
                   breaks and its note line read as one block. */
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
                      {/* Merged down over the shift's Break rows (Pranshu, Oct 16):
                          Total Hours is the shift minus its breaks, as paid. */}
                      <td rowSpan={rs} style={{ ...gc, color: r.seg.deductedMin ? '#b45309' : undefined }}>{r.seg.deductedMin ? `−${r.seg.deductedMin}m` : '-'}</td>
                      <td rowSpan={rs} style={gc}>{r.seg.category || '-'}</td>
                      <td rowSpan={rs} style={{ ...gc, fontWeight: 700 }}>{hhmm(r.seg.workedMin)}</td>
                      <td rowSpan={rs} style={{ ...gc, color: r.seg.dtMin ? '#b91c1c' : r.seg.otMin ? '#b45309' : undefined, fontWeight: (r.seg.otMin || r.seg.dtMin) ? 700 : 400 }}>
                        {(r.seg.otMin || r.seg.dtMin)
                          ? [r.seg.otMin ? hhmm(r.seg.otMin) : '', r.seg.dtMin ? `${hhmm(r.seg.dtMin)} 2×` : ''].filter(Boolean).join(' · ')
                          : '-'}
                      </td>
                      <td rowSpan={rs} style={gc}>
                        {r.base?.geo && r.base.geo !== 'no_location'
                          ? <LocCell seg={r.base} onOpen={(seg) => { setGeoFocus({ seg, date: r.ds }); setGeoMap(data?.email || email || myEmail || ''); }} />
                          : '-'}
                      </td>
                      {showPay && <td rowSpan={rs} style={{ ...gc, textAlign: 'right' }}>{fmtM(byDate[r.ds]?.rate ?? rate)}/hr</td>}
                      {showPay && <td rowSpan={rs} style={{ ...gc, textAlign: 'right', fontWeight: 700 }}>{r.segLast ? fmtM(r.seg.amount) : ''}</td>}
                    </>
                  ) : Array.from({ length: span - 3 }, (_, k) => <td key={k} style={gc}>-</td>)}
                  {/* The Work Log, at the far right of the day's first row (Pranshu, Oct 16). */}
                  <td rowSpan={rs} style={gc}>{r.first !== false && <WorkLogButton onClick={() => setWorkLogDay(r.ds)} title={`View the Work Log for ${dow(r.ds)}`} />}</td>
                </tr>
              ); })())}
            </tbody>
            {T && (
              <tfoot>
                <tr style={{ background: 'var(--wk-hover)', fontWeight: 700 }}>
                  <td colSpan={4} style={{ ...gc, textAlign: 'left' }}>Totals</td>
                  <td style={{ ...gc, color: T.deductedMin ? '#b45309' : undefined }}>{T.deductedMin ? `−${T.deductedMin}m` : '-'}</td>
                  <td style={gc}></td>
                  <td style={gc}>{hhmm(T.workedMin ?? (T.regMin + T.otMin + (T.dtMin || 0)))}</td>
                  <td style={gc}>{(T.otMin || T.dtMin) ? [T.otMin ? hhmm(T.otMin) : '', T.dtMin ? `${hhmm(T.dtMin)} 2×` : ''].filter(Boolean).join(' · ') : '-'}</td>
                  <td style={gc}></td>
                  {showPay && <td style={gc}></td>}
                  {showPay && <td style={{ ...gc, textAlign: 'right' }}>{fmtM(T.totalPay)}</td>}
                  <td style={gc}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Summary + acknowledgment */}
      {T && (
        <div style={{ marginTop: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div data-tour="pr-summary" style={{ flex: 1, minWidth: 300, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
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
                ...(T.holidayDays ? [[`Company holiday${T.holidayDays === 1 ? '' : 's'} (${T.holidayDays} day${T.holidayDays === 1 ? '' : 's'}, not worked)`, '-', fmtM(T.holidayPay)]] : []),
                ['Totals', hd(T.workedMin ?? (T.regMin + T.otMin + (T.dtMin || 0))), fmtM(T.totalPay)],
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
              <button className="secondary-btn" disabled={exporting} onClick={() => exportFile(() => api.timeExportCsv(start, end, 'punches'), 'CSV')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> CSV</button>
              <button className="secondary-btn" disabled={exporting} title="QuickBooks Desktop time import file (IIF) - import instead of keying hours by hand. Employee names and the Regular/Overtime/Double-time/Sick/Vacation payroll items must match QuickBooks."
                onClick={() => exportFile(() => api.timeExportIif(perStart, perEnd), 'QuickBooks IIF')}
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> QuickBooks IIF</button>
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
              {isAdmin && fin && (
                <button className="secondary-btn" onClick={unfinalize} disabled={busy} title="HR: unlock this finalized period for corrections"
                  style={{ fontSize: 12.5 }}>Unlock</button>)}
              {isAdmin && !fin && LEGACY_FINALIZE && (
                <button className="secondary-btn" onClick={finalize} disabled={busy} title="HR override: finalize for payroll without the review and signatures"
                  style={{ fontSize: 12.5 }}>Finalize Without Signatures</button>)}
            </div>
            )}
          </div>
        </div>
      )}
      {T && (
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, fontStyle: 'italic' }}>
          Overtime rule: {rule === 'ca' ? 'California - over 8h/day (1.5×), over 12h/day (2×), the 7th consecutive day, and over 40h/week'
            : rule === 'federal' ? 'Federal - over 40 hours per week (1.5×)'
            : 'None - no US overtime premium applied'}. Set on the person's Pay & Benefits tab, with the pay rate. Each day is paid at the rate in effect that day. Corrections keep the original punch on record.
        </p>
      )}

      {/* Review + Nexus Sign (Sep 2026): the employee submits, the manager sends
          back or agrees, then employee -> manager -> HR sign in Nexus Sign. */}
      {T && (
        <TimesheetReviewPanel review={data.review} self={self} anchor={perStart} periodLabel={label}
          nameFor={nameFor} onChanged={load} toastOk={toastOk} toastErr={toastErr} />
      )}

      {noteModal && (
        <NoteModal dates={dates} dow={dow} self={self} noteFor={noteOf} onSave={self ? saveMyNote : saveNote} toastOk={toastOk} onClose={() => setNoteModal(false)} />
      )}
      {addTime && !self && email && (
        <AddTimeModal email={email} name={nameFor(email)} start={start} end={end} onClose={() => setAddTime(false)}
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
          body: 'Bi-weekly, Sunday to Saturday - the SAME calendar as SwipeClock (current period 7/26–8/8), so the two cards always cover identical days. Arrows move one period.' },
        { target: 'pr-table', title: 'The time card - same columns as SwipeClock',
          body: 'Date, Edit, In, Out, Deducted Time, Category, Total Hours, OT (1.5× and, past 12 hours in California, 2×), Loc, Pay Rate and Wage. Each break the person punched is its own Break line under the shift, with its start, end and length. Hover a time for its punch history - where it came from, the exact time, who entered or changed it. Add Note in the toolbar leaves a note on a day; it reads on the line under that day. Weekly total rows appear after each week.' },
        { target: 'pr-rounding', title: 'Options: rounded vs raw times',
          body: 'SwipeClock computes pay from rounded times but keeps the raw punch - so does Nexus. Open Options to peek at raw times, switch the timezone, or change a pay rule. During the comparison week, leave the rounding setting ON so the numbers can match 1:1.' },
        { target: 'pr-edit', title: 'Fix punches here',
          body: 'Edit on a row opens that shift - set the real in/out, location and Type, or delete a punch; on a Break line it fixes or deletes the break. Add on a day adds Regular, Break, Sick, Vacation or Personal time for someone. Originals stay on record with who changed what, like SwipeClock\'s audit log.' },
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
function FixedTimecard({ data, self, email, people, setEmail, nameFor, cur, fmtM, showRaw, setShowRaw, isAdmin, busy, setBusy, onPrev, onNext, onFinalize, onUnfinalize, editDay, setEditDay, load, toastOk, toastErr, setWorkLogDay, dayNotes = {}, saveNote, saveMyNote, myNote = () => null }) {
  const showPay = !data.payHidden;   // the manager tier never sees pay
  const [geoMap, setGeoMap] = useState('');   // email whose Geofence Punch view is open
  useDisplayTz();   // re-render this card (and its time cells) when the tz switch flips
  const T = data.totals || {};
  const fin = data.finalized;
  const mgrAp = data.approval;
  const [openPunches, setOpenPunches] = useState({});   // date -> show every punch pair
  const [openBreaks, setOpenBreaks] = useState({});     // date -> show each break window
  const [breakFix, setBreakFix] = useState(null);       // { date, breaks } - fixing a break punch
  const byDate = Object.fromEntries((data.days || []).map(d => [d.date, d]));
  const fixedDays = data.fixedDays || [];
  // Policy as the server computed it (A4-A6, Charmi Sep 30) - shown on the strip
  // so the formula is on screen, never a guess.
  const bands = data.bands || { fullMin: 420, halfMin: 240 };
  const fixedSplit = (data.rateSplits || []).length > 1
    ? data.rateSplits.map((s, i) => i === 0 ? `Through ${formatDate(s.through)} at ${fmtM(s.monthlySalary)}/mo` : `From ${formatDate(s.from)} at ${fmtM(s.monthlySalary)}/mo`).join(' · ')
    : '';
  const monthLabel = data.periodStart ? new Date(data.periodStart + 'T00:00').toLocaleDateString([], { month: 'long', year: 'numeric' }) : '';
  const dow = (ds) => new Date(ds + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
  const th = { fontSize: 11.5, fontWeight: 600, color: 'var(--wk-dim)', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const td = { fontSize: 12.5, padding: '6px 10px', textAlign: 'left', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
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
  };
  const effect = (fd) => fd.deduct ? <span style={{ color: '#b91c1c', fontWeight: 700 }}>−{fmtM(fd.deduct)}</span>
    : fd.bonus ? <span style={{ color: 'var(--wk-brand)', fontWeight: 700 }}>+{fmtM(fd.bonus)}</span>
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
      toastOk?.(status === 'approved' ? `Punch added to the timecard.${extra}` : 'Request rejected.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not update the request.'); }
  };

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      {/* Toolbar - month nav (fixed pay is by calendar month, no work-week) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {self
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 160 }}>My Timesheet</span>
          : <EmployeeCombobox people={people} value={email} onChange={setEmail}
              labelFor={p => `${p.name}${p.pendingEdits ? ` (${p.pendingEdits} to review)` : ''}`} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button className="icon-btn" onClick={onPrev} style={{ padding: 6 }}><ChevronLeft size={16} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 130, textAlign: 'center' }}>{monthLabel}</span>
          <button className="icon-btn" onClick={onNext} style={{ padding: 6 }}><ChevronRight size={16} /></button>
        </div>
        <div style={{ flex: 1 }} />
        {/* The California / India toggle is a payroll reviewer's tool; an
            employee's own timesheet shows one timezone (Neil, Sep 23). */}
        {!self && <TzSwitch />}
        {/* No rounding toggle - salary pay is day-based, so times show exactly as punched. */}
      </div>

      {/* Fixed-pay strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontWeight: 700 }}>Fixed salary</span>
        {data.dept && <span><strong style={{ color: 'var(--ink)' }}>Department:</strong> {data.dept}</span>}
        {showPay && <span title="Set on the Pay & Benefits tab of this person's profile"><strong style={{ color: 'var(--ink)' }}>Salary:</strong> {fmtM(data.monthlySalary)}/mo</span>}
        {showPay && fixedSplit && (
          <span title="The salary changed inside this month - each day is paid at the salary in effect that day" style={{ color: 'var(--wk-brand)', fontWeight: 600 }}>{fixedSplit}</span>
        )}
        {showPay && <span title="Monthly salary x 12, divided by the working days in this calendar year (days minus Saturdays and Sundays; company holidays stay in)">
          <strong style={{ color: 'var(--ink)' }}>Daily:</strong> {fmtM(data.dailyRate)} (annual / {data.workingDaysInYear || T.workingDaysInYear || 261} working days)
        </span>}
        <span title="Weekend pay = max(minimum, 1.35 x daily x hours worked / full-day hours). Calculated, never typed per person.">
          <strong style={{ color: 'var(--ink)' }}>Weekend:</strong> {data.weekendMultiplier || 1.35} × daily, pro-rated by hours{data.weekendFloor ? `, min ${fmtM(data.weekendFloor)}` : ''}
        </span>
        <span title="A weekday is a full day at this many hours worked (full-day hours minus an hour), a half day from 4 hours, absent below that">
          <strong style={{ color: 'var(--ink)' }}>Bands:</strong> Full Day ≥ {hhmm(bands.fullMin)} · Half Day ≥ {hhmm(bands.halfMin)} · Absent below
        </span>
        {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}><CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
        {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}><CheckCircle size={12} /> Finalized · period locked</span>}
      </div>

      {self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
          <Pencil size={13} style={{ flexShrink: 0 }} /> Your pay is fixed at {fmtM(data.monthlySalary)}/month. A weekday under {hhmm(bands.halfMin)} deducts a day, under {hhmm(bands.fullMin)} half a day; each weekend day worked adds {data.weekendMultiplier || 1.35} × your daily rate, pro-rated by hours{data.weekendFloor ? ` (at least ${fmtM(data.weekendFloor)})` : ''}. Tap a time to change it, or "+ add" on a past day to log a missed punch - it goes to your approver.
        </div>
      )}
      {showPay && !data.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No salary set - set it on this person's Pay &amp; Benefits tab. Pay shows {fmtM(0)} until then.
        </div>
      )}

      {/* Day grid */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
        {/* On a phone (style.css .pr-fixed-table) each day row stacks into a
            card: date, status and hours; In and Out, break and effect on pay;
            then the note and Work Log (Oct 14). */}
        <table className="pr-fixed-table" style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--wk-hover)' }}>
              <th style={th}>Date</th><th style={th}>Day</th><th style={th}>In</th><th style={th}>Out</th>
              <th style={{ ...th, textAlign: 'right' }}>Hours</th><th style={{ ...th, textAlign: 'right' }}>Break</th><th style={{ ...th, textAlign: 'right' }}>{showPay ? 'Effect on pay' : ''}</th>
              <th title={self ? 'Your notes on the day - your manager sees them on your timecard' : 'Notes on the day - seen by managers and HR, not the employee'} style={th}>Notes</th>
              {/* Far right, like the hourly card (Sep 29). */}
              <th title="What was planned, done, and left pending that day" style={{ ...th, textAlign: 'center' }}>Work Log</th>
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
              const multi = segs.length > 1;               // collapse only when there's more than one punch pair
              const punchesOpen = !!openPunches[fd.date];
              const breaksOpen = !!openBreaks[fd.date];

              // Break = short between-session gaps (stepping away) plus any formal
              // Start Break time. A gap up to 90 min still counts as a break (a long
              // lunch shows, in red once the day's total passes the 60-min allowance);
              // a gap LONGER than 90 min is time OFF the clock (left the site / gone
              // for the afternoon), so a multi-hour absence never shows as a break.
              const BREAK_MAX = 90;
              const breaks = [];
              let offClockGaps = 0;
              for (let i = 1; i < segs.length; i++) {
                const pOut = segs[i - 1].out, tIn = segs[i].in;
                if (pOut && tIn) {
                  const m = Math.round((new Date(tIn + 'Z') - new Date(pOut + 'Z')) / 60000);
                  if (m > 0 && m <= BREAK_MAX) breaks.push({ start: pOut, end: tIn, min: m });
                  else if (m > BREAK_MAX) offClockGaps++;
                }
              }
              const dayBreak = (d?.breakMin || 0) + breaks.reduce((a, b) => a + b.min, 0);
              // The day's Start Break / End Break windows (d.breakMin above). A
              // break the clock-out closed (implicit) never ended - it blocks
              // sign-off, so it is flagged and fixable here (Sep 29).
              const formal = segs.flatMap(s => s.breaks || []);
              const unendedBreak = formal.some(b => b.implicit);
              const overBreak = dayBreak > 60;             // 60 min/day allowance
              const breakFg = dayBreak <= 0 ? 'var(--muted)' : overBreak ? '#b91c1c' : 'hsl(var(--color-green))';

              // Reasons/notes visible IN the card (not just on hover), employee AND HR.
              // Internal markers like "payroll edit" are filtered out (segReasons).
              const notes = segs.flatMap(segReasons);

              // Editable in/out cell for a single segment (or an expanded punch row).
              // The location dot links to the Locations map (only for viewers who can
              // reach it: HR/managers on someone else's card, or an admin on their own).
              const locateEmail = (!self || isAdmin) ? (data.email || '') : '';
              // A clock-out with no clock-in (Oct 1) reads "Missing" on the in
              // side, like a missing clock-out - it blocks sign-off, and this is
              // where it gets fixed (add the in, or void the out).
              const inCell = (seg) => !seg.in
                ? ((self && fin) ? <span style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                    : <button onClick={() => !fin && setEditDay({ date: fd.date, seg })} title={fin ? 'Locked' : self ? 'Add the missing clock-in - goes to your approver' : 'Add the missing clock-in, or delete the clock-out'} style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>)
                : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <InlineTime seg={seg} k="in" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={locateEmail} onLocate={() => setGeoMap(locateEmail)} />
                    {/* The full punch editor, same as the hourly card's pencil (Pranshu,
                        Oct 12): times, Type (Regular / Sick / Vacation / Personal),
                        location, category, and Delete In / Out / Both. */}
                    {!self && !fin && (
                      <button onClick={() => setEditDay({ date: fd.date, seg })} title="Edit this punch - change the times or type, or delete it"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}>
                        <Pencil size={12} />
                      </button>
                    )}
                  </span>;
              const outCell = (seg) => seg.out
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <InlineTime seg={seg} k="out" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={locateEmail} onLocate={() => setGeoMap(locateEmail)} />
                    {(seg.flags || []).includes('auto_clock_out') && (
                      <span title="Nexus closed this shift automatically - no clock-out was recorded. 0 paid hours until the real end time is set."
                        style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#b91c1c', background: 'rgba(185,28,28,0.1)', padding: '2px 7px', borderRadius: 6 }}>
                        auto
                      </span>
                    )}
                  </span>
                : (self && fin) ? <span style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                    : <button onClick={() => !fin && setEditDay({ date: fd.date, seg })} title={fin ? 'Locked' : 'Add the missing clock-out'} style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>;
              const addBtn = <button onClick={() => setEditDay({ date: fd.date, seg: null })} title={self ? 'Add a missing punch for this day - goes to your approver' : 'Add a punch for this day'} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand)', fontWeight: 600, font: 'inherit', opacity: 0.85 }}>+ add</button>;
              const onLeave = !!fd.leaveClass;
              const statusPill = <span title={onLeave ? 'Leave - the day is deducted unless hours were also worked' : timeOffDay ? `Approved time off (${fd.timeOff}) - the missed time is deducted` : (fd.holidayName || undefined)} style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>;
              const breakCell = (
                <td className="fx-break" style={{ ...td, textAlign: 'right' }}>
                  {dayBreak > 0
                    ? <button onClick={() => setOpenBreaks(o => ({ ...o, [fd.date]: !o[fd.date] }))} aria-expanded={breaksOpen}
                        title="Daily break allowance is 60 min. Click to see each break in/out."
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 700, color: breakFg, borderBottom: '1px dashed currentColor', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {hhmm(dayBreak)}{overBreak && <AlertTriangle size={11} />}
                      </button>
                    : (!self && !fin && segs.some(s => s.in && s.out))
                      /* No break recorded: a manager adds one from X to Y (Pranshu, Oct 12). */
                      ? <button onClick={() => setEditDay({ date: fd.date, seg: null, type: 'Break' })} title="Add a break to this day - its start and end"
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, color: 'var(--wk-brand)', opacity: 0.85 }}>+ break</button>
                      : <span style={{ color: 'var(--muted)' }}>-</span>}
                </td>
              );

              const rows = [];
              const rowBg = fd.isWeekend ? 'var(--mist)' : 'transparent';
              const firstSeg = segs[0];
              const lastSeg = segs[segs.length - 1];

              // ── One summary row per day: first clock-in, last clock-out, hours, break ──
              //    (zebra + hover come from .pr-day-row in style.css; weekends keep their mist)
              rows.push(
                <tr key={fd.date} className={`pr-day-row${fd.isWeekend ? ' pr-weekend' : fi % 2 ? ' pr-band' : ''}${onLeave ? ' pr-leave' : ''}`}>
                  <td className="fx-date" style={{ ...td, fontWeight: 700 }}>{dow(fd.date)}</td>
                  <td className="fx-status" style={td}>{statusPill}</td>
                  <td className="fx-in" style={td}>
                    {!segs.length
                      ? ((!fin && !fd.future) ? addBtn : <span style={{ color: 'var(--muted)' }}>-</span>)
                      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {/* first clock-in - editable in place; toggle reveals the rest */}
                          {inCell(firstSeg)}
                          {multi && (
                            <button onClick={() => setOpenPunches(o => ({ ...o, [fd.date]: !o[fd.date] }))} aria-expanded={punchesOpen}
                              title="Show every clock-in and clock-out for this day"
                              style={{ background: 'var(--wk-hover)', border: '1px solid var(--line)', borderRadius: 999, padding: '1px 8px', cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {segs.length} punches {punchesOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            </button>
                          )}
                          {/* Add ANOTHER session to a day that already has punches - the
                              inline in/out cells only EDIT existing ones (Neil, Aug 3). */}
                          {!self && !fin && !fd.future && addBtn}
                        </span>}
                  </td>
                  <td className="fx-out" style={td}>
                    {!segs.length
                      ? <span style={{ color: 'var(--muted)' }}>-</span>
                      : multi
                        ? outCell(lastSeg)
                        : outCell(firstSeg)}
                  </td>
                  <td className="fx-hours" style={{ ...td, textAlign: 'right' }}>{segs.length ? hhmm(d.workedMin) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                  {breakCell}
                  <td className="fx-effect" style={{ ...td, textAlign: 'right' }}>{showPay ? effect(fd) : ''}</td>
                  <td className="fx-notes" style={td}>
                    {self
                      ? <NoteCell date={fd.date} note={myNote(fd.date)} onSave={saveMyNote} placeholder="Add a note for your manager" />
                      : <><NoteCell date={fd.date} note={dayNotes[fd.date]} onSave={saveNote} /><EmployeeNoteLine note={dayNotes[fd.date]} /></>}
                  </td>
                  <td className="fx-log" style={{ ...td, textAlign: 'center' }}>
                    <WorkLogButton onClick={() => setWorkLogDay(fd.date)} title={`View the Work Log for ${dow(fd.date)}`} />
                  </td>
                </tr>
              );

              // ── Auto-closed day (no clock-out was recorded): same loud line the
              //    hourly card gets, so 'Absent'/0 hours never reads as unexplained ──
              if (segs.some(s => (s.flags || []).includes('auto_clock_out'))) rows.push(
                <tr key={fd.date + '-auto'} style={{ background: rowBg }}>
                  <td colSpan={self ? 8 : 9} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b91c1c', fontWeight: 600, fontSize: 11.5, whiteSpace: 'normal' }}>
                    <AlertTriangle size={11} style={{ marginRight: 5, verticalAlign: 'middle' }} />
                    Auto-closed at end of day - no clock-out was recorded. The day is held until the real Out time is set{self ? ' - tap the Out time to propose the real end of your shift.' : '.'}
                  </td>
                </tr>
              );

              // ── Expanded: every punch pair, editable ──
              if (multi && punchesOpen) {
                segs.forEach((seg, si) => {
                  // An EDITED punch (a pending employee edit, or an HR time change)
                  // is tinted amber, badged "edited", and shows its reason inline -
                  // same for HR and the employee.
                  const reasons = segReasons(seg);
                  const edited = reasons.length > 0;
                  const rBg = edited ? 'rgba(180,83,9,0.09)' : 'var(--wk-hover)';
                  rows.push(
                    <tr key={fd.date + '-p' + si} style={{ background: rBg }}>
                      <td style={td}></td>
                      <td style={{ ...td, color: 'var(--muted)', fontSize: 11 }}>
                        Punch {si + 1}{edited && <span style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: '#b45309', background: 'rgba(180,83,9,0.16)', padding: '1px 6px', borderRadius: 6 }}>edited</span>}
                      </td>
                      <td style={td}>{inCell(seg)}</td>
                      <td style={td}>{outCell(seg)}</td>
                      <td style={{ ...td, textAlign: 'right', color: 'var(--muted)' }}>{hhmm(seg.workedMin)}</td>
                      <td style={td}></td>
                      <td style={td}></td>
                      {!self && <td style={td}></td>}
                      <td style={td}></td>
                    </tr>
                  );
                  if (edited) rows.push(
                    <tr key={fd.date + '-pr' + si} style={{ background: rBg }}>
                      <td style={td}></td><td style={td}></td>
                      <td colSpan={self ? 6 : 7} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b45309', fontStyle: 'italic', fontSize: 11.5, whiteSpace: 'normal' }}>
                        <Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{reasons.join('  ·  ')}
                      </td>
                    </tr>
                  );
                });
                if (!fin && !fd.future) rows.push(
                  <tr key={fd.date + '-padd'} style={{ background: 'var(--wk-hover)' }}>
                    <td style={td}></td><td style={td}></td>
                    <td style={td} colSpan={2}>{addBtn}</td>
                    <td style={td}></td><td style={td}></td><td style={td}></td><td style={td}></td>
                    {!self && <td style={td}></td>}
                  </tr>
                );
              }

              // ── Expanded: each break window (clock-out -> next clock-in + duration) ──
              if ((breaksOpen || unendedBreak) && dayBreak > 0) rows.push(
                <tr key={fd.date + '-br'} style={{ background: 'var(--wk-hover)' }}>
                  <td colSpan={self ? 8 : 9} style={{ ...td, whiteSpace: 'normal', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: breakFg, marginRight: 10 }}>Breaks - {hhmm(dayBreak)} {overBreak ? '(over the 60 min allowance)' : '(within 60 min)'}</span>
                    {formal.map((b, i) => (
                      <span key={'f' + i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: b.implicit ? 'rgba(185,28,28,0.07)' : 'var(--card)', border: `1px solid ${b.implicit ? 'rgba(185,28,28,0.4)' : 'var(--line)'}`, borderRadius: 999, padding: '2px 9px', margin: '2px 6px 2px 0', fontSize: 11.5 }}>
                        {t12(b.start)} <ArrowRight size={10} style={{ opacity: 0.6 }} /> {t12(b.end)}
                        <span style={{ fontWeight: 700, marginLeft: 3 }}>({hhmm(b.min)})</span>
                        {b.implicit && (
                          <span title="This break was never ended - the day's clock-out closed it, so all of this time counts as unpaid break." style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#b91c1c', fontWeight: 700 }}>
                            <AlertTriangle size={10} /> never ended
                          </span>
                        )}
                      </span>
                    ))}
                    {breaks.map((b, i) => (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 9px', margin: '2px 6px 2px 0', fontSize: 11.5 }}>
                        {t12(b.start)} <ArrowRight size={10} style={{ opacity: 0.6 }} /> {t12(b.end)}
                        <span style={{ fontWeight: 700, marginLeft: 3 }}>({b.min}m)</span>
                      </span>
                    ))}
                    {offClockGaps > 0 && <span style={{ color: 'var(--muted)', fontStyle: 'italic', marginLeft: 4 }}>· {offClockGaps} longer gap{offClockGaps === 1 ? '' : 's'} off the clock (not counted as break)</span>}
                    {!fin && (
                      <button onClick={() => setBreakFix({ date: fd.date, breaks: formal })}
                        title={self ? "Ask your approver to add a break punch that didn't record, or to remove a break" : 'Add the missing start or end of a break, or delete a break'}
                        style={{ background: 'none', border: 'none', padding: 0, marginLeft: 6, cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, color: unendedBreak ? '#b91c1c' : 'var(--wk-brand)' }}>
                        {unendedBreak ? 'Fix the Break End' : 'Fix a Break Punch'}
                      </button>
                    )}
                    {!fin && !self && (
                      <button onClick={() => setEditDay({ date: fd.date, seg: null, type: 'Break' })} title="Add another break to this day"
                        style={{ background: 'none', border: 'none', padding: 0, marginLeft: 10, cursor: 'pointer', font: 'inherit', fontSize: 11.5, fontWeight: 700, color: 'var(--wk-brand)' }}>
                        Add a Break
                      </button>
                    )}
                  </td>
                </tr>
              );

              // ── Day-level reasons: shown when the day is COLLAPSED. When expanded,
              //    each edited punch shows its own reason inline above instead. ──
              if (notes.length && !(multi && punchesOpen)) rows.push(
                <tr key={fd.date + '-notes'} style={{ background: rowBg }}>
                  <td colSpan={self ? 8 : 9} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b45309', fontStyle: 'italic', fontSize: 11.5, whiteSpace: 'normal' }}>
                    <Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{notes.join('  ·  ')}
                  </td>
                </tr>
              );

              // ── Pending add/remove requests on this day - HR approves/rejects here ──
              (reqsByDate[fd.date] || []).forEach(r => {
                const isIn = r.punchKind === 'in';
                // Break requests reach this row too now, so the label has to name
                // the actual kind - "Add clock-out" for a break end read as a
                // request to end the SHIFT.
                const kindLabel = r.action === 'remove' ? 'Remove a punch'
                  : `Add ${PR_KIND_LABEL[r.punchKind] || r.punchKind}${r.category ? ` as ${r.category}` : ''}`;
                rows.push(
                  <tr key={fd.date + '-req-' + r.id} style={{ background: 'rgba(180,83,9,0.07)' }}>
                    <td style={td}></td>
                    <td style={td}><span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: 'rgba(180,83,9,0.16)', color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={10} /> Request</span></td>
                    <td style={td}>{r.action === 'add' && isIn ? <span style={{ color: '#b45309', fontWeight: 700 }}>{t12(r.at)}</span> : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                    <td style={td}>{r.action === 'add' && !isIn ? <span style={{ color: '#b45309', fontWeight: 700 }}>{t12(r.at)}</span> : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                    <td style={td}></td>
                    <td style={td}></td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {!self
                        ? <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button onClick={() => decideReq(r.id, 'approved')} title="Approve - adds this punch to the timecard" style={{ ...reqBtn, border: 'none', background: 'hsl(var(--color-green))', color: '#fff' }}>Approve</button>
                            <button onClick={() => decideReq(r.id, 'rejected')} title="Reject - the employee is notified" style={{ ...reqBtn, border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)' }}>Reject</button>
                          </span>
                        : <span style={{ fontSize: 11, color: '#b45309', fontWeight: 700, fontStyle: 'italic' }}>pending approval</span>}
                    </td>
                    <td style={td}></td>
                  </tr>
                );
                rows.push(
                  <tr key={fd.date + '-reqr-' + r.id} style={{ background: 'rgba(180,83,9,0.07)' }}>
                    <td colSpan={self ? 8 : 9} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b45309', fontSize: 11.5, whiteSpace: 'normal' }}>
                      <span style={{ fontWeight: 700 }}>{kindLabel}</span>{r.reason ? <span style={{ fontStyle: 'italic' }}> · {r.employeeName || 'Employee'}: “{r.reason}”</span> : ''}
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
        <div style={{ flex: 1, minWidth: 300, display: showPay ? undefined : 'none', border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
          {(() => {
            const rows = [
              [fixedSplit ? 'Salary this month (pro-rated by day)' : 'Monthly salary', fmtM(T.salaryForPeriod ?? T.monthlySalary)],
              // Why the days were missed (Charmi, Oct 15 2026): "Sick ×2 · Personal ×8"
              // instead of only a count - the server sends missedReasons.
              [<span key="missed">
                {`Missed days (${T.missedFullDays} full${T.missedHalfDays ? `, ${T.missedHalfDays} half` : ''})`}
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
              [`Weekend pay (${T.weekendDaysWorked} day${T.weekendDaysWorked === 1 ? '' : 's'}, ${data.weekendMultiplier || 1.35} × daily by hours)`, T.weekendBonus ? `+${fmtM(T.weekendBonus)}` : fmtM(0)],
              ['Net pay this month', fmtM(T.totalPay)],
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
        <div style={{ minWidth: 200, fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
            <span>Missing punches</span><span style={{ fontWeight: 700, color: T.missingPunches ? '#b91c1c' : 'var(--ink)' }}>{T.missingPunches}</span>
          </div>
          {T.pendingEdits > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: '#b45309', fontWeight: 700 }} title={self ? 'Your edits waiting for approval' : 'Employee edits awaiting your review'}>
              <span>Pending edits</span><span>{T.pendingEdits}</span>
            </div>
          )}
          {!self && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {isAdmin && fin && (
                <button className="secondary-btn" onClick={onUnfinalize} disabled={busy} style={{ fontSize: 12.5 }}>Unlock</button>)}
              {isAdmin && !fin && LEGACY_FINALIZE && (
                <button className="secondary-btn" onClick={onFinalize} disabled={busy} title="HR override: finalize for payroll without the review and signatures"
                  style={{ fontSize: 12.5 }}>Finalize Without Signatures</button>)}
            </div>
          )}
        </div>
      </div>

      {/* Review + Nexus Sign (same as hourly) */}
      <TimesheetReviewPanel review={data.review} self={self} anchor={data.periodStart} periodLabel={monthLabel}
        nameFor={nameFor} onChanged={load} toastOk={toastOk} toastErr={toastErr} />

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
      {geoMap && (
        <GeofencePunchModal email={geoMap} name={data?.name || nameFor?.(geoMap) || geoMap} start={data?.periodStart || ''} end={data?.periodEnd || ''} onClose={() => setGeoMap('')} />
      )}
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
  const punchId = k === 'in' ? seg?.inId : seg?.outId;   // always available (for approve/reject)
  const id = (locked ? '' : punchId);                    // editable id (blank when locked)
  const raw = k === 'in' ? seg?.in : seg?.out;
  const rounded = k === 'in' ? (seg?.inR || seg?.in) : (seg?.outR || seg?.out);
  const pendingAt = k === 'in' ? seg?.inPendingAt : seg?.outPendingAt;
  const pendReason = k === 'in' ? seg?.inEditReason : seg?.outEditReason;
  const isPending = (k === 'in' ? seg?.inEditStatus : seg?.outEditStatus) === 'pending' && pendingAt;
  const adjustNote = k === 'in' ? seg?.inAdjustNote : seg?.outAdjustNote;   // why this punch was changed
  if (!raw) return <span style={{ color: 'var(--muted)' }}>-</span>;

  async function commit(atUtc) {
    if (self) {
      // Employee edit: goes to the approver, and does NOT change pay until approved.
      const reason = await dialog.prompt('', {
        title: `Change your ${k === 'in' ? 'clock-in' : 'clock-out'} time`,
        message: 'This is sent to your approver. Your pay is unchanged until they approve it.',
        placeholder: 'Reason (optional)', confirmText: 'Send for approval',
      });
      if (reason === null) return;   // cancelled
      try { await api.timePunchEditCreate({ punch_id: id, at: atUtc, reason: reason || '' }); onSaved?.(); }
      catch (err) { toastErr?.(err?.message || 'Could not send the edit.'); }
    } else {
      try { await api.timeAdjustPunch(id, { at: atUtc }); onSaved?.(); }
      catch (err) { toastErr?.(err?.message || 'Could not save the time.'); }
    }
  }

  if (editing) return (
    <input autoFocus type="datetime-local" className="form-input" value={val}
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setVal(''); setEditing(false); } }}
      onBlur={async () => {
        const orig = utcToInput(raw); setEditing(false);
        if (val && val !== orig) await commit(inputToUtc(val));
      }}
      style={{ fontSize: 12, padding: '2px 4px', width: 172 }} />
  );
  // Each punch is judged on its own: the In dot is the in punch, the Out dot the out punch.
  const geo = (k === 'out' ? seg.geoOut : seg.geo) || '';
  const siteName = (k === 'out' ? seg.workSiteOut : seg.workSite) || '';
  const mini = { border: 'none', background: 'none', cursor: 'pointer', padding: '0 2px', fontWeight: 800, fontSize: 12, lineHeight: 1 };
  const dotColor = geo === 'in_fence' ? 'hsl(var(--color-green))' : geo === 'out_of_fence' ? '#b91c1c' : 'var(--line-strong,var(--line))';
  // Clicking the location dot opens the Geofence Punch view for this person and
  // period (SwipeClock-style map + punch table, Charmi Sep 25).
  const openMap = (e) => { e.stopPropagation(); if (!locateEmail) return; onLocate?.(); };
  const dotTitle = (geo === 'in_fence' ? `On site${siteName ? ` - ${siteName}` : ''}` : geo === 'out_of_fence' ? `Out of Location${siteName ? ` - nearest ${siteName}` : ''}` : geo === 'no_site' ? 'No location mapped' : geo === 'low_accuracy' ? 'Approx. location - no GPS, too rough to tell which site' : geo === 'remote' ? 'Remote' : geo === 'no_location' ? 'No location shared' : 'GPS only');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {geo && geo !== 'no_location' && (locateEmail
        ? <button onClick={openMap} aria-label="Open the geofence punch map" title={`${dotTitle} - click for the punch map`}
            style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, padding: 0, cursor: 'pointer', border: 'none', background: dotColor, boxShadow: `0 0 0 2px var(--card), 0 0 0 3px ${dotColor}` }} />
        : <span title={dotTitle}
            style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: dotColor }} />)}
      <button onClick={() => { if (!id) return; setVal(utcToInput(raw)); setEditing(true); }}
        title={[punchHistory(meta, rounded), id ? (self ? 'Click to propose a new time - goes to your approver; pay unchanged until approved' : 'Click to edit this punch time - the original stays on record') : ''].filter(Boolean).join('\n')}
        style={{ background: 'none', border: 'none', padding: 0, cursor: id ? 'pointer' : 'default', font: 'inherit', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {/* A punch someone entered or changed reads bold, as on SwipeClock. */}
        <span style={{ borderBottom: id ? `1px dashed ${self ? 'var(--wk-brand)' : 'var(--line-strong,var(--line))'}` : '1px dashed var(--line-strong,var(--line))', color: self && id ? 'var(--wk-brand)' : undefined, fontWeight: (meta?.manual || meta?.adjustedAt) ? 800 : self && id ? 600 : undefined }}>{t12(rounded)}</span>
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: '#b45309', fontWeight: 700 }}
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
export function BreakFixModal({ day, email = '', self = true, busy, setBusy, onDone, onClose, toastOk, toastErr }) {
  // A break the day's clock-out closed (implicit) is one whose END never landed -
  // by far the common case, so open on it with its start time already known.
  const unended = (day.breaks || []).find(b => b.implicit);
  // Adding a WHOLE break is the Add punch form with Type = Break (Neil, Oct 13).
  const [kind, setKind] = useState(unended ? 'break_end' : 'break_start');
  const [endAt, setEndAt] = useState(`${day.date}T12:30`);
  const [at, setAt] = useState(() => {
    const anchor = unended?.start || (day.breaks || [])[0]?.end || '';
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
    // End first, then start: never leave a lone break_end behind.
    const ids = [b.endId, b.startId].filter(Boolean);
    setBusy(true);
    try {
      for (const id of ids) {
        if (self) await api.timePunchRequestCreate({ action: 'remove', target_punch_id: id, reason: reason.trim() });
        else await api.timeAdjustPunch(id, { void: true, adjust_note: reason.trim() });
      }
      toastOk?.(self ? 'Request sent - your approver decides whether the break comes off.' : 'Break deleted - the timecard is updated.');
      window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
      onDone();
    } catch (e) { toastErr?.(e?.message || 'Could not delete the break.'); }
    setBusy(false);
  }

  async function save() {
    if (!reason.trim()) { toastErr?.(self ? 'Add a reason so your approver can confirm it.' : 'Add a reason - it is kept on record.'); return; }
    if (isDelete) { await removeBreak(); return; }
    if (kind === 'both') {
      if (new Date(endAt) <= new Date(at)) { toastErr?.('The break end has to be after the break started.'); return; }
      setBusy(true);
      try {
        await api.timeAddPunch({ employee_email: email, kind: 'break_start', at: inputToUtc(at), tz_offset_min: tzFor(at), note: reason.trim() });
        await api.timeAddPunch({ employee_email: email, kind: 'break_end', at: inputToUtc(endAt), tz_offset_min: tzFor(endAt), note: reason.trim() });
        toastOk?.('Break added - the timecard is updated.');
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
        await api.timePunchRequestCreate({ action: 'add', punch_kind: kind, at: inputToUtc(at), tz_offset_min: tzFor(at), reason: reason.trim() });
        toastOk?.('Request sent to your approver - it shows on your timecard as Not Yet Approved until they decide.');
      } else {
        await api.timeAddPunch({ employee_email: email, kind, at: inputToUtc(at), tz_offset_min: tzFor(at), note: reason.trim() });
        toastOk?.(kind === 'break_end' ? 'Break end added - the timecard is updated.' : 'Break start added - the timecard is updated.');
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
        style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 'clamp(400px, 50vw, 560px)', padding: 20, boxShadow: '0 24px 70px rgba(17,24,39,0.30)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{isDelete ? (self ? 'Ask to Remove a Break' : 'Delete a Break') : self ? 'Request a Missing Break Punch' : kind === 'both' ? 'Add a Break' : 'Fix a Break Punch'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        {unended && !isDelete && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: '#b45309', background: 'rgba(180,83,9,0.09)', border: '1px solid rgba(180,83,9,0.25)', borderRadius: 10, padding: '9px 12px', marginBottom: 12 }}>
            {self ? 'Your' : 'The'} break started at {t12(unended.start)} and was never ended, so the clock-out closed it
            and all {hhmm(unended.min)} of it counts as unpaid break. Set the time {self ? 'you' : 'they'} actually came back.
          </div>
        )}
        <div style={{ display: 'grid', gap: 12 }}>
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
                {self ? 'Your approver decides; nothing changes until they approve.' : 'Its start and end punches come off the timecard. The audit record keeps them, with who deleted them and why.'}
              </span>
            </label>
          ) : (
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>{kind === 'both' ? 'Break start' : label} time
            <input autoFocus type="datetime-local" className="form-input" value={at} onChange={e => setAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
          </label>
          )}
          {kind === 'both' && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Break end time
              <input type="datetime-local" className="form-input" value={endAt} onChange={e => setEndAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
            </label>
          )}
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>{self ? 'Reason (sent to your approver - not the time)' : 'Reason (kept on record and shown to the employee)'}
            <input className="form-input" value={reason} onChange={e => setReason(e.target.value)}
              placeholder={self ? "Why it's missing - e.g. ended my break on my phone and it didn't record" : 'Why - e.g. confirmed with them they were back at 1:00 PM'} style={{ width: '100%', fontSize: 13 }} />
          </label>
        </div>
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
  // Type is offered when adding a whole block - a manager on any new pair, an
  // employee on a day they ask to add time to (Pranshu, Oct 13).
  const canAddBreak = !seg;
  const showType = self ? !seg : !!(seg?.inId || needIn);

  async function save() {
    setErr('');
    // A clock-out must be after the clock-in it pairs with. With the out now
    // defaulting to the in-time, leaving it unchanged trips this - forcing the real
    // time in - and it also catches a time accidentally typed into the reason field.
    const inRef = (seg?.inId && !needIn) ? utcToInput(seg.in) : inAt;
    if (needOut && inRef && new Date(outAt) <= new Date(inRef)) {
      fail('Set the clock-out time - it has to be after the clock-in.'); return;
    }
    // ...and a clock-in added in front of an existing clock-out comes first (Oct 1).
    if (needIn && !needOut && seg?.out && new Date(inAt) >= new Date(utcToInput(seg.out))) {
      fail('Set the clock-in time - it has to be before the clock-out.'); return;
    }
    // Whichever side changed, the clock-out never ends up before the clock-in
    // (Oct 1) - the server refuses it too (_guard_punch_order).
    if (inAt && outAt && new Date(outAt) <= new Date(inAt)) {
      fail('The clock-out has to be after the clock-in.'); return;
    }
    // A break: the two times are its start and end, inside a shift that day.
    if (isBreak && canAddBreak && self) {
      if (!reason.trim()) { fail('Add a reason so your approver can confirm it.'); return; }
      setBusy(true);
      try {
        await api.timePunchRequestCreate({ action: 'add', punch_kind: 'break_start', at: inputToUtc(inAt), tz_offset_min: tzFor(inAt), reason: reason.trim() });
        await api.timePunchRequestCreate({ action: 'add', punch_kind: 'break_end', at: inputToUtc(outAt), tz_offset_min: tzFor(outAt), reason: reason.trim() });
        toastOk?.('Request sent to your approver - it shows on your timecard as Not Yet Approved until they decide.');
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
        toastOk?.('Break added - the timecard is updated.');
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
        if (needIn) adds.push(['in', inAt]);
        if (needOut) adds.push(['out', outAt]);
        for (const [kind, at] of adds) {
          await api.timePunchRequestCreate({ action: 'add', punch_kind: kind, at: inputToUtc(at), tz_offset_min: tzFor(at), reason: reason.trim(),
            category: kind === 'in' && LEAVE_TYPES.includes(type) ? type : '' });
        }
        toastOk?.('Request sent to your approver - it shows on your timecard as Not Yet Approved until they decide.');
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
      if (outFirst) { await saveOut(); await saveIn(); } else { await saveIn(); await saveOut(); }
      toastOk?.('Timecard updated - original times stay on record.'); onDone();
    } catch (e) { fail(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  // Delete one punch or the whole pair (Neil, Oct 12-13 - SwipeClock's
  // "delete"). The punch is voided server-side: it leaves the hours but stays
  // on record with who deleted it, so nothing is physically lost.
  async function voidPunches(ids, what) {
    const list = ids.filter(Boolean);
    if (!list.length) return;
    if (!await dialog.confirm(`Delete ${what}? It comes off the timecard and out of the hours. The audit record keeps it, with who deleted it.`,
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}
      onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div role="dialog" aria-modal="true" aria-label={self ? 'Request a missing punch' : seg ? 'Edit punch' : isBreak ? 'Add break' : 'Add punch'}
        style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 'clamp(400px, 60vw, 680px)', padding: 20, boxShadow: '0 24px 70px rgba(17,24,39,0.30)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{self ? 'Request a Missing Punch' : seg ? 'Edit Punch' : isBreak ? 'Add Break' : 'Add Punch'}</span>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {/* In self mode only the MISSING punch is editable - an existing time stays
              shown (disabled) for context but can't be silently overwritten here. */}
          {showType && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Type
              <select className="form-input" value={type} onChange={e => pickType(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="Regular">Regular</option>
                {canAddBreak && <option value="Break">Break</option>}
                {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          )}
          {(!self || needIn) && <label style={{ fontSize: 11, color: 'var(--muted)' }}>{isBreak ? 'Break start time' : 'Clock in time'}<input autoFocus={self && needIn} type="datetime-local" className="form-input" value={inAt} disabled={self && !needIn} onChange={e => setInAt(e.target.value)} style={{ width: '100%', fontSize: 13, opacity: self && !needIn ? 0.6 : 1 }} /></label>}
          {(!self || needOut) && <label style={{ fontSize: 11, color: 'var(--muted)' }}>{isBreak ? 'Break end time' : 'Clock out time'}<input autoFocus={self && needOut && !needIn} type="datetime-local" className="form-input" value={outAt} disabled={self && !needOut} onChange={e => setOutAt(e.target.value)} style={{ width: '100%', fontSize: 13, opacity: self && !needOut ? 0.6 : 1 }} /></label>}
          {self && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Reason (sent to your approver - not the time)
              <input className="form-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Why you're adding it - e.g. forgot to clock out" style={{ width: '100%', fontSize: 13 }} />
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
