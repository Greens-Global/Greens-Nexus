// Item Management - The employee screen: home, catalog, My Checkouts and handovers.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, useMemo, useDeferredValue, memo } from 'react';
import { Package, Plus, Search, RotateCcw, Camera, X, MapPin, ClipboardList, ShoppingCart, Box, ArrowLeft, ChevronRight, LayoutGrid, Settings2 } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import ModuleTabs from '../components/ModuleTabs';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { useAssignments } from '../components/Assignments';
import { ITEM_TYPES, TYPE_META, displayStatus } from './model/status';
import { sortItemsBy } from './model/sort';
import { TypeBadge, StatusBadge } from './ui/badges';
import { SortableTh } from './ui/SortableTh';
import { CartDrawer } from './ui/CartDrawer';
import { ReturnModal } from './checkout/ReturnModal';
import { runBatchReRequest } from './checkout/batchReRequest';
import { AllocateModal } from './checkout/AllocateModal';
import { MyCheckoutsPanel } from './checkout/MyCheckoutsPanel';
import { ItemPhotoGrid } from './catalog/ItemPhotoGrid';

// ── Employee View ─────────────────────────────────────────────────────────────
export const EmployeeView = memo(function EmployeeView({ items, checkouts, activeSub, userName, userEmail, itemsLoading, itemsError, onReturn, refreshItems, refreshCheckouts, submitCartCheckouts, cancelRequest, allocateItem, initiateHandover, confirmReceipt, toast, showManage = false, onEnterManage }) {
  const { assignments, refreshAssignments } = useAssignments();
  const { can } = useRole();
  // Supervisors (level 2) are ALLOCATORS, not managers: they don't approve, but
  // they hand over items a manager assigned to them. Managers (level 3+) never
  // reach this view. (Jun 16: allocators were stuck in the employee view with no
  // way to do handovers.)
  const isAllocator = can?.('supervisor');
  const [tab,            setTab]            = useState('catalog');
  const [mode,           setMode]           = useState('home');

  // Deep-link from notifications: 'myitems'/'checkouts' lands on My Checkouts,
  // 'catalog' on the catalog - skipping the home screen.
  useEffect(() => {
    if (activeSub === 'handover')                                { setMode('catalog'); setTab('handover'); }
    else if (['myitems','checkouts','permanent','active-checkouts'].includes(activeSub)) { setMode('catalog'); setTab('checkouts'); }
    else if (activeSub === 'catalog')                            { setMode('catalog'); setTab('catalog'); }
  }, [activeSub]);
  // Window event covers repeat clicks where activeSub doesn't change value
  useEffect(() => {
    const h = e => {
      const { view, sub } = e.detail || {};
      if (view !== 'inventory') return;
      if (sub === 'handover')                                { setMode('catalog'); setTab('handover'); }
      else if (['myitems','checkouts','permanent','active-checkouts'].includes(sub)) { setMode('catalog'); setTab('checkouts'); }
      else if (sub === 'catalog')                             { setMode('catalog'); setTab('catalog'); }
    };
    window.addEventListener('nexus:navigate', h);
    return () => window.removeEventListener('nexus:navigate', h);
  }, []);
  const [viewMode,       setViewMode]       = useState('tile');
  const [catalogSort,    setCatalogSort]    = useState({ key: null, dir: 'asc' });
  const [search,         setSearch]         = useState('');
  const [typeFilter,     setTypeFilter]     = useState('All');
  const [locationFilter, setLocationFilter] = useState('All');
  const [cartOpen,       setCartOpen]       = useState(false);
  const [cart,           setCart]           = useState([]);
  const [returningCo,    setReturningCo]    = useState(null);
  const [allocatingCo,   setAllocatingCo]   = useState(null);
  const [submitting,     setSubmitting]     = useState(false);

  // Items a manager assigned to ME to hand over (I'm the allocator), still
  // awaiting handover. This is the allocator's work queue.
  const myAllocations = useMemo(() =>
    checkouts.filter(c => (c.assignedAllocatorEmail || '').toLowerCase() === userEmail && c.status === 'approved'),
    [checkouts, userEmail]);

  // Mirrors the manager's handover: either the allocator uploads the photo now,
  // or hands over and asks the employee to confirm receipt with a photo.
  function handleAllocate(co, { photoBy, batch, photoMap }) {
    const p = photoBy === 'employee'
      ? initiateHandover(co.id, userName)
      : allocateItem(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: batch });
    return p.then(() => {
      toast(photoBy === 'employee'
        ? `${co.requestedBy} has been notified to confirm receipt.`
        : `Item handed over to ${co.requestedBy} - checkout confirmed.`);
      refreshItems(); refreshCheckouts();
    });
  }

  useEffect(() => {
    api.getItemCart().then(rows => {
      setCart(rows.map(r => ({ id: r.id, item: { id: r.itemId, name: r.itemName, itemType: r.itemType }, days: 1 })));
    }).catch(() => {});
  }, []);

  const myCheckouts     = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName
  );
  const activeCheckouts = myCheckouts.filter(c => ['pending','approved','pending_receipt','allocated'].includes(c.status));
  const allTransient    = useMemo(() => items.filter(i => i.ownershipType === 'transient'), [items]);
  // Items flagged picture_required=false - every photo step for them is optional
  const photoOptionalIds = useMemo(() => new Set(items.filter(i => i.pictureRequired === false).map(i => i.id)), [items]);
  const availableItems  = allTransient.filter(i => i.status === 'available');
  const inCart          = new Set(cart.map(c => c.item.id));

  // Derive location list from all transient items (not just available)
  const locations = ['All', ...Array.from(new Set(allTransient.map(i => i.location).filter(Boolean))).sort()];

  // Deferred so the input stays responsive while the grid re-filters at low priority
  const deferredSearch = useDeferredValue(search);
  const filteredItems = useMemo(() => allTransient.filter(i => {
    const q = deferredSearch.toLowerCase();
    const ms = !deferredSearch || i.name.toLowerCase().includes(q) ||
      (i.make||'').toLowerCase().includes(q) ||
      (i.model||'').toLowerCase().includes(q);
    const mt = typeFilter     === 'All' || i.itemType === typeFilter;
    const ml = locationFilter === 'All' || i.location === locationFilter;
    return ms && mt && ml;
  }), [allTransient, deferredSearch, typeFilter, locationFilter]);

  function addToCart(item) {
    if (inCart.has(item.id)) return;
    const optimisticId = `cart-${Date.now()}`;
    setCart(prev => [...prev, { id: optimisticId, item, days: 1 }]);
    api.addItemToCart({ item_id: item.id, item_name: item.name, item_type: item.itemType })
      .then(saved => setCart(prev => prev.map(c => c.id === optimisticId ? { id: saved.id, item, days: 1 } : c)))
      .catch(err => {
        setCart(prev => prev.filter(c => c.id !== optimisticId));
        toast(err?.message || 'Could not add item to cart.', 'error');
      });
  }

  function removeFromCart(cartId) {
    const entry = cart.find(c => c.id === cartId);
    setCart(prev => prev.filter(c => c.id !== cartId));
    if (entry) api.removeItemFromCart(entry.item.id).catch(() => {});
  }
  // Catalog cards only know the item, not its cart row id - resolve it here so
  // the "In cart" pill on the card can double as a remove button (Pranshu: it
  // was just a disabled label before, no way back off the cart from the card).
  function removeFromCartByItemId(itemId) {
    const entry = cart.find(c => c.item.id === itemId);
    if (entry) removeFromCart(entry.id);
  }

  function handleDaysChange(cartId, days) {
    setCart(prev => prev.map(c => c.id === cartId ? { ...c, days } : c));
  }

  async function handleSubmitCart({ reason, approverEmail, approverName, forName = '', forEmail = '' }) {
    setSubmitting(true);
    const results = await submitCartCheckouts(cart, { reason, raisedBy: userName, raisedByEmail: userEmail, forName, forEmail, approverEmail, approverName });
    const succeededItems = cart.filter((_, i) => results[i].status === 'fulfilled');
    const failedItems    = cart.filter((_, i) => results[i].status === 'rejected');
    await Promise.all(succeededItems.map(c => api.removeItemFromCart(c.item.id).catch(() => {})));
    setSubmitting(false);
    setCartOpen(false);
    setCart(failedItems);
    if (succeededItems.length > 0) {
      toast(`${succeededItems.length} checkout request${succeededItems.length !== 1 ? 's' : ''} submitted.`);
      // Land on My Checkouts → Active so the fresh order + progress trackers
      // are immediately in view (no wondering whether the submit worked)
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'active-checkouts' } }));
    }
    if (failedItems.length > 0) {
      const allConflict = results.filter(r => r.status === 'rejected').every(r => r.reason?.message?.includes('active checkout'));
      toast(
        <div>
          <div style={{ fontWeight:700, marginBottom:5 }}>
            {failedItems.length} item{failedItems.length !== 1 ? 's' : ''} couldn't be submitted
          </div>
          <ul style={{ margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:2 }}>
            {failedItems.map((c, i) => <li key={i} style={{ fontSize:12 }}>{c.item.name}</li>)}
          </ul>
          {allConflict && <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:5 }}>Each already has an active checkout request.</div>}
        </div>,
        'error'
      );
    }
  }

  function handleReturn(co) { setReturningCo(co); }
  function handleReturnSubmit(data) {
    return onReturn(returningCo.id, data).then(() => {
      toast(`Return confirmed - ${returningCo.itemName}`);
      setReturningCo(null);
    }).catch(() => toast('Could not confirm return - please try again.', 'error'));
  }
  function handleCancel(co, opts = {}) {
    return cancelRequest(co.id, userName)
      .then(() => { if (!opts.silent) toast('Checkout cancelled.'); })
      .catch(() => { if (!opts.silent) toast('Could not cancel.', 'error'); });
  }
  async function handleReRequest(co, newReason) {
    try {
      await api.createItemCheckout({
        id: crypto.randomUUID(),
        item_id: co.itemId, item_name: co.itemName, item_type: co.itemType,
        requested_by: co.requestedBy, requested_by_email: co.requestedByEmail || userEmail,
        raised_by: userName, department: co.department, days: co.days || 1,
        reason: newReason,
        order_id: co.orderId || null,            // rejoin the original order, not a new solo card
        approver_email: co.approverEmail || '', approver_name: co.approverName || '',
      });
      toast(`Re-submitted request for ${co.itemName}.`);
      if (refreshCheckouts) refreshCheckouts();
    } catch (err) {
      toast(err?.message || `Could not re-submit request for ${co.itemName}.`, 'error');
      throw err; // panel must not clear the rejected card on failure
    }
  }
  const handleBatchReRequest = (cos, vals) =>
    runBatchReRequest(cos, vals, { submitCartCheckouts, userName, userEmail, toast });

  // ── Home screen ─────────────────────────────────────────────────────────────
  if (mode === 'home') {
    return (
      <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
        <div style={{ marginBottom:32 }}>
          <h2 style={{ fontSize:20, fontWeight:700, margin:'0 0 4px' }}>Item Management</h2>
          <p style={{ fontSize:13, color:'var(--muted)', margin:0 }}>What would you like to do today?</p>
        </div>
        {(() => {
          // Neil: top row groups the "do something with items" actions and spans the full
          // width (no maxWidth cap, no compression). Purchase Request moved to Workday
          // (Neil, Oct 22 2026), so its card is gone from here.
          const renderCard = ({ Icon, colorVar, title, sub, go, badge }) => (
            <button key={title} onClick={go}
              style={{ display:'flex', alignItems:'flex-start', gap:16, padding:'20px 20px', borderRadius:14, border:'1px solid var(--line)', background:'var(--card)', cursor:'pointer', textAlign:'left', fontFamily:'Inter,sans-serif', transition:'box-shadow 0.15s', boxShadow:'var(--shadow-sm)', position:'relative' }}
              onMouseEnter={e => e.currentTarget.style.boxShadow='var(--shadow-md)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow='var(--shadow-sm)'}>
              <div style={{ width:46, height:46, borderRadius:12, background:`hsla(var(--${colorVar}),0.12)`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <Icon size={22} color={`hsl(var(--${colorVar}))`} />
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:15, color:'var(--ink)', marginBottom:4 }}>
                  {title}
                  {badge > 0 && <span style={{ marginLeft:8, padding:'1px 8px', borderRadius:20, fontSize:11, fontWeight:700, background:`hsla(var(--${colorVar}),0.12)`, color:`hsl(var(--${colorVar}))` }}>{badge} active</span>}
                </div>
                <div style={{ fontSize:12.5, color:'var(--muted)', lineHeight:1.5 }}>{sub}</div>
              </div>
              <ChevronRight size={16} color="var(--muted)" style={{ flexShrink:0, alignSelf:'center' }} />
            </button>
          );
          const topCards = [
            { Icon:ShoppingCart,  colorVar:'color-green',  title:'Check Out an Item',      sub:'Browse available equipment and raise a checkout request.',                                                                          go:() => { setMode('catalog'); setTab('catalog'); },   badge:null },
            // Covers BOTH return and extend, so the title says so (UX-030).
            { Icon:RotateCcw,     colorVar:'color-blue',   title:'Return or Extend', sub:activeCheckouts.length > 0 ? `${activeCheckouts.length} item${activeCheckouts.length!==1?'s':''} currently checked out.` : 'Return equipment you have, or ask for more time.', go:() => { setMode('catalog'); setTab('checkouts'); }, badge:activeCheckouts.length||null },
            // Managers get a Manage card right on the home screen (Neil: no way in from here).
            ...(showManage && onEnterManage ? [{ Icon:Box, colorVar:'color-purple', title:'Manage Items', sub:'Add, edit, assign, import, types and the activity log - the full management tools.', go:onEnterManage, badge:null }] : []),
          ];
          // All actions in one responsive grid so every card is the same size.
          return (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))', gap:16, marginBottom:cart.length ? 28 : 0 }}>
              {topCards.map(renderCard)}
            </div>
          );
        })()}
        {cart.length > 0 && (
          <div style={{ padding:'14px 18px', borderRadius:12, border:'1px solid hsla(var(--color-green),0.3)', background:'hsla(var(--color-green),0.06)', display:'flex', alignItems:'center', gap:12, maxWidth:520, marginTop:24 }}>
            <ShoppingCart size={16} color="hsl(var(--color-green))" style={{ flexShrink:0 }} />
            <span style={{ fontSize:13, fontWeight:600, color:'var(--ink)', flex:1 }}>{cart.length} item{cart.length!==1?'s':''} waiting in your cart</span>
            <button className="primary-btn" onClick={() => setCartOpen(true)} style={{ fontSize:12, padding:'6px 14px', flexShrink:0 }}>View Cart</button>
          </div>
        )}
        <CartDrawer open={cartOpen} cart={cart} items={items} onClose={() => setCartOpen(false)} onRemove={removeFromCart} onSubmit={handleSubmitCart} submitting={submitting} onDaysChange={handleDaysChange} showApprover />
      </div>
    );
  }

  // ── Catalog / Checkouts view ─────────────────────────────────────────────────
  return (
    <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Back-to-home + cart row. The cart MUST live outside the .scroll-tabs
          strip: that strip is position:sticky on phones, which makes it the
          containing block for the absolutely-pinned .header-cart and the cart
          ends up overlapping the tabs. Keeping it here pins it to the viewport,
          same as the manager view. minHeight reserves the pinned cart's zone. */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:18, minHeight:40 }}>
        <button onClick={() => setMode('home')}
          style={{ display:'inline-flex', alignItems:'center', gap:6, background:'none', border:'none', cursor:'pointer', color:'var(--muted)', fontSize:13, fontFamily:'Inter,sans-serif', padding:'4px 0', transition:'color 0.15s' }}
          onMouseEnter={e => e.currentTarget.style.color='var(--ink)'}
          onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}>
          <ArrowLeft size={14} /> Back to Home
        </button>
        <button onClick={() => setCartOpen(true)}
          className="header-cart"
          style={{ display:'inline-flex', alignItems:'center', gap:7, position:'relative', fontSize:14.5, fontWeight:700, padding:'10px 22px', background:'#000', color:'#fff', border:'1px solid #000', borderRadius:9, cursor:'pointer', fontFamily:'Inter,sans-serif', flexShrink:0 }}>
          <ShoppingCart size={17} /> Cart
          {cart.length > 0 && <span style={{ position:'absolute', top:-7, right:-1, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:17, height:17, fontSize:10, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>{cart.length}</span>}
        </button>
      </div>

      {/* Tab strip - desktop renders it centered in the top header; phones
          keep the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs
        tabs={[
          { key:'catalog',   label:'Browse Catalog', Icon: Package },
          { key:'checkouts', label:'My Checkouts',   Icon: ClipboardList, badge: activeCheckouts.length || null },
          ...(isAllocator ? [{ key:'handover', label:'To Hand Over', Icon: Camera, badge: myAllocations.length || null }] : []),
        ]}
        active={tab} onChange={setTab} />
      {/* Managers get a big Manage button that opens the full management UI
          (Neil). It used to ride the tab strip row; with the tabs in the
          header it gets its own right-aligned row. */}
      {showManage && onEnterManage && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
          <button className="primary-btn" onClick={onEnterManage} title="Open the management tools">
            <Settings2 size={14} /> Manage
          </button>
        </div>
      )}

      {/* ── CATALOG TAB ── */}
      {tab === 'catalog' && (
        <div style={{ paddingBottom: cart.length ? 80 : 0 }}>
          <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:20 }}>
            <div className="search-bar" style={{ width:'100%' }}>
              <Search size={14} style={{ flexShrink:0 }} />
              <input placeholder="Search by name, make, or model…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
              {search && <button className="search-clear" onClick={() => setSearch('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
            </div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                {['All', ...ITEM_TYPES].map(t => {
                  const active = typeFilter === t;
                  return (
                    <button key={t} onClick={() => setTypeFilter(t)}
                      style={{ padding:'5px 14px', borderRadius:20, border:`1px solid ${active ? 'var(--pine)' : 'var(--line)'}`, background: active ? 'var(--pine)' : 'var(--card)', color: active ? '#fff' : 'var(--ink)', fontSize:12.5, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif', transition:'all 0.15s' }}>
                      {t}
                    </button>
                  );
                })}
                <span style={{ fontSize:12.5, color:'var(--muted)', alignSelf:'center', marginLeft:4 }}>
                  {filteredItems.filter(i => i.status === 'available').length} available · {filteredItems.length} total
                </span>
              </div>
              {/* Tile/List toggle shows on phones too - list is a horizontally
                  scrollable table, reachable in portrait now (Neil, Jun 16) */}
              <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                <button onClick={() => setViewMode('tile')}
                  style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode==='tile' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode==='tile' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode==='tile' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                  <LayoutGrid size={13} /> Tile
                </button>
                <button onClick={() => setViewMode('list')}
                  style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:8, border:`1px solid ${viewMode==='list' ? 'var(--pine)' : 'var(--line)'}`, background: viewMode==='list' ? 'hsla(var(--color-green),0.1)' : 'transparent', color: viewMode==='list' ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                  <ClipboardList size={13} /> List
                </button>
              </div>
            </div>
            {locations.length > 2 && (
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                <MapPin size={13} style={{ color:'var(--muted)', flexShrink:0 }} />
                {locations.map(loc => {
                  const active = locationFilter === loc;
                  return (
                    <button key={loc} onClick={() => setLocationFilter(loc)}
                      style={{ padding:'4px 12px', borderRadius:20, border:`1px solid ${active ? 'hsl(var(--color-blue))' : 'var(--line)'}`, background: active ? 'hsla(var(--color-blue),0.1)' : 'transparent', color: active ? 'hsl(var(--color-blue))' : 'var(--muted)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif', transition:'all 0.15s' }}>
                      {loc}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {(viewMode === 'tile') ? (
            <ItemPhotoGrid
              items={filteredItems} checkouts={checkouts}
              itemsLoading={itemsLoading} itemsError={itemsError}
              refreshItems={refreshItems} onAddToCart={addToCart} onRemoveFromCart={removeFromCartByItemId} inCart={inCart}
              emptyLabel={search || typeFilter !== 'All' || locationFilter !== 'All' ? 'No items match your search.' : 'No items available.'}
            />
          ) : (
            itemsError ? <ErrorBanner message="Could not load items." onRetry={refreshItems} /> :
            itemsLoading && !filteredItems.length ? <SkeletonBlocks count={6} height={48} borderRadius={8} /> :
            filteredItems.length === 0 ? (
              <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
                <Package size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
                {search || typeFilter !== 'All' || locationFilter !== 'All' ? 'No items match your search.' : 'No items available.'}
              </div>
            ) : (
              <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto', marginBottom:20 }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'var(--mist)' }}>
                      <th style={{ textAlign:'left', padding:'9px 14px', fontWeight:700, color:'var(--muted)', fontSize:10.5, textTransform:'uppercase', letterSpacing:'.07em', whiteSpace:'nowrap' }}>Photo</th>
                      <SortableTh label="Name"     colKey="name"     sort={catalogSort} onSort={setCatalogSort} />
                      <SortableTh label="Type"     colKey="type"     sort={catalogSort} onSort={setCatalogSort} />
                      <SortableTh label="Make"     colKey="make"     sort={catalogSort} onSort={setCatalogSort} />
                      <SortableTh label="Model"    colKey="model"    sort={catalogSort} onSort={setCatalogSort} />
                      <SortableTh label="Location" colKey="location" sort={catalogSort} onSort={setCatalogSort} />
                      <SortableTh label="Status"   colKey="status"   sort={catalogSort} onSort={setCatalogSort} />
                      <th style={{ padding:'9px 14px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortItemsBy(filteredItems, catalogSort.key, catalogSort.dir).slice(0, 200).map(item => {
                      const tm = TYPE_META[item.itemType] || TYPE_META.Other;
                      const alreadyInCart = inCart.has(item.id);
                      const hasPending = item.status==='available' && (
                        checkouts.some(c => ['pending','approved','pending_receipt'].includes(c.status) && c.itemId===item.id) ||
                        !!item.hasActiveRequest // server flag - covers other users' requests employees can't see
                      );
                      const canAdd = item.status==='available' && !hasPending && item.ownershipType==='transient';
                      return (
                        <tr key={item.id} style={{ borderTop:'1px solid var(--line)', opacity: item.status==='available'&&!hasPending ? 1 : 0.65 }}>
                          <td style={{ padding:'8px 14px' }}>
                            {item.photoUrl
                              ? <img src={item.photoUrl} alt={item.name} loading="lazy" decoding="async" style={{ width:44, height:44, borderRadius:10, objectFit:'cover', border:'1px solid var(--line)' }} />
                              : <div style={{ width:44, height:44, borderRadius:10, background:tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}><tm.Icon size={21} color={tm.color} /></div>}
                          </td>
                          <td style={{ padding:'8px 14px', fontWeight:600 }}>{item.name}</td>
                          <td style={{ padding:'8px 14px' }}><TypeBadge type={item.itemType} /></td>
                          <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.make||'-'}</td>
                          <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.model||'-'}</td>
                          <td style={{ padding:'8px 14px', color:'var(--muted)', fontSize:12 }}>{item.location||'-'}</td>
                          <td style={{ padding:'8px 14px' }}><StatusBadge status={hasPending ? 'under_review' : displayStatus(item)} item={item} /></td>
                          <td style={{ padding:'8px 14px' }}>
                            {canAdd && (
                              <button onClick={() => alreadyInCart ? removeFromCartByItemId(item.id) : addToCart(item)}
                                className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                                style={{ fontSize:12, padding:'5px 12px', display:'inline-flex', alignItems:'center', gap:5 }}>
                                {alreadyInCart ? <><X size={11} /> Remove</> : <><Plus size={11} /> Add</>}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredItems.length > 200 && (
                      <tr><td colSpan={20} style={{ padding:'10px 14px', fontSize:12, color:'var(--muted)', textAlign:'center' }}>Showing 200 of {filteredItems.length} items - search or filter to narrow down.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          )}

          {cart.length > 0 && (
            <div style={{ position:'fixed', bottom:0, left:0, right:0, background:'var(--pine)', padding:'14px 24px', zIndex:200, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, boxShadow:'0 -4px 24px rgba(0,0,0,0.18)' }}>
              <div style={{ color:'#fff' }}>
                <span style={{ fontWeight:700, fontSize:15 }}>{cart.length} item{cart.length!==1?'s':''} in cart</span>
                <div style={{ fontSize:12, opacity:.8, marginTop:1 }}>Ready to submit your request</div>
              </div>
              <button onClick={() => setCartOpen(true)}
                style={{ background:'#fff', color:'var(--pine)', border:'none', borderRadius:10, padding:'10px 20px', fontWeight:700, fontSize:14, cursor:'pointer', display:'flex', alignItems:'center', gap:8, fontFamily:'Inter,sans-serif', flexShrink:0 }}>
                Review & Submit <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── MY CHECKOUTS TAB ── */}
      {tab === 'checkouts' && (
        <div>
          {/* P0-5: mount the panel (which holds the Permanent tab where assignments
              are accepted) whenever the user has EITHER checkouts OR assignments -
              today's acceptance banner deep-links here and must not dead-end. */}
          {myCheckouts.length === 0 && !assignments.some(a => a.assigneeEmail === userEmail) ? (
            <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--muted)' }}>
              <Package size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
              <div style={{ fontWeight:600, fontSize:15, marginBottom:6 }}>No checkouts yet</div>
              <div style={{ fontSize:13, marginBottom:20 }}>Browse the catalog to check out equipment.</div>
              <button className="primary-btn" onClick={() => setTab('catalog')} style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                <Package size={14} /> Browse Catalog
              </button>
            </div>
          ) : (
            <MyCheckoutsPanel
              checkouts={checkouts} userEmail={userEmail} userName={userName} activeSub={activeSub}
              photoOptionalIds={photoOptionalIds}
              assignments={assignments} refreshAssignments={refreshAssignments} toast={toast}
              onReturn={handleReturn} onCancel={handleCancel} onReRequest={handleReRequest}
              onBatchReRequest={handleBatchReRequest}
              onConfirmReceipt={confirmReceipt ? (co, batch, photoMap) =>
                confirmReceipt(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '')
                  .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); })
              : undefined}
              onReturnAll={async (items, data) => {
                // P1-5: count real successes/failures instead of always claiming all N returned.
                let ok = 0, failed = 0;
                for (const c of items) {
                  try { await onReturn(c.id, data); ok++; } catch { failed++; }
                }
                refreshCheckouts && refreshCheckouts();
                if (failed === 0) toast(`Returned ${ok} item${ok !== 1 ? 's' : ''}.`);
                else toast(`Returned ${ok} · ${failed} failed.`, 'error');
              }}
              onRequestExtension={(co, days, reason) =>
                api.requestItemExtension(co.id, { days, reason })
                  .then(() => { toast(`Extension requested for ${co.itemName} - awaiting approval.`); refreshCheckouts && refreshCheckouts(); })
              }
            />
          )}
        </div>
      )}

      {/* ── TO HAND OVER TAB (allocators / supervisors) ── */}
      {tab === 'handover' && (
        <div>
          {myAllocations.length === 0 ? (
            <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--muted)' }}>
              <Camera size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
              <div style={{ fontWeight:600, fontSize:15, marginBottom:6 }}>Nothing to hand over</div>
              <div style={{ fontSize:13 }}>Items a manager assigns you to hand over will appear here.</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {myAllocations.map(co => {
                const item = items.find(i => i.id === co.itemId);
                return (
                  <div key={co.id} className="co-row" style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', border:'1px solid var(--line)', borderRadius:12, padding:'12px 16px', background:'var(--card)', boxShadow:'var(--shadow-sm)' }}>
                    {item?.photoUrl
                      ? <img src={item.photoUrl} alt={co.itemName} loading="lazy" decoding="async" style={{ width:44, height:44, borderRadius:10, objectFit:'cover', border:'1px solid var(--line)', flexShrink:0 }} />
                      : <div style={{ width:44, height:44, borderRadius:10, background:'var(--mist)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}><Package size={18} style={{ opacity:.4 }} /></div>}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:13 }}>{co.itemName}</div>
                      <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:1 }}>
                        For {co.requestedBy} · {co.itemType} · {co.days} day{co.days !== 1 ? 's' : ''}
                      </div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                      <span style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'2px 8px', borderRadius:20, fontSize:10.5, fontWeight:800, background:'hsla(var(--color-blue),0.12)', color:'hsl(var(--color-blue))' }}>Awaiting Handover</span>
                      <button className="primary-btn" style={{ fontSize:12, display:'inline-flex', alignItems:'center', gap:5, background:'hsl(var(--color-orange))' }} onClick={() => setAllocatingCo(co)}>
                        <Camera size={12} /> Hand Over
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <CartDrawer
        open={cartOpen} cart={cart} items={items}
        onClose={() => setCartOpen(false)}
        onRemove={removeFromCart}
        onSubmit={handleSubmitCart}
        submitting={submitting}
        onDaysChange={handleDaysChange}
        showApprover
      />
      {returningCo && <ReturnModal checkout={returningCo} photoOptional={photoOptionalIds.has(returningCo.itemId)} onClose={() => setReturningCo(null)} onSubmit={handleReturnSubmit} />}
      {allocatingCo && (
        <AllocateModal checkout={allocatingCo} onClose={() => setAllocatingCo(null)}
          photoOptional={photoOptionalIds.has(allocatingCo.itemId)}
          onConfirm={payload => handleAllocate(allocatingCo, payload)} />
      )}
    </div>
  );
});
