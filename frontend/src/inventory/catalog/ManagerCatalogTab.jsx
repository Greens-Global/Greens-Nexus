// Item Management - Manage > Catalog.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useMemo, memo } from 'react';
import { Package, Plus, Search, X, ClipboardList, LayoutGrid } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { TYPE_META, displayStatus } from '../model/status';
import { cleanField } from '../model/fields';
import { sortItemsBy } from '../model/sort';
import { TypeBadge, StatusBadge } from '../ui/badges';
import { SortableTh } from '../ui/SortableTh';
import { ItemPhotoGrid } from './ItemPhotoGrid';

// ── Manager Catalog Tab ───────────────────────────────────────────────────────
export const ManagerCatalogTab = memo(function ManagerCatalogTab({ items, itemsLoading, itemsError, deptFilter, typeFilter, ownershipFilter = 'All', locationFilter = 'All', modelFilter = 'All', search, searchValue, onSearchChange, refreshItems, onAddToCart, onRemoveFromCart, inCart, checkouts, userEmail, userName, onReturn, onCancel, onSelfAllocate, filterControls }) {
  // Desktop defaults to the list/table; phones default to tiles but can now
  // switch to the (scrollable) list in portrait too (Neil, Jun 16).
  const [viewMode, setViewMode] = useState(() => window.matchMedia('(max-width: 640px)').matches ? 'tile' : 'list');
  const [sort, setSort] = useState({ key: null, dir: 'asc' });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return items.filter(i => {
      const mS = !search || i.name.toLowerCase().includes(q) || (i.make||'').toLowerCase().includes(q) || (i.model||'').toLowerCase().includes(q);
      const mD = deptFilter === 'All' || i.department === deptFilter;
      const mT = typeFilter === 'All' || i.itemType === typeFilter;
      const mO = ownershipFilter === 'All' || (i.ownershipType || 'transient') === ownershipFilter;
      const mL = locationFilter === 'All' || i.location === locationFilter;
      const mM = modelFilter === 'All' || cleanField(i.model) === modelFilter;
      return mS && mD && mT && mO && mL && mM;
    });
  }, [items, search, deptFilter, typeFilter, ownershipFilter, locationFilter, modelFilter]);

  // Sorted for list view: chosen column, or default (available first, then alpha)
  const sortedForList = useMemo(
    () => sortItemsBy(filtered, sort.key, sort.dir),
    [filtered, sort]);

  const pendingCheckoutIds = useMemo(() => new Set(
    (checkouts || []).filter(c => ['pending','approved','pending_receipt','allocated'].includes(c.status)).map(c => c.itemId)
  ), [checkouts]);

  return (
    <>
      {/* One consistent toolbar - search on the LEFT, filters + view toggle on the
          RIGHT, on a single row directly below the tabs. Same shape as Manage so the
          search bar never jumps position between tabs (Neil). */}
      <div style={{ display:'flex', gap:10, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        <div className="search-bar" style={{ flex:1, minWidth:200, marginBottom:0 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search items…" value={searchValue} onChange={e => onSearchChange(e.target.value)} />
          {searchValue && <button className="search-clear" onClick={() => onSearchChange('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
        </div>
        {filterControls && (
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>{filterControls}</div>
        )}
        <div style={{ display:'flex', gap:4, flexShrink:0 }}>
          <button onClick={() => setViewMode('tile')}
            style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode === 'tile' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode === 'tile' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode === 'tile' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <LayoutGrid size={13} /> Tile
          </button>
          <button onClick={() => setViewMode('list')}
            style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode === 'list' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode === 'list' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode === 'list' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <ClipboardList size={13} /> List
          </button>
        </div>
      </div>
      <p style={{ fontSize:12, color:'var(--muted)', margin:'0 0 12px' }}>{filtered.length} item{filtered.length !== 1 ? 's' : ''}</p>

      {(viewMode === 'tile') ? (
        <ItemPhotoGrid
          items={filtered}
          checkouts={checkouts}
          itemsLoading={itemsLoading}
          itemsError={itemsError}
          refreshItems={refreshItems}
          onAddToCart={onAddToCart}
          onRemoveFromCart={onRemoveFromCart}
          inCart={inCart}
          emptyLabel="No items match your filters."
        />
      ) : (
        itemsError ? <ErrorBanner message="Could not load items." onRetry={refreshItems} /> :
        itemsLoading && !filtered.length ? <SkeletonBlocks count={6} height={48} borderRadius={8} /> :
        sortedForList.length === 0 ? (
          <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
            <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
            No items match your filters.
          </div>
        ) : (
          <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto', marginBottom:20 }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'var(--mist)' }}>
                  <th style={{ textAlign:'left', padding:'9px 14px', fontWeight:700, color:'var(--muted)', fontSize:10.5, whiteSpace:'nowrap', textTransform:'uppercase', letterSpacing:'.07em' }}>Photo</th>
                  <SortableTh label="Name"     colKey="name"     sort={sort} onSort={setSort} />
                  <SortableTh label="Type"     colKey="type"     sort={sort} onSort={setSort} />
                  <SortableTh label="Make"     colKey="make"     sort={sort} onSort={setSort} />
                  <SortableTh label="Model"    colKey="model"    sort={sort} onSort={setSort} />
                  <SortableTh label="Location" colKey="location" sort={sort} onSort={setSort} />
                  <SortableTh label="Status"   colKey="status"   sort={sort} onSort={setSort} />
                  <th style={{ padding:'9px 14px' }} />
                </tr>
              </thead>
              <tbody>
                {sortedForList.slice(0, 200).map(item => {
                  const tm = TYPE_META[item.itemType] || TYPE_META.Other;
                  const alreadyInCart = inCart?.has(item.id);
                  const hasPending = pendingCheckoutIds.has(item.id);
                  const canAdd = onAddToCart && item.status === 'available' && !hasPending && item.ownershipType === 'transient';
                  const co = checkouts?.find(c => c.itemId === item.id && ['approved','allocated'].includes(c.status));
                  return (
                    <tr key={item.id} style={{ borderTop:'1px solid var(--line)', opacity: item.status === 'available' && !hasPending ? 1 : 0.65 }}>
                      <td style={{ padding:'8px 14px' }}>
                        {item.photoUrl
                          ? <img src={item.photoUrl} alt={item.name} loading="lazy" decoding="async" style={{ width:44, height:44, borderRadius:10, objectFit:'cover', border:'1px solid var(--line)' }} />
                          : <div style={{ width:44, height:44, borderRadius:10, background:tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}><tm.Icon size={21} color={tm.color} /></div>}
                      </td>
                      <td style={{ padding:'8px 14px', fontWeight:600 }}>
                        {item.name}
                        {co && <div style={{ fontSize:11, color:'hsl(var(--color-orange))', marginTop:1 }}>With {co.requestedBy}</div>}
                      </td>
                      <td style={{ padding:'8px 14px' }}><TypeBadge type={item.itemType} /></td>
                      <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.make || '-'}</td>
                      <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.model || '-'}</td>
                      <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.location || '-'}</td>
                      <td style={{ padding:'8px 14px' }}><StatusBadge status={hasPending ? 'under_review' : displayStatus(item)} item={item} /></td>
                      <td style={{ padding:'8px 14px' }}>
                        {canAdd && (
                          <button onClick={() => alreadyInCart ? onRemoveFromCart?.(item.id) : onAddToCart(item)}
                            className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                            style={{ fontSize:12, padding:'5px 12px', display:'inline-flex', alignItems:'center', gap:5 }}>
                            {alreadyInCart ? <><X size={11} /> Remove</> : <><Plus size={11} /> Add</>}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {sortedForList.length > 200 && (
                  <tr><td colSpan={20} style={{ padding:'10px 14px', fontSize:12, color:'var(--muted)', textAlign:'center' }}>Showing 200 of {sortedForList.length} items - search or filter to narrow down.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )
      )}

    </>
  );
});
