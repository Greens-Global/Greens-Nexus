import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FilePlus2, Loader2, Play, Plus, Send, Trash2, Users, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import Amount from './Amount';
import { AccountsPicker, EntitiesPicker, ExportMenu, FiltersButton, PeriodStepper, control } from './reportControls';
import { POPOVER_DIMS, bookOptions, csvFileName, csvRows, downloadBlob, downloadCsv, entityText, periodText, setUserBooks } from './reportModel';
import {
  BUILDER_COLUMNS, BUILDER_PERIODS, defaultBuilder, includedAccounts, isPublished, readChart, resolveBuilder, runBuilder, storableBuilder,
} from './builderModel';
import { BUILDER_COMPARE_OPTIONS, BUILDER_PUBLISH_SHARES } from './assumptions';
import { useAccountingPrefs } from './prefs';
import { clearParkedReport, peekParkedReport } from './drill';

// Accounting -> Reports -> Report Center -> Report Builder (Neil, 10/22 call,
// item 05; item 11 for the row groups). Pick the GL accounts, the entities and
// any other dimension (department, vendor, customer, employee, Project-Job,
// item, journal), the period and the book, Run, then Save it under a name or
// Publish it to the accounting team. Named row groups ("Line 8 Advertising")
// gather accounts under one total, so a Schedule C or any other nonstandard
// report is built here, by the person who knows the mapping - never in code.
//
// The definition is a memorized report (builderModel: kind 'builder',
// version 1); it shows in the Report Center and reopens here. The figures are
// read fresh on every Run through the statements' own bucket read, so a
// person limited to certain entities builds over their entities only.
//
// Oct 23, team answer (Neil, CR-05): "Yes it needs comparison columns.
// Anyone can publish if they have access to accounting, and published reports
// can be shared with everyone, but are not shared by default." Compare adds
// vs Prior Period / vs Prior Year (BUILDER_COMPARE_OPTIONS) with Variance $
// and %. Save keeps a draft; Publish marks it published (`published` in the
// config), still seen by its author only (BUILDER_PUBLISH_SHARES); Share With
// Everyone is the memorized report's `shared` flag, the sharing every
// memorized report already uses. Anyone with Accounting may do all three
// (canPublish, BUILDER_PUBLISH_MIN_LEVEL).

export default function ReportBuilder({ canPublish = true }) {
  const [parked] = useState(() => peekParkedReport(true));
  useEffect(() => { if (parked) clearParkedReport(parked); }, [parked]);
  const [config, setConfig] = useState(() => (parked ? resolveBuilder(parked.config) : defaultBuilder()));
  const [name, setName] = useState(() => parked?.name || '');
  const [opened, setOpened] = useState(() => (parked ? { id: parked.id, name: parked.name, mine: !!parked.mine, shared: !!parked.shared, published: isPublished(parked) } : null));
  const patch = (p) => setConfig((c) => resolveBuilder({ ...c, ...p }));
  const [prefs] = useAccountingPrefs();

  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [chart, setChart] = useState(null);
  const [chartError, setChartError] = useState('');
  const [journalsOn, setJournalsOn] = useState(true);
  const [, setBooksListed] = useState(0);
  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) { setEntities(d?.entities || []); setLimited(!!d?.limited); } }).catch(() => {});
    readChart(api).then((list) => { if (alive) setChart(list); }).catch((e) => { if (alive) { setChart([]); setChartError(e?.message || 'Could not load the GL accounts.'); } });
    api.getAccountingBooks?.()?.then((d) => { if (alive && d?.available) { setUserBooks(d.books); setBooksListed((n) => n + 1); } })?.catch?.(() => {});
    api.getAccountingJournals?.()?.then((d) => { if (alive) setJournalsOn(d?.available !== false); })?.catch?.(() => { if (alive) setJournalsOn(false); });
    return () => { alive = false; };
  }, []);
  const kinds = useMemo(() => (journalsOn ? POPOVER_DIMS : POPOVER_DIMS.filter((k) => k.key !== 'journals')), [journalsOn]);

  // Run: read the ledger for the definition on screen.
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const run = (c = config) => {
    if (running) return;
    setRunning(true);
    setError('');
    runBuilder(api, c, { name: name.trim() || opened?.name || '', entities, chart: chart || [] })
      .then((r) => { setResult(r); setCollapsed(new Set()); })
      .catch((e) => { setResult(null); setError(/too many ledger lines|statement timeout|canceling statement/i.test(e?.message || '') ? 'Too many lines for one run - pick an entity or a shorter period.' : e?.message || 'Could not run the report.'); })
      .finally(() => setRunning(false));
  };
  // A saved report opened from the Report Center runs at once.
  useEffect(() => { if (parked) run(resolveBuilder(parked.config)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = !!result && JSON.stringify(storableBuilder(result.builder)) !== JSON.stringify(storableBuilder(config));

  // Row groups (item 11): a name and the accounts under it; an account sits in one group only.
  const groups = config.groups;
  const setGroups = (next) => patch({ groups: next });
  const addGroup = () => setGroups([...groups, { name: '', accounts: [] }]);
  const renameGroup = (i, v) => setGroups(groups.map((g, j) => (j === i ? { ...g, name: v } : g)));
  const groupAccounts = (i, accounts) => {
    const mine = new Set(accounts);
    setGroups(groups.map((g, j) => (j === i ? { ...g, accounts } : { ...g, accounts: g.accounts.filter((a) => !mine.has(a)) })));
  };
  const moveGroup = (i, by) => {
    const j = i + by;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[i], next[j]] = [next[j], next[i]];
    setGroups(next);
  };
  const removeGroup = (i) => setGroups(groups.filter((_g, j) => j !== i));
  const [groupsOpen, setGroupsOpen] = useState(() => groups.length > 0);

  // Save (a draft, or Save Changes keeping its state), Publish, Share With
  // Everyone / Stop Sharing, Unpublish. `published` rides in the config,
  // `shared` is the memorized report's flag.
  const [saving, setSaving] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const NOTES = {
    save: 'Saved as a draft. Only you see it in the Report Center.',
    publish: BUILDER_PUBLISH_SHARES ? 'Published and shared with everyone. It is in the Report Center.' : 'Published. Only you see it until you share it with everyone.',
    share: 'Shared with everyone who has Accounting. It is in their Report Center.',
    unshare: 'No longer shared. Only you see it.',
    unpublish: 'Back to a draft. Only you see it.',
  };
  const save = (action = 'save') => {
    const n = name.trim();
    if (!n || saving) return;
    const keep = opened?.mine ? opened : { published: false, shared: false };
    const published = action === 'publish' || action === 'share' ? true : action === 'unpublish' ? false : !!keep.published;
    const shared = action === 'share' ? true : action === 'publish' ? (keep.shared || BUILDER_PUBLISH_SHARES) : action === 'save' ? !!keep.shared : false;
    setSaving(action);
    setSaveNote('');
    setError('');
    const body = { name: n, config: { ...storableBuilder(config), ...(published ? { published: true } : {}) }, shared };
    const call = opened?.mine ? api.updateAccountingSavedReport(opened.id, body) : api.saveAccountingReport(body);
    Promise.resolve(call)
      .then((r) => {
        setOpened({ id: r?.id || opened?.id, name: r?.name || n, mine: true, shared: r ? !!r.shared : shared, published: r ? isPublished(r) : published });
        setSaveNote(action === 'save' && published ? 'Saved.' : NOTES[action]);
      })
      .catch((e) => setError(e?.message || 'Could not save the report.'))
      .finally(() => setSaving(''));
  };
  const startNew = () => { setConfig(defaultBuilder()); setName(''); setOpened(null); setResult(null); setSaveNote(''); setError(''); setConfirmDelete(false); };
  // Only the author deletes a saved report (the backend checks the same).
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = () => {
    if (!opened?.mine || saving) return;
    setSaving('delete');
    Promise.resolve(api.deleteAccountingSavedReport(opened.id))
      .then(() => { startNew(); setSaveNote('Deleted.'); })
      .catch((e) => setError(e?.message || 'Could not delete the report.'))
      .finally(() => { setSaving(''); setConfirmDelete(false); });
  };

  // Exports: the same Excel, CSV and PDF writers as every statement.
  const [busy, setBusy] = useState('');
  const title = name.trim() || opened?.name || 'Custom Report';
  const shown = result ? { ...result, def: { ...result.def, label: title } } : null;
  const exportAs = async (format) => {
    if (!shown || busy) return;
    setBusy(format);
    try {
      if (format === 'csv') downloadCsv(csvFileName(shown), csvRows(shown, entities));
      if (format === 'excel') {
        const { buildStatementWorkbook } = await import('./reportExcel');
        const bytes = await buildStatementWorkbook({ title, result: shown, entities });
        downloadBlob(csvFileName(shown).replace(/\.csv$/, '.xlsx'), new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      }
      if (format === 'pdf') {
        const { buildPackagePdf } = await import('./reportPdf');
        const bytes = await buildPackagePdf({ name: title, statements: [{ title, result: shown, entities }], cover: false });
        downloadBlob(csvFileName(shown).replace(/\.csv$/, '.pdf'), new Blob([bytes], { type: 'application/pdf' }));
      }
    } catch (e) {
      setError(e?.message || 'Could not export the report.');
    } finally {
      setBusy('');
    }
  };

  const books = bookOptions({ report: 'general-ledger' });
  const picked = includedAccounts(config).length;
  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
  const select = (active) => ({ ...control, fontWeight: active ? 600 : 400, color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', borderColor: active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)', maxWidth: 260 });
  const small = { fontSize: '0.76rem', height: 30, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6 };
  const iconBtn = { border: 'none', background: 'none', padding: 4, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };

  // Folded groups hide their accounts; the group row keeps its total.
  const visible = (shown?.rows || []).filter((r) => !(r.kind === 'account' && r.section && collapsed.has(r.section)));
  const toggle = (key) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 }}>
      {/* What the report reads: period, columns, book, entities, filters, accounts. */}
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <select value={config.period} onChange={(e) => patch({ period: e.target.value })} aria-label="Period Type" style={select(false)}>
          {BUILDER_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <PeriodStepper config={config} period={config.period} onChange={patch} />
        {config.period === 'range' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Columns
            <select value={config.cols} onChange={(e) => patch({ cols: e.target.value })} aria-label="Columns" style={select(config.cols !== 'total')}>
              {BUILDER_COLUMNS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
        )}
        <span role="group" aria-label="Compare" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
          Compare
          {BUILDER_COMPARE_OPTIONS.map((o) => (
            <label key={o.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={config.compare.includes(o.key)}
                onChange={(e) => patch({ compare: e.target.checked ? [...config.compare, o.key] : config.compare.filter((k) => k !== o.key) })} /> {o.label}
            </label>
          ))}
        </span>
        <select value={config.book} onChange={(e) => patch({ book: e.target.value })} aria-label="Book" style={select(config.book !== 'accrual')}>
          {books.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        <FiltersButton dims={config.dims} onChange={(dims) => patch({ dims })} showHistorical={!!prefs.showHistoricalAccounts} kinds={kinds} />
        <AccountsPicker accounts={chart || []} value={config.accounts} onChange={(accounts) => patch({ accounts })} showHistorical={!!prefs.showHistoricalAccounts}
          allLabel={groups.some((g) => g.accounts.length) ? 'No other accounts' : 'All accounts'} ariaLabel="GL Accounts" />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={config.showZero} onChange={(e) => patch({ showZero: e.target.checked })} /> Show zero balances
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="primary-btn" onClick={() => run()} disabled={running} style={small}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Run
          </button>
          <ExportMenu disabled={!shown} items={[
            { key: 'excel', label: 'Excel', hint: 'Group totals as live formulas, columns fitted', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Laid out like a page of a package', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
          ]} />
        </div>
      </div>

      {/* Row groups (item 11): named lines, each the total of the accounts mapped to it. */}
      <div style={{ ...card, padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setGroupsOpen((v) => !v)} aria-expanded={groupsOpen}
            style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontWeight: 600, fontSize: '0.86rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-primary)' }}>
            {groupsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Row Groups{groups.length ? ` (${groups.length})` : ''}
          </button>
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', flex: '1 1 260px' }}>
            Optional. Name a line and map GL accounts to it; the report shows its total with the accounts underneath. Accounts in no group are listed one by one.
          </span>
          <button type="button" className="secondary-btn" onClick={() => { setGroupsOpen(true); addGroup(); }} style={small}><Plus size={14} /> Add Row Group</button>
        </div>
        {groupsOpen && groups.length > 0 && (
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            {groups.map((g, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ width: 22, textAlign: 'right', fontSize: '0.74rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}.</span>
                <input type="text" value={g.name} maxLength={120} onChange={(e) => renameGroup(i, e.target.value)} aria-label={`Row group ${i + 1} name`}
                  placeholder="Line name, e.g. Advertising" style={{ ...control, flex: '1 1 220px', maxWidth: 360 }} />
                <AccountsPicker accounts={chart || []} value={g.accounts} onChange={(accounts) => groupAccounts(i, accounts)} showHistorical={!!prefs.showHistoricalAccounts}
                  allLabel="No accounts yet" ariaLabel={`Row group ${i + 1} accounts`} />
                <button type="button" style={iconBtn} onClick={() => moveGroup(i, -1)} disabled={i === 0} aria-label={`Move row group ${i + 1} up`} title="Move up"><ArrowUp size={14} /></button>
                <button type="button" style={iconBtn} onClick={() => moveGroup(i, 1)} disabled={i === groups.length - 1} aria-label={`Move row group ${i + 1} down`} title="Move down"><ArrowDown size={14} /></button>
                <button type="button" style={iconBtn} onClick={() => removeGroup(i)} aria-label={`Remove row group ${i + 1}`} title="Remove"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
        {chartError && <div role="alert" style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>{chartError}</div>}
      </div>

      {/* Name it, then Save (private) or Publish (the accounting team). */}
      <div style={{ ...card, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Report name" placeholder="Name this report"
          style={{ ...control, flex: '1 1 260px', maxWidth: 420 }} />
        <button type="button" className="secondary-btn" onClick={() => save('save')} disabled={!name.trim() || !!saving} style={small}>
          {saving === 'save' ? 'Saving...' : opened?.mine ? 'Save Changes' : 'Save'}
        </button>
        {canPublish && !(opened?.mine && opened.published) && (
          <button type="button" className="primary-btn" onClick={() => save('publish')} disabled={!name.trim() || !!saving} style={small}>
            <Send size={14} /> {saving === 'publish' ? 'Publishing...' : 'Publish'}
          </button>
        )}
        {canPublish && opened?.mine && opened.published && !opened.shared && (
          <button type="button" className="primary-btn" onClick={() => save('share')} disabled={!name.trim() || !!saving} style={small}>
            <Users size={14} /> {saving === 'share' ? 'Sharing...' : 'Share With Everyone'}
          </button>
        )}
        {canPublish && opened?.mine && opened.published && opened.shared && (
          <button type="button" className="secondary-btn" onClick={() => save('unshare')} disabled={!name.trim() || !!saving} style={small}>Stop Sharing</button>
        )}
        {canPublish && opened?.mine && opened.published && (
          <button type="button" className="secondary-btn" onClick={() => save('unpublish')} disabled={!name.trim() || !!saving} style={small}>Unpublish</button>
        )}
        <button type="button" className="secondary-btn" onClick={startNew} style={small}><FilePlus2 size={14} /> New</button>
        {opened?.mine && (confirmDelete ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem' }}>
            Delete {opened.name}?
            <button type="button" className="secondary-btn" onClick={remove} disabled={!!saving} style={{ ...small, color: 'var(--bad-fg, #dc2626)' }}>Delete</button>
            <button type="button" className="secondary-btn" onClick={() => setConfirmDelete(false)} style={small}>Keep</button>
          </span>
        ) : (
          <button type="button" style={iconBtn} onClick={() => setConfirmDelete(true)} aria-label={`Delete ${opened.name}`} title="Delete this saved report"><Trash2 size={14} /></button>
        ))}
        <span role="status" style={{ fontSize: '0.76rem', color: saveNote ? 'var(--ok-fg, #15803d)' : 'var(--text-muted)' }}>
          {saveNote || (opened
            ? `${opened.mine ? '' : 'Shared by a teammate - Save keeps your own copy. '}${opened.shared ? 'Published and shared with everyone.' : opened.published ? 'Published - only you see it.' : 'Draft - only you see it.'}`
            : 'Saved reports appear in the Report Center.')}
        </span>
        {saveNote && <button type="button" style={iconBtn} onClick={() => setSaveNote('')} aria-label="Dismiss"><X size={13} /></button>}
      </div>

      {error && <div role="alert" style={{ ...card, padding: 12, color: 'var(--bad-fg, #dc2626)', borderColor: 'var(--bad-fg, #dc2626)', fontSize: '0.86rem' }}>{error}</div>}
      {running && !shown && <div role="status" aria-label="Running the report" style={{ ...card, padding: 12 }}><SkeletonBlocks count={4} /></div>}
      {!running && !shown && !error && (
        <div style={{ ...card, padding: 22, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>
          {chart === null ? 'Loading the GL accounts...' : `Pick the accounts, filters and period, then Run. ${picked ? `${picked} ${picked === 1 ? 'account' : 'accounts'} picked.` : 'Nothing picked runs every account.'}`}
        </div>
      )}

      {shown && (
        <div style={{ ...card, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <h3 style={{ fontSize: '0.98rem', margin: 0 }}>{title}</h3>
            <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
              {[shown.org, entityText(shown.config, entities), periodText(shown.config), `${books.find((b) => b.key === shown.builder.book)?.label || 'Accrual'} Book`,
                shown.builder.cols !== 'total' ? BUILDER_COLUMNS.find((m) => m.key === shown.builder.cols)?.label : ''].filter(Boolean).join(' · ')}
              {running ? ' · updating' : stale ? ' · the controls changed - Run to update' : ''}
            </span>
          </div>
          <div className="acct-report-wrap" style={{ opacity: running ? 0.6 : 1 }}>
            <table className="acct-report">
              <thead>
                <tr>
                  <th className="acct-label acct-head" style={{ position: 'sticky' }}>Account</th>
                  {shown.columns.map((c) => <th key={c.key} className="acct-num" title={c.hint} style={c.emphasis || c.compare ? EMPHASIS : undefined}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const cells = shown.columns.map((c, k) => (
                    <td key={c.key} className="acct-num" style={c.emphasis || c.compare ? EMPHASIS : undefined}>
                      {typeof r.values[k] === 'number' ? <Amount value={r.values[k]} zero="dash" /> : r.values[k] || null}
                    </td>
                  ));
                  if (r.kind === 'section') {
                    const open = !collapsed.has(r.section);
                    return (
                      <tr key={`s-${r.section}`} className="acct-section" onClick={() => toggle(r.section)} title={open ? 'Click to fold' : 'Click to open'}>
                        <td className="acct-label">
                          <button type="button" className="acct-fold" aria-expanded={open} aria-label={`${open ? 'Fold' : 'Open'} ${r.label}`} onClick={(e) => { e.stopPropagation(); toggle(r.section); }}>
                            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                          {r.label}<span className="acct-count">{r.count}</span>
                        </td>
                        {cells}
                      </tr>
                    );
                  }
                  if (r.kind === 'group') return <tr key={`g-${i}`} className="acct-section acct-group"><td className="acct-label">{r.label}</td>{shown.columns.map((c) => <td key={c.key} />)}</tr>;
                  if (r.kind === 'account') {
                    return (
                      <tr key={`a-${r.section || ''}-${r.code}`}>
                        <td className={`acct-label${r.section ? ' acct-indent' : ''}`} title={`${r.code} ${r.title}`}><span className="acct-code">{r.code}</span><span>{r.title}</span></td>
                        {cells}
                      </tr>
                    );
                  }
                  return <tr key={`t-${i}`} className="acct-grand"><td className="acct-label">{r.label}</td>{cells}</tr>;
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 6, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            Generated {formatDate(shown.generatedAt)} from the Nexus Accounting ledger. Each account is in its normal balance - income, liabilities and equity as credits less debits, everything else as debits less credits - and a group or grand total adds those up as shown.
            {config.period === 'asof' ? ' As of a date, balance sheet accounts are their balance on that date and income and expense accounts their year to date.' : ''}
            {shown.builder.compare.length ? ` Variances are the ${shown.builder.cols === 'total' ? 'period' : 'Total column'} less the comparison; Variance % is that over the comparison.` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

const EMPHASIS = { fontWeight: 700, borderLeft: '2px solid var(--border-color)' };
