import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, X, Loader2, CheckCircle, Download, AlertTriangle, MapPin, PlayCircle } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { useWorkSites } from '../lib/queries';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { useRole } from '../contexts/RoleContext';
import GuidedTour from './GuidedTour';

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
const money = (n) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const t12 = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase() : '-';
const utcToInput = (iso) => { const d = new Date(iso + 'Z'); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const inputToUtc = (v) => new Date(v).toISOString().slice(0, 19);

function periodStartFor(date) {
  const sun = new Date(date); sun.setHours(0, 0, 0, 0);
  sun.setDate(sun.getDate() - sun.getDay());                   // Sunday of this week
  const idx = Math.floor((sun.getTime() - ANCHOR) / (14 * DAY));
  return new Date(ANCHOR + idx * 14 * DAY);
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

export default function PayrollTimecard({ toastOk, toastErr, selfMode = false }) {
  const self = selfMode;   // employee viewing their OWN timecard (from /my-payroll)
  const [people, setPeople] = useState([]);
  const [email, setEmail] = useState('');
  const [pStart, setPStart] = useState(() => periodStartFor(new Date()));
  const [data, setData] = useState(null);
  const [rateInput, setRateInput] = useState('');
  const [ruleInput, setRuleInput] = useState('ca');   // ca | federal | none
  const [editDay, setEditDay] = useState(null);   // { date, seg? }
  const [busy, setBusy] = useState(false);
  const [stepLocked, setStepLocked] = useState(false);   // payroll $ needs a fresh step-up
  const [exceptions, setExceptions] = useState([]);      // per-employee missing/exception counts (sidebar)
  const [showRaw, setShowRaw] = useState(false);         // SwipeClock's "Show Unrounded Times"
  const [tour, setTour] = useState(false);               // Simulate walkthrough
  const { can } = useRole();
  const isAdmin = can('administrator');

  const start = isoDate(pStart);
  const end = isoDate(pStart.getTime() + 13 * DAY);
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => isoDate(pStart.getTime() + i * DAY)), [pStart]);

  // employee list (scoped) for the picker
  useEffect(() => {
    if (self) return;   // employee self-view has no picker / team list
    api.timeTeam(start, end).then(r => {
      const list = (r.rows || []).map(x => ({ email: x.email, name: x.name || x.email }));
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

  const load = useCallback(() => {
    if (self) {
      // Employee's own timecard - same shape as the HR card, no step-up needed for
      // one's own pay (like a payslip). /my-payroll keys off the period start.
      setData(null);
      api.timeMyPayroll(start).then(d => { setStepLocked(false); setData(d); setRateInput(d.rateSet ? String(d.rate) : ''); setRuleInput(d.overtimeRule || 'ca'); })
        .catch(e => { setData(null); toastErr?.(e?.message || 'Could not load your timecard.'); });
      return;
    }
    if (!email) return;
    setData(null);
    api.timePayroll(email, start, end).then(d => { setStepLocked(false); setData(d); setRateInput(d.rateSet ? String(d.rate) : ''); setRuleInput(d.overtimeRule || 'ca'); })
      .catch(e => {
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

  const byDate = useMemo(() => Object.fromEntries((data?.days || []).map(d => [d.date, d])), [data]);
  const weekTotals = useMemo(() => {
    const w = {};
    (data?.days || []).forEach(d => { (w[d.weekStart] ||= { min: 0 }).min += d.workedMin; });
    return w;
  }, [data]);
  const rate = data?.rate || 0;

  async function saveRate() {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) toastErr?.('Identity check didn’t complete.'); return; }
    setBusy(true);
    try { await api.timePayrollRate({ email, hourly_rate: parseFloat(rateInput) || 0, overtime_rule: ruleInput }); toastOk?.('Pay rate saved.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not save rate.'); }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try { await api.timeApprove({ email, start, end }); toastOk?.('Timecard approved - the employee is notified.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not approve.'); }
    setBusy(false);
  }
  async function signTimecard() {
    setBusy(true);
    try { await api.timeSignMyTimecard(start); toastOk?.('Timecard signed - thank you.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not sign.'); }
    setBusy(false);
  }

  const shift = (n) => setPStart(new Date(pStart.getTime() + n * 14 * DAY));
  const label = `${pStart.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' })} – ${new Date(pStart.getTime() + 13 * DAY).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' })}`;
  const T = data?.totals;
  const fin = data?.finalized;         // HR finalization - the period is LOCKED
  const mgrAp = data?.approval;        // manager approval (step 1 of 2)
  const nameFor = (em) => people.find(p => p.email === (em || '').toLowerCase())?.name || em || '';

  async function finalize() {
    if (!await dialog.confirm(`Finalize ${nameFor(email)}'s timecard for ${label}? This locks all time records for the period - edits will need an unlock.`, { title: 'Finalize timecard', confirmText: 'Finalize', danger: true })) return;
    setBusy(true);
    try { await api.timeFinalize({ email, start, end }); toastOk?.('Timecard finalized - the period is locked.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not finalize.'); }
    setBusy(false);
  }
  async function unfinalize() {
    if (!await dialog.confirm(`Unlock ${nameFor(email)}'s finalized timecard for ${label}? Edits become possible again; re-finalize when done.`, { title: 'Unlock period', confirmText: 'Unlock' })) return;
    setBusy(true);
    try { await api.timeUnfinalize({ email, start, end }); toastOk?.('Period unlocked.'); load(); }
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
      const notes = segs.map(s => s.note).filter(Boolean);
      if (notes.length) rows.push({ type: 'note', text: notes.join(' · ') });
    }
  });
  if (prevWeek) rows.push({ type: 'wk', week: prevWeek });

  const dow = (ds) => new Date(ds + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });

  const exByEmail = Object.fromEntries(exceptions.map(e => [e.email, e]));
  const sidebar = (exceptions.length ? exceptions : people.map(p => ({ ...p, missing: 0, exceptions: 0 })));

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', fontFamily: 'var(--wk-font)' }}>
      {/* Employee sidebar - who has missing punches / exceptions this period */}
      {!self && (
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
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {self
          ? <span style={{ fontSize: 15, fontWeight: 800, minWidth: 180 }}>My Timecard</span>
          : <select className="form-input" value={email} onChange={e => setEmail(e.target.value)} style={{ fontSize: 13, minWidth: 180, fontWeight: 700 }} title="Also selectable from the sidebar">
              {people.map(p => <option key={p.email} value={p.email}>{p.name}{exByEmail[p.email]?.missing ? ` (${exByEmail[p.email].missing} missing)` : ''}</option>)}
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
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Rate $/hr</span>
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
          <span><strong style={{ color: 'var(--ink)' }}>Pay rate:</strong> {money(rate)}/hr</span>
          <span><strong style={{ color: 'var(--ink)' }}>OT rule:</strong> {ruleInput === 'ca' ? 'California' : ruleInput === 'federal' ? 'Federal' : 'None'}</span>
          {mgrAp && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', fontWeight: 700 }}>
            <CheckCircle size={12} /> Manager approved · {nameFor(mgrAp.by)}</span>}
          {fin && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontWeight: 700 }}>
            <CheckCircle size={12} /> Finalized · {nameFor(fin.by)} - period locked</span>}
        </div>
      )}
      {!stepLocked && !data?.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No pay rate set for this employee - wages show $0 until you set one.
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
                  <td colSpan={15} style={{ ...td, textAlign: 'center', fontWeight: 700, color: 'var(--wk-brand)', fontSize: 12 }}>
                    Total hours clocked for week of {new Date(r.week + 'T00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric' })} to {new Date(new Date(r.week + 'T00:00').getTime() + 6 * DAY).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}: {hhmm(weekTotals[r.week]?.min || 0)}
                  </td>
                </tr>
              ) : r.type === 'note' ? (
                <tr key={i}>
                  <td colSpan={15} style={{ ...td, textAlign: 'left', borderTop: 'none', paddingTop: 0, color: 'var(--muted)', fontStyle: 'italic', fontSize: 11.5 }}>
                    <Pencil size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />{r.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className="pr-row">
                  <td style={{ ...td, textAlign: 'left', fontWeight: r.first === undefined ? 400 : 700, color: r.seg ? 'var(--ink)' : 'var(--muted)' }}>
                    {r.first === false ? '' : dow(r.ds)}
                  </td>
                  <td style={{ ...td, textAlign: 'left' }}>{r.seg ? <InlineTime seg={r.seg} k="in" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} /> : '-'}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    {r.seg ? (r.seg.out
                      ? <InlineTime seg={r.seg} k="out" showRaw={showRaw} locked={!!fin} onSaved={load} toastErr={toastErr} self={self} />
                      : <button onClick={() => !fin && !self && setEditDay({ date: r.ds, seg: r.seg })} title={fin ? 'Period finalized - locked' : self ? 'Use the Clock tab to add a missing punch' : 'Add the missing clock-out'}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: fin ? 'default' : 'pointer', color: '#b91c1c', fontWeight: 700, font: 'inherit' }}>Missing</button>) : '-'}
                  </td>
                  <td style={{ ...td, color: r.seg?.deductedMin ? '#b45309' : 'var(--muted)' }}>{r.seg?.deductedMin ? `−${r.seg.deductedMin}m` : '-'}</td>
                  <td style={{ ...td, textAlign: 'left', color: r.seg?.category ? 'var(--ink)' : 'var(--muted)' }}>{r.seg?.category || '-'}</td>
                  <td style={td}>{r.seg ? hhmm(r.seg.workedMin) : '-'}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{r.seg && byDate[r.ds]
                    ? (r.last ? hhmm(byDate[r.ds].workedMin) : '↓')
                    : ''}</td>
                  <td style={td}>{r.seg?.regMin ? hhmm(r.seg.regMin) : '-'}</td>
                  <td style={{ ...td, color: r.seg?.otMin ? '#b45309' : 'var(--muted)', fontWeight: r.seg?.otMin ? 700 : 400 }}>{r.seg?.otMin ? hhmm(r.seg.otMin) : '-'}</td>
                  <td style={{ ...td, color: r.seg?.dtMin ? '#b91c1c' : 'var(--muted)', fontWeight: r.seg?.dtMin ? 700 : 400 }}>{r.seg?.dtMin ? hhmm(r.seg.dtMin) : '-'}</td>
                  <td style={{ ...td, textAlign: 'left' }}><LocCell seg={r.seg} /></td>
                  <td style={{ ...td, textAlign: 'left', color: 'var(--muted)' }}>{r.seg ? (data?.dept || '-') : '-'}</td>
                  <td style={{ ...td, color: 'var(--muted)' }}>{r.seg ? `${money(rate)}/hr` : '-'}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{r.seg ? money(r.seg.amount) : '-'}</td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    {!self && !fin && (
                      <button onClick={() => setEditDay({ date: r.ds, seg: r.seg })}
                        title={r.seg ? 'Edit punch' : 'Add punch'}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}>
                        {r.seg ? <Pencil size={13} /> : <Plus size={14} />}
                      </button>
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
                  <td style={td}>{hhmm(T.regMin)}</td>
                  <td style={td}>{hhmm(T.otMin)}</td>
                  <td style={td}>{T.dtMin ? hhmm(T.dtMin) : '-'}</td>
                  <td style={td}></td>
                  <td style={td}></td>
                  <td style={td}></td>
                  <td style={td}>{money(T.totalPay)}</td>
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
                [`Total Regular hours at ${money(rate)}/hr`, hd(T.regMin), money(T.regPay)],
                [`Total Overtime hours at ${money(rate * 1.5)}/hr`, hd(T.otMin), money(T.otPay)],
                ...(T.dtMin ? [[`Total Double-time hours at ${money(rate * 2)}/hr`, hd(T.dtMin), money(T.dtPay)]] : []),
                ['Totals', hd(T.regMin + T.otMin + (T.dtMin || 0)), money(T.totalPay)],
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
                  <span style={{ textAlign: 'right', fontWeight: 700 }}>{money(c.pay)}</span>
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
          toastOk={toastOk} toastErr={toastErr} />
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
    </div>
  );
}

const t12s = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(' ', '').toLowerCase() : '';

// A punch time you can edit right in the sheet (SwipeClock-style): click the
// time → it becomes an input, Enter/blur saves via the audited adjust endpoint.
// Shows the geo dot (green in-fence / red off-site) and, when "Show unrounded
// times" is on, the raw seconds-precision time in small italics beside it -
// exactly how SwipeClock renders its unrounded overlay.
// One signature line in the sign-off block. `sig` is the backend sign-off record
// ({by, at, name?, stale}); `action` (employee only) shows the Sign button;
// `pending` is the hint shown to others before that party has acted.
function SigLine({ label, sig, nameFor, action, pending }) {
  const done = sig && sig.at;
  const who = done ? (sig.name || (nameFor && nameFor(sig.by)) || (sig.by || '').split('@')[0].replace(/\./g, ' ')) : '';
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--card)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 7 }}>{label} signature</div>
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
          style={{ marginTop: 10, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <CheckCircle size={13} /> {action.busy ? '…' : action.label}
        </button>
      )}
    </div>
  );
}

function InlineTime({ seg, k, showRaw, locked, onSaved, toastErr, self }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const punchId = k === 'in' ? seg?.inId : seg?.outId;   // always available (for approve/reject)
  const id = (locked ? '' : punchId);                    // editable id (blank when locked)
  const raw = k === 'in' ? seg?.in : seg?.out;
  const rounded = k === 'in' ? (seg?.inR || seg?.in) : (seg?.outR || seg?.out);
  const pendingAt = k === 'in' ? seg?.inPendingAt : seg?.outPendingAt;
  const pendReason = k === 'in' ? seg?.inEditReason : seg?.outEditReason;
  const isPending = (k === 'in' ? seg?.inEditStatus : seg?.outEditStatus) === 'pending' && pendingAt;
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
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button onClick={() => { if (!id) return; setVal(utcToInput(raw)); setEditing(true); }}
        title={id ? (self ? 'Propose a new time - goes to your approver; pay unchanged until approved' : 'Click to edit this punch time - the original stays on record') : ''}
        style={{ background: 'none', border: 'none', padding: 0, cursor: id ? 'pointer' : 'default', font: 'inherit', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {geo && <span title={geo === 'in_fence' ? 'On site' : geo === 'out_of_fence' ? 'Off site' : 'No location'}
          style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: geo === 'in_fence' ? 'hsl(var(--color-green))' : geo === 'out_of_fence' ? '#b91c1c' : 'var(--line-strong,var(--line))' }} />}
        <span style={{ borderBottom: id ? `1px dashed ${self ? 'var(--wk-brand)' : 'var(--line-strong,var(--line))'}` : '1px dashed var(--line-strong,var(--line))', color: self && id ? 'var(--wk-brand)' : undefined, fontWeight: self && id ? 600 : undefined }}>{t12(rounded)}</span>
        {self && id && <Pencil size={10} style={{ opacity: 0.7, flexShrink: 0, color: 'var(--wk-brand)' }} />}
        {showRaw && <span style={{ fontSize: 10.5, fontStyle: 'italic', color: 'var(--muted)' }}>{t12s(raw)}</span>}
      </button>
      {isPending && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: '#b45309', fontWeight: 700 }}
          title={`${self ? 'Your proposed time' : 'Proposed by employee'}${pendReason ? ': ' + pendReason : ''} - not counted until approved`}>
          &rarr; {t12(pendingAt)} <span style={{ fontStyle: 'italic' }}>pending</span>
          {!self && !locked && punchId && (
            <>
              <button title="Approve this time" style={{ ...mini, color: 'hsl(var(--color-green))' }}
                onClick={async () => { try { await api.timePunchEditDecide(punchId, { status: 'approved' }); onSaved?.(); } catch (e) { toastErr?.(e?.message || 'Could not approve.'); } }}>&#10003;</button>
              <button title="Reject this time" style={{ ...mini, color: '#b91c1c' }}
                onClick={async () => { const note = await dialog.prompt('', { title: 'Reject edit', message: 'Sent to the employee.', placeholder: 'Reason (optional)', confirmText: 'Reject', danger: true }); if (note === null) return; try { await api.timePunchEditDecide(punchId, { status: 'rejected', note: note || '' }); onSaved?.(); } catch (e) { toastErr?.(e?.message || 'Could not reject.'); } }}>&#10007;</button>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function PunchEditModal({ day, email, categories = [], busy, setBusy, onDone, onClose, toastOk, toastErr }) {
  const seg = day.seg;
  const [inAt, setInAt] = useState(seg?.in ? utcToInput(seg.in) : `${day.date}T09:00`);
  const [outAt, setOutAt] = useState(seg?.out ? utcToInput(seg.out) : `${day.date}T17:00`);
  const { data: sites = [] } = useWorkSites();
  const [siteId, setSiteId] = useState(seg?.workSiteId || '');
  const [cat, setCat] = useState(seg?.category || '');
  const tz = new Date().getTimezoneOffset();

  async function save() {
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
      <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 400, padding: 20, boxShadow: '0 24px 70px rgba(17,24,39,0.30)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{seg ? 'Edit punch' : 'Add punch'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>Clock in<input type="datetime-local" className="form-input" value={inAt} onChange={e => setInAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>Clock out<input type="datetime-local" className="form-input" value={outAt} onChange={e => setOutAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          {seg?.inId && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Location (work site)
              <select className="form-input" value={siteId} onChange={e => setSiteId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="">- No location -</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Reassigning marks the punch as on-site at the chosen location.</span>
            </label>
          )}
          {seg?.inId && (
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>Category (job / cost code)
              <input list="pr-cats" className="form-input" value={cat} onChange={e => setCat(e.target.value)}
                placeholder="e.g. Operations-GS" style={{ width: '100%', fontSize: 13 }} />
              <datalist id="pr-cats">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </label>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {seg?.outId && <button onClick={removeOut} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'var(--wk-font)' }}>Void out-punch</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy}>{busy ? '…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
