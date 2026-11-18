import { useState, useEffect, useRef, Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import { cityRegion, typeIcon } from '../../lib/portfolioCards.js';
import { COLUMN_OPTIONS, DEFAULT_COLUMNS, measuresOf, fmtInt, fmtAcres, stageInk } from '../../lib/portfolioQuery.js';

// The Properties register as a list (Neil, 11/17/2026 - List is the default view). Flat and
// hairline: Title Case headers, numbers right-aligned and tabular, a stage as colored text,
// "Not set" faint. A parcel group is ONE row whose numbers SUM its parcels (the old list showed
// the lead's alone while the card summed - they disagreed); the chevron opens its parcels.
// Columns resize (kept per browser); a header that sorts says so (aria-sort).

const NUMERIC = new Set(['acres', 'sf', 'units', 'occupied']);
const LABEL = Object.fromEntries(COLUMN_OPTIONS);
const DEFAULT_W = { property: 300, type: 130, stage: 150, owner: 190, manager: 150, company: 170, acres: 84, sf: 110, units: 84, occupied: 92 };
const MIN_W = { property: 200 };
const SORTS = { property: 'name', acres: 'acres', sf: 'sf', units: 'units', stage: 'stage' };
const COLW_KEY = 'nexus_asset_list_colw_v2';

const readWidths = () => { try { return { ...DEFAULT_W, ...(JSON.parse(localStorage.getItem(COLW_KEY) || 'null') || {}) }; } catch { return { ...DEFAULT_W }; } };

const Faint = ({ children = '-' }) => <span className="pt-faint">{children}</span>;

function cellValue(col, asset, f, m) {
  switch (col) {
    case 'type': return f?.type || <Faint />;
    case 'stage': return asset.devStage ? <span style={{ color: stageInk(asset.devStage), fontWeight: 500 }}>{asset.devStage}</span> : <Faint />;
    case 'owner': return asset.entity ? asset.entity : <Faint />;
    case 'manager': return String(asset.manager || '').trim() ? (f?.managerName || asset.manager) : <Faint>Not set</Faint>;
    case 'company': return f?.companyName || <Faint />;
    case 'acres': return m.acres ? fmtAcres(m.acres) : <Faint />;
    case 'sf': return m.sf ? fmtInt(m.sf) : <Faint />;
    case 'units': return m.units ? fmtInt(m.units) : <Faint />;
    case 'occupied': return typeof f?.occupancy === 'number' ? `${Math.round(f.occupancy * 100)}%` : <Faint />;
    default: return null;
  }
}
const titleOf = (asset, f, col) => {
  if (col === 'owner') return asset.entity || '';
  if (col === 'manager') return asset.manager || '';
  if (col === 'company') return f?.companyName || '';
  return '';
};

/**
 * groups:   [{ key, label, rows, sums }] from portfolioQuery.groupRows (one unlabeled group = no grouping)
 * ctx:      the query context (per-row facts); columns: visible column keys
 * selected: Set of ids; onToggle(id), onToggleMany(ids, on); sort / onSort(key) for the headers
 */
export function ListTable({ groups, ctx, columns = DEFAULT_COLUMNS, open, selected, onToggle, onToggleMany, sort = 'name', onSort, lastOpenedId = null, childrenOf }) {
  const [expanded, setExpanded] = useState({});
  const [widths, setWidths] = useState(readWidths);
  useEffect(() => { try { localStorage.setItem(COLW_KEY, JSON.stringify(widths)); } catch { /* not kept this session */ } }, [widths]);
  const drag = useRef(null);
  const cols = COLUMN_OPTIONS.map(([k]) => k).filter((k) => columns.includes(k));
  const textCols = cols.filter((k) => !NUMERIC.has(k));
  const numCols = cols.filter((k) => NUMERIC.has(k));
  const ordered = [...textCols, ...numCols];
  const allIds = groups.flatMap((g) => g.rows.map((a) => a.id));
  const allOn = allIds.length > 0 && allIds.every((id) => selected?.has(id));
  const someOn = allIds.some((id) => selected?.has(id));
  const grouped = groups.length > 1 || (groups[0] && groups[0].label);

  const onResizeDown = (col, ev) => {
    ev.preventDefault(); ev.stopPropagation();
    drag.current = { col, x: ev.clientX, w: widths[col], moved: false };
    const move = (e) => {
      const d = drag.current; if (!d) return;
      if (Math.abs(e.clientX - d.x) > 2) d.moved = true;
      setWidths((w) => ({ ...w, [d.col]: Math.max(MIN_W[d.col] || 64, d.w + e.clientX - d.x) }));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setTimeout(() => { drag.current = null; }, 0); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  const header = (col) => {
    const sortKey = SORTS[col];
    const on = sortKey && sort === sortKey;
    const label = col === 'property' ? 'Property' : LABEL[col];
    return (
      <th key={col} scope="col" aria-sort={on ? (sortKey === 'name' || sortKey === 'stage' ? 'ascending' : 'descending') : undefined}
        className={NUMERIC.has(col) ? 'is-num' : undefined} style={{ width: widths[col] }}>
        {sortKey && onSort ? (
          <button type="button" className="pt-th-btn" onClick={() => { if (!drag.current?.moved) onSort(sortKey); }} title={`Sort by ${label}`}>
            {label}
          </button>
        ) : <span className="pt-th-btn is-static">{label}</span>}
        <span className="pt-col-resize" aria-hidden="true" onMouseDown={(e) => onResizeDown(col, e)} onClick={(e) => e.stopPropagation()} />
      </th>
    );
  };

  const row = (asset, { child = false } = {}) => {
    const f = ctx.byId[asset.id];
    const m = child ? measuresOf(asset, []) : (f?.measures || measuresOf(asset, []));
    const kids = child ? [] : (childrenOf ? childrenOf(asset.id) : []);
    const photo = (asset.images && asset.images[0]) || asset.image || '';
    const Icon = typeIcon(asset);
    const isOn = !child && selected?.has(asset.id);
    const name = (!child && kids.length && asset.siteName) || asset.name || asset.siteName || 'Unnamed property';
    const meta = [child ? 'Linked parcel' : cityRegion(asset), kids.length ? `${kids.length + 1} parcels` : ''].filter(Boolean).join(' · ');
    const openIt = () => open(asset.id);
    return (
      <tr key={(child ? 'c' : 'r') + asset.id} tabIndex={0} aria-selected={isOn || undefined}
        className={`pt-row${child ? ' is-child' : ''}${isOn ? ' is-on' : ''}${asset.id === lastOpenedId ? ' is-last' : ''}`}
        onClick={openIt} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openIt(); }}>
        <td className="pt-cell-property">
          <div className="pt-prop">
            {child ? <span className="pt-check-space" /> : (
              <label className="pt-check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={!!isOn} onChange={() => onToggle?.(asset.id)} aria-label={`Select ${name}`} />
              </label>
            )}
            {kids.length ? (
              <button type="button" className="pt-expand" aria-expanded={!!expanded[asset.id]} aria-label={`${expanded[asset.id] ? 'Hide' : 'Show'} the parcels of ${name}`}
                onClick={(e) => { e.stopPropagation(); setExpanded((s) => ({ ...s, [asset.id]: !s[asset.id] })); }}>
                <ChevronRight size={14} style={{ transform: expanded[asset.id] ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
              </button>
            ) : <span className="pt-expand-space" />}
            <span className={`pt-thumb${photo ? '' : ' is-empty'}`} aria-hidden="true">
              {photo ? <img src={photo} alt="" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <Icon size={16} strokeWidth={1.6} />}
            </span>
            <span className="pt-prop-words">
              <span className="pt-prop-name" title={name}>{name}</span>
              {meta && <span className="pt-prop-meta">{meta}</span>}
            </span>
          </div>
        </td>
        {ordered.map((col) => (
          <td key={col} className={NUMERIC.has(col) ? 'is-num' : undefined} title={titleOf(asset, f, col) || undefined}>
            {child && (col === 'occupied') ? <Faint /> : cellValue(col, asset, f, m)}
          </td>
        ))}
      </tr>
    );
  };

  const sumCell = (col, sums) => {
    if (col === 'acres') return sums.acres ? fmtAcres(sums.acres) : '';
    if (col === 'sf') return sums.sf ? fmtInt(sums.sf) : '';
    if (col === 'units') return sums.units ? fmtInt(sums.units) : '';
    return '';
  };

  return (
    <div className="pt-list-wrap">
      <table className="pt-list" aria-label="Properties">
        <colgroup>
          <col style={{ width: widths.property }} />
          {ordered.map((c) => <col key={c} style={{ width: widths[c] }} />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" style={{ width: widths.property }} aria-sort={sort === 'name' ? 'ascending' : undefined}>
              <div className="pt-prop">
                <label className="pt-check">
                  <input type="checkbox" checked={allOn} aria-label={allOn ? 'Clear the selection' : 'Select every property shown'}
                    ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
                    onChange={() => onToggleMany?.(allIds, !allOn)} />
                </label>
                <span className="pt-expand-space" />
                <button type="button" className="pt-th-btn" onClick={() => onSort?.('name')} title="Sort by Name">Property</button>
              </div>
              <span className="pt-col-resize" aria-hidden="true" onMouseDown={(e) => onResizeDown('property', e)} />
            </th>
            {ordered.map(header)}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            {grouped && (
              <tr className="pt-group-row">
                <th scope="rowgroup" colSpan={1 + textCols.length}>
                  <span className="pt-group-name">{g.label}</span>
                  <span className="pt-group-count">{g.rows.length} {g.rows.length === 1 ? 'property' : 'properties'}</span>
                </th>
                {numCols.map((c) => <td key={c} className="is-num">{sumCell(c, g.sums)}</td>)}
              </tr>
            )}
            {g.rows.map((asset) => (
              <Fragment key={asset.id}>
                {row(asset)}
                {expanded[asset.id] ? (childrenOf ? childrenOf(asset.id) : []).map((kid) => row(kid, { child: true })) : null}
              </Fragment>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
