// Operations > Dashboard > Ops Budget (Oct 21 2026): how each site is doing
// against plan and against last year, built to make sense to an owner at a
// glance (the ops team's briefing and mockup, Oct 19).
//
// Every figure, rate, variance and sentence comes from GET /ops-budget and
// /ops-budget/trend (backend/ops_budget.py) - this screen only lays them out
// and formats them. A missing figure is a dash, never 0%; website visitors
// and reviews read "Pending API" until those connections are live.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Upload } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LabelList,
} from 'recharts';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { Legend } from './charts';
import { DASH, byKey, fmtValue, monthOptions, monthText, pill } from './opsBudgetFormat';
import OpsBudgetUpload from './OpsBudgetUpload';
import './opsBudget.css';

const PREFS_KEY = 'nexus.ops.budget';
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* not remembered */ } };

const AXIS = { fontSize: 11.5, fill: 'var(--muted)' };
const GRID = 'var(--ops-grid)';
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Small pieces ──────────────────────────────────────────────────────────────

function Arrow({ dir }) {
  if (!dir) return null;
  return <span className="ob-arrow" aria-hidden="true">{dir === 'up' ? '▲' : '▼'}</span>;
}

// A variance pill: green better, red worse, gray even or neutral, a dash when missing.
export function VarPill({ unit, variance, suffix = '' }) {
  const p = pill(unit, variance);
  if (p.tone === 'none') return <span className="ob-pill ob-pill-none">{DASH}</span>;
  const word = p.tone === 'good' ? 'better' : p.tone === 'bad' ? 'worse' : '';
  return (
    <span className={`ob-pill ob-pill-${p.tone}`} title={word ? `${p.text}${suffix} (${word})` : undefined}>
      <Arrow dir={p.arrow} />{p.text}{suffix}
    </span>
  );
}

function Seg({ options, value, onChange, label }) {
  return (
    <div className="ob-seg" role="group" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

function Card({ title, right, children, className = '' }) {
  return (
    <section className={`dash-card ob-card ${className}`}>
      {(title || right) && (
        <div className="ob-card-head">
          {title && <h3 className="ob-card-title">{title}</h3>}
          {right && <span className="ob-card-right">{right}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

function TipBox({ active, payload, rows }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="ops-tip">
      <div className="ops-tip-title">{monthText(d.month, { long: true })}</div>
      {rows(d).map(([label, value, color]) => (
        <div className="ops-tip-row" key={label}><span>{color && <i style={{ background: color }} />}{label}</span><b>{value}</b></div>
      ))}
    </div>
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

function Item({ item, good }) {
  return (
    <li>
      <span className={`ob-tri ${good ? 'ob-good' : 'ob-bad'}`} aria-hidden="true">{item.arrow === 'down' ? '▼' : '▲'}</span>
      <span><b>{item.name}</b>{item.rest}</span>
    </li>
  );
}

export function SummaryCard({ report }) {
  const s = report.summary;
  const more = (s.attentionCount || 0) - (s.needsAttention || []).length;
  return (
    <section className="dash-card ob-summary" aria-label="Summary">
      <div className="ob-eyebrow">{report.segmentLabel} · {report.periodLabel}</div>
      <p className="ob-headline">{s.headline}</p>
      <div className="ob-lists">
        <div className="ob-list ob-list-good">
          <h4><CheckCircle2 size={16} aria-hidden="true" /> Going Well</h4>
          {s.goingWell.length ? <ul>{s.goingWell.map((i) => <Item key={i.metric} item={i} good />)}</ul>
            : <p className="ob-list-empty">Nothing ahead of last year or the plan yet.</p>}
        </div>
        <div className="ob-list ob-list-bad">
          <h4><AlertTriangle size={16} aria-hidden="true" /> Needs Attention</h4>
          {s.needsAttention.length ? <ul>{s.needsAttention.map((i) => <Item key={i.metric} item={i} />)}</ul>
            : <p className="ob-list-empty">Nothing is behind last year or the plan.</p>}
          {more > 0 && <p className="ob-list-empty">And {more} more in All Numbers below.</p>}
        </div>
      </div>
    </section>
  );
}

// ── KPI cards ────────────────────────────────────────────────────────────────

const SCALE_LO = 0.7;
const pos = (v) => `${Math.max(0, Math.min(1, (v - SCALE_LO) / (1 - SCALE_LO))) * 100}%`;

function OccKpi({ m, title, sub }) {
  const has = (v) => v !== null && v !== undefined;
  return (
    <section className="dash-card ob-kpi" aria-label={title}>
      <div className="ob-kpi-top"><span className="ob-kpi-title">{title}</span><VarPill unit="pct" variance={m.vsLastYear} suffix=" vs last yr" /></div>
      <div className="ob-kpi-value">{fmtValue('pct', m.actual)}</div>
      <div className="ob-kpi-sub">{sub}</div>
      <div className="ob-scale" title={`Actual ${fmtValue('pct', m.actual)}, budget ${fmtValue('pct', m.budget)}, last year ${fmtValue('pct', m.lastYear)}`}>
        <div className="ob-scale-track">
          {has(m.actual) && <div className="ob-scale-fill" style={{ width: pos(m.actual) }} />}
          {has(m.budget) && <span className="ob-scale-tick" style={{ left: pos(m.budget) }} />}
          {has(m.lastYear) && <span className="ob-scale-dot" style={{ left: pos(m.lastYear) }} />}
        </div>
        <div className="ob-scale-axis"><span>70%</span><span>85%</span><span>100%</span></div>
      </div>
      <div className="ob-kpi-legend">
        <span><i className="ob-key-tick" />Budget {fmtValue('pct', m.budget)}</span>
        <span><i className="ob-key-dot" />Last year {fmtValue('pct', m.lastYear)}</span>
      </div>
    </section>
  );
}

function IncomeKpi({ m }) {
  const vals = [['This period', m.actual, 'ob-bar-now'], ['Budget', m.budget, 'ob-bar-plan'], ['Last year', m.lastYear, 'ob-bar-ly']];
  const max = Math.max(...vals.map((v) => v[1] || 0)) || 1;
  return (
    <section className="dash-card ob-kpi" aria-label="Rental income">
      <div className="ob-kpi-top"><span className="ob-kpi-title">Rental Income</span><VarPill unit="money" variance={m.vsLastYear} suffix=" vs last yr" /></div>
      <div className="ob-kpi-value">{fmtValue('money', m.actual)}</div>
      <div className="ob-kpi-sub">Rent actually collected for the period</div>
      <div className="ob-hbars">
        {vals.map(([label, v, cls]) => (
          <div className="ob-hbar" key={label} title={`${label}: ${fmtValue('money', v)}`}>
            <span className="ob-hbar-label">{label}</span>
            <span className="ob-hbar-track">{v !== null && v !== undefined && <span className={cls} style={{ width: `${(v / max) * 100}%` }} />}</span>
            <span className="ob-num">{fmtValue('money', v)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Charts ───────────────────────────────────────────────────────────────────

function InOutChart({ points }) {
  const data = points.map((p) => ({ ...p, label: monthText(p.month, { axis: true }).slice(0, 3), outsNeg: p.move_outs === null ? null : -p.move_outs }));
  const empty = !data.some((d) => d.move_ins || d.move_outs);
  if (empty) return <div className="ops-empty">No move-ins or move-outs on record for these months.</div>;
  return (
    <div style={{ width: '100%', height: 250 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} stackOffset="sign" margin={{ top: 18, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval={0} />
          <YAxis hide />
          <ReferenceLine y={0} stroke="var(--muted)" strokeDasharray="4 3" />
          <Tooltip cursor={{ fill: 'var(--ops-grid)' }} content={<TipBox rows={(d) => [
            ['Move-Ins', fmtValue('count', d.move_ins), 'var(--ops-s1)'],
            ['Move-Outs', fmtValue('count', d.move_outs), 'var(--ops-s2)'],
            ['Net', d.move_ins === null || d.move_outs === null ? DASH : `${d.move_ins - d.move_outs > 0 ? '+' : ''}${d.move_ins - d.move_outs}`],
          ]} />} />
          <Bar dataKey="move_ins" stackId="m" fill="var(--ops-s1)" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <LabelList dataKey="move_ins" position="top" style={{ fontSize: 11, fill: 'var(--ink)', fontWeight: 600 }} />
          </Bar>
          <Bar dataKey="outsNeg" stackId="m" fill="var(--ops-s2)" radius={[0, 0, 4, 4]} isAnimationActive={false}>
            <LabelList dataKey="move_outs" position="bottom" style={{ fontSize: 11, fill: 'var(--ink)', fontWeight: 600 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TwoLines({ points, a, b, unit, domain, step = false, empty }) {
  const data = points.map((p) => ({ ...p, label: monthText(p.month, { axis: true }) }));
  const has = data.filter((d) => d[a.key] !== null || d[b.key] !== null).length;
  if (has < 2) return <div className="ops-empty" style={{ height: 220, display: 'grid', placeItems: 'center' }}>{empty}</div>;
  const tick = (v) => (unit === 'pct' ? `${Math.round(v * 100)}%` : `$${Math.round(v)}`);
  const type = step ? 'stepAfter' : 'monotone';
  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={44} domain={domain} tickFormatter={tick} />
          <Tooltip cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }} content={<TipBox rows={(d) => [
            [a.label, fmtValue(unit, d[a.key]), a.color], [b.label, fmtValue(unit, d[b.key]), b.color],
          ]} />} />
          {[a, b].map((s) => (
            <Line key={s.key} type={type} dataKey={s.key} stroke={s.color} strokeWidth={2} isAnimationActive={false} connectNulls={false}
              dot={(props) => (props.index === data.length - 1 && props.value !== null
                ? <circle key={`e${s.key}`} cx={props.cx} cy={props.cy} r={4.5} fill={s.color} stroke="var(--card)" strokeWidth={2} />
                : <g key={`n${s.key}${props.index}`} />)}
              activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function pctDomain(points, keys) {
  const vals = points.flatMap((p) => keys.map((k) => p[k])).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return [0.75, 1];
  const lo = Math.min(0.75, Math.floor(Math.min(...vals) * 20) / 20);
  return [lo, 1];
}

function moneyDomain(points, keys) {
  const vals = points.flatMap((p) => keys.map((k) => p[k])).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return [0, 'auto'];
  return [Math.floor(Math.min(...vals) / 10) * 10 - 10, Math.ceil(Math.max(...vals) / 10) * 10 + 10];
}

function Funnel({ m, month }) {
  const leads = m.leads?.actual, res = m.reservations?.actual, conv = m.reservations_converted?.actual;
  const w = (v) => (leads ? `${Math.max(8, Math.min(100, (v / leads) * 100))}%` : '100%');
  const steps = [['Inquiries', leads, 'ob-f1'], ['Reservations', res, 'ob-f2'], ['Moved in', conv, 'ob-f3']];
  const lr = m.reservations && leads ? (res ?? null) / leads : null;
  return (
    <div className="ob-funnel">
      {steps.map(([label, v, cls], i) => (
        <div key={label}>
          {i === 1 && <p className="ob-funnel-step"><ChevronDown size={13} aria-hidden="true" /> {lr === null || res === null || res === undefined ? DASH : `${(lr * 100).toFixed(1)}%`} of inquiries reserved a unit</p>}
          {i === 2 && <p className="ob-funnel-step"><ChevronDown size={13} aria-hidden="true" /> {fmtValue('pct', m.reservation_to_move_in?.actual)} of reservations moved in
            {m.reservation_to_move_in?.budget !== null && m.reservation_to_move_in?.budget !== undefined ? ` (target ${fmtValue('pct', m.reservation_to_move_in.budget)})` : ''}</p>}
          <div className={`ob-funnel-bar ${cls}`} style={{ width: v === null || v === undefined ? '100%' : w(v) }}
            title={`${label}, ${monthText(month, { long: true })}: ${fmtValue('count', v)}`}>
            <b className="ob-num">{fmtValue('count', v)}</b> {label}
          </div>
        </div>
      ))}
      <p className="ops-note" style={{ margin: '10px 0 0' }}>Website visitors are added at the top once the website analytics connection is live.</p>
    </div>
  );
}

function Ring({ value, label }) {
  const r = 34, c = 2 * Math.PI * r;
  const f = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value));
  return (
    <svg viewBox="0 0 84 84" className="ob-ring" role="img" aria-label={`${label}: ${fmtValue('pct', value)}`}>
      <circle cx="42" cy="42" r={r} fill="none" stroke="var(--ops-grid)" strokeWidth="9" />
      {value !== null && value !== undefined && (
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--ops-s1)" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 42 42)" />
      )}
      <text x="42" y="46" textAnchor="middle" className="ob-ring-text">{fmtValue('pct', value)}</text>
    </svg>
  );
}

function RingCard({ title, m, note }) {
  return (
    <Card title={title} className="ob-small">
      <div className="ob-ring-row">
        <Ring value={m.actual} label={title} />
        <div>
          <VarPill unit="pct" variance={m.vsBudget} suffix=" vs target" />
          <p className="ob-ring-meta">Target {fmtValue('pct', m.budget)} · Last year {fmtValue('pct', m.lastYear)}</p>
        </div>
      </div>
      <p className="ob-card-note">{note}</p>
    </Card>
  );
}

const BUCKETS = [['ar_1_30', 'Under 30 days', 'var(--ob-age-1)'], ['ar_31_60', '31-60 days', 'var(--ob-age-2)'],
  ['ar_61_90', '61-90 days', 'var(--ob-age-3)'], ['ar_90_plus', 'Over 90 days', 'var(--ob-age-4)']];

function UnpaidCard({ m }) {
  const total = m.total_past_due?.actual;
  const share = m.share_over_30?.actual;
  return (
    <Card title="Unpaid Rent" className="ob-small">
      <div className="ob-kpi-top">
        <span className="ob-kpi-value ob-kpi-value-sm">{fmtValue('money', total)}</span>
        <VarPill unit="money" variance={m.total_past_due?.vsLastYear} suffix=" vs last yr" />
      </div>
      <div className="ob-stack" role="img" aria-label="Unpaid rent by age">
        {total ? BUCKETS.map(([k, label, color]) => {
          const v = m[k]?.actual || 0;
          return v > 0 ? <span key={k} style={{ flexGrow: v, background: color }} title={`${label}: ${fmtValue('money', v)}`} /> : null;
        }) : <span className="ob-stack-empty" />}
      </div>
      <ul className="ob-stack-legend">
        {BUCKETS.map(([k, label, color]) => (
          <li key={k}><i style={{ background: color }} />{label} <b className="ob-num">{fmtValue('money', m[k]?.actual)}</b></li>
        ))}
      </ul>
      <p className="ob-card-note">{share === null || share === undefined ? 'The share of unpaid rent more than a month late shows once every age bucket has a figure.'
        : `${fmtValue('pct', share)} of unpaid rent is more than a month late. These accounts move toward lien.`}</p>
    </Card>
  );
}

function CountBox({ title, m }) {
  return (
    <div className="ob-countbox">
      <div className="ob-countbox-title">{title}</div>
      <div className="ob-kpi-value ob-kpi-value-sm">{fmtValue('count', m?.actual)}</div>
      <div className="ob-ring-meta">Budget {fmtValue('count', m?.budget)} · Last year {fmtValue('count', m?.lastYear)}</div>
    </div>
  );
}

function LiensCard({ m, vehicle }) {
  return (
    <Card title="Liens & Tows" className="ob-small">
      <CountBox title="Liens completed" m={m.liens} />
      {vehicle ? <CountBox title="Tows completed" m={m.tows} /> : <p className="ob-card-note">Tows are tracked for vehicle storage only.</p>}
    </Card>
  );
}

// ── All numbers ──────────────────────────────────────────────────────────────

function Cell({ m, v }) {
  if (m.pending && v === m.actual) return <span className="ob-pending">Pending API</span>;
  return fmtValue(m.unit, v);
}

export function AllNumbers({ report }) {
  const [open, setOpen] = useState(false);
  const groups = report.sections.map((s) => ({ ...s, rows: report.metrics.filter((m) => m.section === s.key) })).filter((g) => g.rows.length);
  return (
    <section className="dash-card ob-card" aria-label="All numbers">
      <div className="ob-card-head">
        <div>
          <h3 className="ob-card-title">All Numbers</h3>
          <p className="ob-card-sub">Every metric: budget, actual and last year, for the detail-minded.</p>
        </div>
        <button type="button" className="secondary-btn ob-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <>Hide Numbers <ChevronUp size={14} aria-hidden="true" /></> : <>Show All Numbers <ChevronDown size={14} aria-hidden="true" /></>}
        </button>
      </div>
      {open && (
        <div className="ob-table-wrap">
          <table className="req-table ob-table">
            <thead>
              <tr><th>Metric</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Vs Budget</th>
                <th className="num">Last Year</th><th className="num">Vs Last Year</th></tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key}>
                <tr className="ob-group"><th colSpan={6} scope="colgroup">{g.label}</th></tr>
                {g.rows.map((m) => (
                  <tr key={m.key} className={m.isRate ? 'ob-rate' : ''}>
                    <th scope="row">{m.label}</th>
                    <td className="num">{fmtValue(m.unit, m.budget)}</td>
                    <td className="num ob-actual" title={m.source ? `From ${m.source.replace('cubby_api', 'Cubby').replace('workbook', 'the workbook')}${m.otherSource !== null && m.otherSource !== undefined ? ` (the other source says ${fmtValue(m.unit, m.otherSource)})` : ''}` : undefined}>
                      <Cell m={m} v={m.actual} />
                    </td>
                    <td className="num"><VarPill unit={m.unit} variance={m.vsBudget} /></td>
                    <td className="num">{fmtValue(m.unit, m.lastYear)}</td>
                    <td className="num"><VarPill unit={m.unit} variance={m.vsLastYear} /></td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

export default function OpsBudget() {
  const [meta, setMeta] = useState({ status: 'loading', data: null, error: null });
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = useCallback((patch) => setPrefsState((p) => { const n = { ...p, ...patch }; savePrefs(n); return n; }), []);
  const [rep, setRep] = useState({ status: 'loading', report: null, trend: null, error: null });
  const [uploadOpen, setUploadOpen] = useState(false);

  const loadMeta = useCallback(async () => {
    try {
      const data = await api.getOpsBudgetFacilities();
      setMeta({ status: 'ready', data, error: null });
    } catch (err) {
      console.error('Ops Budget: could not load the sites', err);
      setMeta((s) => (s.data ? s : { status: 'error', data: null, error: err }));
    }
  }, []);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  const facilities = useMemo(() => meta.data?.facilities || [], [meta.data]);
  const facility = facilities.find((f) => f.id === prefs.facility) || facilities[0];
  const segment = prefs.segment === 'vehicle' ? 'vehicle' : 'self_storage';
  const period = prefs.period === 'ytd' ? 'ytd' : 'month';
  const months = useMemo(() => (meta.data ? monthOptions(meta.data.historyFrom, meta.data.currentMonth) : []), [meta.data]);
  const month = months.includes(prefs.month) ? prefs.month : meta.data?.defaultMonth;

  const loadReport = useCallback(async () => {
    if (!facility || !month) return;
    setRep((s) => ({ ...s, status: s.report ? 'refreshing' : 'loading', error: null }));
    try {
      const [report, trend] = await Promise.all([
        api.getOpsBudget({ facility: facility.id, segment, month, period }),
        api.getOpsBudgetTrend({ facility: facility.id, segment, month, months: 24 }),
      ]);
      setRep({ status: 'ready', report, trend, error: null });
    } catch (err) {
      console.error('Ops Budget: could not load the figures', err);
      setRep((s) => ({ ...s, status: 'error', error: err }));
    }
  }, [facility, segment, month, period]);
  useEffect(() => { loadReport(); }, [loadReport]);

  const fyStart = facility?.fiscalStartMonth || 1;
  const fiscal = `${MONTH_SHORT[fyStart - 1]}-${MONTH_SHORT[(fyStart + 10) % 12]}`;

  if (meta.status === 'loading') return <div className="ob-root"><SkeletonBlocks count={4} height={120} /></div>;
  if (meta.status === 'error') return <ErrorBanner message="Couldn't load the Ops Budget sites." onRetry={loadMeta} />;

  const r = rep.report;
  const m = r ? byKey(r) : {};
  const trend = rep.trend?.points || [];
  const vehicle = segment === 'vehicle';

  return (
    <div className="ob-root ops-root">
      <header className="ob-header">
        <div>
          <h2 className="ob-title">Ops Budget</h2>
          <p className="ob-subtitle">How each site is doing against plan and against last year</p>
        </div>
        <div className="ob-filters">
          <label className="ops-period"><span>Facility</span>
            <select value={facility?.id || ''} onChange={(e) => setPrefs({ facility: e.target.value })}>
              {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="ops-period"><span>Month</span>
            <select value={month || ''} onChange={(e) => setPrefs({ month: e.target.value })}>
              {months.map((mo) => <option key={mo} value={mo}>{monthText(mo)}</option>)}
            </select>
          </label>
          <Seg label="Period" value={period} onChange={(v) => setPrefs({ period: v })} options={[['month', 'Month'], ['ytd', 'Year to Date']]} />
          {meta.data?.canUpload && (
            <button type="button" className="secondary-btn ob-upload-btn" onClick={() => setUploadOpen(true)}>
              <Upload size={14} aria-hidden="true" /> Upload Workbook
            </button>
          )}
        </div>
      </header>
      <div className="ob-subbar">
        <Seg label="Segment" value={segment} onChange={(v) => setPrefs({ segment: v })} options={[['self_storage', 'Self-Storage'], ['vehicle', 'Vehicle Storage']]} />
        <span className="ops-note ob-loaded">
          {facility?.lastWorkbookAt ? `Workbook loaded ${formatDate(facility.lastWorkbookAt)}` : 'No workbook loaded for this site yet'}
          {facility?.lastCubbyAt ? ` · Cubby actuals updated ${formatDate(facility.lastCubbyAt)}` : ''}
        </span>
      </div>

      {rep.status === 'loading' && <SkeletonBlocks count={5} height={140} />}
      {rep.status === 'error' && !r && <ErrorBanner message="Couldn't load the Ops Budget figures." onRetry={loadReport} />}
      {rep.status === 'error' && r && <ErrorBanner message="Couldn't refresh the figures. These are the last ones loaded." onRetry={loadReport} />}

      {r && (
        <div className="ob-body" aria-busy={rep.status === 'refreshing'}>
          <SummaryCard report={r} />

          <div className="ob-kpis">
            <OccKpi m={m.unit_occupancy} title="Units Rented" sub="Share of units with a tenant" />
            <OccKpi m={m.sqft_occupancy} title="Space Rented" sub="Share of square footage with a tenant" />
            <OccKpi m={m.economic_occupancy} title="Revenue Captured" sub="Rent earned vs. full price on every unit" />
            <IncomeKpi m={m.rental_income} />
          </div>

          <div className="ob-grid-2">
            <Card title="Customers In vs. Out" right="Last 12 months">
              {rep.trend?.takeaways?.inout && <p className="ob-takeaway">{rep.trend.takeaways.inout}</p>}
              <Legend items={[['Move-ins', 'var(--ops-s1)'], ['Move-outs', 'var(--ops-s2)']]} />
              <InOutChart points={trend.slice(-12)} />
            </Card>
            <Card title="From Inquiry to Move-In" right={r.periodLabel}>
              {r.funnelTakeaway && <p className="ob-takeaway">{r.funnelTakeaway}</p>}
              <Funnel m={m} month={r.month} />
            </Card>
          </div>

          <div className="ob-grid-2">
            <Card title="Occupancy Over Two Years" right="Actual, month-end">
              <Legend items={[['Units rented', 'var(--ops-s1)'], ['Revenue (economic)', 'var(--ops-s2)']]} />
              <TwoLines points={trend} unit="pct" domain={pctDomain(trend, ['unit_occupancy', 'economic_occupancy'])}
                a={{ key: 'unit_occupancy', label: 'Units Rented', color: 'var(--ops-s1)' }}
                b={{ key: 'economic_occupancy', label: 'Revenue (Economic)', color: 'var(--ops-s2)' }}
                empty="Occupancy draws once two months have figures." />
              {rep.trend?.takeaways?.occupancy && <p className="ob-takeaway ob-takeaway-after">{rep.trend.takeaways.occupancy}</p>}
            </Card>
            <Card title="What We Charge" right="Average monthly rate">
              <Legend items={[[`Standard rate ${fmtValue('rate', m.avg_standard_rate?.actual)}`, 'var(--ob-ink-series)'], [`Web rate ${fmtValue('rate', m.avg_web_rate?.actual)}`, 'var(--ops-s1)']]} />
              <TwoLines points={trend} unit="rate" step domain={moneyDomain(trend, ['avg_standard_rate', 'avg_web_rate'])}
                a={{ key: 'avg_standard_rate', label: 'Standard Rate', color: 'var(--ob-ink-series)' }}
                b={{ key: 'avg_web_rate', label: 'Web Rate', color: 'var(--ops-s1)' }}
                empty="Rates draw once two months have figures." />
              {rep.trend?.takeaways?.rates && <p className="ob-takeaway ob-takeaway-after">{rep.trend.takeaways.rates}</p>}
            </Card>
          </div>

          <div className="ob-grid-4">
            <RingCard title="Customers on Autopay" m={m.autopay_pct} note="Autopay tenants pay on time more often." />
            <RingCard title="New Rentals With Insurance" m={m.insurance_take_rate} note="Share of new move-ins who added coverage." />
            <UnpaidCard m={m} />
            <LiensCard m={m} vehicle={vehicle} />
          </div>

          <AllNumbers report={r} />

          <p className="ops-note ob-footer">
            Greens Storage · Ops Budget · Fiscal year {fiscal}. {r.notes.join(' ')} Website visitors and reviews switch on once their API connections are live.
          </p>
        </div>
      )}

      {uploadOpen && (
        <OpsBudgetUpload facilities={facilities} current={facility?.id || ''} onClose={() => setUploadOpen(false)}
          onSaved={() => { loadMeta(); loadReport(); }} />
      )}
    </div>
  );
}
