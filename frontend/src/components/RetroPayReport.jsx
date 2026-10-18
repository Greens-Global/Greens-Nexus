import { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from './AsyncState';
import { defaultRange, hrs, money, rateNowText, retroPayCsv, span } from './retroPayModel';
import { isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';

// People > Time > Payroll > Retro Pay (Neil, Oct 17 2026). A finalized period
// keeps the rate it was finalized with, so a raise entered later with an
// effective date inside it is not paid by the card. This lists who is owed
// what (or was overpaid) so payroll can pay it off-cycle. Figures come from
// GET /timeclock/retro-pay (routers/retro_pay.py) - the payroll card priced
// twice, never a calculation here. HR / payroll only: TimeAdmin hides it from
// the manager tier and the backend asks for the payroll guard and step-up.

const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, marginTop: 18 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '8px 10px', fontSize: 12.5, color: 'var(--ink)', borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const sub = { fontSize: 11.5, color: 'var(--muted)' };
const lbl = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, fontWeight: 600, color: 'var(--muted)' };

export default function RetroPayReport({ initiallyOpen = false }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [[start, end], setRange] = useState(() => defaultRange());
  const [data, setData] = useState(null);
  const [state, setState] = useState({ loading: false, error: '', stepUp: false });

  // Only the latest Run Report lands - a slow earlier range never overwrites a newer one.
  const seq = useRef(0);
  const load = useCallback((s, e) => {
    const mine = ++seq.current;
    setState({ loading: true, error: '', stepUp: false });
    api.timeRetroPay(s, e)
      .then((d) => { if (mine !== seq.current) return; setData(d); setState({ loading: false, error: '', stepUp: false }); })
      .catch((err) => {
        if (mine !== seq.current) return;
        setData(null);
        const su = isStepUpRequired(err);
        setState({ loading: false, stepUp: su, error: su ? '' : (err?.message || 'Could not build the Retro Pay report.') });
      });
  }, []);

  const rangeError = !start || !end ? 'Pick both dates.' : start > end ? 'The start date must be on or before the end date.' : '';
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !state.loading && !rangeError) load(start, end);
  };
  const run = () => { if (!rangeError) load(start, end); };

  const rows = useMemo(() => (data?.people || []).flatMap((p) => p.periods.map((it) => ({ ...it, name: p.name }))), [data]);
  const manual = data?.checkManually || [];
  const isEmpty = !!data && !rows.length && !manual.length;

  const download = () => {
    const blob = new Blob([retroPayCsv(data)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retro-pay-${data.start}-to-${data.end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section style={card} aria-label="Retro Pay">
      <button type="button" onClick={toggle} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Retro Pay</span>
        <span style={{ ...sub, marginLeft: 4 }}>Back-dated rate changes on finalized periods - who is owed what.</span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
            <label style={lbl}>From
              <input className="form-input" type="date" aria-label="From" value={start} onChange={(e) => setRange([e.target.value, end])} style={{ fontSize: 12, width: 150 }} />
            </label>
            <label style={lbl}>To
              <input className="form-input" type="date" aria-label="To" value={end} onChange={(e) => setRange([start, e.target.value])} style={{ fontSize: 12, width: 150 }} />
            </label>
            <button type="button" className="primary-btn" onClick={run} disabled={!!rangeError || state.loading} style={{ fontSize: 12.5 }}>Run Report</button>
            <div style={{ flex: 1 }} />
            <button type="button" className="secondary-btn" onClick={download} disabled={!data || isEmpty}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <Download size={14} /> Download CSV
            </button>
            {rangeError && <div style={{ width: '100%', fontSize: 12, color: 'hsl(var(--color-red))' }}>{rangeError}</div>}
          </div>

          {state.stepUp ? (
            <StepUpNeeded label="Retro Pay shows employees' pay figures." onVerified={() => load(start, end)} />
          ) : (
            <AsyncSection loading={state.loading} error={!!state.error} errorMessage={state.error} onRetry={run}
              skeleton={<SkeletonBlocks count={2} />} isEmpty={isEmpty}
              emptyContent={<div style={{ padding: '22px 14px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 10 }}>No back-dated rate changes in this range.</div>}>
              {data && !isEmpty && (
                <>
                  {rows.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                        <thead>
                          <tr>
                            <th style={th}>Employee</th><th style={th}>Period</th><th style={thNum}>Hours</th>
                            <th style={thNum}>Rate Paid</th><th style={thNum}>Rate Now</th><th style={thNum}>Owed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((it) => (
                            <tr key={`${it.email}-${it.periodStart}`}>
                              <td style={td}><strong>{it.name}</strong><div style={sub}>{it.email}</div></td>
                              <td style={td}>{span(it.periodStart, it.periodEnd)}
                                <div style={sub}>Changed {span(it.changedFrom, it.changedThrough)}</div></td>
                              <td style={tdNum}>
                                <div>{hrs(it.hours.regMin)} Regular</div>
                                {it.hours.otMin > 0 && <div style={sub}>{hrs(it.hours.otMin)} OT 1.5x</div>}
                                {it.hours.dtMin > 0 && <div style={sub}>{hrs(it.hours.dtMin)} DT 2x</div>}
                                {it.hours.leaveMin > 0 && <div style={sub}>{hrs(it.hours.leaveMin)} Leave</div>}
                                {it.hours.holidayDays > 0 && <div style={sub}>{it.hours.holidayDays} Paid Holiday{it.hours.holidayDays === 1 ? '' : 's'}</div>}
                              </td>
                              <td style={tdNum}>{money(it.ratePaid, it.currency)}</td>
                              <td style={tdNum}>{rateNowText(it.rateNow, it.currency, it.rateNow?.length === 1).map((t) => <div key={t}>{t}</div>)}</td>
                              <td style={{ ...tdNum, fontWeight: 700, color: it.owed < 0 ? 'hsl(var(--color-red))' : 'var(--ink)' }}>
                                {money(it.owed, it.currency)}
                                <div style={{ ...sub, fontWeight: 400 }}>{money(it.paid.total, it.currency)} paid, {money(it.now.total, it.currency)} now</div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          {(data.totals || []).map((t) => (
                            <tr key={t.currency}>
                              <td style={{ ...td, fontWeight: 700 }} colSpan={2}>{data.totals.length > 1 ? `Total ${t.currency}` : 'Total'}
                                <div style={{ ...sub, fontWeight: 400 }}>{t.people} {t.people === 1 ? 'employee' : 'employees'}, {t.periods} {t.periods === 1 ? 'period' : 'periods'}</div></td>
                              <td style={{ ...tdNum, fontWeight: 700 }}>{hrs(t.regMin + t.otMin + t.dtMin + t.leaveMin)}</td>
                              <td style={td} /><td style={td} />
                              <td style={{ ...tdNum, fontWeight: 700, color: t.owed < 0 ? 'hsl(var(--color-red))' : 'var(--ink)' }}>{money(t.owed, t.currency)}</td>
                            </tr>
                          ))}
                        </tfoot>
                      </table>
                    </div>
                  )}
                  {manual.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>Check Manually</div>
                      {manual.map((m) => (
                        <div key={`${m.email}-${m.periodStart}`} style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 6, fontSize: 12.5 }}>
                          <strong>{m.name}</strong> <span style={sub}>{span(m.periodStart, m.periodEnd)}</span>
                          {m.ratePaid != null && (
                            <span style={sub}> - paid {money(m.ratePaid, m.currency)}{m.rateNow?.length ? `, now ${rateNowText(m.rateNow, m.currency, m.rateNow.length === 1).join(', ')}` : ''}</span>
                          )}
                          <div style={{ ...sub, marginTop: 3 }}>{m.reason}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p style={{ margin: '10px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                    Hours are the ones on the days whose rate changed. Owed is the period priced at the rate now in effect
                    minus what it paid when it was finalized, with the same overtime rule. A negative amount was overpaid.
                    Finalized time sheets are not changed - pay the difference through the payroll provider.
                  </p>
                </>
              )}
            </AsyncSection>
          )}
        </div>
      )}
    </section>
  );
}
