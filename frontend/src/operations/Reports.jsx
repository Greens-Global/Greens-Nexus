// Operations -> Reports. Four parts (Neil, Oct 20; library Oct 20):
//   Reports        - the report library: search, favorites, open any report
//                    as an interactive table, download XLSX / PDF / CSV
//                    (CubbyReports.jsx, ReportLibrary.jsx, ReportRunDialog.jsx)
//   Scheduled      - reports emailed on a schedule (ReportSchedules.jsx)
//   Report Builder - your own metrics, saved, shared and scheduled (lazy-loaded)
//   Quick Exports  - every list on the other tabs, and Cubby's own rent roll
//                    and aged receivables, as a spreadsheet (Oct 13).
// Follows the facility picker; the period only applies where a report is
// about activity over time.
import { lazy, Suspense, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import CubbyReports from './CubbyReports';
import SectionPicker from './SectionPicker';
import ReportSchedules, { ScheduleDialog, blankSchedule, useSchedules } from './ReportSchedules';
import { todayIso } from './reportPeriod';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { csvName, downloadCsv } from './csv';
import { rentedAll } from './occupancy';
import { AGING, LEAD_STATUS, OFF_MARKET_REASON, agingLabel, periodStats, tidy } from './model';

const usd = (cents) => ((Number(cents) || 0) / 100).toFixed(2);
const pctOf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '');
const yesNo = (v) => (v ? 'Yes' : 'No');

// Built from what is already on screen: [title, what it is, () => [columns, rows], uses the period]
function localReports(data, facilities, scope, range) {
  const stats = periodStats(data, range);
  return [
    ['Facility Scorecard', 'One line per facility: units, occupancy, rent roll, past due, autopay.', () => [
      // Storage units, occupancy of rentable ones; mailboxes in their own columns (occupancy.js).
      ['Facility', 'Storage Units', 'Rented', 'Vacant', 'Off Market', 'Occupancy (of Rentable)', 'Mailboxes', 'Mailboxes Rented', 'Mailbox Occupancy',
        'Rent Roll', 'Past Due', 'Past Due / Rent', 'Tenants Past Due', 'On Autopay'],
      scope.map((f) => [f.shortName, f.units.total, f.units.rented, f.units.vacant, f.units.unavailable, pctOf(f.units.rented, f.units.rented + f.units.vacant),
        f.mailboxes?.total || 0, f.mailboxes?.rented || 0, pctOf(f.mailboxes?.rented || 0, f.mailboxes?.total || 0),
        usd(f.rent.rentRoll), usd(f.pastDue.total), pctOf(f.pastDue.total, f.rent.rentRoll), f.pastDue.tenants, pctOf(f.autoPay, rentedAll(f))]),
    ]],
    ['Tenants Past Due', 'Who owes, how much, and how old the balance is.', () => [
      ['Facility', 'Unit', 'Tenant', 'Amount Due', 'Oldest Balance', ...AGING.map((a) => a.label), 'Paid Through', 'Autopay', 'Overlocked'],
      data.pastDue.rows.map((r) => [r.facility, r.unit, r.tenant, usd(r.amount), agingLabel(r.oldest),
        ...AGING.map((a) => usd(r.buckets?.[a.key])), formatDate(r.paidThrough), yesNo(r.autoPay), yesNo(r.overlocked)]),
    ]],
    ['Failed Payments', `Declined or returned payments listed for ${range.label.toLowerCase()} (the last 31 days at most).`, () => [
      ['Facility', 'Date', 'Tenant', 'Units Rented', 'Amount', 'Method', 'Reason'],
      stats.failedRows.map((r) => [r.facility, formatDate(r.date), r.tenant || 'Former tenant', r.unit, usd(r.amount), tidy(r.method), r.reason]),
    ], true],
    ['Collections by Day', `Money collected and failed payments per day, ${range.label.toLowerCase()}.`, () => [
      ['Date', 'Collected', 'Failed Payments'],
      data.payments.daily.filter((d) => d.date >= range.from && d.date <= range.to).map((d) => [formatDate(d.date), usd(d.collected), d.failed]),
    ], true],
    ['Unit Types', 'Occupancy, street rate, average rent and empty rent for every unit type.', () => [
      ['Unit Type', 'Units', 'Rented', 'Vacant', 'Off Market', 'Occupancy', 'Street Rate', 'Average Rent', 'Empty Rent per Month'],
      data.unitTypes.map((t) => [t.name, t.total, t.rented, t.vacant, t.unavailable, pctOf(t.rented, t.total), usd(t.street),
        t.rented ? usd(t.rentSum / t.rented) : '', usd(t.vacantPotential)]),
    ]],
    ['Tenants Under Street Rate', 'Rent-increase candidates: rent, street rate and the gap.', () => [
      ['Facility', 'Unit', 'Tenant', 'Unit Type', 'Rent', 'Street Rate', 'Gap', 'Moved In', 'Last Rent Change'],
      data.belowStreet.map((r) => [r.facility, r.unit, r.tenant, r.type, usd(r.rent), usd(r.street), usd(r.street - r.rent), formatDate(r.moveIn), formatDate(r.lastChange)]),
    ]],
    ['Off-Market Units', 'Units that cannot be rented, and why.', () => [
      ['Facility', 'Unit', 'Unit Type', 'Reason', 'Note', 'Street Rate'],
      data.offMarket.map((r) => [r.facility, r.unit, r.type, OFF_MARKET_REASON[r.reason] || 'Other', r.note, usd(r.street)]),
    ]],
    ['Move-Ins and Move-Outs by Month', 'Month by month, with units rented at each month end.', () => [
      ['Month', 'Move-Ins', 'Move-Outs', 'Net', 'Units Rented at Month End'],
      data.history.map((h) => [`${h.month.slice(5)}/${h.month.slice(0, 4)}`, h.moveIns, h.moveOuts, h.moveIns - h.moveOuts, h.rented]),
    ]],
    ['Facility Tasks', 'Overlocks, open tasks, open leads and scheduled moves in one sheet.', () => [
      ['Facility', 'Kind', 'Unit', 'Tenant or Task', 'Date', 'Detail'],
      [
        ...data.locks.toPlace.map((r) => [r.facility, 'Overlock to Place', r.unit, r.tenant, formatDate(r.paidThrough), 'Paid through']),
        ...data.locks.toRemove.map((r) => [r.facility, 'Lock to Remove', r.unit, r.tenant, formatDate(r.paidThrough), 'Paid through']),
        ...data.tasks.rows.map((r) => [r.facility, 'Task', r.unit, r.title, formatDate(r.dueDate), r.overdue ? 'Overdue' : 'Open']),
        ...data.leads.rows.map((r) => [r.facility, 'Lead', '', r.tenant || tidy(r.source), formatDate(r.targetMoveIn), `${LEAD_STATUS[r.status] || 'Open'}, waiting ${r.ageDays} days`]),
        ...data.moves.movingOut.map((r) => [r.facility, 'Move-Out', r.unit, r.tenant, formatDate(r.date), 'Scheduled']),
        ...data.moves.movingIn.map((r) => [r.facility, 'Move-In', r.unit, r.tenant, formatDate(r.date), 'Booked']),
      ],
    ]],
  ];
}

const CUBBY_REPORTS = [
  ['rent-roll', 'Rent Roll', 'Every unit from Cubby: status, tenant, street rate, rent, paid-through date, autopay and balance.'],
  ['aged-receivables', 'Aged Receivables', 'Every past-due lease from Cubby with its balance split by age.'],
];

const ReportBuilder = lazy(() => import('./ReportBuilder'));

// The facility is the page's one Facility dropdown (Oct 20); no picker of its own.
// Operations' top bar picks the view (Reports menu, Oct 21) through `section` /
// `onSection`; without them the in-page View dropdown does.
export default function Reports({ data, facilities, scope, range, section: sectionProp, onSection }) {
  const [ownSection, setOwnSection] = useState('reports');
  const section = sectionProp || ownSection;
  const setSection = onSection || setOwnSection;
  const [catalog, setCatalog] = useState({ status: 'loading' });
  const [editing, setEditing] = useState(null);   // a schedule being made or changed
  const [flash, setFlash] = useState('');
  const schedules = useSchedules();
  const today = todayIso(facilities[0]?.asOf);

  const [catalogTry, setCatalogTry] = useState(0);
  useEffect(() => {
    let live = true;
    api.opsReportCatalog()
      .then((d) => { if (live) setCatalog({ status: 'ready', data: { categories: d?.categories || [], reports: d?.reports || [] } }); })
      .catch((err) => { if (live) setCatalog({ status: 'error', error: err }); });
    return () => { live = false; };
  }, [catalogTry]);
  const loadCatalog = () => { setCatalog({ status: 'loading' }); setCatalogTry((n) => n + 1); };
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  const count = schedules.list.length;
  const sections = [['reports', 'Reports'], ['scheduled', count ? `Scheduled (${count})` : 'Scheduled'], ['builder', 'Report Builder'], ['exports', 'Quick Exports']];
  const reports = catalog.data?.reports || [];
  const canSchedule = schedules.status !== 'off';
  const scheduleFrom = (meta, choices) => setEditing({ ...blankSchedule(meta, choices?.facilityIds || scope.map((f) => f.id)),
    ...(choices ? { options: choices.options, format: choices.format, period: meta.period && choices.period?.mode !== 'manual' ? choices.period : { mode: 'previous', unit: 'week' } } : {}) });

  const catalogBody = (render) => {
    if (catalog.status === 'loading') return <div className="dash-card"><SkeletonBlocks count={4} height={52} /></div>;
    if (catalog.status === 'error') return <ErrorBanner message="Couldn't load the report list." onRetry={loadCatalog} />;
    return render();
  };

  return (
    <>
      {!onSection && (
        <div className="ops-rep-bar">
          <SectionPicker label="View" value={section} onChange={setSection}
            options={sections.map(([key, label]) => ({ value: key, label }))} />
        </div>
      )}
      {flash && <div className="ops-rep-flash" role="status">{flash}</div>}
      {section === 'reports' && catalogBody(() => (
        <CubbyReports catalog={catalog.data} scope={scope} facilities={facilities} range={range} today={today}
          canSchedule={canSchedule} onSchedule={scheduleFrom} />
      ))}
      {section === 'scheduled' && catalogBody(() => (
        <ReportSchedules schedules={schedules} reports={reports} facilities={facilities}
          onNew={() => setEditing(blankSchedule(null, scope.map((f) => f.id)))} onEdit={(s) => setEditing(s)} />
      ))}
      {section === 'builder' && (
        <Suspense fallback={<div className="dash-card"><SkeletonBlocks count={3} height={70} /></div>}>
          <ReportBuilder scope={scope} facilities={facilities} />
        </Suspense>
      )}
      {section === 'exports' && <QuickExports data={data} facilities={facilities} scope={scope} range={range} />}
      {editing && (
        <ScheduleDialog initial={editing} reports={reports} facilities={facilities} today={today} onClose={() => setEditing(null)}
          onSaved={(s) => { setEditing(null); setFlash(`${s?.name || 'The schedule'} was saved.`); schedules.reload(); }} />
      )}
    </>
  );
}

function QuickExports({ data, facilities, scope, range }) {
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const one = scope.length === 1 ? scope[0] : null;
  const where = one ? one.shortName : 'All Facilities';
  const asOf = facilities[0]?.asOf;

  const fromCubby = async (kind, title) => {
    setBusy(kind);
    setFailed('');
    try {
      const out = await api.facilityOpsReport(kind, one?.id || '');
      downloadCsv(csvName(out.title || title, where, out.asOf || asOf), out.columns, out.rows);
    } catch (err) {
      console.error('Operations report export failed', err);
      setFailed(title);
    } finally {
      setBusy('');
    }
  };

  const Row = ({ title, about, tag, onClick, disabled, count }) => (
    <li className="ops-report">
      <div>
        <div className="ops-report-title">{title}{tag && <span className="status-badge pill-info">{tag}</span>}</div>
        <div className="ops-report-about">{about}{count != null ? ` ${count.toLocaleString('en-US')} rows.` : ''}</div>
      </div>
      <button type="button" className="secondary-btn" onClick={onClick} disabled={disabled}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }} aria-label={`Download ${title} as a spreadsheet`}>
        <Download size={14} aria-hidden="true" /> {disabled && busy ? 'Preparing...' : 'Download CSV'}
      </button>
    </li>
  );

  return (
    <>
      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">From Cubby</div>
            <div className="dash-card-sub">Cubby&apos;s own reports for {where}, as of now. Tenant name, unit and money only: no phone, email or address.</div>
          </div>
        </div>
        {failed && <div className="ops-empty" role="alert">{failed} could not be prepared. Try again.</div>}
        <ul className="ops-reports">
          {CUBBY_REPORTS.map(([kind, title, about]) => (
            <Row key={kind} title={title} about={about} tag="Cubby" onClick={() => fromCubby(kind, title)} disabled={busy === kind} />
          ))}
        </ul>
      </div>

      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">From This Screen</div>
            <div className="dash-card-sub">The lists behind the other tabs, for {where}. Reports about activity follow the period: {range.label.toLowerCase()}.</div>
          </div>
        </div>
        <ul className="ops-reports">
          {localReports(data, facilities, scope, range).map(([title, about, build, timed]) => {
            const [columns, rows] = build();
            return (
              <Row key={title} title={title} about={about} tag={timed ? range.label : null} count={rows.length} disabled={!rows.length}
                onClick={() => downloadCsv(csvName(title, where, asOf), columns, rows)} />
            );
          })}
        </ul>
      </div>
    </>
  );
}
