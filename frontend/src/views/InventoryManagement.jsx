import { useState, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import { Package, AlertCircle, ClipboardList, History, ShoppingCart, Filter, ArrowLeft, ChevronRight, Users, User } from 'lucide-react';
import { SkeletonBlocks } from '../components/AsyncState';
import ModuleTabs from '../components/ModuleTabs';
import { useInventory } from '../contexts/InventoryContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { useMsal } from '@azure/msal-react';
import { cleanName } from '../lib/utils';
import { useAssignments, AssignItemModal } from '../components/Assignments';
import { ITEM_TYPES, displayStatus, DEPARTMENTS } from '../inventory/model/status';
import { cleanField } from '../inventory/model/fields';
import { fmtMoney } from '../inventory/model/format';
import { triggerDownload, downloadItemsCsv } from '../inventory/model/csv';
import { diffItemEdit } from '../inventory/model/itemEdit';
import { Toast } from '../inventory/ui/Toast';
import { CartDrawer } from '../inventory/ui/CartDrawer';
import { ReturnModal } from '../inventory/checkout/ReturnModal';
import { runBatchReRequest } from '../inventory/checkout/batchReRequest';
import { MyCheckoutsPanel } from '../inventory/checkout/MyCheckoutsPanel';
import { ManagerCheckoutsTab } from '../inventory/checkout/ManagerCheckoutsTab';
import { ManagerCatalogTab } from '../inventory/catalog/ManagerCatalogTab';
import { EmployeeView } from '../inventory/EmployeeView';
import { AddItemModal } from '../inventory/manage/AddItemModal';
import { EditItemModal } from '../inventory/manage/EditItemModal';
import { DeleteItemModal } from '../inventory/manage/DeleteItemModal';
import { ImportItemsModal } from '../inventory/manage/ImportItemsModal';
import { ReportModal } from '../inventory/manage/ReportModal';
import { ItemDetailsPanel } from '../inventory/manage/ItemDetailsPanel';
import { DeletedItemsModal } from '../inventory/manage/DeletedItemsModal';
import { ManagerManageTab } from '../inventory/manage/ManagerManageTab';
import { OverdueAlertModal } from '../inventory/admin/OverdueAlertModal';
import { WhoHasItTab } from '../inventory/whohas/WhoHasItTab';
import { AuditLogPanel } from '../inventory/audit/AuditLogPanel';

// Borrowed by other modules (asset/App.jsx, components/PurchaseRequests.jsx,
// views/AdminConsole.jsx) and their tests - keep these re-exports.
export { AddItemModal } from '../inventory/manage/AddItemModal';
export { ManageTypesModal } from '../inventory/admin/ManageTypesModal';
export { CustomFieldsAdminModal } from '../inventory/admin/CustomFieldsAdminModal';
export { SendAlertModal } from '../inventory/admin/SendAlertModal';

// ── Main view ─────────────────────────────────────────────────────────────────
const INV_VALID_TABS = ['myitems','catalog','manage','checkouts','whohasit','audit'];

export default function InventoryManagement({ activeSub }) {
  const {
    items, itemsLoading, itemsError,
    checkouts, checkoutsLoading, checkoutsError,
    submitCartCheckouts, approveRequest, rejectRequest,
    allocateItem, initiateHandover, confirmReceipt, returnItem, cancelRequest,
    refreshItems, refreshCheckouts,
    patchItemLocal, removeItemsLocal, addItemLocal,
  } = useInventory();
  const { addNotification } = useNotifications();
  const { can, canAccessModule, loading: roleLoading } = useRole();
  const { accounts } = useMsal();
  const userName  = cleanName(accounts[0]?.name ?? 'Employee');
  const userEmail = (accounts[0]?.username ?? '').toLowerCase();

  // Manager tier OR an Access-Group/job-role grant of Item Management at
  // editor+ (grants layer additively - an Employee-tier person with the
  // "Item Management: Full" grant gets the full Manage experience).
  const isManager = canAccessModule('inventory', 'manager', 'editor');
  const canDelete = canAccessModule('inventory', 'owner', 'full');

  const pendingCount   = checkouts.filter(c => c.status === 'pending').length;
  const approvedCount  = checkouts.filter(c => c.status === 'approved').length;
  const myActiveCount  = checkouts.filter(c =>
    ['pending','approved','pending_receipt','allocated'].includes(c.status) &&
    ((c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName)
  ).length;
  const myTotalCount   = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName
  ).length;

  // Cart - DB-backed, survives logout and device switches
  const { assignments, refreshAssignments } = useAssignments();
  const [assigningItem, setAssigningItem] = useState(null); // {item, mode}
  const [cart,        setCart]        = useState([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [cartBusy,    setCartBusy]    = useState(false);
  const [returningCo, setReturningCo] = useState(null);

  useEffect(() => {
    api.getItemCart().then(rows => {
      setCart(rows.map(r => ({ id: r.id, item: { id: r.itemId, name: r.itemName, itemType: r.itemType }, days: 1 })));
    }).catch(() => {});
  }, []);

  const inCart = useMemo(() => new Set(cart.map(c => c.item.id)), [cart]);
  // Items flagged picture_required=false - every photo step for them is optional
  const photoOptionalIds = useMemo(() => new Set(items.filter(i => i.pictureRequired === false).map(i => i.id)), [items]);
  const addToCart = useCallback(item => {
    if (inCart.has(item.id)) return;
    const optimisticId = `cart-${Date.now()}`;
    setCart(prev => [...prev, { id: optimisticId, item, days: 1 }]);
    api.addItemToCart({ item_id: item.id, item_name: item.name, item_type: item.itemType })
      .then(saved => setCart(prev => prev.map(c => c.id === optimisticId ? { id: saved.id, item, days: 1 } : c)))
      // P4: surface the failure instead of the row silently disappearing.
      .catch(err => { setCart(prev => prev.filter(c => c.id !== optimisticId)); toast(err?.message || 'Could not add item to cart.', 'error'); });
    // `toast` intentionally omitted: it's a stable useCallback declared lower in
    // this component, so listing it here read it in the temporal dead zone and
    // crashed the whole view ("Cannot access 'toast' before initialization").
  }, [inCart]); // eslint-disable-line react-hooks/exhaustive-deps
  function removeFromCart(cartId) {
    const entry = cart.find(c => c.id === cartId);
    setCart(prev => prev.filter(c => c.id !== cartId));
    // P4: on failure, restore the row and tell the user rather than swallowing it.
    if (entry) api.removeItemFromCart(entry.item.id).catch(err => { setCart(prev => prev.some(c => c.id === cartId) ? prev : [...prev, entry]); toast(err?.message || 'Could not remove item from cart.', 'error'); });
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
    setCartBusy(true);
    const results = await submitCartCheckouts(cart, { reason, raisedBy: userName, raisedByEmail: userEmail, forName, forEmail, approverEmail, approverName });
    const succeededItems = cart.filter((_, i) => results[i].status === 'fulfilled');
    const failedItems    = cart.filter((_, i) => results[i].status === 'rejected');
    await Promise.all(succeededItems.map(c => api.removeItemFromCart(c.item.id).catch(() => {})));
    setCartBusy(false); setCartOpen(false); setCart(failedItems);
    if (succeededItems.length > 0) {
      toast(`${succeededItems.length} checkout${succeededItems.length !== 1 ? 's' : ''} submitted.`);
      // Land on My Items → Active Checkouts to see the fresh order's trackers
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

  // Manager-only tab/modal state
  // Remember the last tab so a page refresh keeps you where you were instead of
  // bouncing back to Catalog. Explicit navigation (activeSub / nexus:navigate)
  // still wins over this saved default below.
  const [mainTab, setMainTab] = useState(() => {
    try { const s = localStorage.getItem('nexus_inv_tab'); if (s && INV_VALID_TABS.includes(s)) return s; } catch { /* ignore */ }
    return 'catalog';
  });
  useEffect(() => { try { localStorage.setItem('nexus_inv_tab', mainTab); } catch { /* ignore */ } }, [mainTab]);
  // Managers land on the normal employee screen; the full management UI lives behind
  // a "Manage" tab they opt into (Neil). A deep-link to a management tab enters it.
  const [manageMode, setManageMode] = useState(false);
  // Who Has What → Checkouts deep-link: carries the person/item to prefill the
  // search so the landing view is already scoped to what was clicked.
  const [checkoutsPrefilter, setCheckoutsPrefilter] = useState(null);
  const openInCheckouts = useCallback(filter => {
    setCheckoutsPrefilter({ ...filter, ts: Date.now() }); // ts: re-trigger on same target
    setMainTab('checkouts');
  }, []);

  // Deep-link: NotificationBell navigates with ('inventory', subTab) - land on
  // that tab instead of the default Catalog so the click shows the relevant info.
  const VALID_SUBTABS = INV_VALID_TABS;
  // 'permanent' / 'active-checkouts' are sub-tabs inside My Items;
  // 'checkouts-completed' is the Completed filter inside Checkouts
  // (the inner components pick these up from the same event)
  const resolveSub = sub =>
    (sub === 'permanent' || sub === 'active-checkouts') ? 'myitems'
    : (sub === 'checkouts-completed' || sub === 'assignment-returns' || sub === 'handover') ? 'checkouts'
    : sub;
  useEffect(() => {
    const t = resolveSub(activeSub);
    if (t && VALID_SUBTABS.includes(t)) { setMainTab(t); setManageMode(true); }
  }, [activeSub]); // eslint-disable-line react-hooks/exhaustive-deps
  // Window event covers repeat clicks where activeSub doesn't change value
  useEffect(() => {
    const h = e => {
      const { view, sub } = e.detail || {};
      const t = resolveSub(sub);
      if (view === 'inventory' && t && VALID_SUBTABS.includes(t)) { setMainTab(t); setManageMode(true); }
    };
    window.addEventListener('nexus:navigate', h);
    return () => window.removeEventListener('nexus:navigate', h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [deptFilter,    setDeptFilter]    = useState('All');
  const [typeFilter,    setTypeFilter]    = useState('All');
  // Master ownership filter: All | transient (temporary) | permanent.
  // Lets managers filter permanent items out of Catalog/Manage (Neil, Jun 16).
  // Default the ownership filter to Temporary (Neil: opening to hundreds of items
  // is overwhelming; lead with the checkout-able/temporary ones). One click to All.
  // Catalog is the employee browse view - they check out Temporary items and have
  // no reason to see Permanent ones, so it leads with Temporary. Manage is the
  // manager view and shows All ownership. The default resets per tab when you
  // switch between the two (Neil).
  const [ownershipFilter, setOwnershipFilter] = useState('transient');
  const [locationFilter, setLocationFilter] = useState('All');
  const [modelFilter,    setModelFilter]    = useState('All');
  // Which KPI tile (Manage tab) is narrowing the list, if any - clicking a tile
  // toggles it on/off; it's a bucket on top of the dropdown filters, not a
  // replacement for them (Neil: cards were dead placeholders, make them act
  // like the filter chips everywhere else in the app).
  const [cardFilter,    setCardFilter]      = useState(null);
  // Reset the ownership default when moving between the employee (Catalog) and
  // manager (Manage) views - Temporary-only vs All.
  useEffect(() => {
    if (mainTab === 'catalog')     setOwnershipFilter('transient');
    else if (mainTab === 'manage') setOwnershipFilter('All');
    setCardFilter(null);
  }, [mainTab]);
  // Type filter auto-populates from the data so imported types (e.g. "IP Camera")
  // appear alongside the built-in ones; "Other" stays last.
  // Ankush: when a DEPARTMENT is selected, hide types that department never has
  // (Ops has no networking, IT has no vehicles) - derived from the live data so
  // the full set still exists system-wide. With "All departments" we show
  // everything, keeping the complexity available.
  const typeOptions = useMemo(() => {
    if (deptFilter === 'All') {
      const base = ITEM_TYPES.filter(t => t !== 'Other');
      const custom = [...new Set(items.map(i => (i.itemType || '').trim()).filter(Boolean))]
        .filter(t => !ITEM_TYPES.includes(t)).sort();
      return [...base, ...custom, 'Other'];
    }
    const present = new Set(items.filter(i => (i.department || '') === deptFilter)
      .map(i => (i.itemType || '').trim()).filter(Boolean));
    const builtins = ITEM_TYPES.filter(t => t !== 'Other' && present.has(t));
    const custom   = [...present].filter(t => !ITEM_TYPES.includes(t)).sort();
    return [...builtins, ...custom, ...(present.has('Other') ? ['Other'] : [])];
  }, [items, deptFilter]);
  // If the selected type isn't valid for the chosen department, fall back to All
  // so the list never shows zero items because of a stale, now-hidden type.
  useEffect(() => {
    if (typeFilter !== 'All' && !typeOptions.includes(typeFilter)) setTypeFilter('All');
  }, [typeOptions, typeFilter]);
  // Location filter populates entirely from the data (locations come from the import).
  const locationOptions = useMemo(() =>
    [...new Set(items.map(i => (i.location || '').trim()).filter(Boolean))].sort(),
  [items]);
  // Model filter - derived from the data, scoped to the chosen department + type so
  // the list stays relevant (you don't see every model in the company at once).
  const modelOptions = useMemo(() => {
    const pool = items.filter(i =>
      (deptFilter === 'All' || (i.department || '') === deptFilter) &&
      (typeFilter === 'All' || (i.itemType || '') === typeFilter));
    return [...new Set(pool.map(i => cleanField(i.model)).filter(Boolean))].sort();
  }, [items, deptFilter, typeFilter]);
  // Drop a stale model selection when dept/type narrows it away.
  useEffect(() => {
    if (modelFilter !== 'All' && !modelOptions.includes(modelFilter)) setModelFilter('All');
  }, [modelOptions, modelFilter]);
  const [search,        setSearch]        = useState('');
  // Items scoped to the active filters - the KPI tiles must follow ALL of them
  // (department, ownership, location, type), not show company-wide totals (Sai).
  const deptItems = useMemo(
    () => items.filter(i =>
      (deptFilter === 'All' || (i.department || '') === deptFilter) &&
      (ownershipFilter === 'All' || (i.ownershipType || 'transient') === ownershipFilter) &&
      (locationFilter === 'All' || (i.location || '') === locationFilter) &&
      (typeFilter === 'All' || (i.itemType || '') === typeFilter) &&
      (modelFilter === 'All' || cleanField(i.model) === modelFilter)
    ),
    [items, deptFilter, ownershipFilter, locationFilter, typeFilter, modelFilter]
  );
  // Deferred copy keeps the input responsive: tabs re-filter at low priority
  // instead of blocking every keystroke.
  const deferredSearch = useDeferredValue(search);
  const [addItemOpen,   setAddItemOpen]   = useState(false);
  const [editingItem,   setEditingItem]   = useState(null);
  const [detailsItem,   setDetailsItem]   = useState(null);        // item Details slide-over (Ankush)
  const [deletingItem,  setDeletingItem]  = useState(null);
  const [deletedOpen,   setDeletedOpen]   = useState(false);       // recycle bin
  const [highlightItemId,    setHighlightItemId]    = useState(null); // Manage row to glow (Audit "Open item")
  const [deletedHighlightId, setDeletedHighlightId] = useState(null); // Recycle Bin row to glow
  // Manage Types / Add Custom Field / generic Send Alert moved to the Admin
  // module in full (Pranshu, Sep 9) - no local open-state for them here any
  // more; ManageTypesModal / CustomFieldsAdminModal / SendAlertModal stay
  // exported from this file since Admin still borrows them from here.
  const [importOpen,    setImportOpen]    = useState(false);
  const [reportOpen,    setReportOpen]    = useState(false);
  const [reportInitial, setReportInitial] = useState(null); // seeds the report with the active filters
  const [overdueAlertOpen, setOverdueAlertOpen] = useState(false); // person-grouped overdue alert (default)
  // Admin-defined custom field definitions - loaded once, surfaced in the Details
  // panel and editable via the Custom Fields modal.
  const [customFields, setCustomFields] = useState([]);
  const refreshCustomFields = useCallback(() => {
    api.getItemCustomFields().then(setCustomFields).catch(() => {});
  }, []);
  useEffect(() => { refreshCustomFields(); }, [refreshCustomFields]);
  // Manager-curated item types - loaded from the server (falls back to the static
  // list). Used by the Add/Edit/Batch dropdowns and the Manage Types modal.
  const [itemTypes, setItemTypes] = useState(ITEM_TYPES);
  const refreshItemTypes = useCallback(() => {
    api.getItemTypes().then(t => setItemTypes(Array.isArray(t) && t.length ? t : ITEM_TYPES)).catch(() => {});
  }, []);
  useEffect(() => { refreshItemTypes(); }, [refreshItemTypes]);

  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, kind = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), kind === 'error' ? 6000 : 4000);
  }, []);
  const dismissToast = id => setToasts(prev => prev.filter(t => t.id !== id));

  function handleAddItem(data, opts = {}) {
    return api.createItem(data)
      .then(created => {
        addItemLocal(created); toast(`Added "${data.name}" to the catalog.`);
        // Permanent item + "assign right away" → straight into the normal
        // assign flow (acceptance + photo), same as the Manage-tab button
        if (opts.assignNow && created?.id) setAssigningItem({ item: created, mode: 'assign' });
        // "Let AI find a photo" - fire-and-forget, photo lands via refresh
        if (opts.aiFill && created?.id) {
          toast(`AI is finding a photo for "${data.name}"…`);
          api.autoFillItemPhotos([created.id], false)
            .then(() => { refreshItems(); })
            .catch(() => {});
        }
      })
      .catch(err => { toast(err?.message || 'Could not add item.', 'error'); throw err; });
  }
  function handleEditItem(item, data) {
    // Only send what actually changed, so the audit log shows the real edit.
    const changed = diffItemEdit(item, data);
    if (Object.keys(changed).length === 0) { toast('No changes to save.'); return Promise.resolve(); }
    return api.updateItem(item.id, changed)
      .then(updated => { patchItemLocal(updated); toast(`Updated "${data.name}".`); })
      .catch(err => { toast(err?.message || 'Could not save changes.', 'error'); throw err; });
  }
  function handleDeleteItem(item) {
    return api.deleteItem(item.id)
      .then(() => { removeItemsLocal(item.id); toast(`Deleted "${item.name}".`); setDeletingItem(null); })
      .catch(err => { toast(err?.message || 'Could not delete item.', 'error'); throw err; });
  }
  function handleImport(rows) {
    return api.importItems(rows)
      .then(res => {
        refreshItems();
        toast(`Imported ${res.created} item${res.created !== 1 ? 's' : ''}${res.updated ? `, updated ${res.updated}` : ''}.`);
        // The import can extend the type list - pull the new types in and say so.
        const added = res.added_types || [];
        if (added.length) {
          refreshItemTypes();
          toast(`Added ${added.length} new type${added.length !== 1 ? 's' : ''}: ${added.join(', ')}.`);
        }
        return res;
      })
      .catch(err => { toast(err?.message || 'Import failed.', 'error'); throw err; });
  }

  // Stable handlers so the memoized tab components skip re-renders when
  // unrelated state (toasts, cart, modals) changes in this component.
  const openReturn = useCallback(co => setReturningCo(co), []);
  const cancelCo = useCallback((co, opts = {}) => cancelRequest(co.id, userName)
    .then(() => { if (!opts.silent) toast('Checkout cancelled.'); })
    .catch(() => { if (!opts.silent) toast('Could not cancel.', 'error'); }), [cancelRequest, userName, toast]);
  const selfAllocate = useCallback(co => allocateItem(co.id, userName)
    .then(() => toast(`Confirmed - ${co.itemName} is with you.`))
    .catch(() => toast('Could not confirm.', 'error')), [allocateItem, userName, toast]);
  // Manager accepting their OWN approved checkout: must upload a handover photo
  // just like an employee does - receipts are evidence (Jun 16 bug: this path
  // skipped the photo modal and auto-accepted). Throws on failure so the modal
  // surfaces the error and stays open.
  const handleSelfAccept = useCallback((co, url, name) =>
    allocateItem(co.id, userName, url, name)
      .then(() => toast(`Confirmed - ${co.itemName} is with you.`))
      .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); }),
    [allocateItem, userName, toast]);
  const openAdd       = useCallback(() => setAddItemOpen(true), []);
  const openImport    = useCallback(() => setImportOpen(true), []);
  const openReport    = useCallback((ctx) => { setReportInitial(ctx || null); setReportOpen(true); }, []);
  const openSendAlert = useCallback(() => setOverdueAlertOpen(true), []);
  const exportCsv     = useCallback((rows) => downloadItemsCsv(Array.isArray(rows) && rows.length ? rows : items, customFields), [items, customFields]);
  // "All Items → PDF": route through the report export with no filters applied.
  const exportAllPdf  = useCallback(() => {
    api.getItemsReport({ format:'pdf' })
      .then(({ blob, filename }) => triggerDownload(filename, blob))
      .catch(() => toast('Could not generate the PDF.', 'error'));
  }, [toast]);
  const openAssign    = useCallback((item, mode) => setAssigningItem({ item, mode }), []);
  const refreshAssignmentsAndItems = useCallback(() => { refreshAssignments(); refreshItems(); }, [refreshAssignments, refreshItems]);
  const handleConfirmReceipt = useCallback((co, batch, photoMap) =>
    confirmReceipt(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '')
      .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); }),
    [confirmReceipt, userName]);
  const handleReturnAll = useCallback(async (cos, data) => {
    // P1-5: count real successes/failures rather than always claiming all N returned.
    let ok = 0, failed = 0;
    for (const c of cos) {
      try { await returnItem(c.id, data); ok++; } catch { failed++; }
    }
    refreshCheckouts();
    if (failed === 0) toast(`Returned ${ok} item${ok !== 1 ? 's' : ''}.`);
    else toast(`Returned ${ok} · ${failed} failed.`, 'error');
  }, [returnItem, toast, refreshCheckouts]);
  const handleRequestExtension = useCallback((co, days, reason) =>
    api.requestItemExtension(co.id, { days, reason })
      .then(() => { toast(`Extension requested for ${co.itemName} - awaiting approval.`); refreshCheckouts(); }),
    [toast, refreshCheckouts]);
  const handleReRequest = useCallback(async (co, newReason) => {
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
      refreshCheckouts();
    } catch (err) {
      toast(err?.message || `Could not re-submit request for ${co.itemName}.`, 'error');
      throw err; // panel must not clear the rejected card on failure
    }
  }, [userEmail, userName, toast, refreshCheckouts]);
  const handleBatchReRequest = useCallback((cos, vals) =>
    runBatchReRequest(cos, vals, { submitCartCheckouts, userName, userEmail, toast }),
    [submitCartCheckouts, userName, userEmail, toast]);

  if (roleLoading) return <SkeletonBlocks count={6} height={56} borderRadius={10} />;

  // Items assigned to me still awaiting my acceptance - persistent callout; the
  // 7s toast alone is easy to miss (Neil couldn't find where his iPhone landed).
  const awaitingAcceptance = assignments.filter(a => a.assigneeEmail === userEmail && a.status === 'pending_acceptance').length;
  const goAccept = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view:'inventory', sub:'permanent' } }));
  const acceptBanner = awaitingAcceptance > 0 ? (
    <div role="button" tabIndex={0} onClick={goAccept} onKeyDown={e => e.key === 'Enter' && goAccept()}
      style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:10, marginBottom:14,
               background:'hsla(var(--color-blue),0.08)', border:'1px solid hsla(var(--color-blue),0.35)', cursor:'pointer' }}>
      <Package size={16} style={{ color:'hsl(var(--color-blue))', flexShrink:0 }} />
      <span style={{ fontSize:13, color:'var(--ink)' }}>
        <strong>{awaitingAcceptance} item{awaitingAcceptance !== 1 ? 's' : ''}</strong> assigned to you - waiting for your acceptance.
      </span>
      <span style={{ marginLeft:'auto', fontSize:12.5, fontWeight:700, color:'hsl(var(--color-blue))', whiteSpace:'nowrap' }}>Review →</span>
    </div>
  ) : null;

  // Everyone lands on the normal employee screen. Managers get a "Manage" tab on it
  // that flips into the full management UI below (Neil). Employees never see it.
  if (!isManager || !manageMode) {
    return (
      <>
        {acceptBanner}
        <EmployeeView
          items={items} checkouts={checkouts} activeSub={activeSub}
          userName={userName} userEmail={userEmail}
          itemsLoading={itemsLoading} itemsError={itemsError}
          onReturn={returnItem}
          refreshItems={refreshItems} refreshCheckouts={refreshCheckouts}
          submitCartCheckouts={submitCartCheckouts}
          cancelRequest={cancelRequest}
          allocateItem={allocateItem}
          initiateHandover={initiateHandover}
          confirmReceipt={confirmReceipt}
          addNotification={addNotification}
          toast={toast}
          showManage={isManager} onEnterManage={() => { setMainTab('manage'); setManageMode(true); }}
        />
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  // The filter selects, rendered directly above the table on Catalog and Manage
  // (no longer in the page header - Neil: filters must sit in one consistent spot,
  // not jump around). Any filter that isn't on "All" gets a tinted background so
  // it's obvious one is active and nothing is silently hidden.
  const baseSel   = { padding:'6px 10px', fontSize:13, height:34, width:'auto' };
  const activeSel = v => (v && v !== 'All')
    ? { borderColor:'var(--pine)', background:'hsla(var(--color-green),0.12)', fontWeight:700, color:'var(--ink)' }
    : null;
  const filterSelects = (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <Filter size={13} style={{ color:'var(--muted)' }} />
        <select className="form-input" value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ ...baseSel, minWidth:150, ...activeSel(deptFilter) }}>
          {DEPARTMENTS.map(d => <option key={d} value={d}>{d === 'All' ? 'All departments' : d}</option>)}
        </select>
      </div>
      <select className="form-input" value={locationFilter} onChange={e => setLocationFilter(e.target.value)} style={{ ...baseSel, minWidth:130, ...activeSel(locationFilter) }}>
        <option value="All">All locations</option>
        {locationOptions.map(l => <option key={l}>{l}</option>)}
      </select>
      <select className="form-input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ ...baseSel, minWidth:110, ...activeSel(typeFilter) }}>
        <option value="All">All types</option>
        {typeOptions.map(t => <option key={t}>{t}</option>)}
      </select>
      <select className="form-input" value={modelFilter} onChange={e => setModelFilter(e.target.value)} style={{ ...baseSel, minWidth:120, ...activeSel(modelFilter) }}>
        <option value="All">All models</option>
        {modelOptions.map(m => <option key={m}>{m}</option>)}
      </select>
      <select className="form-input" value={ownershipFilter} onChange={e => setOwnershipFilter(e.target.value)} style={{ ...baseSel, minWidth:130, ...activeSel(ownershipFilter) }}>
        <option value="All">All ownership</option>
        <option value="transient">Temporary</option>
        <option value="permanent">Permanent</option>
      </select>
    </>
  );

  return (
    <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
      {acceptBanner}
      {/* Header */}
      <div className="view-header" style={{ marginBottom:0 }}>
        <div className="view-title-group">
          {/* Leave the manager-only Manage UI, back to the normal employee screen. */}
          <button onClick={() => setManageMode(false)}
            style={{ display:'inline-flex', alignItems:'center', gap:6, background:'none', border:'none', cursor:'pointer', color:'var(--muted)', fontSize:12.5, fontFamily:'Inter,sans-serif', padding:'0 0 4px', fontWeight:600 }}
            onMouseEnter={e => e.currentTarget.style.color='var(--ink)'} onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}>
            <ArrowLeft size={13} /> Exit Manage
          </button>
          <h2>Item Management <span style={{ fontSize:13, fontWeight:700, color:'hsl(var(--color-purple))', verticalAlign:'middle' }}>· Manage</span></h2>
          <p>Browse company assets and check out what you need</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          {/* Filters no longer live in the header - each tab renders them directly
              above its own table so they never jump around between tabs (Neil). */}
          {/* Cart last: it's the one control visible on every tab, so it anchors
              the right edge instead of floating next to hidden filters */}
          {/* header-cart: phones pin this to ONE fixed spot (title row, top
              right) on every tab - no FAB, no drifting (Visesh) */}
          <button className="header-cart"
            style={{ display:'inline-flex', alignItems:'center', gap:7, position:'relative', background:'#000', color:'#fff', border:'1px solid #000', borderRadius:9, fontWeight:700, padding:'8px 18px', cursor:'pointer', fontFamily:'Inter,sans-serif' }}
            onClick={() => setCartOpen(true)}>
            <ShoppingCart size={14} /> Cart
            {cart.length > 0 && (
              <span style={{ position:'absolute', top:-7, right:-1, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:17, height:17, fontSize:10, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>
                {cart.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Tab strip - desktop only; on phones the bottom action bar replaces it */}
      {/* Manager tabs - desktop renders them centered in the top header; on
          phones the bottom action bar replaces them (mobileInline off, same as
          the old `.im-tabs { display:none }` rule). */}
      <ModuleTabs mobileInline={false}
        tabs={[
          { key:'myitems',      label:'My Items',          Icon: User,         badge: myActiveCount          },
          { key:'catalog',      label:'Catalog',           Icon: Package                                     },
          { key:'manage',       label:'Manage',            Icon: ClipboardList                               },
          { key:'checkouts',    label:'Checkouts',         Icon: ShoppingCart, badge: pendingCount + approvedCount },
          { key:'whohasit',     label:'Who Has What',      Icon: Users                                       },
          { key:'audit',        label:'Activity Log',      Icon: History                                     },
        ]}
        active={mainTab} onChange={setMainTab} />

      {/* Pending approvals banner - below the tab strip so the nav itself never moves */}
      {pendingCount > 0 && (
        <div onClick={() => setMainTab('checkouts')}
          style={{ margin:'0 0 16px', background:'hsla(var(--color-orange),0.1)', border:'1px solid hsla(var(--color-orange),0.35)', borderRadius:12, padding:'12px 18px', display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
          <AlertCircle size={18} color="hsl(var(--color-orange))" style={{ flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <span style={{ fontWeight:700, fontSize:13.5 }}>{pendingCount} checkout request{pendingCount !== 1 ? 's' : ''} waiting for your approval</span>
            <span style={{ fontSize:12, color:'var(--muted)', marginLeft:8 }}>Tap to review</span>
          </div>
          <ChevronRight size={16} style={{ color:'var(--muted)', flexShrink:0 }} />
        </div>
      )}

      {/* KPI strip now renders INSIDE the Manage tab, below its search/filter bar,
          so the toolbar sits at the same height on every tab (Neil: stop the
          search/filters jumping up and down). */}

      {/* Tab content */}
      {mainTab === 'catalog' && (
        <ManagerCatalogTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} ownershipFilter={ownershipFilter} locationFilter={locationFilter} modelFilter={modelFilter} search={deferredSearch}
          searchValue={search} onSearchChange={setSearch}
          refreshItems={refreshItems} onAddToCart={addToCart} onRemoveFromCart={removeFromCartByItemId} inCart={inCart}
          checkouts={checkouts} userEmail={userEmail} userName={userName}
          onReturn={openReturn} onCancel={cancelCo}
          onSelfAllocate={selfAllocate}
          filterControls={filterSelects}
        />
      )}
      {mainTab === 'manage' && (
        <ManagerManageTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} ownershipFilter={ownershipFilter} locationFilter={locationFilter} modelFilter={modelFilter} search={deferredSearch}
          searchValue={search} onSearchChange={setSearch}
          refreshItems={refreshItems} canDelete={canDelete}
          onAdd={openAdd} onEdit={setEditingItem}
          onDelete={setDeletingItem} onImport={openImport}
          onExport={exportCsv} onExportAllPdf={exportAllPdf} onReport={openReport}
          checkouts={checkouts} toast={toast}
          onAssign={openAssign} onDetails={setDetailsItem}
          onShowDeleted={() => setDeletedOpen(true)}
          // Manage Types / Add Custom Field moved to the Admin module in full
          // (Pranshu, Sep 9) - no longer triggered from here.
          itemTypes={itemTypes}
          highlightId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)}
          filterControls={filterSelects}
          cardFilter={cardFilter}
          kpiStrip={
            <div className="kpi-grid" style={{ gridTemplateColumns:'repeat(auto-fit, minmax(104px, 1fr))', gap:8, margin:'0 0 16px' }}>
              {/* Tiles now cover every lifecycle bucket so the counts reconcile against
                  Total items (P4): available-to-checkout + unassigned-permanent +
                  assigned-to-location + assigned-to-person + checked-out (+ retired).
                  Clicking a tile narrows the table below to that bucket (on top of the
                  dropdown filters, same idea as the checkout status chips) - clicking the
                  active tile again, or Total/Items Value, clears back to the full set. */}
              {[
                { key:'available',            label:'Available to check out', value: deptItems.filter(i => i.status === 'available' && i.ownershipType !== 'permanent').length, color:'card-green'  },
                { key:'unassigned',           label:'Unassigned permanent',   value: deptItems.filter(i => displayStatus(i) === 'unassigned').length, color:'card-purple' },
                { key:'location_assigned',    label:'Assigned · location',    value: deptItems.filter(i => displayStatus(i) === 'location_assigned').length, color:'card-blue' },
                { key:'permanently_assigned', label:'Assigned · person',      value: deptItems.filter(i => i.status === 'permanently_assigned').length, color:'card-blue' },
                { key:'checked_out',          label:'Checked out', value: deptItems.filter(i => i.status === 'checked_out').length,  color:'card-orange' },
                { key:null,                   label:'Total Items', value: deptItems.length,                                          color:'card-blue'   },
                { key:null,                   label:'Items Value', value: fmtMoney(deptItems.reduce((s, i) => s + (Number(i.assetValue) || 0), 0)), color:'card-blue' },
              ].map(({ key, label, value, color }) => {
                const active = key && cardFilter === key;
                return (
                  <div key={label} className={`kpi-card ${color}`} role="button" tabIndex={0}
                    aria-pressed={active}
                    onClick={() => setCardFilter(prev => (!key || prev === key) ? null : key)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCardFilter(prev => (!key || prev === key) ? null : key); } }}
                    style={{
                      padding:'8px 11px', cursor:'pointer',
                      outline: active ? '2px solid var(--pine)' : 'none', outlineOffset: -2,
                      background: active ? 'hsla(var(--color-green),0.08)' : undefined,
                    }}>
                    <div className="kpi-label" style={{ fontSize:10.5 }}>{label}</div>
                    <div className="kpi-value" style={{ fontSize:18, lineHeight:1.1 }}>{value}</div>
                  </div>
                );
              })}
            </div>
          }
        />
      )}
      {mainTab === 'myitems' && (
        <div>
          <MyCheckoutsPanel
            checkouts={checkouts} userEmail={userEmail} userName={userName} activeSub={activeSub}
            photoOptionalIds={photoOptionalIds}
            assignments={assignments} refreshAssignments={refreshAssignments} toast={toast}
            onReturn={openReturn} onCancel={cancelCo}
            onEmployeeAccept={handleSelfAccept}
            onConfirmReceipt={handleConfirmReceipt}
            onReturnAll={handleReturnAll}
            onRequestExtension={handleRequestExtension}
            onReRequest={handleReRequest}
            onBatchReRequest={handleBatchReRequest}
          />
          {myTotalCount === 0 && (
            <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--muted)' }}>
              <Package size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
              <div style={{ fontWeight:600, fontSize:15, marginBottom:6 }}>No checkouts yet</div>
              <div style={{ fontSize:13 }}>Your personal item checkouts will appear here.</div>
            </div>
          )}
        </div>
      )}
      {mainTab === 'checkouts' && (
        <ManagerCheckoutsTab
          checkouts={checkouts} items={items}
          userName={userName} userEmail={userEmail}
          approveRequest={approveRequest} rejectRequest={rejectRequest}
          allocateItem={allocateItem} initiateHandover={initiateHandover}
          refreshCheckouts={refreshCheckouts} refreshItems={refreshItems} toast={toast}
          assignments={assignments} refreshAssignments={refreshAssignmentsAndItems}
          onSendAlert={openSendAlert} prefilter={checkoutsPrefilter} activeSub={activeSub}
        />
      )}
      {mainTab === 'whohasit' && (
        <WhoHasItTab items={items} checkouts={checkouts} onOpenCheckouts={openInCheckouts} />
      )}
      {mainTab === 'audit' && <AuditLogPanel items={items} onChanged={refreshItems}
        onOpenItem={(it) => {
          const found = items.find(x => x.id === it.id) || items.find(x => x.name === it.name);
          if (found) { setMainTab('manage'); setEditingItem(found); }
          else toast('That item no longer exists (it may have been deleted).', 'error');
        }}
        onLocate={(it) => {
          const found = items.find(x => x.id === it.id) || (it.name && items.find(x => x.name === it.name));
          if (found) {
            // Clear filters so the row is guaranteed visible, jump to Manage, glow
            // it in the background, and open it for editing on top.
            setSearch(''); setDeptFilter('All'); setTypeFilter('All'); setOwnershipFilter('All'); setLocationFilter('All'); setModelFilter('All');
            setMainTab('manage');
            setHighlightItemId(null);
            setTimeout(() => setHighlightItemId(found.id), 0); // re-trigger even if same id
            setEditingItem(found);
          } else {
            // Deleted / purged → open the Recycle Bin, select + glow it there.
            setDeletedHighlightId(it.id || '');
            setDeletedOpen(true);
          }
        }} />}

      {overdueAlertOpen && (
        <OverdueAlertModal checkouts={checkouts} toast={toast}
          onClose={() => setOverdueAlertOpen(false)} />
      )}
      {assigningItem && (
        <AssignItemModal item={assigningItem.item} mode={assigningItem.mode} userEmail={userEmail}
          locations={[...new Set(items.map(i => i.location).filter(Boolean))].sort()} toast={toast}
          onClose={() => setAssigningItem(null)}
          onDone={() => { refreshAssignments(); refreshItems(); }} />
      )}
      {addItemOpen  && <AddItemModal   onClose={() => setAddItemOpen(false)}  onSave={handleAddItem} types={itemTypes} />}
      {editingItem  && <EditItemModal  item={editingItem} onClose={() => setEditingItem(null)} onSave={data => handleEditItem(editingItem, data)} types={itemTypes} />}
      {deletingItem && <DeleteItemModal item={deletingItem} onClose={() => setDeletingItem(null)} onConfirm={() => handleDeleteItem(deletingItem)} />}
      {detailsItem && (
        <ItemDetailsPanel item={detailsItem} customFields={customFields} canEdit={isManager}
          onClose={() => setDetailsItem(null)} onSaved={refreshItems} toast={toast} />
      )}
      {deletedOpen && (
        <DeletedItemsModal onClose={() => { setDeletedOpen(false); setDeletedHighlightId(null); }}
          onRestored={refreshItems} toast={toast} highlightId={deletedHighlightId} />
      )}
      {importOpen   && <ImportItemsModal onClose={() => setImportOpen(false)} onImport={handleImport} customFields={customFields}
        knownDepts={[...new Set([...DEPARTMENTS.filter(d => d !== 'All'), ...items.map(i => (i.department || '').trim()).filter(Boolean)])]}
        knownLocations={locationOptions} />}
      {reportOpen   && <ReportModal onClose={() => setReportOpen(false)} checkouts={checkouts} initial={reportInitial} />}
      {returningCo  && (
        <ReturnModal checkout={returningCo} onClose={() => setReturningCo(null)}
          photoOptional={photoOptionalIds.has(returningCo.itemId)}
          onSubmit={data => returnItem(returningCo.id, data)
            .then(() => { toast(`Return confirmed - ${returningCo.itemName}`); setReturningCo(null); })
            .catch(err => toast(err?.message || 'Could not confirm return - please try again.', 'error'))} />
      )}

      {/* P1-15: managers pick a targeted approver here too - without showApprover this
          cart submitted approver_email:'' and broadcast to every manager. (Follow-up:
          this Manage-mode cart is a second, divergent cart state from the employee
          path - unify to one cart context in a later refactor.) */}
      <CartDrawer open={cartOpen} cart={cart} items={items} onClose={() => setCartOpen(false)}
        onRemove={removeFromCart} onSubmit={handleSubmitCart} submitting={cartBusy}
        onDaysChange={handleDaysChange} showApprover />

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
