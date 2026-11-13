// Item Management - Inventory > Table: the item list, filters, KPIs and batch tools.
// Items redesign (Neil, 11/02/2026): a name opens the item record; a missing
// photo is a quiet filter (Missing Photo), not a red banner; a batch edit that
// skipped rows (checked out or assigned) says which.
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { Package, Plus, Search, X, ChevronDown, UploadCloud, FileSpreadsheet, Download, Pencil, Trash2, FileBarChart, ArrowUpDown, Tag, Settings2, ImageOff, QrCode } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { api } from '../../api';
import NewButton from '../../components/NewButton';
import { ITEM_TYPES, displayStatus } from '../model/status';
import { cleanField } from '../model/fields';
import { useIsMobile } from '../ui/hooks';
import { ImageLightbox } from '../ui/ImageLightbox';
import { BatchDeleteConfirmModal } from './BatchDeleteConfirmModal';
import { BatchEditModal } from './BatchEditModal';
import { BatchPhotoModal } from './BatchPhotoModal';
import { ManageRow, ManageCard } from './ManageRow';

export const ManagerManageTab = memo(function ManagerManageTab({ items, itemsLoading, itemsError, deptFilter, typeFilter, ownershipFilter = 'All', locationFilter = 'All', modelFilter = 'All', cardFilter = null, search, searchValue, onSearchChange, refreshItems, canDelete, onAdd, onEdit, onDelete, onImport, onExport, onExportAllPdf, onReport, checkouts, toast, onAssign, onDetails, onShowDeleted, onManageCustomFields, onManageTypes, itemTypes = ITEM_TYPES, filterControls, kpiStrip, highlightId, onHighlightDone, overdueIds = null, onPrintTags }) {
  const [missingOnly, setMissingOnly] = useState(false);   // the quiet Missing Photo filter
  const [photoPreview,       setPhotoPreview]       = useState(null);
  const [exportMenu,         setExportMenu]         = useState(false); // Export ▾ dropdown
  const [manageMenu,         setManageMenu]         = useState(false); // Manage ▾ dropdown (admin extras)
  const [selected,           setSelected]           = useState(new Set());
  const [sortCol,            setSortCol]            = useState('name');
  const [sortDir,            setSortDir]            = useState('asc');
  // One unified Batch modal with two tabs (Neil: merge "Batch Update Photos" and
  // "Edit" into a single feature). batchTab picks which face shows.
  const [batchOpen,          setBatchOpen]          = useState(false);
  const [batchTab,           setBatchTab]           = useState('fields'); // 'fields' | 'photos'
  const [batchEditing,       setBatchEditing]       = useState(false);
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [batchDeleting,      setBatchDeleting]      = useState(false);
  const isMobile = useIsMobile(); // phones render cards, not the table

  // (AI photo fill lives inside BatchPhotoModal now - Neil moved it off this bar.)

  const TYPE_ORDER = ['Vehicles', 'Devices', 'Tools', 'Equipment', 'Keys', 'Other'];

  const filtered = useMemo(() => items.filter(i => {
    const q = search.toLowerCase();
    const mS = !search || i.name.toLowerCase().includes(q) || (i.make||'').toLowerCase().includes(q) || (i.model||'').toLowerCase().includes(q);
    const mD = deptFilter === 'All' || i.department === deptFilter;
    const mT = typeFilter === 'All' || i.itemType === typeFilter;
    const mO = ownershipFilter === 'All' || (i.ownershipType || 'transient') === ownershipFilter;
    const mL = locationFilter === 'All' || i.location === locationFilter;
    const mM = modelFilter === 'All' || cleanField(i.model) === modelFilter;
    // The KPI tile bucket (see kpiStrip above) - a lifecycle-status narrower
    // on top of the dropdown filters, matching the same counts the tiles show.
    const mC = !cardFilter
      || (cardFilter === 'available'            && i.status === 'available' && i.ownershipType !== 'permanent')
      || (cardFilter === 'unassigned'           && displayStatus(i) === 'unassigned')
      || (cardFilter === 'location_assigned'    && displayStatus(i) === 'location_assigned')
      || (cardFilter === 'permanently_assigned' && i.status === 'permanently_assigned')
      || (cardFilter === 'checked_out'          && i.status === 'checked_out')
      || (cardFilter === 'overdue'              && !!overdueIds?.has(i.id));
    const mP = !missingOnly || (!i.photoUrl && i.pictureRequired !== false);
    return mS && mD && mT && mO && mL && mM && mC && mP;
  }), [items, search, deptFilter, typeFilter, ownershipFilter, locationFilter, modelFilter, cardFilter, missingOnly, overdueIds]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    let av, bv;
    if (sortCol === 'serial')    { av = (a.serialNumber || '').toLowerCase();   bv = (b.serialNumber || '').toLowerCase(); }
    if (sortCol === 'name')      { av = a.name.toLowerCase();                   bv = b.name.toLowerCase(); }
    if (sortCol === 'type')      { av = TYPE_ORDER.indexOf(a.itemType);         bv = TYPE_ORDER.indexOf(b.itemType); }
    if (sortCol === 'make')      { av = (a.make || '').toLowerCase();           bv = (b.make || '').toLowerCase(); }
    if (sortCol === 'model')     { av = (a.model || '').toLowerCase();          bv = (b.model || '').toLowerCase(); }
    if (sortCol === 'dept')      { av = (a.department || '').toLowerCase();     bv = (b.department || '').toLowerCase(); }
    if (sortCol === 'location')  { av = (a.location || '').toLowerCase();       bv = (b.location || '').toLowerCase(); }
    if (sortCol === 'ownership') { av = (a.ownershipType || 'transient');       bv = (b.ownershipType || 'transient'); }
    // Sort by the DISPLAYED status (Unassigned / Assigned · Location …), matching
    // the badge the column actually shows (P4 status coherence).
    if (sortCol === 'status')    { av = displayStatus(a);                       bv = displayStatus(b); }
    if (sortCol === 'opstatus')  { av = (a.opStatus || '').toLowerCase();       bv = (b.opStatus || '').toLowerCase(); }
    if (sortCol === 'photo')     { av = a.photoUrl ? 1 : 0;                     bv = b.photoUrl ? 1 : 0; }
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortDir === 'asc' ? cmp : -cmp;
  }), [filtered, sortCol, sortDir]);

  // ── Row virtualization (desktop table) ──────────────────────────────────────
  // A catalog of hundreds of rows is slow to scroll/select when every row is in
  // the DOM. Render only the rows near the viewport (+ overscan) inside a bounded
  // scroll box; fixed row height + spacer rows keep the scrollbar honest.
  const ROW_H = 65;
  const OVERSCAN = 6;
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(640);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 640);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  // Jump back to the top whenever the filtered/sorted set changes, so we never
  // sit in a now-out-of-range scroll window.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [search, deptFilter, typeFilter, ownershipFilter, locationFilter, modelFilter, cardFilter, missingOnly, sortCol, sortDir]);
  const vStart = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const vEnd   = Math.min(sorted.length, vStart + Math.ceil(viewportH / ROW_H) + OVERSCAN * 2);
  const vSlice = sorted.slice(vStart, vEnd);
  const padTop = vStart * ROW_H;
  const padBot = Math.max(0, (sorted.length - vEnd) * ROW_H);

  // Jump to + flash a specific item (the Audit Log "Open item →"). The parent
  // clears the filters first so the row is guaranteed visible; we scroll the
  // virtualized list to it (the row's own ref then centres it) and glow for ~2.5s.
  const [flashId, setFlashId] = useState(null);
  useEffect(() => {
    if (!highlightId) return;
    const idx = sorted.findIndex(i => i.id === highlightId);
    if (idx < 0) { onHighlightDone?.(); return; }
    setFlashId(highlightId);
    if (!isMobile && scrollRef.current) {
      const target = Math.max(0, idx * ROW_H - viewportH / 2 + ROW_H / 2);
      scrollRef.current.scrollTop = target;
      setScrollTop(target);
    }
    const t = setTimeout(() => { setFlashId(null); onHighlightDone?.(); }, 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId]);

  // Photo-optional items (pictureRequired === false, e.g. keys) don't count as
  // "missing a photo" (P1-16 / UX-017).
  const missingPhotos = items.filter(i => !i.photoUrl && i.pictureRequired !== false).length;
  const selItems      = filtered.filter(i => selected.has(i.id));
  const blockedItems  = selItems.filter(i =>
    (checkouts || []).some(c => c.itemId === i.id && ['pending','approved','pending_receipt','allocated'].includes(c.status))
  );
  // What a batch action operates on: the explicit selection if any rows are
  // ticked, otherwise everything currently shown under the filters (Neil: never
  // forced to all 500 - selecting six, or filtering to a type, scopes the batch).
  // Batch acts ONLY on the explicit selection - never "everything shown" by
  // default (Neil: people will mass-edit by accident; make them tick rows first.
  // Select-all is one click away when they really want every row).
  const usingSelection = selItems.length > 0;
  const batchScope     = selItems;

  // Refs let toggleSelect stay STABLE (so memoized rows don't all re-render) while
  // still reading the current sorted order + the last-ticked anchor for shift-range.
  // The ref is synced in an effect (not during render) - toggleSelect only reads it
  // from a click handler, which fires after commit, so it always sees the latest list.
  const sortedRef = useRef(sorted);
  useEffect(() => { sortedRef.current = sorted; });
  const selectAnchorRef = useRef(null);
  const toggleSelect = useCallback((id, shift) => {
    const list = sortedRef.current;
    const idx = list.findIndex(i => i.id === id);
    if (shift && selectAnchorRef.current != null && idx !== -1) {
      // Shift-click: select the whole range from the last ticked row to this one.
      const a = Math.min(selectAnchorRef.current, idx);
      const b = Math.max(selectAnchorRef.current, idx);
      const rangeIds = list.slice(a, b + 1).map(i => i.id);
      setSelected(prev => { const n = new Set(prev); rangeIds.forEach(r => n.add(r)); return n; });
    } else {
      setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
    if (idx !== -1) selectAnchorRef.current = idx;
  }, []);
  function toggleAll() {
    setSelected(selected.size === filtered.length && filtered.length > 0 ? new Set() : new Set(filtered.map(i => i.id)));
  }
  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  async function executeBatchEdit(fields, assignment) {
    setBatchEditing(true);
    const ids = batchScope.map(i => i.id);
    try {
      const parts = [];
      // "Assign to location" already writes location - drop a ticked location
      // field so the same value isn't written twice by two endpoints.
      if (fields && assignment?.kind === 'location') delete fields.location;
      if (fields && Object.keys(fields).length) {
        const res = await api.bulkUpdateItems(ids, fields);
        const n = res?.updated ?? ids.length;
        parts.push(`updated ${n} item${n !== 1 ? 's' : ''}`);
        // The server skips rows it may not change (checked out or assigned
        // right now) and says which - say so rather than claim every row.
        const blocked = res?.blocked || [];
        if (blocked.length) {
          toast?.(`${blocked.length} not changed (${blocked.slice(0, 4).map(b => b.name).join(', ')}${blocked.length > 4 ? ` and ${blocked.length - 4} more` : ''}): checked out or assigned right now.`, 'error');
        }
      }
      if (assignment) {
        if (assignment.kind === 'location') {
          const r = await api.bulkAssignLocation(ids, assignment.location);
          parts.push(`assigned ${r?.assigned ?? ids.length} to ${assignment.location}`);
          if (r?.skipped?.length) parts.push(`${r.skipped.length} skipped (in use)`);
        } else {
          const r = await api.bulkAssignPerson(ids, assignment.email, assignment.name, assignment.skipAcceptance);
          parts.push(`assigned ${r?.assigned ?? ids.length} to ${assignment.name || assignment.email}`);
          if (r?.skipped?.length) parts.push(`${r.skipped.length} skipped (in use or temporary)`);
        }
      }
      await refreshItems();
      setSelected(new Set());
      setBatchOpen(false);
      const msg = parts.join(' · ') || 'No changes';
      toast?.(msg.charAt(0).toUpperCase() + msg.slice(1) + '.');
    } catch {
      toast?.('Could not apply the changes. Please try again.', 'error');
    } finally {
      setBatchEditing(false);
    }
  }


  async function executeBatchDelete() {
    setBatchDeleting(true);
    const deletable = selItems.filter(i => !blockedItems.find(b => b.id === i.id));
    try {
      // One request, one transaction - the old per-item loop made deleting 30+
      // items take 10-20s (Jun 16).
      const res = await api.bulkDeleteItems(deletable.map(i => i.id));
      await refreshItems();
      setSelected(new Set());
      setBatchDeleteConfirm(false);
      const blocked = res?.blocked?.length || 0;
      const deleted = res?.deleted ?? deletable.length;
      if (!blocked) toast?.(`Deleted ${deleted} item${deleted !== 1 ? 's' : ''}.`);
      else toast?.(`Deleted ${deleted} item${deleted !== 1 ? 's' : ''} · ${blocked} skipped (active checkout).`, 'error');
    } catch {
      toast?.('Could not delete the selected items. Please try again.', 'error');
    } finally {
      setBatchDeleting(false);
    }
  }

  const SortTh = ({ col, label }) => {
    const active = sortCol === col;
    return (
      <th onClick={() => toggleSort(col)} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        style={{ textAlign:'left', padding:'10px 14px', fontWeight:600, color: active ? 'var(--ink)' : 'var(--muted)', whiteSpace:'nowrap', fontSize:13, cursor:'pointer', userSelect:'none', background:'var(--mist)' }}>
        <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}>
          {label}
          <ArrowUpDown size={11} style={{ opacity: active ? 1 : 0.35, color: active ? 'var(--wk-brand)' : 'inherit', transform: active && sortDir === 'desc' ? 'scaleY(-1)' : 'none' }} />
        </span>
      </th>
    );
  };

  if (itemsError) return <ErrorBanner message="Could not load items." onRetry={refreshItems} />;

  return (
    <>
      {/* Phone search - the desktop tab-strip search is hidden on mobile */}
      {isMobile && onSearchChange && (
        <div className="search-bar" style={{ width:'100%', marginBottom:12 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search items…" value={searchValue} onChange={e => onSearchChange(e.target.value)} />
          {searchValue && <button className="search-clear" onClick={() => onSearchChange('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
        </div>
      )}
      {/* Filter + search bar - directly above the items, one consistent spot
          (Neil): search on the left, filter dropdowns pushed to the right. The
          phone search is rendered separately above, so this one is desktop-only. */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        {!isMobile && onSearchChange && (
          <div className="search-bar" style={{ flex:1, minWidth:200, marginBottom:0 }}>
            <Search size={14} style={{ flexShrink:0 }} />
            <input placeholder="Search items…" value={searchValue} onChange={e => onSearchChange(e.target.value)} />
            {searchValue && <button className="search-clear" onClick={() => onSearchChange('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
          </div>
        )}
        <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center', marginLeft: isMobile ? 0 : 'auto' }}>
          {filterControls}
        </div>
      </div>
      {/* KPI cards sit BELOW the toolbar so the search/filter row stays at the same
          height as every other tab (Neil: fixed position, no jumping). */}
      {kpiStrip}
      {/* Action bar - one row: primary action first, everyday secondaries next,
          admin extras collected under Manage ▾ so the bar never wraps into soup. */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        {/* "+ New", the one create button across Nexus (Neil, 11/13/2026);
            Import rides its menu, as on Credentials and Links. */}
        <NewButton title="Add items to the catalog" items={[
          { key: 'item', label: 'Item', hint: 'One item, with its serial and photo', Icon: Package },
          { key: 'import', label: 'Import From a CSV...', hint: 'Many items at once', Icon: UploadCloud },
        ]} onPick={(k) => (k === 'item' ? onAdd() : onImport())} />
        {/* Export ▾ - two choices (Neil): every item unfiltered (CSV or PDF), or a
            custom report honoring the filters currently applied. */}
        <div style={{ position:'relative' }}>
          <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={() => setExportMenu(o => !o)}>
            <Download size={14} /> Export <ChevronDown size={13} style={{ opacity:.6 }} />
          </button>
          {exportMenu && (
            <>
              {/* click-away backdrop */}
              <div style={{ position:'fixed', inset:0, zIndex:40 }} onClick={() => setExportMenu(false)} />
              <div style={{ position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:41, background:'var(--card)', border:'1px solid var(--line)', borderRadius:10, boxShadow:'var(--shadow-lg)', minWidth:268, overflow:'hidden', padding:5 }}>
                {/* All Items - unfiltered; pick a format */}
                <div style={{ padding:'9px 11px' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:7, fontSize:13, fontWeight:700, color:'var(--ink)' }}><FileSpreadsheet size={14} /> All items (CSV / PDF)</span>
                  <span style={{ display:'block', fontSize:12, color:'var(--muted)', paddingLeft:21, margin:'1px 0 8px' }}>Unfiltered - every item, all {items.length}.</span>
                  <div style={{ display:'flex', gap:7, paddingLeft:21 }}>
                    <button onClick={() => { setExportMenu(false); onExport(items); }}
                      style={{ flex:1, padding:'6px 0', borderRadius:7, border:'1px solid var(--line)', background:'var(--card)', cursor:'pointer', fontFamily:'Inter,sans-serif', fontSize:12, fontWeight:700, color:'var(--ink)' }}
                      onMouseEnter={e => e.currentTarget.style.background='var(--mist)'} onMouseLeave={e => e.currentTarget.style.background='var(--card)'}>CSV</button>
                    <button onClick={() => { setExportMenu(false); onExportAllPdf && onExportAllPdf(); }}
                      style={{ flex:1, padding:'6px 0', borderRadius:7, border:'1px solid var(--line)', background:'var(--card)', cursor:'pointer', fontFamily:'Inter,sans-serif', fontSize:12, fontWeight:700, color:'var(--ink)' }}
                      onMouseEnter={e => e.currentTarget.style.background='var(--mist)'} onMouseLeave={e => e.currentTarget.style.background='var(--card)'}>PDF</button>
                  </div>
                </div>
                <div style={{ height:1, background:'var(--line)', margin:'4px 6px' }} />
                {/* Custom Report - honors the filters currently applied */}
                <button onClick={() => { setExportMenu(false); onReport({ dept: deptFilter, itemType: typeFilter }); }}
                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:1, width:'100%', textAlign:'left', background:'none', border:'none', cursor:'pointer', padding:'9px 11px', borderRadius:7, fontFamily:'Inter,sans-serif' }}
                  onMouseEnter={e => e.currentTarget.style.background='var(--mist)'} onMouseLeave={e => e.currentTarget.style.background='none'}>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:7, fontSize:13, fontWeight:700, color:'var(--ink)' }}><FileBarChart size={14} /> Custom report (PDF / Excel)</span>
                  <span style={{ fontSize:12, color:'var(--muted)', paddingLeft:21 }}>Formatted to the current filters.</span>
                </button>
              </div>
            </>
          )}
        </div>
        {/* Manage ▾ - the admin extras (types, custom fields, deleted items) live
            behind one button instead of crowding the bar. */}
        {(onManageTypes || onManageCustomFields || (canDelete && onShowDeleted)) && (
          <div style={{ position:'relative' }}>
            <button className="secondary-btn" style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={() => setManageMenu(o => !o)}>
              <Settings2 size={14} /> Manage <ChevronDown size={13} style={{ opacity:.6 }} />
            </button>
            {manageMenu && (
              <>
                <div style={{ position:'fixed', inset:0, zIndex:40 }} onClick={() => setManageMenu(false)} />
                <div style={{ position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:41, background:'var(--card)', border:'1px solid var(--line)', borderRadius:10, boxShadow:'var(--shadow-lg)', minWidth:210, overflow:'hidden', padding:5 }}>
                  {[
                    onManageTypes        && { icon: Tag,         label: 'Manage Types',      onClick: onManageTypes },
                    onManageCustomFields && { icon: Plus,        label: 'Add Custom Field',  onClick: onManageCustomFields },
                    canDelete && onShowDeleted && { icon: Trash2, label: 'Recycle Bin',      onClick: onShowDeleted },
                  ].filter(Boolean).map(({ icon: MIcon, label, onClick }) => (
                    <button key={label} onClick={() => { setManageMenu(false); onClick(); }}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left', background:'none', border:'none', cursor:'pointer', padding:'9px 11px', borderRadius:7, fontFamily:'Inter,sans-serif', fontSize:13, fontWeight:600, color:'var(--ink)' }}
                      onMouseEnter={e => e.currentTarget.style.background='var(--mist)'} onMouseLeave={e => e.currentTarget.style.background='none'}>
                      <MIcon size={14} style={{ color:'var(--muted)' }} /> {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {/* Batch Edit - one feature, two tabs (Fields / Photos). Only available
            once rows are ticked (Neil: never act on everything by default). The
            "select all" header checkbox + Batch Edit covers the whole-list case.
            (AI photo fill lives inside the Photos tab.) */}
        {selected.size > 0 && (
          <button className="primary-btn" onClick={() => { setBatchTab('fields'); setBatchOpen(true); }}
            title={`Batch edit the ${selItems.length} selected item${selItems.length !== 1 ? 's' : ''}`}
            style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
            <Pencil size={14} /> Batch Edit ({selItems.length})
          </button>
        )}
        {/* QR tags for the ticked rows (Items phase 4, Neil 11/02/2026). */}
        {onPrintTags && selected.size > 0 && (
          <button className="secondary-btn" onClick={() => onPrintTags(selItems)}
            style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
            <QrCode size={14} /> Print Tags ({selItems.length})
          </button>
        )}
        {/* Assignment moved INTO Batch Edit (Neil) - no separate Assign button. */}
        {/* Batch delete */}
        {canDelete && selected.size > 0 && (
          <button className="secondary-btn" onClick={() => setBatchDeleteConfirm(true)}
            style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
            <Trash2 size={14} /> Delete {selected.size}
          </button>
        )}
        {(missingPhotos > 0 || missingOnly) && (
          <button type="button" className={`it-chip${missingOnly ? ' is-on' : ''}`} aria-pressed={missingOnly}
            onClick={() => setMissingOnly(v => !v)} style={{ marginLeft:'auto' }}>
            <ImageOff size={13} /> Missing Photo <span className="it-chip-n">{missingPhotos}</span>
          </button>
        )}
      </div>

      {itemsLoading && !items.length ? (
        <SkeletonBlocks count={8} height={52} borderRadius={8} />
      ) : sorted.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          {items.length ? 'No items match your filters.' : 'No items yet. Add one above or import a CSV.'}
        </div>
      ) : isMobile ? (
        /* Phone layout: one card per item - name, badges and actions all
           visible without sideways scrolling (the "Add/Edit is hiding" bug) */
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {/* Select all - lives in the table header on desktop, which cards don't have */}
          <label style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 14px', cursor:'pointer', userSelect:'none' }}>
            <input type="checkbox"
              checked={selected.size === filtered.length && filtered.length > 0}
              ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < filtered.length; }}
              onChange={toggleAll}
              style={{ cursor:'pointer', accentColor:'var(--pine)', flexShrink:0 }} />
            <span style={{ fontSize:12, fontWeight:600, color:'var(--muted)' }}>
              {selected.size > 0 ? `${selected.size} of ${filtered.length} selected` : `Select all (${filtered.length})`}
            </span>
          </label>
          {sorted.map(item => (
            <ManageCard key={item.id} item={item} isSelected={selected.has(item.id)} highlight={flashId === item.id} overdue={!!overdueIds?.has(item.id)}
              onToggle={toggleSelect} onEdit={onEdit} onDelete={onDelete} onAssign={onAssign}
              onDetails={onDetails} onPreview={setPhotoPreview} canDelete={canDelete} />
          ))}
        </div>
      ) : (
        <div ref={scrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
          style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto', background:'var(--card)', maxHeight:'70vh' }}>
          <table style={{ width:'100%', minWidth:880, borderCollapse:'collapse', fontSize:13 }}>
            <thead style={{ position:'sticky', top:0, zIndex:2 }}>
              <tr style={{ background:'var(--mist)' }}>
                <th style={{ padding:'10px 14px', width:36, background:'var(--mist)' }}>
                  <input type="checkbox"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < filtered.length; }}
                    onChange={toggleAll}
                    aria-label="Select all shown"
                    style={{ cursor:'pointer', accentColor:'var(--wk-brand)' }} />
                </th>
                <SortTh col="name" label="Item" />
                <SortTh col="serial" label="Serial" />
                <SortTh col="type" label="Type" />
                <SortTh col="dept" label="Department" />
                <SortTh col="location" label="Location" />
                <SortTh col="status" label="Status" />
                <th style={{ padding:'10px 14px', position:'sticky', right:0, background:'var(--mist)' }}></th>
              </tr>
            </thead>
            <tbody>
              {/* Spacer for the rows scrolled past above the viewport */}
              {padTop > 0 && <tr aria-hidden="true"><td colSpan={8} style={{ height:padTop, padding:0, border:'none' }} /></tr>}
              {vSlice.map(item => (
                <ManageRow key={item.id} item={item} isSelected={selected.has(item.id)} highlight={flashId === item.id} overdue={!!overdueIds?.has(item.id)}
                  onToggle={toggleSelect} onEdit={onEdit} onDelete={onDelete} onAssign={onAssign}
                  onDetails={onDetails} onPreview={setPhotoPreview} canDelete={canDelete} />
              ))}
              {/* Spacer for the rows still below the viewport */}
              {padBot > 0 && <tr aria-hidden="true"><td colSpan={8} style={{ height:padBot, padding:0, border:'none' }} /></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize:12, color:'var(--muted)', marginTop:10 }}>
        {sorted.length} item{sorted.length !== 1 ? 's' : ''} shown · {items.length} total
        {selected.size > 0 && <> · <strong>{selected.size} selected</strong></>}
      </p>

      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
      {batchOpen && batchTab === 'fields' && (
        <BatchEditModal
          selectedItems={batchScope}
          usingSelection={usingSelection}
          onSwitchTab={setBatchTab}
          onClose={() => setBatchOpen(false)}
          onSave={executeBatchEdit} saving={batchEditing}
          locations={[...new Set(items.map(i => i.location).filter(Boolean))].sort()} types={itemTypes} />
      )}
      {batchOpen && batchTab === 'photos' && (
        <BatchPhotoModal
          items={batchScope}
          usingSelection={usingSelection}
          onSwitchTab={setBatchTab}
          onClose={() => setBatchOpen(false)} onUpdate={refreshItems} toast={toast} />
      )}
      {batchDeleteConfirm && (
        <BatchDeleteConfirmModal
          selectedItems={selItems} blockedItems={blockedItems}
          onClose={() => setBatchDeleteConfirm(false)}
          onConfirm={executeBatchDelete} deleting={batchDeleting} />
      )}
    </>
  );
});
