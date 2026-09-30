import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderUp, Loader2, Mail, Maximize2, Minimize2, Search, Share2, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { useNameResolver } from '../../lib/useNameResolver';
import LedgerSearch from './LedgerSearch';
import SavedReportsManager from './SavedReportsManager';
import SendReportDialog from './SendReportDialog';
import { takePendingDrill } from './drill';
import { useAccountingPrefs } from './prefs';
import {
  AccountsPicker, ClearButton, CustomizeButton, EntitiesPicker, ExportMenu, FiltersButton, MemorizeButton, PeriodStepper,
  SavedReportsMenu, control, densityOf, densityVars,
} from './reportControls';
import Amount from './Amount';
import {
  BOOKS, REPORTS, activeColumns, bookLabel, canPickAccounts, canPickBook, canUseDims, cellText, columnModes, csvFileName, csvRows,
  defaultConfig, downloadBlob, downloadCsv, entityText, filterChips, iso, periodText, presetLabel, reportDef, resolveConfig, runReport,
} from './reportModel';

// Accounting -> Reports. Pull any statement for any entity straight from the
// ledger without opening Nexus Accounting: Income Statement, Balance Sheet,
// Trial Balance, Cash Position. Read-only, served by the accounting app's
// internal API through the backend proxy (the Accounting grant is the gate,
// and a person limited to certain entities only ever reads those).
//
// Sep 25 (Neil, Charmi): the screen works like the accounting app's Reports
// page and like Intacct. ONE slim row of dropdowns - report, period,
// comparison, book (accrual, cash, or both side by side), entities
// (searchable, several at once), every other dimension behind "Dimensions",
// the memorized reports - so the statement starts high on the page. Nothing
// to refresh by hand: the report follows the controls. "Memorize" keeps the
// view under a name.
//
// Sep 29 (Visesh, from the same call: "the reports are better there"): the
// row now carries every filter the accounting app's Reports page has - the
// period stepper with its arrows, Columns (Total Only, By Month, By Quarter,
// By Entity, By Vendor ... vs Prior Year), departments and accounts as their
// own dropdowns, Customize, full screen - and the figures line above the
// statement (Revenue, Expenses, Net Income, Net Margin).
//
// The search box is the global search (Neil, Sep 17): type a vendor, a
// customer, an invoice number or an amount and every posted line containing
// it replaces the report. Every account amount on a report is a drill-down
// into the same view - the lines behind that number, for that column's
// period, book and entity. Since 09/30 the other Accounting tabs carry the
// same box (`search` prop): typing there lands here with the words typed.
//
// Sep 30 (Charmi and Neil, call of 09/29): Entities, Accounts, then Filters
// (departments inside); the Columns dropdown is labeled; the filters in
// force sit under the title as chips that come off in one click; zero
// balances are hidden unless Customize shows them; one Export menu.
//
// Typography brief (09/29): the report title in Libre Caslon, the metadata
// line as a tracked label, the figures line as KPI cards, every number
// through <Amount /> (tabular Inter, zero as a dash, a reserved ) slot),
// color only in variance columns, a display scale (exact / whole dollars /
// thousands) that never touches exports, the final total pinned to the
// bottom and the Total column pinned to the right, copied cells as raw
// numbers, and j / k / Enter / Esc / "/" on the keyboard.

// What a memorized report keeps: the controls, never the figures. A named
// period is kept by name so it moves with the calendar.
const storable = (c) => ({
  report: c.report, preset: c.preset, ...(c.preset === 'custom' ? { from: c.from, to: c.to } : {}),
  ...(c.asofToday === false ? { asof: c.asof, asofToday: false } : {}),
  book: c.book, cols: c.cols, entities: c.entities, dims: c.dims,
  ...(c.accounts?.length ? { accounts: c.accounts } : {}), ...(c.showZero ? { showZero: true } : {}),
});
const sameView = (a, b) => JSON.stringify(storable(a)) === JSON.stringify(storable(b));

export default function ReportsTab({ search = null }) {
  const [config, setConfig] = useState(() => defaultConfig());
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [prefs, setPrefs] = useAccountingPrefs();
  const nameOf = useNameResolver();
  const density = densityOf(prefs.density);
  const scale = prefs.scale || 'exact';
  // Full screen: the toolbar and the statement take the whole window.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => {
      // Escape closes whatever is open on top first (a dropdown, an entry).
      if (e.key === 'Escape' && !document.querySelector('.modal-overlay, [role="listbox"], [role="dialog"], [role="menu"]')) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);
  const colW = Number(prefs.accountWidth) || 0;   // 0 = size to content
  const patch = useCallback((p) => setConfig((c) => resolveConfig({ ...c, ...p })), []);
  const toggleSection = (key) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // Global search + drill-down. `searchText` is what is typed; `term` follows it
  // after a pause so the ledger is not queried on every keystroke.
  const [searchText, setSearchText] = useState(() => search?.text || '');
  const [term, setTerm] = useState('');
  // Words typed in another tab's search box arrive here ({ text, nonce }).
  useEffect(() => { if (search?.text) setSearchText(search.text); }, [search?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // Names behind the codes picked in Filters, for the chips under the title.
  const [dimNames, setDimNames] = useState({});
  const onNames = useCallback((kind, names) => setDimNames((m) => ({ ...m, [kind]: { ...(m[kind] || {}), ...names } })), []);
  const [drill, setDrill] = useState(null);   // { account, accountName, from, to, book, entity?, department?, party? }
  const [searchBusy, setSearchBusy] = useState(false);
  useEffect(() => {
    // Every search that starts runs to its end on the ledger, even when the
    // next keystroke has already replaced it. Two or three characters match a
    // large part of the ledger ("in" is on 619,000 lines), so a short word
    // waits longer for the rest of it to be typed (Sep 29).
    const typed = searchText.trim();
    const t = setTimeout(() => setTerm(typed), typed.length < 4 ? 700 : 350);
    return () => clearTimeout(t);
  }, [searchText]);
  const searching = term.length >= 2 || !!drill;
  // From the first keystroke until the lines are on screen (Charmi, Sep 25:
  // with nothing moving, nobody could tell whether to press Enter).
  const waiting = (searchText.trim().length >= 2 && searchText.trim() !== term) || (searching && searchBusy);
  const closeSearch = () => { setSearchText(''); setTerm(''); setDrill(null); };
  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  // A drill-down asked for from another tab (see drill.js) lands here.
  useEffect(() => {
    const take = (d) => {
      if (!d || !d.account) return;
      if (d.entity !== undefined) patch({ entities: d.entity ? [d.entity] : [] });
      setDrill({ account: d.account, accountName: d.accountName || '', from: d.from || '', to: d.to || iso(new Date()), book: d.book || 'accrual' });
      toTop();
    };
    take(takePendingDrill());
    const onEvent = (e) => { takePendingDrill(); take(e.detail); };
    window.addEventListener('nexus:accounting-drill', onEvent);
    return () => window.removeEventListener('nexus:accounting-drill', onEvent);
  }, [patch]);
  // The lines behind one amount: the account, in that column's window and book.
  const drillInto = (row, column) => {
    if (!row.code || !column.drill) return;
    setDrill({ account: row.code, accountName: row.title || '', ...column.drill });
    toTop();
  };

  useEffect(() => {
    api.getAccountingLocations().then((d) => { setEntities(d?.entities || []); setLimited(!!d?.limited); }).catch(() => setEntities([]));
  }, []);

  // Run on every control change so the tab always shows what the controls say.
  const seq = useRef(0);
  const key = JSON.stringify(storable(config)) + config.from + config.to + config.asof;
  const started = useRef(false);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    const run = () => runReport(api, config, entities)
      .then((r) => { if (mine === seq.current) setResult(r); })
      .catch((e) => { if (mine === seq.current) { setResult(null); setError(e?.message || 'Could not load the report.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
    // The first report loads at once. After that a change waits a moment:
    // two controls changed one after the other are one report, not two heavy
    // reads of the ledger side by side.
    if (!started.current) { started.current = true; run(); return undefined; }
    const t = setTimeout(run, 250);
    return () => clearTimeout(t);
  }, [key, entities.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Memorized reports.
  const [saved, setSaved] = useState([]);
  const [savedState, setSavedState] = useState({ loading: true, error: '' });
  const loadSaved = useCallback(() => api.getAccountingSavedReports()
    .then((list) => { setSaved(list || []); setSavedState({ loading: false, error: '' }); })
    .catch((e) => setSavedState({ loading: false, error: e?.message || 'Could not load the saved reports.' })), []);
  useEffect(() => { loadSaved(); }, [loadSaved]);
  const activeSaved = useMemo(() => saved.find((r) => sameView(resolveConfig(r.config), config)), [saved, config]);
  const memorize = (name, shared) => api.saveAccountingReport({ name, config: storable(config), shared }).then(loadSaved);
  // The memorized report on screen, as it was opened. Once the controls
  // differ from it, a bar offers to keep the changes (Charmi, 09/29 call:
  // "do you want to save your changes?").
  const [opened, setOpened] = useState(null);   // { id, name, mine, config }
  const openSaved = (r) => { closeSearch(); setCollapsed(new Set()); const c = resolveConfig(r.config); setConfig(c); setOpened({ id: r.id, name: r.name, mine: r.mine, config: c }); };
  const changed = !!opened && saved.some((r) => r.id === opened.id) && !sameView(opened.config, config);
  const [saveAs, setSaveAs] = useState(null);   // '' | text - the Save as New name being typed
  const [savingChange, setSavingChange] = useState(false);
  const keepChanges = () => {
    if (savingChange) return;
    setSavingChange(true);
    api.updateAccountingSavedReport(opened.id, { config: storable(config) })
      .then(() => { setOpened((o) => ({ ...o, config })); return loadSaved(); })
      .catch((e) => setSavedState((s) => ({ ...s, error: e?.message || 'Could not save the changes.' })))
      .finally(() => setSavingChange(false));
  };
  const saveAsNew = (e) => {
    e.preventDefault();
    const name = (saveAs || '').trim();
    if (!name || savingChange) return;
    setSavingChange(true);
    memorize(name, false)
      .then(() => { setOpened(null); setSaveAs(null); })
      .catch((err) => setSavedState((s) => ({ ...s, error: err?.message || 'Could not save the report.' })))
      .finally(() => setSavingChange(false));
  };
  const [managing, setManaging] = useState(false);
  // Export -> Email / Save to Egnyte / Share (Charmi, 09/29 call).
  const [sending, setSending] = useState(null);   // 'email' | 'egnyte' | 'share'
  const [sent, setSent] = useState(null);         // { text, url? }
  const deleteSaved = (r) => api.deleteAccountingSavedReport(r.id).then(loadSaved).catch((e) => { setSavedState({ loading: false, error: e?.message || 'Could not delete the report.' }); throw e; });
  const shareSaved = (r, shared) => api.updateAccountingSavedReport(r.id, { shared }).then(loadSaved).catch((e) => { setSavedState({ loading: false, error: e?.message || 'Could not change sharing.' }); throw e; });
  const renameSaved = (r, name) => api.updateAccountingSavedReport(r.id, { name }).then(loadSaved);

  // The statement on screen as a PDF, laid out like a page of a package.
  const [pdfBusy, setPdfBusy] = useState(false);
  const exportPdf = async (r) => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      // pdf-lib is large; it loads only when a PDF is asked for.
      const { buildPackagePdf } = await import('./reportPdf');
      const title = activeSaved?.name || r.def.label;
      const bytes = await buildPackagePdf({ name: title, statements: [{ title: r.def.label, result: r, entities }], cover: false });
      downloadBlob(csvFileName(r).replace(/\.csv$/, '.pdf'), new Blob([bytes], { type: 'application/pdf' }));
    } catch (e) {
      setError(e?.message || 'Could not build the PDF.');
    } finally {
      setPdfBusy(false);
    }
  };

  // The statement as a workbook: bold totals, fitted columns, live SUM
  // formulas (Neil, 09/29 call: "critical"). The writer loads on demand.
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const exportExcel = async (r) => {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const { buildStatementWorkbook } = await import('./reportExcel');
      const bytes = await buildStatementWorkbook({ title: activeSaved?.name || r.def.label, result: r, entities });
      downloadBlob(csvFileName(r).replace(/\.csv$/, '.xlsx'), new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) {
      setError(e?.message || 'Could not build the workbook.');
    } finally {
      setXlsxBusy(false);
    }
  };

  const def = reportDef(config.report);
  const cols = activeColumns(config);
  const modes = columnModes(config.report);
  // Copying cells puts raw numbers on the clipboard (the brief): "(3,418.07)"
  // pastes into Excel as -3418.07, a dash as 0, so formulas work.
  const copyRaw = (e) => {
    const text = String(window.getSelection?.() || '');
    if (!text.trim()) return;
    const raw = text.replace(/\((\d[\d,]*\.?\d*)\)/g, '-$1').replace(/(?<=^|[\s\t])[\u2013-](?=[\s\t]|$)/g, '0').replace(/(\d),(?=\d{3})/g, '$1');
    e.clipboardData.setData('text/plain', raw);
    e.preventDefault();
  };
  // Keyboard: j / k move down and up the statement, Enter opens the lines
  // behind the focused row, Esc leaves the search, "/" goes to the search box.
  const [focusRow, setFocusRow] = useState(-1);
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); document.querySelector('input[aria-label="Search the ledger"]')?.focus(); return; }
      const r = shownRef.current;
      if (!r || searching) return;
      const rows = r.rows;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setFocusRow((f) => { let n = f; for (let step = 0; step < rows.length; step += 1) { n = e.key === 'j' ? Math.min(rows.length - 1, n + 1) : Math.max(0, n - 1); if (rows[n]?.kind === 'account' || rows[n]?.kind === 'section' || rows[n]?.kind === 'line') break; } return n; });
      } else if (e.key === 'Enter') {
        const row = rows[focusRowRef.current];
        const col = r.columns.find((c) => c.drill);
        if (row?.kind === 'account' && row.code && col) { e.preventDefault(); drillInto(row, col); }
        else if (row?.kind === 'section') { e.preventDefault(); toggleSection(row.section); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searching]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownRef = useRef(null);
  const focusRowRef = useRef(-1);
  focusRowRef.current = focusRow;
  useEffect(() => { setFocusRow(-1); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const showColumns = modes.length > 1 && config.book !== 'both';
  const chips = filterChips(config, entities, dimNames);
  const entityLabel = entityText(config, entities);
  // A column of one entity drills into that entity, whatever the report covers.
  const drillEntities = drill?.entity ? [drill.entity] : config.entities;
  const drillEntityLabel = drill?.entity ? entityText({ entities: [drill.entity] }, entities) : entityLabel;
  const sections = (result?.rows || []).filter((r) => r.kind === 'section');
  const shown = result && result.config.report === config.report ? result : null;
  shownRef.current = shown;
  // Many months or entities across: the Total column stays in view.
  const pinTotal = !!shown && shown.columns.length > 6 && shown.columns.some((c) => c.emphasis);

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
  const select = (active) => ({ ...control, fontWeight: active ? 600 : 400, color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)', maxWidth: 300 });

  // minmax(0,1fr): an unsized grid track grows to its widest content, which
  // pushed the controls past a phone's edge (QA, Sep 23).
  const shell = full
    ? { position: 'fixed', inset: 0, zIndex: 400, overflow: 'auto', padding: 12, background: 'var(--bg-primary)', display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10, alignContent: 'start' }
    : { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 };

  return (
    <div style={shell}>
      {/* One slim row: search, then every control as a dropdown. */}
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0, maxWidth: 460 }}>
          {waiting
            ? <Loader2 size={14} className="spin" aria-label="Searching" style={{ position: 'absolute', left: 9, top: 8, color: 'var(--wk-brand, #2b45e1)' }} />
            : <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />}
          <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search the ledger"
            placeholder="Search vendor, customer, invoice, amount, memo..."
            style={{ ...control, width: '100%', paddingLeft: 28, paddingRight: 26 }} />
          {searchText && <ClearButton onClick={() => setSearchText('')} label="Clear search" />}
        </div>

        <select value={config.report} onChange={(e) => { closeSearch(); setCollapsed(new Set()); patch({ report: e.target.value, accounts: [] }); }} aria-label="Report" style={{ ...select(false), fontWeight: 600 }}>
          {REPORTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>

        <PeriodStepper config={config} period={def.period} onChange={patch} />

        {showColumns && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Columns
            <select value={cols} onChange={(e) => { setCollapsed(new Set()); patch({ cols: e.target.value }); }} aria-label="Columns" style={select(cols !== 'total')}>
              {modes.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
        )}

        {canPickBook(config) && (
          <select value={config.book} onChange={(e) => patch({ book: e.target.value })} aria-label="Book" style={select(config.book !== 'accrual')}>
            {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        )}

        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        {canPickAccounts(config) && <AccountsPicker accounts={shown?.pickable || []} value={config.accounts} onChange={(accounts) => patch({ accounts })} />}
        {canUseDims(config) && <FiltersButton dims={config.dims} onChange={(dims) => patch({ dims })} onNames={onNames} />}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SavedReportsMenu reports={saved} loading={savedState.loading} error={savedState.error} activeId={activeSaved?.id}
            onOpen={openSaved} onDelete={deleteSaved} onShare={shareSaved} onManage={() => setManaging(true)} nameOf={nameOf} />
          <MemorizeButton onSave={memorize} suggestion={activeSaved?.mine ? activeSaved.name : `${def.label} - ${entityLabel} - ${def.period === 'asof' ? 'As of Date' : presetLabel(config.preset)}`} />
          <CustomizeButton density={density} onDensity={(d) => setPrefs({ density: d })} showZero={config.showZero} onShowZero={(v) => patch({ showZero: v })}
            showHistorical={!!prefs.showHistoricalEntities} onShowHistorical={(v) => setPrefs({ showHistoricalEntities: v })}
            scale={scale} onScale={(v) => setPrefs({ scale: v })} />
          <ExportMenu disabled={!shown || searching} items={[
            { key: 'excel', label: 'Excel', hint: 'Totals in bold, columns fitted, live formulas', onPick: () => shown && exportExcel(shown), busy: xlsxBusy },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => shown && downloadCsv(csvFileName(shown), csvRows(shown, entities)) },
            { key: 'pdf', label: 'PDF', hint: 'Laid out like a page of a package', onPick: () => shown && exportPdf(shown), busy: pdfBusy },
            { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, statement attached', Icon: Mail, onPick: () => setSending('email') },
            { key: 'egnyte', group: 'send', label: 'Save to Egnyte...', hint: 'Into a folder you name', Icon: FolderUp, onPick: () => setSending('egnyte') },
            { key: 'share', group: 'send', label: 'Share With a Teammate...', hint: 'Memorized for the team, with a bell notice', Icon: Share2, onPick: () => setSending('share') },
          ]} />
          <button type="button" onClick={() => setFull((v) => !v)} aria-pressed={full} aria-label={full ? 'Back to window size' : 'Fill the screen'} title={full ? 'Back to window size' : 'Fill the screen'}
            style={{ ...control, width: 30, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {changed && !searching && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderColor: 'var(--wk-brand, #2b45e1)', fontSize: '0.82rem' }}>
          <span style={{ flex: '1 1 260px' }}>
            <strong>{opened.name}</strong> has changed. Do you want to save your changes?
          </span>
          {saveAs === null ? (
            <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
              {opened.mine && <button type="button" className="primary-btn" onClick={keepChanges} disabled={savingChange} style={{ fontSize: '0.76rem', padding: '4px 12px' }}>{savingChange ? 'Saving...' : 'Save Changes'}</button>}
              <button type="button" className="secondary-btn" onClick={() => setSaveAs(`${opened.name} (copy)`)} style={{ fontSize: '0.76rem', padding: '4px 12px' }}>Save as New</button>
              <button type="button" className="secondary-btn" onClick={() => { setConfig(opened.config); setCollapsed(new Set()); }} style={{ fontSize: '0.76rem', padding: '4px 12px' }}>Discard</button>
              <button type="button" onClick={() => setOpened(null)} aria-label="Keep working without saving" title="Keep working without saving" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 4 }}><X size={14} /></button>
            </span>
          ) : (
            <form onSubmit={saveAsNew} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="text" value={saveAs} onChange={(e) => setSaveAs(e.target.value)} aria-label="Name for the new report" autoFocus maxLength={120} style={{ ...control, width: 280 }} />
              <button type="submit" className="primary-btn" disabled={!saveAs.trim() || savingChange} style={{ fontSize: '0.76rem', padding: '4px 12px' }}>Save</button>
              <button type="button" className="secondary-btn" onClick={() => setSaveAs(null)} style={{ fontSize: '0.76rem', padding: '4px 12px' }}>Cancel</button>
            </form>
          )}
        </div>
      )}

      {sent && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{sent.text}{sent.url && <> <a href={sent.url} target="_blank" rel="noreferrer">Open in Egnyte</a></>}</span>
          <button type="button" onClick={() => setSent(null)} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}><X size={14} /></button>
        </div>
      )}
      {sending && shown && (
        <SendReportDialog mode={sending} result={shown} entities={entities} title={activeSaved?.name || def.label} config={storable(config)}
          onClose={() => setSending(null)} onDone={(text, url) => { setSending(null); setSent({ text, url }); }} />
      )}

      {managing && (
        <SavedReportsManager reports={saved} activeId={activeSaved?.id} nameOf={nameOf} onClose={() => setManaging(false)}
          onOpen={openSaved} onRename={renameSaved} onShare={shareSaved} onDelete={deleteSaved} />
      )}

      {searching && (
        <LedgerSearch term={term.length >= 2 ? term : ''} entities={drillEntities} entityName={drillEntityLabel}
          dims={canUseDims(config) ? config.dims : null} drill={drill} onClearDrill={() => setDrill(null)} onClose={closeSearch} onBusy={setSearchBusy} />
      )}

      {!searching && error && <div style={{ ...card, padding: 14, borderColor: 'var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', fontSize: '0.88rem' }}>{error}</div>}
      {!searching && loading && !shown && <SkeletonBlocks count={4} />}

      {!searching && shown && (
        <div style={{ ...card, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
              <h3 className="acct-heading" style={{ margin: 0 }}>{def.label}</h3>
              <span className="acct-caps">
                {[shown.org, entityLabel, periodText(config), shown.mode === 'compare' ? `vs ${shown.otherLabel}` : '', cols !== 'total' && shown.mode !== 'compare' ? modes.find((m) => m.key === cols)?.label : '', canPickBook(config) ? bookLabel(config.book) : '', shown.generatedAt ? `As of ${formatDateTime(shown.generatedAt)}` : ''].filter(Boolean).join(' · ')}
                {loading ? ' · updating' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {sections.length > 0 && (
                <button type="button" className="secondary-btn" style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                  onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(sections.map((x) => x.section)))}>
                  {collapsed.size ? 'Expand All' : 'Collapse All'}
                </button>
              )}
            </div>
          </div>

          {chips.length > 0 && (
            <div aria-label="Active filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '0 2px 8px' }}>
              {chips.map((c) => (
                <span key={c.key} style={CHIP}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                  <button type="button" onClick={() => patch(c.patch)} aria-label={`Remove ${c.label}`} title="Remove this filter"
                    style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }}><X size={12} /></button>
                </span>
              ))}
              {chips.length > 1 && (
                <button type="button" onClick={() => patch({ entities: [], dims: { departments: [], vendor: [], customer: [], employee: [], project: [], item: [] }, accounts: [] })}
                  style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.74rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                  Clear all filters
                </button>
              )}
            </div>
          )}

          {shown.summary.length > 0 && (
            <div aria-label="Summary" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 2px 10px' }}>
              {shown.summary.map((f, i) => (
                <div key={f.label} className={`acct-kpi${i === 0 ? '' : f.label === 'Net Income' || f.label === 'Net Worth' ? '' : ' is-muted'}`} title={f.value}>
                  <span className="acct-caps">{f.label}</span>
                  <span className="kpi-value">{f.value}</span>
                </div>
              ))}
            </div>
          )}

          <div className="acct-report-wrap" style={{ opacity: loading ? 0.6 : 1, ...(full ? { maxHeight: 'calc(100vh - 190px)' } : {}) }} onCopy={copyRaw}>
            <table className="acct-report" style={densityVars(density)}>
              <colgroup><col style={colW ? { width: colW, minWidth: colW } : undefined} /></colgroup>
              <thead>
                <tr>
                  <ResizableHead width={colW} onResize={(w) => setPrefs({ accountWidth: w })}>{shown.glLabel || 'Account'}</ResizableHead>
                  {shown.columns.map((c) => <th key={c.key} className={`${c.type === 'date' || c.type === 'text' ? '' : 'acct-num'}${c.emphasis && pinTotal ? ' acct-pin' : ''}`} style={c.emphasis ? EMPHASIS : undefined}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.rows.map((r, i) => {
                  if (r.kind !== 'section' && r.section && collapsed.has(r.section)) return null;
                  const open = r.kind === 'section' && !collapsed.has(r.section);
                  return <StatementRow key={`${r.kind}-${r.section || ''}-${r.code || r.label}-${i}`} row={r} columns={shown.columns} open={open} colW={colW} scale={scale} pinTotal={pinTotal}
                    focused={focusRow === i} onToggle={() => toggleSection(r.section)} onDrill={drillInto} />;
                })}
              </tbody>
            </table>
          </div>
          {(shown.notes || []).map((n) => <div key={n} style={{ marginTop: 6, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{n}</div>)}
          <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            Generated {formatDate(shown.generatedAt)} from the Nexus Accounting ledger. Click any underlined amount for the lines behind it; click a section to fold it; drag the edge of the Account heading to change its width (double-click resets).
          </div>
        </div>
      )}
    </div>
  );
}

// The Total column beside a run of period or entity columns.
const EMPHASIS = { fontWeight: 600, borderLeft: '2px solid var(--border-color)' };
// A filter in force, under the report title; its X takes it off.
const CHIP = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: '0.75rem', maxWidth: 320, border: '1px solid var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 };

// Color is a secondary cue in the VARIANCE columns only (favorable green,
// unfavorable red); base figures stay neutral and negatives read by their
// parentheses (the brief: red is never the only signal).
const tint = (v) => (v < 0 ? 'var(--bad-fg, #dc2626)' : v > 0 ? 'var(--ok-fg, #15803d)' : undefined);

// One line of a statement: a fold-able section heading with its total, an
// account (code and name on one line, every amount a drill-down), or a total.
function StatementRow({ row, columns, open, colW, scale, pinTotal, focused, onToggle, onDrill }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const variance = columns.findIndex((c) => c.type === 'variance');
  const cells = columns.map((c, i) => {
    const v = row.values[i];
    const pin = c.emphasis && pinTotal ? ' acct-pin' : '';
    if (c.type === 'date') return <td key={c.key} style={{ color: 'var(--text-secondary)' }}>{v || (row.kind === 'account' ? '-' : '')}</td>;
    if (c.type === 'text') return <td key={c.key} title={v || undefined} style={{ maxWidth: c.key === 'description' ? 460 : 220, overflow: 'hidden', textOverflow: 'ellipsis', color: row.kind === 'line' ? undefined : 'var(--text-secondary)' }}>{v || ''}</td>;
    if (c.type === 'pct') return <td key={c.key} className="acct-num" style={{ color: tint(row.values[variance]) }}>{v || '\u2013'}</td>;
    if (row.kind === 'margin') return <td key={c.key} className={`acct-num${pin}`} style={c.emphasis ? EMPHASIS : undefined}>{cellText(row, c, v) || '\u2013'}</td>;
    if (c.type === 'variance') return <td key={c.key} className="acct-num" style={{ color: tint(v) }}>{Math.abs(v) < 0.005 ? '\u2013' : <Amount value={v} scale={scale} />}</td>;
    const figure = <Amount value={v} zero="dash" scale={scale} />;
    return (
      <td key={c.key} className={`acct-num${pin}`} style={c.emphasis ? EMPHASIS : c.key === 'other' && columns.length > 2 ? { color: 'var(--text-secondary)' } : undefined}>
        {row.kind === 'account' && row.code && c.drill
          ? <button type="button" className="acct-drill" title="See the lines behind this amount" onClick={() => onDrill(row, c)}>{figure}</button>
          : figure}
      </td>
    );
  });
  if (row.kind === 'section') {
    return (
      <tr className={`acct-section${focused ? ' acct-focus' : ''}`} onClick={onToggle} title={open ? 'Click to fold this section' : 'Click to open this section'}>
        <td className="acct-caps">
          <button type="button" className="acct-fold" aria-expanded={open} aria-label={`${open ? 'Fold' : 'Open'} ${row.label}`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <Chevron size={13} />
          </button>
          {row.label}{!open ? <span className="acct-count">{row.count}</span> : null}
        </td>
        {cells}
      </tr>
    );
  }
  if (row.kind === 'line') {
    return (
      <tr className={focused ? 'acct-focus' : undefined}>
        <td className="acct-label acct-indent" style={{ color: 'var(--text-secondary)' }}>{row.label}</td>
        {cells}
      </tr>
    );
  }
  if (row.kind === 'account') {
    return (
      <tr className={focused ? 'acct-focus' : undefined}>
        <td className={`acct-label${row.section ? ' acct-indent' : ''}`} style={colW ? { maxWidth: colW } : undefined} title={`${row.code ? `${row.code} ` : ''}${row.title}`}>
          {row.code ? <span className="acct-code">{row.code}</span> : null}
          <span>{row.title}</span>
        </td>
        {cells}
      </tr>
    );
  }
  return (
    <tr className={row.kind === 'grand' ? 'acct-grand' : row.kind === 'subtotal' || row.kind === 'margin' ? 'acct-subtotal' : undefined} style={row.kind === 'warn' ? { color: 'var(--bad-fg, #dc2626)' } : undefined}>
      <td className="acct-caps">{row.label}</td>
      {cells}
    </tr>
  );
}

// The Account heading with a drag handle on its right edge: drag to set the
// column width, double-click to go back to "as wide as the longest name".
function ResizableHead({ width, onResize, children }) {
  const ref = useRef(null);
  const onPointerDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = ref.current ? ref.current.getBoundingClientRect().width : width || 240;
    const move = (ev) => onResize(Math.max(140, Math.round(startW + ev.clientX - startX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <th ref={ref} className="acct-label acct-head" style={width ? { width, minWidth: width, maxWidth: width } : undefined}>
      {children}
      <span role="separator" aria-orientation="vertical" aria-label="Resize the Account column" title="Drag to resize · double-click to fit"
        onPointerDown={onPointerDown} onDoubleClick={() => onResize(0)} className="acct-resize" />
    </th>
  );
}
