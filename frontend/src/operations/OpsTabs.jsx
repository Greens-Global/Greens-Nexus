// Operations tabs. Each answers one question:
//   Overview    - how are the facilities doing, and which one needs a look
//   Collections - who owes what, how old is it, is money coming in
//   Units       - where is the empty space and the pricing room
//   Worklist    - what does someone on site need to do ("Facility Tasks" in the menu, Cubby's name)
// `data` is one block from model.combine (a single facility or several);
// `facilities` is always the full list, for the side-by-side pieces.
//
// Every figure leads somewhere: a KPI opens the list behind it (`go(tab,
// section, filter)` - another tab if that is where the list lives), a chart
// bar filters or narrows, and a tenant's name opens them in Cubby.
import { useEffect } from 'react';
import { ArrowUpRight, ExternalLink, X } from 'lucide-react';
import OpsGrid from './OpsGrid';
import { formatDate } from '../lib/datetime';
import { AGING, LEAD_STATUS, OFF_MARKET_REASON, agingLabel, attentionItems, collectionSeries, count, historyWindow, money, pastDueTrend, pct, periodStats, tidy } from './model';
import { mailboxOccupancy, rentedAll, storageOccupancy, storageRent } from './occupancy';
import { storeHoursCell } from './storeHours';
import { AgingChart, CollectionsChart, Legend, MovesChart, PastDueTrendChart, RentedTrendChart, UnitMixChart } from './charts';

// "12.4% of a month's rent" - or nothing when there is no whole to take a
// share of, never "- of a month's rent" (phone review, 11/13/2026).
const share = (p, words) => (p === '-' ? '' : `${p} ${words}`);
const joinSub = (...parts) => parts.filter(Boolean).join(' - ');

// A KPI is a button: it names where it goes ("Past Due, $8,937. Show tenants past due").
function Kpi({ label, value, sub, to, onClick }) {
  return (
    <button type="button" className="kpi-card ops-kpi" onClick={onClick} aria-label={`${label}, ${value}. ${to}`} title={to}>
      <div className="kpi-label">{label}<ArrowUpRight size={14} className="ops-kpi-go" aria-hidden="true" /></div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-delta">{sub}</div>}
    </button>
  );
}

// `id` is what a KPI scrolls to; the card it lands on is outlined for a moment.
function Card({ id, focus, title, sub, right, children }) {
  const lit = focus && focus.section === id;
  return (
    <div className={`dash-card${lit ? ' ops-lit' : ''}`} id={id ? `ops-${id}` : undefined} key={lit ? focus.n : undefined}>
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

// Bring the section a KPI pointed at into view - on arrival at a tab, and
// again each time something on the same tab points somewhere new.
function useScrollTo(focus) {
  useEffect(() => {
    if (!focus?.section) return;
    document.getElementById(`ops-${focus.section}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [focus?.section, focus?.n]);
}

const CubbyLink = ({ url }) => (url
  ? <a className="ops-link" href={url} target="_blank" rel="noopener noreferrer">Open in Cubby <ExternalLink size={12} aria-hidden="true" /></a>
  : null);

// A tenant's name is itself the way into Cubby.
const Tenant = ({ row, fallback = '-' }) => (row.url && row.tenant
  ? <a className="ops-name" href={row.url} target="_blank" rel="noopener noreferrer" title="Open this tenant in Cubby">{row.tenant}</a>
  : (row.tenant || fallback));

const badge = (cls, text) => <span className={`status-badge ${cls}`}>{text}</span>;

// Everything typed on a row that a person might search for: unit, tenant,
// facility, unit type, task title, reason. Links and ids are left out.
const SEARCH_KEYS = ['unit', 'tenant', 'facility', 'type', 'name', 'shortName', 'title', 'reason', 'note', 'source', 'status'];
const haystack = (r) => SEARCH_KEYS.map((k) => (typeof r[k] === 'string' ? r[k] : '')).join(' ').toLowerCase();

// A table that never makes the page longer: `limit` rows at a time with a
// pager, and a search box once there is more than one page (402 off-market
// units are found by typing the unit, not by scrolling). `columns` is
// [{ head, cell, num }]; a column with `when: false` is left out. Since the
// Oct 28 2026 call (B5 / B6 / B8) it is OpsGrid: the same Columns, sort,
// filters, frozen header and Export as every table in the module, kept per
// person under `id`.
function Rows({ id, title, columns, rows, empty, limit = 8, label = 'rows' }) {
  return <OpsGrid tableKey={`tabs:${id || label}`} title={title || label} columns={columns} rows={rows} empty={empty} limit={limit} label={label}
    searchText={haystack} />;
}

// Rented / vacant / off-market as one thin bar, sized for a table cell.
function MixBar({ rented, vacant, off }) {
  const parts = [[rented, 'var(--ops-s1)'], [vacant, 'var(--ops-s2)'], [off, 'var(--ops-neutral)']].filter(([n]) => n > 0);
  return (
    <div className="ops-bar" role="img" aria-label={`${rented} rented, ${vacant} vacant, ${off} off market`}>
      {parts.map(([n, color]) => <span key={color} style={{ flex: n, background: color }} />)}
    </div>
  );
}

const strong = (text) => <span style={{ fontWeight: 600 }}>{text}</span>;
const facilityCol = (many) => ({ head: 'Facility', cell: (r) => r.facility, when: many });

// ── Overview ──────────────────────────────────────────────────────────────────

// The Dashboard is the person's own (Oct 28 2026 call with Neil, B2): every
// card has a key, the person picks which show and in what order (Customize,
// opsDashboard.jsx), and the choice is kept in their profile. DASH_CARDS is
// the library; DEFAULT_CARDS is the board before anyone customizes it - the
// same Overview as before. A full card spans the row, a half card shares it.
export const DASH_CARDS = [
  { key: 'kpis', label: 'Headline Figures', about: 'Occupancy, rent roll, past due, autopay and net move-ins.', size: 'full' },
  { key: 'tpm', label: 'TPM Stores', about: 'The stores another operator runs, from their reports.', size: 'full' },
  { key: 'units-by-facility', label: 'Units by Facility', about: 'Rented, vacant and off-market storage units per facility.', size: 'half' },
  { key: 'attention', label: 'Needs Attention', about: 'What is worth a look today.', size: 'half' },
  { key: 'rented-trend', label: 'Rented Units', about: 'Units rented at each month end.', size: 'half' },
  { key: 'moves-trend', label: 'Move-Ins and Move-Outs', about: 'By month.', size: 'half' },
  { key: 'scorecard', label: 'Facility Scorecard', about: 'One line per facility.', size: 'full' },
  // Cards from the other screens a person may add.
  { key: 'aging', label: 'Past Due by Age', about: 'The past-due balance in 30-day buckets.', size: 'half' },
  { key: 'collected', label: 'Collected', about: 'Successful payments over the period.', size: 'half' },
  { key: 'past-due-trend', label: 'Past-Due Balance Over Time', about: 'One point per day.', size: 'half' },
  { key: 'past-due', label: 'Tenants Past Due', about: 'Who owes, largest balance first.', size: 'full' },
  { key: 'failed', label: 'Failed Payments', about: 'Declined or returned payments.', size: 'half' },
  { key: 'unit-types', label: 'Unit Types', about: 'Occupancy and empty rent by unit type.', size: 'full' },
  { key: 'below-street', label: 'Tenants Under Street Rate', about: 'Rent-increase candidates.', size: 'half' },
  { key: 'tasks', label: 'Open Tasks', about: 'From Cubby, earliest due first.', size: 'half' },
  { key: 'move-outs', label: 'Scheduled Move-Outs', about: 'Units about to come back on the market.', size: 'half' },
  { key: 'leads', label: 'Open Leads', about: 'Longest wait first.', size: 'half' },
];
export const DEFAULT_CARDS = ['kpis', 'tpm', 'units-by-facility', 'attention', 'rented-trend', 'moves-trend', 'scorecard'];

export function Overview({ data, scope, many, range, focus, go, onPick, onJump, hours = null, trend = null, cards = DEFAULT_CARDS, tpm = null }) {
  useScrollTo(focus);
  const occ = storageOccupancy(data.units);
  const boxes = mailboxOccupancy(data.mailboxes);
  const renters = rentedAll(data);
  const stats = periodStats(data, range);
  const net = stats.moveIns - stats.moveOuts;
  const months = historyWindow(data.history, range);
  const attention = attentionItems(scope);
  const known = new Set(DASH_CARDS.map((c) => c.key));
  const list = cards.filter((k) => known.has(k));

  const render = (key) => {
    switch (key) {
      case 'kpis': return (
        <div className="kpi-grid">
          <Kpi label="Storage Occupancy" value={pct(occ.rented, occ.rentable)}
            sub={`${count(occ.rented)} of ${count(occ.rentable)} rentable units${occ.offMarket ? ` - ${count(occ.offMarket)} off market not counted` : ''}`}
            to="Show occupancy by unit type" onClick={() => go('units', 'unit-types')} />
          {boxes && (
            <Kpi label="Mailbox Occupancy" value={pct(boxes.rented, boxes.total)}
              sub={`${count(boxes.rented)} of ${count(boxes.total)} mailboxes rented`}
              to="Show mailboxes by unit type" onClick={() => go('units', 'unit-types')} />
          )}
          <Kpi label="Monthly Rent Roll" value={money(data.rent.rentRoll, { compact: true })}
            sub={renters ? `${money(data.rent.rentRoll / renters)} average per rented unit` : ''}
            to="Show rent by unit type" onClick={() => go('units', 'unit-types')} />
          <Kpi label="Past Due" value={money(data.pastDue.total, { compact: true })}
            sub={joinSub(`${count(data.pastDue.tenants)} tenants`, share(pct(data.pastDue.total, data.rent.rentRoll), "of a month's rent"))}
            to="Show tenants past due" onClick={() => go('collections', 'past-due')} />
          <Kpi label="On Autopay" value={pct(data.autoPay, renters, 0)}
            sub={`${count(data.autoPay)} of ${count(renters)} rented units`}
            to="Show past-due tenants who are not on autopay" onClick={() => go('collections', 'past-due', 'no-autopay')} />
          <Kpi label="Net Move-Ins" value={`${net > 0 ? '+' : ''}${net}`}
            sub={`${count(stats.moveIns)} in, ${count(stats.moveOuts)} out - ${range.label.toLowerCase()}`}
            to="Show scheduled move-outs and move-ins" onClick={() => go('worklist', 'move-outs')} />
        </div>
      );
      case 'tpm': return tpm;
      case 'units-by-facility': return (
        <Card title="Units by Facility" sub={`${many ? 'Storage units. Select a bar to see only that facility' : 'Rented, vacant and off-market storage units'}${boxes ? '. Mailboxes are counted apart.' : ''}`}
          right={<Legend items={[['Rented', 'var(--ops-s1)'], ['Vacant', 'var(--ops-s2)'], ['Off Market', 'var(--ops-neutral)']]} />}>
          <UnitMixChart facilities={scope} onPick={many ? onPick : undefined} />
        </Card>
      );
      case 'attention': return (
        <Card title="Needs Attention" sub="Worth a look today. Select one to open it.">
          {attention.length ? (
            <div className="ops-attn">
              {attention.slice(0, 7).map((a, i) => (
                <button type="button" key={i} onClick={() => onJump(a.tab, a.facility, a.section)}>
                  <span className="ops-attn-fac">{a.facility}</span><span>{a.text}</span>
                </button>
              ))}
            </div>
          ) : <div className="ops-empty">Nothing is flagged right now.</div>}
        </Card>
      );
      case 'rented-trend': return (
        <Card title="Rented Units" sub={`Units rented at each month end, ${months.length} months`}>
          <RentedTrendChart history={months} />
        </Card>
      );
      case 'moves-trend': return (
        <Card title="Move-Ins and Move-Outs" sub={`By month, ${months.length} months`}
          right={<Legend items={[['Move-Ins', 'var(--ops-s1)'], ['Move-Outs', 'var(--ops-s2)']]} />}>
          <MovesChart history={months} />
        </Card>
      );
      case 'scorecard': return many ? (
        <Card title="Facility Scorecard" sub="Select a facility for its figures, or a number for the list behind it">
          <Rows id="scorecard" title="Facility Scorecard" limit={20} label="facilities" empty="No facilities." rows={scope} columns={[
            { head: 'Facility', cell: (f) => <button type="button" className="ops-cell" onClick={() => onPick(f.id)}>{f.shortName}</button> },
            { head: 'Units', num: true, cell: (f) => count(f.units.total) },
            { head: 'Occupancy', num: true, cell: (f) => { const o = storageOccupancy(f.units); return <button type="button" className="ops-cell" onClick={() => onJump('units', f.shortName, 'unit-types')}>{pct(o.rented, o.rentable)}</button>; } },
            { head: 'Mailboxes', num: true, when: scope.some((f) => f.mailboxes?.total), cell: (f) => { const b = mailboxOccupancy(f.mailboxes); return b ? `${pct(b.rented, b.total, 0)} of ${count(b.total)}` : '-'; } },
            { head: 'Off Market', num: true, cell: (f) => <button type="button" className="ops-cell" onClick={() => onJump('units', f.shortName, 'off-market')}>{count(f.units.unavailable)}</button> },
            { head: 'Rent Roll', num: true, cell: (f) => money(f.rent.rentRoll) },
            { head: 'Past Due', num: true, cell: (f) => <button type="button" className="ops-cell" onClick={() => onJump('collections', f.shortName, 'past-due')}>{money(f.pastDue.total)}</button> },
            { head: 'Past Due / Rent', num: true, cell: (f) => pct(f.pastDue.total, f.rent.rentRoll) },
            { head: 'Autopay', num: true, cell: (f) => pct(f.autoPay, rentedAll(f), 0) },
            { head: 'Net This Month', num: true, cell: (f) => { const n = f.moves.insMtd - f.moves.outsMtd; return `${n > 0 ? '+' : ''}${n}`; } },
            { head: `Hours, ${hours?.days || 7} Days`, num: true, when: Object.keys(hours?.stores || {}).length > 0,
              cell: (f) => { const c = storeHoursCell(hours, f.id); return <span title={c.title}>{c.text}</span>; } },
          ]} />
        </Card>
      ) : null;
      case 'aging': return (
        <Card title="Past Due by Age" sub="Select a bar to list the tenants in it. Older balances are darker.">
          <AgingChart buckets={data.pastDue.buckets} onPick={(k) => go('collections', 'past-due', k)} />
        </Card>
      );
      case 'collected': {
        const series = collectionSeries(data.payments.daily, range);
        return (
          <Card title={series.length && series[0].date.length === 7 ? 'Collected per Month' : 'Collected per Day'} sub={`Successful payments, ${range.label.toLowerCase()}`}>
            <CollectionsChart daily={series} />
          </Card>
        );
      }
      case 'past-due-trend': return (
        <Card title="Past-Due Balance Over Time" sub="One point per day, saved by Nexus">
          <PastDueTrendChart points={pastDueTrend(trend, scope.map((f) => f.id))} />
        </Card>
      );
      case 'past-due': return (
        <Card title="Tenants Past Due" sub="Largest balance first. Select a name to open the tenant in Cubby.">
          <Rows id="dash-past-due" title="Tenants Past Due" label="tenants" empty="Nobody is past due." rows={data.pastDue.rows} columns={[
            { head: 'Unit', cell: (r) => strong(r.unit) },
            { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
            facilityCol(many),
            { head: 'Amount', num: true, cell: (r) => money(r.amount, { exact: true }) },
            { head: 'Oldest Balance', cell: (r) => agingLabel(r.oldest) },
            { head: 'Paid Through', cell: (r) => formatDate(r.paidThrough, '-') },
            { head: 'Autopay', cell: (r) => (r.autoPay ? 'On' : 'Off') },
          ]} />
        </Card>
      );
      case 'failed': return (
        <Card title="Failed Payments" sub="Declined or returned, most recent first (the last 31 days at most).">
          <Rows id="dash-failed" title="Failed Payments" limit={6} label="payments" empty="No failed payments listed for this period." rows={stats.failedRows} columns={[
            { head: 'Date', cell: (r) => formatDate(r.date) },
            { head: 'Tenant', cell: (r) => <Tenant row={r} fallback="Former tenant" /> },
            facilityCol(many),
            { head: 'Amount', num: true, cell: (r) => money(r.amount, { exact: true }) },
            { head: 'Reason', cell: (r) => r.reason || '-' },
          ]} />
        </Card>
      );
      case 'unit-types': return (
        <Card title="Unit Types" sub="Most empty rent first.">
          <Rows id="dash-unit-types" title="Unit Types" label="unit types" empty="No units." rows={data.unitTypes} columns={[
            { head: 'Unit Type', cell: (t) => strong(t.name) },
            { head: 'Units', num: true, cell: (t) => count(t.total) },
            { head: 'Occupancy', num: true, cell: (t) => pct(t.rented, t.total, 0) },
            { head: 'Vacant', num: true, cell: (t) => count(t.vacant) },
            { head: 'Street Rate', num: true, cell: (t) => money(t.street) },
            { head: 'Empty Rent / Month', num: true, cell: (t) => (t.vacantPotential ? money(t.vacantPotential) : '-') },
          ]} />
        </Card>
      );
      case 'below-street': return (
        <Card title="Tenants Under Street Rate" sub="Rent-increase candidates, largest gap first">
          <Rows id="dash-below-street" title="Tenants Under Street Rate" limit={6} label="tenants" empty="Every tenant is at or above the street rate." rows={data.belowStreet} columns={[
            { head: 'Unit', cell: (r) => strong(r.unit) },
            { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
            facilityCol(many),
            { head: 'Rent', num: true, cell: (r) => money(r.rent) },
            { head: 'Street', num: true, cell: (r) => money(r.street) },
            { head: 'Gap', num: true, cell: (r) => money(r.street - r.rent) },
          ]} />
        </Card>
      );
      case 'tasks': return (
        <Card title="Open Tasks" sub="From Cubby, earliest due date first">
          <Rows id="dash-tasks" title="Open Tasks" limit={6} label="tasks" empty="No open tasks." rows={data.tasks.rows} columns={[
            { head: 'Task', cell: (r) => strong(r.title) },
            { head: 'Unit', cell: (r) => r.unit || '-' },
            facilityCol(many),
            { head: 'Due', cell: (r) => formatDate(r.dueDate, '-') },
            { head: 'Status', cell: (r) => (r.overdue ? <span style={{ color: 'var(--bad-fg)' }}>Overdue</span> : 'Open') },
          ]} />
        </Card>
      );
      case 'move-outs': return (
        <Card title="Scheduled Move-Outs" sub="Units about to come back on the market">
          <Rows id="dash-move-outs" title="Scheduled Move-Outs" limit={6} label="move-outs" empty="No move-outs scheduled." rows={data.moves.movingOut} columns={[
            { head: 'Unit', cell: (r) => strong(r.unit) },
            { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
            facilityCol(many),
            { head: 'Moving Out', cell: (r) => formatDate(r.date, '-') },
          ]} />
        </Card>
      );
      case 'leads': return (
        <Card title="Open Leads" sub="Longest wait first">
          <Rows id="dash-leads" title="Open Leads" limit={6} label="leads" empty="No open leads." rows={data.leads.rows} columns={[
            { head: 'Name', cell: (r) => <Tenant row={r} /> },
            facilityCol(many),
            { head: 'Status', cell: (r) => LEAD_STATUS[r.status] || 'Open' },
            { head: 'Waiting', num: true, cell: (r) => (r.ageDays === 1 ? '1 day' : `${count(r.ageDays)} days`) },
          ]} />
        </Card>
      );
      default: return null;
    }
  };

  const size = Object.fromEntries(DASH_CARDS.map((c) => [c.key, c.size]));
  const drawn = list.map((k) => [k, render(k)]).filter(([, node]) => node);
  if (!drawn.length) return <div className="ops-empty">Every card is hidden. Customize to put some back.</div>;
  return (
    <div className="ops-dash-board">
      {drawn.map(([k, node]) => <div key={k} className={`ops-dash-cell is-${size[k] || 'full'}`} data-card={k}>{node}</div>)}
    </div>
  );
}

// ── Collections ───────────────────────────────────────────────────────────────

// What the Tenants Past Due table can be narrowed to, and what to call it.
const PAST_DUE_FILTERS = {
  older: { label: 'Older Than 30 Days', keep: (r) => r.oldest !== 'd0_30' },
  'no-autopay': { label: 'Not on Autopay', keep: (r) => !r.autoPay },
  ...Object.fromEntries(AGING.map((a) => [a.key, { label: a.label, keep: (r) => (r.buckets?.[a.key] || 0) > 0 }])),
};

export function Collections({ data, scope, trend, many, range, focus, go }) {
  useScrollTo(focus);
  const stats = periodStats(data, range);
  const series = collectionSeries(data.payments.daily, range);
  const oneMonth = range.key === 'this-month' || range.key === 'last-month';
  const older = data.pastDue.total - (data.pastDue.buckets.d0_30 || 0);
  const points = pastDueTrend(trend, scope.map((f) => f.id));
  const filter = PAST_DUE_FILTERS[focus?.filter] ? focus.filter : null;
  const rows = filter ? data.pastDue.rows.filter(PAST_DUE_FILTERS[filter].keep) : data.pastDue.rows;
  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Past Due" value={money(data.pastDue.total, { compact: true })}
          sub={share(pct(data.pastDue.total, data.rent.rentRoll), "of a month's rent")}
          to="Show every tenant past due" onClick={() => go('collections', 'past-due')} />
        <Kpi label="Tenants Past Due" value={count(data.pastDue.tenants)}
          sub={share(pct(data.pastDue.tenants, data.units.rented), 'of rented units')}
          to="Show every tenant past due" onClick={() => go('collections', 'past-due')} />
        <Kpi label="Older Than 30 Days" value={money(older, { compact: true })}
          sub={share(pct(older, data.pastDue.total, 0), 'of the past-due balance')}
          to="Show tenants with a balance older than 30 days" onClick={() => go('collections', 'past-due', 'older')} />
        <Kpi label="Collected" value={money(stats.collected, { compact: true })}
          sub={oneMonth ? joinSub(range.label, share(pct(stats.collected, data.rent.rentRoll, 0), 'of the monthly rent roll')) : range.label}
          to="Show money collected per day" onClick={() => go('collections', 'collected')} />
        <Kpi label="Failed Payments" value={count(stats.failed)} sub={range.label}
          to="Show the failed payments" onClick={() => go('collections', 'failed')} />
      </div>

      <div className="ops-grid-2">
        <Card title="Past Due by Age" sub="Select a bar to list the tenants in it. Older balances are darker.">
          <AgingChart buckets={data.pastDue.buckets} onPick={(key) => go('collections', 'past-due', key)} />
        </Card>
        <Card id="collected" focus={focus} title={series.length && series[0].date.length === 7 ? 'Collected per Month' : 'Collected per Day'}
          sub={`Successful payments, ${range.label.toLowerCase()}`}>
          <CollectionsChart daily={series} />
        </Card>
      </div>

      <Card id="past-due" focus={focus} title="Tenants Past Due" sub="Largest balance first. Select a name to open the tenant in Cubby."
        right={filter && (
          <button type="button" className="ops-chip" onClick={() => go('collections', 'past-due')}>
            {PAST_DUE_FILTERS[filter].label} - {count(rows.length)} of {count(data.pastDue.rows.length)}
            <X size={13} aria-hidden="true" /><span className="sr-only">Clear filter</span>
          </button>
        )}>
        <Rows id="past-due" title="Tenants Past Due" key={filter || 'all'} label="tenants" empty={filter ? 'No tenants match this filter.' : 'Nobody is past due.'} rows={rows} columns={[
          { head: 'Unit', cell: (r) => strong(r.unit) },
          { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
          facilityCol(many),
          { head: 'Amount', num: true, cell: (r) => money(r.amount, { exact: true }) },
          { head: 'Oldest Balance', cell: (r) => badge(r.oldest === 'd0_30' ? 'pill-muted' : r.oldest === 'd30_60' ? 'status-pending' : 'status-rejected', agingLabel(r.oldest)) },
          { head: 'Paid Through', cell: (r) => formatDate(r.paidThrough, '-') },
          { head: 'Autopay', cell: (r) => (r.autoPay ? 'On' : 'Off') },
          { head: 'Overlocked', cell: (r) => (r.overlocked ? 'Yes' : 'No') },
          { head: '', cell: (r) => <CubbyLink url={r.url} /> },
        ]} />
      </Card>

      <div className="ops-grid-2">
        <Card id="failed" focus={focus} title="Failed Payments" sub="Declined or returned, most recent first. Listed for the last 31 days; a name opens the tenant in Cubby, where the attempt is under Payments.">
          <Rows id="failed" title="Failed Payments" limit={6} label="payments" empty="No failed payments listed for this period." rows={stats.failedRows} columns={[
            { head: 'Date', cell: (r) => formatDate(r.date) },
            { head: 'Tenant', cell: (r) => <Tenant row={r} fallback="Former tenant" /> },
            { head: 'Units Rented', cell: (r) => r.unit || '-' },
            facilityCol(many),
            { head: 'Amount', num: true, cell: (r) => money(r.amount, { exact: true }) },
            { head: 'Reason', cell: (r) => r.reason || '-' },
            { head: '', cell: (r) => <CubbyLink url={r.url} /> },
          ]} />
        </Card>
        <Card title="Past-Due Balance Over Time" sub="One point per day, saved by Nexus">
          <PastDueTrendChart points={points} />
        </Card>
      </div>
    </>
  );
}

// ── Units & Pricing ───────────────────────────────────────────────────────────

export function Units({ data, many, focus, go }) {
  useScrollTo(focus);
  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Vacant Units" value={count(data.units.vacant)}
          sub={share(pct(data.units.vacant, data.units.rented + data.units.vacant), 'of rentable units')}
          to="Show vacant units by type" onClick={() => go('units', 'unit-types')} />
        <Kpi label="Empty Rent per Month" value={money(data.rent.vacantPotential, { compact: true })}
          sub="Vacant units at today's street rate"
          to="Show empty rent by unit type" onClick={() => go('units', 'unit-types')} />
        <Kpi label="Off Market" value={count(data.units.unavailable)}
          sub={share(pct(data.units.unavailable, data.units.total), 'of storage units cannot be rented')}
          to="Show the off-market units and why" onClick={() => go('units', 'off-market')} />
        <Kpi label="Under Street Rate" value={money(data.rent.belowStreetGap, { compact: true })}
          sub={`Per month, across ${count(data.rent.belowStreetCount)} tenants`}
          to="Show tenants paying under the street rate" onClick={() => go('units', 'below-street')} />
        <Kpi label="Rent per Rented Sq Ft" value={data.area.rented ? money(storageRent(data) / data.area.rented, { exact: true }) : '-'}
          sub={`${count(data.area.rented)} of ${count(data.area.total)} sq ft rented`}
          to="Show rent by unit type" onClick={() => go('units', 'unit-types')} />
      </div>

      <Card id="unit-types" focus={focus} title="Unit Types" sub="Most empty rent first. The bar shows each type's rented, vacant and off-market units."
        right={<Legend items={[['Rented', 'var(--ops-s1)'], ['Vacant', 'var(--ops-s2)'], ['Off Market', 'var(--ops-neutral)']]} />}>
        <Rows id="unit-types" title="Unit Types" label="unit types" empty="No units." rows={data.unitTypes} columns={[
          { head: 'Unit Type', cell: (t) => strong(t.name) },
          { head: 'Units', num: true, cell: (t) => count(t.total) },
          { head: 'Mix', cell: (t) => <MixBar rented={t.rented} vacant={t.vacant} off={t.unavailable} /> },
          { head: 'Occupancy', num: true, cell: (t) => pct(t.rented, t.total, 0) },
          { head: 'Vacant', num: true, cell: (t) => count(t.vacant) },
          { head: 'Off Market', num: true, cell: (t) => count(t.unavailable) },
          { head: 'Street Rate', num: true, cell: (t) => money(t.street) },
          { head: 'Average Rent', num: true, cell: (t) => (t.rented ? money(t.rentSum / t.rented) : '-') },
          { head: 'Empty Rent / Month', num: true, cell: (t) => (t.vacantPotential ? strong(money(t.vacantPotential)) : '-') },
        ]} />
      </Card>

      <div className="ops-grid-2">
        <Card id="below-street" focus={focus} title="Tenants Under Street Rate" sub="Rent-increase candidates, largest gap first">
          <Rows id="below-street" title="Tenants Under Street Rate" limit={6} label="tenants" empty="Every tenant is at or above the street rate." rows={data.belowStreet} columns={[
            { head: 'Unit', cell: (r) => strong(r.unit) },
            { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
            facilityCol(many),
            { head: 'Rent', num: true, cell: (r) => money(r.rent) },
            { head: 'Street', num: true, cell: (r) => money(r.street) },
            { head: 'Gap', num: true, cell: (r) => money(r.street - r.rent) },
            { head: 'Moved In', cell: (r) => formatDate(r.moveIn, '-') },
          ]} />
        </Card>
        <Card id="off-market" focus={focus} title="Off-Market Units" sub="Storage units that cannot be rented, and why. Mailboxes are not listed.">
          <Rows id="off-market" title="Off-Market Units" limit={6} label="units" empty="Every unit can be rented." rows={data.offMarket} columns={[
            { head: 'Unit', cell: (r) => strong(r.unit) },
            facilityCol(many),
            { head: 'Unit Type', cell: (r) => r.type },
            { head: 'Reason', cell: (r) => OFF_MARKET_REASON[r.reason] || 'Other' },
            { head: 'Note', cell: (r) => r.note || '-' },
            { head: 'Street Rate', num: true, cell: (r) => money(r.street) },
          ]} />
        </Card>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Which units count as mailboxes or switched off is set in Settings &gt; Operations &gt; Unit Rules.</div>
    </>
  );
}

// ── Worklist ("Facility Tasks", Oct 21) ──────────────────────────────────────────────────────────────

export function Worklist({ data, many, focus, go }) {
  useScrollTo(focus);
  const lockCols = [
    { head: 'Unit', cell: (r) => strong(r.unit) },
    { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
    facilityCol(many),
    { head: 'Paid Through', cell: (r) => formatDate(r.paidThrough, '-') },
    { head: '', cell: (r) => <CubbyLink url={r.url} /> },
  ];
  const moveCols = (head) => [
    { head: 'Unit', cell: (r) => strong(r.unit) },
    { head: 'Tenant', cell: (r) => <Tenant row={r} /> },
    facilityCol(many),
    { head, cell: (r) => formatDate(r.date, '-') },
    { head: '', cell: (r) => <CubbyLink url={r.url} /> },
  ];
  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Overlocks to Place" value={count(data.locks.toPlace.length)} sub={`${count(data.locks.applied)} units overlocked now`}
          to="Show units that need an overlock" onClick={() => go('worklist', 'locks-place')} />
        <Kpi label="Locks to Remove" value={count(data.locks.toRemove.length)} sub="Overlocked units that have paid"
          to="Show locks waiting to come off" onClick={() => go('worklist', 'locks-remove')} />
        <Kpi label="Open Tasks" value={count(data.tasks.open)} sub={`${count(data.tasks.overdue)} overdue`}
          to="Show the open tasks" onClick={() => go('worklist', 'tasks')} />
        <Kpi label="Open Leads" value={count(data.leads.open)} sub={share(pct(data.leads.converted, data.leads.total, 0), `of ${count(data.leads.total)} leads became tenants`)}
          to="Show the open leads" onClick={() => go('worklist', 'leads')} />
        <Kpi label="Scheduled Move-Outs" value={count(data.moves.movingOut.length)} sub={`${count(data.moves.movingIn.length)} move-ins booked`}
          to="Show scheduled move-outs" onClick={() => go('worklist', 'move-outs')} />
      </div>

      <div className="ops-grid-2">
        <Card id="locks-place" focus={focus} title="Overlocks to Place" sub="Cubby flags these units as needing a lock">
          <Rows id="locks-place" title="Overlocks to Place" limit={6} label="units" empty="No units need an overlock." rows={data.locks.toPlace} columns={lockCols} />
        </Card>
        <Card id="locks-remove" focus={focus} title="Locks to Remove" sub="Paid up, lock still on">
          <Rows id="locks-remove" title="Locks to Remove" limit={6} label="units" empty="No locks waiting to come off." rows={data.locks.toRemove} columns={lockCols} />
        </Card>
      </div>

      <div className="ops-grid-2">
        <Card id="tasks" focus={focus} title="Open Tasks" sub="From Cubby, earliest due date first">
          <Rows id="tasks" title="Open Tasks" limit={6} label="tasks" empty="No open tasks." rows={data.tasks.rows} columns={[
            { head: 'Task', cell: (r) => strong(r.title) },
            { head: 'Unit', cell: (r) => r.unit || '-' },
            facilityCol(many),
            { head: 'Due', cell: (r) => formatDate(r.dueDate, '-') },
            { head: 'Status', cell: (r) => (r.overdue ? badge('status-rejected', 'Overdue') : badge('pill-muted', 'Open')) },
          ]} />
        </Card>
        <Card id="leads" focus={focus} title="Open Leads" sub="Longest wait first">
          <Rows id="leads" title="Open Leads" limit={6} label="leads" empty="No open leads." rows={data.leads.rows} columns={[
            { head: 'Status', cell: (r) => badge(r.status === 'NEW' ? 'status-pending' : r.status === 'RESERVATION' ? 'status-approved' : 'pill-muted', LEAD_STATUS[r.status] || 'Open') },
            { head: 'Name', cell: (r) => <Tenant row={r} /> },
            { head: 'Source', cell: (r) => tidy(r.source) || '-' },
            facilityCol(many),
            { head: 'Waiting', num: true, cell: (r) => (r.ageDays === 1 ? '1 day' : `${count(r.ageDays)} days`) },
            { head: 'Wants to Move In', cell: (r) => formatDate(r.targetMoveIn, '-') },
            { head: '', cell: (r) => <CubbyLink url={r.url} /> },
          ]} />
        </Card>
      </div>

      <div className="ops-grid-2">
        <Card id="move-outs" focus={focus} title="Scheduled Move-Outs" sub="Units about to come back on the market">
          <Rows id="move-outs" title="Scheduled Move-Outs" limit={6} label="move-outs" empty="No move-outs scheduled." rows={data.moves.movingOut} columns={moveCols('Moving Out')} />
        </Card>
        <Card title="Upcoming Move-Ins" sub="Leases signed with a future start date">
          <Rows id="move-ins" title="Upcoming Move-Ins" limit={6} label="move-ins" empty="No move-ins booked ahead." rows={data.moves.movingIn} columns={moveCols('Moving In')} />
        </Card>
      </div>
    </>
  );
}
