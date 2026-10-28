// People > Analytics (Neil, Oct 27 2026): headcount over time, joiners and
// leavers, attrition, tenure, absence and leave liability.
//
// Every number is the server's (GET /hr/analytics/summary, calculated in
// backend/hr_analytics.py) - this screen never computes a metric, it only
// draws them. Each count opens the people behind it (GET /hr/analytics/people),
// built from the same dataset, so a card and its list always agree.
//
// The look is the Insights board's (dashboard/BiInsights.jsx): content-sized
// `.dash-card.bi-card` cards, labeled counts in `.bi-stats` rows that open a
// breakdown, `.bi-split` / `.bi-stages` for shares. No chart-type pickers, no
// drag canvas (Neil, Oct 13). Bars appear only where the shape over the
// months is the point.
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Users, ArrowLeftRight, TrendingDown, Hourglass, CalendarOff, Wallet, X, ChevronRight, Info,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, LoadingState, ErrorBanner } from './AsyncState';
import { formatDate } from '../lib/datetime';
import { formatCost } from '../asset/lib/currency';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthShort = (key) => MONTHS[Number(String(key).slice(5, 7)) - 1] || key;
const monthLong = (key) => `${monthShort(key)} ${String(key).slice(0, 4)}`;
// en-US grouping on purpose: a bare toLocaleString() reads 1,23,456 in India.
const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-');
const pct = (n) => (typeof n === 'number' ? `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : '-');
const C = (color) => `hsl(var(--color-${color}))`;

const TYPES = [
  { value: 'employees', label: 'Employees', hint: 'Full-time, part-time and interns' },
  { value: 'contractors', label: 'Contractors', hint: 'Independent contractors only' },
  { value: 'all', label: 'Everyone', hint: 'Employees and contractors' },
];
const SPLITS = [
  { value: 'Company', label: 'Company' },
  { value: 'Department', label: 'Department' },
  { value: 'Type', label: 'Type' },
];
const CATEGORY_COLOR = { voluntary: 'orange', involuntary: 'red', other: 'purple', not_recorded: 'gray' };
const REASON_COLOR = { vacation: 'blue', sick: 'red', personal: 'purple', other: 'orange' };
const toneOf = (color) => (color === 'gray' ? 'var(--wk-faint)' : C(color));

function addMonths(key, n) {
  const y = Number(key.slice(0, 4)); const m = Number(key.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

// ── Pieces in the Insights idiom ─────────────────────────────────────────────
function Card({ Icon, color, title, sub, children }) {
  return (
    <section className="dash-card bi-card" aria-label={title}>
      <div className="dash-card-head" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span className={`dk-chip dk-chip--${color}`}><Icon /></span>
          <div style={{ minWidth: 0 }}>
            <div className="dash-card-title">{title}</div>
            {sub && <div className="dash-card-sub">{sub}</div>}
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, onDrill, color }) {
  const Row = onDrill ? 'button' : 'div';
  return (
    <Row type={onDrill ? 'button' : undefined} className={`bi-stat${onDrill ? ' bi-stat--drill' : ''}`}
      onClick={onDrill} title={onDrill ? `See who is behind ${label}` : undefined}>
      <span className="bi-stat-label">
        {color && <i className="bi-dot" style={{ background: toneOf(color) }} />}
        <span className="bi-stat-text">{label}</span>
      </span>
      <span className="bi-stat-value" style={{ color: 'var(--ink)' }}>{value}</span>
      {onDrill && <ChevronRight size={14} className="bi-stat-chev" />}
    </Row>
  );
}

// Monthly bars: one column per month, stacked segments, each column opens
// that month's people. Labels every month when there is room, else every third.
function MonthBars({ rows, segments, onPick, format = count, label }) {
  const totals = rows.map((r) => segments.reduce((a, s) => a + (Number(r[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const every = rows.length > 18 ? 3 : rows.length > 12 ? 2 : 1;
  return (
    <div className="bi-shape">
      {label && <div className="bi-shape-label">{label}</div>}
      <div className="hra-bars" role="list">
        {rows.map((r, i) => {
          const tip = `${monthLong(r.month)}: ${segments.map((s) => `${s.label} ${format(Number(r[s.key]) || 0)}`).join(', ')}`;
          return (
            <button key={r.month} type="button" role="listitem" className="hra-bar" onClick={() => onPick?.(r.month)}
              title={tip} aria-label={tip} disabled={!onPick}>
              <span className="hra-bar-stack" style={{ height: `${Math.max(totals[i] ? 6 : 2, (totals[i] / max) * 100)}%` }}>
                {segments.map((s) => {
                  const v = Number(r[s.key]) || 0;
                  return v > 0 ? <i key={s.key} style={{ flexGrow: v, background: toneOf(s.color) }} /> : null;
                })}
                {!totals[i] && <i style={{ flexGrow: 1, background: 'var(--mist)' }} />}
              </span>
            </button>
          );
        })}
      </div>
      <div className="hra-bar-axis">
        {rows.map((r, i) => (
          <span key={r.month}>{i % every === 0 || i === rows.length - 1 ? monthShort(r.month) : ''}</span>
        ))}
      </div>
      {segments.length > 1 && (
        <div className="bi-legend">
          {segments.map((s) => <span key={s.key}><i style={{ background: toneOf(s.color) }} />{s.label}</span>)}
        </div>
      )}
    </div>
  );
}

// Paired joiner / leaver columns per month.
function FlowBars({ rows, onPick }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.joiners, r.leavers)));
  const every = rows.length > 18 ? 3 : rows.length > 12 ? 2 : 1;
  const h = (n) => `${n ? Math.max(6, (n / max) * 100) : 2}%`;
  return (
    <div className="bi-shape">
      <div className="hra-bars" role="list">
        {rows.map((r) => (
          <span key={r.month} role="listitem" className="hra-pair">
            <button type="button" className="hra-bar" onClick={() => onPick('joiners', r.month)}
              title={`${monthLong(r.month)}: ${r.joiners} joined`} aria-label={`${monthLong(r.month)}: ${r.joiners} joined`}>
              <span className="hra-bar-stack" style={{ height: h(r.joiners) }}>
                <i style={{ flexGrow: 1, background: r.joiners ? C('green') : 'var(--mist)' }} />
              </span>
            </button>
            <button type="button" className="hra-bar" onClick={() => onPick('leavers', r.month)}
              title={`${monthLong(r.month)}: ${r.leavers} left`} aria-label={`${monthLong(r.month)}: ${r.leavers} left`}>
              <span className="hra-bar-stack" style={{ height: h(r.leavers) }}>
                <i style={{ flexGrow: 1, background: r.leavers ? C('orange') : 'var(--mist)' }} />
              </span>
            </button>
          </span>
        ))}
      </div>
      <div className="hra-bar-axis">
        {rows.map((r, i) => <span key={r.month}>{i % every === 0 || i === rows.length - 1 ? monthShort(r.month) : ''}</span>)}
      </div>
      <div className="bi-legend">
        <span><i style={{ background: C('green') }} />Joiners</span>
        <span><i style={{ background: C('orange') }} />Leavers</span>
      </div>
    </div>
  );
}

// A share of the whole, as one segmented bar with a legend that drills.
function Split({ rows, onPick }) {
  const live = rows.filter((r) => r.value > 0);
  const total = live.reduce((a, r) => a + r.value, 0);
  if (!total) return null;
  return (
    <div className="bi-shape">
      <div className="bi-split">
        {live.map((r) => <span key={r.key} title={`${r.label}: ${count(r.value)}`} style={{ width: `${(r.value / total) * 100}%`, background: toneOf(r.color) }} />)}
      </div>
      <div className="bi-legend">
        {rows.map((r) => (
          <button key={r.key} type="button" className="hra-legend-btn" onClick={() => onPick(r.key)} title={`See who is behind ${r.label}`}>
            <i style={{ background: toneOf(r.color) }} />{r.label} <b>{count(r.value)}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function Stages({ rows, onPick, label }) {
  const max = Math.max(1, ...rows.map((r) => r.n || 0));
  return (
    <div className="bi-shape">
      {label && <div className="bi-shape-label">{label}</div>}
      <div className="bi-stages">
        {rows.map((r) => (
          <button key={r.key ?? r.label} type="button" className="bi-stage hra-stage" onClick={() => onPick(r)} title={`See who is behind ${r.label}`}>
            <span className="bi-stage-label">{r.label}</span>
            <span className="bi-stage-bar"><i style={{ width: `${((r.n || 0) / max) * 100}%` }} /></span>
            <span className="bi-stage-num">{count(r.n)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Tones({ options, value, onChange, label }) {
  return (
    <div className="bi-tones" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.hint}
          className={`bi-tone${value === o.value ? ' bi-tone--on' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────
function HeadcountCard({ hc, onDrill }) {
  const [split, setSplit] = useState('Company');
  const last = hc.months[hc.months.length - 1];
  const parts = (last?.[`by${split}`] || []).map((r) => ({ ...r, key: r.label }));
  return (
    <Card Icon={Users} color="blue" title="Headcount" sub="Everyone employed on each month's last day">
      <div className="bi-stats">
        <Stat label="Headcount Today" value={count(hc.now)} onDrill={() => onDrill({ metric: 'headcount' })} />
        <Stat label="Average Month-End" value={count(hc.average)} />
      </div>
      <MonthBars rows={hc.months} segments={[{ key: 'total', label: 'Headcount', color: 'blue' }]}
        onPick={(month) => onDrill({ metric: 'headcount', month })} />
      {last && (
        <div className="bi-shape">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="bi-shape-label" style={{ margin: 0 }}>Split On {formatDate(last.asOf)}</span>
            <Tones options={SPLITS} value={split} onChange={setSplit} label="Split by" />
          </div>
          {parts.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nobody was employed on that day.</div> : (
            <div className="bi-stages">
              {parts.map((r) => (
                <button key={r.key} type="button" className="bi-stage hra-stage" title={`See who is behind ${r.label}`}
                  onClick={() => onDrill({ metric: 'headcount', month: last.month, key: `${split.toLowerCase()}:${r.label}` })}>
                  <span className="bi-stage-label">{r.label}</span>
                  <span className="bi-stage-bar"><i style={{ width: `${(r.n / Math.max(1, last.total)) * 100}%` }} /></span>
                  <span className="bi-stage-num">{count(r.n)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function FlowCard({ flow, onDrill }) {
  return (
    <Card Icon={ArrowLeftRight} color="green" title="Joiners And Leavers" sub="Starts and last days in each month">
      <div className="bi-stats">
        <Stat label="Joiners" value={count(flow.joiners)} color="green" onDrill={() => onDrill({ metric: 'joiners' })} />
        <Stat label="Leavers" value={count(flow.leavers)} color="orange" onDrill={() => onDrill({ metric: 'leavers' })} />
        <Stat label="Rehires Among Joiners" value={count(flow.rehires)} />
      </div>
      <FlowBars rows={flow.months} onPick={(metric, month) => onDrill({ metric, month })} />
    </Card>
  );
}

function AttritionCard({ at, onDrill }) {
  const t = at.trailing12 || {};
  const cats = (at.byCategory || []).map((c) => ({ key: c.key, label: c.label, value: c.n, color: CATEGORY_COLOR[c.key] }));
  // The bars stack the server's monthly rates; Other and Not Recorded share
  // one shade (otherRate).
  return (
    <Card Icon={TrendingDown} color="orange" title="Attrition" sub="Leavers over average headcount">
      <div className="bi-stats">
        <Stat label="Trailing 12 Months" value={pct(t.trailing12)} />
        <Stat label="Voluntary, Trailing 12 Months" value={pct(t.trailing12Voluntary)} color="orange" />
        <Stat label="Involuntary, Trailing 12 Months" value={pct(t.trailing12Involuntary)} color="red" />
        <Stat label="Over The Range" value={pct(at.range?.rate)} onDrill={() => onDrill({ metric: 'leavers' })} />
      </div>
      <MonthBars rows={at.months} label="Monthly attrition rate" format={pct}
        segments={[{ key: 'voluntaryRate', label: 'Voluntary', color: 'orange' }, { key: 'involuntaryRate', label: 'Involuntary', color: 'red' },
          { key: 'otherRate', label: 'Other Or Not Recorded', color: 'gray' }]}
        onPick={(month) => onDrill({ metric: 'leavers', month })} />
      <Split rows={cats} onPick={(key) => onDrill({ metric: 'leavers', key })} />
    </Card>
  );
}

function TenureCard({ tenure, onDrill }) {
  return (
    <Card Icon={Hourglass} color="purple" title="Tenure" sub="Active people, from their current start date">
      <div className="bi-stats">
        <Stat label="Active People" value={count(tenure.total)} onDrill={() => onDrill({ metric: 'tenure' })} />
      </div>
      <Stages rows={tenure.bands} onPick={(r) => onDrill({ metric: 'tenure', key: r.key })} />
    </Card>
  );
}

function AbsenceCard({ ab, onDrill }) {
  const reasons = (ab.byReason || []).map((r) => ({ key: r.key, label: r.label, value: r.days, color: REASON_COLOR[r.key] }));
  const rows = ab.months.map((m) => ({ month: m.month, ...m.byReason }));
  return (
    <Card Icon={CalendarOff} color="red" title="Absence" sub="Approved time off and leave punches, in days">
      <div className="bi-stats">
        <Stat label="Days Off" value={count(ab.days)} onDrill={() => onDrill({ metric: 'absence' })} />
        <Stat label="Unplanned Sick Days" value={count(ab.unplannedSick)} color="red" onDrill={() => onDrill({ metric: 'absence', key: 'unplanned' })} />
      </div>
      <MonthBars rows={rows} segments={(ab.byReason || []).map((r) => ({ key: r.key, label: r.label, color: REASON_COLOR[r.key] }))}
        onPick={(month) => onDrill({ metric: 'absence', month })} />
      <Split rows={reasons} onPick={(key) => onDrill({ metric: 'absence', key })} />
    </Card>
  );
}

function LiabilityCard({ li, money, onDrill }) {
  return (
    <Card Icon={Wallet} color="brand" title="Leave Liability" sub="Unused vacation of people employed today">
      <div className="bi-stats">
        <Stat label="Unused Vacation Hours" value={count(li.hours)} onDrill={() => onDrill({ metric: 'liability' })} />
        <Stat label="People With Unused Vacation" value={count(li.people)} />
        {money && (li.byCurrency || []).map((c) => (
          <Stat key={c.currency} label={`Owed In ${c.currency}`} value={formatCost(c.amount, c.currency)}
            onDrill={() => onDrill({ metric: 'liability', key: c.currency })} />
        ))}
        {money && li.noRate > 0 && <Stat label="No Pay Rate On File" value={count(li.noRate)} onDrill={() => onDrill({ metric: 'liability' })} />}
      </div>
      <div className="bi-shape" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        {money
          ? 'Hours times the pay in effect today, kept per currency. Fixed pay counts the monthly salary over 260 working days a year.'
          : 'Amounts show to people with the Compensation grant. You see the hours.'}
        {li.people === 0 && ' Balances count once HR sets the start date under Leave.'}
      </div>
    </Card>
  );
}

// ── The people behind a number ───────────────────────────────────────────────
function DrillModal({ request, filters, money, onClose, onOpenPerson }) {
  const [state, setState] = useState({ loading: true, rows: [], title: '', error: '' });
  const closeRef = useRef(null);
  useEffect(() => {
    let alive = true;
    api.getHrAnalyticsPeople({ ...filters, metric: request.metric, month: request.month || '', key: request.key || '' })
      .then((r) => { if (alive) setState({ loading: false, rows: r?.rows || [], title: r?.title || '', error: '' }); })
      .catch((e) => { if (alive) setState({ loading: false, rows: [], title: '', error: e?.message || 'Could not load the list.' }); });
    return () => { alive = false; };
  }, [request, filters]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const before = document.activeElement;
    closeRef.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); if (before && typeof before.focus === 'function') before.focus(); };
  }, [onClose]);
  return (
    <div className="bi-scrim" onClick={onClose} role="presentation">
      <div className="bi-modal nx-popup" role="dialog" aria-modal="true" aria-label={state.title || 'People'} onClick={(e) => e.stopPropagation()}>
        <div className="bi-modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="dash-card-title">{state.title || 'People'}</div>
            <div className="dash-card-sub">
              People Analytics{!state.loading && !state.error && ` · ${state.rows.length} ${state.rows.length === 1 ? 'person' : 'people'}`}
            </div>
          </div>
          <button ref={closeRef} type="button" className="bi-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="bi-modal-body" style={{ display: 'flex', flexDirection: 'column' }}>
          {state.loading ? <LoadingState compact />
            : state.error ? <div className="bi-empty">{state.error}</div>
            : state.rows.length === 0 ? <div className="bi-empty">Nobody is behind this number.</div>
            : (
              <div className="nx-fill" style={{ overflow: 'auto' }}>
              <div className="bi-table">
                {state.rows.map((r, i) => (
                  <button key={`${r.id}-${i}`} type="button" className="bi-table-row hra-person" onClick={() => { onClose(); onOpenPerson?.(r.id); }}
                    title={`Open ${r.name}`}>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, textAlign: 'left' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      <span>{r.detail}</span>
                      {money && r.amount != null && <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{formatCost(r.amount, r.currency)}</span>}
                    </span>
                  </button>
                ))}
              </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────
export default function HrAnalytics({ onOpenPerson }) {
  const [filters, setFilters] = useState({ company: '', type: 'employees', from_month: '', to_month: '' });
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [drill, setDrill] = useState(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    api.getHrAnalytics(filters)
      .then((data) => { if (n === seq.current) setState({ loading: false, data: data && data.range ? data : null, error: data && data.range ? '' : 'Could not load People Analytics.' }); })
      .catch((e) => { if (n === seq.current) setState({ loading: false, data: null, error: e?.message || 'Could not load People Analytics.' }); });
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  const closeDrill = useCallback(() => setDrill(null), []);
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  const d = state.data;
  const today = d?.today ? d.today.slice(0, 7) : '';
  const monthOptions = today ? Array.from({ length: 36 }, (_, i) => addMonths(today, -i)) : [];
  const from = filters.from_month || d?.range?.from || '';
  const to = filters.to_month || d?.range?.to || '';
  const dq = d?.dataQuality || {};

  return (
    <div className="bi-root" style={{ gap: 16 }}>
      <div className="bi-section-head">
        <div>
          <h3 className="bi-section-title">People Analytics</h3>
          <div className="bi-section-sub">
            Click a count to see the people behind it. Months follow {filters.company ? "the company's" : 'each company\'s'} own calendar.
          </div>
        </div>
        <div className="bi-filters">
          <select className="form-input" aria-label="Company" value={filters.company} onChange={(e) => set('company', e.target.value)} style={{ width: 'auto', minWidth: 160 }}>
            <option value="">All Companies</option>
            {(d?.companies || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Tones options={TYPES} value={filters.type} onChange={(v) => set('type', v)} label="Who is counted" />
          <select className="form-input" aria-label="From month" value={from} onChange={(e) => set('from_month', e.target.value)} style={{ width: 'auto' }} disabled={!monthOptions.length}>
            {monthOptions.filter((m) => !to || m <= to).map((m) => <option key={m} value={m}>From {monthLong(m)}</option>)}
          </select>
          <select className="form-input" aria-label="To month" value={to} onChange={(e) => set('to_month', e.target.value)} style={{ width: 'auto' }} disabled={!monthOptions.length}>
            {monthOptions.filter((m) => !from || m >= from).map((m) => <option key={m} value={m}>To {monthLong(m)}</option>)}
          </select>
        </div>
      </div>

      {state.loading ? <SkeletonBlocks count={6} height={260} gridTemplateColumns="repeat(auto-fill, minmax(330px, 1fr))" />
        : state.error ? <ErrorBanner message={state.error} onRetry={() => { setState((s) => ({ ...s, loading: true, error: '' })); load(); }} retryLabel="Try Again" />
        : (
          <>
            {(dq.noStartDate > 0 || dq.leftUndated > 0) && (
              <div className="hra-note">
                <Info size={14} />
                <span>
                  {dq.noStartDate > 0 && `${dq.noStartDate} ${dq.noStartDate === 1 ? 'person has' : 'people have'} no start date - counted in every month's headcount, never as a joiner. `}
                  {dq.leftUndated > 0 && `${dq.leftUndated} ${dq.leftUndated === 1 ? 'person is' : 'people are'} marked Left with no leaving date - not counted.`}
                </span>
              </div>
            )}
            <div className="bi-grid">
              {d.headcount && <HeadcountCard hc={d.headcount} onDrill={setDrill} />}
              {d.flow && <FlowCard flow={d.flow} onDrill={setDrill} />}
              {d.attrition && <AttritionCard at={d.attrition} onDrill={setDrill} />}
              {d.tenure && <TenureCard tenure={d.tenure} onDrill={setDrill} />}
              {d.absence && <AbsenceCard ab={d.absence} onDrill={setDrill} />}
              {d.liability && <LiabilityCard li={d.liability} money={!!d.canSeeMoney} onDrill={setDrill} />}
            </div>
          </>
        )}

      {drill && <DrillModal key={`${drill.metric}:${drill.month || ''}:${drill.key || ''}`} request={drill} filters={filters}
        money={!!d?.canSeeMoney} onClose={closeDrill} onOpenPerson={onOpenPerson} />}
    </div>
  );
}
