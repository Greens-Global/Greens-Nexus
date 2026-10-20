// Operations > Portfolio (Neil, Oct 20 2026): CubeSmart's "Daily Flash", for
// every property we run and any set of them a person picks - "I want this
// property and this property, but I don't want this one."
//
// Layout follows the Daily Flash: move-in, move-out and square-foot occupancy
// trends (this year against last), occupancy by status, revenue, allowances,
// net rentals and net revenue. Every figure opens the list behind it, and the
// tables expand by property. A figure the data cannot support shows a dash
// and says why - nothing is estimated. Figures come from
// GET /facility-ops/portfolio (backend/ops_portfolio.py).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { Modal } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
import { formatDate } from '../lib/datetime';
import { count, money } from './model';
import { groupsOf, loadSelection, monthChoices, net, pctText, saveSelection, selectionLabel, signed, toggle } from './portfolioModel';
import { Legend } from './charts';
import SectionPicker from './SectionPicker';
import './portfolio.css';

const CY = 'var(--ops-s1)';
const PY = 'var(--ops-s2)';
const AXIS = { fontSize: 11.5, fill: 'var(--muted)' };

// ── Property picker ───────────────────────────────────────────────────────────

function PropertyPicker({ properties, ids, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const groups = useMemo(() => groupsOf(properties), [properties]);
  const chosen = (id) => (ids.length ? ids.includes(id) : properties.find((p) => p.id === id)?.connected);
  const sameAs = (list) => list.length === ids.length && list.every((x) => ids.includes(x));
  // The quick picks were a pill row; now one dropdown (Visesh, Oct 20).
  const quick = !ids.length ? 'all' : groups.find((g) => sameAs(g.ids))?.label || 'custom';
  const pickQuick = (v) => { if (v === 'all') onChange([]); else { const g = groups.find((x) => x.label === v); if (g) onChange(g.ids); } };
  return (
    <div className="pf-picker ops-facility" ref={box}>
      <span className="ops-facility-label">Properties</span>
      <span className="ops-facility-box">
        <SlidersHorizontal size={14} className="ops-facility-icon" aria-hidden="true" />
        <button type="button" className="ops-section-btn pf-picker-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
          {selectionLabel(ids, properties)}
        </button>
        <ChevronDown size={13} className="ops-facility-chev" aria-hidden="true" />
      </span>
      {open && (
        <div className="dash-card pf-picker-panel" role="group" aria-label="Choose properties">
          <SectionPicker label="Quick Pick" value={quick} onChange={pickQuick}
            options={[{ value: 'all', label: 'All Properties' }, ...groups.map((g) => ({ value: g.label, label: g.label })),
              ...(quick === 'custom' ? [{ value: 'custom', label: 'Custom Selection', disabled: true }] : [])]} />
          <ul className="pf-picker-list">
            {properties.map((p) => (
              <li key={p.id}>
                <label className={p.connected ? '' : 'pf-off'}>
                  <input type="checkbox" checked={!!chosen(p.id)} disabled={!p.connected}
                    onChange={() => onChange(toggle(ids, p.id, properties))} />
                  <span className="pf-picker-name">{p.shortName}</span>
                  <span className="pf-picker-meta">{p.connected ? [p.managedBy, p.market || p.state].filter(Boolean).join(' - ') : p.status}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="ops-note" style={{ margin: 0 }}>Your choice is remembered on this device.</p>
        </div>
      )}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Card({ title, sub, right, children }) {
  return (
    <div className="dash-card pf-card">
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">{title}</div>
          {sub && <div className="dash-card-sub">{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// A figure that opens its list; a dash (with the reason on hover) when there is none.
function Fig({ value, text, onOpen, why, label }) {
  if (value == null) return <span className="pf-na" title={why || 'Not available'}>-</span>;
  if (!onOpen) return <span>{text ?? value}</span>;
  return <button type="button" className="ops-cell" onClick={onOpen} aria-label={label ? `${label}: ${text ?? value}. Show the list` : undefined}>{text ?? value}</button>;
}

function Kpi({ label, value, sub, onOpen }) {
  return (
    <button type="button" className="kpi-card ops-kpi" onClick={onOpen} disabled={!onOpen} aria-label={`${label}, ${value}. Show the list`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-delta">{sub}</div>}
    </button>
  );
}

function Tip({ active, payload, fmt }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="ops-tip">
      <div className="ops-tip-title">{d.label}</div>
      <div className="ops-tip-row"><span><i style={{ background: CY }} />This Year</span><b>{d.cy == null ? 'No data' : fmt(d.cy)}</b></div>
      <div className="ops-tip-row"><span><i style={{ background: PY }} />Prior Year</span><b>{d.py == null ? 'No data before cutover' : fmt(d.py)}</b></div>
    </div>
  );
}

// This year against last, one month per point. Missing months are gaps, not zeros.
function TrendChart({ trend, field, fmt, onMonth }) {
  const data = trend.map((r) => ({ month: r.month, label: r.label, cy: r.cy ? r.cy[field] : null, py: r.py ? r.py[field] : null }));
  const has = data.some((d) => d.cy != null || d.py != null);
  if (!has) return <div className="ops-empty" style={{ height: 210, display: 'grid', placeItems: 'center' }}>No history for these months yet.</div>;
  const click = (s) => {
    const i = s?.activeTooltipIndex ?? s?.activeIndex;
    const row = data[Number(i)];
    if (row && row.cy != null) onMonth?.(row.month, row.label);
  };
  return (
    <div className="pf-chart-scroll">
      <div style={{ minWidth: 420, height: 210 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 14, bottom: 0, left: 0 }} onClick={click} style={{ cursor: onMonth ? 'pointer' : undefined }}>
            <CartesianGrid vertical={false} stroke="var(--ops-grid)" />
            <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={14} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} width={46} tickFormatter={fmt} domain={['auto', 'auto']} allowDecimals={false} />
            <Tooltip content={<Tip fmt={fmt} />} cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }} />
            <Line type="monotone" dataKey="cy" stroke={CY} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="py" stroke={PY} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// A row that opens to one line per property.
function Expand({ open, onToggle, label }) {
  return (
    <button type="button" className="pf-expand" aria-expanded={open} onClick={onToggle} aria-label={`${open ? 'Hide' : 'Show'} ${label} by property`}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{label}
    </button>
  );
}

// ── Drill-down ────────────────────────────────────────────────────────────────

const STATUS_LABEL = { occupied: 'Occupied', vacant: 'Vacant', reserved: 'Reserved', damaged: 'Damaged', unrentable: 'Unrentable' };

function DrillList({ drill, onClose }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const PER = 25;
  const query = q.trim().toLowerCase();
  const rows = query ? drill.rows.filter((r) => drill.columns.some((c) => String(c.text(r)).toLowerCase().includes(query))) : drill.rows;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const at = Math.min(page, pages - 1);
  return (
    <Modal title={drill.title} onClose={onClose}>
      <p className="ops-note" style={{ margin: '0 0 10px' }}>{count(drill.rows.length)} {drill.rows.length === 1 ? 'row' : 'rows'}{drill.sub ? ` - ${drill.sub}` : ''}</p>
      {drill.rows.length > PER && (
        <label className="ops-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={q} placeholder="Search this list" aria-label="Search this list" onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        </label>
      )}
      {rows.length ? (
        <div className="req-table-wrapper">
          <table className="req-table stack-table">
            <thead><tr>{drill.columns.map((c) => <th key={c.head} className={c.num ? 'num' : undefined}>{c.head}</th>)}</tr></thead>
            <tbody>
              {rows.slice(at * PER, at * PER + PER).map((r, i) => (
                <tr key={at * PER + i}>{drill.columns.map((c) => <td key={c.head} data-th={c.head} className={c.num ? 'num' : undefined}>{c.text(r)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="ops-empty">{drill.rows.length ? 'Nothing matches.' : 'Nothing to list.'}</div>}
      {pages > 1 && (
        <div className="ops-pager">
          <span>{`Page ${at + 1} of ${pages}`}</span>
          <span className="ops-pager-btns">
            <button type="button" className="secondary-btn" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</button>
            <button type="button" className="secondary-btn" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next</button>
          </span>
        </div>
      )}
    </Modal>
  );
}

const UNIT_COLS = [
  { head: 'Property', text: (r) => r.facility },
  { head: 'Unit', text: (r) => r.name },
  { head: 'Unit Type', text: (r) => r.type },
  { head: 'Status', text: (r) => STATUS_LABEL[r.status] || r.status },
  { head: 'Sq Ft', num: true, text: (r) => count(r.sqft) },
  { head: 'Tenant', text: (r) => r.tenant || '-' },
  { head: 'Rent', num: true, text: (r) => (r.rent ? money(r.rent) : '-') },
];
const MOVE_COLS = [
  { head: 'Date', text: (r) => formatDate(r.date) },
  { head: 'Property', text: (r) => r.facility },
  { head: 'Unit', text: (r) => r.unit },
  { head: 'Tenant', text: (r) => r.tenant || '-' },
  { head: 'Move', text: (r) => (r.kind === 'in' ? 'Move-In' : 'Move-Out') },
];
const PAY_COLS = [
  { head: 'Date', text: (r) => formatDate(r.date) },
  { head: 'Property', text: (r) => r.facility },
  { head: 'Tenant', text: (r) => r.tenant || '-' },
  { head: 'Amount', num: true, text: (r) => money(r.amount, { exact: true }) },
];

// ── The board ─────────────────────────────────────────────────────────────────

export default function Portfolio() {
  const role = useRole();
  const email = role?.realEmail || '';
  const [ids, setIds] = useState(() => loadSelection(email));
  const [month, setMonth] = useState('');
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [drill, setDrill] = useState(null);
  const [open, setOpen] = useState({});
  const flip = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: s.data ? 'ready' : 'loading', error: null }));
    try {
      const data = await api.getOpsPortfolio(ids, month);
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      console.error('Portfolio: could not load', err);
      setState((s) => ({ status: s.data ? 'ready' : 'error', data: s.data, error: err }));
    }
  }, [ids, month]);
  useEffect(() => { load(); }, [load]);

  const pick = (next) => { setIds(next); saveSelection(email, next); };
  const d = state.data;

  if (state.status === 'loading' && !d) return <LoadingState size="view" label="Adding up the portfolio" minHeight={320} onRetry={load} />;
  if (!d) return <ErrorBanner message="Couldn't load the portfolio figures." onRetry={load} />;

  const t = d.total;
  const lists = t.lists;
  const by = d.byProperty;
  const showBudget = d.budget.available;
  const occ = Object.fromEntries(t.occupancy.map((r) => [r.key, r]));
  const show = (title, rows, columns, sub) => setDrill({ title, rows, columns, sub });
  const units = (status) => show(`${STATUS_LABEL[status]} Units`, lists.units.filter((u) => u.status === status), UNIT_COLS);
  const moves = (title, from, to, kind) => show(title, lists.moves.filter((m) => m.date >= from && m.date <= to && (!kind || m.kind === kind)), MOVE_COLS,
    from === to ? formatDate(from) : `${formatDate(from)} - ${formatDate(to)}`);
  const monthStart = `${d.month}-01`;
  const monthMoves = (kind) => (ym, label) => {
    const end = ym === d.month ? d.through : `${ym}-31`;
    moves(`${kind === 'in' ? 'Move-Ins' : 'Move-Outs'} - ${label}`, `${ym}-01`, end, kind);
  };
  const nothing = !d.selected.length;

  return (
    <div className="ops-root pf-root">
      <div className="ops-bar-top">
        <PropertyPicker properties={d.properties} ids={ids} onChange={pick} />
        <label className="ops-period">
          <span>Month</span>
          <select value={month || d.month} onChange={(e) => setMonth(e.target.value)}>
            {monthChoices(d.asOf).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
      </div>
      <p className="ops-note">
        {`${monthChoices(d.asOf).find((m) => m.key === d.month)?.label || d.monthLabel} through ${formatDate(d.through)}. Occupancy is as of today. `}
        {d.notes.join(' ')}
      </p>

      {nothing ? (
        <div className="dash-card"><div className="ops-empty">None of the chosen properties is connected yet. Pick another property, or All Properties.</div></div>
      ) : (
        <>
          <div className="kpi-grid">
            <Kpi label="Sq Ft Occupancy" value={pctText(occ.occupied.sqftPct)} sub={`${count(occ.occupied.sqft)} of ${count(t.totalSqft)} sq ft`} onOpen={() => units('occupied')} />
            <Kpi label="Unit Occupancy" value={pctText(occ.occupied.unitPct)} sub={`${count(occ.occupied.units)} of ${count(t.totalUnits)} units`} onOpen={() => units('occupied')} />
            <Kpi label="Net Rentals MTD" value={signed(net(t.netRentals.mtd))}
              sub={t.netRentals.mtd ? `${count(t.netRentals.mtd.ins)} in, ${count(t.netRentals.mtd.outs)} out` : ''}
              onOpen={() => moves('Move-Ins and Move-Outs, Month to Date', monthStart, d.through)} />
            <Kpi label="Collected MTD" value={t.collected.mtd == null ? '-' : money(t.collected.mtd, { compact: true })}
              sub={t.collected.mtd == null ? 'No data before cutover' : 'Payments received'}
              onOpen={t.collected.mtd == null ? undefined : () => show('Payments Received, Month to Date', lists.payments, PAY_COLS)} />
            <Kpi label="Monthly Rent Roll" value={money(t.rentRoll, { compact: true })} sub="Scheduled rent, rented units"
              onOpen={() => units('occupied')} />
          </div>

          <div className="pf-grid">
            <Card title="Move-In Trend" sub="This year vs prior year, by month" right={<Legend items={[['This Year', CY], ['Prior Year', PY]]} />}>
              <TrendChart trend={t.trend} field="moveIns" fmt={count} onMonth={monthMoves('in')} />
            </Card>
            <Card title="Square Foot Occupancy Trend" sub="Occupied sq ft at month end" right={<Legend items={[['This Year', CY], ['Prior Year', PY]]} />}>
              <TrendChart trend={t.trend} field="sqftPct" fmt={(v) => `${Number(v).toFixed(1)}%`} />
            </Card>
            <Card title="Move-Out Trend" sub="This year vs prior year, by month" right={<Legend items={[['This Year', CY], ['Prior Year', PY]]} />}>
              <TrendChart trend={t.trend} field="moveOuts" fmt={count} onMonth={monthMoves('out')} />
            </Card>

            <Card title="Occupancy by Status" sub={t.mailboxesExcluded ? `Storage units only - ${count(t.mailboxesExcluded)} mailboxes left out` : 'Storage units'}>
              <div className="req-table-wrapper">
                <table className="req-table pf-table">
                  <thead><tr><th>Status</th><th className="num">Units</th><th className="num">Unit %</th><th className="num">Sq Ft</th><th className="num">Sq Ft %</th></tr></thead>
                  <tbody>
                    {t.occupancy.map((r) => [
                      <tr key={r.key}>
                        <td><Expand open={!!open[`occ-${r.key}`]} onToggle={() => flip(`occ-${r.key}`)} label={r.label} /></td>
                        <td className="num"><Fig value={r.units} text={count(r.units)} label={`${r.label} units`} onOpen={() => units(r.key)} /></td>
                        <td className="num">{pctText(r.unitPct)}</td>
                        <td className="num"><Fig value={r.sqft} text={count(r.sqft)} label={`${r.label} sq ft`} onOpen={() => units(r.key)} /></td>
                        <td className="num">{pctText(r.sqftPct)}</td>
                      </tr>,
                      ...(open[`occ-${r.key}`] ? by.map((p) => {
                        const pr = p.occupancy.find((x) => x.key === r.key);
                        return (
                          <tr key={`${r.key}-${p.id}`} className="pf-sub">
                            <td>{p.shortName}</td><td className="num">{count(pr.units)}</td><td className="num">{pctText(pr.unitPct)}</td>
                            <td className="num">{count(pr.sqft)}</td><td className="num">{pctText(pr.sqftPct)}</td>
                          </tr>
                        );
                      }) : []),
                    ])}
                    <tr className="pf-total"><td>Totals</td><td className="num">{count(t.totalUnits)}</td><td className="num">100.00%</td><td className="num">{count(t.totalSqft)}</td><td className="num">100.00%</td></tr>
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Revenue" sub={showBudget ? 'Month to date' : 'Month to date - no Ops budget in Nexus yet, so budget columns are hidden'}>
              <MoneyTable lines={t.revenue} total={{ label: 'Totals', ...t.revenueTotal }} budget={showBudget ? d.budget.figures?.revenue : null} why={d.notes.find((n) => n.includes('ledger'))}
                extra={[{ key: 'collected', label: 'Payments Received', mtd: t.collected.mtd, priorYear: t.collected.priorYear,
                  onOpen: () => show('Payments Received, Month to Date', lists.payments, PAY_COLS) }]} />
            </Card>
            <Card title="Allowances" sub="Discounts and write-offs, month to date">
              <MoneyTable lines={t.allowances} total={{ label: 'Totals', ...t.allowanceTotal }} budget={showBudget ? d.budget.figures?.allowances : null} why={d.notes.find((n) => n.includes('ledger'))} />
            </Card>

            <Card title="Net Rentals" sub="Move-ins less move-outs">
              <div className="req-table-wrapper">
                <table className="req-table pf-table">
                  <thead><tr><th /><th className="num">Daily</th><th className="num">MTD</th><th className="num">MTD Prior Year</th></tr></thead>
                  <tbody>
                    {[['ins', 'Move-Ins', 'in'], ['outs', 'Move-Outs', 'out']].map(([k, label, kind]) => (
                      <tr key={k}>
                        <td>{label}</td>
                        <td className="num"><Fig value={t.netRentals.daily?.[k]} label={`${label} today`} onOpen={() => moves(`${label} - ${formatDate(d.through)}`, d.through, d.through, kind)} /></td>
                        <td className="num"><Fig value={t.netRentals.mtd?.[k]} label={`${label} month to date`} onOpen={() => moves(`${label}, Month to Date`, monthStart, d.through, kind)} /></td>
                        <td className="num"><Fig value={t.netRentals.priorYear?.[k]} why="No data before cutover" /></td>
                      </tr>
                    ))}
                    <tr className="pf-total">
                      <td><Expand open={!!open.net} onToggle={() => flip('net')} label="Net Rentals" /></td>
                      <td className="num">{signed(net(t.netRentals.daily))}</td>
                      <td className="num">{signed(net(t.netRentals.mtd))}</td>
                      <td className="num"><Fig value={net(t.netRentals.priorYear)} text={signed(net(t.netRentals.priorYear))} why="No data before cutover" /></td>
                    </tr>
                    {open.net && by.map((p) => (
                      <tr key={p.id} className="pf-sub">
                        <td>{p.shortName}</td><td className="num">{signed(net(p.netRentals.daily))}</td>
                        <td className="num">{signed(net(p.netRentals.mtd))}</td><td className="num">{p.netRentals.priorYear ? signed(net(p.netRentals.priorYear)) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Net Revenue" sub="Revenue less allowances, month to date">
              <div className="pf-net">
                <div><span>MTD</span><b><Fig value={t.netRevenue.mtd} text={money(t.netRevenue.mtd)} why={d.notes.find((n) => n.includes('ledger'))} /></b></div>
                <div><span>Prior Year</span><b><Fig value={t.netRevenue.priorYear} text={money(t.netRevenue.priorYear)} why="No data before cutover" /></b></div>
              </div>
              {t.netRevenue.mtd == null && <p className="ops-note" style={{ margin: '10px 0 0' }}>Net revenue needs the accrual figures above. Until then, Payments Received is the money that actually came in.</p>}
            </Card>
          </div>
        </>
      )}
      {drill && <DrillList drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

function MoneyTable({ lines, total, budget, why, extra = [] }) {
  const cols = budget ? ['MTD', 'Budget', 'Variance', 'Prior Year'] : ['MTD', 'Prior Year'];
  const row = (l, cls) => (
    <tr key={l.key || l.label} className={cls}>
      <td>{l.label}</td>
      <td className="num"><Fig value={l.mtd} text={l.mtd == null ? null : money(l.mtd)} why={why} onOpen={l.onOpen} label={l.label} /></td>
      {budget && <td className="num">{budget[l.key] == null ? '-' : money(budget[l.key])}</td>}
      {budget && <td className="num">{budget[l.key] == null || l.mtd == null ? '-' : money(l.mtd - budget[l.key])}</td>}
      <td className="num"><Fig value={l.priorYear} text={l.priorYear == null ? null : money(l.priorYear)} why="No data before cutover" /></td>
    </tr>
  );
  return (
    <div className="req-table-wrapper">
      <table className="req-table pf-table">
        <thead><tr><th />{cols.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
        <tbody>
          {lines.map((l) => row(l))}
          {row(total, 'pf-total')}
          {extra.map((l) => row(l, 'pf-extra'))}
        </tbody>
      </table>
    </div>
  );
}
