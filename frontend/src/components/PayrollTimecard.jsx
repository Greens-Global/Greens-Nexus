import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowRight, Pencil, Plus, X, Loader2, CheckCircle, Download, AlertTriangle, MapPin, PlayCircle, Info } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { TZ_OPTIONS, useDisplayTz, setDisplayTz, formatTimeTz, utcToInputTz, inputToUtcTz } from '../lib/displayTz';
import { dialog } from '../ui/dialog';
import { useWorkSites } from '../lib/queries';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { useRole } from '../contexts/RoleContext';
import GuidedTour from './GuidedTour';
import WorkLogDrawer, { WorkLogButton } from './WorkLogDrawer';

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
const CUR_SYM = { USD: '$', INR: '₹' };
const money = (n, cur = 'USD') => `${CUR_SYM[cur] || '$'}${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const t12 = (iso) => iso ? formatTimeTz(iso) : '-';
const utcToInput = (iso) => utcToInputTz(iso);
const inputToUtc = (v) => inputToUtcTz(v);

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

// Snap any instant onto the pay-period series: the boundary Sunday at-or-before
// it, computed ENTIRELY in UTC. pStart is always one of these UTC instants.
const snapPeriodUTC = (t) => new Date(ANCHOR + Math.floor((t - ANCHOR) / (14 * DAY)) * 14 * DAY);

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
function LocCell({ seg }) {
  if (!seg) return <span style={{ color: 'var(--muted)' }}>-</span>;
  const geo = seg.geo || '';
  const site = seg.workSite || '';
  if (!site && geo !== 'out_of_fence') return <span style={{ color: 'var(--muted)' }}>-</span>;
  const color = geo === 'in_fence' ? 'hsl(var(--color-green))'
    : geo === 'out_of_fence' ? '#b45309' : 'var(--muted)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
      title={geo === 'out_of_fence' ? `${site || 'nearest site'} - off-site when punched` : site}>
      <MapPin size={12} style={{ color, flexShrink: 0 }} />
      <span style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
        {site || 'Off-site'}{geo === 'out_of_fence' && site ? ' ⚠' : ''}
      </span>
    </span>
  );
}

// Last successful payload per (employee|self + period), kept at MODULE scope so it
// survives the component unmounting between tabs. Reopening the Time Sheet paints the
// cached card instantly and refreshes in the background - no loader flash, no snap.
const _timecardCache = new Map();
const _tcKey = (self, email, start, end) => self ? `self:${start}` : (email ? `${email}:${start}:${end}` : '');

export default function PayrollTimecard({ toastOk, toastErr, selfMode = false, initialEmail = '' }) {
  const self = selfMode;   // employee viewing their OWN timecard (from /my-payroll)
  const [people, setPeople] = useState([]);
  const [email, setEmail] = useState(initialEmail);
  // Jump to a specific employee when the caller changes initialEmail (e.g. the
  // "N to review" badge in TimeAdmin opens that person's card).
  useEffect(() => { if (initialEmail) setEmail(initialEmail); }, [initialEmail]);
  const [pStart, setPStart] = useState(() => periodStartFor(new Date()));
  // Seed from the module cache so a reopen renders the last card immediately (no loader).
  const [data, setData] = useState(() => {
    const s = isoDate(pStart), e = isoDate(pStart.getTime() + 13 * DAY);
    return _timecardCache.get(_tcKey(selfMode, initialEmail, s, e)) || null;
  });
  const [rateInput, setRateInput] = useState('');
  const [ruleInput, setRuleInput] = useState('ca');   // ca | federal | none
  const [editDay, setEditDay] = useState(null);   // { date, seg? }
  const [busy, setBusy] = useState(false);
  const [stepLocked, setStepLocked] = useState(false);   // payroll $ needs a fresh step-up
  const [exceptions, setExceptions] = useState([]);      // per-employee missing/exception counts (sidebar)
  const [showRaw, setShowRaw] = useState(false);         // SwipeClock's "Show Unrounded Times"
  useDisplayTz();   // re-render this card (and its time cells) when the tz switch flips
  const [tour, setTour] = useState(false);               // Simulate walkthrough
  const { can, myEmail } = useRole();
  const isAdmin = can('administrator');
  const [workLogDay, setWorkLogDay] = useState(null);   // date string - opens the Work Log drawer for this day
  // Location dot on a punch links to the Locations map, for viewers who can reach it.
  const hourlyLocate = (!self || isAdmin) ? (data?.email || email || '') : '';

  const start = isoDate(pStart);
  const end = isoDate(pStart.getTime() + 13 * DAY);
  const cacheKey = _tcKey(self, email, start, end);
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => isoDate(pStart.getTime() + i * DAY)), [pStart]);

  // employee list (scoped) for the picker
  useEffect(() => {
    if (self) return;   // employee self-view has no picker / team list
    api.timeTeam(start, end).then(r => {
      const list = (r.rows || []).map(x => ({ email: x.email, name: x.name || x.email, pendingEdits: x.pendingEdits || 0 }));
      setPeople(list);
      setEmail(e => e || list[0]?.email || '');
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        setStepLocked(false); setData(d); setRateInput(d.rateSet ? String(d.rate) : ''); setRuleInput(d.overtimeRule || 'ca');
      }).catch(e => { if (reqKeyRef.current === key) { setData(null); toastErr?.(e?.message || 'Could not load your timecard.'); } });
      return;
    }
    if (!email) return;
    const key = _tcKey(false, email, start, end);
    reqKeyRef.current = key;
    api.timePayroll(email, start, end).then(d => {
      _timecardCache.set(key, d);
      if (reqKeyRef.current !== key) return;
      setStepLocked(false); setData(d); setRateInput(d.rateSet ? String(d.rate) : ''); setRuleInput(d.overtimeRule || 'ca');
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

  // Fixed employees are paid by MONTH, but the default period anchor is the
  // bi-weekly Sunday (which can fall in the previous month). On the first fixed
  // load, snap to the CURRENT month so they don't open on last month by default.
  const fixedSnapped = useRef(false);
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

  async function saveRate() {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) toastErr?.('Identity check didn’t complete.'); return; }
    setBusy(true);
    try { await api.timePayrollRate({ email, hourly_rate: parseFloat(rateInput) || 0, overtime_rule: ruleInput }); toastOk?.('Pay rate saved.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not save rate.'); }
    setBusy(false);
  }
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
  async function approve() {
    await signOff((allow) => api.timeApprove({ email, start: perStart, end: perEnd, allow_exceptions: allow }),
      'Approve', 'Timecard approved - the employee is notified.');
  }
  async function signTimecard() {
    setBusy(true);
    try { await api.timeSignMyTimecard(perStart); toastOk?.('Timecard signed - thank you.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not sign.'); }
    setBusy(false);
  }

  // Hourly nav MUST stay Sunday-anchored (SwipeClock parity). Step in whole
  // periods on the UTC series - snapPeriodUTC first, so a pStart left
  // off-series by a fixed employee's month snap re-aligns. Never route the
  // step through periodStartFor: that reads the LOCAL calendar, and a UTC
  // boundary lands on Saturday for US viewers, re-flooring a period back.
  const shift = (n) => setPStart(new Date(snapPeriodUTC(pStart.getTime()).getTime() + n * 14 * DAY));
  const isFixed = data?.payType === 'fixed';   // monthly salary employee (not hourly)
  const cur = data?.currency || 'USD';         // $ or ₹
  const fmtM = (n) => money(n, cur);
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

  const th = { fontSize: 11.5, fontWeight: 600, color: 'var(--wk-dim)', padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' };
  const td = { fontSize: 12.5, padding: '6px 10px', textAlign: 'right', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' };

  // build rows: for each date, its segments (or one empty row); punch-note lines
  // under their day (SwipeClock); weekly subtotal after each SUNDAY-anchored week
  const rows = [];
  let prevWeek = null;
  dates.forEach(ds => {
    const d = byDate[ds];
    const wk = d?.weekStart || (() => { const x = new Date(ds + 'T00:00'); x.setDate(x.getDate() - x.getDay()); return isoDate(x); })();
    if (prevWeek && wk !== prevWeek) rows.push({ type: 'wk', week: prevWeek });
    prevWeek = wk;
    const segs = d?.segments || [];
    if (!segs.length) rows.push({ type: 'day', ds, seg: null });
    else {
      segs.forEach((seg, i) => rows.push({ type: 'day', ds, seg, first: i === 0, last: i === segs.length - 1 }));
      // Same reasons/notes the fixed card shows: employee edit reasons + HR adjust
      // notes + punch notes, visible in the card (not only on the hover Info dot).
      // Internal markers like "payroll edit" are filtered out (segReasons).
      const notes = segs.flatMap(segReasons);
      if (notes.length) rows.push({ type: 'note', text: notes.join('  ·  ') });
    }
  });
  if (prevWeek) rows.push({ type: 'wk', week: prevWeek });

  const dow = (ds) => new Date(ds + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });

  const exByEmail = Object.fromEntries(exceptions.map(e => [e.email, e]));
  const sidebar = (exceptions.length ? exceptions : people.map(p => ({ ...p, missing: 0, exceptions: 0 })));

  // The employee master-detail list - shared by the hourly and fixed-salary views
  // so switching between them never rearranges the screen (hidden in self mode).
  const employeeSidebar = !self ? (
    <div data-tour="pr-sidebar" style={{ width: 210, flexShrink: 0, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', maxHeight: 620, overflowY: 'auto', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }} className="pr-sidebar">
      <div style={{ padding: '9px 12px', background: 'var(--wk-hover)', fontSize: 12, fontWeight: 500, color: 'var(--wk-dim)', display: 'flex' }}>
        <span style={{ flex: 1 }}>Employee</span><span title="Missing punches">M</span><span style={{ width: 22, textAlign: 'right' }} title="Exceptions">E</span>
      </div>
      {sidebar.map(p => {
        const sel = p.email === email;
        return (
          <button key={p.email} onClick={() => setEmail(p.email)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderTop: '1px solid var(--line)', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 12.5, background: sel ? 'var(--wk-brand-tint)' : 'transparent', fontWeight: sel ? 700 : 500, color: sel ? 'var(--wk-brand)' : 'var(--ink)' }}>
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
        onApprove={approve} onFinalize={finalize} onUnfinalize={unfinalize} onSign={signTimecard}
        editDay={editDay} setEditDay={setEditDay} load={load} toastOk={toastOk} toastErr={toastErr}
        setWorkLogDay={setWorkLogDay} />
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
    const spinner = (
      <div style={{ fontFamily: 'var(--wk-font)', padding: '52px 0', textAlign: 'center', color: 'var(--muted)' }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
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
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 180 }}>My Timecard</span>
          : <select className="form-input" value={email} onChange={e => setEmail(e.target.value)} style={{ fontSize: 13, minWidth: 180, fontWeight: 700 }} title="Also selectable from the sidebar">
              {people.map(p => <option key={p.email} value={p.email}>{p.name}{p.pendingEdits ? ` (${p.pendingEdits} to review)` : exByEmail[p.email]?.missing ? ` (${exByEmail[p.email].missing} missing)` : ''}</option>)}
            </select>}
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
        <div style={{ flex: 1 }} />
        <TzSwitch />
        <label data-tour="pr-rounding" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700, cursor: 'pointer' }}
          title="SwipeClock shows rounded times (nearest 5 min) and computes pay from them. Tick to see the raw punch times instead - totals stay computed from rounded.">
          <input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />
          Show unrounded times
        </label>
        {isAdmin && data?.rounding && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700, cursor: 'pointer' }}
            title={`Round every punch to the nearest ${data.rounding.nearestMin || 5} minutes before computing hours - matches SwipeClock (site setting: nearest 5). Keep ON during the parallel run.`}>
            <input type="checkbox" checked={!!data.rounding.enabled}
              onChange={async e => {
                try { await api.timeRoundingSet({ enabled: e.target.checked, nearestMin: data.rounding.nearestMin || 5 }); toastOk?.(`Punch rounding ${e.target.checked ? 'on' : 'off'}.`); load(); }
                catch (err) { toastErr?.(err?.message || 'Could not update rounding.'); }
              }} />
            Round to {data.rounding.nearestMin || 5} min
          </label>
        )}
        {isAdmin && data?.autoLunch && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700, cursor: 'pointer' }}
            title={`Auto-deduct ${data.autoLunch.deductMin}m lunch from any segment over ${Math.round(data.autoLunch.afterMin / 60)}h with no recorded break. Applies to everyone.`}>
            <input type="checkbox" checked={!!data.autoLunch.enabled}
              onChange={async e => {
                try { await api.timeAutoLunchSet({ enabled: e.target.checked, afterMin: data.autoLunch.afterMin, deductMin: data.autoLunch.deductMin }); toastOk?.(`Auto-lunch ${e.target.checked ? 'enabled' : 'disabled'}.`); load(); }
                catch (err) { toastErr?.(err?.message || 'Could not update auto-lunch.'); }
              }} />
            Auto-lunch
          </label>
        )}
        {!self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>OT rule</span>
          <select className="form-input" value={ruleInput} onChange={e => setRuleInput(e.target.value)}
            title="California = daily >8h/>12h + 7th-day + weekly 40h. Federal = weekly 40h only (out-of-state US). None = no US overtime (non-US)."
            style={{ width: 128, fontSize: 12.5 }}>
            <option value="ca">California</option>
            <option value="federal">Federal (US)</option>
            <option value="none">None (non-US)</option>
          </select>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Rate {CUR_SYM[cur] || '$'}/hr</span>
          <input type="number" min="0" step="0.01" className="form-input" value={rateInput} placeholder="0.00"
            onChange={e => setRateInput(e.target.value)} style={{ width: 90, fontSize: 13 }} />
          <button className="secondary-btn" onClick={saveRate} disabled={busy} style={{ fontSize: 12 }}>Save</button>
        </div>
        )}
      </div>

      {self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
          <Pencil size={13} style={{ flexShrink: 0 }} /> Tap any clock-in or clock-out time to request a change. It goes to your approver, and your pay stays the same until they approve it.
        </div>
      )}
      {!stepLocked && data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {data.dept && <span><strong style={{ color: 'var(--ink)' }}>Department:</strong> {data.dept}</span>}
          <span><strong style={{ color: 'var(--ink)' }}>Pay rate:</strong> {fmtM(rate)}/hr</span>
          <span><strong style={{ color: 'var(--ink)' }}>OT rule:</strong> {ruleInput === 'ca' ? 'California' : ruleInput === 'federal' ? 'Federal' : 'None'}</span>
          {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}>
            <CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
          {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}>
            <CheckCircle size={12} /> Finalized · {nameFor(fin.by)} - period locked</span>}
        </div>
      )}
      {!stepLocked && !data?.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No pay rate set for this employee - wages show {fmtM(0)} until you set one.
        </div>
      )}

      {stepLocked ? (
        <StepUpNeeded label="Payroll shows employees’ pay figures." onVerified={load} />
      ) : data === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>
      ) : (
        <div data-tour="pr-table" style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
          {/* SwipeClock column order - Date, In, Out, Deducted, Category, Hours,
              Hrs/day, Non-OT, OT, OT 2×, Loc, Department, Pay rate, Wage - so HR
              reads this card exactly like the one they use today. */}
          <table style={{ width: '100%', minWidth: 980, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--wk-hover)' }}>
                <th style={{ ...th, textAlign: 'left' }}>Date</th>
                <th style={{ ...th, textAlign: 'left' }}>In</th>
                <th style={{ ...th, textAlign: 'left' }}>Out</th>
                <th style={th}>Deducted time</th>
                <th style={{ ...th, textAlign: 'left' }}>Category</th>
                <th style={th}>Hours</th>
                <th style={th}>Hrs/day</th>
                <th title="What was planned, done, and left pending that day" style={{ ...th, textAlign: 'center' }}>Work Log</th>
                <th style={th}>Non-OT</th>
                <th style={th}>OT</th>
                <th style={th}>OT 2×</th>
                <th style={{ ...th, textAlign: 'left' }}>Loc</th>
                <th style={{ ...th, textAlign: 'left' }}>Department</th>
                <th style={th}>Pay rate</th>
                <th style={th}>Wage</th>
                <th data-tour="pr-edit" style={{ ...th, width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => r.type === 'wk' ? (
                <tr key={i} style={{ background: 'var(--wk-brand-tint)' }}>
                  <td colSpan={16} style={{ ...td, textAlign: 'center', fontWeight: 700, color: 'var(--wk-brand)', fontSize: 12 }}>
                    Total hours clocked for week of {new Date(r.week + 'T00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })} to {new Date(new Date(r.week + 'T00:00').getTime() + 6 * DAY).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}: {hhmm(weekTotals[r.week]?.min || 0)}
                  </td>
                </tr>
              ) : r.type === 'note' ? (
                <tr key={i}>
                  <td colSpan={16} style={{ ...td, textAlign: 'left', borderTop: 'none', paddingTop: 0, color: 'var(--muted)', fontStyle: 'italic', fontSize: 11.5 }}>
                    <Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{r.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className="pr-row">
                  <td style={{ ...td, textAlign: 'left', fontWeight: r.first === undefined ? 400 : 700, color: r.seg ? 'var(--ink)' : 'var(--muted)' }}>
                    {r.first === false ? '' : dow(r.ds)}
                  </td>
                  <td style={{ ...td, textAlign: 'left' }}>{r.seg
                    ? <InlineTime seg={r.seg} k="in" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={hourlyLocate} />
                    : self && !fin
                      ? <button onClick={() => setEditDay({ date: r.ds, seg: null })} title="Add a punch for this day - goes to your approver"
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand)', fontWeight: 600, font: 'inherit', opacity: 0.75 }}>+ add</button>
                      : '-'}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    {r.seg ? (r.seg.out
                      ? <InlineTime seg={r.seg} k="out" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={hourlyLocate} />
                      : (self && fin)
                        ? <span title="Period finalized - locked" style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                        : <button onClick={() => !fin && setEditDay({ date: r.ds, seg: r.seg })} title={fin ? 'Period finalized - locked' : self ? 'Add the missing clock-out - goes to your approver' : 'Add the missing clock-out'}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>) : '-'}
                  </td>
                  <td style={{ ...td, color: r.seg?.deductedMin ? '#b45309' : 'var(--muted)' }}>{r.seg?.deductedMin ? `−${r.seg.deductedMin}m` : '-'}</td>
                  <td style={{ ...td, textAlign: 'left', color: r.seg?.category ? 'var(--ink)' : 'var(--muted)' }}>{r.seg?.category || '-'}</td>
                  <td style={td}>{r.seg ? hhmm(r.seg.workedMin) : '-'}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{r.seg && byDate[r.ds]
                    ? (r.last ? hhmm(byDate[r.ds].workedMin) : '↓')
                    : ''}</td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    {r.first !== false && (
                      <WorkLogButton onClick={() => setWorkLogDay(r.ds)} title={`View the Work Log for ${dow(r.ds)}`} />
                    )}
                  </td>
                  <td style={td}>{r.seg?.regMin ? hhmm(r.seg.regMin) : '-'}</td>
                  <td style={{ ...td, color: r.seg?.otMin ? '#b45309' : 'var(--muted)', fontWeight: r.seg?.otMin ? 700 : 400 }}>{r.seg?.otMin ? hhmm(r.seg.otMin) : '-'}</td>
                  <td style={{ ...td, color: r.seg?.dtMin ? '#b91c1c' : 'var(--muted)', fontWeight: r.seg?.dtMin ? 700 : 400 }}>{r.seg?.dtMin ? hhmm(r.seg.dtMin) : '-'}</td>
                  <td style={{ ...td, textAlign: 'left' }}><LocCell seg={r.seg} /></td>
                  <td style={{ ...td, textAlign: 'left', color: 'var(--muted)' }}>{r.seg ? (data?.dept || '-') : '-'}</td>
                  <td style={{ ...td, color: 'var(--muted)' }}>{r.seg ? `${fmtM(rate)}/hr` : '-'}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{r.seg ? fmtM(r.seg.amount) : '-'}</td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    {!self && !fin && (
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
                        <button onClick={() => setEditDay({ date: r.ds, seg: r.seg })}
                          title={r.seg ? 'Edit punch' : 'Add punch'}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}>
                          {r.seg ? <Pencil size={13} /> : <Plus size={14} />}
                        </button>
                        {/* A day that already has punches still needs a way to add ANOTHER
                            session - the edit pencil only edits the existing pair. Show a
                            second "+" on the day's last row (Neil, Aug 3: "no option to just
                            add a punch, only edit a punch"). */}
                        {r.seg && r.last && (
                          <button onClick={() => setEditDay({ date: r.ds, seg: null })}
                            title="Add another punch for this day"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-brand)', display: 'inline-flex' }}>
                            <Plus size={14} />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {T && (
              <tfoot>
                <tr style={{ background: 'var(--wk-hover)', fontWeight: 700 }}>
                  <td colSpan={3} style={{ ...td, textAlign: 'left' }}>Totals</td>
                  <td style={{ ...td, color: T.deductedMin ? '#b45309' : 'var(--muted)' }}>{T.deductedMin ? `−${T.deductedMin}m` : '-'}</td>
                  <td style={td}></td>
                  <td style={td}>{hhmm(T.regMin + T.otMin + (T.dtMin || 0))}</td>
                  <td style={td}>{hhmm(T.regMin + T.otMin + (T.dtMin || 0))}</td>
                  <td style={td}></td>
                  <td style={td}>{hhmm(T.regMin)}</td>
                  <td style={td}>{hhmm(T.otMin)}</td>
                  <td style={td}>{T.dtMin ? hhmm(T.dtMin) : '-'}</td>
                  <td style={td}></td>
                  <td style={td}></td>
                  <td style={td}></td>
                  <td style={td}>{fmtM(T.totalPay)}</td>
                  <td style={td}></td>
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
              const rows = [
                [`Total Regular hours at ${fmtM(rate)}/hr`, hd(T.regMin), fmtM(T.regPay)],
                [`Total Overtime hours at ${fmtM(rate * 1.5)}/hr`, hd(T.otMin), fmtM(T.otPay)],
                ...(T.dtMin ? [[`Total Double-time hours at ${fmtM(rate * 2)}/hr`, hd(T.dtMin), fmtM(T.dtPay)]] : []),
                ['Totals', hd(T.regMin + T.otMin + (T.dtMin || 0)), fmtM(T.totalPay)],
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
            {!self && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="secondary-btn" onClick={async () => { const up = await ensureStepUp(); if (!up.ok) { if (!up.cancelled) toastErr?.('Identity check didn’t complete.'); return; } api.timeExportCsv(start, end, 'punches'); }} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> CSV</button>
              <button className={mgrAp ? 'secondary-btn' : 'primary-btn'} data-tour="pr-approve" onClick={approve} disabled={busy || !!fin}
                title={fin ? 'Period is finalized' : mgrAp ? `Approved by ${nameFor(mgrAp.by)} - click to re-approve after changes` : 'Step 1: manager sign-off'}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, ...(mgrAp ? { color: 'hsl(var(--color-green))', borderColor: 'hsl(var(--color-green))' } : {}) }}>
                <CheckCircle size={13} /> {busy ? '…' : mgrAp ? 'Approved' : 'Approve'}</button>
              {isAdmin && (fin
                ? <button className="secondary-btn" onClick={unfinalize} disabled={busy} title="HR: unlock this finalized period for corrections"
                    style={{ fontSize: 12.5 }}>Unlock</button>
                : <button className="secondary-btn" onClick={finalize} disabled={busy} title="Step 2 (HR): finalize for payroll and lock the period"
                    style={{ fontSize: 12.5, fontWeight: 700 }}>Finalize</button>)}
            </div>
            )}
          </div>
        </div>
      )}
      {T && (
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, fontStyle: 'italic' }}>
          Overtime rule: {ruleInput === 'ca' ? 'California - over 8h/day (1.5×), over 12h/day (2×), the 7th consecutive day, and over 40h/week'
            : ruleInput === 'federal' ? 'Federal - over 40 hours per week (1.5×)'
            : 'None - no US overtime premium applied'}. Set per employee above. Corrections keep the original punch on record.
        </p>
      )}

      {/* Three-signature sign-off. The Approve and Finalize buttons ARE the manager
          and HR signatures - each line auto-fills when that person acts. A line goes
          amber "changed since" if hours were edited after it was signed. */}
      {T && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
            The employee signs to attest the hours are accurate; the manager approves and HR finalizes for payroll. Period: {label}.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
            <SigLine label="Employee" sig={data.signed} nameFor={nameFor}
              action={self && !fin ? { label: data.signed ? 'Re-sign' : 'Sign & submit', onClick: signTimecard, busy } : null} />
            <SigLine label="Manager" sig={data.approval} nameFor={nameFor} pending="Approve to sign" />
            <SigLine label="HR" sig={data.finalized} nameFor={nameFor} pending="Finalize to sign" />
          </div>
        </div>
      )}

      {editDay && (
        <PunchEditModal day={editDay} email={email} busy={busy} setBusy={setBusy}
          categories={(data?.byCategory || []).map(c => c.category).filter(c => c && c !== 'Uncategorised')}
          onDone={() => { setEditDay(null); load(); }} onClose={() => setEditDay(null)}
          toastOk={toastOk} toastErr={toastErr} self={self} />
      )}
      {tour && <GuidedTour onClose={() => setTour(false)} steps={[
        { target: 'pr-sidebar', title: 'Start with the employee list',
          body: 'Everyone in this pay period. M = missing punches, E = exceptions - the red numbers are your to-do list each morning. Click a name to open their card.' },
        { target: 'pr-period', title: 'The pay period',
          body: 'Bi-weekly, Sunday to Saturday - the SAME calendar as SwipeClock (current period 7/26–8/8), so the two cards always cover identical days. Arrows move one period.' },
        { target: 'pr-table', title: 'The time card - same columns as SwipeClock',
          body: 'Date, In, Out, Deducted time, Category, Hours, Hrs/day, then the California split: Non-OT, OT (1.5×), OT 2×, and Wage. Times are rounded to the nearest 5 minutes exactly like SwipeClock; weekly total rows appear after each week.' },
        { target: 'pr-rounding', title: 'Rounded vs raw times',
          body: 'SwipeClock computes pay from rounded times but keeps the raw punch - so does Nexus. Tick this to peek at raw times. During the comparison week, leave the rounding setting ON so the numbers can match 1:1.' },
        { target: 'pr-edit', title: 'Fix punches here',
          body: 'The pencil on any row edits that punch (or adds one on an empty day) - set the real in/out, location, and job category. Originals stay on record with who changed what, like SwipeClock\'s audit log.' },
        { target: 'pr-summary', title: 'Totals, in both formats',
          body: 'Regular, overtime (1.5×), and double-time (2×) hours with wages - shown as clock time AND decimal ("58:30 (58.50)"), matching SwipeClock\'s summary, so payroll can key either format.' },
        { target: 'pr-approve', title: 'Two-step sign-off',
          body: 'Step 1 - the manager presses Approve when their person\'s card is right. Step 2 - HR presses Finalize: the period locks (no more edits, like SwipeClock\'s "finalized" periods) and payroll runs from it. Unlock reopens it if a correction is truly needed. CSV exports the punches for records.' },
      ]} />}
      <style>{`.pr-row:hover { background: var(--bg); } .pr-sidebar button:hover { background: var(--bg); }`}</style>
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
function FixedTimecard({ data, self, email, people, setEmail, nameFor, cur, fmtM, showRaw, setShowRaw, isAdmin, busy, setBusy, onPrev, onNext, onApprove, onFinalize, onUnfinalize, onSign, editDay, setEditDay, load, toastOk, toastErr, setWorkLogDay }) {
  useDisplayTz();   // re-render this card (and its time cells) when the tz switch flips
  const T = data.totals || {};
  const fin = data.finalized;
  const mgrAp = data.approval;
  const [openPunches, setOpenPunches] = useState({});   // date -> show every punch pair
  const [openBreaks, setOpenBreaks] = useState({});     // date -> show each break window
  const byDate = Object.fromEntries((data.days || []).map(d => [d.date, d]));
  const fixedDays = data.fixedDays || [];
  const monthLabel = data.periodStart ? new Date(data.periodStart + 'T00:00').toLocaleDateString([], { month: 'long', year: 'numeric' }) : '';
  const dow = (ds) => new Date(ds + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
  const th = { fontSize: 11.5, fontWeight: 600, color: 'var(--wk-dim)', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap' };
  const td = { fontSize: 12.5, padding: '6px 10px', textAlign: 'left', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' };
  const STATUS = {
    working: { label: 'Working', bg: 'var(--wk-brand-tint)', fg: 'var(--wk-brand)' },
    present: { label: 'Present', bg: 'hsla(var(--color-green),0.12)', fg: 'hsl(var(--color-green))' },
    late: { label: 'Late', bg: 'rgba(217,119,6,0.15)', fg: '#c2410c' },   // shift start passed, not clocked in yet (today only, no deduction)
    half: { label: 'Half day', bg: 'rgba(180,83,9,0.12)', fg: '#b45309' },
    absent: { label: 'Absent', bg: 'rgba(185,28,28,0.1)', fg: '#b91c1c' },
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
      await api.timeDecidePunchRequest(id, { status, note: note || '' });
      toastOk?.(status === 'approved' ? 'Punch added to the timecard.' : 'Request rejected.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not update the request.'); }
  };

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      {/* Toolbar - month nav (fixed pay is by calendar month, no work-week) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {self
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 160 }}>My Timecard</span>
          : <select className="form-input" value={email} onChange={e => setEmail(e.target.value)} style={{ fontSize: 13, minWidth: 180, fontWeight: 700 }}>
              {people.map(p => <option key={p.email} value={p.email}>{p.name}{p.pendingEdits ? ` (${p.pendingEdits} to review)` : ''}</option>)}
            </select>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button className="icon-btn" onClick={onPrev} style={{ padding: 6 }}><ChevronLeft size={16} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 130, textAlign: 'center' }}>{monthLabel}</span>
          <button className="icon-btn" onClick={onNext} style={{ padding: 6 }}><ChevronRight size={16} /></button>
        </div>
        <div style={{ flex: 1 }} />
        <TzSwitch />
        {/* No rounding toggle - salary pay is day-based, so times show exactly as punched. */}
      </div>

      {/* Fixed-pay strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontWeight: 700 }}>Fixed salary</span>
        {data.dept && <span><strong style={{ color: 'var(--ink)' }}>Department:</strong> {data.dept}</span>}
        <span><strong style={{ color: 'var(--ink)' }}>Salary:</strong> {fmtM(data.monthlySalary)}/mo</span>
        <span><strong style={{ color: 'var(--ink)' }}>Daily:</strong> {fmtM(data.dailyRate)} ({T.daysInMonth}d)</span>
        <span><strong style={{ color: 'var(--ink)' }}>Weekend OT:</strong> {fmtM(data.weekendOtAmount)}/day</span>
        {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}><CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
        {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}><CheckCircle size={12} /> Finalized · period locked</span>}
      </div>

      {self && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--wk-brand)', background: 'var(--wk-brand-tint)', borderRadius: 9, padding: '8px 12px', marginBottom: 10, fontWeight: 500 }}>
          <Pencil size={13} style={{ flexShrink: 0 }} /> Your pay is fixed at {fmtM(data.monthlySalary)}/month. A missed weekday deducts one day; each weekend day worked adds {fmtM(data.weekendOtAmount)}. Tap a time to change it, or "+ add" on a past day to log a missed punch - it goes to your approver.
        </div>
      )}
      {!data.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No salary set - set it on this person's profile (People &rarr; Edit &rarr; Payroll wage). Pay shows {fmtM(0)} until then.
        </div>
      )}

      {/* Day grid */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 14, background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
        <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--wk-hover)' }}>
              <th style={th}>Date</th><th style={th}>Day</th><th style={th}>In</th><th style={th}>Out</th>
              <th title="What was planned, done, and left pending that day" style={{ ...th, textAlign: 'center' }}>Work Log</th>
              <th style={{ ...th, textAlign: 'right' }}>Hours</th><th style={{ ...th, textAlign: 'right' }}>Break</th><th style={{ ...th, textAlign: 'right' }}>Effect on pay</th>
            </tr>
          </thead>
          <tbody>
            {fixedDays.map(fd => {
              const d = byDate[fd.date];
              const segs = d?.segments || [];
              const st = STATUS[fd.status] || STATUS.upcoming;
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
              const overBreak = dayBreak > 60;             // 60 min/day allowance
              const breakFg = dayBreak <= 0 ? 'var(--muted)' : overBreak ? '#b91c1c' : 'hsl(var(--color-green))';

              // Reasons/notes visible IN the card (not just on hover), employee AND HR.
              // Internal markers like "payroll edit" are filtered out (segReasons).
              const notes = segs.flatMap(segReasons);

              // Editable in/out cell for a single segment (or an expanded punch row).
              // The location dot links to the Locations map (only for viewers who can
              // reach it: HR/managers on someone else's card, or an admin on their own).
              const locateEmail = (!self || isAdmin) ? (data.email || '') : '';
              const inCell = (seg) => <InlineTime seg={seg} k="in" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={locateEmail} />;
              const outCell = (seg) => seg.out
                ? <InlineTime seg={seg} k="out" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} locateEmail={locateEmail} />
                : (self && fin) ? <span style={{ color: '#b91c1c', fontWeight: 700 }}>Missing</span>
                    : <button onClick={() => !fin && setEditDay({ date: fd.date, seg })} title={fin ? 'Locked' : 'Add the missing clock-out'} style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>;
              const addBtn = <button onClick={() => setEditDay({ date: fd.date, seg: null })} title={self ? 'Add a missing punch for this day - goes to your approver' : 'Add a punch for this day'} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand)', fontWeight: 600, font: 'inherit', opacity: 0.85 }}>+ add</button>;
              const statusPill = <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: st.bg, color: st.fg }}>{st.label}</span>;
              const breakCell = (
                <td style={{ ...td, textAlign: 'right' }}>
                  {dayBreak > 0
                    ? <button onClick={() => setOpenBreaks(o => ({ ...o, [fd.date]: !o[fd.date] }))} aria-expanded={breaksOpen}
                        title="Daily break allowance is 60 min. Click to see each break in/out."
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 700, color: breakFg, borderBottom: '1px dashed currentColor', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {hhmm(dayBreak)}{overBreak && <AlertTriangle size={11} />}
                      </button>
                    : <span style={{ color: 'var(--muted)' }}>-</span>}
                </td>
              );

              const rows = [];
              const rowBg = fd.isWeekend ? 'var(--mist)' : 'transparent';
              const firstSeg = segs[0];
              const lastSeg = segs[segs.length - 1];

              // ── One summary row per day: first clock-in, last clock-out, hours, break ──
              rows.push(
                <tr key={fd.date} style={{ background: rowBg }}>
                  <td style={{ ...td, fontWeight: 700 }}>{dow(fd.date)}</td>
                  <td style={td}>{statusPill}</td>
                  <td style={td}>
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
                  <td style={td}>
                    {!segs.length
                      ? <span style={{ color: 'var(--muted)' }}>-</span>
                      : multi
                        ? outCell(lastSeg)
                        : outCell(firstSeg)}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <WorkLogButton onClick={() => setWorkLogDay(fd.date)} title={`View the Work Log for ${dow(fd.date)}`} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{segs.length ? hhmm(d.workedMin) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                  {breakCell}
                  <td style={{ ...td, textAlign: 'right' }}>{effect(fd)}</td>
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
                      <td style={td}></td>
                      <td style={{ ...td, textAlign: 'right', color: 'var(--muted)' }}>{hhmm(seg.workedMin)}</td>
                      <td style={td}></td>
                      <td style={td}></td>
                    </tr>
                  );
                  if (edited) rows.push(
                    <tr key={fd.date + '-pr' + si} style={{ background: rBg }}>
                      <td style={td}></td><td style={td}></td>
                      <td colSpan={6} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b45309', fontStyle: 'italic', fontSize: 11.5, whiteSpace: 'normal' }}>
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
                  </tr>
                );
              }

              // ── Expanded: each break window (clock-out -> next clock-in + duration) ──
              if (breaksOpen && dayBreak > 0) rows.push(
                <tr key={fd.date + '-br'} style={{ background: 'var(--wk-hover)' }}>
                  <td colSpan={8} style={{ ...td, whiteSpace: 'normal', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: breakFg, marginRight: 10 }}>Breaks - {hhmm(dayBreak)} {overBreak ? '(over the 60 min allowance)' : '(within 60 min)'}</span>
                    {breaks.map((b, i) => (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 9px', margin: '2px 6px 2px 0', fontSize: 11.5 }}>
                        {t12(b.start)} <ArrowRight size={10} style={{ opacity: 0.6 }} /> {t12(b.end)}
                        <span style={{ fontWeight: 700, marginLeft: 3 }}>({b.min}m)</span>
                      </span>
                    ))}
                    {offClockGaps > 0 && <span style={{ color: 'var(--muted)', fontStyle: 'italic', marginLeft: 4 }}>· {offClockGaps} longer gap{offClockGaps === 1 ? '' : 's'} off the clock (not counted as break)</span>}
                  </td>
                </tr>
              );

              // ── Day-level reasons: shown when the day is COLLAPSED. When expanded,
              //    each edited punch shows its own reason inline above instead. ──
              if (notes.length && !(multi && punchesOpen)) rows.push(
                <tr key={fd.date + '-notes'} style={{ background: rowBg }}>
                  <td colSpan={8} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b45309', fontStyle: 'italic', fontSize: 11.5, whiteSpace: 'normal' }}>
                    <Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{notes.join('  ·  ')}
                  </td>
                </tr>
              );

              // ── Pending add/remove requests on this day - HR approves/rejects here ──
              (reqsByDate[fd.date] || []).forEach(r => {
                const isIn = r.punchKind === 'in';
                const kindLabel = r.action === 'remove' ? 'Remove a punch' : `Add clock-${isIn ? 'in' : 'out'}`;
                rows.push(
                  <tr key={fd.date + '-req-' + r.id} style={{ background: 'rgba(180,83,9,0.07)' }}>
                    <td style={td}></td>
                    <td style={td}><span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: 'rgba(180,83,9,0.16)', color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={10} /> Request</span></td>
                    <td style={td}>{r.action === 'add' && isIn ? <span style={{ color: '#b45309', fontWeight: 700 }}>{t12(r.at)}</span> : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                    <td style={td}>{r.action === 'add' && !isIn ? <span style={{ color: '#b45309', fontWeight: 700 }}>{t12(r.at)}</span> : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                    <td style={td}></td>
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
                  </tr>
                );
                rows.push(
                  <tr key={fd.date + '-reqr-' + r.id} style={{ background: 'rgba(180,83,9,0.07)' }}>
                    <td colSpan={8} style={{ ...td, borderTop: 'none', paddingTop: 0, color: '#b45309', fontSize: 11.5, whiteSpace: 'normal' }}>
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

      {/* Monthly pay summary */}
      <div style={{ marginTop: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 300, border: '1px solid var(--wk-line2)', borderRadius: 14, overflow: 'hidden', background: 'var(--card)', boxShadow: 'var(--wk-shadow)' }}>
          {(() => {
            const rows = [
              ['Monthly salary', fmtM(T.monthlySalary)],
              [`Missed days (${T.missedFullDays} full${T.missedHalfDays ? `, ${T.missedHalfDays} half` : ''})`, T.deduction ? `−${fmtM(T.deduction)}` : fmtM(0)],
              [`Weekend overtime (${T.weekendDaysWorked} day${T.weekendDaysWorked === 1 ? '' : 's'})`, T.weekendBonus ? `+${fmtM(T.weekendBonus)}` : fmtM(0)],
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
              <button className={mgrAp ? 'secondary-btn' : 'primary-btn'} onClick={onApprove} disabled={busy || !!fin}
                title={fin ? 'Period is finalized' : mgrAp ? 'Approved - click to re-approve after changes' : 'Step 1: manager sign-off'}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, ...(mgrAp ? { color: 'hsl(var(--color-green))', borderColor: 'hsl(var(--color-green))' } : {}) }}>
                <CheckCircle size={13} /> {busy ? '…' : mgrAp ? 'Approved' : 'Approve'}</button>
              {isAdmin && (fin
                ? <button className="secondary-btn" onClick={onUnfinalize} disabled={busy} style={{ fontSize: 12.5 }}>Unlock</button>
                : <button className="secondary-btn" onClick={onFinalize} disabled={busy} style={{ fontSize: 12.5, fontWeight: 700 }}>Finalize</button>)}
            </div>
          )}
        </div>
      </div>

      {/* Three-signature sign-off (same as hourly) */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
          The employee signs to attest attendance; the manager approves and HR finalizes for payroll. Month: {monthLabel}.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <SigLine label="Employee" sig={data.signed} nameFor={nameFor} action={self && !fin ? { label: data.signed ? 'Re-sign' : 'Sign & submit', onClick: onSign, busy } : null} />
          <SigLine label="Manager" sig={data.approval} nameFor={nameFor} pending="Approve to sign" />
          <SigLine label="HR" sig={data.finalized} nameFor={nameFor} pending="Finalize to sign" />
        </div>
      </div>

      {editDay && (
        <PunchEditModal day={editDay} email={email} busy={busy} setBusy={setBusy}
          onDone={() => { setEditDay(null); load(); }} onClose={() => setEditDay(null)}
          toastOk={toastOk} toastErr={toastErr} self={self} />
      )}
    </div>
  );
}

function SigLine({ label, sig, nameFor, action, pending }) {
  const done = sig && sig.at;
  const who = done ? (sig.name || (nameFor && nameFor(sig.by)) || (sig.by || '').split('@')[0].replace(/\./g, ' ')) : '';
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px', background: 'var(--card)', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label} signature</div>
      {done ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: sig.stale ? '#b45309' : 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <CheckCircle size={14} /> {who}
          </span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(sig.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          {sig.stale && <span title="Hours changed after this signature - it needs to be redone" style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: 'rgba(180,83,9,0.12)', padding: '2px 8px', borderRadius: 999 }}>changed since</span>}
        </div>
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>{action ? 'Unsigned' : (pending || 'Pending')}</span>
      )}
      {action && (
        <button className="primary-btn" onClick={action.onClick} disabled={action.busy}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle size={13} /> {action.busy ? '…' : action.label}
        </button>
      )}
    </div>
  );
}

function InlineTime({ seg, k, showRaw, locked, onSaved, toastErr, self, locateEmail }) {
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
  const geo = seg.geo || '';
  const mini = { border: 'none', background: 'none', cursor: 'pointer', padding: '0 2px', fontWeight: 800, fontSize: 12, lineHeight: 1 };
  const dotColor = geo === 'in_fence' ? 'hsl(var(--color-green))' : geo === 'out_of_fence' ? '#b91c1c' : 'var(--line-strong,var(--line))';
  // Clicking the location dot jumps to the Locations map, focused on this person.
  const openMap = (e) => { e.stopPropagation(); if (!locateEmail) return; sessionStorage.setItem('nexus:locateEmail', locateEmail); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'locations' } })); };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {geo && (locateEmail
        ? <button onClick={openMap} aria-label="See on map" title="See this person's last location on the map"
            style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, padding: 0, cursor: 'pointer', border: 'none', background: dotColor, boxShadow: `0 0 0 2px var(--card), 0 0 0 3px ${dotColor}` }} />
        : <span title={geo === 'in_fence' ? 'On site' : geo === 'out_of_fence' ? 'Off site' : 'No location'}
            style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: dotColor }} />)}
      <button onClick={() => { if (!id) return; setVal(utcToInput(raw)); setEditing(true); }}
        title={id ? (self ? 'Propose a new time - goes to your approver; pay unchanged until approved' : 'Click to edit this punch time - the original stays on record') : ''}
        style={{ background: 'none', border: 'none', padding: 0, cursor: id ? 'pointer' : 'default', font: 'inherit', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ borderBottom: id ? `1px dashed ${self ? 'var(--wk-brand)' : 'var(--line-strong,var(--line))'}` : '1px dashed var(--line-strong,var(--line))', color: self && id ? 'var(--wk-brand)' : undefined, fontWeight: self && id ? 600 : undefined }}>{t12(rounded)}</span>
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
  const tz = new Date().getTimezoneOffset();
  useEffect(() => {   // Escape closes the modal (keyboard parity with the backdrop click)
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // What's missing on this day and therefore addable (self can only ADD, not overwrite).
  const needIn = !seg?.inId, needOut = !seg?.outId;

  async function save() {
    // A clock-out must be after the clock-in it pairs with. With the out now
    // defaulting to the in-time, leaving it unchanged trips this - forcing the real
    // time in - and it also catches a time accidentally typed into the reason field.
    const inRef = (seg?.inId && !needIn) ? utcToInput(seg.in) : inAt;
    if (needOut && inRef && new Date(outAt) <= new Date(inRef)) {
      toastErr?.('Set the clock-out time - it has to be after the clock-in.'); return;
    }
    // Employees don't write the timecard directly - a missing punch becomes an
    // approver-confirmed REQUEST. Nothing moves on pay until it's approved.
    if (self) {
      if (!reason.trim()) { toastErr?.('Add a reason so your approver can confirm it.'); return; }
      setBusy(true);
      try {
        const adds = [];
        if (needIn) adds.push(['in', inAt]);
        if (needOut) adds.push(['out', outAt]);
        for (const [kind, at] of adds) {
          await api.timePunchRequestCreate({ action: 'add', punch_kind: kind, at: inputToUtc(at), tz_offset_min: tz, reason: reason.trim() });
        }
        toastOk?.("Request sent to your approver - nothing changes on your timecard until they approve it.");
        window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));   // refresh the request stack
        onDone();
      } catch (e) { toastErr?.(e?.message || 'Could not send the request.'); }
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      // Edit existing in-punch, or add one
      if (seg?.inId) {
        if (utcToInput(seg.in) !== inAt) await api.timeAdjustPunch(seg.inId, { at: inputToUtc(inAt) });
        // Reassign location (work site) on the in-punch if it changed.
        if (siteId !== (seg.workSiteId || '')) await api.timeAdjustPunch(seg.inId, { work_site_id: siteId });
        // Job-costing category on the in-punch.
        if (cat !== (seg.category || '')) await api.timeAdjustPunch(seg.inId, { category: cat });
      } else {
        await api.timeAddPunch({ employee_email: email, kind: 'in', at: inputToUtc(inAt), tz_offset_min: tz, note: 'payroll edit' });
      }
      // Edit existing out-punch, or add one
      if (seg?.outId) { if (utcToInput(seg.out) !== outAt) await api.timeAdjustPunch(seg.outId, { at: inputToUtc(outAt) }); }
      else await api.timeAddPunch({ employee_email: email, kind: 'out', at: inputToUtc(outAt), tz_offset_min: tz, note: 'payroll edit' });
      toastOk?.('Timecard updated - original times stay on record.'); onDone();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function removeOut() {
    if (!seg?.outId) return;
    setBusy(true);
    try { await api.timeAdjustPunch(seg.outId, { void: true }); toastOk?.('Punch voided.'); onDone(); }
    catch (e) { toastErr?.(e?.message || 'Could not void.'); }
    setBusy(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={self ? 'Request a missing punch' : seg ? 'Edit punch' : 'Add punch'}
        style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 400, padding: 20, boxShadow: '0 24px 70px rgba(17,24,39,0.30)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{self ? 'Request a missing punch' : seg ? 'Edit punch' : 'Add punch'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {/* In self mode only the MISSING punch is editable - an existing time stays
              shown (disabled) for context but can't be silently overwritten here. */}
          {(!self || needIn) && <label style={{ fontSize: 11, color: 'var(--muted)' }}>Clock in time<input autoFocus={self && needIn} type="datetime-local" className="form-input" value={inAt} disabled={self && !needIn} onChange={e => setInAt(e.target.value)} style={{ width: '100%', fontSize: 13, opacity: self && !needIn ? 0.6 : 1 }} /></label>}
          {(!self || needOut) && <label style={{ fontSize: 11, color: 'var(--muted)' }}>Clock out time<input autoFocus={self && needOut && !needIn} type="datetime-local" className="form-input" value={outAt} disabled={self && !needOut} onChange={e => setOutAt(e.target.value)} style={{ width: '100%', fontSize: 13, opacity: self && !needOut ? 0.6 : 1 }} /></label>}
          {self && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Reason (sent to your approver - not the time)
              <input className="form-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="Why you're adding it - e.g. forgot to clock out" style={{ width: '100%', fontSize: 13 }} />
            </label>
          )}
          {!self && seg?.inId && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Location (work site)
              <select className="form-input" value={siteId} onChange={e => setSiteId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="">- No location -</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Reassigning marks the punch as on-site at the chosen location.</span>
            </label>
          )}
          {!self && seg?.inId && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Category (job / cost code)
              <input list="pr-cats" className="form-input" value={cat} onChange={e => setCat(e.target.value)}
                placeholder="e.g. Operations-GS" style={{ width: '100%', fontSize: 13 }} />
              <datalist id="pr-cats">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </label>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {!self && seg?.outId && <button onClick={removeOut} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>Void out-punch</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy}>{busy ? '…' : self ? 'Send request' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
