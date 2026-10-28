import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import Amount, { Figure } from './Amount';
import { BarMore, ColumnResizer, ControlBar, control, EntitiesPicker, ExportMenu, SyncButton, fitSelect, widest } from './reportControls';
import { useColumnWidths, useFitHeight } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import LinesPanel from './LinesPanel';
import { useTableSync } from './tableSync';
import { downloadBlob, iso, presetRange } from './reportModel';
import { requestReportDrill } from './drill';
import { linesFile } from './linesExport';
import { breakdown, canDrill, COMPARE_ON, orderedRows, pctText, periodLine, priorLine, PROFIT_COLUMNS, profitTable } from './profitabilityModel';

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
const th = { textAlign: 'right', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', minWidth: 96 };
const thLeft = { ...th, textAlign: 'left', minWidth: 200, position: 'sticky', left: 0, background: 'var(--bg-card)', zIndex: 1 };
const td = { padding: '5px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const tdLeft = { ...td, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg-card)', whiteSpace: 'normal' };
const cellBtn = { border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 };
// 10/23 meeting, item 02 (fix 10/24): the words sit beside the controls, not above them, so the bar is one line.
const inline = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' };

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
  const [open, setOpen] = useState(null);     // { code, key }
  // Call of 10/27 with Charmi, item 17: an account's amount under a figure
  // opens its ledger lines in the side panel; every column drags wider or
  // narrower, kept per person.
  const [linesOf, setLinesOf] = useState(null);    // { account, title, entity, name }
  const closeLines = useCallback(() => setLinesOf(null), []);
  const widths = useColumnWidths('profitability', {}, { min: 60 });
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
  const entityLabel = !picked.length ? (limited ? 'All my entities' : 'All entities') : picked.length === 1 ? (entities.find((e) => e.code === picked[0])?.name || picked[0]) : `${picked.length} entities`;

  const openRow = open && rows.find((r) => r.code === open.code);
  const openCol = open && PROFIT_COLUMNS.find((c) => c.key === open.key);
  const lines = openRow && openCol ? breakdown(openRow, openCol) : [];

  const exportAs = async (format) => {
    if (!data) return;
    setBusy(format);
    try {
      const file = await linesFile(profitTable(data, { compareOn, entityLabel, bookLabel: book === 'cash' ? 'Cash' : 'Accrual' }), format);
      downloadBlob(file.name, file);
    } finally { setBusy(''); }
  };

  const figure = (row, c) => {
    const v = row.current?.[c.key];
    if (c.kind === 'pct') return <Figure text={pctText(v) || '-'} />;
    if (v == null) return <span style={{ color: 'var(--text-muted)' }}>-</span>;
    const amt = <Amount value={v} zero="dash" style={c.strong ? { fontWeight: 700 } : undefined} />;
    if (!canDrill(c) || Math.abs(v) < 0.005) return amt;
    return (
      <button type="button" style={cellBtn} onClick={() => setOpen({ code: row.code, key: c.key })} title={`Show the accounts behind ${c.label}`}
        aria-label={`${c.label} for ${row.name}`}>{amt}</button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <select value={period} onChange={(e) => pickPeriod(e.target.value)} style={{ ...control, ...fitSelect(PERIODS.find((p) => p.key === period)?.label, { base: widest(PERIODS.map((p) => p.label)) }) }} aria-label="Period" title="Period">
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <span style={inline}>
          <input type="date" value={from} onChange={(e) => { setPeriod('custom'); setRange([e.target.value, to]); }} style={control} aria-label="From" title="From" />
          to
          <input type="date" value={to} onChange={(e) => { setPeriod('custom'); setRange([from, e.target.value]); }} style={control} aria-label="To" title="To" />
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
        emptyContent={<div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>Nothing posted to income or expense accounts for these entities in this period.</div>}>
        {data && (
          <div className="acct-scroll-box" ref={setBox} data-testid="profitability-box" style={{ ...card, ...fit }}>
            <div style={{ padding: '10px 12px 4px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
              <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Profitability Sheet</h3>
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
                        <span style={{ fontWeight: r.depth ? 400 : 600 }}>{r.name}</span> <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{r.code}</span>
                      </td>
                      {PROFIT_COLUMNS.map((c) => <td key={c.key} style={{ ...C(c.key, td), background: open?.code === r.code && open?.key === c.key ? 'var(--wk-brand-tint, #e8ecfd)' : undefined }}>{figure(r, c)}</td>)}
                      {withPrior && (
                        <>
                          <td style={C('prior', td)}>{r.prior?.[compareOn] == null ? '-' : <Amount value={r.prior[compareOn]} zero="dash" />}</td>
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
                  {PROFIT_COLUMNS.map((c) => {
                    const v = data.totals?.current?.[c.key];
                    return <td key={c.key} style={{ ...td, fontWeight: 700 }}>{c.kind === 'pct' ? <Figure text={pctText(v) || '-'} /> : v == null ? '-' : <Amount value={v} zero="dash" />}</td>;
                  })}
                  {withPrior && (
                    <>
                      <td style={{ ...td, fontWeight: 700 }}>{data.totals.prior?.[compareOn] == null ? '-' : <Amount value={data.totals.prior[compareOn]} zero="dash" />}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{data.totals.change?.[compareOn]?.amount == null ? '-' : <Amount value={data.totals.change[compareOn].amount} zero="dash" />}</td>
                      <td style={{ ...td, fontWeight: 700 }}><Figure text={pctText(data.totals.change?.[compareOn]?.pct) || '-'} /></td>
                    </>
                  )}
                </tr>
              </tfoot>
            </table>
            <p style={{ margin: 0, padding: '8px 12px 12px', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
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
            <h3 style={{ margin: 0, fontSize: '0.9rem', flex: 1 }}>{openCol.label} - {openRow.name}</h3>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close the accounts" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 4 }}><X size={15} /></button>
          </div>
          <p style={{ margin: 0, padding: '0 12px 6px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Click an account to open its ledger lines on Reports.</p>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={{ ...th, textAlign: 'left', minWidth: 0 }}>Line</th><th style={{ ...th, textAlign: 'left', minWidth: 0 }}>Account</th><th style={{ ...th, textAlign: 'left', minWidth: 0 }}>Title</th><th style={th}>Amount</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={`${l.group}-${l.account}`}>
                  <td style={{ ...td, textAlign: 'left' }}>{l.label}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <button type="button" style={cellBtn} onClick={() => requestReportDrill({ account: l.account, accountName: l.title, from: data.from, to: data.to, entity: openRow.code, book })}>{l.account}</button>
                  </td>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>{l.title}</td>
                  <td style={td}>
                    {Math.abs(Number(l.amount) || 0) >= 0.005
                      ? <button type="button" style={cellBtn} onClick={() => setLinesOf({ account: l.account, title: l.title, entity: openRow.code, name: openRow.name })} aria-label={`Lines behind ${l.account} ${l.title}`} title="See the ledger lines behind this amount"><Amount value={l.signed} zero="dash" /></button>
                      : <Amount value={l.signed} zero="dash" />}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td style={{ ...td, textAlign: 'left', fontWeight: 700 }} colSpan={3}>{openCol.label}</td><td style={{ ...td, fontWeight: 700 }}><Amount value={openRow.current[openCol.key]} zero="dash" /></td></tr></tfoot>
          </table>
        </div>
      )}
      {linesOf && data && (
        <LinesPanel key={`${linesOf.entity}|${linesOf.account}`} label={`${linesOf.account} ${linesOf.title}, ${linesOf.name}`} title={`${linesOf.account} ${linesOf.title}`} widthsKey="profitability" onClose={closeLines}
          caption={`${linesOf.name} (${linesOf.entity}), ${periodLine(data)}, ${book === 'cash' ? 'Cash' : 'Accrual'}`}
          queries={[{ account: linesOf.account, location: linesOf.entity, from: data.from, to: data.to, book }]}
          report={{ account: linesOf.account, accountName: linesOf.title, from: data.from, to: data.to, entity: linesOf.entity, book }} />
      )}
    </div>
  );
}
