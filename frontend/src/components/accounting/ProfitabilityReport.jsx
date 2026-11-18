import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api';
import { DateField } from '../../tasks/components';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import Amount, { Figure } from './Amount';
import { BarMore, ColumnResizer, ControlBar, control, EntitiesPicker, ExportMenu, SyncButton, fitSelect, widest } from './reportControls';
import { useColumnWidths, useFitHeight } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import LinesPanel from './LinesPanel';
import { useTableSync } from './tableSync';
import { downloadBlob, iso, presetRange } from './reportModel';
import { linesFile } from './linesExport';
import { breakdown, canDrill, COMPARE_ON, orderedRows, pctText, periodLine, priorLine, PROFIT_COLUMNS, profitTable, TOTAL_CODE, totalRow } from './profitabilityModel';
import { formatDate } from '../../lib/datetime';

// Accounting > Reporting > Profitability (Charmi, 10/15: "a major end of year
// report"; Neil: "we still need to make ... profitability"). One row per
// entity for the period, with NOI, interest, depreciation, net income, debt
// service and cash flow after debt service, and one figure compared with the
// same period a year earlier. The backend computes every figure from the
// ledger (routers/accounting_profitability.py documents which accounts feed
// which line) and honors the entity limit. Clicking a figure opens the
// accounts behind it; an account opens its ledger lines on Reports.

const PERIODS = [
  { key: 'this-year', label: 'This Year' },
  { key: 'ytd', label: 'Year-to-Date' },
  { key: 'last-year', label: 'Last Year' },
  { key: 'this-quarter', label: 'This Quarter' },
  { key: 'last-quarter', label: 'Last Quarter' },
  { key: 't12m', label: 'Trailing 12 Months' },
  { key: 'custom', label: 'Custom' },
];
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'right', padding: '6px 8px', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', minWidth: 96 };
const thLeft = { ...th, textAlign: 'left', minWidth: 200, position: 'sticky', left: 0, background: 'var(--bg-card)', zIndex: 1 };
const td = { padding: '5px 8px', borderBottom: '1px solid var(--border-color)', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const tdLeft = { ...td, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg-card)', whiteSpace: 'normal' };
const cellBtn = { border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 };
// 10/23 meeting, item 02 (fix 10/24): the words sit beside the controls, not above them, so the bar is one line.
const inline = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' };

const BREAKDOWN_COLUMNS = [['line', 'Line'], ['account', 'Account'], ['title', 'Title'], ['amount', 'Amount']];

const rangeOf = (key) => { const [f, t] = presetRange(key); return [iso(f), iso(t)]; };

export default function ProfitabilityReport({ limited = false }) {
  const [period, setPeriod] = useState('this-year');
  const [[from, to], setRange] = useState(() => rangeOf('this-year'));
  const [picked, setPicked] = useState([]);
  const [book, setBook] = useState('accrual');
  const [expand, setExpand] = useState(false);
  const [compareOn, setCompareOn] = useState('netIncome');
  const [entities, setEntities] = useState([]);
  const [data, setData] = useState(null);
  const [state, setState] = useState({ loading: true, error: '' });
  const [open, setOpen] = useState(null);     // { code, key, period } - code TOTAL_CODE for the Total row
  // Call of 10/27 with Charmi, item 17: an account's amount under a figure
  // opens its ledger lines in the side panel; every column drags wider or
  // narrower, kept per person.
  const [linesOf, setLinesOf] = useState(null);    // { account, title, entity | entities, name, from, to }
  const closeLines = useCallback(() => setLinesOf(null), []);
  const widths = useColumnWidths('profitability', {}, { min: 60 });
  const bw = useColumnWidths('profitability-breakdown', {}, { min: 60 });
  const W = (key, base) => ({ ...base, ...headStyle(widths.width(key)), ...(base === thLeft ? { position: 'sticky' } : {}) });
  const C = (key, base) => ({ ...base, ...cellStyle(widths.width(key)) });
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) setEntities(d?.entities || []); }).catch(() => { if (alive) setEntities([]); });
    return () => { alive = false; };
  }, []);

  // `quiet` (a Sync, 10/23 meeting item 13): the sheet and an open breakdown stay on screen while it reads.
  const load = useCallback((quiet = false) => {
    if (!from || !to || from > to) { setState({ loading: false, error: 'The start date must be on or before the end date.' }); return undefined; }
    if (quiet === true) setState((s) => ({ ...s, syncing: true }));
    else { setState({ loading: true, error: '' }); setOpen(null); }
    return api.getProfitability(from, to, { locations: picked, book, expand })
      .then((d) => { setData(d); setState({ loading: false, error: '' }); })
      .catch((e) => { setData(null); setState({ loading: false, error: e?.message || 'Could not build the Profitability Sheet.' }); });
  }, [from, to, picked, book, expand]);
  useEffect(() => { load(); }, [load]);
  const ts = useTableSync(useCallback(() => load(true), [load]));
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);   // item 05: the sheet scrolls inside its own box

  const pickPeriod = (key) => { setPeriod(key); if (key !== 'custom') setRange(rangeOf(key)); };
  const rows = useMemo(() => orderedRows(data), [data]);
  const withPrior = !!data?.totals?.prior;
  const cmp = COMPARE_ON.find((c) => c.key === compareOn) || COMPARE_ON[0];
  const entityLabel = !picked.length ? (limited ? 'All My Entities' : 'All Entities') : picked.length === 1 ? (entities.find((e) => e.code === picked[0])?.name || picked[0]) : `${picked.length} entities`;

  // The Total row and the Prior Year column open into accounts like any figure.
  const prior = open?.period === 'prior';
  const openBase = open && (open.code === TOTAL_CODE ? totalRow(rows, data?.totals, open.period, entityLabel) : rows.find((r) => r.code === open.code));
  const openRow = openBase && (prior && open.code !== TOTAL_CODE ? { ...openBase, current: openBase.prior } : openBase);
  const openCol = open && PROFIT_COLUMNS.find((c) => c.key === open.key);
  const lines = openRow && openCol ? breakdown(openRow, openCol) : [];
  const openFrom = prior ? data?.priorFrom : data?.from;
  const openTo = prior ? data?.priorTo : data?.to;
  const openWhere = openRow?.code === TOTAL_CODE ? { entities: openRow.entities } : { entity: openRow?.code };

  const exportAs = async (format) => {
    if (!data) return;
    setBusy(format);
    try {
      const file = await linesFile(profitTable(data, { compareOn, entityLabel, bookLabel: book === 'cash' ? 'Cash' : 'Accrual' }), format);
      downloadBlob(file.name, file);
    } finally { setBusy(''); }
  };

  // A figure that opens into its accounts: an entity's or the Total's, this period's or the prior year's.
  const hasAccounts = (row, period) => (row.code === TOTAL_CODE ? rows.some((r) => r[period]?.accounts) : !!row[period]?.accounts);
  const figure = (row, c, period = 'current', strong = c.strong) => {
    const v = row[period]?.[c.key];
    if (c.kind === 'pct') return <Figure text={pctText(v) || '-'} />;
    if (v == null) return <span style={{ color: 'var(--text-muted)' }}>-</span>;
    const amt = <Amount value={v} zero="dash" style={strong ? { fontWeight: 700 } : undefined} />;
    if (!canDrill(c) || Math.abs(v) < 0.005 || !hasAccounts(row, period)) return amt;
    return (
      <button type="button" style={cellBtn} onClick={() => setOpen({ code: row.code, key: c.key, period })} title={`Show the accounts behind ${c.label}`}
        aria-label={`${period === 'prior' ? 'Prior Year ' : ''}${c.label} for ${row.name}`}>{amt}</button>
    );
  };
  const lit = (code, key, period = 'current') => (open?.code === code && open?.key === key && (open.period || 'current') === period ? 'var(--wk-brand-tint, #e8ecfd)' : undefined);
  const cmpCol = PROFIT_COLUMNS.find((c) => c.key === compareOn);
  const total = data ? { code: TOTAL_CODE, name: 'Total', current: data.totals?.current, prior: data.totals?.prior } : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <select value={period} onChange={(e) => pickPeriod(e.target.value)} style={{ ...control, ...fitSelect(PERIODS.find((p) => p.key === period)?.label, { base: widest(PERIODS.map((p) => p.label)) }) }} aria-label="Period" title="Period">
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <span style={inline}>
          {/* Charmi 10/28, round 4: the shared DateField, never a native date box (that one follows the PC's region - 31-12-2026). */}
          <span style={{ width: 120 }}><DateField value={from} onChange={(v) => { if (v) { setPeriod('custom'); setRange([v, to]); } }} placeholder="MM/DD/YYYY" title="From" style={{ ...control, width: '100%' }} /></span>
          to
          <span style={{ width: 120 }}><DateField value={to} onChange={(v) => { if (v) { setPeriod('custom'); setRange([from, v]); } }} placeholder="MM/DD/YYYY" title="To" style={{ ...control, width: '100%' }} /></span>
        </span>
        <EntitiesPicker entities={entities} value={picked} onChange={setPicked} limited={limited} />
        <select value={book} onChange={(e) => setBook(e.target.value)} style={{ ...control, ...fitSelect(book === 'cash' ? 'Cash' : 'Accrual', { base: 'Accrual' }) }} aria-label="Book" title="Book">
          <option value="accrual">Accrual</option>
          <option value="cash">Cash</option>
        </select>
        <BarMore level={2} active={compareOn !== COMPARE_ON[0].key ? 1 : 0}>
        <label style={inline}>
          <span className="acct-bar-label-2">Compare On</span>
          <select value={compareOn} onChange={(e) => setCompareOn(e.target.value)} style={{ ...control, ...fitSelect(COMPARE_ON.find((c) => c.key === compareOn)?.label, { base: widest(COMPARE_ON.map((c) => c.label)) }) }} aria-label="Compare On" title="Compare On">
            {COMPARE_ON.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        </BarMore>
        <BarMore level={1} active={expand ? 1 : 0}>
          <label style={{ ...inline, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} /> Show Sub-Entities
          </label>
        </BarMore>
        {/* Round 3 (item 02): on a short row Sync is the fourth to move into More, Export the fifth. */}
        <div className="acct-bar-end">
          <BarMore level={4}>
          <SyncButton onSync={ts.sync} busy={!!state.syncing} syncedAt={ts.syncedAt} />
          </BarMore>
          <BarMore level={5}>
          <ExportMenu disabled={!data || !rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'Workbook with the totals as formulas', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, ready to print', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
            { key: 'csv', label: 'CSV', onPick: () => exportAs('csv'), busy: busy === 'csv' },
          ]} />
          </BarMore>
        </div>
      </ControlBar>

      <AsyncSection loading={state.loading} error={!!state.error} errorMessage={state.error} onRetry={() => load()} skeleton={<SkeletonBlocks count={2} />}
        isEmpty={!!data && !rows.length}
        emptyContent={<div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>Nothing posted to income or expense accounts for these entities in this period.</div>}>
        {data && (
          <div className="acct-scroll-box" ref={setBox} data-testid="profitability-box" style={{ ...card, ...fit }}>
            <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Profitability Sheet</h3>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{entityLabel} · {periodLine(data)}{withPrior ? ` · compared with ${priorLine(data)}` : ''}</span>
            </div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={W('entity', thLeft)}>Entity<ColumnResizer {...widths.resizer('entity', 'Entity')} /></th>
                  {PROFIT_COLUMNS.map((c) => <th key={c.key} style={W(c.key, th)}>{c.label}<ColumnResizer {...widths.resizer(c.key, c.label)} /></th>)}
                  {withPrior && <>
                    <th style={W('prior', th)}>Prior Year {cmp.label}<ColumnResizer {...widths.resizer('prior', 'Prior Year')} /></th>
                    <th style={W('change', th)}>Change $<ColumnResizer {...widths.resizer('change', 'Change $')} /></th>
                    <th style={W('changePct', th)}>Change %<ColumnResizer {...widths.resizer('changePct', 'Change %')} /></th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ch = r.change?.[compareOn] || {};
                  return (
                    <tr key={r.code}>
                      <td style={{ ...C('entity', tdLeft), paddingLeft: 8 + r.depth * 18 }}>
                        <span style={{ fontWeight: r.depth ? 400 : 600 }}>{r.name}</span> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.code}</span>
                      </td>
                      {PROFIT_COLUMNS.map((c) => <td key={c.key} style={{ ...C(c.key, td), background: lit(r.code, c.key) }}>{figure(r, c)}</td>)}
                      {withPrior && (
                        <>
                          <td style={{ ...C('prior', td), background: lit(r.code, compareOn, 'prior') }}>{r.prior?.[compareOn] == null ? '-' : figure(r, cmpCol, 'prior', false)}</td>
                          <td style={C('change', td)}>{ch.amount == null ? '-' : <Amount value={ch.amount} zero="dash" />}</td>
                          <td style={C('changePct', td)}><Figure text={pctText(ch.pct) || '-'} /></td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...tdLeft, fontWeight: 700 }}>Total</td>
                  {PROFIT_COLUMNS.map((c) => <td key={c.key} style={{ ...td, fontWeight: 700, background: lit(TOTAL_CODE, c.key) }}>{figure(total, c, 'current', true)}</td>)}
                  {withPrior && (
                    <>
                      <td style={{ ...td, fontWeight: 700, background: lit(TOTAL_CODE, compareOn, 'prior') }}>{data.totals.prior?.[compareOn] == null ? '-' : figure(total, cmpCol, 'prior', true)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{data.totals.change?.[compareOn]?.amount == null ? '-' : <Amount value={data.totals.change[compareOn].amount} zero="dash" />}</td>
                      <td style={{ ...td, fontWeight: 700 }}><Figure text={pctText(data.totals.change?.[compareOn]?.pct) || '-'} /></td>
                    </>
                  )}
                </tr>
              </tfoot>
            </table>
            <p style={{ margin: 0, padding: '8px 12px 12px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              NOI is revenue less operating expenses; interest and depreciation & amortization are left out of it and come off below NOI.
              Debt service is the monthly payment of each loan set up under Loans & Financing, times the months in the period.
              {data.expand ? ' Sub-entities are already inside their parent, so the totals count them once.' : ''}
              {(data.notes || []).map((n) => <Fragment key={n}> {n}</Fragment>)}
            </p>
          </div>
        )}
      </AsyncSection>

      {openRow && openCol && (
        <div style={{ ...card, overflow: 'auto' }} role="region" aria-label="Accounts Behind the Figure">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 4px' }}>
            <h3 style={{ margin: 0, fontSize: 15, flex: 1 }}>{prior ? 'Prior Year ' : ''}{openCol.label} - {openRow.name}</h3>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close the accounts" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 4 }}><X size={15} /></button>
          </div>
          <p style={{ margin: 0, padding: '0 12px 6px', fontSize: 12, color: 'var(--text-muted)' }}>Click an account or its amount for the ledger lines; Open in Reports there has every filter and the export.</p>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>
              {BREAKDOWN_COLUMNS.map(([k, label]) => (
                <th key={k} style={{ ...th, ...(k === 'amount' ? null : { textAlign: 'left' }), minWidth: 0, ...headStyle(bw.width(k)) }}>{label}<ColumnResizer {...bw.resizer(k, label)} /></th>
              ))}
            </tr></thead>
            <tbody>
              {lines.map((l) => {
                const openLines = () => setLinesOf({ account: l.account, title: l.title, ...openWhere, name: openRow.name, from: openFrom, to: openTo });
                return (
                  <tr key={`${l.group}-${l.account}`}>
                    <td style={{ ...td, textAlign: 'left', ...cellStyle(bw.width('line')) }}>{l.label}</td>
                    <td style={{ ...td, textAlign: 'left', ...cellStyle(bw.width('account')) }}>
                      <button type="button" style={cellBtn} onClick={openLines} title="See the ledger lines behind this account">{l.account}</button>
                    </td>
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', ...cellStyle(bw.width('title')) }}>{l.title}</td>
                    <td style={{ ...td, ...cellStyle(bw.width('amount')) }}>
                      {Math.abs(Number(l.amount) || 0) >= 0.005
                        ? <button type="button" style={cellBtn} onClick={openLines} aria-label={`Lines behind ${l.account} ${l.title}`} title="See the ledger lines behind this amount"><Amount value={l.signed} zero="dash" /></button>
                        : <Amount value={l.signed} zero="dash" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><td style={{ ...td, textAlign: 'left', fontWeight: 700 }} colSpan={3}>{openCol.label}</td><td style={{ ...td, fontWeight: 700 }}><Amount value={openRow.current[openCol.key]} zero="dash" /></td></tr></tfoot>
          </table>
        </div>
      )}
      {linesOf && data && (
        <LinesPanel key={`${linesOf.entity || linesOf.entities.join(',')}|${linesOf.account}|${linesOf.from}`} label={`${linesOf.account} ${linesOf.title}, ${linesOf.name}`} title={`${linesOf.account} ${linesOf.title}`} widthsKey="profitability" onClose={closeLines}
          caption={`${linesOf.name}${linesOf.entity ? ` (${linesOf.entity})` : ''}, ${formatDate(linesOf.from)} - ${formatDate(linesOf.to)}, ${book === 'cash' ? 'Cash' : 'Accrual'}`}
          queries={[{ account: linesOf.account, ...(linesOf.entity ? { location: linesOf.entity } : { locations: linesOf.entities.join(',') }), from: linesOf.from, to: linesOf.to, book }]}
          report={{ account: linesOf.account, accountName: linesOf.title, from: linesOf.from, to: linesOf.to, ...(linesOf.entity ? { entity: linesOf.entity } : { entities: linesOf.entities }), book }} />
      )}
    </div>
  );
}
