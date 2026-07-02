import { useState, useEffect, useRef, Fragment } from 'react';
import { ChevronDown, Link2 } from 'lucide-react';
import { cityRegion, typeLabel, tileStats, typeIcon, deriveCategory, stageTone } from '../../lib/portfolioCards.js';

const COLUMNS = ['Asset', 'Type', 'Location', 'Stage', 'Owner', 'Asset Manager', 'Size'];
const DEFAULT_WIDTHS = [300, 110, 110, 110, 140, 140, 100];
const MIN_WIDTHS = [180, 80, 80, 80, 90, 90, 80];
const COLW_STORAGE_KEY = 'nexus_list_colw_v1';

// Category -> row icon-badge color. Distinct from (and simpler than) StatusBadge's tone system —
// this colors the per-row leading icon by CATEGORY, not by stage.
const CATEGORY_COLOR = { Commercial: 'blue', Residential: 'green', Industrial: 'orange', Vehicles: 'purple', 'Heavy Equipment': 'gold' };

/** Numeric-aware comparator: compares as numbers if BOTH sides parse as one and BOTH contain a
 *  digit, otherwise falls back to locale string comparison. Powers every column's sort. */
function compareValues(a, b) {
  const an = parseFloat(String(a ?? '').replace(/[^0-9.-]/g, ''));
  const bn = parseFloat(String(b ?? '').replace(/[^0-9.-]/g, ''));
  if (!isNaN(an) && !isNaN(bn) && /\d/.test(String(a)) && /\d/.test(String(b))) return an - bn;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

// Per-column sort-key accessors, in COLUMNS order. "Size" sorts by the value of whichever stat
// tileStats() puts first for that asset (its most prominent metric) — the same value shown in
// the Size column itself, so what you see is what you sort by.
const COLUMN_ACCESSORS = [
  (p) => p.name || '',
  (p) => typeLabel(p) || '',
  (p) => cityRegion(p) || '',
  (p) => p.devStage || 'Active',
  (p) => p.entity || '',
  (p) => p.manager || '',
  (p) => { const stats = tileStats(p).filter((x) => x.v && x.v !== '—'); return stats[0] ? stats[0].v : ''; },
];

const thStyle = {
  textAlign: 'left', fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)', padding: '11px 16px', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis', borderBottom: '1px solid var(--border-color)',
  backgroundColor: 'var(--bg-secondary)',
};
const tdStyle = { padding: '10px 16px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'middle', overflow: 'hidden' };

/** Plain-text cell: ellipsis-truncates, shows the full value on hover via `title`, "—" if empty. */
function Cell({ value, dataLabel }) {
  const display = (value ?? '') === '' ? '—' : value;
  return (
    <span
      title={(value ?? '') === '' ? '' : String(value)}
      data-label={dataLabel}
      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', fontSize: '0.82rem', color: 'var(--text-primary)' }}
    >
      {display}
    </span>
  );
}

/** Stage chip cell — same visual language as the tile/list-row stage chip. */
function StageChip({ devStage }) {
  const stage = devStage || 'Active';
  const tone = stageTone(stage);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%', fontSize: '0.7rem', fontWeight: 600, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', overflow: 'hidden', color: `hsl(var(--color-${tone}))`, backgroundColor: `hsla(var(--color-${tone}), 0.12)` }}>
      <span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(var(--color-${tone}))` }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stage}</span>
    </span>
  );
}

/**
 * Portfolio List-view's sortable/resizable table. Column widths are user-draggable (via the
 * resize handle on each `<th>`) and persisted to localStorage so they survive a reload. Rows for
 * a linked group's lead can be expanded in place to reveal secondary/child rows indented
 * beneath it (`childrenOf(id)` supplies a row's children; expand state is local to this table).
 *
 * Mobile (<640px): collapses into stacked cards via the `.list-table` CSS class in styles.css —
 * see that file for the nth-child-based column show/hide rules. `data-label` is set on each cell
 * for documentation/accessibility even though the current CSS keys off column position rather
 * than the label.
 */
export function ListTable({ rows, childrenOf, open, sortCol, setSortCol, sortDir, setSortDir }) {
  const [expandedIds, setExpandedIds] = useState({});

  const [colWidths, setColWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLW_STORAGE_KEY) || 'null');
      if (saved && saved.length === 7) return saved;
    } catch {
      // ignore corrupt/inaccessible localStorage
    }
    return DEFAULT_WIDTHS.slice();
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLW_STORAGE_KEY, JSON.stringify(colWidths));
    } catch {
      // storage full/unavailable — column widths just won't persist this session
    }
  }, [colWidths]);

  // Column-resize drag state lives in a ref (not state) since it updates on every mousemove and
  // doesn't need to trigger its own re-render — only setColWidths does. `moved` distinguishes a
  // real drag from a click-without-movement, so onSortClick can ignore clicks that were actually
  // the tail end of a resize drag (see onSortClick below).
  const dragRef = useRef(null);
  const onResizeDown = (colIndex, ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dragRef.current = { i: colIndex, startX: ev.clientX, startW: colWidths[colIndex], moved: false };
    const onMove = (moveEv) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = moveEv.clientX - drag.startX;
      if (Math.abs(dx) > 2) drag.moved = true;
      setColWidths((widths) => {
        const next = widths.slice();
        next[drag.i] = Math.max(MIN_WIDTHS[drag.i] || 60, drag.startW + dx);
        return next;
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Clear the drag ref on a delay so the click event that fires right after mouseup (from
      // the same gesture) still sees `moved` and can suppress the sort-toggle it would otherwise
      // trigger — see onSortClick.
      setTimeout(() => { dragRef.current = null; }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onSortClick = (colIndex) => {
    if (dragRef.current && dragRef.current.moved) return; // this click was the tail of a resize drag
    if (sortCol === colIndex) setSortDir((d) => -d);
    else { setSortCol(colIndex); setSortDir(1); }
  };

  const sortedRows = sortCol == null
    ? rows
    : [...rows].sort((a, b) => compareValues(COLUMN_ACCESSORS[sortCol](a), COLUMN_ACCESSORS[sortCol](b)) * sortDir);

  const categoryColor = (p) => CATEGORY_COLOR[deriveCategory(p)] || 'blue';

  const metric = (p) => {
    const stats = tileStats(p).filter((x) => x.v && x.v !== '—');
    return stats[0] ? stats[0].v + ' ' + stats[0].l : '—';
  };

  const renderRow = (asset, { kids = [], isChild = false } = {}) => {
    const hasKids = kids.length > 0;
    const Icon = typeIcon(asset);
    const color = categoryColor(asset);
    const openAsset = () => open(asset.id);

    return (
      <tr
        key={(isChild ? 'c' : 'r') + asset.id}
        tabIndex={0}
        onKeyDown={(ev) => { if (ev.key === 'Enter') openAsset(); }}
        onClick={openAsset}
        style={{ cursor: 'pointer', transition: 'background .12s', background: isChild ? 'var(--bg-secondary)' : 'transparent' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--sidebar-hover-bg)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = isChild ? 'var(--bg-secondary)' : 'transparent'; }}
      >
        <td style={{ ...tdStyle, paddingLeft: isChild ? 30 : 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            {hasKids ? (
              <button
                onClick={(ev) => { ev.stopPropagation(); setExpandedIds((s) => ({ ...s, [asset.id]: !s[asset.id] })); }}
                title="Toggle linked"
                style={{ flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, display: 'inline-flex', color: 'var(--pine)' }}
              >
                <ChevronDown size={16} style={{ transition: 'transform .2s', transform: expandedIds[asset.id] ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              </button>
            ) : (
              <span style={{ flexShrink: 0, width: isChild ? 14 : 16 }} />
            )}
            <span
              style={{
                flexShrink: 0, width: isChild ? 38 : 46, height: isChild ? 38 : 46, borderRadius: isChild ? 9 : 12,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                color: `hsl(var(--color-${color}))`, backgroundColor: `hsla(var(--color-${color}), 0.13)`,
                border: `1px solid hsla(var(--color-${color}), 0.22)`,
              }}
            >
              <Icon size={isChild ? 19 : 23} strokeWidth={1.7} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <strong style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {asset.name}
                </strong>
                {hasKids && (
                  <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.6rem', fontWeight: 700, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)', padding: '1px 6px', borderRadius: 999 }}>
                    <Link2 size={9} />
                    {kids.length}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isChild ? 'Linked property' : cityRegion(asset) || '—'}
              </div>
            </div>
          </div>
        </td>
        <td style={tdStyle}><Cell value={typeLabel(asset)} dataLabel="Type" /></td>
        <td style={tdStyle}><Cell value={cityRegion(asset)} dataLabel="Location" /></td>
        <td style={tdStyle}><StageChip devStage={asset.devStage} /></td>
        <td style={tdStyle}><Cell value={asset.entity} dataLabel="Owner" /></td>
        <td style={tdStyle}><Cell value={asset.manager} dataLabel="Asset Manager" /></td>
        <td style={{ ...tdStyle, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--text-primary)', fontSize: '0.8rem' }} data-label="Size">
          {metric(asset)}
        </td>
      </tr>
    );
  };

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 14, backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' }}>
      <table className="list-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {COLUMNS.map((label, i) => (
              <th
                key={i}
                onClick={() => onSortClick(i)}
                style={{ ...thStyle, width: colWidths[i], position: 'relative', cursor: 'pointer', userSelect: 'none' }}
              >
                {label}
                {sortCol === i ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}
                <span
                  onMouseDown={(ev) => onResizeDown(i, ev)}
                  onClick={(ev) => ev.stopPropagation()}
                  style={{ position: 'absolute', top: 0, right: 0, width: 8, height: '100%', cursor: 'col-resize', zIndex: 3 }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((asset) => {
            const kids = childrenOf(asset.id);
            return (
              <Fragment key={asset.id}>
                {renderRow(asset, { kids })}
                {expandedIds[asset.id] ? kids.map((kid) => renderRow(kid, { isChild: true })) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
