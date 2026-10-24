import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../api';
import LedgerSearch from './LedgerSearch';
import { ControlBar, EntitiesPicker, ExportMenu, FiltersButton, PeriodStepper, SyncButton, control } from './reportControls';
import { EMPTY_DIMS, POPOVER_DIMS, downloadBlob, resolveConfig } from './reportModel';
import { linesFile } from './linesExport';
import { useAccountingPrefs } from './prefs';
import { JOURNAL_PAGE_DEFAULT_PRESET } from './assumptions';

// Accounting -> Records -> Journals -> <symbol> (Charmi, 10/22 call and her
// edited Teams post; Neil, 23 Oct: "Each journal page should allow us to view
// the transactions of that journal and have all standard filters and search
// functionality and resizable columns etc."). One journal's lines: the
// period, entities and Filters of every report, a search box, and below them
// the ledger lines grid the General Ledger drills into (LedgerSearch) -
// column filters and operators, resizable and hideable columns, the facets,
// paging, the entry on a click, and Export. The journals listed are
// RECORDS_JOURNALS in ./assumptions.js.

export default function JournalTab({ symbol }) {
  const [prefs] = useAccountingPrefs();
  const [config, setConfig] = useState(() => resolveConfig({ report: 'general-ledger', preset: JOURNAL_PAGE_DEFAULT_PRESET }));
  const patch = (p) => setConfig((c) => resolveConfig({ ...c, ...p }));
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [title, setTitle] = useState('');
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(typed.trim().length >= 2 ? typed.trim() : ''), 400); return () => clearTimeout(t); }, [typed]);
  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) { setEntities(d?.entities || []); setLimited(!!d?.limited); } }).catch(() => {});
    api.getAccountingJournals?.()?.then((d) => { if (alive) setTitle((d?.journals || []).find((j) => j.symbol === symbol)?.title || ''); })?.catch?.(() => {});
    return () => { alive = false; };
  }, [symbol]);
  // The journal is a filter like any other (its chip can be lifted to compare).
  const kinds = useMemo(() => POPOVER_DIMS.filter((k) => k.key !== 'journals'), []);
  const drill = useMemo(() => ({ from: config.from, to: config.to, account: '', accountName: `${symbol} journal`, book: 'accrual', dims: { journals: [symbol] } }), [config.from, config.to, symbol]);
  const dims = useMemo(() => ({ ...EMPTY_DIMS, ...config.dims, journals: [] }), [config.dims]);
  const entityName = !config.entities.length ? 'All entities' : config.entities.length > 1 ? `${config.entities.length} entities` : config.entities[0];

  const [lines, setLines] = useState(null);
  // 10/23 meeting, item 13: Sync reads this journal's lines again, nothing else.
  const [syncTick, setSyncTick] = useState(0);
  const [syncedAt, setSyncedAt] = useState(null);
  const [linesBusy, setLinesBusy] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const exportAs = async (format) => {
    if (!lines || busy) return;
    setBusy(format);
    try {
      const file = await linesFile(await lines.build(), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setError(e?.message || 'Could not export the lines.');
    } finally {
      setBusy('');
    }
  };

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <strong style={{ fontSize: '0.9rem' }}>{symbol}{title ? ` - ${title}` : ''}</strong>
        <PeriodStepper config={config} period="range" onChange={patch} />
        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        <FiltersButton dims={config.dims} onChange={(d) => patch({ dims: d })} showHistorical={!!prefs.showHistoricalAccounts} kinds={kinds} />
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
          <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Search the ${symbol} journal`}
            placeholder="Search vendor, customer, memo, amount..." style={{ ...control, width: '100%', paddingLeft: 28 }} />
        </div>
        <div className="acct-bar-end">
          <SyncButton onSync={() => { setSyncTick((n) => n + 1); setSyncedAt(new Date()); }} busy={linesBusy && syncTick > 0} syncedAt={syncedAt} />
          <ExportMenu disabled={!lines} items={[
            { key: 'excel', label: 'Excel', hint: 'Every line, columns as on screen, live totals', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
          ]} />
        </div>
      </ControlBar>
      {error && <div role="alert" style={{ ...card, padding: 12, color: 'var(--bad-fg, #dc2626)', fontSize: '0.84rem' }}>{error}</div>}
      <LedgerSearch key={symbol} term={term} entities={config.entities} entityName={entityName} drill={drill} onClearDrill={() => {}}
        dims={dims} onExport={setLines} onBusy={setLinesBusy} syncTick={syncTick} />
    </div>
  );
}
