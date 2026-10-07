import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderUp, Loader2, Mail, Maximize2, Minimize2, Pencil, Search, Share2, ChevronDown, ChevronRight, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useNameResolver } from '../../lib/useNameResolver';
import LedgerSearch from './LedgerSearch';
import EntryDetail from './EntryDetail';
import SavedReportsManager from './SavedReportsManager';
import SendReportDialog from './SendReportDialog';
import { linesFile } from './linesExport';
import { takePendingDrill } from './drill';
import { useAccountingPrefs } from './prefs';
import { useColumnWidths, useCustomizePrefs } from './tableHooks';
import Amount, { Figure } from './Amount';
import {
  AccountsPicker, ClearButton, ColumnResizer, CustomizeButton, DENSITIES, EntitiesPicker, ExportMenu, FiltersButton, MemorizeButton, Pager, PeriodStepper,
  SavedReportsMenu, control,
} from './reportControls';
import {
  EMPTY_DIMS, NUM_OPS, POPOVER_DIMS, REPORTS, activeColumns, bookLabel, bookOptions, canPickAccounts, canPickBook, canUseDims, cellText, columnModes, columnsForPicks, csvFileName, csvRows,
  defaultConfig, downloadBlob, downloadCsv, entityText, filterChips, hideInactive, iso, numberFilterHit, periodText, presetLabel, reportDef, reportPages, resolveConfig, runReport, setUserBooks, withFluxNotes,
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
// Oct 6 (Neil: "search bar should always be on the top right in the entire
// accounting module"): the Accounting header's box at the top right is THE
// search on every tab, this one included - it drives `searchText` through
// `onSearchText`, and `onWaiting` lights its spinner. Reports draws its own
// box only when used on its own (no `onSearchText`) or filling the screen,
// where the header is out of sight.
//
// Sep 30 (Charmi and Neil, call of 09/29): Entities, Filters (departments
// inside), then Accounts last (Charmi, 10/02: "keep accounts as the last
// tab"); the Columns dropdown is labeled; the filters in force sit under the
// title as chips that come off in one click; zero balances are hidden unless
// Customize shows them; one Export menu.
//
// Figures (Charmi, 09/30): every number goes through <Amount /> - tabular
// Inter, two decimals, a negative in parentheses that stand outside the
// digit column (the reserved ) slot), a zero as a dash on the statement -
// and copying cells puts raw numbers on the clipboard.
//
// Oct 2 (Charmi, Neil): two or more picks in a filter become one column per
// pick plus a Total (Columns reads "By Employee (2 picked)"); EVERY figure -
// section totals, subtotals, Net Income, a trial balance or ledger balance,
// a bucket column - opens the lines behind it; Filters gets Journals;
// Customize gets historical accounts; the drill-down scrolls with the page;
// and Flux Analysis is a report of its own, with an Explanation per account
// kept in Nexus.

// What a memorized report keeps: the controls, never the figures. A named
// period is kept by name so it moves with the calendar.
const storable = (c) => ({
  report: c.report, preset: c.preset, ...(c.preset === 'custom' ? { from: c.from, to: c.to } : {}),
  ...(c.asofToday === false ? { asof: c.asof, asofToday: false } : {}),
  book: c.book, cols: c.cols, entities: c.entities, dims: c.dims,
  ...(c.accounts?.length ? { accounts: c.accounts } : {}), ...(c.showZero ? { showZero: true } : {}),
  ...(c.report === 'flux' ? { fluxPct: c.fluxPct, fluxAmount: c.fluxAmount } : {}),
});
const sameView = (a, b) => JSON.stringify(storable(a)) === JSON.stringify(storable(b));

export default function ReportsTab({ search = null, searchText: outerText = '', onSearchText = null, onWaiting = null }) {
  const [config, setConfig] = useState(() => defaultConfig());
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [prefs, setPrefs] = useAccountingPrefs();
  const nameOf = useNameResolver();
  const density = DENSITIES.some((d) => d.key === prefs.density) ? prefs.density : 'compact';
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
  // Oct 7 (items 21 / 32 / 34): Rows per Page and Show Inactive Accounts in
  // Customize; every column drags wider or narrower, saved per report.
  const custom = useCustomizePrefs(['pageSize', 'inactiveAccounts']);
  const widths = useColumnWidths(`report:${config.report}`, Number(prefs.accountWidth) ? { __label: Number(prefs.accountWidth) } : {}, { min: 60 });
  const patch = useCallback((p) => setConfig((c) => resolveConfig({ ...c, ...p })), []);
  const toggleSection = (key) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // A journal entry opened from its number on a General Ledger line (item 33).
  const [entry, setEntry] = useState(null);   // { id, no }

  // Books the accounting app lists (item 35: Fair Market, KJE ...), and
  // whether it lists its journals - the Journals filter hides until it does.
  const [books, setBooks] = useState(() => bookOptions());
  const [journalsOn, setJournalsOn] = useState(true);
  useEffect(() => {
    let alive = true;
    api.getAccountingBooks?.()
      .then((d) => { if (alive && d?.available) { setUserBooks(d.books); setBooks(bookOptions()); } })
      .catch(() => { /* Accrual / Cash / both, as before */ });
    api.getAccountingJournals?.()
      .then((d) => { if (alive) setJournalsOn(d?.available !== false); })
      .catch(() => { if (alive) setJournalsOn(false); });
    return () => { alive = false; };
  }, []);
  const filterKinds = useMemo(() => (journalsOn ? POPOVER_DIMS : POPOVER_DIMS.filter((k) => k.key !== 'journals')), [journalsOn]);

  // Global search + drill-down. `searchText` is what is typed; `term` follows it
  // after a pause so the ledger is not queried on every keystroke.
  const [ownText, setOwnText] = useState(() => search?.text || '');
  const headerSearch = typeof onSearchText === 'function';
  const searchText = headerSearch ? (outerText || '') : ownText;
  const setSearchText = headerSearch ? onSearchText : setOwnText;
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
  useEffect(() => { onWaiting?.(waiting); }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeSearch = () => { setSearchText(''); setTerm(''); setDrill(null); };
  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  // A drill-down asked for from another tab (see drill.js) lands here.
  useEffect(() => {
    const take = (d) => {
      // Oct 7: a drill may carry a party ({ kind, code, name }) and report
      // filters (`dims`: vendor, customer, departments, journals ...) - they
      // follow into the lines like the report's own.
      if (!d || !(d.account || d.party || d.dims)) return;
      if (d.entity !== undefined) patch({ entities: d.entity ? [d.entity] : [] });
      setDrill({ account: d.account || '', accountName: d.accountName || '', from: d.from || '', to: d.to || iso(new Date()), book: d.book || 'accrual',
        ...(d.party ? { party: d.party } : {}), ...(d.dims ? { dims: d.dims } : {}) });
      toTop();
    };
    take(takePendingDrill());
    const onEvent = (e) => { takePendingDrill(); take(e.detail); };
    window.addEventListener('nexus:accounting-drill', onEvent);
    return () => window.removeEventListener('nexus:accounting-drill', onEvent);
  }, [patch]);
  // The lines behind one amount: the account, in that column's window and
  // book. A total has no account (Charmi, 10/02: "make all the reports
  // clickable"): it opens every line of the column's period and entity.
  const drillInto = (row, column) => {
    if (!column.drill) return;
    setDrill({ account: row.code || '', accountName: row.title || row.label || '', ...column.drill });
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

  // Oct 2 (Charmi): in a drill-down or a search the same Export menu takes
  // the lines on screen - one Export, every format, everywhere.
  const [linesExport, setLinesExport] = useState(null);   // { build, lines, name, title } from LedgerSearch
  const [linesBusy, setLinesBusy] = useState('');
  const exportLines = async (format) => {
    if (!linesExport || linesBusy) return;
    setLinesBusy(format);
    try {
      const file = await linesFile(await linesExport.build(), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setError(e?.message || 'Could not export the lines.');
    } finally {
      setLinesBusy('');
    }
  };

  const def = reportDef(config.report);
  const cols = activeColumns(config);
  const modes = columnModes(config.report, config);
  const showColumns = modes.length > 1 && config.book !== 'both';
  const chips = filterChips(config, entities, dimNames);
  const entityLabel = entityText(config, entities);
  // A column of one entity drills into that entity, whatever the report covers.
  const drillEntities = drill?.entity ? [drill.entity] : config.entities;
  const drillEntityLabel = drill?.entity ? entityText({ entities: [drill.entity] }, entities) : entityLabel;
  const glBusy = loading && config.report === 'general-ledger';
  // What Collapse All folds: statement sections and General Ledger accounts, and the account groups above them.
  const foldKeys = (result?.rows || []).flatMap((r) => (r.kind === 'section' ? [r.section] : r.kind === 'group' ? [`g:${r.group}`] : []));

  // Flux Analysis explanations (Neil, 10/02): kept per entity set, account
  // and period in Nexus (accounting_flux_notes). A limited caller's "all
  // entities" is their own set, so the key names them.
  const fluxKey = useMemo(() => {
    if (config.report !== 'flux') return null;
    const codes = config.entities.length ? [...config.entities] : limited ? entities.map((e) => e.code) : [];
    return { entity: codes.length ? [...new Set(codes)].sort().join(',') : 'all', period: `${config.from}_${config.to}` };
  }, [config.report, config.entities, config.from, config.to, limited, entities]);
  const [fluxNotes, setFluxNotes] = useState({});     // accountNo -> text
  // Item 26a (Charmi's Friday list): the explanation is edited in its cell -
  // the pencil opens a box in place (Enter or leaving it saves, Esc cancels,
  // Shift+Enter a new line), the trash asks "Remove / Keep" in place.
  const [noteEdit, setNoteEdit] = useState(null);     // { code, text }
  const [noteRemove, setNoteRemove] = useState(null); // code waiting for Remove / Keep
  const [noteError, setNoteError] = useState(null);   // { code, text }
  const [noteBusy, setNoteBusy] = useState('');       // code being saved
  useEffect(() => {
    if (!fluxKey) return undefined;
    let alive = true;
    setFluxNotes({});
    api.getAccountingFluxNotes(fluxKey.entity, fluxKey.period)
      .then((d) => { if (alive) setFluxNotes(Object.fromEntries((d?.notes || []).map((n) => [n.accountNo, n.note]))); })
      .catch(() => { /* the column reads empty; writing will say why */ });
    return () => { alive = false; };
  }, [fluxKey?.entity, fluxKey?.period]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveNote = (code, text) => {
    if (noteBusy || !fluxKey) return;
    const note = (text || '').trim();
    setNoteEdit(null);
    setNoteRemove(null);
    if (note === (fluxNotes[code] || '')) return;
    setNoteBusy(code);
    setNoteError(null);
    api.saveAccountingFluxNote({ entity: fluxKey.entity, period: fluxKey.period, accountNo: code, note })
      .then((n) => setFluxNotes((m) => ({ ...m, [code]: n?.note || '' })))
      .catch((err) => setNoteError({ code, text: err?.message || 'Could not save the explanation.' }))
      .finally(() => setNoteBusy(''));
  };
  const noteProps = {
    notes: fluxNotes, edit: noteEdit, remove: noteRemove, error: noteError, busy: noteBusy,
    onEdit: (code) => { setNoteError(null); setNoteRemove(null); setNoteEdit({ code, text: fluxNotes[code] || '' }); },
    onText: (text) => setNoteEdit((n) => (n ? { ...n, text } : n)),
    onCancel: () => setNoteEdit(null),
    onSave: saveNote,
    onAskRemove: (code) => { setNoteEdit(null); setNoteRemove(code); },
    onKeep: () => setNoteRemove(null),
  };
  const showInactive = !!custom.showInactiveAccounts;
  const shown = useMemo(() => {
    if (!result || result.config.report !== config.report) return null;
    return hideInactive(result.flux ? withFluxNotes(result, fluxNotes) : result, showInactive);
  }, [result, config.report, fluxNotes, showInactive]);
  // The first column (code and name) and the report's own; each one drags to a width (item 32).
  const headCols = shown ? [{ key: '__label', label: shown.glLabel || 'Account', type: 'label' }, ...shown.columns] : [];
  // Oct 2 (Charmi): the "contains" box under every column, on every report,
  // like the ledger lines grid. Typed text narrows the account and line rows
  // (amounts match with or without commas); a section heading stays while
  // something under it matches, and the grand total stays (it is the whole
  // report's - the line under the table says so).
  // Oct 7 (item 26d): an amount, variance or % column filters with an
  // operator (=, >, <, >=, <=, Between) and a value - { op, a, b }; a text
  // column keeps "contains".
  const [colFilters, setColFilters] = useState({});
  useEffect(() => { setColFilters({}); }, [config.report]);
  const isNumCol = (c) => c.type === 'amount' || c.type === 'variance' || c.type === 'pct';
  const filterSet = (v) => (typeof v === 'string' ? !!v.trim() : !!v && (String(v.a ?? '').trim() || String(v.b ?? '').trim()));
  const filterOn = Object.values(colFilters).some(filterSet);
  const visibleRows = useMemo(() => {
    const rows = shown?.rows || [];
    if (!filterOn) return rows;
    const wants = Object.entries(colFilters).filter(([, v]) => filterSet(v));
    const textOf = (r, k) => {
      if (k === '__label') return `${r.code || ''} ${r.title || r.label || ''}`;
      const i = shown.columns.findIndex((c) => c.key === k);
      const v = r.values?.[i];
      if (typeof v === 'number') { const a = Math.abs(v).toFixed(2); return `${a} ${Number(a).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${v < 0 ? `-${a} (${a})` : ''}`; }
      return String(v ?? '');
    };
    const hit = (r) => wants.every(([k, f]) => {
      if (typeof f !== 'string') {
        const i = shown.columns.findIndex((c) => c.key === k);
        return i >= 0 && numberFilterHit(r.values?.[i], f);
      }
      const v = f.trim().toLowerCase();
      const cell = textOf(r, k).toLowerCase();
      return cell.includes(k === '__label' ? v : v.replace(/,/g, '')) || cell.includes(v);
    });
    const matched = rows.filter((r) => (r.kind === 'account' || r.kind === 'line') && hit(r));
    const keepSections = new Set(matched.map((r) => r.section).filter(Boolean));
    const keepGroups = new Set(matched.map((r) => r.group).filter(Boolean));
    const keep = new Set(matched);
    return rows.filter((r) => keep.has(r) || (r.kind === 'section' && (keepSections.has(r.section) || hit(r))) || (r.kind === 'group' && keepGroups.has(r.group)) || r.kind === 'grand');
  }, [shown, colFilters, filterOn]);
  const matchedCount = filterOn ? visibleRows.filter((r) => r.kind === 'account' || r.kind === 'line').length : 0;

  // Folded groups and accounts, then pages (item 21): a General Ledger page
  // never splits a group heading from its accounts; the totals under the
  // table are over every row, on every page. Exports always take everything.
  const groupKey = (g) => `g:${g}`;
  const openRows = useMemo(() => visibleRows.filter((r) => {
    if (filterOn) return true;
    if (r.group && r.kind !== 'group' && collapsed.has(groupKey(r.group))) return false;
    if (r.kind !== 'section' && r.kind !== 'group' && r.section && collapsed.has(r.section)) return false;
    return true;
  }), [visibleRows, collapsed, filterOn]);
  const paged = useMemo(() => reportPages(openRows, custom.pageSize), [openRows, custom.pageSize]);
  const pageKey = `${key}|${custom.pageSize}|${JSON.stringify(colFilters)}|${config.report}`;
  const [pageState, setPageState] = useState({ page: 1, key: pageKey });
  let page = pageState.page;
  if (pageState.key !== pageKey) { page = 1; setPageState({ page: 1, key: pageKey }); }
  page = Math.min(Math.max(1, page), Math.max(1, paged.pages.length));
  const pageRows = paged.pages[page - 1] || [];
  const before = paged.pages.slice(0, page - 1).reduce((n, p) => n + p.filter((r) => !r.continued).length, 0);
  const pager = {
    page, pages: paged.pages.length, total: paged.total, from: paged.total ? before + 1 : 0,
    to: before + pageRows.filter((r) => !r.continued).length, setPage: (n) => setPageState({ page: Math.max(1, n), key: pageKey }),
  };

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
  const select = (active) => ({ ...control, fontWeight: active ? 600 : 400, color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)', maxWidth: 300 });

  // minmax(0,1fr): an unsized grid track grows to its widest content, which
  // pushed the controls past a phone's edge (QA, Sep 23).
  const shell = full
    ? { position: 'fixed', inset: 0, zIndex: 400, overflow: 'auto', padding: 12, background: 'var(--bg-primary)', display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10, alignContent: 'start' }
    : { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 };

  return (
    <div style={shell}>
      {/* One slim row: every control as a dropdown (the search is in the header, top right). */}
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {(!headerSearch || full) && <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0, maxWidth: 460 }}>
          {waiting
            ? <Loader2 size={14} className="spin" aria-label="Searching" style={{ position: 'absolute', left: 9, top: 8, color: 'var(--wk-brand, #2b45e1)' }} />
            : <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />}
          <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search the ledger"
            placeholder="Search vendor, customer, invoice, amount, memo..."
            style={{ ...control, width: '100%', paddingLeft: 28, paddingRight: 26 }} />
          {searchText && <ClearButton onClick={() => setSearchText('')} label="Clear search" />}
        </div>}

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
            {books.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        )}

        {/* Entities, Filters, then Accounts last (Charmi, 10/02). */}
        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        {canUseDims(config) && (
          <FiltersButton dims={config.dims} onNames={onNames} showHistorical={!!prefs.showHistoricalAccounts} kinds={filterKinds}
            onChange={(dims) => { const mode = columnsForPicks(config, dims); setCollapsed(new Set()); patch({ dims, ...(mode ? { cols: mode } : {}) }); }} />
        )}
        {canPickAccounts(config) && <AccountsPicker accounts={shown?.pickable || []} value={config.accounts} onChange={(accounts) => patch({ accounts })} showHistorical={!!prefs.showHistoricalAccounts} />}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SavedReportsMenu reports={saved} loading={savedState.loading} error={savedState.error} activeId={activeSaved?.id}
            onOpen={openSaved} onDelete={deleteSaved} onShare={shareSaved} onManage={() => setManaging(true)} nameOf={nameOf} />
          <MemorizeButton onSave={memorize} suggestion={activeSaved?.mine ? activeSaved.name : `${def.label} - ${entityLabel} - ${def.period === 'asof' ? 'As of Date' : presetLabel(config.preset)}`} />
          <CustomizeButton density={density} onDensity={(d) => setPrefs({ density: d })} showZero={config.showZero} onShowZero={(v) => patch({ showZero: v })}
            showHistorical={!!prefs.showHistoricalEntities} onShowHistorical={(v) => setPrefs({ showHistoricalEntities: v })}
            showHistoricalAccounts={!!prefs.showHistoricalAccounts} onShowHistoricalAccounts={(v) => setPrefs({ showHistoricalAccounts: v })}
            pageSize={custom.pageSize} onPageSize={custom.onPageSize}
            {...(shown?.activeKnown ? { showInactiveAccounts: custom.showInactiveAccounts, onShowInactiveAccounts: custom.onShowInactiveAccounts } : {})}
            flux={config.report === 'flux' ? { fluxPct: config.fluxPct, fluxAmount: config.fluxAmount } : null} onFlux={(p) => patch(p)} />
          <ExportMenu disabled={searching ? !linesExport : !shown} items={searching ? [
            { key: 'excel', label: 'Excel', hint: 'Every line, columns as on screen, live totals', onPick: () => exportLines('excel'), busy: linesBusy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportLines('csv'), busy: linesBusy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportLines('pdf'), busy: linesBusy === 'pdf' },
            { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, lines attached', Icon: Mail, onPick: () => setSending('email') },
            { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
          ] : [
            { key: 'excel', label: 'Excel', hint: 'Totals in bold, columns fitted, live formulas', onPick: () => shown && exportExcel(shown), busy: xlsxBusy },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => shown && downloadCsv(csvFileName(shown), csvRows(shown, entities)) },
            { key: 'pdf', label: 'PDF', hint: 'Laid out like a page of a package', onPick: () => shown && exportPdf(shown), busy: pdfBusy },
            { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, statement attached', Icon: Mail, onPick: () => setSending('email') },
            { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
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
          <span style={{ flex: 1 }}>{sent.text}{sent.url && <> <a href={sent.url} target="_blank" rel="noreferrer">Open the File</a></>}</span>
          <button type="button" onClick={() => setSent(null)} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}><X size={14} /></button>
        </div>
      )}
      {sending && searching && linesExport && (
        <SendReportDialog mode={sending} title={linesExport.title} baseName={linesExport.name} what="lines"
          makeFile={async (format, name) => linesFile(await linesExport.build(), format, name)}
          onClose={() => setSending(null)} onDone={(text, url) => { setSending(null); setSent({ text, url }); }} />
      )}
      {sending && !searching && shown && (
        <SendReportDialog mode={sending} result={shown} entities={entities} title={activeSaved?.name || def.label} config={storable(config)}
          onClose={() => setSending(null)} onDone={(text, url) => { setSending(null); setSent({ text, url }); }} />
      )}

      {managing && (
        <SavedReportsManager reports={saved} activeId={activeSaved?.id} nameOf={nameOf} onClose={() => setManaging(false)}
          onOpen={openSaved} onRename={renameSaved} onShare={shareSaved} onDelete={deleteSaved} />
      )}

      {searching && (
        <LedgerSearch term={term.length >= 2 ? term : ''} entities={drillEntities} entityName={drillEntityLabel} full={full}
          dims={canUseDims(config) ? config.dims : null} dimNames={dimNames} drill={drill} onClearDrill={() => setDrill(null)} onClose={closeSearch} onBusy={setSearchBusy} onExport={setLinesExport} />
      )}

      {!searching && error && <div role="alert" style={{ ...card, padding: 14, borderColor: 'var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', fontSize: '0.88rem' }}>{plainError(error)}</div>}
      {/* The General Ledger reads the lines account by account - the skeleton stays for the whole run (item 31). */}
      {!searching && loading && (!shown || glBusy) && (
        <div role="status" aria-label="Loading the report" style={{ ...card, padding: 12, display: 'grid', gap: 8 }}>
          {glBusy && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Loader2 size={14} className="spin" /> Reading the ledger lines...</span>}
          <SkeletonBlocks count={4} />
        </div>
      )}

      {!searching && shown && !glBusy && (
        <div style={{ ...card, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
              <h3 style={{ fontSize: '0.98rem', margin: 0 }}>{def.label}</h3>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                {[shown.org, entityLabel, periodText(config), shown.mode === 'compare' ? `vs ${shown.otherLabel}` : '', cols !== 'total' && shown.mode !== 'compare' ? modes.find((m) => m.key === cols)?.label : '', canPickBook(config) ? bookLabel(config.book) : ''].filter(Boolean).join(' · ')}
                {loading ? ' · updating' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {foldKeys.length > 0 && (
                <button type="button" className="secondary-btn" style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                  onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(foldKeys))}>
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
                <button type="button" onClick={() => patch({ entities: [], dims: { ...EMPTY_DIMS }, accounts: [] })}
                  style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.74rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                  Clear all filters
                </button>
              )}
            </div>
          )}

          {shown.summary.length > 0 && (
            <div aria-label="Summary" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 22px', margin: '0 2px 8px', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>
              {shown.summary.map((f) => (
                <span key={f.label} style={{ color: 'var(--text-secondary)' }}>
                  {f.label} <strong style={{ color: f.tone === 'good' ? 'var(--ok-fg, #15803d)' : f.tone === 'bad' ? 'var(--bad-fg, #dc2626)' : 'var(--text-primary)' }}>{f.amount != null ? <Amount value={f.amount} /> : <Figure text={f.value} />}</strong>
                </span>
              ))}
            </div>
          )}

          <div className="acct-report-wrap" style={{ opacity: loading ? 0.6 : 1, ...(full ? { maxHeight: 'calc(100vh - 190px)' } : {}) }} onCopy={copyRaw}>
            <table className={`acct-report${shown.glLabel ? ' acct-gl' : ''}`} style={{ '--acct-row-py': DENSITIES.find((d) => d.key === density)?.py || '5px' }}>
              <colgroup>
                {headCols.map((c) => <col key={c.key} style={widths.width(c.key) ? { width: widths.width(c.key), minWidth: widths.width(c.key) } : undefined} />)}
              </colgroup>
              <thead>
                <tr>
                  {headCols.map((c, i) => {
                    const w = widths.width(c.key);
                    const size = w ? { width: w, minWidth: w, maxWidth: w } : {};
                    return (
                      <th key={c.key} aria-label={c.label} className={i === 0 ? 'acct-label acct-head' : c.type === 'date' || c.type === 'text' ? undefined : 'acct-num'}
                        style={{ position: i === 0 ? 'sticky' : 'relative', ...size, ...(c.emphasis ? EMPHASIS : {}) }}>
                        {c.label}
                        <ColumnResizer {...widths.resizer(c.key, c.label)} />
                      </th>
                    );
                  })}
                </tr>
                <tr className="acct-filter-row">
                  {headCols.map((c, i) => {
                    const f = colFilters[c.key];
                    const setF = (v) => setColFilters((all) => ({ ...all, [c.key]: v }));
                    if (!isNumCol(c)) {
                      return (
                        <td key={c.key} className={i === 0 ? 'acct-head' : undefined}>
                          <input type="text" value={typeof f === 'string' ? f : ''} onChange={(e) => setF(e.target.value)} aria-label={`Filter ${c.label}`} placeholder="contains" />
                        </td>
                      );
                    }
                    const nf = f && typeof f === 'object' ? f : { op: '=', a: '', b: '' };
                    return (
                      <td key={c.key}>
                        <span className="acct-op-filter">
                          <select value={nf.op} onChange={(e) => setF({ ...nf, op: e.target.value })} aria-label={`Operator for ${c.label}`} title="Compare with">
                            {NUM_OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                          </select>
                          <input type="text" inputMode="decimal" value={nf.a} onChange={(e) => setF({ ...nf, a: e.target.value })} aria-label={`Filter ${c.label}`}
                            placeholder={c.type === 'pct' ? '%' : '0.00'} className="acct-num" />
                          {nf.op === 'between' && (
                            <input type="text" inputMode="decimal" value={nf.b} onChange={(e) => setF({ ...nf, b: e.target.value })} aria-label={`Filter ${c.label} up to`}
                              placeholder="and" className="acct-num" />
                          )}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const foldKey = r.kind === 'group' ? `g:${r.group}` : r.section;
                  const open = (r.kind === 'section' || r.kind === 'group') && (filterOn || !collapsed.has(foldKey));
                  return <StatementRow key={`${r.kind}-${r.group || ''}-${r.section || ''}-${r.code || r.label}-${i}`} row={r} columns={shown.columns} open={open} width={widths.width}
                    onToggle={() => toggleSection(foldKey)} onDrill={drillInto} onEntry={(row) => row.entryId && setEntry({ id: row.entryId, no: row.entryNo || row.values?.[0] || '' })}
                    note={shown.flux ? noteProps : null} />;
                })}
                {paged.pinned.map((r, i) => (
                  <StatementRow key={`pinned-${r.kind}-${r.label}-${i}`} row={r} columns={shown.columns} open width={widths.width} onToggle={() => {}} onDrill={drillInto} note={null} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager {...pager} />
          {entry && <EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} />}
          {filterOn && (
            <div role="status" style={{ marginTop: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>Filtered to {matchedCount.toLocaleString('en-US')} {matchedCount === 1 ? 'row' : 'rows'}. Section and grand totals are for the whole report.</span>
              <button type="button" onClick={() => setColFilters({})} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>Clear column filters</button>
            </div>
          )}
          {(shown.notes || []).map((n) => <div key={n} style={{ marginTop: 6, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{n}</div>)}
          <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            Generated {formatDate(shown.generatedAt)} from the Nexus Accounting ledger. Click any underlined amount for the lines behind it{shown.glLabel ? ', an entry number for the whole entry' : ''}; click a section to fold it; drag the edge of a column heading to change its width (double-click fits it).
          </div>
        </div>
      )}
    </div>
  );
}

// Copying cells puts raw numbers on the clipboard: "(3,418.07)" pastes into
// Excel as -3418.07, a dash as 0 and "1,500.00" as 1500.00, so formulas work.
function copyRaw(e) {
  const text = String(window.getSelection?.() || '');
  if (!text.trim()) return;
  const raw = text
    .replace(/\((\d[\d,]*\.?\d*%?)\)/g, '-$1')
    .replace(/(^|\s)-(?=\s|$)/gm, (_m, lead) => `${lead}0`)
    .replace(/(\d),(?=\d{3})/g, '$1');
  e.clipboardData.setData('text/plain', raw);
  e.preventDefault();
}

// The Total column beside a run of period or entity columns.
const EMPHASIS = { fontWeight: 700, borderLeft: '2px solid var(--border-color)' };
// A filter in force, under the report title; its X takes it off.
const CHIP = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: '0.75rem', maxWidth: 320, border: '1px solid var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 };

const tint = (v) => (v < 0 ? 'var(--bad-fg, #dc2626)' : v > 0 ? 'var(--ok-fg, #15803d)' : undefined);

// One line of a statement: a fold-able section heading with its total, an
// account (code and name on one line, every amount a drill-down), or a total.
// Every figure with a window behind it drills (Charmi, 10/02) - an account
// into its lines, a section total or subtotal into the column's whole
// period; only a ledger line itself (it IS a line) and a variance do not.
const DRILL_KINDS = new Set(['account', 'section', 'subtotal', 'grand']);
// The accounting service's time-out, in the words of the screen (item 31).
function plainError(text) {
  return /too many ledger lines|statement timeout|canceling statement/i.test(text || '') ? 'Too many lines for one run - pick an entity or a shorter period.' : text;
}
// Oct 7: `width(key)` is the column's dragged width (item 32); `drills` on a
// row overrides a column's window (an Opening balance opens every line
// before the period); `noDrill` keeps a computed figure (a group total, Net
// Income on a cash flow) from opening "every line"; an entry number opens
// the entry (item 33); `note` carries the Flux explanation editing (item 26a).
function StatementRow({ row, columns, open, width = () => undefined, onToggle, onDrill, onEntry = null, note = null }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const variance = columns.findIndex((c) => c.type === 'variance');
  const labelW = width('__label');
  // A folded group shows its totals on its heading.
  const values = row.kind === 'group' && !open && row.totals ? row.totals : row.values;
  const cells = columns.map((c, i) => {
    const v = values[i];
    const w = width(c.key);
    const cap = w ? { maxWidth: w, overflow: 'hidden', textOverflow: 'ellipsis' } : {};
    if (c.type === 'date') return <td key={c.key} style={{ color: 'var(--text-secondary)', ...cap }}>{v || (row.kind === 'account' ? '-' : '')}</td>;
    if (c.type === 'text' && c.key === 'note' && note && row.kind === 'account' && row.code) {
      return <NoteCell key={c.key} row={row} value={v} note={note} maxWidth={w || 360} />;
    }
    if (c.type === 'text' && c.key === 'flag' && v) {
      const done = v === 'Explained';
      return <td key={c.key}><span className={`acct-chip${done ? ' acct-chip-muted' : ' acct-chip-warn'}`} title={done ? 'Flagged, and explained' : 'Over the flux thresholds - needs an explanation'}>{v}</span></td>;
    }
    if (c.type === 'text' && c.key === 'entry' && row.kind === 'line' && row.entryId && onEntry && v) {
      return (
        <td key={c.key} style={cap}>
          <button type="button" className="acct-drill" title="Open the journal entry" onClick={(e) => { e.stopPropagation(); onEntry(row); }}>{v}</button>
        </td>
      );
    }
    if (c.type === 'text') return <td key={c.key} title={v || undefined} style={{ maxWidth: w || (c.key === 'description' ? 460 : 220), overflow: 'hidden', textOverflow: 'ellipsis', color: row.kind === 'line' ? undefined : 'var(--text-secondary)' }}>{v || ''}</td>;
    if (c.type === 'pct') return <td key={c.key} className="acct-num" style={{ color: tint(values[variance]) }}><Figure text={v || '-'} /></td>;
    if (row.kind === 'margin') return <td key={c.key} className="acct-num" style={{ ...(c.emphasis ? EMPHASIS : {}), color: tint(v) }}><Figure text={cellText(row, c, v) || '-'} /></td>;
    if (v === '' || v == null) return <td key={c.key} className="acct-num" />;
    if (c.type === 'variance') return <td key={c.key} className="acct-num" style={{ color: tint(v) }}><Amount value={v} zero="dash" /></td>;
    // A zero is a dash on the statement; a ledger line leaves its empty side blank.
    const figure = <Amount value={v} zero={row.kind === 'line' ? 'blank' : 'dash'} />;
    const look = row.tone ? { color: v >= 0 ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)' } : c.key === 'other' && columns.length > 2 ? { color: 'var(--text-secondary)' } : row.kind === 'account' && v < 0 && columns.length === 2 && columns[1].type === 'date' ? { color: 'var(--bad-fg, #dc2626)' } : undefined;
    const style = c.emphasis ? { ...EMPHASIS, ...look } : look;
    const drill = row.drills?.[i] || c.drill;
    const drills = drill && !row.noDrill && DRILL_KINDS.has(row.kind) && (row.kind !== 'section' || !row.values.every((x) => typeof x !== 'number'));
    return (
      <td key={c.key} className="acct-num" style={style}>
        {drills
          ? <button type="button" className="acct-drill" title={row.code ? 'See the lines behind this amount' : 'See every line behind this total'} onClick={(e) => { e.stopPropagation(); onDrill(row, { ...c, drill }); }}>{figure}</button>
          : figure}
      </td>
    );
  });
  const labelStyle = labelW ? { maxWidth: labelW } : undefined;
  if (row.kind === 'section' || row.kind === 'group') {
    // A heading folds what is under it; one with nothing under it has no arrow (item 20).
    const folds = row.kind === 'group' || row.count > 0;
    return (
      <tr className={row.kind === 'group' ? 'acct-section acct-group' : 'acct-section'} onClick={folds ? onToggle : undefined} title={folds ? (open ? 'Click to fold' : 'Click to open') : undefined}>
        <td className="acct-label" style={labelStyle} title={row.label}>
          {folds && (
            <button type="button" className="acct-fold" aria-expanded={open} aria-label={`${open ? 'Fold' : 'Open'} ${row.label}`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
              <Chevron size={13} />
            </button>
          )}
          {row.code && row.title ? <><span className="acct-code">{row.code}</span>{row.title}</> : row.label}{!open || row.kind === 'group' ? <span className="acct-count">{row.count}</span> : null}
        </td>
        {cells}
      </tr>
    );
  }
  if (row.kind === 'line') {
    const opens = row.entryId && onEntry;
    return (
      <tr className={opens ? 'acct-line-link' : undefined} onClick={opens ? () => onEntry(row) : undefined} title={opens ? 'Open the journal entry' : undefined}>
        <td className="acct-label acct-indent" style={{ color: 'var(--text-secondary)', ...(labelStyle || {}) }}>{row.label}</td>
        {cells}
      </tr>
    );
  }
  if (row.kind === 'account') {
    return (
      <tr className={row.flag ? (row.explained ? 'acct-flag acct-flag-done' : 'acct-flag') : undefined} title={row.flag ? 'Over the flux thresholds' : undefined}>
        <td className={`acct-label${row.section || row.group ? ' acct-indent' : ''}`} style={labelStyle} title={`${row.code ? `${row.code} ` : ''}${row.title}`}>
          {row.code ? <span className="acct-code">{row.code}</span> : null}
          <span>{row.title}</span>
          {row.inactive ? <span className="acct-count" title="Inactive in Intacct">Inactive</span> : null}
        </td>
        {cells}
      </tr>
    );
  }
  return (
    <tr className={row.kind === 'grand' ? 'acct-grand' : row.kind === 'subtotal' || row.kind === 'margin' ? 'acct-subtotal' : undefined} style={row.kind === 'warn' ? { color: 'var(--bad-fg, #dc2626)' } : undefined}>
      <td className={`acct-label${row.section && row.kind === 'subtotal' ? ' acct-indent' : ''}`} style={labelStyle}>{row.label}</td>
      {cells}
    </tr>
  );
}

// The Explanation cell of a Flux line (item 26a): the text with a pencil and
// a trash can; the pencil turns the cell into a box (Enter or leaving it
// saves, Esc cancels, Shift+Enter starts a new line), the trash asks
// "Remove / Keep" in the cell - no dialog.
function NoteCell({ row, value, note, maxWidth }) {
  const editing = note.edit?.code === row.code;
  const removing = note.remove === row.code;
  const busy = note.busy === row.code;
  const err = note.error?.code === row.code ? note.error.text : '';
  const cancelled = useRef(false);
  const name = `${row.code} ${row.title}`;
  if (editing) {
    return (
      <td style={{ minWidth: 260, maxWidth: Math.max(maxWidth, 320), whiteSpace: 'normal' }}>
        <textarea value={note.edit.text} maxLength={2000} rows={2} autoFocus aria-label={`Explanation for ${name}`} placeholder="Why did this account move?"
          onChange={(e) => note.onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; note.onCancel(); }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); note.onSave(row.code, note.edit.text); }
          }}
          onBlur={() => { if (cancelled.current) { cancelled.current = false; return; } note.onSave(row.code, note.edit.text); }}
          style={{ ...control, width: '100%', height: 'auto', padding: 6, lineHeight: 1.4, resize: 'vertical', fontSize: '0.78rem' }} />
      </td>
    );
  }
  const iconBtn = { border: 'none', background: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex' };
  return (
    <td style={{ maxWidth, overflow: 'hidden' }} title={value || undefined}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {removing ? (
          <>
            <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>Remove this explanation?</span>
            <button type="button" className="secondary-btn" style={{ fontSize: '0.72rem', padding: '1px 8px', color: 'var(--bad-fg, #dc2626)' }} onClick={() => note.onSave(row.code, '')}>Remove</button>
            <button type="button" className="secondary-btn" style={{ fontSize: '0.72rem', padding: '1px 8px' }} onClick={note.onKeep}>Keep</button>
          </>
        ) : (
          <>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: value ? undefined : 'var(--text-muted)' }}>{busy ? 'Saving...' : value || ''}</span>
            <button type="button" style={iconBtn} onClick={() => note.onEdit(row.code)} aria-label={`${value ? 'Edit' : 'Add'} explanation for ${name}`} title={value ? 'Edit the explanation' : 'Write why this account moved'}><Pencil size={13} /></button>
            {value && <button type="button" style={iconBtn} onClick={() => note.onAskRemove(row.code)} aria-label={`Remove explanation for ${name}`} title="Remove the explanation"><Trash2 size={13} /></button>}
          </>
        )}
      </span>
      {err && <span role="alert" style={{ display: 'block', fontSize: '0.72rem', color: 'var(--bad-fg, #dc2626)', whiteSpace: 'normal' }}>{err}</span>}
    </td>
  );
}
