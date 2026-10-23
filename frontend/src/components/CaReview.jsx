// California Review (Neil, Oct 18 2026; reworked for HR - Charmi, Oct 20) -
// People > Time > Payroll, HR only. An automated check of the pay period for
// people who WORK IN CALIFORNIA (backend/ca_review.py + work_state.py, off the
// same timecard engine): meal breaks, 7th-day and double time, over-16-hour
// days, split shifts, reporting time, the state minimum wage, and manual time
// with no reason.
//   * Counts by type at the top (click one to show only that type).
//   * Grouped by person; each flag in plain words: what happened, what it
//     means (the minutes and dollars worked out), and what HR can do - Pay
//     Meal Premium / Already Handled / Adjust Time Sheet / Resolve with Note.
//   * A premium already on the time sheet reads as handled by itself, and a
//     resolved flag opens again when the facts behind it change.
//   * People on the California rule whose work state Nexus cannot tell are
//     listed under Work State Unknown - set it, and they are checked.
// Employees never see any of this (the routes are HR only).
import { useState, useCallback, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, RefreshCw, Scale, SlidersHorizontal, MapPinOff, Check } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { Spinner, ErrorBanner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { Modal } from '../tasks/components';
import { dialog } from '../ui/dialog';

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const KIND_COLOR = {
  meal_missed: '#b45309', meal_short: '#b45309', meal_late: '#b45309', missed_break_reported: '#b45309',
  min_wage: '#b91c1c', seventh_day: '#c2410c', dt_missing: '#c2410c', over16: '#c2410c',
  split_shift: '#0369a1', reporting: '#0369a1', manual_time: '#64748b', not_signed: '#64748b',
};
const KIND_LABEL = {
  meal_missed: 'Meal Missed', meal_short: 'Meal Short', meal_late: 'Meal Late',
  missed_break_reported: 'Missed Break Reported', not_signed: 'Not Signed Yet', seventh_day: '7th Day',
  dt_missing: 'Double Time', over16: 'Over 16 Hours', split_shift: 'Split Shift', reporting: 'Reporting Time',
  min_wage: 'Minimum Wage', manual_time: 'Manual Time',
};
const kindOf = (f) => f.kind || f.rule;
const kindLabel = (f) => KIND_LABEL[kindOf(f)] || f.ruleLabel || 'Flag';
const PREMIUM_LABEL = { meal: 'Pay Meal Premium', rest: 'Pay Rest Premium' };

export default function CaReview({ onOpenTimecard, toastOk, toastErr }) {
  const [anchor, setAnchor] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stepLocked, setStepLocked] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [only, setOnly] = useState('');
  const [closed, setClosed] = useState({});
  const [unknownOpen, setUnknownOpen] = useState(false);

  const run = useCallback(async (at = anchor) => {
    setLoading(true); setError(''); setStepLocked(false);
    try {
      const r = await api.caReview(at);
      setData(r); setAnchor(r?.period?.start || at);
    } catch (e) {
      if (isStepUpRequired(e)) setStepLocked(true);
      else setError(e?.message || 'The California Review could not run.');
    } finally { setLoading(false); }
  }, [anchor]);

  async function act(f, fn, ok, fail) {
    setBusyKey(f.email + f.key);
    try { await fn(); toastOk?.(ok); await run(anchor); }
    catch (e) { toastErr?.(e?.message || fail); }
    setBusyKey('');
  }
  async function resolveWithNote(f) {
    const note = await dialog.prompt(`${f.what || f.reason}\n\nHow was this handled?`,
      { title: 'Resolve with Note', confirmText: 'Resolve', required: true, multiline: true });
    if (!note) return;
    act(f, () => api.caReviewResolve({ email: f.email, periodStart: f.periodStart, key: f.key, note }),
      'Flag resolved.', 'Could not resolve the flag.');
  }
  function alreadyHandled(f) {
    act(f, () => api.caReviewResolve({ email: f.email, periodStart: f.periodStart, key: f.key, note: 'Already handled' }),
      'Marked as already handled.', 'Could not resolve the flag.');
  }
  async function payPremium(f) {
    const kind = f.premiumKind;
    const day = f.premiumDate || f.date;
    const ok = await dialog.confirm(
      `Add a ${kind === 'meal' ? 'Meal' : 'Rest'} Premium for ${f.name} on ${formatDate(day)}? It pays 1 hour at their regular rate on this time sheet.`,
      { title: PREMIUM_LABEL[kind], confirmText: 'Add Premium' });
    if (!ok) return;
    act(f, () => api.breakPremiumAdd({ email: f.email, date: day, kind, note: 'California Review' }),
      'Premium added to the time sheet.', 'Could not add the premium.');
  }
  function reopen(f) {
    act(f, () => api.caReviewReopen({ email: f.email, periodStart: f.periodStart, key: f.key }),
      'Flag reopened.', 'Could not reopen the flag.');
  }

  const P = data?.period;
  const all = useMemo(() => data?.rows || [], [data]);
  const resolvedCount = all.filter(r => r.status === 'resolved').length;
  const summary = data?.summary || [];
  const people = useMemo(() => {
    const visible = all.filter(r => (showResolved || r.status === 'open') && (!only || kindOf(r) === only));
    const by = new Map();
    for (const r of visible) {
      if (!by.has(r.email)) by.set(r.email, { email: r.email, name: r.name, periodStart: r.periodStart, rows: [] });
      by.get(r.email).rows.push(r);
    }
    return [...by.values()].map(p => ({
      ...p,
      open: p.rows.filter(r => r.status === 'open').length,
      days: new Set(p.rows.map(r => r.date)).size,
    }));
  }, [all, showResolved, only]);
  const unknown = data?.unknownState || [];
  const outside = data?.outsideCa || [];

  return (
    <section data-testid="ca-review" style={{ border: '1px solid var(--wk-line2, var(--line))', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Scale size={16} style={{ color: 'var(--wk-brand)' }} />
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: 'var(--ink)' }}>California Review</h3>
        {data && (
          <StatusLabel size="sm" label={`${data.openCount} Open`} color={data.openCount ? '#b45309' : '#16a34a'} />
        )}
        {P && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--muted)' }}>
            <button type="button" className="secondary-btn" aria-label="Previous Period" disabled={loading} onClick={() => run(addDays(P.start, -14))} style={{ padding: '2px 6px' }}><ChevronLeft size={14} /></button>
            <span>{formatDate(P.start)} - {formatDate(P.end)}</span>
            <button type="button" className="secondary-btn" aria-label="Next Period" disabled={loading} onClick={() => run(addDays(P.end, 1))} style={{ padding: '2px 6px' }}><ChevronRight size={14} /></button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        {data && (
          <button type="button" className="secondary-btn" onClick={() => setSettingsOpen(true)}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><SlidersHorizontal size={13} /> Minimum Wage</button>
        )}
        <button type="button" className={data ? 'secondary-btn' : 'primary-btn'} disabled={loading} onClick={() => run(anchor)}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {loading ? <Spinner size={13} /> : (data ? <RefreshCw size={13} /> : <Scale size={13} />)}
          {data ? 'Refresh' : 'Run Review'}
        </button>
      </div>

      {!data && !loading && !error && !stepLocked && (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
          Check the time sheets of hourly staff who work in California against California rules - meal breaks, 7th-day and double time, split shifts, reporting time, minimum wage and manual time. Each flag says what happened, what is owed and what you can do.
        </p>
      )}
      {loading && !data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0 2px', fontSize: 12.5, color: 'var(--muted)' }}>
          <Spinner size="inline" /> Reading every California time sheet in your scope.
        </div>
      )}
      {error && <div style={{ marginTop: 10 }}><ErrorBanner message={error} onRetry={() => run(anchor)} /></div>}
      {stepLocked && <StepUpNeeded label="The California Review shows employees’ pay rates." onVerified={() => run(anchor)} />}

      {data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>
              {data.people} {data.people === 1 ? 'person' : 'people'} who work in California checked.
              {outside.length > 0 && (
                <span title={outside.map(o => `${o.name} - ${o.reason}`).join('\n')}>
                  {' '}{outside.length} outside California {outside.length === 1 ? 'is' : 'are'} not checked.
                </span>
              )}
            </span>
            {resolvedCount > 0 && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Show {resolvedCount} Resolved
              </label>
            )}
          </div>

          {summary.length > 0 && (
            <div role="group" aria-label="Flags by Type" style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <TypeChip label="All" count={data.openCount} active={!only} onClick={() => setOnly('')} />
              {summary.map(s => (
                <TypeChip key={s.kind} label={s.label} count={s.count} color={KIND_COLOR[s.kind]} active={only === s.kind}
                  onClick={() => setOnly(only === s.kind ? '' : s.kind)} />
              ))}
            </div>
          )}

          {unknown.length > 0 && (
            <div style={{ marginTop: 10, border: '1px dashed var(--line)', borderRadius: 10, padding: '8px 10px' }}>
              <button type="button" onClick={() => setUnknownOpen(o => !o)} aria-expanded={unknownOpen}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', textAlign: 'left' }}>
                <MapPinOff size={14} style={{ color: '#b45309' }} />
                Work State Unknown
                <StatusLabel size="sm" label={String(unknown.length)} color="#b45309" />
                <span style={{ flex: 1 }} />
                <ChevronDown size={14} style={{ transform: unknownOpen ? 'rotate(180deg)' : 'none', color: 'var(--muted)' }} />
              </button>
              {unknownOpen && (
                <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    On the California rule, but Nexus cannot tell where they work, so they are not checked. Give them a work site on their People profile (or pick an overtime rule on Pay &amp; Benefits) and they are.
                  </div>
                  {unknown.map(u => (
                    <div key={u.email} style={{ display: 'flex', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink)', minWidth: 160 }}>{u.name}</span>
                      <span style={{ color: 'var(--muted)' }}>{u.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!people.length ? (
            <div style={{ padding: '14px 4px 6px', fontSize: 12.5, color: 'var(--muted)' }}>
              {only ? 'Nothing of this type to look at.' : 'Nothing to look at for this period.'}
            </div>
          ) : (
            <div aria-label="California Review Flags" style={{ maxHeight: 520, overflowY: 'auto', marginTop: 10, display: 'grid', gap: 8 }}>
              {people.map(p => {
                const isClosed = closed[p.email];
                return (
                  <div key={p.email} data-person={p.email} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)' }}>
                    <button type="button" aria-expanded={!isClosed} onClick={() => setClosed(c => ({ ...c, [p.email]: !c[p.email] }))}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 0, padding: '9px 12px', cursor: 'pointer', fontFamily: 'Inter,sans-serif', textAlign: 'left' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{p.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {p.days} {p.days === 1 ? 'day' : 'days'} · {p.open} open
                      </span>
                      <span style={{ flex: 1 }} />
                      <ChevronDown size={14} style={{ transform: isClosed ? 'rotate(-90deg)' : 'none', color: 'var(--muted)' }} />
                    </button>
                    {!isClosed && p.rows.map(f => (
                      <FlagRow key={f.key} f={f} busy={busyKey === f.email + f.key}
                        onPay={() => payPremium(f)} onHandled={() => alreadyHandled(f)} onNote={() => resolveWithNote(f)}
                        onReopen={() => reopen(f)} onAdjust={() => onOpenTimecard?.(f.email, f.periodStart, 'hourly')} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
            Checked {formatDateTime(data.generatedAt)}. Minimum wage ${Number(data.settings?.minWage || 0).toFixed(2)}/hr (California state - city and county minimums are not checked). Only HR sees this review.
          </div>
        </>
      )}
      {settingsOpen && (
        <MinWageSettings current={data?.settings?.minWage} onClose={() => setSettingsOpen(false)} toastOk={toastOk} toastErr={toastErr}
          onSaved={() => { setSettingsOpen(false); run(anchor); }} />
      )}
    </section>
  );
}

function TypeChip({ label, count, color = 'var(--ink)', active, onClick }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 12, fontWeight: 600,
        border: `1px solid ${active ? color : 'var(--line)'}`, background: active ? 'color-mix(in srgb, currentColor 6%, transparent)' : 'transparent', color: active ? color : 'var(--ink)' }}>
      {label}
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color }}>{count}</span>
    </button>
  );
}

function FlagRow({ f, busy, onPay, onHandled, onNote, onReopen, onAdjust }) {
  const open = f.status === 'open';
  const btn = { fontSize: 12, padding: '4px 10px' };
  return (
    <div data-flag={f.key} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', padding: '10px 12px', borderTop: '1px solid var(--line)', opacity: open ? 1 : 0.75 }}>
      <div style={{ flex: '0 0 118px', display: 'grid', gap: 4, alignContent: 'start' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{formatDate(f.date)}</span>
        <StatusLabel size="sm" label={kindLabel(f)} color={KIND_COLOR[kindOf(f)] || '#64748b'} />
      </div>
      <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 3, fontSize: 12.5, lineHeight: 1.45 }}>
        <div style={{ color: 'var(--ink)' }}>{f.what || f.reason}</div>
        {f.means && <div style={{ color: 'var(--muted)' }}>{f.means}</div>}
        {f.changedSinceResolved && <div style={{ fontSize: 11.5, color: '#b45309' }}>Resolved before, but the facts changed since.</div>}
        {f.status === 'resolved' && f.resolution && (
          <div style={{ fontSize: 11.5, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={12} />
            {f.premiumAdded ? f.resolution.note : `Resolved${f.resolution.at ? ` ${formatDateTime(f.resolution.at)}` : ''}: ${f.resolution.note}`}
          </div>
        )}
      </div>
      <div style={{ flex: '0 1 300px', display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {open && f.premiumKind && PREMIUM_LABEL[f.premiumKind] && (
          <button type="button" className="primary-btn" disabled={busy} onClick={onPay} style={btn}>{PREMIUM_LABEL[f.premiumKind]}</button>
        )}
        {open && <button type="button" className="secondary-btn" disabled={busy} onClick={onHandled} style={btn}>Already Handled</button>}
        <button type="button" className="secondary-btn" onClick={onAdjust} style={btn}>Adjust Time Sheet</button>
        {open
          ? <button type="button" className="secondary-btn" disabled={busy} onClick={onNote} style={btn}>Resolve with Note</button>
          : (!f.premiumAdded && <button type="button" className="secondary-btn" disabled={busy} onClick={onReopen} style={btn}>Reopen</button>)}
      </div>
    </div>
  );
}

// The minimum wage box (Settings > Time & Pay > California Minimum Wage since
// Oct 23). `current` comes from the review when it wraps it; on its own it
// loads the saved value.
export function MinWageForm({ current, onSaved, toastOk, toastErr }) {
  const [v, setV] = useState(current ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (current !== undefined) return;
    api.caReviewSettings().then(r => setV(r?.minWage ?? 16.9)).catch(() => setV(16.9));
  }, [current]);
  async function save() {
    setBusy(true);
    try { await api.caReviewSaveSettings({ minWage: Number(v) }); toastOk?.('Minimum wage saved.'); onSaved?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not save the minimum wage.'); }
    setBusy(false);
  }
  if (v === null) return <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="inline" /></div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        The California state minimum wage the review checks pay rates against ($16.90/hr in 2026). It also prices the split-shift premium. City and county minimums are not checked.
      </p>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--ink)', maxWidth: 240 }}>
        Minimum Wage ($/hr)
        <input className="form-input" type="number" min={0.01} step={0.01} aria-label="Minimum Wage" value={v}
          onChange={e => setV(e.target.value)} style={{ fontSize: 13 }} />
      </label>
      <div>
        <button type="button" className="primary-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function MinWageSettings({ current, onClose, onSaved, toastOk, toastErr }) {
  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
    </div>
  );
  return (
    <Modal title="California Minimum Wage" onClose={onClose} footer={footer}>
      <MinWageForm current={current} onSaved={() => { onSaved?.(); onClose(); }} toastOk={toastOk} toastErr={toastErr} />
      <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--muted)' }}>Also under Settings &gt; Time &amp; Pay &gt; California Minimum Wage.</p>
    </Modal>
  );
}
