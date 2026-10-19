// Tickets > Reports (Oct 2026). Every number comes from the server
// (GET /task-tickets/reports - backend/ticket_reports.py build_report, the
// same builder the CSV and the Monday Weekly Ticket Report email use), so the
// report sees every ticket the caller may see over the chosen dates, with the
// honest-SLA pauses, instead of whatever the list happened to have loaded.
// Nothing is computed here beyond formatting and sorting.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, ArrowUp, ArrowDown, ArrowUpDown, Mail } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, btn, input as inputStyle, chip, PRIORITY_META } from '../tasks/theme';
import { Card } from '../tasks/views/charts';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatMonthDay } from '../lib/datetime';
import { presetRange, fmtHours } from './ticketReportRange';

const PRESETS = [
  ['this_week', 'This Week'], ['last_week', 'Last Week'], ['last_30', 'Last 30 Days'],
  ['this_quarter', 'This Quarter'], ['custom', 'Custom'],
];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const SERIES = [
  { key: 'created', label: 'Created', color: NX.blue },
  { key: 'resolved', label: 'Resolved', color: NX.green },
  { key: 'breached', label: 'Breached', color: NX.red },
];
const BREAKDOWNS = [
  ['type', 'By Type'], ['priority', 'By Priority'], ['department', 'By Department'],
  ['helpTopic', 'By Help Topic'], ['serviceArea', 'By Service Area'], ['company', 'By Company'],
  ['source', 'By Source'],
];

const fmtPct = (p) => (p == null ? '-' : `${p}%`);
const fmtCsat = (c) => (c == null ? '-' : `${c.toFixed(1)}/5`);

const th = { padding: '8px 10px', fontSize: 11.5, fontWeight: 700, color: NX.dim, textAlign: 'left', borderBottom: `1px solid ${NX.border}`, whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13, color: NX.ink, borderBottom: `1px solid ${NX.border2}`, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const num = { textAlign: 'right' };

// A table that scrolls sideways inside its card on a phone, never the page.
function ScrollTable({ minWidth = 480, children }) {
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}>
      <table style={{ width: '100%', minWidth, borderCollapse: 'collapse', fontFamily: FONT }}>{children}</table>
    </div>
  );
}

function Tile({ label, value, hint, color }) {
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${NX.border}`, background: NX.surface, padding: '14px 16px', minWidth: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || NX.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: NX.faint, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function TrendChart({ trend, granularity }) {
  const max = Math.max(1, ...trend.flatMap((b) => SERIES.map((s) => b[s.key])));
  const H = 140;
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        {SERIES.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: NX.dim }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <div role="img" aria-label="Created, resolved and breached tickets over time"
          style={{ display: 'flex', alignItems: 'flex-end', gap: 6, minWidth: trend.length * 34, height: H + 22 }}>
          {trend.map((b) => (
            <div key={b.key} title={`${granularity === 'week' ? 'Week of ' : ''}${formatDate(b.key)}: ${b.created} created, ${b.resolved} resolved, ${b.breached} breached`}
              style={{ flex: '1 0 28px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: H }}>
                {SERIES.map((s) => (
                  <div key={s.key} style={{ width: 7, borderRadius: 3, background: s.color, height: b[s.key] ? Math.max(3, (b[s.key] / max) * H) : 0 }} />
                ))}
              </div>
              <span style={{ fontSize: 10, color: NX.faint, whiteSpace: 'nowrap' }}>{formatMonthDay(b.key)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AgingTable({ aging }) {
  const rows = [...aging.buckets, { key: 'paused', label: 'Paused', ...aging.paused }];
  return (
    <>
      <ScrollTable minWidth={460}>
        <thead><tr>
          <th style={th}>Age</th><th style={{ ...th, ...num }}>Total</th>
          {PRIORITIES.map((p) => <th key={p} style={{ ...th, ...num }}>{PRIORITY_LABEL[p]}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={r.key === 'paused' ? { background: NX.surface2 } : undefined}>
              <td style={{ ...td, fontWeight: r.key === 'paused' ? 700 : 500 }}>{r.label}</td>
              <td style={{ ...td, ...num, fontWeight: 700 }}>{r.total}</td>
              {PRIORITIES.map((p) => <td key={p} style={{ ...td, ...num, color: r.byPriority[p] ? (PRIORITY_META[p]?.color || NX.ink) : NX.faint }}>{r.byPriority[p]}</td>)}
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 8 }}>
        Age counts only the time the SLA clock ran. Paused tickets ({aging.paused.waitingOnRequester} waiting on the requester, {aging.paused.pendingApproval} pending approval) are not aging.
      </div>
    </>
  );
}

const AGENT_COLS = [
  { key: 'name', label: 'Agent' },
  { key: 'open', label: 'Open', num: true },
  { key: 'resolved', label: 'Resolved', num: true },
  { key: 'firstResponseMedianHours', label: 'Median First Response', num: true, fmt: fmtHours },
  { key: 'resolutionMedianHours', label: 'Median Resolution', num: true, fmt: fmtHours },
  { key: 'slaMetPct', label: 'SLA Met', num: true, fmt: fmtPct },
  { key: 'csatAvg', label: 'CSAT', num: true, fmt: fmtCsat },
  { key: 'oldestOpenDays', label: 'Oldest Open', num: true, fmt: (d) => (d == null ? '-' : `${d} days`) },
];

function sortAgents(agents, sort) {
  const col = AGENT_COLS.find((c) => c.key === sort.key) || AGENT_COLS[1];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...agents].sort((a, b) => {
    const av = a[col.key]; const bv = b[col.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;        // no value always last
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

function AgentTable({ agents }) {
  const [sort, setSort] = useState({ key: 'open', dir: 'desc' });
  const rows = useMemo(() => sortAgents(agents, sort), [agents, sort]);
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  if (!agents.length) return <div style={{ fontSize: 12.5, color: NX.faint, padding: '12px 0' }}>No tickets in this range.</div>;
  return (
    <ScrollTable minWidth={760}>
      <thead><tr>
        {AGENT_COLS.map((c) => {
          const Icon = sort.key !== c.key ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
          return (
            <th key={c.key} style={{ ...th, ...(c.num ? num : {}) }} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button type="button" onClick={() => onSort(c.key)} style={{ ...btn('ghost'), padding: 0, fontSize: 11.5, fontWeight: 700, color: sort.key === c.key ? NX.ink : NX.dim }}>
                {c.label} <Icon size={11} />
              </button>
            </th>
          );
        })}
      </tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={`${a.kind}:${a.email || a.name}`}>
            {AGENT_COLS.map((c) => (
              <td key={c.key} style={{ ...td, ...(c.num ? num : {}), ...(c.key === 'name' ? { fontWeight: 600, color: a.kind === 'agent' ? NX.ink : NX.dim } : {}) }}>
                {c.fmt ? c.fmt(a[c.key]) : a[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}

function BreakdownTable({ rows }) {
  if (!rows.length) return <div style={{ fontSize: 12.5, color: NX.faint, padding: '12px 0' }}>Nothing to show.</div>;
  const max = Math.max(1, ...rows.map((r) => r.created));
  return (
    <ScrollTable minWidth={340}>
      <thead><tr>
        <th style={th}>Name</th><th style={{ ...th, ...num }}>Created</th><th style={{ ...th, ...num }}>Resolved</th><th style={{ ...th, ...num }}>Open</th>
      </tr></thead>
      <tbody>
        {rows.slice(0, 10).map((r) => (
          <tr key={r.key || '-'}>
            <td style={{ ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.label}>
              {r.label}
              <div style={{ height: 4, marginTop: 4, borderRadius: 4, background: NX.surface2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(r.created / max) * 100}%`, background: NX.blue, borderRadius: 4 }} />
              </div>
            </td>
            <td style={{ ...td, ...num, fontWeight: 700 }}>{r.created}</td>
            <td style={{ ...td, ...num }}>{r.resolved}</td>
            <td style={{ ...td, ...num }}>{r.open}</td>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}

function WeeklyEmailSwitch() {
  const [pref, setPref] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getTicketWeeklyEmail()).then((p) => { if (alive) setPref(p); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!pref?.eligible) return null;
  const toggle = async () => {
    setBusy(true);
    try { setPref(await api.setTicketWeeklyEmail(!pref.on)); } catch { /* keep the old value */ }
    finally { setBusy(false); }
  };
  const title = !pref.deskEnabled ? 'The weekly email is turned off for the whole desk in the notification settings'
    : pref.on ? 'You get last week\'s report every Monday morning' : 'You do not get the Monday report';
  return (
    <button type="button" onClick={toggle} disabled={busy} title={title} aria-pressed={pref.on}
      style={{ ...btn('outline'), padding: '7px 11px', fontSize: 13, opacity: busy ? 0.6 : 1 }}>
      <Mail size={14} /> Weekly Email: {pref.on ? 'On' : 'Off'}
    </button>
  );
}

// `listFilters`: the list's current filters that the server understands -
// { priority, type, department, assignee, service_area } ('' = any).
// `filterLabels`: their human labels for the chips.
export default function TicketReports({ listFilters = {}, filterLabels = [], companies = [] }) {
  const [preset, setPreset] = useState('last_30');
  const [custom, setCustom] = useState(() => presetRange('last_30'));
  const [company, setCompany] = useState('');
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [exporting, setExporting] = useState(false);

  const [start, end] = preset === 'custom' ? custom : presetRange(preset);
  const params = useMemo(() => {
    const p = { start, end, company };
    for (const [k, v] of Object.entries(listFilters)) if (v) p[k] = v;
    return Object.fromEntries(Object.entries(p).filter(([, v]) => v));
  }, [start, end, company, listFilters]);
  const key = JSON.stringify(params);

  const load = useCallback(() => {
    let alive = true;
    Promise.resolve()
      .then(() => {
        if (alive) setState((s) => ({ loading: true, error: null, data: s.data }));
        return api.getTicketReport(params);
      })
      .then((data) => { if (alive) setState({ loading: false, error: null, data }); })
      .catch((error) => { if (alive) setState({ loading: false, error, data: null }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => load(), [load]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.ticketReportCsv(params);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'ticket-report.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { /* the button stays; a retry is one click */ }
    finally { setExporting(false); }
  };

  const data = state.data;
  const k = data?.kpis;
  const customBad = preset === 'custom' && (!custom[0] || !custom[1] || custom[1] < custom[0]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT, minWidth: 0 }} data-testid="ticket-reports">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="scroll-tabs" role="tablist" aria-label="Date range"
          style={{ display: 'flex', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, maxWidth: '100%' }}>
          {PRESETS.map(([kk, lab]) => (
            <button key={kk} type="button" role="tab" aria-selected={preset === kk} onClick={() => setPreset(kk)} style={{
              ...btn('ghost'), padding: '6px 10px', borderRadius: 7, whiteSpace: 'nowrap', fontSize: 12.5,
              background: preset === kk ? NX.surface : 'transparent', color: preset === kk ? NX.ink : NX.dim,
              boxShadow: preset === kk ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}>{lab}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" aria-label="Start date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} style={{ ...inputStyle, width: 150, padding: '6px 8px', fontSize: 13 }} />
            <span style={{ color: NX.faint, fontSize: 12 }}>to</span>
            <input type="date" aria-label="End date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} style={{ ...inputStyle, width: 150, padding: '6px 8px', fontSize: 13 }} />
          </div>
        )}
        {companies.length > 1 && (
          <select aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)} style={{ ...inputStyle, width: 'auto', minWidth: 150, padding: '6px 8px', fontSize: 13 }}>
            <option value="">All Companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <WeeklyEmailSwitch />
          <button type="button" onClick={exportCsv} disabled={exporting || customBad} style={{ ...btn('outline'), padding: '7px 11px', fontSize: 13, opacity: exporting ? 0.6 : 1 }}>
            <Download size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: NX.dim }}>
        <span>{data?.range?.label || `${formatDate(start)} - ${formatDate(end)}`}</span>
        {filterLabels.map((l) => <span key={l} style={chip(NX.blue, 'rgba(37,99,235,0.12)')}>{l}</span>)}
        {filterLabels.length > 0 && <span style={{ color: NX.faint }}>From the list&apos;s filters</span>}
      </div>

      {customBad ? (
        <div style={{ fontSize: 13, color: NX.dim, padding: 12 }}>Pick a start date on or before the end date.</div>
      ) : (
        <AsyncSection loading={state.loading && !data} error={state.error} onRetry={load}
          errorMessage="The report couldn't be loaded right now - please try again."
          isEmpty={!!data && !data.hasTickets}
          emptyContent={<div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 32 }}>No tickets in this range.</div>}
          skeleton={<div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <SkeletonBlocks count={8} height={74} gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" />
            <SkeletonBlocks count={2} height={200} />
          </div>}>
          {data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: state.loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                <Tile label="Created" value={k.created} />
                <Tile label="Resolved" value={k.resolved} />
                <Tile label="Open Now" value={k.openNow} color={NX.blue} />
                <Tile label="Backlog Change" value={k.backlogChange > 0 ? `+${k.backlogChange}` : k.backlogChange} color={k.backlogChange > 0 ? NX.amber : k.backlogChange < 0 ? NX.green : NX.ink} hint="Created minus resolved" />
                <Tile label="Median First Response" value={fmtHours(k.firstResponseMedianHours)} hint={`Average ${fmtHours(k.firstResponseAvgHours)}`} />
                <Tile label="Median Resolution" value={fmtHours(k.resolutionMedianHours)} hint="Paused time left out" />
                <Tile label="SLA Met" value={fmtPct(k.slaMetPct)} color={k.slaMetPct != null && k.slaMetPct < 80 ? NX.red : k.slaMetPct != null ? NX.green : NX.ink} hint={`${k.slaMeasured} resolved with a target`} />
                <Tile label="First Response Met" value={fmtPct(k.firstResponseMetPct)} color={k.firstResponseMetPct != null && k.firstResponseMetPct < 80 ? NX.red : k.firstResponseMetPct != null ? NX.green : NX.ink} hint={`${k.firstResponseMeasured} measured`} />
                <Tile label="Breached Now" value={k.breachedNow} color={k.breachedNow ? NX.red : NX.ink} />
                <Tile label="Reopened" value={k.reopened} color={k.reopened ? NX.amber : NX.ink} />
                <Tile label="Avg CSAT" value={fmtCsat(k.csatAvg)} hint={`${k.csatCount} rated`} />
              </div>

              <Card title={data.range.granularity === 'week' ? 'Trend by Week' : 'Trend by Day'}>
                <TrendChart trend={data.trend} granularity={data.range.granularity} />
              </Card>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 14 }}>
                <Card title="Open Tickets by Age"><AgingTable aging={data.aging} /></Card>
                <Card title="Recurring Subjects">
                  {data.recurring.length === 0
                    ? <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 12, color: NX.faint }}>No repeats in this range - every subject is unique.</div>
                    : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {data.recurring.map((g) => (
                          <div key={g.label} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                            <span style={{ ...chip(NX.red, 'rgba(220,38,38,0.14)'), flexShrink: 0 }}>×{g.count}</span>
                            <span style={{ fontSize: 12.5, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                          </div>
                        ))}
                        <div style={{ fontSize: 11, color: NX.faint, marginTop: 2 }}>Repeats often signal a fix-once or replacement opportunity, not more repairs.</div>
                      </div>
                    )}
                </Card>
              </div>

              <Card title="By Agent"><AgentTable agents={data.agents} /></Card>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 14 }}>
                {BREAKDOWNS.map(([dim, title]) => (
                  <Card key={dim} title={title}><BreakdownTable rows={data.breakdowns[dim] || []} /></Card>
                ))}
              </div>
            </div>
          )}
        </AsyncSection>
      )}
    </div>
  );
}
