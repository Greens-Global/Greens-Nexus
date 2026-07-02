import { useState } from 'react';
import { LayoutGrid, List, MapPin, Flag, Shapes, Search } from 'lucide-react';
import { CATEGORIES, TYPES, deriveCategory, deriveType, cityRegion, typeLabel, stateAbbrev, stateSearchHaystack, assetRank } from '../../lib/portfolioCards.js';
import { STAGE_FILTER_OPTIONS, baseStage } from '../../lib/stages.js';
import { EmptyState } from '../shared/EmptyState.jsx';
import { PortfolioMap } from './PortfolioMap.jsx';
import { TileCard } from './TileCard.jsx';
import { ListTable } from './ListTable.jsx';
// NOTE: ListRow/ListGroupRow (from ./ListRow.jsx) are NOT used below. In the original app, List
// view always renders ListTable (see the `viewMode === 'list'` branch), and the card-row variant
// (ListRow/ListGroupRow) is only reachable from a code path that's unconditionally shadowed by
// that same check — i.e. already-dead code in the shipped app, not something this port dropped.
// They're kept as importable components (faithfully ported, matching their original signatures)
// in case a future redesign wants a card-style List view again, but nothing here renders them.
// See ListRow.jsx's file comment for the same note from the other side.

// Column headers, in the same order as ListTable's COLUMNS — duplicated here (rather than
// imported) only for the "Sorted: <Column>" chip label; kept as its own small constant so
// Portfolio.jsx doesn't need to reach into ListTable's internals for display text.
const SORT_COLUMN_LABELS = ['Asset', 'Type', 'Location', 'Stage', 'Owner', 'Asset Manager', 'Size'];

// Icon-label span style, shared by the little Category/Stage/Type/Region glyphs that sit
// directly to the left of each filter <select>.
const filterIconLabelStyle = {
  fontSize: '0.64rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-secondary)',
  display: 'inline-flex',
  alignItems: 'center',
};

const selectStyle = { width: '140px', minWidth: 0, maxWidth: '160px', padding: '0 10px', fontSize: '0.8rem', height: 40, boxSizing: 'border-box' };

// Both the "Clear Filters" button and the "Sorted: X" chip share this exact pill shape — this
// was a real fix (they used to render with different border-radius/background/font-size before
// being unified). Keep them visually identical; only content/interactivity differs.
const filterPillStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999,
  backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
  fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap',
};

const VIEW_TABS = [
  ['tile', 'Tiles', LayoutGrid],
  ['list', 'List', List],
  ['map', 'Map', MapPin],
];

/**
 * The Portfolio page: search, Category/Stage/Type/Region filters, a Tiles/List/Map view
 * toggle, and (in List view) column sorting — the main landing page for browsing every asset.
 *
 * `typeFilter`/`setTypeFilter` are lifted up to the caller rather than local state, so the Type
 * filter can be pre-set/read from outside this component (e.g. a "View all Self-Storage assets"
 * link elsewhere in the app); every other filter (category/stage/region/search) and the view
 * mode/sort are local to this component and reset on unmount.
 *
 * IMPORTANT — the per-option counts shown in each filter dropdown (e.g. "Commercial (23)") are
 * always computed from the FULL unfiltered asset list, not from the results of the OTHER
 * currently-applied filters. So picking a Category doesn't shrink the counts shown in the Stage/
 * Type/Region dropdowns — every dropdown's counts are relative to the whole portfolio, not to
 * "what's left after my other filters." This matches the original app's behavior; it reads as
 * intentional (lets you see full-portfolio breakdowns while narrowing your view) rather than a
 * bug, but flagging it here since it's easy to "fix" by accident while touching this code.
 */
export function Portfolio({ props, openProperty, typeFilter, setTypeFilter }) {
  const [stageFilter, setStageFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [viewMode, setViewMode] = useState('tile');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState(1);

  const all = props.slice();
  if (!all.length) {
    return <EmptyState>No properties yet. Use “Add property” to register the first one.</EmptyState>;
  }

  // Apply filters in this order: Category -> Stage -> Type -> Region -> search. Order doesn't
  // change the result (they're independent predicates, all AND'd together) but matches the
  // original for ease of comparison.
  let filtered = all.slice();
  if (categoryFilter) filtered = filtered.filter((a) => deriveCategory(a) === categoryFilter);
  if (stageFilter) filtered = filtered.filter((a) => baseStage(a.devStage) === stageFilter);
  if (typeFilter) filtered = filtered.filter((a) => deriveType(a) === typeFilter);
  if (regionFilter) filtered = filtered.filter((a) => stateAbbrev(a) === regionFilter);
  if (search.trim()) {
    const needle = search.trim().toLowerCase();
    filtered = filtered.filter((a) =>
      [a.name, a.entity, a.manager, cityRegion(a), typeLabel(a), a.address, stateSearchHaystack(a)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }

  // Dropdown option counts are deliberately based on the FULL list (`all`), not `filtered` — see
  // the function-level doc comment above.
  const categoryCount = (cat) => all.filter((a) => deriveCategory(a) === cat).length;
  const stageCount = (stage) => all.filter((a) => baseStage(a.devStage) === stage).length;

  const typeCounts = {};
  all.forEach((a) => { const t = deriveType(a); if (t) typeCounts[t] = (typeCounts[t] || 0) + 1; });
  const availableTypes = TYPES.filter((t) => typeCounts[t] > 0);

  const regionCounts = {};
  all.forEach((a) => { const r = stateAbbrev(a); if (r) regionCounts[r] = (regionCounts[r] || 0) + 1; });
  const availableRegions = Object.keys(regionCounts).sort();

  const isTopLevel = (a) => !a.parentId;
  const childrenOf = (id) => all.filter((a) => a.parentId === id);
  // Only top-level (non-linked-child) assets are ever shown as their own row/tile/pin — linked
  // secondaries are reachable through their lead's group card/row instead, never listed
  // separately. Re-sorted by assetRank since the filter above doesn't preserve any particular
  // order.
  const topLevelAssets = filtered.filter(isTopLevel).sort((a, b) => assetRank(a) - assetRank(b));

  const hasAnyFilter = categoryFilter || stageFilter || typeFilter || regionFilter || search;
  const showFilterRow = hasAnyFilter || (viewMode === 'list' && sortCol != null);

  const clearFilters = () => {
    setCategoryFilter('');
    setStageFilter('');
    setTypeFilter && setTypeFilter('');
    setRegionFilter('');
    setSearch('');
  };

  const viewToggle = (
    <div style={{ display: 'inline-flex', alignItems: 'center', padding: 3, height: 40, boxSizing: 'border-box', borderRadius: 999, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
      {VIEW_TABS.map(([mode, label, Icon]) => (
        <button
          key={mode}
          onClick={() => setViewMode(mode)}
          title={`${label} view`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 999,
            border: 'none', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 600,
            background: viewMode === mode ? 'var(--pine)' : 'transparent',
            color: viewMode === mode ? '#fff' : 'var(--text-secondary)',
          }}
        >
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );

  const renderTiles = () =>
    topLevelAssets.map((asset) => {
      const secondaries = childrenOf(asset.id);
      return <TileCard key={asset.id} pr={asset} openProperty={openProperty} secondaries={secondaries} />;
    });

  return (
    <>
      <div className="gt-filters" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'nowrap', marginBottom: 20 }}>
        <div className="gt-fmain" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
            <Search size={17} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
            <input
              className="form-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assets, owner, location…"
              style={{ width: '100%', padding: '10px 14px 10px 40px', fontSize: '0.92rem', fontWeight: 500, borderRadius: 10 }}
            />
          </div>

          <span title="Category" style={{ ...filterIconLabelStyle, color: 'var(--pine)' }}>
            <LayoutGrid size={15} />
          </span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="form-input"
            style={{ ...selectStyle, borderColor: categoryFilter ? 'var(--pine)' : undefined }}
          >
            <option value="">All Categories</option>
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{`${cat} (${categoryCount(cat)})`}</option>
            ))}
          </select>

          <span style={{ width: 1, height: 22, backgroundColor: 'var(--border-color)' }} />

          <span title="Stage" style={filterIconLabelStyle}>
            <Flag size={15} />
          </span>
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="form-input" style={selectStyle}>
            <option value="">All Stages</option>
            {STAGE_FILTER_OPTIONS.map((stage) => (
              <option key={stage} value={stage}>{`${stage} (${stageCount(stage)})`}</option>
            ))}
          </select>

          <span title="Asset type" style={filterIconLabelStyle}>
            <Shapes size={15} />
          </span>
          <select value={typeFilter} onChange={(e) => setTypeFilter && setTypeFilter(e.target.value)} className="form-input" style={selectStyle}>
            <option value="">All Types</option>
            {availableTypes.map((type) => (
              <option key={type} value={type}>{`${type} (${typeCounts[type]})`}</option>
            ))}
          </select>

          <span title="Region" style={filterIconLabelStyle}>
            <MapPin size={15} />
          </span>
          <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} className="form-input" style={selectStyle}>
            <option value="">All Regions</option>
            {availableRegions.map((region) => (
              <option key={region} value={region}>{`${region} (${regionCounts[region]})`}</option>
            ))}
          </select>
        </div>

        <div style={{ flexShrink: 0 }}>{viewToggle}</div>
      </div>

      {showFilterRow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
          {hasAnyFilter && (
            <button onClick={clearFilters} style={{ ...filterPillStyle, cursor: 'pointer' }}>
              Clear Filters ✕
            </button>
          )}
          {viewMode === 'list' && sortCol != null && (
            <div style={filterPillStyle}>
              {'Sorted: '}
              <strong style={{ color: 'var(--text-primary)' }}>{SORT_COLUMN_LABELS[sortCol]}</strong>
              {sortDir > 0 ? ' ↑' : ' ↓'}
              <button
                onClick={() => setSortCol(null)}
                title="Reset sort"
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, marginLeft: 2, color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {topLevelAssets.length === 0 ? (
        <EmptyState>
          No properties match the current filters{categoryFilter ? ` (${categoryFilter})` : ''}.
        </EmptyState>
      ) : viewMode === 'map' ? (
        <PortfolioMap assets={topLevelAssets} openProperty={openProperty} />
      ) : viewMode === 'list' ? (
        <ListTable rows={topLevelAssets} childrenOf={childrenOf} open={openProperty} sortCol={sortCol} setSortCol={setSortCol} sortDir={sortDir} setSortDir={setSortDir} />
      ) : (
        <div className="pt-portfolio-grid" style={{ display: 'grid', gap: 18, alignItems: 'stretch' }}>
          {renderTiles()}
        </div>
      )}
    </>
  );
}
