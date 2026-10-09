import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, Save } from 'lucide-react';
import { api } from '../../api';
import Amount, { Figure, parseAmountInput } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { EntityPicker, control, entityOptions } from './reportControls';
import { useAccountingPrefs } from './prefs';
import { downloadCsv, iso } from './reportModel';
import { formatDateTime } from '../../lib/datetime';
import { useNameResolver } from '../../lib/useNameResolver';
import { dialog } from '../../ui/dialog';
import { MONTHS, actualsByAccount, budgetVsActual, copyActuals, gridTotals, pctText, rowTotal } from './budgetModel';
import { intacctBudgetFile } from './budgetExport';

// Accounting > Budget (Charmi and Neil, 10/01: "add a budget - open and
// edit"). One entity, one year: every P&L account by month, editable in
// place, saved to the accounting app (contract B1/B2 through the backend).
// "Copy From Last Year's Actuals" fills the grid from the ledger's by-month
// buckets; "Copy From Intacct Budget" takes the budget as pulled from
// Intacct when there is one. Budget vs Actual (contract B3) is computed
// here from the saved budget and the same buckets - Actual, Budget,
// Variance $ and Variance %, year to date through a month.
//
// Until the accounting app ships the budgets route it answers 404, which
// the backend passes on as 501: the tab says so and nothing else breaks.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'right', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-color)', position: 'sticky', top: 0, background: 'var(--bg-card)' };
const td = { padding: '2px 4px', borderBottom: '1px solid var(--border-color)', fontVariantNumeric: 'tabular-nums' };
const cellInput = { ...control, width: 92, textAlign: 'right', padding: '3px 6px', height: 26, fontSize: '0.78rem' };
const SOURCE = { nexus: 'Saved in Nexus', intacct: 'As pulled from Intacct', none: 'Nothing saved yet - zeros' };

export default function BudgetTab({ canEdit = false }) {
  const nameOf = useNameResolver();
  const [entities, setEntities] = useState(null);
  const [location, setLocation] = useState('');
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [data, setData] = useState(null);          // what the accounting app holds
  const [rows, setRows] = useState([]);            // the grid as edited
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState({ loading: false, error: '', notReady: false });
  const [view, setView] = useState('grid');        // grid | bva
  const [through, setThrough] = useState(() => new Date().getMonth() + 1);
  const [actuals, setActuals] = useState(null);    // Map for the Budget vs Actual view
  const [busy, setBusy] = useState('');
  const seq = useRef(0);
  // Historical (H) entities follow the person's Customize choice elsewhere in the module.
  const [prefs, setPrefs] = useAccountingPrefs();
  // Export Intacct Import File (item 43): the panel, the budget ID typed
  // (remembered per viewer), and what stops the file.
  const [intacct, setIntacct] = useState(null);    // null | { problems: [] }
  const [budgetId, setBudgetId] = useState(() => prefs.intacctBudgetId || '');

  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => {
      if (!alive) return;
      const list = (d?.entities || []).filter((e) => e.code);
      setEntities(list);
      // The first entity in number order (historical ones aside), as the picker lists them.
      setLocation((cur) => cur || entityOptions(list)[0]?.code || list[0]?.code || '');
    }).catch(() => { if (alive) setEntities([]); });
    return () => { alive = false; };
  }, []);

  const load = useCallback((loc, y) => {
    if (!loc) return;
    const mine = ++seq.current;
    setState({ loading: true, error: '', notReady: false });
    api.getAccountingBudget(loc, y).then((d) => {
      if (mine !== seq.current) return;
      setData(d);
      setRows((d.rows || []).map((r) => ({ ...r, months: [...r.months] })));
      setDirty(false);
      setState({ loading: false, error: '', notReady: false });
    }).catch((e) => {
      if (mine !== seq.current) return;
      setData(null);
      setRows([]);
      setState({ loading: false, error: e?.status === 501 ? '' : (e?.message || 'Could not load the budget.'), notReady: e?.status === 501 });
    });
  }, []);
  useEffect(() => { load(location, year); }, [location, year, load]);

  // Actuals for the year (Budget vs Actual) - read once per entity and year.
  useEffect(() => {
    if (view !== 'bva' || !location) return;
    let alive = true;
    setActuals(null);
    api.getAccountingBuckets({ from: `${year}-01-01`, to: `${year}-12-31`, by: 'month', location })
      .then((d) => { if (alive) setActuals(actualsByAccount(d?.rows || [], year)); })
      .catch(() => { if (alive) setActuals(new Map()); });
    return () => { alive = false; };
  }, [view, location, year]);

  const totals = useMemo(() => gridTotals(rows), [rows]);
  const bva = useMemo(() => (actuals ? budgetVsActual(rows, actuals, through) : null), [rows, actuals, through]);
  const entityName = entities?.find((e) => e.code === location)?.name || location;

  const setCell = (i, m, text) => {
    const v = parseAmountInput(text);
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, months: r.months.map((x, mi) => (mi === m ? (v == null ? 0 : v) : x)) } : r)));
    setDirty(true);
  };

  async function save() {
    setBusy('save');
    try {
      const d = await api.saveAccountingBudget({ location, year, rows: rows.map((r) => ({ accountNo: r.accountNo, months: r.months })) });
      setData(d);
      setRows((d.rows || []).map((r) => ({ ...r, months: [...r.months] })));
      setDirty(false);
    } catch (e) { await dialog.alert(e?.message || 'Could not save the budget.', { title: 'Budget' }); }
    setBusy('');
  }

  async function copyLastYear() {
    if (dirty && !await dialog.confirm('Replace the grid with last year\'s actuals? Unsaved edits are lost.', { title: 'Copy From Last Year', confirmText: 'Replace' })) return;
    setBusy('actuals');
    try {
      const d = await api.getAccountingBuckets({ from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, by: 'month', location });
      const a = actualsByAccount(d?.rows || [], year - 1);
      if (!a.size) { await dialog.alert(`Nothing posted for ${entityName} in ${year - 1}.`, { title: 'Copy From Last Year' }); }
      else { setRows((cur) => copyActuals(cur, a)); setDirty(true); }
    } catch (e) { await dialog.alert(e?.message || 'Could not read last year\'s actuals.', { title: 'Copy From Last Year' }); }
    setBusy('');
  }

  async function copyIntacct() {
    if (dirty && !await dialog.confirm('Replace the grid with the Intacct budget? Unsaved edits are lost.', { title: 'Copy From Intacct', confirmText: 'Replace' })) return;
    setBusy('intacct');
    try {
      const d = await api.getAccountingBudget(location, year, 'intacct');
      if (d?.source !== 'intacct' || !(d.rows || []).some((r) => r.months.some((v) => v))) {
        await dialog.alert(`No Intacct budget was pulled for ${entityName} in ${year}.`, { title: 'Copy From Intacct' });
      } else {
        const byCode = new Map(d.rows.map((r) => [r.accountNo, r]));
        setRows((cur) => {
          const seen = new Set();
          const out = cur.map((r) => { seen.add(r.accountNo); const x = byCode.get(r.accountNo); return x ? { ...r, months: [...x.months] } : r; });
          d.rows.filter((r) => !seen.has(r.accountNo)).forEach((r) => out.push({ ...r, months: [...r.months] }));
          return out;
        });
        setDirty(true);
      }
    } catch (e) { await dialog.alert(e?.message || 'Could not read the Intacct budget.', { title: 'Copy From Intacct' }); }
    setBusy('');
  }

  function exportCsv() {
    const stamp = iso(new Date());
    if (view === 'bva' && bva) {
      downloadCsv(`Budget vs Actual - ${entityName} - ${year} through ${MONTHS[bva.through - 1]} - ${stamp}.csv`,
        [['Account', 'Title', 'Actual', 'Budget', 'Variance $', 'Variance %'], ...bva.rows.map((r) => [r.accountNo, r.title, r.actual, r.budget, r.variance, r.pct ?? '']), ['', 'Total', bva.totals.actual, bva.totals.budget, bva.totals.variance, bva.totals.pct ?? '']]);
      return;
    }
    downloadCsv(`Budget - ${entityName} - ${year} - ${stamp}.csv`,
      [['Account', 'Title', ...MONTHS, 'Total'], ...rows.map((r) => [r.accountNo, r.title, ...r.months, rowTotal(r.months)]), ['', 'Total', ...totals.months, totals.total]]);
  }

  function exportIntacct(e) {
    e.preventDefault();
    const file = intacctBudgetFile({ budgetId, location, year, rows, dirty });
    if (file.problems.length) { setIntacct({ problems: file.problems }); return; }
    if (budgetId.trim() !== (prefs.intacctBudgetId || '')) setPrefs({ intacctBudgetId: budgetId.trim() });
    downloadCsv(`Intacct Budget Import - ${location} - ${year} - ${budgetId.trim().replace(/[^A-Za-z0-9._-]+/g, '-')}.csv`, file.lines);
    setIntacct({ problems: [], done: `${(file.lines.length - 1).toLocaleString('en-US')} rows written. Import it in Intacct under General Ledger > Budgets.` });
  }

  if (state.notReady) {
    return (
      <div style={{ ...card, padding: 24, textAlign: 'center' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: '1rem' }}>Budget</h3>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.86rem' }}>Not available yet - the accounting app needs its update. Once it serves budgets, this tab opens the grid for {entityName || 'each entity'} by month.</p>
      </div>
    );
  }

  return (
    <AsyncSection loading={entities === null} skeleton={<SkeletonBlocks count={2} />}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <EntityPicker entities={entities || []} value={location} onChange={setLocation} showHistorical={!!prefs.showHistoricalEntities}
            placeholder={entities?.length ? 'Pick an Entity' : 'No Entities'} disabled={!entities?.length} active={false} />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button type="button" aria-label="Previous year" onClick={() => setYear((y) => y - 1)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 5, display: 'inline-flex', color: 'var(--text-muted)' }}><ChevronLeft size={16} /></button>
            <strong style={{ fontSize: '0.86rem', minWidth: 40, textAlign: 'center' }}>{year}</strong>
            <button type="button" aria-label="Next year" onClick={() => setYear((y) => y + 1)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 5, display: 'inline-flex', color: 'var(--text-muted)' }}><ChevronRight size={16} /></button>
          </div>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
            {[['grid', 'Budget'], ['bva', 'Budget vs Actual']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setView(k)} aria-pressed={view === k}
                style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: view === k ? 700 : 500, border: `1px solid ${view === k ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: view === k ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: view === k ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                {label}
              </button>
            ))}
          </div>
          {view === 'bva' && (
            <select value={through} onChange={(e) => setThrough(Number(e.target.value))} aria-label="Through month" style={control}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>Through {m}</option>)}
            </select>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {data && (
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                {SOURCE[data.source] || data.source}{data.updatedAt ? ` · ${nameOf(data.updatedBy) || ''} ${formatDateTime(data.updatedAt)}` : ''}
              </span>
            )}
            {canEdit && view === 'grid' && (
              <>
                <button type="button" className="secondary-btn" disabled={!!busy || !location} onClick={copyLastYear} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Copy size={13} /> Copy From Last Year's Actuals</button>
                <button type="button" className="secondary-btn" disabled={!!busy || !location} onClick={copyIntacct} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Copy size={13} /> Copy From Intacct Budget</button>
                <button type="button" className="primary-btn" disabled={!!busy || !dirty} onClick={save} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Save size={13} /> {busy === 'save' ? 'Saving...' : dirty ? 'Save' : 'Saved'}</button>
              </>
            )}
            <button type="button" className="secondary-btn" disabled={!rows.length} onClick={exportCsv} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> CSV</button>
            {view === 'grid' && (
              <button type="button" className="secondary-btn" disabled={!rows.length} aria-expanded={!!intacct} onClick={() => setIntacct((v) => (v ? null : { problems: [] }))}
                style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export Intacct Import File</button>
            )}
          </div>
        </div>

        {intacct && view === 'grid' && (
          <form onSubmit={exportIntacct} aria-label="Export Intacct Import File" style={{ ...card, padding: '10px 12px', display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                Intacct Budget ID
                <input type="text" value={budgetId} onChange={(e) => setBudgetId(e.target.value)} maxLength={40} placeholder="e.g. 2026 Operating" style={{ ...control, width: 200 }} />
              </label>
              <button type="submit" className="primary-btn" style={{ fontSize: '0.78rem' }}>Download File</button>
              <button type="button" className="secondary-btn" onClick={() => setIntacct(null)} style={{ fontSize: '0.78rem' }}>Close</button>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              One row per account and month for {entityName || 'the entity'} {year}: Budget ID, Account No., Location ID, Period Name (&quot;Month Ended January {year}&quot;), Amount. Months at zero are left out. The layout is provisional until it is matched to the Intacct import template.
            </div>
            {intacct.problems.length > 0 && (
              <div role="alert" style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.8rem' }}>
                <strong>Fix these first - no file was made:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{intacct.problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )}
            {intacct.done && <div role="status" style={{ fontSize: '0.8rem', color: 'var(--ok-fg, #15803d)' }}>{intacct.done}</div>}
          </form>
        )}

        {state.error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{state.error}</div>}

        <AsyncSection loading={state.loading && !data} skeleton={<SkeletonBlocks count={2} />}>
          {view === 'grid' ? (
            <div style={{ ...card, overflow: 'auto', maxHeight: '70vh' }}>
              {!rows.length ? (
                <p style={{ margin: 0, padding: 24, color: 'var(--text-secondary)', fontSize: '0.86rem', textAlign: 'center' }}>
                  {location ? `No income statement accounts came back for ${entityName}.` : 'Pick an entity to open its budget.'}
                </p>
              ) : (
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left', left: 0, zIndex: 1 }}>Account</th>
                      {MONTHS.map((m) => <th key={m} style={th}>{m}</th>)}
                      <th style={th}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.accountNo}>
                        <td style={{ ...td, whiteSpace: 'nowrap', padding: '4px 8px' }}><span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{r.accountNo}</span>{r.title}</td>
                        {r.months.map((v, m) => (
                          <td key={m} style={{ ...td, textAlign: 'right' }}>
                            {canEdit
                              ? <input type="text" inputMode="decimal" className="num" aria-label={`${r.accountNo} ${MONTHS[m]}`} defaultValue={v ? v.toFixed(2) : ''} key={`${r.accountNo}-${m}-${v}`} placeholder="0.00"
                                  onBlur={(e) => { if (e.target.value.trim() !== (v ? v.toFixed(2) : '')) setCell(i, m, e.target.value); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }} style={cellInput} />
                              : <Amount value={v} zero="dash" />}
                          </td>
                        ))}
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '4px 8px' }}><Amount value={rowTotal(r.months)} zero="dash" /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ ...td, fontWeight: 700, padding: '6px 8px' }}>Total</td>
                      {totals.months.map((v, m) => <td key={m} style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '6px 8px' }}><Amount value={v} zero="dash" /></td>)}
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '6px 8px' }}><Amount value={totals.total} zero="dash" /></td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          ) : (
            <AsyncSection loading={!bva} skeleton={<SkeletonBlocks count={2} />}>
              <div style={{ ...card, overflow: 'auto', maxHeight: '70vh' }}>
                {!bva?.rows.length ? (
                  <p style={{ margin: 0, padding: 24, color: 'var(--text-secondary)', fontSize: '0.86rem', textAlign: 'center' }}>Nothing budgeted or posted for {entityName} through {MONTHS[(bva?.through || 1) - 1]} {year}.</p>
                ) : (
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left' }}>Account</th>
                        <th style={th}>Actual</th><th style={th}>Budget</th><th style={th}>Variance $</th><th style={th}>Variance %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bva.rows.map((r) => (
                        <tr key={r.accountNo}>
                          <td style={{ ...td, padding: '4px 8px', whiteSpace: 'nowrap' }}><span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{r.accountNo}</span>{r.title}</td>
                          <td style={{ ...td, textAlign: 'right', padding: '4px 8px' }}><Amount value={r.actual} zero="dash" /></td>
                          <td style={{ ...td, textAlign: 'right', padding: '4px 8px' }}><Amount value={r.budget} zero="dash" /></td>
                          <td style={{ ...td, textAlign: 'right', padding: '4px 8px' }}><Amount value={r.variance} zero="dash" /></td>
                          <td style={{ ...td, textAlign: 'right', padding: '4px 8px' }}><Figure text={pctText(r.pct)} /></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={{ ...td, fontWeight: 700, padding: '6px 8px' }}>Total</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '6px 8px' }}><Amount value={bva.totals.actual} zero="dash" /></td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '6px 8px' }}><Amount value={bva.totals.budget} zero="dash" /></td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '6px 8px' }}><Amount value={bva.totals.variance} zero="dash" /></td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, padding: '6px 8px' }}><Figure text={pctText(bva.totals.pct)} /></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </AsyncSection>
          )}
        </AsyncSection>
      </div>
    </AsyncSection>
  );
}
