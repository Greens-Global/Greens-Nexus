import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import { SkeletonBlocks } from '../../AsyncState';
import { FS } from '../../../lib/typeScale';
import { formatDate } from '../../../lib/datetime';
import Amount from '../Amount';
import { ColumnResizer } from '../reportControls';
import { useColumnWidths } from '../tableHooks';
import StructureChart from './StructureChart';
import { wholeGraph } from './structureModel';

// Accounting > Entities (Neil, 11/17/2026, plan https://claude.ai/artifact/JZmUfATX7NvH2Qq4kAkJb1).
// The list: one row per legal entity with its locations folded under it -
// the legal record (type, where and when formed, status), who owns it, its
// deal in Investor Relations and its live cash, liabilities and book equity.
// Structure draws the same entities as one legal structure chart, from the
// top owners down. A row or a shape opens the entity (`entity-<code>`).

export const ENTITY_SUB = 'entity-';
const STATUS_WORDS = { active: 'Active', inactive: 'Inactive', dissolved: 'Dissolved', sold: 'Sold' };
const COLS = [
  { key: 'code', label: 'Entity', width: 100 },
  { key: 'name', label: 'Legal Name', width: 260 },
  { key: 'type', label: 'Type', width: 230 },
  { key: 'formed', label: 'Formed', width: 130 },
  { key: 'owned', label: 'Owned By', width: 200 },
  { key: 'deal', label: 'Deal', width: 150 },
  { key: 'cash', label: 'Cash', width: 130, num: true },
  { key: 'liabilities', label: 'Liabilities', width: 140, num: true },
  { key: 'equity', label: 'Book Equity', width: 140, num: true },
];

const matches = (r, words) => {
  if (!words.length) return true;
  const hay = [r.code, r.name, r.booksName, r.legalName, r.typeLine, r.formedState, r.einLast4, r.ownedBy, r.deal?.name, STATUS_WORDS[r.status]].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
};

export default function EntitiesTab({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [graph, setGraph] = useState(null);
  const [figures, setFigures] = useState({});
  const [q, setQ] = useState('');
  const [view, setView] = useState('list');
  const [showLocations, setShowLocations] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [top, setTop] = useState('');
  const cols = useColumnWidths('entities-list', Object.fromEntries(COLS.map((c) => [c.key, c.width])), { min: 70 });

  useEffect(() => {
    let alive = true;
    api.getLegalEntities().then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(e?.message || 'Could not read the entities.'); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (view !== 'structure' || graph) return undefined;
    let alive = true;
    api.getLegalEntityStructure().then((g) => { if (alive) setGraph(g); }).catch((e) => { if (alive) setGraph({ nodes: [], edges: [], error: e?.message || 'Could not read the structure.' }); });
    return () => { alive = false; };
  }, [view, graph]);

  const rows = useMemo(() => data?.entities || [], [data]);
  const legal = useMemo(() => rows.filter((r) => r.kind === 'entity'), [rows]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    const ended = (r) => ['dissolved', 'sold'].includes(r.status);
    const keep = legal.filter((r) => (showEnded || !ended(r)) && matches(r, words));
    const locs = rows.filter((r) => r.kind === 'location');
    const out = [];
    keep.forEach((r) => {
      out.push(r);
      if (showLocations) locs.filter((l) => l.parentCode === r.code).forEach((l) => out.push(l));
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legal, rows, showLocations, showEnded, q]);

  // Live figures for the entities on screen, a few at a time (one cached read each).
  const wanted = useMemo(() => shown.filter((r) => r.kind === 'entity').map((r) => r.code).filter((c) => !(c in figures)).slice(0, 40), [shown, figures]);
  useEffect(() => {
    if (view !== 'list' || !wanted.length) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      setFigures((f) => ({ ...f, ...Object.fromEntries(wanted.map((c) => [c, f[c] || null])) }));
      api.getLegalEntityFigures(wanted)
        .then((d) => { if (alive) setFigures((f) => ({ ...f, ...(d?.figures || {}) })); })
        .catch(() => { if (alive) setFigures((f) => ({ ...f, ...Object.fromEntries(wanted.map((c) => [c, { error: 'Not read' }])) })); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [wanted, view]);

  const chart = useMemo(() => {
    if (!graph?.nodes) return null;
    return wholeGraph(graph, { tops: top ? [`e:${top}`] : null, properties: true });
  }, [graph, top]);

  if (error) return <p role="alert" style={{ color: 'var(--danger, #dc2626)', fontSize: FS.body }}>{error}</p>;
  if (!data) return <SkeletonBlocks count={4} />;

  const ended = legal.filter((r) => ['dissolved', 'sold'].includes(r.status)).length;
  const deals = legal.filter((r) => r.deal).length;
  const notRecorded = legal.filter((r) => !r.recorded).length;
  const locCount = rows.length - legal.length;
  const open = (code) => onOpen?.(code);

  return (
    <div className="ent-page">
      <div className="ent-toolbar">
        <input className="form-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, entity, state, EIN ending"
          aria-label="Search entities" style={{ maxWidth: 300 }} />
        <div className="ent-seg" role="group" aria-label="Show as">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          <button type="button" aria-pressed={view === 'structure'} onClick={() => setView('structure')}>Structure</button>
        </div>
        {view === 'list' ? (
          <>
            <label className="ent-check"><input type="checkbox" checked={showLocations} onChange={(e) => setShowLocations(e.target.checked)} /> Show Locations</label>
            {ended > 0 && <label className="ent-check"><input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show Dissolved and Sold</label>}
          </>
        ) : (
          <label className="ent-check">Start From
            <select className="form-input" value={top} onChange={(e) => setTop(e.target.value)} style={{ marginLeft: 8, width: 'auto', maxWidth: 260 }}>
              <option value="">Every entity</option>
              {legal.map((r) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="ent-summary">
        {legal.length} legal {legal.length === 1 ? 'entity' : 'entities'}
        {locCount > 0 && ` with ${locCount} ${locCount === 1 ? 'location' : 'locations'} under them`}
        {deals > 0 && ` - ${deals} ${deals === 1 ? 'is a deal' : 'are deals'} in Investor Relations`}
        {notRecorded > 0 && ` - ${notRecorded} without a legal record yet`}
        {data.limited && ' - only the entities your accounting access includes'}
      </p>

      {view === 'list' ? (
        <div className="ent-table-wrap">
          <table className="ent-table" style={{ minWidth: COLS.reduce((s, c) => s + cols.width(c.key), 0) }}>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} scope="col" className={c.num ? 'acct-num' : undefined} style={{ width: cols.width(c.key) }}>
                    {c.label}<ColumnResizer {...cols.resizer(c.key, c.label)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const f = figures[r.code];
                const loc = r.kind === 'location';
                const endedRow = ['dissolved', 'sold'].includes(r.status);
                return (
                  <tr key={r.code} className={loc ? 'ent-loc' : undefined} tabIndex={0} onClick={() => open(r.code)}
                    onKeyDown={(e) => { if (e.key === 'Enter') open(r.code); }} aria-label={`Open ${r.name}`}>
                    <td>{r.code}</td>
                    <td>
                      {loc ? <span className="ent-muted">Location of {r.parentCode}</span> : r.name}
                      {loc && r.name && <span className="ent-muted"> - {r.name}</span>}
                      {endedRow && <span style={{ color: 'var(--text-secondary)' }}> - {STATUS_WORDS[r.status]}</span>}
                    </td>
                    <td className="ent-muted">{loc ? '' : r.typeLine || 'Not set yet'}</td>
                    <td>{[r.formedState, r.formedOn ? formatDate(r.formedOn) : ''].filter(Boolean).join(' ')}</td>
                    <td>{r.ownedBy}</td>
                    <td>{r.deal ? <span className="ent-green">{r.deal.name}</span> : ''}</td>
                    {['cash', 'liabilities', 'bookEquity'].map((k) => (
                      <td key={k} className="acct-num">
                        {loc ? '' : f === undefined ? '' : f === null ? <span className="ent-muted">...</span> : f.error ? <span className="ent-muted" title={f.error}>Not read</span> : <Amount value={f[k]} zero="dash" />}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={COLS.length} className="ent-muted" style={{ padding: 16 }}>No entity matches that search.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : !graph ? <SkeletonBlocks count={3} /> : graph.error ? <p role="alert" className="ent-muted">{graph.error}</p> : (
        <>
          <p className="ent-muted" style={{ fontSize: FS.body, margin: '0 0 8px' }}>
            Owners above what they own, the membership or ownership percentage on each line. Dashed lines are management agreements.
            {!graph.seesInvestors && ' Investor names need Investor Relations access, so a deal\'s members are counted together.'}
          </p>
          <StructureChart graph={chart} title="Structure of every entity" fileName={top ? `structure-${top}` : 'structure'}
            onOpen={(n) => {
              if (n.kind === 'entity') open(n.code);
              else if (n.kind === 'property') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'property-asset', sub: `a:${encodeURIComponent(n.assetId)}:property` } }));
            }}
            empty={<p className="ent-muted">No ownership is recorded yet. Open an entity and add its owners, or link its deal in Investor Relations.</p>} />
          {chart?.loose?.length > 0 && (
            <p className="ent-muted" style={{ fontSize: FS.body, marginTop: 12 }}>
              No owners recorded yet: {chart.loose.map((n, i) => (
                <span key={n.id}>{i > 0 && ', '}<button type="button" className="ent-link" onClick={() => open(n.code)}>{n.label}</button></span>
              ))}
            </p>
          )}
        </>
      )}
    </div>
  );
}
