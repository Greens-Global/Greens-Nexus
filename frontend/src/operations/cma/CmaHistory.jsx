// Rate History (Miranda's mockup, artboard 3): one unit type over time - our
// Web (sell) rate, the average in-place rent, the market average and the
// market low-high band - with the gap to market, rent vs web rate and
// occupancy cards, and a change log of every Cubby rate change, survey, comp
// set edit, approval and website sync (GET /facility-ops/cma/history).
// Before Cubby (Sep 2026) the chart and the log reach back through the
// Hummingbird months - one month-end point each, our rates and occupancy only
// (source "Hummingbird"). Neil, Oct 21 2026: the old Excel CMAs are not wanted,
// so there is no workbook seed.
import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, LoadingState } from '../../components/AsyncState';
import { formatDate } from '../../lib/datetime';
import { DateField, SearchSelect } from '../../tasks/components';
import { count } from '../model';
import { dash, exportRows, pctText, signedUsd, sizeOf, usd } from './cmaModel';

// The period the chart and the change log cover (Visesh, Oct 21: a date filter
// to see the Hummingbird years). Remembered per viewer on this device.
const PERIODS = [
  { key: 'all', label: 'All History' },
  { key: '3m', label: 'Last 3 Months', months: 3 },
  { key: '6m', label: 'Last 6 Months', months: 6 },
  { key: '12m', label: 'Last 12 Months', months: 12 },
  { key: '24m', label: 'Last 24 Months', months: 24 },
  { key: 'ytd', label: 'This Year' },
  { key: 'custom', label: 'Custom Range' },
];
const PERIOD_KEY = 'nexus.ops.rateHistory.period';
const readPeriod = () => { try { return JSON.parse(localStorage.getItem(PERIOD_KEY)) || { key: 'all' }; } catch { return { key: 'all' }; } };
const savePeriod = (p) => { try { localStorage.setItem(PERIOD_KEY, JSON.stringify(p)); } catch { /* not remembered */ } };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** {start, end} (YYYY-MM-DD or '') for a period choice. */
export function periodBounds(p, today = new Date()) {
  const def = PERIODS.find((x) => x.key === p?.key);
  if (!def || def.key === 'all') return { start: '', end: '' };
  if (def.key === 'custom') return { start: p.start || '', end: p.end || '' };
  if (def.key === 'ytd') return { start: `${today.getFullYear()}-01-01`, end: '' };
  const from = new Date(today.getFullYear(), today.getMonth() - def.months, today.getDate());
  return { start: isoDay(from), end: '' };
}

const SOURCE = { manual: ['manual', 'Manual'], comp_set: ['comp_set', 'Comp Set'], cubby: ['cubby', 'Cubby'], website: ['website', 'Website'], import: ['import', 'Import'], hummingbird: ['hummingbird', 'Hummingbird'] };
const W = 760; const H = 260; const PAD = { l: 52, r: 16, t: 14, b: 30 };

function Chart({ points }) {
  const [hover, setHover] = useState(null);
  const vals = points.flatMap((p) => [p.sell, p.avgRent, p.marketAvg, p.marketLow, p.marketHigh]).filter((x) => x != null);
  if (!points.length || !vals.length) return <div className="ops-empty">No history for this unit type yet. It fills in from today.</div>;
  const lo = Math.min(...vals) * 0.95; const hi = Math.max(...vals) * 1.05;
  const t0 = new Date(`${points[0].date}T12:00:00`).getTime();
  const t1 = new Date(`${points[points.length - 1].date}T12:00:00`).getTime();
  const x = (d) => PAD.l + (t1 === t0 ? (W - PAD.l - PAD.r) / 2 : ((new Date(`${d}T12:00:00`).getTime() - t0) / (t1 - t0)) * (W - PAD.l - PAD.r));
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const line = (k) => points.filter((p) => p[k] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const band = points.filter((p) => p.marketLow != null && p.marketHigh != null);
  const bandPath = band.length > 1
    ? `${band.map((p, i) => `${i ? 'L' : 'M'}${x(p.date)},${y(p.marketHigh)}`).join(' ')} ${[...band].reverse().map((p) => `L${x(p.date)},${y(p.marketLow)}`).join(' ')} Z` : '';
  const ticks = [lo, (lo + hi) / 2, hi];
  const hp = hover != null ? points[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <div className="cma-legend" aria-hidden="true">
        <span><i style={{ background: 'var(--ok-fg)' }} />Our Web (Sell) Rate</span>
        <span><i style={{ background: 'repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 7px)' }} />Avg In-Place Rent</span>
        <span><i style={{ background: 'var(--info-fg)', width: 8, height: 8, borderRadius: '50%' }} />Market Avg (Ex. Us)</span>
        <span><i style={{ background: 'rgba(42, 120, 214, .2)', height: 10 }} />Market Low-High</span>
      </div>
      <svg className="cma-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Rate history chart" data-testid="history-chart"
        onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{usd(Math.round(v / 100) * 100)}</text>
          </g>
        ))}
        {bandPath && <path d={bandPath} fill="rgba(42, 120, 214, .14)" stroke="none" />}
        {band.length === 1 && <rect x={x(band[0].date) - 4} y={y(band[0].marketHigh)} width="8" height={Math.max(2, y(band[0].marketLow) - y(band[0].marketHigh))} rx="4" fill="rgba(42, 120, 214, .2)" />}
        <path d={line('avgRent')} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="5 4" />
        <path d={line('sell')} fill="none" stroke="var(--ok-fg)" strokeWidth="2" />
        {points.map((p, i) => (
          <g key={p.date}>
            {p.sell != null && <circle cx={x(p.date)} cy={y(p.sell)} r="4" fill="var(--ok-fg)" stroke="var(--card)" strokeWidth="2" />}
            {p.marketAvg != null && <circle cx={x(p.date)} cy={y(p.marketAvg)} r="4.5" fill="var(--info-fg)" stroke="var(--card)" strokeWidth="2" />}
            <rect x={x(p.date) - 12} y={PAD.t} width="24" height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
          </g>
        ))}
        {hp && <line x1={x(hp.date)} x2={x(hp.date)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth="1" />}
        {[points[0], points[points.length - 1]].filter((p, i, a) => i === 0 || p.date !== a[0].date).map((p) => (
          <text key={p.date} x={x(p.date)} y={H - 10} fontSize="11" fill="var(--muted)" textAnchor={p === points[0] ? 'start' : 'end'}>{formatDate(p.date)}</text>
        ))}
      </svg>
      {hp && (
        <div role="status" style={{ position: 'absolute', top: 30, left: `${Math.min(70, (x(hp.date) / W) * 100)}%`, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12, pointerEvents: 'none', boxShadow: '0 4px 12px rgba(15,23,42,.12)' }}>
          <strong>{formatDate(hp.date)}</strong>{hp.source === 'hummingbird' && <span className="cma-badge cma-badge-hummingbird" style={{ marginLeft: 6 }}>Hummingbird</span>}
          <div>Web Rate {usd(hp.sell)}</div>
          {hp.marketAvg != null && <div>Market Avg {usd(hp.marketAvg)} ({usd(hp.marketLow)} - {usd(hp.marketHigh)}, {hp.comps} comps)</div>}
          {hp.avgRent != null && <div>Avg In-Place Rent {usd(hp.avgRent)}</div>}
        </div>
      )}
    </div>
  );
}

export default function CmaHistory({ facility, view, onSection }) {
  const types = view.rows;
  const first = types.find((r) => r.ready) || types.find((r) => r.competitors) || types[0];
  const [unit, setUnit] = useState(first?.name || '');
  const [state, setState] = useState({ status: 'loading', data: null, key: '' });
  const [nonce, setNonce] = useState(0);
  const [period, setPeriodState] = useState(readPeriod);
  const setPeriod = (p) => { setPeriodState(p); savePeriod(p); };
  const { start, end } = periodBounds(period);
  const badRange = !!(start && end && start > end);
  const key = `${facility.id}|${unit}|${start}|${end}|${nonce}`;
  useEffect(() => {
    if (!unit || badRange) return undefined;
    let live = true;
    api.getOpsCmaHistory(facility.id, unit, { start, end })
      .then((data) => { if (live) setState({ status: 'ready', data, key }); })
      .catch((err) => { console.error('Operations: rate history failed', err); if (live) setState({ status: 'error', data: null, key }); });
    return () => { live = false; };
  }, [facility.id, unit, start, end, badRange, key]);
  const row = types.find((r) => r.name === unit);
  const d = state.key === key ? state.data : null;
  const loading = state.key !== key && !badRange;
  const exportLog = (format) => exportRows(format, {
    title: `Rate History ${unit}`, facility: view.facility, asOf: view.asOf, rows: d.log,
    columns: [{ header: 'Date', get: (e) => formatDate(e.date), width: 12 }, { header: 'What Changed', get: (e) => e.text, width: 60 },
      { header: 'Source', get: (e) => (SOURCE[e.source] || ['', e.source])[1], width: 12 }, { header: 'By', get: (e) => e.by, width: 24 }],
  }).catch((err) => console.error('Operations: history export failed', err));
  const exportPoints = (format) => exportRows(format, {
    title: `Rate History Points ${unit}`, facility: view.facility, asOf: view.asOf, rows: d.points,
    columns: [{ header: 'Date', get: (p) => formatDate(p.date) }, { header: 'Source', get: (p) => (p.source === 'hummingbird' ? 'Hummingbird' : 'Cubby') }, { header: 'Web Rate', get: (p) => usd(p.sell) },
      { header: 'Standard Rate', get: (p) => usd(p.standard) }, { header: 'Avg In-Place Rent', get: (p) => usd(p.avgRent) },
      { header: 'Market Low', get: (p) => usd(p.marketLow) }, { header: 'Market Avg', get: (p) => usd(p.marketAvg) },
      { header: 'Market High', get: (p) => usd(p.marketHigh) }, { header: 'Comps', get: (p) => p.comps },
      { header: 'Occupied', get: (p) => (p.occupied == null ? '' : p.occupied) }],
  }).catch((err) => console.error('Operations: history export failed', err));
  // Unit types as one searchable dropdown, grouped Self-Storage / Vehicle
  // Storage (Visesh, Oct 21: the chip rows were crammed, and two parking types
  // of one size read the same as chips). The full Cubby name tells them apart.
  const unitOptions = useMemo(() => {
    const live = types.filter((r) => r.total);
    const out = [];
    for (const [title, test] of [['Self-Storage', (r) => r.category !== 'Vehicle Storage'], ['Vehicle Storage', (r) => r.category === 'Vehicle Storage']]) {
      const list = live.filter(test);
      if (!list.length) continue;
      out.push({ id: `__${title}`, header: true, label: title });
      list.forEach((r) => out.push({ id: r.name, label: r.name, keywords: `${sizeOf(r)} ${r.category || ''}` }));
    }
    return out;
  }, [types]);

  return (
    <>
      <div className="dash-card" data-testid="cma-history">
        <div className="cma-crumb"><button type="button" onClick={() => onSection('overview')}>CMA · {view.facility}</button> / Rate History</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h2 className="cma-title">Rate History · {row ? `${sizeOf(row)} ${row.category === 'Vehicle Storage' ? 'parking' : 'storage'}` : unit}</h2>
            <div className="cma-sub">Our rates from Cubby&apos;s rate changes and daily snapshots, and from Hummingbird month-ends before Cubby · competitor rates from each website read and manual survey.</div>
          </div>
        </div>
        <div className="cma-toolbar">
          <div className="cma-toolbar-group">
            <span className="cma-field">
              <span className="cma-field-label" id="rh-unit-label">Unit Type</span>
              <span aria-labelledby="rh-unit-label" className="cma-unit-select">
                <SearchSelect options={unitOptions} value={unit} onPick={(v) => v && !String(v).startsWith('__') && setUnit(v)}
                  placeholder="Pick a unit type" searchPlaceholder="Search sizes or types..." menuMinWidth={340} />
              </span>
            </span>
            <span className="cma-field" role="group" aria-label="Date range">
              <label className="cma-field-label" htmlFor="rh-period">Period</label>
              <select id="rh-period" className="cma-select" value={period.key} onChange={(e) => setPeriod(e.target.value === 'custom'
                ? { key: 'custom', start: start || (d?.span?.first || ''), end: end || '' } : { key: e.target.value })}>
                {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              {period.key === 'custom' && (
                <span className="cma-range-dates">
                  <DateField value={period.start || ''} onChange={(v) => setPeriod({ ...period, start: v || '' })} placeholder="From" title="From" />
                  <span aria-hidden="true">-</span>
                  <DateField value={period.end || ''} onChange={(v) => setPeriod({ ...period, end: v || '' })} placeholder="Today" title="To" />
                </span>
              )}
            </span>
          </div>
          {d?.span?.first && (
            <span className="cma-record">
              History on record {formatDate(d.span.first)} - {formatDate(d.span.last)}
              {d.hummingbird?.first ? <span className="cma-record-hb">Hummingbird from {formatDate(`${d.hummingbird.first}-01`)}</span> : null}
            </span>
          )}
        </div>
        {badRange && <p className="ops-note" role="alert" style={{ margin: '8px 0 0' }}>The From date is after the To date.</p>}
      </div>
      {loading && <LoadingState size="section" label="Loading rate history" minHeight={240} />}
      {!loading && state.status === 'error' && <ErrorBanner message="Couldn't load the rate history." onRetry={() => setNonce((n) => n + 1)} />}
      {d && (
        <>
          <div className="cma-side">
            <section className="cma-panel" aria-label="Chart">
              <Chart points={d.points} />
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>Show as a Table</summary>
                <div className="req-table-wrapper">
                  <table className="req-table stack-table cma-table">
                    <thead><tr><th>Date</th><th>Source</th><th className="num">Web Rate</th><th className="num">Avg In-Place Rent</th><th className="num">Mkt Low</th><th className="num">Mkt Avg</th><th className="num">Mkt High</th><th className="num">Comps</th></tr></thead>
                    <tbody>{d.points.map((p) => (
                      <tr key={p.date}><td>{formatDate(p.date)}</td><td>{p.source === 'hummingbird' ? 'Hummingbird' : 'Cubby'}</td><td className="num">{usd(p.sell)}</td><td className="num">{usd(p.avgRent)}</td>
                        <td className="num">{usd(p.marketLow)}</td><td className="num">{usd(p.marketAvg)}</td><td className="num">{usd(p.marketHigh)}</td><td className="num">{p.comps}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </details>
            </section>
            <div className="cma-cards">
              <div className="cma-kpi">
                <div className="cma-kpi-label">Gap to Market (Web Rate vs Avg)</div>
                <div className={`cma-kpi-value${d.cards.gap < 0 ? ' cma-below' : ''}`} style={{ fontSize: 20 }}>{d.cards.gap == null ? dash : `${signedUsd(d.cards.gap)} · ${pctText(d.cards.gapPct)}`}</div>
                <div className="cma-kpi-sub">{formatDate(d.cards.asOf)} · {d.cards.comps} {d.cards.comps === 1 ? 'comp' : 'comps'}</div>
              </div>
              <div className="cma-kpi">
                <div className="cma-kpi-label">Avg In-Place Rent vs Web Rate</div>
                <div className="cma-kpi-value" style={{ fontSize: 20 }}>{signedUsd(d.cards.rentVsSell)}</div>
                <div className="cma-kpi-sub">{d.cards.rentVsSell == null ? 'No tenants in this unit type' : d.cards.rentVsSell > 0 ? 'Existing tenants pay more than new move-ins' : 'New move-ins pay more than existing tenants'}</div>
              </div>
              <div className="cma-kpi">
                <div className="cma-kpi-label">Occupancy Trend</div>
                <div className="cma-kpi-value" style={{ fontSize: 20 }}>{d.cards.occupiedThen == null ? count(d.cards.occupiedNow) : `${count(d.cards.occupiedThen)} → ${count(d.cards.occupiedNow)}`}</div>
                <div className="cma-kpi-sub">Occupied of {count(d.cards.total)}{d.cards.occupiedFrom ? ` · ${formatDate(d.cards.occupiedFrom)} → ${formatDate(d.cards.occupiedTo || d.cards.asOf)}` : ' today'}</div>
              </div>
            </div>
          </div>

          <section className="cma-panel" aria-label="Change log">
            <div className="cma-panel-head">
              <div>
                <h3 className="cma-h3">Change Log</h3>
                <div className="cma-sub">Every rate change, sync and manual entry - who, when, and from where.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary-btn cma-btn" onClick={() => exportLog('csv')}><Download size={14} aria-hidden="true" /> Export CSV</button>
                <button type="button" className="secondary-btn cma-btn" onClick={() => exportLog('xls')}><Download size={14} aria-hidden="true" /> Export XLS</button>
                <button type="button" className="secondary-btn cma-btn" onClick={() => exportPoints('xls')}><Download size={14} aria-hidden="true" /> Chart Data XLS</button>
              </div>
            </div>
            {d.log.length === 0 ? <div className="ops-empty">Nothing recorded for this unit type yet.</div> : (
              <div className="req-table-wrapper">
                <table className="req-table stack-table cma-table" data-testid="change-log">
                  <thead><tr><th>Date</th><th>What Changed</th><th>Source</th><th>By</th></tr></thead>
                  <tbody>
                    {d.log.map((e, i) => {
                      const [cls, label] = SOURCE[e.source] || ['manual', e.source];
                      return (
                        <tr key={`${e.at}:${i}`}>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDate(e.date)}</td>
                          <td data-th="What Changed">{e.text}</td>
                          <td data-th="Source"><span className={`cma-badge cma-badge-${cls}`}>{label}</span></td>
                          <td data-th="By">{e.by || dash}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
