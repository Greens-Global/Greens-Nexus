// Operations > Pricing Insights (Visesh, Oct 20 2026): "cubby already has
// these data - can you take account for all this data, create an engine that
// pulls all of the data every time it changes and create good insights".
//
// Everything comes from GET /facility-ops/insights (ops_insights.py): Cubby's
// pricing groups, discounts and scheduled rent changes (synced read-only every
// 15 minutes, with a change history), the rent roll and leases, and the
// competitor rates Market Rates keeps (StorTrack, websites, manual). Nothing
// here is typed in and nothing is sent to Cubby.
//
// Layout: ranked insight cards (Kind and Severity dropdowns - never chips),
// then ONE section at a time picked from a dropdown: Overview, Competitive
// Pricing, Trends, Standard Rates, ECRI, Revenue at Risk, Discounts. The
// facility is the page's one Facility dropdown.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Lightbulb } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { count, money } from './model';

const dash = '-';
const $ = (c) => (c == null ? dash : money(c, { exact: c % 100 !== 0 }));
const pct = (x, digits = 0) => (x == null ? dash : `${(x * 100).toFixed(digits)}%`);
const signedPct = (x, digits = 1) => (x == null ? dash : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
const num = { textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const stickyCell = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--card, #fff)', minWidth: 170, maxWidth: 240 };

const SECTIONS = [
  ['overview', 'Overview'],
  ['competitive', 'Competitive Pricing'],
  ['trends', 'Trends'],
  ['standard', 'Standard Rates'],
  ['ecri', 'ECRI'],
  ['risk', 'Revenue at Risk'],
  ['discounts', 'Discounts'],
];
const RATE_FILTERS = [
  ['all', 'All Pricing Groups'],
  ['move-in-spike', 'Move-In Spikes'],
  ['move-out-spike', 'Move-Out Spikes'],
  ['large-increase', 'Large Increase'],
  ['large-decrease', 'Large Decrease'],
  ['low-occupancy', 'Occupancy Under 60%'],
  ['no-move-ins', 'No Move-Ins in 30 Days'],
];
const SEVERITY = { high: ['status-rejected', 'High'], medium: ['status-pending', 'Medium'], low: ['pill-muted', 'Low'] };
// Our cell against the competitor median: within 5% reads as at market.
const tone = (vs) => {
  if (vs == null) return undefined;
  if (vs > 0.05) return { background: 'var(--warn-bg, #fef3c7)', color: 'var(--warn-fg, #92400e)' };
  if (vs < -0.05) return { background: 'var(--ok-bg, #dcfce7)', color: 'var(--ok-fg, #166534)' };
  return undefined;
};
const changeTone = (x) => (x == null || Math.abs(x) < 0.0005 ? undefined
  : { color: x > 0 ? 'var(--ok-fg, #166534)' : 'var(--bad-fg, #991b1b)', fontWeight: 600 });

function Select({ label, value, onChange, options, id }) {
  return (
    <label className="ops-period" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

function Card({ title, sub, right, children }) {
  return (
    <div className="dash-card">
      <div className="dash-card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
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

function Empty({ children }) {
  return <div className="ops-empty">{children}</div>;
}

// ── Insight cards ────────────────────────────────────────────────────────────

function InsightList({ items, kinds, many, onOpen }) {
  const [kind, setKind] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const present = useMemo(() => {
    const n = {};
    items.forEach((i) => { n[i.kind] = (n[i.kind] || 0) + 1; });
    return n;
  }, [items]);
  const shown = items.filter((i) => (kind === 'all' || i.kind === kind) && (severity === 'all' || i.severity === severity));
  const list = showAll ? shown : shown.slice(0, 8);
  const high = items.filter((i) => i.severity === 'high').length;
  return (
    <Card
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Lightbulb size={16} aria-hidden="true" /> Insights</span>}
      sub={items.length ? `${items.length} ${items.length === 1 ? 'insight' : 'insights'}, ${high} high. Ranked by severity, then by the money at stake.` : 'Nothing needs attention right now.'}
      right={(
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Select id="pi-kind" label="Kind" value={kind} onChange={(v) => { setKind(v); setShowAll(false); }}
            options={[['all', 'All Kinds'], ...kinds.filter((k) => present[k.key]).map((k) => [k.key, `${k.label} (${present[k.key]})`])]} />
          <Select id="pi-severity" label="Severity" value={severity} onChange={(v) => { setSeverity(v); setShowAll(false); }}
            options={[['all', 'All'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} />
        </div>
      )}>
      {!shown.length && <Empty>{items.length ? 'No insights match these filters.' : 'No insights yet. They appear after the next Cubby sync.'}</Empty>}
      <ul className="ops-reports" data-testid="insight-list">
        {list.map((i) => (
          <li className="ops-report" key={i.id} style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div className="ops-report-title" style={{ flexWrap: 'wrap' }}>
                <span className={`status-badge ${(SEVERITY[i.severity] || SEVERITY.low)[0]}`}>{(SEVERITY[i.severity] || SEVERITY.low)[1]}</span>
                {i.title}
              </div>
              <div className="ops-report-about" style={{ color: 'var(--ink)', marginTop: 4 }}>{i.detail}</div>
              <div className="ops-report-about">
                {[many && i.facility, i.kindLabel, i.action].filter(Boolean).join(' - ')}
              </div>
            </div>
            {i.link?.tab && (
              <button type="button" className="secondary-btn" onClick={() => onOpen(i.link)} aria-label={`Open: ${i.title}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                Open <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {shown.length > 8 && (
        <button type="button" className="secondary-btn" style={{ marginTop: 10 }} onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show Fewer' : `Show All (${shown.length})`}
        </button>
      )}
    </Card>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function Overview({ overview, onPick }) {
  const cols = [
    ['units', 'Units', count], ['pricingGroups', 'Pricing Groups', count], ['tenants', 'Tenants', count],
    ['area', 'Total Area (Sq Ft)', count], ['monthlyRent', 'Monthly Rent', $], ['occupancy', 'Physical Occ.', (v) => pct(v, 1)],
    ['moveInsMonth', 'Move-Ins This Month', count], ['moveIns60', 'Move-Ins Past 60 Days', count],
    ['moveOuts60', 'Move-Outs Past 60 Days', count], ['lowOccGroups', 'Groups Under 60% Occ.', count],
    ['zeroMoveInGroups', 'Groups With 0 Move-Ins (30 Days)', count],
  ];
  return (
    <Card title="Overview" sub="Storage units only (mailboxes are counted apart). Pricing groups are Cubby's, with at least one unit.">
      <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
        <table className="req-table" data-testid="pi-overview">
          <thead><tr><th style={stickyCell}>Facility</th>{cols.map(([k, l]) => <th key={k} style={num}>{l}</th>)}</tr></thead>
          <tbody>
            {overview.rows.map((r) => (
              <tr key={r.facilityId}>
                <td style={stickyCell}><button type="button" className="ops-cell" onClick={() => onPick(r.facilityId)}>{r.facility}</button></td>
                {cols.map(([k, , f]) => <td key={k} style={num}>{f(r[k])}</td>)}
              </tr>
            ))}
            {overview.rows.length > 1 && (
              <tr style={{ fontWeight: 700 }}>
                <td style={stickyCell}>Total</td>
                {cols.map(([k, , f]) => <td key={k} style={num}>{f(overview.totals[k])}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Competitive({ b, connectNote, focusColumn }) {
  const { columns, rows } = b.competitive;
  const ours = rows.filter((r) => r.kind === 'ours');
  const comps = rows.filter((r) => r.kind === 'competitor');
  const cell = (r, c) => {
    const v = r.cells[c.key];
    if (!v) return <td key={c.key} style={num}>{dash}</td>;
    const title = r.kind === 'ours'
      ? `${r.name}: ${$(v.rate)}${v.vsMarket != null ? ` (${signedPct(v.vsMarket)} vs the competitor median ${$(c.median)})` : ''}`
      : `${r.name}: ${$(v.rate)}, seen ${formatDate(v.observedOn)} (${v.source})`;
    return <td key={c.key} title={title} style={{ ...num, ...(r.kind === 'ours' ? tone(v.vsMarket) : null), ...(c.key === focusColumn ? { outline: '2px solid var(--ops-s1, #2563eb)' } : null) }}>{$(v.rate)}</td>;
  };
  return (
    <Card title="Competitive Pricing" sub="Our standard rate and our nearby facilities, then each competitor's newest rate. CC = climate controlled, NCC = not.">
      {!columns.length && <Empty>Cubby&apos;s pricing groups for this facility have not been synced yet.</Empty>}
      {!b.competitive.hasMarket && <p className="ops-note" style={{ margin: '0 0 10px' }}>{connectNote}</p>}
      {columns.length > 0 && (
        <>
          <div className="ops-legend" style={{ marginBottom: 8 }}>
            <span><span style={{ ...tone(0.1), padding: '1px 6px', borderRadius: 4 }}>$199</span> more than 5% above the competitor median</span>
            <span><span style={{ ...tone(-0.1), padding: '1px 6px', borderRadius: 4 }}>$169</span> more than 5% below</span>
          </div>
          <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="req-table" data-testid="pi-competitive" style={{ minWidth: 'max-content' }}>
              <thead><tr><th style={stickyCell}>Facility</th>{columns.map((c) => <th key={c.key} style={num}>{c.label}</th>)}</tr></thead>
              <tbody>
                {ours.map((r) => (
                  <tr key={r.facilityId} style={r.main ? { fontWeight: 600 } : undefined}>
                    <td style={stickyCell}><div>{r.name}</div>{r.address && <div className="ops-report-about">{r.address}</div>}</td>
                    {columns.map((c) => cell(r, c))}
                  </tr>
                ))}
                <tr>
                  <td style={{ ...stickyCell, color: 'var(--muted)', fontSize: 12 }}>Competitors With a Rate</td>
                  {columns.map((c) => <td key={c.key} style={{ ...num, color: 'var(--muted)', fontSize: 12 }}>{c.competitors}</td>)}
                </tr>
                {comps.map((r) => (
                  <tr key={r.id}>
                    <td style={stickyCell}>
                      <div>{r.name}</div>
                      <div className="ops-report-about">{[r.address, r.distanceMiles ? `${r.distanceMiles} mi` : ''].filter(Boolean).join(' - ')}</div>
                    </td>
                    {columns.map((c) => cell(r, c))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function Trends({ b, connectNote }) {
  const [who, setWho] = useState('competitors');
  const { columns } = b.competitive;
  const t = b.trends;
  const change = who === 'mine' ? t.myChange : t.competitorChange;
  return (
    <Card title="Trends" sub="Average rate per unit type now, and how it moved. Our history starts the day Nexus began tracking Cubby's rates."
      right={<Select id="pi-trend-who" label="Change For" value={who} onChange={setWho} options={[['competitors', 'Competitors'], ['mine', 'My Locations']]} />}>
      {!b.competitive.hasMarket && <p className="ops-note" style={{ margin: '0 0 10px' }}>{connectNote}</p>}
      {!columns.length ? <Empty>No unit types to show yet.</Empty> : (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
          <table className="req-table" data-testid="pi-trends" style={{ minWidth: 'max-content' }}>
            <thead><tr><th style={stickyCell}>Average</th>{columns.map((c) => <th key={c.key} style={num}>{c.label}</th>)}</tr></thead>
            <tbody>
              <tr><td style={stickyCell}>My Locations</td>{columns.map((c) => <td key={c.key} style={num}>{$(t.my[c.key])}</td>)}</tr>
              <tr><td style={stickyCell}>Competitors</td>{columns.map((c) => <td key={c.key} style={num}>{$(t.competitors[c.key])}</td>)}</tr>
              {['1', '7', '30'].map((d) => (
                <tr key={d}>
                  <td style={stickyCell}>{d === '1' ? '1 Day Ago' : `${d} Days Ago`}</td>
                  {columns.map((c) => <td key={c.key} style={{ ...num, ...changeTone(change[d]?.[c.key]) }}>{signedPct(change[d]?.[c.key], 2)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StandardRates({ b, filter, setFilter, focusGroup }) {
  const rows = b.standardRates.filter((r) => filter === 'all' || r.flags.includes(filter));
  const counts = {};
  b.standardRates.forEach((r) => r.flags.forEach((f) => { counts[f] = (counts[f] || 0) + 1; }));
  return (
    <Card title="Standard Rates" sub="Cubby's pricing groups. Suggested = the market rule (10% step); Market Target is where the market points with no step limit."
      right={<Select id="pi-rate-filter" label="Show" value={filter} onChange={setFilter}
        options={RATE_FILTERS.map(([k, l]) => [k, k === 'all' ? l : `${l} (${counts[k] || 0})`])} />}>
      {!b.standardRates.length ? <Empty>Cubby&apos;s pricing groups for this facility have not been synced yet. They arrive with the next Cubby sync.</Empty> : (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
          <table className="req-table" data-testid="pi-standard" style={{ minWidth: 'max-content' }}>
            <thead><tr>
              <th style={stickyCell}>Pricing Group</th><th style={num}>Area (Sq Ft)</th><th>Last Changed</th>
              <th style={num}>Standard Rate</th><th style={num}>Web Rate</th><th style={num}>Walk-In Rate</th><th style={num}>Per Sq Ft</th>
              <th style={num}>Mkt Median</th><th style={num}>Suggested</th><th style={num}>Market Target</th><th style={num}>Gap</th>
              <th>Discount Bands</th><th style={num}>Vacant</th><th style={num}>30 Day Net Move-Ins</th>
              <th style={num}>Move-Ins (T30)</th><th style={num}>Move-Outs (T30)</th><th style={num}>Physical Occ.</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.groupId} style={r.groupId === focusGroup ? { outline: '2px solid var(--ops-s1, #2563eb)' } : undefined}>
                  <td style={stickyCell}><div>{r.name}</div><div className="ops-report-about">{r.label}{r.kind === 'mailbox' ? ' - Mailbox' : ''}</div></td>
                  <td style={num}>{count(r.area)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.lastChangedAt ? formatDate(r.lastChangedAt) : <span title={r.trackedSince ? `Tracked since ${formatDate(r.trackedSince)}` : ''} style={{ color: 'var(--muted)' }}>No Change Seen</span>}</td>
                  <td style={num}>{$(r.standard)}</td><td style={num}>{$(r.web)}</td><td style={num}>{$(r.walkIn)}</td>
                  <td style={num}>{r.perSqFt == null ? dash : $(r.perSqFt)}</td>
                  <td style={num} title={r.competitors ? `${r.competitors} competitors` : 'No competitor rate'}>{$(r.marketMedian)}</td>
                  <td style={num} title={r.why}>{$(r.suggested)}</td>
                  <td style={num}>{$(r.target)}</td>
                  <td style={{ ...num, ...changeTone(r.targetGap) }}>{signedPct(r.targetGap)}</td>
                  <td style={{ minWidth: 140 }}>{r.discounts?.length ? r.discounts.map((d) => `${d.name}${d.visibility === 'CUBBY_ONLY' ? ' (Cubby Only)' : ''}`).join(', ') : dash}</td>
                  <td style={num}>{count(r.vacant)}</td>
                  <td style={{ ...num, ...changeTone(r.net30 / 100) }}>{r.net30 > 0 ? `+${r.net30}` : r.net30}</td>
                  <td style={num}>{count(r.ins30)}</td><td style={num}>{count(r.outs30)}</td>
                  <td style={num}>{pct(r.occupancy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>No pricing groups match this filter.</Empty>}
        </div>
      )}
    </Card>
  );
}

function Ecri({ b }) {
  const e = b.ecri;
  const [view, setView] = useState('candidates');
  const [all, setAll] = useState(false);
  const cands = all ? e.candidates : e.candidates.slice(0, 25);
  return (
    <Card title="ECRI" sub="Existing customer rate increases. Enter rent changes in Cubby; build them in Revenue Management."
      right={<Select id="pi-ecri-view" label="Show" value={view} onChange={setView}
        options={[['candidates', `Candidates (${e.candidateCount})`], ['scheduled', `Scheduled (${e.scheduled.length})`], ['survival', 'Monthly Survival']]} />}>
      <div className="kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
        <div className="kpi-card"><div className="kpi-label">Below Street 12+ Months</div><div className="kpi-value">{count(e.candidateCount)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Upside / Month</div><div className="kpi-value">{$(e.upside)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Scheduled</div><div className="kpi-value">{count(e.scheduled.length)}</div><div className="kpi-delta">{$(e.scheduledLift)} / month</div></div>
        <div className="kpi-card"><div className="kpi-label">In First 12 Months</div><div className="kpi-value">{count(e.early)}</div></div>
      </div>
      {view === 'candidates' && (e.candidates.length ? (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
          <table className="req-table" data-testid="pi-ecri">
            <thead><tr><th>Unit</th><th>Tenant</th><th>Unit Type</th><th style={num}>Rent</th><th style={num}>Street</th><th style={num}>Gap</th><th style={num}>Months Stayed</th><th>Last Increase</th></tr></thead>
            <tbody>{cands.map((r) => (
              <tr key={`${r.unit}-${r.tenant}`}>
                <td>{r.unit}</td>
                <td>{r.url ? <a className="ops-name" href={r.url} target="_blank" rel="noreferrer">{r.tenant}</a> : r.tenant}</td>
                <td>{r.unitType}</td><td style={num}>{$(r.rent)}</td><td style={num}>{$(r.street)}</td>
                <td style={num}>{$(r.gap)} ({pct(r.gapPct == null ? null : r.gapPct / 100)})</td>
                <td style={num}>{r.monthsStayed ?? dash}</td>
                <td>{r.lastIncrease ? formatDate(r.lastIncrease) : 'None on File'}</td>
              </tr>
            ))}</tbody>
          </table>
          {e.candidates.length > 25 && <button type="button" className="secondary-btn" style={{ marginTop: 10 }} onClick={() => setAll((s) => !s)}>{all ? 'Show Fewer' : `Show All (${e.candidates.length})`}</button>}
        </div>
      ) : <Empty>No tenant has paid under the street rate for 12+ months without an increase.</Empty>)}
      {view === 'scheduled' && (e.scheduled.length ? (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
          <table className="req-table">
            <thead><tr><th>Unit</th><th>Tenant</th><th style={num}>Rent</th><th style={num}>New Rent</th><th style={num}>Change</th><th>Effective</th><th style={num}>Months Stayed</th></tr></thead>
            <tbody>{e.scheduled.map((r) => (
              <tr key={`${r.unit}-${r.effective}`}>
                <td>{r.unit}</td><td>{r.tenant}</td><td style={num}>{$(r.rent)}</td><td style={num}>{$(r.newRent)}</td>
                <td style={num}>{$(r.change)} ({signedPct(r.changePct)})</td><td>{formatDate(r.effective)}</td>
                <td style={num}>{r.monthsStayed ?? dash}{r.early && <span className="status-badge status-pending" style={{ marginLeft: 6 }}>First Year</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>Cubby has no rent increases scheduled at this facility.</Empty>)}
      {view === 'survival' && (e.survival.length ? (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
          <table className="req-table">
            <thead><tr><th>Month</th><th style={num}>Increases</th><th style={num}>Avg Increase</th><th style={num}>Moved Out Within 60 Days</th><th style={num}>Survival</th><th style={num}>Revenue Gained / Month</th></tr></thead>
            <tbody>{e.survival.map((s) => (
              <tr key={s.month}>
                <td>{`${s.month.slice(5, 7)}/${s.month.slice(0, 4)}`}{s.windowOpen && <span className="ops-pill-tag">Still Counting</span>}</td>
                <td style={num}>{s.increases}</td><td style={num}>{signedPct(s.averageIncrease)}</td><td style={num}>{s.moveOuts}</td>
                <td style={num}>{pct(s.survival)}</td><td style={num}>{$(s.revenueGained)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No increases have taken effect since Nexus began tracking them. Survival builds up as Cubby&apos;s scheduled increases land.</Empty>)}
    </Card>
  );
}

function Risk({ b }) {
  const { vacancy, vacancyLoss, pastDue } = b.risk;
  return (
    <>
      <Card title="Vacancy Loss" sub={`Vacant storage units at the standard rate: ${$(vacancyLoss)} a month.`}>
        {vacancy.length ? (
          <div className="req-table-wrapper"><table className="req-table">
            <thead><tr><th>Pricing Group</th><th style={num}>Vacant</th><th style={num}>Standard Rate</th><th style={num}>Loss / Month</th></tr></thead>
            <tbody>{vacancy.map((v) => <tr key={v.groupId}><td>{v.name}</td><td style={num}>{v.vacant}</td><td style={num}>{$(v.standard)}</td><td style={num}>{$(v.loss)}</td></tr>)}</tbody>
          </table></div>
        ) : <Empty>No vacant storage units.</Empty>}
      </Card>
      <Card title="Past Due" sub={pastDue.total ? `${pastDue.tenants} tenants owe ${$(pastDue.total)}${pastDue.rentRoll ? `, ${pct(pastDue.total / pastDue.rentRoll, 1)} of the monthly rent roll` : ''}${pastDue.top5Share != null ? `; the top 5 owe ${pct(pastDue.top5Share)}` : ''}.` : 'Nobody owes money.'}>
        {pastDue.top.length > 0 && (
          <div className="req-table-wrapper"><table className="req-table">
            <thead><tr><th>Tenant</th><th>Unit</th><th style={num}>Owed</th></tr></thead>
            <tbody>{pastDue.top.map((r) => <tr key={`${r.unit}-${r.tenant}`}><td>{r.url ? <a className="ops-name" href={r.url} target="_blank" rel="noreferrer">{r.tenant}</a> : r.tenant}</td><td>{r.unit}</td><td style={num}>{$(r.amount)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

function Discounts({ discounts, b }) {
  const here = new Set((b?.standardRates || []).map((r) => r.groupId));
  const rows = discounts.filter((d) => !b || (d.facilityIds || []).includes(b.facilityId));
  return (
    <Card title="Discounts" sub="Cubby's discount strategies and the pricing groups they are offered on.">
      {rows.length ? (
        <div className="req-table-wrapper" style={{ overflowX: 'auto' }}><table className="req-table">
          <thead><tr><th>Name</th><th>Band</th><th>Type</th><th>Status</th><th style={num}>Pricing Groups{b ? ' Here' : ''}</th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td><td>{d.band || dash}</td>
              <td>{(d.type || '').toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || dash}</td>
              <td><span className={`status-badge ${d.live ? 'status-approved' : 'pill-muted'}`}>{d.live ? 'Published' : 'Not Offered'}</span></td>
              <td style={num}>{(d.pricingGroups || []).filter((p) => !b || here.has(p.pricingGroupId)).length}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty>No discounts synced from Cubby yet.</Empty>}
    </Card>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

// `facility` is the page's pick (null = All Facilities). `onPick` changes it;
// `onGo` switches the Operations tab (Revenue, Collections, Rate Management).
export default function PricingInsights({ facility, onPick, onGo }) {
  const facilityId = facility?.id || '';
  const [state, setState] = useState({ status: 'loading', data: null });
  const [section, setSection] = useState('overview');
  const [rateFilter, setRateFilter] = useState('all');
  const [focus, setFocus] = useState({});

  const load = useCallback(async () => {
    // Another facility shows a skeleton, not the last one's sections.
    setState((s) => (s.data && (s.data.facilityId || '') === facilityId ? s : { status: 'loading', data: null }));
    try {
      setState({ status: 'ready', data: await api.getOpsInsights(facilityId) });
    } catch (err) {
      console.error('Operations: could not load pricing insights', err);
      setState((s) => (s.data ? s : { status: 'error', data: null }));
    }
  }, [facilityId]);
  useEffect(() => { load(); }, [load]);

  const open = (link) => {
    if (link.tab !== 'pricing') {
      if (link.facilityId) onPick?.(link.facilityId);
      onGo?.(link.tab);
      return;
    }
    if (link.facilityId && link.facilityId !== facilityId) onPick?.(link.facilityId);
    setSection(link.section || 'overview');
    setRateFilter(link.filters?.insight || 'all');
    setFocus({ group: link.filters?.group, column: link.filters?.column });
  };

  if (state.status === 'loading') return <div data-testid="pi-loading"><SkeletonBlocks count={3} height={140} /></div>;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load the pricing insights." onRetry={load} />;

  const d = state.data;
  const b = d.facility && d.facility.facilityId === facilityId ? d.facility : null;
  const connectNote = d.market?.stortrack?.connected
    ? 'No competitor rates are on file for this facility yet. Add them in Rate Management.'
    : 'StorTrack not connected yet. Connect StorTrack to compare with the market; website and manual rates in Rate Management count too.';
  const needsOne = section !== 'overview' && section !== 'discounts' && !b;

  return (
    <>
      <div className="dash-card">
        <div className="dash-card-title">Pricing Insights</div>
        <div className="dash-card-sub">
          From Cubby&apos;s pricing groups, rent roll and leases (read every 15 minutes; rate changes are kept as history) and
          competitor rates from StorTrack, websites and manual entry.
          {d.syncedAt ? ` Cubby synced ${formatDateTime(d.syncedAt)}.` : ''}
          {d.pricingSyncedAt ? ` Pricing groups synced ${formatDateTime(d.pricingSyncedAt)}.` : ''}
        </div>
        {(d.notices || []).map((n) => <p key={n} className="ops-note" role="status" style={{ margin: '8px 0 0' }}>{n === 'Connect StorTrack to compare with the market' ? `${n}: StorTrack not connected yet, so market position and competitor moves are not shown.` : n}</p>)}
      </div>

      <InsightList items={d.insights || []} kinds={d.kinds || []} many={!facilityId} onOpen={open} />

      <div className="ops-bar-top">
        <Select id="pi-section" label="Section" value={section} onChange={(v) => { setSection(v); setFocus({}); }} options={SECTIONS} />
      </div>

      {needsOne && (
        <div className="dash-card"><Empty>Pick a facility above to see {SECTIONS.find(([k]) => k === section)?.[1]}.</Empty></div>
      )}
      {section === 'overview' && <Overview overview={d.overview} onPick={(id) => onPick?.(id)} />}
      {section === 'competitive' && b && <Competitive b={b} connectNote={connectNote} focusColumn={focus.column} />}
      {section === 'trends' && b && <Trends b={b} connectNote={connectNote} />}
      {section === 'standard' && b && <StandardRates b={b} filter={rateFilter} setFilter={setRateFilter} focusGroup={focus.group} />}
      {section === 'ecri' && b && <Ecri b={b} />}
      {section === 'risk' && b && <Risk b={b} />}
      {section === 'discounts' && <Discounts discounts={d.discounts || []} b={b} />}
    </>
  );
}
