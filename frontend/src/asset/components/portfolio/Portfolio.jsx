import { useEffect, useMemo, useRef, useState } from 'react';
import { List, LayoutGrid, MapPin, SlidersHorizontal, Columns3 } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { Modal } from '../../../tasks/components.jsx';
import { useIsMobile } from '../../../lib/useIsMobile';
import { ModuleActions } from '../../../components/ModuleTabs';
import { PortfolioMap } from './PortfolioMap.jsx';
import { TileCard } from './TileCard.jsx';
import { ListTable } from './ListTable.jsx';
import { PhoneList } from './ListRow.jsx';
import { ViewMenu, viewTitle } from './ViewMenu.jsx';
import { SmartSearch } from './SmartSearch.jsx';
import { FiltersPanel } from './FiltersPanel.jsx';
import { FilterWords } from './FilterWords.jsx';
import { BulkBar } from './BulkBar.jsx';
import { PortfolioSummary } from './PortfolioSummary.jsx';
import { MENU_PANEL, MenuItem, PickMenu, menuKeys, useMenu } from './menuParts.jsx';
import {
  buildContext, applyFilters, facetOptions, filterWords, sortRows, groupRows, normalizeFilters, mergeFilters,
  activeCount, hasFilters, sameView, suggestedFilters, presetView, GROUP_OPTIONS, SORT_OPTIONS, COLUMN_OPTIONS,
  DEFAULT_COLUMNS, EMPTY_FILTERS, SUGGESTED_VIEWS, recordIdentity,
} from '../../lib/portfolioQuery.js';
import { RECORD_TYPES } from '../../lib/recordTypes.jsx';
import { CRITICAL_ITEM_TAB } from '../../lib/criticalItems.js';

const NO_KIDS = [];
const MODES = [['list', 'List', List], ['gallery', 'Gallery', LayoutGrid], ['map', 'Map', MapPin]];

/** The view a saved / suggested view id stands for, so "- edited" can compare against it. */
function baseOf(view, saved, me) {
  if (!view?.id || view.id === 'all') return { filters: EMPTY_FILTERS, groupBy: 'none', sort: 'name' };
  if (SUGGESTED_VIEWS.some(([k]) => k === view.id)) return { filters: suggestedFilters(view.id, me), groupBy: view.id === 'development' ? 'stage' : 'none', sort: 'name' };
  const mine = saved.find((v) => v.id === view.id);
  return mine || null;
}

function ColumnsMenu({ columns, onChange }) {
  const { open, setOpen, btn, panel } = useMenu();
  const on = columns || DEFAULT_COLUMNS;
  return (
    <>
      <button ref={btn} type="button" className="pt-pick" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Columns3 size={14} aria-hidden="true" /> <span className="pt-pick-label">Columns</span>
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} minWidth={200} style={MENU_PANEL} aria-label="Columns">
        <div ref={panel} onKeyDown={menuKeys}>
          {COLUMN_OPTIONS.map(([k, l]) => (
            <MenuItem key={k} checked={on.includes(k)} onClick={() => onChange(on.includes(k) ? on.filter((x) => x !== k) : [...on, k])}>{l}</MenuItem>
          ))}
        </div>
      </AnchoredMenu>
    </>
  );
}

/**
 * The Properties tab - the register (Neil, 11/17/2026). Its view (filters, grouping, sort,
 * mode, columns) is held by App.jsx so it rides the address; this draws it: the view name as
 * the page's first word, the summary sentence and what needs you, the smart search, Filters,
 * Group by and Sort, List / Gallery / Map, the filter words, a selection's bulk line, the list.
 * Properties only - vehicles and equipment live in Fleet.
 */
export function Portfolio({
  assets = [], store = {}, metrics = {}, flagCount = 0, onReviewFlags = null, companies = [], canClearCompany = false, view, onView, mode = 'list', onMode,
  saved = [], onSaveViews, me = null, openAsset, lastOpenedId = null, serverOk = true, loading = false,
  onBulkSet, canEdit = true, openTickets = null, onCopyLink, onListChange, actions = null, onNeedTickets,
}) {
  const phone = useIsMobile();
  const v = view || { id: 'all', filters: EMPTY_FILTERS, groupBy: 'none', sort: 'name' };
  const filters = useMemo(() => normalizeFilters(v.filters), [v.filters]);
  const ctx = useMemo(() => buildContext({ assets, store, companies, metrics, openTickets, me }), [assets, store, companies, metrics, openTickets, me]);
  const options = useMemo(() => facetOptions(ctx), [ctx]);
  const shown = useMemo(() => sortRows(applyFilters(ctx, filters), ctx, v.sort), [ctx, filters, v.sort]);
  const groups = useMemo(() => groupRows(shown, ctx, v.groupBy), [shown, ctx, v.groupBy]);
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const words = filterWords(filters, options);
  const [selected, setSelected] = useState(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersBtn = useRef(null);
  const [saveAsk, setSaveAsk] = useState(0);
  const base = baseOf(v, saved, me);
  const edited = !!base && !sameView(v, base);
  const title = viewTitle(v, saved);
  const columns = v.columns || DEFAULT_COLUMNS;
  const childrenOf = useMemo(() => {
    const kids = {};
    ctx.all.forEach((a) => { if (a.parentId) (kids[a.parentId] ||= []).push(a); });
    return (id) => kids[id] || NO_KIDS;
  }, [ctx]);

  // Prev / next on an open asset walks this list, in this order.
  const idsKey = ordered.map((a) => a.id).join('|');
  useEffect(() => { onListChange?.(ordered.map((a) => a.id), edited ? 'Properties' : title); }, [idsKey, title, edited]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A filter that needs the tickets list asks for it once.
  useEffect(() => { if (filters.shows.includes('tickets') && !openTickets) onNeedTickets?.(); }, [filters.shows, openTickets, onNeedTickets]);
  // A selection keeps only what is still shown.
  useEffect(() => { setSelected((s) => { const ids = new Set(ordered.map((a) => a.id)); const next = new Set([...s].filter((id) => ids.has(id))); return next.size === s.size ? s : next; }); }, [idsKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const setFilters = (next) => onView({ ...v, filters: normalizeFilters(next) });
  const apply = (next) => onView({ ...next, filters: normalizeFilters(next.filters), mode: next.mode || '' });
  const showPreset = (key) => {
    const map = { passed: 'passed-dates', 'no-manager': 'no-manager', mistyped: 'mistyped-dates' };
    const p = presetView(map[key] || key, me);
    if (p) apply({ ...p, groupBy: p.groupBy || v.groupBy, sort: v.sort, columns: v.columns });
  };
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleMany = (ids, on) => setSelected(on ? new Set(ids) : new Set());
  const openRecord = (r) => {
    if (r.coll === 'permit') openAsset(r.assetId, 'permit', r.item);
    else if (r.coll === 'property') openAsset(r.assetId, 'property');
    else openAsset(r.assetId, r.coll, recordIdentity(r.coll, r.row, RECORD_TYPES));
  };

  const empty = !loading && !ctx.rows.length;
  const filtered = hasFilters(filters);

  const firstRow = (
    <ModuleActions>
      <div className="pt-first-row">
        {!phone && (
          <div className="pt-first-title">
            <ViewMenu view={v} title={title} edited={edited} ctx={ctx} me={me} saved={saved} onSave={onSaveViews} onApply={apply} onCopyLink={onCopyLink} askSave={saveAsk} />
          </div>
        )}
        <div className="pt-first-actions">{actions}</div>
      </div>
    </ModuleActions>
  );

  const filtersBody = (
    <FiltersPanel filters={filters} onChange={setFilters} ctx={ctx} options={options} shownCount={shown.length} phone={phone}
      onDone={() => { setFiltersOpen(false); filtersBtn.current?.focus(); }} />
  );
  const nFilters = activeCount(filters);

  return (
    <div className="pt-register">
      {firstRow}
      <PortfolioSummary flagCount={flagCount} onReviewFlags={onReviewFlags} rows={shown} ctx={ctx} phone={phone} loading={loading && !ctx.rows.length} onShow={showPreset}
        onFix={(d) => openAsset(d.id, CRITICAL_ITEM_TAB[d.cat] || 'property')}
        onOpenDate={(d) => openAsset(d.id, CRITICAL_ITEM_TAB[d.cat] || 'property')} />

      <div className="pt-toolbar">
        <SmartSearch value={filters.q} ctx={ctx} options={options} store={store} filters={filters}
          placeholder={phone ? 'Search' : filtered ? 'Search or filter' : 'Search or filter - try "self storage in CA"'}
          onSearch={(q) => setFilters({ ...filters, q })} onFilter={(patch) => setFilters({ ...mergeFilters(filters, patch), q: '' })}
          onOpenAsset={(id) => openAsset(id, 'property')} onOpenRecord={openRecord} />
        <button ref={filtersBtn} type="button" className={`secondary-btn pt-filters-btn${filtersOpen ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}>
          <SlidersHorizontal size={14} aria-hidden="true" /> Filters{nFilters ? <span className="pt-filters-n">{nFilters}</span> : null}
        </button>
        {!phone && <PickMenu label="Group by" value={v.groupBy || 'none'} options={GROUP_OPTIONS} onPick={(g) => onView({ ...v, groupBy: g })} />}
        {!phone && <PickMenu label="Sort" value={v.sort || 'name'} options={SORT_OPTIONS} onPick={(s) => onView({ ...v, sort: s })} />}
        {!phone && mode === 'list' && <ColumnsMenu columns={v.columns} onChange={(c) => onView({ ...v, columns: c })} />}
        {!phone && (
          <div className="pt-modes" role="radiogroup" aria-label="Show as">
            {MODES.map(([k, label, Icon]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'is-on' : ''} onClick={() => onMode(k)}>
                <Icon size={14} aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {!phone && (
        <AnchoredMenu anchorRef={filtersBtn} open={filtersOpen} onClose={() => setFiltersOpen(false)} role="presentation" minWidth={640}
          style={{ ...MENU_PANEL, padding: 0, width: 680, maxWidth: 'calc(100vw - 32px)' }}>
          {filtersBody}
        </AnchoredMenu>
      )}
      {phone && filtersOpen && (
        <Modal title="Filters" onClose={() => setFiltersOpen(false)} minHeight="auto">{filtersBody}</Modal>
      )}

      {selected.size > 0 ? (
        <BulkBar count={selected.size} companies={companies} canClearCompany={canClearCompany} canEdit={canEdit}
          managers={options.manager.filter((m) => m.key !== '__none__')}
          onSet={(field, value) => { onBulkSet?.([...selected], field, value); setSelected(new Set()); }} onClear={() => setSelected(new Set())} />
      ) : (
        <FilterWords words={words} shown={shown.length} total={ctx.rows.length}
          onRemove={(w) => setFilters(w.clear(filters))} onClear={() => setFilters({ ...EMPTY_FILTERS, q: filters.q })}
          onSaveView={phone ? null : () => setSaveAsk((n) => n + 1)} />
      )}

      {loading && !ctx.rows.length ? (
        <div className="pt-loading" aria-busy="true" aria-label="Loading properties">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="pt-skel-row"><div className="pt-skel" style={{ width: 48, height: 34 }} /><div className="pt-skel" style={{ width: `${30 + (i % 3) * 12}%`, height: 14 }} /></div>)}
        </div>
      ) : empty ? (
        <div className="pt-empty">
          {serverOk
            ? <>No properties yet. <b>New</b> registers the first one.</>
            : <>Couldn't reach the server to load the portfolio - retrying on its own. <button type="button" className="pt-link" onClick={() => window.location.reload()}>Reload Now</button></>}
        </div>
      ) : !shown.length ? (
        <div className="pt-empty">
          No properties match {filtered ? 'these filters' : 'this view'}. <button type="button" className="pt-link" onClick={() => apply({ id: 'all', filters: EMPTY_FILTERS, groupBy: v.groupBy, sort: v.sort, columns: v.columns })}>Show All Properties</button>
        </div>
      ) : phone && mode !== 'map' ? (
        <PhoneList rows={ordered} open={(id) => openAsset(id, 'property')} lastOpenedId={lastOpenedId} />
      ) : mode === 'map' ? (
        <PortfolioMap assets={ordered} openProperty={(id) => openAsset(id, 'property')} noun="properties" />
      ) : mode === 'gallery' ? (
        <div className="pt-gallery">
          {groups.map((g) => (
            <section key={g.key} className="pt-gallery-group" aria-label={g.label || 'Properties'}>
              {g.label && <h3 className="pt-group-head">{g.label} <span className="pt-dim">{g.rows.length} {g.rows.length === 1 ? 'property' : 'properties'}</span></h3>}
              <div className="pt-grid">
                {g.rows.map((a) => (
                  <TileCard key={a.id} pr={a} openProperty={(id) => openAsset(id, 'property')} secondaries={childrenOf(a.id)} measures={ctx.byId[a.id]?.measures} selected={a.id === lastOpenedId} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <ListTable groups={groups} ctx={ctx} columns={columns} open={(id) => openAsset(id, 'property')} selected={selected} onToggle={toggle} onToggleMany={toggleMany}
          sort={v.sort} onSort={(s) => onView({ ...v, sort: s })} lastOpenedId={lastOpenedId} childrenOf={childrenOf} />
      )}
    </div>
  );
}
