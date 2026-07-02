import { useState, useEffect, useCallback } from 'react';
import { Settings, ArrowLeft, Pencil, Search } from 'lucide-react';

import { PT } from './lib/propertyFields.js';
import { ASSET_SCHEMAS, inferAssetKind } from './lib/vehicleFields.js';
import { RECORD_TYPES } from './lib/recordTypes.jsx';
import { normLabel, genId, toNumber, snapMap } from './lib/format.js';
import { editGuard } from './lib/editGuard.js';
import { makeLogEntry, appendLog, diffChanges, recordDisplayName } from './lib/logging.js';
import { TAB_LIST, visibleTabsFor, SHARED_FILTER_GROUPS, LOG_SECTION_TO_TAB, UNDOABLE_FIELD_KEYS } from './lib/navigation.js';
import { TIMELINE_FIELDS, permitColumns } from './lib/timelineFields.js';
import { useNexusStore } from './lib/useNexusStore.js';
import { portfolioStats } from './lib/assetMetrics.js';

import { CopyButton } from './components/shared/CopyButton.jsx';
import { ToastHost, pushToast } from './components/shared/ToastHost.jsx';
import { SyncStatus } from './components/shared/SyncStatus.jsx';
import { ScrollTopFab } from './components/shared/ScrollTopFab.jsx';
import { CollectionTable } from './components/shared/CollectionTable.jsx';
import { RecordModal } from './components/shared/RecordModal.jsx';

import { Portfolio } from './components/portfolio/Portfolio.jsx';
import { HealthStrip } from './components/asset/HealthStrip.jsx';
import { CriticalDates } from './components/asset/CriticalDates.jsx';
import { AssetDetailForm } from './components/asset/AssetDetailForm.jsx';
import { ParcelManager } from './components/asset/ParcelManager.jsx';
import { AssemblageParcels } from './components/asset/AssemblageParcels.jsx';
import { ExportMenu } from './components/asset/ExportMenu.jsx';
import { AddAssetModal } from './components/asset/AddAssetModal.jsx';
import { TimelineTracker } from './components/asset/TimelineTracker.jsx';
import { SimpleRecordTable } from './components/shared/SimpleRecordTable.jsx';
import { SimpleRowModal } from './components/shared/SimpleRowModal.jsx';
import { TimelineStatusModal } from './components/asset/TimelineStatusModal.jsx';

import { VserviceSection } from './components/maintenance/VserviceSection.jsx';
import { PropertyMaintenanceSection } from './components/maintenance/PropertyMaintenanceSection.jsx';

import { ManagePage } from './components/manage/ManagePage.jsx';

import { exportAssetCsvAsFile, exportAssetPdf } from './lib/csvExport.js';
import { useSession } from './lib/session.js';

const cityRegion = (p) => (p.city || '') + (p.state ? ', ' + p.state : '');

export default function App() {
  const session = useSession();
  const canManage = session?.can ? session.can('manager') : false;

  // `store` is the whole app's data: { properties, warranties, inspections, documents, ahj,
  // utilities, vendors, logs, vservice, odometer, vdocs, maintenance, _ts }. useNexusStore
  // owns hydration (localStorage -> IndexedDB -> server reconcile) and background sync — see
  // lib/useNexusStore.js and lib/sync.js. This component only ever reads `store` and calls
  // `setStore(updater)`; it never touches localStorage/IndexedDB/the network directly.
  const [store, setStore, loading] = useNexusStore();

  const [view, setView] = useState('portfolio');       // 'portfolio' | 'manage' | a TAB_LIST key
  const [activeId, setActiveId] = useState(null);        // currently open asset's id, or null
  const [leaveAsk, setLeaveAsk] = useState(false);        // "unsaved changes" confirm dialog
  const [pendingNav, setPendingNav] = useState(null);     // navigation to run after that dialog resolves
  const [filters, setFilters] = useState({});             // per-tab search text, keyed by tab (or shared group)
  const [modal, setModal] = useState(null);                // the currently-open record/asset/timeline modal, if any
  const [lastManageVisit, setLastManageVisit] = useState(() => { try { return localStorage.getItem('nexus_manage_seen') || ''; } catch { return ''; } });
  const [highlight, setHighlight] = useState(null);        // deep-link target set by "Go to" from the Activity Log
  const [typeFilter, setTypeFilter] = useState('');

  const unseenLogCount = (store.logs || []).filter((l) => l.ts > lastManageVisit).length;
  const markManageSeen = () => {
    const now = new Date().toISOString();
    setLastManageVisit(now);
    try { localStorage.setItem('nexus_manage_seen', now); } catch {}
  };
  // Visiting Manage, or any new log arriving while already on Manage, marks everything read.
  useEffect(() => { if (view === 'manage') markManageSeen(); }, [view, store.logs]);

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(t);
  }, [highlight]);

  // Officers/execs/admins (role check) can see private-flagged assets; everyone else can't.
  const canSeePrivate = session && (session.level >= 5 || /owner|officer|exec|admin/i.test(session.role || ''));
  const visibleProperties = store.properties.filter((p) => !p.deleted && (!p.private || canSeePrivate));
  const deletedProperties = store.properties.filter((p) => p.deleted);
  const findAsset = (id) => visibleProperties.find((p) => p.id === id);
  const active = activeId ? findAsset(activeId) : null;
  const recordsFor = (coll) => (store[coll] || []).filter((r) => r.propertyId === activeId);

  const openAsset = (id, tab = 'property') => { setActiveId(id); setView(tab); };

  /** All navigation goes through this — it's what enforces the unsaved-changes guard. */
  const navigate = (nextView) => {
    const go = () => {
      setView(nextView);
      if (nextView === 'manage') { setActiveId(null); markManageSeen(); }
    };
    if (editGuard.dirty) { setPendingNav(() => go); setLeaveAsk(true); }
    else go();
  };

  /** "Go to" from the Activity Log: jump straight to the asset + tab + field a log entry touched. */
  const goToLogEntry = (entry) => {
    const tab = LOG_SECTION_TO_TAB[entry.section] || 'property';
    if (entry.propertyId) setActiveId(entry.propertyId);
    setView(tab);
    setHighlight({ tab, section: entry.section, field: entry.changes?.[0]?.field || '', item: entry.item || '', at: Date.now() });
  };

  // ---------------------------------------------------------------------------------------
  // Mutations. Every one of these follows the same shape: compute the new store, append a
  // log entry via appendLog()+makeLogEntry(), setStore(...), close whatever modal triggered it.
  // ---------------------------------------------------------------------------------------

  /** Add or edit a row in a simple collection (warranties, inspections, maintenance, ...). */
  const saveRecord = (coll, id, patch) => {
    setStore((s) => {
      const rows = [...(s[coll] || [])];
      const asset = s.properties.find((p) => p.id === activeId);
      const base = { section: RECORD_TYPES[coll].plural, property: asset?.name || '', propertyId: activeId };
      let entry;
      if (id) {
        const idx = rows.findIndex((r) => r.id === id);
        if (idx >= 0) {
          const changes = diffChanges(RECORD_TYPES[coll].fields, rows[idx], patch);
          rows[idx] = { ...rows[idx], ...patch };
          if (changes.length) entry = { ...base, action: 'edited', item: recordDisplayName(coll, rows[idx]), changes };
        }
      } else {
        const row = { id: genId(), propertyId: activeId, ...patch };
        rows.push(row);
        entry = { ...base, action: 'added', item: recordDisplayName(coll, row), changes: [] };
      }
      return appendLog({ ...s, [coll]: rows }, entry && makeLogEntry(entry));
    });
    setModal(null);
    pushToast(id ? 'Changes saved' : RECORD_TYPES[coll].title + ' added', 'ok');
  };

  /** Delete a row from a simple collection. */
  const deleteRecord = (coll, id, reason) => {
    setStore((s) => {
      const removed = s[coll].find((r) => r.id === id);
      const asset = s.properties.find((p) => p.id === activeId);
      const next = { ...s, [coll]: s[coll].filter((r) => r.id !== id) };
      if (!removed) return next;
      return appendLog(next, makeLogEntry({ section: RECORD_TYPES[coll].plural, property: asset?.name || '', propertyId: activeId, action: 'removed', item: recordDisplayName(coll, removed), changes: [], reason: reason || '' }));
    });
    setModal(null);
    pushToast('Removed', 'mut');
  };

  /** Add/edit a row inside an asset's own `timeline`/`permits` array (not a top-level collection).
   *  `reason` is required by TimelineStatusModal (status changes must be justified) and optional
   *  everywhere else. */
  const savePropertyListRow = (field, index, patch, fieldDefs, reason) => {
    const sectionLabel = field === 'timeline' ? 'Timeline' : 'Permit';
    const describe = (row) => { for (const [k] of fieldDefs || []) { const v = String(row?.[k] ?? '').trim(); if (v) return v; } return sectionLabel + ' row'; };
    setStore((s) => {
      const props = [...s.properties];
      const idx = props.findIndex((p) => p.id === activeId);
      if (idx < 0) return s;
      const asset = props[idx];
      const rows = [...(asset[field] || [])];
      const base = { section: sectionLabel, property: asset.name, propertyId: activeId, reason: reason || '' };
      let entry;
      if (index != null && index >= 0 && index < rows.length) {
        const before = rows[index];
        rows[index] = { ...before, ...patch };
        const changes = (fieldDefs || []).filter(([k]) => String(before[k] ?? '') !== String(patch[k] ?? '')).map(([k, label]) => ({ field: label || k, from: String(before[k] ?? ''), to: String(patch[k] ?? '') }));
        if (changes.length || reason) entry = { ...base, action: 'edited', item: describe(rows[index]), changes };
      } else {
        rows.push({ ...patch });
        entry = { ...base, action: 'added', item: describe(patch), changes: [] };
      }
      props[idx] = { ...asset, [field]: rows };
      return appendLog({ ...s, properties: props }, entry && makeLogEntry(entry));
    });
    setModal(null);
  };

  const deletePropertyListRow = (field, index, fieldDefs) => {
    const sectionLabel = field === 'timeline' ? 'Timeline' : 'Permit';
    const describe = (row) => { for (const [k] of fieldDefs || []) { const v = String(row?.[k] ?? '').trim(); if (v) return v; } return sectionLabel + ' row'; };
    setStore((s) => {
      const props = [...s.properties];
      const idx = props.findIndex((p) => p.id === activeId);
      if (idx < 0 || index == null) return s;
      const asset = props[idx];
      const rows = [...(asset[field] || [])];
      if (index < 0 || index >= rows.length) return s;
      const [removed] = rows.splice(index, 1);
      props[idx] = { ...asset, [field]: rows };
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: sectionLabel, property: asset.name, propertyId: activeId, action: 'removed', item: describe(removed), changes: [] }));
    });
    setModal(null);
  };

  // --- Parcel linking (group-first: order + multiple-primary flags, not parent/child) --------

  const linkParcel = (targetId) => {
    setStore((s) => {
      const anchorId = active.parentId || active.id;
      const anchor = s.properties.find((p) => p.id === anchorId) || active;
      const siteName = anchor.siteName || anchor.name;
      const orders = s.properties.filter((p) => p.id === anchorId || p.parentId === anchorId).map((p) => p.parcelOrder ?? 0);
      const maxOrder = orders.length ? Math.max(...orders) : 0;
      const props = s.properties.map((p) =>
        p.id === anchorId ? { ...p, siteName, parcelOrder: p.parcelOrder ?? 0, primary: p.primary ?? true }
        : p.id === targetId ? { ...p, parentId: anchorId, siteName, primary: false, parcelOrder: maxOrder + 1 }
        : p
      );
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: active.name, propertyId: activeId, action: 'edited', item: 'Linked parcel', changes: [] }));
    });
  };

  const unlinkParcel = (id) => {
    setStore((s) => {
      const removed = s.properties.find((p) => p.id === id);
      if (!removed) return s;
      const anchorId = removed.parentId || removed.id;
      const remaining = s.properties.filter((p) => (p.id === anchorId || p.parentId === anchorId) && !p.deleted && p.id !== id);
      let props;
      if (removed.id === anchorId && remaining.length > 0) {
        const newAnchor = [...remaining].sort((a, b) => (a.parcelOrder ?? 0) - (b.parcelOrder ?? 0))[0];
        const siteName = removed.siteName || removed.name;
        props = s.properties.map((p) =>
          p.id === id ? { ...p, parentId: '', siteName: '', primary: false, parcelOrder: null }
          : p.id === newAnchor.id ? { ...p, parentId: '', siteName }
          : p.parentId === anchorId ? { ...p, parentId: newAnchor.id, siteName }
          : p
        );
      } else {
        props = s.properties.map((p) => p.id === id ? { ...p, parentId: '', siteName: '', primary: false, parcelOrder: null } : p);
      }
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: active.name, propertyId: activeId, action: 'edited', item: 'Unlinked parcel', changes: [] }));
    });
  };

  const renameGroup = (newName) => {
    setStore((s) => {
      const anchorId = active.parentId || active.id;
      const props = s.properties.map((p) => (p.id === anchorId || p.parentId === anchorId) ? { ...p, siteName: newName } : p);
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: active.name, propertyId: activeId, action: 'edited', item: 'Renamed asset group', changes: [] }));
    });
  };

  const setAssembled = (on) => {
    setStore((s) => {
      const anchorId = active.parentId || active.id;
      const props = s.properties.map((p) => (p.id === anchorId || p.parentId === anchorId) ? { ...p, assembled: on } : p);
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: active.name, propertyId: activeId, action: 'edited', item: on ? 'Set group as one assembled asset' : 'Unset assembled asset', changes: [] }));
    });
  };

  const togglePrimaryParcel = (id) => {
    setStore((s) => {
      const target = s.properties.find((p) => p.id === id);
      const props = s.properties.map((p) => p.id === id ? { ...p, primary: !p.primary } : p);
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: target ? target.name : active.name, propertyId: activeId, action: 'edited', item: 'Toggled primary parcel', changes: [] }));
    });
  };

  const moveParcelOrder = (id, dir) => {
    setStore((s) => {
      const start = s.properties.find((p) => p.id === id);
      if (!start) return s;
      const anchorId = start.parentId || start.id;
      const members = s.properties.filter((p) => (p.id === anchorId || p.parentId === anchorId) && !p.deleted)
        .map((p, i) => ({ id: p.id, order: p.parcelOrder ?? i })).sort((a, b) => a.order - b.order);
      const idx = members.findIndex((m) => m.id === id);
      const swapWith = idx + dir;
      if (idx < 0 || swapWith < 0 || swapWith >= members.length) return s;
      const normalized = members.map((m, i) => ({ id: m.id, order: i }));
      [normalized[idx].order, normalized[swapWith].order] = [normalized[swapWith].order, normalized[idx].order];
      const orderById = Object.fromEntries(normalized.map((m) => [m.id, m.order]));
      const props = s.properties.map((p) => orderById[p.id] != null ? { ...p, parcelOrder: orderById[p.id] } : p);
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: active.name, propertyId: activeId, action: 'edited', item: 'Reordered parcels', changes: [] }));
    });
  };

  const duplicateAsset = (linked) => {
    const newId = 'asset-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setStore((s) => {
      const src = s.properties.find((p) => p.id === activeId);
      if (!src) return s;
      const EMPTY_COLLECTIONS = ['warranties', 'inspections', 'documents', 'vendors', 'utilities', 'ahj', 'vservice', 'odometer', 'vdocs', 'permits', 'plans'];
      const copy = { ...src, id: newId, name: (src.name || 'Asset') + ' (Copy)' };
      EMPTY_COLLECTIONS.forEach((k) => { copy[k] = []; });

      if (linked) {
        const anchorId = src.parentId || src.id;
        const anchor = s.properties.find((p) => p.id === anchorId) || src;
        const siteName = anchor.siteName || anchor.name;
        const orders = s.properties.filter((p) => p.id === anchorId || p.parentId === anchorId).map((p) => p.parcelOrder ?? 0);
        const maxOrder = orders.length ? Math.max(...orders) : 0;
        Object.assign(copy, { parentId: anchorId, siteName, primary: false, parcelOrder: maxOrder + 1 });
        const props = [...s.properties.map((p) => (p.id === anchorId && p.parcelOrder == null) ? { ...p, parcelOrder: 0, primary: p.primary ?? true, siteName: p.siteName || p.name } : p), copy];
        return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: copy.name, propertyId: newId, action: 'added', item: 'Duplicated as linked parcel', changes: [] }));
      }
      Object.assign(copy, { parentId: '', siteName: '', primary: false, parcelOrder: null });
      return appendLog({ ...s, properties: [...s.properties, copy] }, makeLogEntry({ section: 'Property', property: copy.name, propertyId: newId, action: 'added', item: 'Duplicated asset', changes: [] }));
    });
    setActiveId(newId);
    navigate('property');
  };

  // --- Field-level operations (spec sheet, contacts, flags, privacy, multi-tenant units) -----

  const saveContact = (label, info) => {
    setStore((s) => {
      const props = [...s.properties];
      const idx = props.findIndex((p) => p.id === activeId);
      if (idx < 0) return s;
      const asset = props[idx];
      props[idx] = { ...asset, contacts: { ...(asset.contacts || {}), [normLabel(label)]: info } };
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: asset.name, propertyId: activeId, action: 'edited', item: `Contact — ${label}`, changes: [] }));
    });
  };

  /**
   * Writes an AssetDetailForm draft (keyed by field LABEL) back to the record.
   *   - Properties: rebuild the full `snapshot` from PT + the draft, and mirror any field with
   *     a `key` onto the top-level record too (acreage/nrsf/gsf are coerced to numbers).
   *   - Vehicles/equipment: patch matching labels directly in the existing flat `snapshot`,
   *     mirroring onto the top-level record via each schema field's `k`.
   */
  const saveDetail = (draft) => {
    setStore((s) => {
      const props = [...s.properties];
      const idx = props.findIndex((p) => p.id === activeId);
      if (idx < 0) return s;
      const asset = props[idx];
      const existing = snapMap(asset);
      const kind = inferAssetKind(asset);
      const flat = {};
      const changes = [];
      let snapshot;

      if (kind === 'property') {
        snapshot = PT.map((group) => ({
          group: group.group,
          fields: group.fields.map((f) => {
            const hasDraftValue = f.label in draft;
            let value = hasDraftValue ? draft[f.label]
              : existing[normLabel(f.label)] !== undefined ? existing[normLabel(f.label)]
              : f.key && asset[f.key] != null ? String(asset[f.key]) : '';
            if (f.type === 'stage' && !hasDraftValue) value = asset.devStage || value;
            if (hasDraftValue) {
              const old = existing[normLabel(f.label)] ?? '';
              if (String(old) !== String(value)) changes.push({ field: f.label, from: old, to: value });
              if (f.key) flat[f.key] = ['acreage', 'nrsf', 'gsf'].includes(f.key) ? toNumber(value) : value;
            }
            return { label: f.label, value: value == null ? '' : value };
          }),
        }));
        if ('Development Stage' in draft) flat.devStage = draft['Development Stage'];
      } else {
        const schema = ASSET_SCHEMAS[kind] || [];
        const labelToKey = {};
        schema.forEach((f) => { if (f.k && f.label) labelToKey[normLabel(f.label)] = f.k; });
        snapshot = (asset.snapshot || []).map((group) => ({
          ...group,
          fields: (group.fields || []).map((f) => {
            if (!(f.label in draft)) return f;
            const value = draft[f.label];
            if (String(f.value) !== String(value)) changes.push({ field: f.label, from: f.value, to: value });
            const key = labelToKey[normLabel(f.label)];
            if (key) flat[key] = value;
            return { ...f, value };
          }),
        }));
      }

      props[idx] = { ...asset, ...flat, snapshot };
      const next = { ...s, properties: props };
      return changes.length
        ? appendLog(next, makeLogEntry({ section: 'Property', property: props[idx].name, propertyId: activeId, action: 'edited', item: props[idx].name, changes: changes.slice(0, 40) }))
        : next;
    });
    pushToast('Changes saved', 'ok');
  };

  const toggleFlag = (assetId, group, field, reason) => {
    setStore((s) => ({
      ...s,
      properties: s.properties.map((p) => {
        if (p.id !== assetId) return p;
        const flags = (p.reviewFlags || []).slice();
        const idx = flags.findIndex((x) => x.g === group && x.f === field);
        if (idx >= 0) flags.splice(idx, 1);
        else flags.push(makeLogEntry({ g: group, f: field, reason: reason || 'Needs review' }));
        return { ...p, reviewFlags: flags };
      }),
    }));
  };

  const pushFieldFix = (assetId, group, field, newValue) => {
    setStore((s) => {
      const props = s.properties.map((p) => {
        if (p.id !== assetId) return p;
        const ptGroup = PT.find((g) => g.group === group);
        const ptField = ptGroup && ptGroup.fields.find((f) => f.label === field);
        const flat = ptField && ptField.key ? { [ptField.key]: newValue } : {};
        const snapshot = (p.snapshot || []).map((g) => g.group === group
          ? { ...g, fields: (g.fields || []).map((f) => normLabel(f.label) === normLabel(field) ? { ...f, value: newValue } : f) }
          : g);
        const reviewFlags = (p.reviewFlags || []).filter((x) => !(x.g === group && x.f === field));
        return { ...p, ...flat, snapshot, reviewFlags };
      });
      const target = props.find((p) => p.id === assetId);
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: target?.name || '', propertyId: assetId, action: 'edited', item: target?.name || '', changes: [{ field, from: '', to: newValue }] }));
    });
  };

  const togglePrivate = (id) => {
    setStore((s) => {
      const idx = s.properties.findIndex((p) => p.id === id);
      if (idx < 0) return s;
      const before = s.properties[idx];
      const nowPrivate = !before.private;
      const next = { ...before, private: nowPrivate };
      return appendLog(
        { ...s, properties: s.properties.map((p, i) => i === idx ? next : p) },
        makeLogEntry({ section: 'Property', property: next.name, propertyId: id, action: 'edited', item: next.name, changes: [{ field: 'Private', from: String(!!before.private), to: String(nowPrivate) }] })
      );
    });
  };

  const setTenantUnits = (id, units) => {
    setStore((s) => {
      const idx = s.properties.findIndex((p) => p.id === id);
      if (idx < 0) return s;
      const before = s.properties[idx];
      const next = { ...before, tenantUnits: units };
      return appendLog(
        { ...s, properties: s.properties.map((p, i) => i === idx ? next : p) },
        makeLogEntry({ section: 'Property', property: next.name, propertyId: id, action: 'edited', item: next.name, changes: [{ field: 'Units', from: `${(before.tenantUnits || []).length} unit(s)`, to: `${units.length} unit(s)` }] })
      );
    });
  };

  const saveImages = (images) => {
    setStore((s) => {
      const props = [...s.properties];
      const idx = props.findIndex((p) => p.id === activeId);
      if (idx < 0) return s;
      const asset = props[idx];
      const before = asset.images?.length ? asset.images.length : (asset.image ? 1 : 0);
      props[idx] = { ...asset, images, image: images[0] || '' };
      const next = { ...s, properties: props };
      if (before === images.length) return next;
      return appendLog(next, makeLogEntry({ section: 'Property', property: asset.name, propertyId: activeId, action: 'edited', item: asset.name, changes: [{ field: 'Pictures', from: `${before} photo${before === 1 ? '' : 's'}`, to: `${images.length} photo${images.length === 1 ? '' : 's'}` }] }));
    });
  };

  /** Add/edit an ASSET itself (the guided Add-Asset modal's onSave — property/vehicle/equipment). */
  const saveAsset = (id, patch, reason, linkOptions) => {
    setStore((s) => {
      let props = [...s.properties];
      let assetId = id;
      let action = 'edited';
      let priorParentId = '';
      let changes = [];
      let displayName;

      if (id) {
        const idx = props.findIndex((p) => p.id === id);
        if (idx < 0) return s;
        const before = props[idx];
        priorParentId = before.parentId || '';
        const schema = Object.values(ASSET_SCHEMAS).flat().filter((f) => f.k !== 'parentId'); // any flat schema works for label lookup
        changes = diffChanges(schema, before, patch);
        props[idx] = { ...before, ...patch };
        displayName = props[idx].name;
      } else {
        const row = { id: genId(), parentId: '', siteName: '', ...patch };
        assetId = row.id;
        props.push(row);
        setTimeout(() => setActiveId(row.id), 0);
        action = 'added';
        displayName = row.name;
      }

      if (linkOptions) {
        const anchorOf = (pid) => { const p = props.find((x) => x.id === pid); return p ? (p.parentId || p.id) : ''; };
        if (linkOptions.role === 'none') {
          props = props.map((p) => (p.id === assetId && p.parentId) ? { ...p, parentId: '', siteName: '' } : p);
        } else if (linkOptions.role === 'secondary' && linkOptions.targetId) {
          const anchorId = anchorOf(linkOptions.targetId);
          const anchor = props.find((p) => p.id === anchorId);
          const siteName = (anchor?.siteName || anchor?.name || '').trim();
          props = props.map((p) => p.id === assetId ? { ...p, parentId: anchorId, siteName } : (p.id === anchorId && !p.siteName) ? { ...p, siteName } : p);
        } else if (linkOptions.role === 'primary' && linkOptions.targetId) {
          const anchorId = anchorOf(linkOptions.targetId);
          const self = props.find((p) => p.id === assetId);
          const siteName = (self?.siteName || self?.name || '').trim();
          props = props.map((p) => p.id === assetId ? { ...p, parentId: '', siteName } : (p.id === anchorId || p.parentId === anchorId) ? { ...p, parentId: assetId, siteName } : p);
        }
      }

      const newParentId = props.find((p) => p.id === assetId)?.parentId || '';
      if (id && priorParentId !== newParentId) {
        const nameOf = (pid) => pid ? (props.find((p) => p.id === pid)?.name || '(removed)') : 'Standalone';
        changes = [...changes, { field: 'Linked under', from: nameOf(priorParentId), to: nameOf(newParentId) }];
      }

      let entry;
      if (action === 'added') entry = { section: 'Property', property: displayName, propertyId: assetId, action: 'added', item: displayName, changes: [] };
      else if (changes.length) entry = { section: 'Property', property: displayName, propertyId: assetId, action: 'edited', item: displayName, changes, reason: reason || '' };

      return appendLog({ ...s, properties: props }, entry && makeLogEntry(entry));
    });
    setModal(null);
  };

  /** Soft-delete an asset (and un-link any children it had). */
  const deleteAsset = (id, keepModalClosed) => {
    setStore((s) => {
      const target = s.properties.find((p) => p.id === id);
      const next = {
        ...s,
        properties: s.properties.map((p) => p.id === id ? { ...p, deleted: true, deletedAt: new Date().toISOString() } : p.parentId === id ? { ...p, parentId: '', siteName: '' } : p),
      };
      return target ? appendLog(next, makeLogEntry({ section: 'Property', property: target.name, propertyId: id, action: 'removed', item: target.name, changes: [] })) : next;
    });
    if (activeId === id) { setActiveId(null); setView('portfolio'); }
    if (!keepModalClosed) setModal(null);
  };

  const recoverAsset = (id) => {
    setStore((s) => {
      const target = s.properties.find((p) => p.id === id);
      const next = { ...s, properties: s.properties.map((p) => p.id === id ? { ...p, deleted: false, deletedAt: '' } : p) };
      return target ? appendLog(next, makeLogEntry({ section: 'Property', property: target.name, propertyId: id, action: 'edited', item: target.name, changes: [{ field: 'Status', from: 'Deleted', to: 'Recovered' }] })) : next;
    });
  };

  const purgeAsset = (id) => setStore((s) => ({ ...s, properties: s.properties.filter((p) => p.id !== id) }));

  /** Reverts a single Activity Log entry (added -> soft-delete, removed -> recover, edited ->
   *  restore prior field values via UNDOABLE_FIELD_KEYS). Only fields with a mapped top-level
   *  key are undo-able; snapshot-only field edits can't be mechanically reverted this way. */
  const undoLogEntry = (entry) => {
    setStore((s) => {
      const props = [...s.properties];
      const idx = props.findIndex((p) => p.id === entry.propertyId);
      if (idx < 0) return s;
      const asset = props[idx];
      let logEntry;

      if (entry.action === 'added' && !asset.deleted) {
        props.forEach((p, i) => { if (p.parentId === asset.id) props[i] = { ...p, parentId: '', siteName: '' }; });
        props[idx] = { ...asset, deleted: true, deletedAt: new Date().toISOString() };
        logEntry = { section: 'Property', property: asset.name, propertyId: asset.id, action: 'removed', item: asset.name, changes: [], reason: 'Undo — reversed an "Added"' };
      } else if (entry.action === 'removed' && asset.deleted) {
        props[idx] = { ...asset, deleted: false, deletedAt: '' };
        logEntry = { section: 'Property', property: asset.name, propertyId: asset.id, action: 'edited', item: asset.name, changes: [{ field: 'Status', from: 'Deleted', to: 'Recovered' }], reason: 'Undo — reversed a "Removed"' };
      } else if (entry.action === 'edited') {
        const revert = {};
        const reverseChanges = [];
        (entry.changes || []).forEach((c) => {
          const key = UNDOABLE_FIELD_KEYS[c.field];
          if (key != null) { revert[key] = c.from; reverseChanges.push({ field: c.field, from: c.to, to: c.from }); }
        });
        if (!reverseChanges.length) return s;
        props[idx] = { ...asset, ...revert };
        logEntry = { section: 'Property', property: props[idx].name, propertyId: asset.id, action: 'edited', item: props[idx].name, changes: reverseChanges, reason: 'Undo — restored previous value(s)' };
      } else return s;

      const logs = (s.logs || []).map((l) => l.id === entry.id ? { ...l, undone: true } : l);
      return appendLog({ ...s, properties: props, logs }, makeLogEntry(logEntry));
    });
    if (activeId === entry.propertyId && entry.action === 'added') { setActiveId(null); setView('manage'); }
  };

  const canUndo = (entry) => {
    if (!entry || entry.undone || entry.section !== 'Property') return false;
    const asset = store.properties.find((p) => p.id === entry.propertyId);
    if (!asset) return false;
    if (entry.action === 'added') return !asset.deleted;
    if (entry.action === 'removed') return !!asset.deleted;
    if (entry.action === 'edited') return (entry.changes || []).some((c) => UNDOABLE_FIELD_KEYS[c.field] != null);
    return false;
  };

  // ---------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------

  const pulse = view !== 'manage' && !active ? portfolioStats(store) : null;
  const assetKind = active ? inferAssetKind(active) : null;
  const tabsForActiveAsset = active ? visibleTabsFor(assetKind) : [];
  const filterKeysForTab = SHARED_FILTER_GROUPS[view] || [view];
  const showTabSearch = filterKeysForTab.length > 0 || ['timeline', 'permit'].includes(view);
  const searchValue = filterKeysForTab.length ? (filters[filterKeysForTab[0]] || '') : '';
  const setSearchValue = (text) => setFilters((f) => {
    const next = { ...f };
    filterKeysForTab.forEach((k) => { next[k] = text; });
    return next;
  });

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <ToastHost />
      <SyncStatus />

      {!active && view !== 'manage' && pulse && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <h1 style={{ fontSize: '1.5rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.02em', margin: 0 }}>Asset Management</h1>
          <span style={{ marginLeft: 'auto', fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {loading && !visibleProperties.length ? '…' : `${pulse.assets}${pulse.assets === 1 ? ' Asset' : ' Assets'}`}
          </span>
          <button className="primary-btn" onClick={() => navigate('manage')} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Settings size={14} /> Manage
            {unseenLogCount > 0 && <CountBadge n={unseenLogCount} />}
          </button>
        </div>
      )}

      {active && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          {(active.images?.[0] || active.image) && (
            <img
              src={active.images?.[0] || active.image}
              alt={active.name}
              title={active.name}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              style={{ width: 170, height: 127, objectFit: 'cover', objectPosition: 'center 30%', borderRadius: 14, border: '1px solid var(--border-color)', flexShrink: 0, boxShadow: 'var(--shadow-sm)' }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: '1.5rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.01em', color: 'var(--text-primary)', margin: 0 }}>{active.name}</h1>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span>{cityRegion(active) || '—'}</span>
              {assetKind === 'property' && <CopyButton text={cityRegion(active)} />}
            </div>
            <HealthStrip p={active} store={store} logs={store.logs} />
          </div>
          <button className="primary-btn" onClick={() => navigate('manage')} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
            <Settings size={14} /> Manage
            {unseenLogCount > 0 && <CountBadge n={unseenLogCount} />}
          </button>
        </div>
      )}

      {active && (
        <div className="gt-crumb" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 51, backgroundColor: 'var(--paper)', padding: '8px 4px 7px', marginBottom: 8 }}>
          <button onClick={() => (editGuard.dirty ? setLeaveAsk(true) : (setActiveId(null), setView('portfolio')))} title="Back to portfolio" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 15px', borderRadius: 999, border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, boxShadow: 'var(--shadow-sm)' }}>
            <ArrowLeft size={15} />Back
          </button>
          <div className="gt-bc-trail" style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 0, fontSize: '0.82rem' }}>
            <button onClick={() => (editGuard.dirty ? setLeaveAsk(true) : (setActiveId(null), setView('portfolio')))} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', flexShrink: 0, fontSize: '0.82rem' }}>Portfolio</button>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>›</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.name}</span>
          </div>

          <button
            onClick={() => togglePrivate(active.id)}
            title={active.private ? 'Click to make public (visible to all)' : 'Click to mark private (hidden from non-officers)'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 999, fontSize: '0.76rem', fontWeight: 700, marginLeft: 'auto', border: active.private ? '1px solid transparent' : '1px dashed var(--border-color)', cursor: 'pointer', backgroundColor: active.private ? 'hsla(var(--color-red), 0.12)' : 'transparent', color: active.private ? 'hsl(var(--color-red))' : 'var(--text-muted)' }}
          >
            {active.private ? '🔒 Private' : 'Mark Private'}
          </button>
          <button className="secondary-btn" onClick={() => duplicateAsset(false)} title="Duplicate this asset as a standalone copy" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>⧉ Duplicate</button>
          <ExportMenu onPdf={() => exportAssetPdf(active, store)} onCsv={() => exportAssetCsvAsFile(active, store)} />
        </div>
      )}

      {active && <ParcelManager active={active} all={store.properties} onOpen={(id) => openAsset(id, 'property')} onLink={linkParcel} onUnlink={unlinkParcel} onTogglePrimary={togglePrimaryParcel} onMove={moveParcelOrder} onRenameGroup={renameGroup} onDuplicate={() => duplicateAsset(true)} onSetAssembled={setAssembled} />}

      {leaveAsk && (
        <div onClick={() => setLeaveAsk(false)} style={{ position: 'fixed', inset: 0, zIndex: 600, background: 'rgba(8,12,22,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: 16, padding: '20px 20px 16px', maxWidth: 380, width: '100%', boxShadow: '0 20px 50px rgba(0,0,0,0.35)' }}>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 }}>Unsaved changes</div>
            <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 18 }}>You have unsaved changes on this asset. Save them before you leave?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <button className="primary-btn" onClick={() => { editGuard.save?.(); setLeaveAsk(false); const go = pendingNav; setPendingNav(null); go ? go() : (setActiveId(null), setView('portfolio')); }} style={{ width: '100%', padding: 12, fontSize: '0.9rem' }}>Save & leave</button>
              <button className="secondary-btn" onClick={() => { editGuard.cancel?.(); setLeaveAsk(false); const go = pendingNav; setPendingNav(null); go ? go() : (setActiveId(null), setView('portfolio')); }} style={{ width: '100%', padding: 12, fontSize: '0.9rem' }}>Discard & leave</button>
              <button onClick={() => { setLeaveAsk(false); setPendingNav(null); }} style={{ width: '100%', padding: 10, background: 'none', border: 'none', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.86rem', cursor: 'pointer' }}>Keep editing</button>
            </div>
          </div>
        </div>
      )}

      {active && (
        <>
          <div className="gt-tabs" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, padding: '8px 4px', position: 'sticky', top: 46, zIndex: 50, backgroundColor: 'var(--paper)', borderBottom: '1px solid var(--border-color)' }}>
            {tabsForActiveAsset.map(([key, defaultLabel]) => {
              const isActive = view === key;
              const label = (key === 'property' && assetKind !== 'property') ? 'Overview' : (key === 'documents' && assetKind !== 'property') ? 'Documents' : defaultLabel;
              return (
                <button key={key} onClick={() => navigate(key)} style={{ position: 'relative', padding: '8px 16px', borderRadius: 999, border: '1px solid', borderColor: isActive ? 'var(--pine)' : 'var(--border-color)', background: isActive ? 'var(--pine)' : 'var(--bg-card)', color: isActive ? '#fff' : 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {label}
                </button>
              );
            })}
            {view === 'property' && (
              <button className="primary-btn" onClick={() => editGuard.startEdit?.()} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', padding: '7px 14px' }}>
                <Pencil size={14} /> Edit
              </button>
            )}
            {showTabSearch && (
              <div style={{ position: 'relative', width: 220, marginLeft: view === 'property' ? undefined : 'auto' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
                <input className="form-input" placeholder="Search…" value={searchValue} onChange={(e) => setSearchValue(e.target.value)} style={{ width: '100%', fontSize: '0.82rem', padding: '7px 10px 7px 32px' }} />
              </div>
            )}
          </div>
        </>
      )}

      {view === 'portfolio' && !active && loading && !visibleProperties.length && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: 320, color: 'var(--text-secondary)' }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', border: '3px solid var(--border-color)', borderTopColor: 'var(--pine)', animation: 'spin 0.8s linear infinite' }} />
          <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Loading assets…</div>
        </div>
      )}
      {view === 'portfolio' && !active && !(loading && !visibleProperties.length) && <CriticalDates store={store} openProperty={openAsset} hideIfEmpty />}
      {view === 'portfolio' && !active && !(loading && !visibleProperties.length) && <Portfolio props={visibleProperties} openProperty={openAsset} typeFilter={typeFilter} setTypeFilter={setTypeFilter} />}

      {view === 'property' && active?.assembled && !active.parentId && <AssemblageParcels lead={active} all={store.properties} onOpen={(id) => openAsset(id, 'property')} />}
      {view === 'property' && active && <CriticalDates store={store} only={active.id} openProperty={openAsset} onTab={navigate} />}
      {view === 'property' && active && (
        <AssetDetailForm p={active} onSaveImages={saveImages} onSaveDetail={saveDetail} onSaveContact={saveContact} highlight={highlight?.tab === 'property' ? highlight : null} onOpenLead={(id) => openAsset(id, 'property')} onFlag={toggleFlag} />
      )}

      {['warranties', 'inspections', 'documents', 'vdocs', 'utilities', 'ahj', 'vendors', 'odometer'].map((coll) => (
        view === coll && active && (
          <CollectionTable
            key={coll}
            coll={coll}
            rows={recordsFor(coll)}
            active={active}
            filters={filters}
            setFilters={setFilters}
            highlightItem={highlight?.tab === coll || highlight?.section === RECORD_TYPES[coll].plural ? highlight.item : ''}
            onAdd={() => setModal({ type: 'row', coll, id: null })}
            onEdit={(id) => setModal({ type: 'row', coll, id })}
          />
        )
      ))}

      {view === 'maintenance' && active && (
        <PropertyMaintenanceSection p={active} rows={recordsFor('maintenance')} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'maintenance' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'maintenance', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'maintenance', id })} onSaveUnits={(units) => setTenantUnits(active.id, units)} onQuickAdd={(patch) => saveRecord('maintenance', null, patch)} />
      )}
      {view === 'vservice' && active && (
        <VserviceSection p={active} rows={recordsFor('vservice')} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'vservice' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'vservice', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'vservice', id })} onQuickAdd={(patch) => saveRecord('vservice', null, patch)} />
      )}

      {view === 'timeline' && active && (
        <>
          <TimelineTracker rows={active.timeline} />
          <SimpleRecordTable
            title="Development Timeline"
            subtitle={active.name}
            rows={active.timeline}
            cols={TIMELINE_FIELDS}
            query={filters.timeline || ''}
            highlightItem={highlight?.section === 'Timeline' ? highlight.item : ''}
            onAdd={() => setModal({ type: 'plist', field: 'timeline', index: null, fields: TIMELINE_FIELDS.filter(([k]) => k !== 'status') })}
            onEdit={(i) => setModal({ type: 'plist', field: 'timeline', index: i, fields: TIMELINE_FIELDS.filter(([k]) => k !== 'status') })}
            onStatusClick={(i, current) => setModal({ type: 'tstatus', index: i, current })}
          />
        </>
      )}
      {view === 'permit' && active && (
        <SimpleRecordTable
          title="Permit Matrix"
          subtitle={active.name}
          rows={active.permits}
          cols={permitColumns(active.permits)}
          query={filters.permit || ''}
          highlightItem={highlight?.section === 'Permit' ? highlight.item : ''}
          onAdd={() => setModal({ type: 'plist', field: 'permits', index: null, fields: permitColumns(active.permits) })}
          onEdit={(i) => setModal({ type: 'plist', field: 'permits', index: i, fields: permitColumns(active.permits) })}
          onDelete={(i) => deletePropertyListRow('permits', i, permitColumns(active.permits))}
        />
      )}

      {view === 'manage' && !active && (
        <ManagePage
          props={visibleProperties}
          logs={store.logs || []}
          deletedProps={deletedProperties}
          onBack={() => (editGuard.dirty ? setLeaveAsk(true) : (setActiveId(null), setView('portfolio')))}
          onAdd={() => setModal({ type: 'property', id: null })}
          onDelete={(id) => deleteAsset(id, true)}
          onRecover={recoverAsset}
          onPurge={purgeAsset}
          onOpenProperty={openAsset}
          onGoTo={goToLogEntry}
          onUndo={undoLogEntry}
          canUndo={canUndo}
          onClearFlag={toggleFlag}
          onPushFix={pushFieldFix}
        />
      )}

      {modal?.type === 'row' && (
        <RecordModal
          coll={modal.coll}
          row={modal.id ? store[modal.coll].find((r) => r.id === modal.id) : null}
          canDelete={modal.coll === 'warranties' ? canManage : true}
          requireReason={modal.coll === 'warranties'}
          onSave={(patch) => saveRecord(modal.coll, modal.id, patch)}
          onDelete={(reason) => deleteRecord(modal.coll, modal.id, reason)}
          onClose={() => setModal(null)}
          active={active}
        />
      )}
      {modal?.type === 'property' && (
        <AddAssetModal row={modal.id ? findAsset(modal.id) : null} properties={visibleProperties} onSave={(patch, reason, linkOptions) => saveAsset(modal.id, patch, reason, linkOptions)} onDelete={() => deleteAsset(modal.id)} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'plist' && (
        <SimpleRowModal
          title={modal.field === 'timeline' ? 'Timeline row' : 'Permit row'}
          fields={modal.fields}
          row={modal.index != null && active ? active[modal.field][modal.index] : null}
          onSave={(patch) => savePropertyListRow(modal.field, modal.index, patch, modal.fields)}
          onDelete={modal.index == null ? null : () => deletePropertyListRow(modal.field, modal.index, modal.fields)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'tstatus' && (
        <TimelineStatusModal current={modal.current} onSave={(status, date, reason) => savePropertyListRow('timeline', modal.index, { status, statusDate: date }, TIMELINE_FIELDS, reason)} onClose={() => setModal(null)} />
      )}

      <ScrollTopFab />
    </div>
  );
}

function CountBadge({ n }) {
  return (
    <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, fontSize: '0.64rem', fontWeight: 700, color: '#fff', backgroundColor: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {n}
    </span>
  );
}
