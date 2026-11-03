// Item Management (Items redesign, Neil 11/02/2026; plan
// https://claude.ai/artifact/PdnHYdRUodkwrPLdKvRXbj). Neil green-lit editing
// Visesh's Items files for this on 11/02/2026.
//
// One module, no chooser home and no Manage mode: the person's access decides
// the tabs (inventory/model/routes.js) - My Stuff and Borrow for everyone,
// Requests for items managers and allocators, Inventory for items admins -
// and every tab, queue, view and open item record is in the address, so Back
// and links work (the old subs still land). The item record opens over any
// tab as a sheet. The phone's bottom bar is these same tabs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SkeletonBlocks } from '../components/AsyncState';
import ModuleTabs from '../components/ModuleTabs';
import { useInventory } from '../contexts/InventoryContext';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { useAssignments } from '../components/Assignments';
import { ITEM_TYPES } from '../inventory/model/status';
import { parseItemsSub, itemsSub, tabsFor, resolveTab } from '../inventory/model/routes';
import { myStuffRows, groupCounts } from '../inventory/model/urgency';
import { buildQueues } from '../inventory/requests/RequestsTab';
import { useItemsIdentity } from '../inventory/model/identity';
import { useTypeSettings, isTypeBorrowable } from '../inventory/model/useTypeSettings';
import { diffItemEdit } from '../inventory/model/itemEdit';
import { MyStuffTab } from '../inventory/mystuff/MyStuffTab';
import { BorrowTab } from '../inventory/borrow/BorrowTab';
import { CartSheet } from '../inventory/borrow/CartSheet';
import { RequestsTab } from '../inventory/requests/RequestsTab';
import { InventoryTab } from '../inventory/stock/InventoryTab';
import { ItemRecord } from '../inventory/record/ItemRecord';
import { EditItemModal } from '../inventory/manage/EditItemModal';
import { ItemDetailsPanel } from '../inventory/manage/ItemDetailsPanel';
import { ItemsToasts, itemsToast } from '../inventory/ui/Toast';

// Borrowed by other modules (asset/App.jsx, components/PurchaseRequests.jsx,
// views/AdminConsole.jsx) and their tests - keep these re-exports.
export { AddItemModal } from '../inventory/manage/AddItemModal';
export { ManageTypesModal } from '../inventory/admin/ManageTypesModal';
export { CustomFieldsAdminModal } from '../inventory/admin/CustomFieldsAdminModal';
export { SendAlertModal } from '../inventory/admin/SendAlertModal';

const TAB_COPY = {
  mystuff:   { title: 'My Stuff',  sub: 'What you have and what is waiting on you, most urgent first.' },
  borrow:    { title: 'Borrow',    sub: 'Pick what you need, choose a return date, and send one request.' },
  requests:  { title: 'Requests',  sub: 'Approve, hand over and take back.' },
  inventory: { title: 'Inventory', sub: 'Every item, who has it, and what happened to it.' },
};
const MOBILE_IDS = { mystuff: 'items-mystuff', borrow: 'items-borrow', requests: 'items-requests', inventory: 'items-inventory' };
const MOBILE_LABEL = { mystuff: 'My Stuff', borrow: 'Borrow', requests: 'Requests', inventory: 'Inventory' };

export default function InventoryManagement({ activeSub, onSubChange }) {
  const inv = useInventory() || {};
  const {
    items = [], itemsLoading, itemsError, checkouts = [], checkoutsLoading, checkoutsError,
    refreshItems, refreshCheckouts, patchItemLocal, removeItemsLocal, addItemLocal,
  } = inv;
  const { can, canAccessModule, loading: roleLoading } = useRole();
  const { myEmail } = useItemsIdentity();
  const { assignments } = useAssignments();
  const { byName } = useTypeSettings();

  const isManager = canAccessModule('inventory', 'manager', 'editor');
  const canDelete = canAccessModule('inventory', 'owner', 'full');
  // Allocators hand items over: supervisors, and anyone a manager named on an
  // approved request.
  const isAllocator = !!can?.('supervisor') || checkouts.some(c => c.status === 'approved' && (c.assignedAllocatorEmail || '').toLowerCase() === myEmail);
  const access = useMemo(() => ({ isManager, isAllocator }), [isManager, isAllocator]);

  // ── The address: <tab>[:<view>][@<itemId | co:checkoutId>] ───────────────
  const parsed = parseItemsSub(activeSub);
  const tab = resolveTab(parsed, access);
  const view = tab === parsed.tab ? parsed.view : '';
  const recordRef = parsed.itemId;
  const recordItemId = recordRef.startsWith('co:')
    ? (checkouts.find(c => c.id === recordRef.slice(3))?.itemId || '')
    : recordRef;
  const go = useCallback((next) => {
    const sub = itemsSub(next);
    if (onSubChange) onSubChange(sub);
    else window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub } }));
  }, [onSubChange]);
  // An old sub (or a tab this person may not open) is rewritten to the one shown.
  useEffect(() => {
    if (roleLoading) return;
    const canonical = itemsSub({ tab, view, itemId: recordRef });
    if (activeSub && activeSub !== canonical && (parsed.legacy || parsed.tab !== tab)) onSubChange?.(canonical);
  }, [roleLoading, activeSub, tab, view, recordRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const openItem = useCallback((itemId) => go({ tab, view, itemId }), [go, tab, view]);
  const closeItem = useCallback(() => go({ tab, view }), [go, tab, view]);

  // ── Counts on the tabs (quiet - DESIGN: no loud pills) ─────────────────────
  const myCounts = useMemo(() => groupCounts(myStuffRows(checkouts, assignments, myEmail, { isManager })), [checkouts, assignments, myEmail, isManager]);
  const queues = useMemo(() => buildQueues(checkouts, assignments, { me: myEmail, isManager }), [checkouts, assignments, myEmail, isManager]);
  const tabs = tabsFor(access).map(t => ({
    key: t.key, label: t.label,
    badge: t.key === 'mystuff' ? (myCounts.overdue + myCounts.today + myCounts.action) || null
      : t.key === 'requests' ? (queues.approve.length + queues.handover.length + queues.returns.length) || null
      : null,
  }));

  // ── The phone's bottom bar is these tabs ───────────────────────────────────
  const tabKeys = tabs.map(t => t.key).join(',');
  useEffect(() => {
    const actions = tabKeys.split(',').map(k => ({ id: MOBILE_IDS[k], label: MOBILE_LABEL[k], active: k === tab }));
    window.__nexusMobileActions = actions;   // MobileNav reads it if it mounts after this
    window.dispatchEvent(new CustomEvent('nexus:mobile-actions', { detail: { actions } }));
  }, [tabKeys, tab]);
  useEffect(() => {
    const onTap = (e) => {
      const id = e.detail?.id || '';
      const key = Object.keys(MOBILE_IDS).find(k => MOBILE_IDS[k] === id);
      if (key) go({ tab: key });
    };
    window.addEventListener('nexus:mobile-action', onTap);
    return () => {
      window.removeEventListener('nexus:mobile-action', onTap);
      window.__nexusMobileActions = null;
      window.dispatchEvent(new CustomEvent('nexus:mobile-actions', { detail: { actions: null } }));
    };
  }, [go]);

  // ── Sheets the record asks for (Edit, Custom Fields) and the cart ──────────
  const [cartOpen, setCartOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [details, setDetails] = useState(null);
  const [types, setTypes] = useState(ITEM_TYPES);
  const [customFields, setCustomFields] = useState([]);
  useEffect(() => {
    if (!editing && !details) return;
    api.getItemTypes().then(t => setTypes(Array.isArray(t) && t.length ? t : ITEM_TYPES)).catch(() => {});
    if (details) api.getItemCustomFields().then(setCustomFields).catch(() => {});
  }, [editing, details]);

  if (roleLoading) return <SkeletonBlocks count={6} height={56} borderRadius={10} />;

  const recordItem = items.find(i => i.id === recordItemId);
  const copy = TAB_COPY[tab];

  return (
    <div className="it-page" data-tab={tab}>
      <header className="it-head">
        <div>
          <h2 className="it-title">{copy.title}</h2>
          <p className="it-sub">{copy.sub}</p>
        </div>
      </header>
      {/* The tabs live in the page (never behind the header search at any
          width); phones use the bottom bar instead (style.css hides these). */}
      <div className="it-tabs"><ModuleTabs tabs={tabs} active={tab} onChange={k => go({ tab: k })} inline /></div>

      {tab === 'mystuff' && (
        <MyStuffTab items={items} checkouts={checkouts} me={myEmail} isManager={isManager}
          itemsLoading={itemsLoading} checkoutsLoading={checkoutsLoading} checkoutsError={checkoutsError}
          refreshCheckouts={refreshCheckouts} onOpenItem={openItem} onBrowse={() => go({ tab: 'borrow' })} />
      )}
      {tab === 'borrow' && (
        <BorrowTab items={items} checkouts={checkouts} itemsLoading={itemsLoading} itemsError={itemsError}
          refreshItems={refreshItems} onOpenItem={openItem} onReviewCart={() => setCartOpen(true)} />
      )}
      {tab === 'requests' && (
        <RequestsTab items={items} checkouts={checkouts} isManager={isManager} view={view}
          onViewChange={v => go({ tab: 'requests', view: v })} onOpenItem={openItem}
          checkoutsLoading={checkoutsLoading} checkoutsError={checkoutsError} refreshCheckouts={refreshCheckouts} />
      )}
      {tab === 'inventory' && (
        <InventoryTab view={view} onViewChange={v => go({ tab: 'inventory', view: v === 'table' ? '' : v })}
          items={items} itemsLoading={itemsLoading} itemsError={itemsError} checkouts={checkouts}
          refreshItems={refreshItems} patchItemLocal={patchItemLocal} removeItemsLocal={removeItemsLocal} addItemLocal={addItemLocal}
          canDelete={canDelete} onOpenItem={openItem} />
      )}

      {recordRef && (
        <ItemRecord itemId={recordItemId} onClose={closeItem}
          borrowable={recordItem ? isTypeBorrowable(byName, recordItem.itemType) : true}
          onEdit={isManager ? setEditing : undefined} onOpenDetails={isManager ? setDetails : undefined} />
      )}
      {editing && (
        <EditItemModal item={editing} types={types} onClose={() => setEditing(null)}
          onSave={data => {
            const changed = diffItemEdit(editing, data);
            if (!Object.keys(changed).length) { itemsToast('No changes to save.'); return Promise.resolve(); }
            return api.updateItem(editing.id, changed).then(u => { patchItemLocal?.(u); itemsToast(`Updated ${data.name}.`); });
          }} />
      )}
      {details && (
        <ItemDetailsPanel item={details} customFields={customFields} canEdit={isManager}
          onClose={() => setDetails(null)} onSaved={refreshItems} toast={itemsToast} />
      )}
      {cartOpen && <CartSheet isManager={isManager} onClose={() => setCartOpen(false)} onSubmitted={() => go({ tab: 'mystuff' })} />}
      <ItemsToasts />
    </div>
  );
}
