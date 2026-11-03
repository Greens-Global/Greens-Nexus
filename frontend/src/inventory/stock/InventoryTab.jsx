// Item Management - Inventory (Items redesign, Neil 11/02/2026).
//
// For items admins: the table (with its filters, four KPI tiles and the batch
// tools), Who Has What and Activity as views inside it - the view rides the
// address (inventory:whohas, inventory:activity). Add Item gets a Serial and
// Save and Add Another; Import CSV is the path for many items at once.
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Filter, Table2, Users, History } from 'lucide-react';
import { api } from '../../api';
import { useAssignments, AssignItemModal } from '../../components/Assignments';
import { ITEM_TYPES, DEPARTMENTS } from '../model/status';
import { cleanField } from '../model/fields';
import { fmtMoney } from '../model/format';
import { triggerDownload, downloadItemsCsv } from '../model/csv';
import { diffItemEdit } from '../model/itemEdit';
import { checkoutDueInfo } from '../model/due';
import { useItemsIdentity } from '../model/identity';
import { ManagerManageTab } from '../manage/ManagerManageTab';
import { AddItemModal } from '../manage/AddItemModal';
import { EditItemModal } from '../manage/EditItemModal';
import { DeleteItemModal } from '../manage/DeleteItemModal';
import { ImportItemsModal } from '../manage/ImportItemsModal';
import { ReportModal } from '../manage/ReportModal';
import { DeletedItemsModal } from '../manage/DeletedItemsModal';
import { WhoHasItTab } from '../whohas/WhoHasItTab';
import { AuditLogPanel } from '../audit/AuditLogPanel';
import { itemsToast as toast } from '../ui/Toast';

const VIEWS = [
  { key: 'table', label: 'Table', Icon: Table2 },
  { key: 'whohas', label: 'Who Has What', Icon: Users },
  { key: 'activity', label: 'Activity', Icon: History },
];

export function InventoryTab({ view, onViewChange, items, itemsLoading, itemsError, checkouts, refreshItems, patchItemLocal, removeItemsLocal, addItemLocal, canDelete, onOpenItem }) {
  const { refreshAssignments } = useAssignments();
  const { myEmail } = useItemsIdentity();
  const current = VIEWS.some(v => v.key === view) ? view : 'table';
  const [deptFilter, setDeptFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [ownershipFilter, setOwnershipFilter] = useState('All');
  const [locationFilter, setLocationFilter] = useState('All');
  const [modelFilter, setModelFilter] = useState('All');
  const [cardFilter, setCardFilter] = useState(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [sheet, setSheet] = useState(null);   // { kind, item? }
  const [highlightItemId, setHighlightItemId] = useState(null);
  const [deletedHighlightId, setDeletedHighlightId] = useState(null);
  const [customFields, setCustomFields] = useState([]);
  const [itemTypes, setItemTypes] = useState(ITEM_TYPES);

  const refreshCustomFields = useCallback(() => { api.getItemCustomFields().then(setCustomFields).catch(() => {}); }, []);
  const refreshItemTypes = useCallback(() => {
    api.getItemTypes().then(t => setItemTypes(Array.isArray(t) && t.length ? t : ITEM_TYPES)).catch(() => {});
  }, []);
  useEffect(() => { refreshCustomFields(); refreshItemTypes(); }, [refreshCustomFields, refreshItemTypes]);

  const overdueIds = useMemo(() => new Set(checkouts.filter(c => c.status === 'allocated' && checkoutDueInfo(c).overdue).map(c => c.itemId)), [checkouts]);

  const typeOptions = useMemo(() => {
    const present = new Set(items.filter(i => deptFilter === 'All' || (i.department || '') === deptFilter).map(i => (i.itemType || '').trim()).filter(Boolean));
    return [...new Set([...ITEM_TYPES, ...present])].filter(t => present.has(t) || deptFilter === 'All').sort();
  }, [items, deptFilter]);
  const locationOptions = useMemo(() => [...new Set(items.map(i => (i.location || '').trim()).filter(Boolean))].sort(), [items]);
  const modelOptions = useMemo(() => [...new Set(items.filter(i =>
    (deptFilter === 'All' || (i.department || '') === deptFilter) && (typeFilter === 'All' || (i.itemType || '') === typeFilter))
    .map(i => cleanField(i.model)).filter(Boolean))].sort(), [items, deptFilter, typeFilter]);
  useEffect(() => { if (typeFilter !== 'All' && !typeOptions.includes(typeFilter)) setTypeFilter('All'); }, [typeOptions, typeFilter]);
  useEffect(() => { if (modelFilter !== 'All' && !modelOptions.includes(modelFilter)) setModelFilter('All'); }, [modelOptions, modelFilter]);

  const scoped = useMemo(() => items.filter(i =>
    (deptFilter === 'All' || (i.department || '') === deptFilter)
    && (ownershipFilter === 'All' || (i.ownershipType || 'transient') === ownershipFilter)
    && (locationFilter === 'All' || (i.location || '') === locationFilter)
    && (typeFilter === 'All' || (i.itemType || '') === typeFilter)
    && (modelFilter === 'All' || cleanField(i.model) === modelFilter)), [items, deptFilter, ownershipFilter, locationFilter, typeFilter, modelFilter]);

  // Four tiles that matter (the old strip had seven): what can go out, what is
  // out, what is late, and what it is all worth. A tile narrows the table.
  const kpis = [
    { key: 'available', label: 'Available to Borrow', value: scoped.filter(i => i.status === 'available' && i.ownershipType !== 'permanent' && !i.hasActiveRequest).length },
    { key: 'checked_out', label: 'In Use', value: scoped.filter(i => i.status === 'checked_out').length },
    { key: 'overdue', label: 'Overdue', value: scoped.filter(i => overdueIds.has(i.id)).length, tone: 'overdue' },
    { key: null, label: 'Total Value', value: fmtMoney(scoped.reduce((s, i) => s + (Number(i.assetValue) || 0), 0)), sub: `${scoped.length} items` },
  ];
  const kpiStrip = (
    <div className="it-kpis">
      {kpis.map(k => {
        const on = k.key && cardFilter === k.key;
        return (
          <button key={k.label} type="button" className={`it-kpi${on ? ' is-on' : ''}${k.tone === 'overdue' && k.value ? ' is-overdue' : ''}`}
            aria-pressed={!!on} disabled={!k.key}
            onClick={() => setCardFilter(prev => (!k.key || prev === k.key) ? null : k.key)}>
            <span className="it-kpi-label">{k.label}</span>
            <span className="it-kpi-value">{k.value}</span>
            {k.sub && <span className="it-kpi-sub">{k.sub}</span>}
          </button>
        );
      })}
    </div>
  );

  const sel = (v) => (v && v !== 'All') ? ' is-on' : '';
  const filterSelects = (
    <>
      <Filter size={13} style={{ color: 'var(--muted)' }} aria-hidden="true" />
      <select className={`form-input it-select${sel(deptFilter)}`} value={deptFilter} onChange={e => setDeptFilter(e.target.value)} aria-label="Department">
        {DEPARTMENTS.map(d => <option key={d} value={d}>{d === 'All' ? 'All Departments' : d}</option>)}
      </select>
      <select className={`form-input it-select${sel(locationFilter)}`} value={locationFilter} onChange={e => setLocationFilter(e.target.value)} aria-label="Location">
        <option value="All">All Locations</option>
        {locationOptions.map(l => <option key={l}>{l}</option>)}
      </select>
      <select className={`form-input it-select${sel(typeFilter)}`} value={typeFilter} onChange={e => setTypeFilter(e.target.value)} aria-label="Type">
        <option value="All">All Types</option>
        {typeOptions.map(t => <option key={t}>{t}</option>)}
      </select>
      {modelOptions.length > 0 && (
        <select className={`form-input it-select${sel(modelFilter)}`} value={modelFilter} onChange={e => setModelFilter(e.target.value)} aria-label="Model">
          <option value="All">All Models</option>
          {modelOptions.map(m => <option key={m}>{m}</option>)}
        </select>
      )}
      <select className={`form-input it-select${sel(ownershipFilter)}`} value={ownershipFilter} onChange={e => setOwnershipFilter(e.target.value)} aria-label="Ownership">
        <option value="All">All Ownership</option>
        <option value="transient">Temporary</option>
        <option value="permanent">Permanent</option>
      </select>
    </>
  );

  function handleAddItem(data, opts = {}) {
    return api.createItem(data)
      .then(created => {
        addItemLocal?.(created); toast(`Added ${data.name}${created?.serialNumber ? ` (${created.serialNumber})` : ''}.`);
        if (opts.assignNow && created?.id) setSheet({ kind: 'assign', item: created });
        if (opts.aiFill && created?.id) api.autoFillItemPhotos([created.id], false).then(() => refreshItems?.()).catch(() => {});
      });
  }
  function handleEditItem(item, data) {
    const changed = diffItemEdit(item, data);
    if (Object.keys(changed).length === 0) { toast('No changes to save.'); return Promise.resolve(); }
    return api.updateItem(item.id, changed).then(updated => { patchItemLocal?.(updated); toast(`Updated ${data.name}.`); });
  }
  function handleDeleteItem(item) {
    return api.deleteItem(item.id)
      .then(() => { removeItemsLocal?.(item.id); toast(`${item.name} moved to the Recycle Bin.`); setSheet(null); })
      .catch(err => { toast(err?.message || 'Could not delete the item.', 'error'); throw err; });
  }
  const afterImport = (res) => {
    refreshItems?.();
    toast(`Imported ${res.created} item${res.created !== 1 ? 's' : ''}${res.updated ? `, updated ${res.updated}` : ''}${res.conflicts?.length ? ` · ${res.conflicts.length} not imported` : ''}.`);
    if ((res.added_types || []).length) refreshItemTypes();
    return res;
  };

  return (
    <div className="it-inventory">
      <div className="it-segment" role="tablist" aria-label="Inventory views">
        {VIEWS.map(v => (
          <button key={v.key} role="tab" aria-selected={current === v.key} className={current === v.key ? 'is-on' : ''} onClick={() => onViewChange(v.key)}>
            <v.Icon size={14} aria-hidden="true" /> {v.label}
          </button>
        ))}
      </div>

      {current === 'table' && (
        <ManagerManageTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} ownershipFilter={ownershipFilter} locationFilter={locationFilter} modelFilter={modelFilter}
          search={deferredSearch} searchValue={search} onSearchChange={setSearch}
          refreshItems={refreshItems} canDelete={canDelete}
          onAdd={() => setSheet({ kind: 'add' })} onEdit={item => setSheet({ kind: 'edit', item })}
          onDelete={item => setSheet({ kind: 'delete', item })} onImport={() => setSheet({ kind: 'import' })}
          onExport={rows => downloadItemsCsv(Array.isArray(rows) && rows.length ? rows : items, customFields)}
          onExportAllPdf={() => api.getItemsReport({ format: 'pdf' }).then(({ blob, filename }) => triggerDownload(filename, blob)).catch(() => toast('Could not make the PDF.', 'error'))}
          onReport={ctx => setSheet({ kind: 'report', initial: ctx || null })}
          checkouts={checkouts} toast={toast}
          onAssign={item => setSheet({ kind: 'assign', item })} onDetails={item => onOpenItem(item.id)}
          onShowDeleted={() => setSheet({ kind: 'deleted' })}
          itemTypes={itemTypes} overdueIds={overdueIds}
          highlightId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)}
          filterControls={filterSelects} cardFilter={cardFilter} kpiStrip={kpiStrip} />
      )}
      {current === 'whohas' && (
        <WhoHasItTab items={items} checkouts={checkouts} onOpenItem={onOpenItem} />
      )}
      {current === 'activity' && (
        <AuditLogPanel items={items} onChanged={refreshItems}
          onOpenItem={it => { const found = items.find(x => x.id === it.id); if (found) onOpenItem(found.id); else toast('That item no longer exists (it may have been deleted).', 'error'); }}
          onLocate={it => {
            const found = items.find(x => x.id === it.id) || (it.name && items.find(x => x.name === it.name));
            if (found) {
              setSearch(''); setDeptFilter('All'); setTypeFilter('All'); setOwnershipFilter('All'); setLocationFilter('All'); setModelFilter('All'); setCardFilter(null);
              onViewChange('table');
              setHighlightItemId(null); setTimeout(() => setHighlightItemId(found.id), 0);
            } else { setDeletedHighlightId(it.id || ''); setSheet({ kind: 'deleted' }); }
          }} />
      )}

      {sheet?.kind === 'add' && <AddItemModal allowAddAnother onClose={() => setSheet(null)} onSave={handleAddItem} types={itemTypes} />}
      {sheet?.kind === 'edit' && <EditItemModal item={sheet.item} onClose={() => setSheet(null)} onSave={data => handleEditItem(sheet.item, data)} types={itemTypes} />}
      {sheet?.kind === 'delete' && <DeleteItemModal item={sheet.item} onClose={() => setSheet(null)} onConfirm={() => handleDeleteItem(sheet.item)} />}
      {sheet?.kind === 'deleted' && (
        <DeletedItemsModal onClose={() => { setSheet(null); setDeletedHighlightId(null); }} onRestored={refreshItems} toast={toast} highlightId={deletedHighlightId} />
      )}
      {sheet?.kind === 'import' && (
        <ImportItemsModal onClose={() => setSheet(null)} customFields={customFields}
          onImport={rows => api.importItems(rows).then(afterImport)}
          onRestoreConflicts={rows => api.importItemsRestoring(rows).then(afterImport)}
          knownDepts={[...new Set([...DEPARTMENTS.filter(d => d !== 'All'), ...items.map(i => (i.department || '').trim()).filter(Boolean)])]}
          knownLocations={locationOptions} />
      )}
      {sheet?.kind === 'report' && <ReportModal onClose={() => setSheet(null)} checkouts={checkouts} initial={sheet.initial} />}
      {sheet?.kind === 'assign' && (
        <AssignItemModal item={sheet.item} userEmail={myEmail} toast={toast}
          locations={locationOptions} onClose={() => setSheet(null)}
          onDone={() => { refreshAssignments(); refreshItems?.(); }} />
      )}
    </div>
  );
}
