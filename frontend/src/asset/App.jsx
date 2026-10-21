import { useState, useEffect, useCallback, useRef } from 'react';
import { LoadingState } from '../components/AsyncState';
import { ArrowLeft, Pencil, Search, Lock, Unlock, Copy, MoreHorizontal, FileText, Download, Plus, History, Trash2, Upload } from 'lucide-react';

import { PT } from './lib/propertyFields.js';
import { ASSET_SCHEMAS, inferAssetKind } from './lib/vehicleFields.js';
import { RECORD_TYPES } from './lib/recordTypes.jsx';
import { normLabel, genId, toNumber, snapMap } from './lib/format.js';
import { editGuard } from './lib/editGuard.js';
import { makeLogEntry, appendLog, diffChanges, recordDisplayName } from './lib/logging.js';
import { SHARED_FILTER_GROUPS, LOG_SECTION_TO_TAB, UNDOABLE_FIELD_KEYS, recordViewsFor, stripTabsFor, recordLabel, assetSub, parseAssetSub, PORTFOLIO_SUB } from './lib/navigation.js';
import { TIMELINE_FIELDS, permitColumns } from './lib/timelineFields.js';
import { useNexusStore } from './lib/useNexusStore.js';
import { portfolioStats, assetCompleteness } from './lib/assetMetrics.js';
import { typeLabel } from './lib/portfolioCards.js';
import AnchoredMenu from '../components/AnchoredMenu';
import { StatusLabel } from '../components/StatusLabel.jsx';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';

import { ToastHost, pushToast } from './components/shared/ToastHost.jsx';
import { SyncStatus } from './components/shared/SyncStatus.jsx';
import { CollectionTable } from './components/shared/CollectionTable.jsx';
import { RecordModal } from './components/shared/RecordModal.jsx';

import { Portfolio } from './components/portfolio/Portfolio.jsx';
import { AssetOverview } from './components/asset/AssetOverview.jsx';
import { CriticalDates } from './components/asset/CriticalDates.jsx';
import { AssetDetailForm } from './components/asset/AssetDetailForm.jsx';
import { ParcelManager } from './components/asset/ParcelManager.jsx';
import { AssemblageParcels } from './components/asset/AssemblageParcels.jsx';
import { AddAssetModal } from './components/asset/AddAssetModal.jsx';
import { TimelineTracker } from './components/asset/TimelineTracker.jsx';
import { SimpleRecordTable } from './components/shared/SimpleRecordTable.jsx';
import { SimpleRowModal } from './components/shared/SimpleRowModal.jsx';
import { TimelineStatusModal } from './components/asset/TimelineStatusModal.jsx';

import { VserviceSection } from './components/maintenance/VserviceSection.jsx';
import { PropertyMaintenanceSection } from './components/maintenance/PropertyMaintenanceSection.jsx';

import { ReviewFlagsPanel } from './components/manage/ReviewFlagsPanel.jsx';
import { ActivityLog } from './components/manage/ActivityLog.jsx';
import { DataGapsPanel, TrashPanel } from './components/portfolio/PortfolioPanels.jsx';
import { MenuRow } from './components/shared/MenuRow.jsx';

import { exportAssetCsvAsFile, exportAssetPdf } from './lib/csvExport.js';
import { ticketMaintenanceRows } from './lib/propertyTickets.js';
import { useSession } from './lib/session.js';
import { api } from '../api.js';
import { AddItemModal } from '../views/InventoryManagement.jsx';
// Oct 7 accounting feedback: a property's loans from the ledger (self-contained; see the file's header).
import PropertyLoans from '../components/PropertyLoans.jsx';

const cityRegion = (p) => (p.city || '') + (p.state ? ', ' + p.state : '');

export default function App({ activeSub = null, onSubChange = null } = {}) {
  const session = useSession();
  const canManage = session?.can ? session.can('manager') : false;

  // `store` is the whole app's data: { properties, warranties, inspections, documents, ahj,
  // utilities, vendors, logs, vservice, odometer, vdocs, maintenance, _ts }. useNexusStore
  // owns hydration (localStorage -> IndexedDB -> server reconcile) and background sync - see
  // lib/useNexusStore.js and lib/sync.js. This component only ever reads `store` and calls
  // `setStore(updater)`; it never touches localStorage/IndexedDB/the network directly.
  const [store, setStore, loading, serverOk] = useNexusStore();

  const [view, setView] = useState('portfolio');       // 'portfolio' | a strip tab or record collection key (lib/navigation.js)
  const [activeId, setActiveId] = useState(null);        // currently open asset's id, or null
  const [leaveAsk, setLeaveAsk] = useState(false);        // "unsaved changes" confirm dialog
  const [pendingNav, setPendingNav] = useState(null);     // navigation to run after that dialog resolves
  const [filters, setFilters] = useState({});             // per-tab search text, keyed by tab (or shared group)
  const [modal, setModal] = useState(null);                // the currently-open record/asset/timeline modal, if any
  const [equipmentItemModal, setEquipmentItemModal] = useState(null); // staged Heavy Equipment asset awaiting its paired Item Management entry
  const [lastManageVisit, setLastManageVisit] = useState(() => { try { return localStorage.getItem('nexus_manage_seen') || ''; } catch { return ''; } });
  const [highlight, setHighlight] = useState(null);
  // Ticket bells and emails deep-link here (Property Tickets, Oct 2026): sub
  // "tickets|needs-action|services:<propertyId>[:<ticketId>]" opens that
  // property's Maintenance on that tab (and the ticket). Consumed once (onSubChange(null)), so the
  // next visit to Asset Management starts at the portfolio as usual.
  const [ticketFocus, setTicketFocus] = useState(null);
  const [subSeen, setSubSeen] = useState(null);
  const [subMissing, setSubMissing] = useState(false);
  const ticketSub = /^(tickets|needs-action|services):([^:]+)(?::(.+))?$/.exec(activeSub || '');
  if (ticketSub && !loading && activeSub !== subSeen) {
    setSubSeen(activeSub);
    if (store.properties.some((p) => p.id === ticketSub[2] && !p.deleted)) {
      setSubMissing(false);
      setActiveId(ticketSub[2]);
      setView('maintenance');
      setTicketFocus((f) => ({ propertyId: ticketSub[2], ticketId: ticketSub[3] || null, tab: ticketSub[1], at: (f?.at || 0) + 1 }));
    } else {
      setSubMissing(true);
    }
  }
  useEffect(() => {
    if (!subSeen || activeSub !== subSeen || !subMissing) return;
    pushToast?.('That property is no longer in Asset Management.', 'mut');
    onSubChange?.(null);
  }, [subSeen, activeSub, subMissing, onSubChange]);
  // Every open asset is a URL (Oct 2026): "a:<id>:<view>" under /property-asset, so a
  // tab can be bookmarked, shared, reloaded and walked with the browser's Back. State
  // writes the segment; a segment arriving from outside (a pasted link, Back) sets the
  // state - each side skips when the other already matches, so they never ping-pong.
  // The shell's default segment for this module is PORTFOLIO_SUB, so the portfolio
  // keeps the address it always had.
  const wantSub = assetSub(activeId, view === 'portfolio' ? 'property' : view) || PORTFOLIO_SUB;
  useEffect(() => {
    if (loading || ticketSub) return;
    if ((activeSub || PORTFOLIO_SUB) !== wantSub) onSubChange?.(wantSub);
  }, [wantSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loading || ticketSub) return;
    const target = parseAssetSub(activeSub);
    if (target) {
      if (target.id === activeId && target.view === view) return;
      if (!store.properties.some((p) => p.id === target.id && !p.deleted)) {
        pushToast?.('That asset is no longer in Asset Management.', 'mut');
        onSubChange?.(PORTFOLIO_SUB);
        return;
      }
      const go = () => { setActiveId(target.id); setView(target.view); };
      if (editGuard.dirty) { onSubChange?.(wantSub); setPendingNav(() => go); setLeaveAsk(true); } else go();
    } else if (activeId && (!activeSub || activeSub === PORTFOLIO_SUB)) {
      const go = () => { setActiveId(null); setView('portfolio'); };
      if (editGuard.dirty) { onSubChange?.(wantSub); setPendingNav(() => go); setLeaveAsk(true); } else go();
    }
  }, [activeSub, loading]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [typeFilter, setTypeFilter] = useState('');
  const moreRef = useRef(null);                                // the header's "more actions" button
  const [moreOpen, setMoreOpen] = useState(false);
  // The portfolio's own more menu and the panel open under its Needs Attention band
  // (Data Gaps / Flagged / Activity Log / Trash - the old Manage page, in place).
  const portfolioMoreRef = useRef(null);
  const [portfolioMoreOpen, setPortfolioMoreOpen] = useState(false);
  const [panel, setPanel] = useState(null);
  const [lastRecord, setLastRecord] = useState(null);         // the Records segment last open, per session
  // Per-asset numbers for the tiles (occupancy, % complete) - one read, refreshed with the store.
  const [metrics, setMetrics] = useState({});
  useEffect(() => { let alive = true; api.getAssetMetrics().then((m) => { if (alive && m) setMetrics(m); }).catch(() => {}); return () => { alive = false; }; }, [store._ts]);
  // The spec sheet's edit state, for the header's Cancel / Save Changes.
  const [editState, setEditState] = useState({ editing: false, dirty: false });
  useEffect(() => editGuard.subscribe(() => setEditState((s) => (s.editing === editGuard.editing && s.dirty === editGuard.dirty) ? s : { editing: editGuard.editing, dirty: editGuard.dirty })), []);

  const unseenLogCount = (store.logs || []).filter((l) => l.ts > lastManageVisit).length;
  const markManageSeen = () => {
    const now = new Date().toISOString();
    setLastManageVisit(now);
    try { localStorage.setItem('nexus_manage_seen', now); } catch { /* ignore */ }
  };
  // Opening the Activity Log, or any new log arriving while it is open, marks everything read.
  useEffect(() => { if (panel === 'activity') markManageSeen(); }, [panel, store.logs]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (recordViews.includes(view)) setLastRecord(view); }, [view]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(t);
  }, [highlight]);

  // The sync engine (asset/lib/sync.js) can't reach React, so it fires this event
  // when a save is refused. A hard 4xx (dropped, won't retry) shows a persistent
  // error so the edit isn't lost silently; a soft/transient one shows a lighter
  // "still trying" note. Previously these failures were swallowed entirely.
  useEffect(() => {
    const onSaveFailed = (e) => {
      const d = (e && e.detail) || {};
      if (d.soft) {
        pushToast("Changes aren't syncing yet - retrying. Keep this tab open.", 'mut');
      } else {
        const why = d.status === 403 ? "you don't have edit access to Asset Management"
          : d.status === 400 ? (d.message || 'the server refused the change')
          : d.status === 422 ? 'the server rejected the data shape'
          : `save failed (error ${d.status || 'network'})`;
        pushToast(`Could not save - ${why}. Your last change was not stored.`, 'bad');
      }
    };
    // A row someone else saved since this tab read it: the server kept theirs,
    // the workspace was re-pulled; say so rather than overwrite in silence.
    const onConflict = (e) => {
      const n = (e?.detail?.ids || []).length || 1;
      pushToast?.(`${n === 1 ? 'One record was' : n + ' records were'} changed by someone else - reloaded with their version.`, 'mut');
    };
    window.addEventListener('nexus:asset-save-failed', onSaveFailed);
    window.addEventListener('nexus:asset-save-conflict', onConflict);
    return () => { window.removeEventListener('nexus:asset-save-failed', onSaveFailed); window.removeEventListener('nexus:asset-save-conflict', onConflict); };
  }, []);

  // Officers/execs/admins (role check) can see private-flagged assets; everyone else can't.
  const canSeePrivate = session && (session.level >= 5 || /owner|officer|exec|admin/i.test(session.role || ''));
  const visibleProperties = store.properties.filter((p) => !p.deleted && (!p.private || canSeePrivate));
  const deletedProperties = store.properties.filter((p) => p.deleted && (!p.private || canSeePrivate));
  const findAsset = (id) => visibleProperties.find((p) => p.id === id);
  const active = activeId ? findAsset(activeId) : null;
  const recordsFor = (coll) => (store[coll] || []).filter((r) => r.propertyId === activeId);

  const openAsset = (id, tab = 'property') => { setActiveId(id); setView(tab); };
  // Export CSV is "everything tied to an asset" - that includes its closed
  // tickets summarized as maintenance records, which live in Tickets, not in
  // the store. Fetched at export time; if that fails the file says so
  // instead of silently leaving them out.
  const exportCsvWithTickets = async (asset) => {
    let ticketMaintenance = null;
    try { ticketMaintenance = ticketMaintenanceRows(await api.getPropertyTickets(asset.id), asset); }
    catch { /* exported with a "Not included" row */ }
    exportAssetCsvAsFile(asset, store, { ticketMaintenance });
  };

  /** All navigation goes through this - it's what enforces the unsaved-changes guard. */
  const navigate = (nextView) => {
    const go = () => {
      if (nextView === 'manage') { setActiveId(null); setView('portfolio'); setPanel('activity'); return; }
      setView(nextView);
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
      return appendLog({ ...s, properties: props }, makeLogEntry({ section: 'Property', property: asset.name, propertyId: activeId, action: 'edited', item: `Contact - ${label}`, changes: [] }));
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

  // The property's ledger entity (Oct 7) - what PropertyLoans reads the loans of.
  const setEntityCode = (id, code) => {
    setStore((s) => {
      const idx = s.properties.findIndex((p) => p.id === id);
      if (idx < 0) return s;
      const before = s.properties[idx];
      const next = { ...before, entityCode: code || '' };
      return appendLog(
        { ...s, properties: s.properties.map((p, i) => i === idx ? next : p) },
        makeLogEntry({ section: 'Property', property: next.name, propertyId: id, action: 'edited', item: next.name, changes: [{ field: 'Ledger Entity', from: before.entityCode || '', to: code || '' }] })
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

  /** Add/edit an ASSET itself (the guided Add-Asset modal's onSave - property/vehicle/equipment). */
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
        setTimeout(() => openAsset(row.id, 'property'), 0);
        action = 'added';
        displayName = row.name;
      }

      if (linkOptions) {
        const anchorOf = (pid) => { const p = props.find((x) => x.id === pid); return p ? (p.parentId || p.id) : ''; };
        if (linkOptions.role === 'none') {
          props = props.map((p) => (p.id === assetId && p.parentId) ? { ...p, parentId: '', siteName: '' } : p);
        } else if (linkOptions.role === 'secondary' && linkOptions.targetId) {
          const anchorId = anchorOf(linkOptions.targetId);
          // Linking under one's own parcel would make the asset its own anchor and
          // drop the whole group off the portfolio (tiles show parentId-less assets).
          if (anchorId && anchorId !== assetId) {
            const anchor = props.find((p) => p.id === anchorId);
            const siteName = (anchor?.siteName || anchor?.name || '').trim();
            props = props.map((p) => p.id === assetId ? { ...p, parentId: anchorId, siteName } : (p.id === anchorId && !p.siteName) ? { ...p, siteName } : p);
          }
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

  /** Delete Forever: the asset and everything under it, here as on the server. */
  const purgeAsset = (id) => setStore((s) => {
    const next = { ...s, properties: s.properties.filter((p) => p.id !== id), logs: (s.logs || []).filter((l) => l.propertyId !== id) };
    for (const coll of ['warranties', 'inspections', 'documents', 'ahj', 'utilities', 'vendors', 'vservice', 'odometer', 'vdocs', 'maintenance']) {
      next[coll] = (s[coll] || []).filter((r) => r.propertyId !== id);
    }
    return next;
  });

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
        logEntry = { section: 'Property', property: asset.name, propertyId: asset.id, action: 'removed', item: asset.name, changes: [], reason: 'Undo - reversed an "Added"' };
      } else if (entry.action === 'removed' && asset.deleted) {
        props[idx] = { ...asset, deleted: false, deletedAt: '' };
        logEntry = { section: 'Property', property: asset.name, propertyId: asset.id, action: 'edited', item: asset.name, changes: [{ field: 'Status', from: 'Deleted', to: 'Recovered' }], reason: 'Undo - reversed a "Removed"' };
      } else if (entry.action === 'edited') {
        const revert = {};
        const reverseChanges = [];
        (entry.changes || []).forEach((c) => {
          const key = UNDOABLE_FIELD_KEYS[c.field];
          if (key != null) { revert[key] = c.from; reverseChanges.push({ field: c.field, from: c.to, to: c.from }); }
        });
        if (!reverseChanges.length) return s;
        props[idx] = { ...asset, ...revert };
        logEntry = { section: 'Property', property: props[idx].name, propertyId: asset.id, action: 'edited', item: props[idx].name, changes: reverseChanges, reason: 'Undo - restored previous value(s)' };
      } else return s;

      const logs = (s.logs || []).map((l) => l.id === entry.id ? { ...l, undone: true } : l);
      return appendLog({ ...s, properties: props, logs }, makeLogEntry(logEntry));
    });
    if (activeId === entry.propertyId && entry.action === 'added') { setActiveId(null); setView('portfolio'); }
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

  const pulse = !active ? portfolioStats(store) : null;
  const needData = !active ? visibleProperties.filter((p) => assetCompleteness(p).pct < 100).length : 0;
  const flagCount = !active ? visibleProperties.reduce((n, p) => n + ((p.reviewFlags || []).length), 0) : 0;
  const assetKind = active ? inferAssetKind(active) : null;
  const recordViews = active ? recordViewsFor(assetKind) : [];
  const stripTabs = active ? stripTabsFor(assetKind) : [];
  const onRecords = recordViews.includes(view);
  const tabCount = (key) => !active ? 0
    : key === 'records' ? recordViews.reduce((n, k) => n + tabCount(k), 0)
    : key === 'timeline' ? (active.timeline || []).length
    : key === 'permit' ? (active.permits || []).length
    : key === 'property' ? 0 : recordsFor(key).length;
  // Records opens on the segment last used, else the first collection with rows;
  // clicking it while already there is a no-op.
  const openRecords = () => {
    if (onRecords) return;
    navigate(recordViews.includes(lastRecord) ? lastRecord : (recordViews.find((k) => tabCount(k) > 0) || recordViews[0]));
  };
  const backToPortfolio = () => (editGuard.dirty ? setLeaveAsk(true) : (setActiveId(null), setView('portfolio')));
  const filterKeysForTab = SHARED_FILTER_GROUPS[view] || [view];
  const showTabSearch = view !== 'property' && (filterKeysForTab.length > 0 || ['timeline', 'permit'].includes(view));
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

      {!active && pulse && (
        <div className="view-header" style={{ alignItems: 'center', marginBottom: 16 }}>
          <div className="view-title-group" style={{ minWidth: 0 }}>
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>Asset Management</h2>
            <p>{loading && !visibleProperties.length ? 'Loading the portfolio…' : `${pulse.assets} ${pulse.assets === 1 ? 'asset' : 'assets'} in the portfolio`}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="primary-btn" onClick={() => setModal({ type: 'property', id: null })}>
              <Plus size={14} /> Add Asset
            </button>
            <button ref={portfolioMoreRef} type="button" className="secondary-btn" aria-label="More" aria-haspopup="menu" aria-expanded={portfolioMoreOpen} onClick={() => setPortfolioMoreOpen((o) => !o)} style={{ padding: 8, position: 'relative' }}>
              <MoreHorizontal size={16} />
              {unseenLogCount > 0 && <CountBadge n={unseenLogCount} />}
            </button>
            <AnchoredMenu anchorRef={portfolioMoreRef} open={portfolioMoreOpen} onClose={() => setPortfolioMoreOpen(false)} align="end" minWidth={220}
              style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
              <MenuRow icon={History} onClick={() => { setPortfolioMoreOpen(false); setPanel('activity'); }}>Activity Log{unseenLogCount > 0 ? ` (${unseenLogCount} new)` : ''}</MenuRow>
              <MenuRow icon={Trash2} onClick={() => { setPortfolioMoreOpen(false); setPanel('trash'); }}>Trash{deletedProperties.length ? ` (${deletedProperties.length})` : ''}</MenuRow>
              <MenuRow icon={Upload} onClick={() => { setPortfolioMoreOpen(false); setModal({ type: 'property', id: null, mode: 'import' }); }}>Import From a Spreadsheet</MenuRow>
            </AnchoredMenu>
          </div>
        </div>
      )}

      {/* One title band, the shape every Nexus module has (Shifts, Support):
          back, photo, name + place, the health signals as soft labels; the
          actions on the right, the rare ones (Private, Duplicate, Export)
          behind one "more" button. The old hero + breadcrumb bar + pill strip
          put ~300px of chrome before any content (760px on a phone). */}
      {active && (
        <div className="view-header" style={{ alignItems: 'center', marginBottom: 12 }}>
          {/* flex-basis 320px: narrower than that (a phone) the action row wraps under
              the title instead of squeezing the name to one letter a line. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 320px' }}>
            <button type="button" className="secondary-btn" onClick={backToPortfolio} title="Back to Portfolio" aria-label="Back to Portfolio" style={{ padding: 8, flexShrink: 0 }}>
              <ArrowLeft size={16} />
            </button>
            {(active.images?.[0] || active.image) && (
              <img
                src={active.images?.[0] || active.image}
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                style={{ width: 64, height: 48, objectFit: 'cover', objectPosition: 'center 30%', borderRadius: 8, border: '1px solid var(--border-color)', flexShrink: 0 }}
              />
            )}
            <div className="view-title-group" style={{ minWidth: 0 }}>
              <h2 style={{ fontFamily: 'var(--wk-font)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{active.name}</span>
                {active.private && <StatusLabel label="Private" color="hsl(var(--color-red))" size="sm" title="Hidden from everyone but officers" />}
              </h2>
              <p>{[cityRegion(active), assetKind === 'property' ? typeLabel(active) : ''].filter(Boolean).join(' · ') || '-'}</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            {view === 'property' && !editState.editing && (
              <button className="primary-btn" onClick={() => editGuard.startEdit?.()}>
                <Pencil size={14} /> Edit
              </button>
            )}
            {view === 'property' && editState.editing && (
              <>
                <button className="secondary-btn" onClick={() => editGuard.cancel?.()}>Cancel</button>
                <button className="primary-btn" onClick={() => editGuard.save?.()} disabled={!editState.dirty} title={editState.dirty ? undefined : 'No changes yet'}>Save Changes</button>
              </>
            )}
            <button ref={moreRef} type="button" className="secondary-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} style={{ padding: 8 }}>
              <MoreHorizontal size={16} />
            </button>
            <AnchoredMenu anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} align="end" minWidth={220}
              style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
              <MenuRow icon={active.private ? Unlock : Lock} onClick={() => { setMoreOpen(false); togglePrivate(active.id); }}>
                {active.private ? 'Make Public' : 'Mark Private'}
              </MenuRow>
              <MenuRow icon={Copy} onClick={() => { setMoreOpen(false); duplicateAsset(false); }}>Duplicate</MenuRow>
              <MenuRow icon={FileText} onClick={() => { setMoreOpen(false); exportAssetPdf(active, store); }}>Export as PDF</MenuRow>
              <MenuRow icon={Download} onClick={() => { setMoreOpen(false); exportCsvWithTickets(active); }}>Export as CSV</MenuRow>
            </AnchoredMenu>
          </div>
        </div>
      )}

      {active && <ParcelManager active={active} all={store.properties} onOpen={(id) => openAsset(id, 'property')} onLink={linkParcel} onUnlink={unlinkParcel} onTogglePrimary={togglePrimaryParcel} onMove={moveParcelOrder} onRenameGroup={renameGroup} onDuplicate={() => duplicateAsset(true)} onSetAssembled={setAssembled} />}

      {leaveAsk && (
        <UnsavedChangesPrompt
          onKeepEditing={() => { setLeaveAsk(false); setPendingNav(null); }}
          onDiscard={() => { editGuard.cancel?.(); setLeaveAsk(false); const go = pendingNav; setPendingNav(null); go ? go() : (setActiveId(null), setView('portfolio')); }}
          onSave={() => { editGuard.save?.(); setLeaveAsk(false); const go = pendingNav; setPendingNav(null); go ? go() : (setActiveId(null), setView('portfolio')); }}
        />
      )}

      {/* Underline tabs with a count each - the Shifts strip. Not sticky: Nexus
          took sticky tab strips out app-wide (style.css, Sep 5). */}
      {active && (
        <div className="gt-tabs" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, borderBottom: '1px solid var(--wk-line)', flexWrap: 'wrap' }}>
          <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, minWidth: 0 }}>
            {stripTabs.map(([key, label]) => {
              const on = key === 'records' ? onRecords : view === key;
              const n = tabCount(key);
              return (
                <button key={key} type="button" role="tab" aria-selected={on} onClick={() => (key === 'records' ? openRecords() : navigate(key))}
                  aria-label={n ? `${label}, ${n}` : undefined}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px', border: 'none', background: 'none',
                    cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 13.5, fontWeight: on ? 700 : 600,
                    color: on ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', marginBottom: -1,
                    borderBottom: on ? '2.5px solid var(--wk-brand)' : '2.5px solid transparent' }}>
                  {label}
                  {n > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, lineHeight: '16px', padding: '0 6px', borderRadius: 8, background: on ? 'var(--wk-brand-tint)' : 'var(--bg-secondary)', color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>{n}</span>
                  )}
                </button>
              );
            })}
          </div>
          {showTabSearch && (
            <div style={{ position: 'relative', width: 220, marginLeft: 'auto', padding: '4px 0' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input className="form-input" placeholder="Search…" value={searchValue} onChange={(e) => setSearchValue(e.target.value)} style={{ width: '100%', fontSize: '0.82rem', padding: '7px 10px 7px 32px' }} />
            </div>
          )}
        </div>
      )}

      {/* Records: one segment per collection, counts beside the names, the open
          one lifted on the track - the same control the Maintenance tab uses for
          its units. Scrolls sideways on a phone (.scroll-tabs). */}
      {active && onRecords && (
        <div className="scroll-tabs" role="tablist" aria-label="Record type" style={{ display: 'flex', gap: 2, padding: 3, marginBottom: 16, borderRadius: 10, background: 'var(--bg-secondary)', width: 'fit-content', maxWidth: '100%' }}>
          {recordViews.map((key) => {
            const on = view === key;
            const n = tabCount(key);
            return (
              <button key={key} type="button" role="tab" aria-selected={on} onClick={() => navigate(key)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                  fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                  background: on ? 'var(--bg-card)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-secondary)', boxShadow: on ? 'var(--shadow-sm)' : 'none' }}>
                {recordLabel(key)}
                <span style={{ fontSize: 11.5, fontWeight: 600, color: on ? 'var(--text-secondary)' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {view === 'portfolio' && !active && loading && !visibleProperties.length && (
        <LoadingState label="Loading assets…" minHeight={320} />
      )}
      {view === 'portfolio' && !active && !(loading && !visibleProperties.length) && (
        <CriticalDates store={store} openProperty={openAsset} hideIfEmpty title="Needs Attention"
          extraChips={[
            { count: needData, label: 'Need Data', color: 'orange', title: 'Assets with key fields to fill', expanded: panel === 'data', onClick: () => setPanel((p) => (p === 'data' ? null : 'data')) },
            { count: flagCount, label: 'Flagged', color: 'purple', title: 'Fields flagged for review', expanded: panel === 'flags', onClick: () => setPanel((p) => (p === 'flags' ? null : 'flags')) },
          ]} />
      )}
      {view === 'portfolio' && !active && panel === 'data' && (
        <DataGapsPanel assets={visibleProperties} onOpen={openAsset} onDelete={(id) => deleteAsset(id, true)} serverOk={serverOk} onClose={() => setPanel(null)} />
      )}
      {view === 'portfolio' && !active && panel === 'flags' && (
        <ReviewFlagsPanel props={visibleProperties} onClearFlag={toggleFlag} onOpen={openAsset} onPushFix={pushFieldFix} onClose={() => setPanel(null)} />
      )}
      {view === 'portfolio' && !active && panel === 'activity' && (
        <div style={{ marginBottom: 16 }}>
          <ActivityLog onClose={() => setPanel(null)} logs={store.logs || []} query="" onOpenProperty={openAsset} activeId={null} activeName="" onGoTo={goToLogEntry} onUndo={undoLogEntry} canUndo={canUndo} assetsForKind={visibleProperties} />
        </div>
      )}
      {view === 'portfolio' && !active && panel === 'trash' && (
        <TrashPanel deleted={deletedProperties} onRecover={recoverAsset} onPurge={purgeAsset} onClose={() => setPanel(null)} />
      )}
      {view === 'portfolio' && !active && !(loading && !visibleProperties.length) && <Portfolio props={visibleProperties} openProperty={openAsset} typeFilter={typeFilter} setTypeFilter={setTypeFilter} serverOk={serverOk} metrics={metrics} />}

      {view === 'property' && active?.assembled && !active.parentId && <AssemblageParcels lead={active} all={store.properties} onOpen={(id) => openAsset(id, 'property')} />}
      {view === 'property' && active && !editState.editing && (
        <AssetOverview asset={active} store={store} onTab={navigate} onGoTo={goToLogEntry}
          onEdit={(field) => { if (field) setHighlight({ tab: 'property', section: '', field: String(field).toLowerCase(), item: '', at: Date.now() }); editGuard.startEdit?.(); }} />
      )}
      {view === 'property' && active && (
        <AssetDetailForm p={active} onSaveImages={saveImages} onSaveDetail={saveDetail} onSaveContact={saveContact} highlight={highlight?.tab === 'property' ? highlight : null} onOpenLead={(id) => openAsset(id, 'property')} onFlag={toggleFlag} />
      )}
      {view === 'property' && active && inferAssetKind(active) === 'property' && (
        <PropertyLoans property={active} onSaveEntityCode={(code) => setEntityCode(active.id, code)} />
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
        <PropertyMaintenanceSection p={active} rows={recordsFor('maintenance')} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'maintenance' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'maintenance', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'maintenance', id })} onSaveUnits={(units) => setTenantUnits(active.id, units)} onQuickAdd={(patch) => saveRecord('maintenance', null, patch)} ticketFocus={ticketFocus} />
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
        <AddAssetModal
          draft={modal.draft}
          mode={modal.mode || 'add'}
          properties={visibleProperties}
          onSave={(patch, reason, linkOptions, meta) => {
            // New Heavy Equipment or Vehicle asset from the guided wizard (not CSV bulk-import,
            // which has no sensible per-row Item Management pairing): don't persist yet - stage
            // it and collect the paired Item Management entry first. Neither side saves unless
            // that second modal is completed (see equipmentItemModal below).
            if (!modal.id && (patch.kind === 'equipment' || patch.kind === 'vehicle') && meta?.guided) {
              setModal(null);
              setEquipmentItemModal({ patch, reason, linkOptions });
              return;
            }
            saveAsset(modal.id, patch, reason, linkOptions);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {equipmentItemModal && (
        <AddItemModal
          types={['Equipment', 'Vehicles']}
          initial={{
            name: equipmentItemModal.patch.name || '',
            itemType: equipmentItemModal.patch.kind === 'vehicle' ? 'Vehicles' : 'Equipment',
            make: equipmentItemModal.patch.make || '',
            model: equipmentItemModal.patch.model || '',
            year: equipmentItemModal.patch.yearBuilt || '',
            location: equipmentItemModal.patch.address || '',
          }}
          // These duplicate values already captured on the equipment/vehicle form - lock them
          // here so the item and asset records can't drift apart; fix typos back on the asset
          // side. Department/Location stay editable (Item Management's version can legitimately
          // differ, e.g. an item's storage location vs. the equipment's home base).
          lockedFields={['name', 'itemType', 'make', 'model', 'year']}
          onBack={() => {
            const staged = equipmentItemModal;
            setEquipmentItemModal(null);
            setModal({ type: 'property', id: null, draft: staged.patch });
          }}
          onSave={(itemData) => api.createItem(itemData).then((createdItem) => {
            const staged = equipmentItemModal;
            saveAsset(null, {
              ...staged.patch,
              snapshot: [
                ...(staged.patch.snapshot || []),
                { group: 'Item Management', fields: [
                  { label: 'Linked item serial', value: createdItem?.serial_number || '' },
                ] },
              ],
            }, staged.reason, staged.linkOptions);
          })}
          onClose={() => setEquipmentItemModal(null)}
        />
      )}
      {modal?.type === 'plist' && (
        <SimpleRowModal
          title={modal.field === 'timeline' ? 'Timeline Row' : 'Permit Row'}
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

    </div>
  );
}

function CountBadge({ n }) {
  return (
    <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700, color: '#fff', backgroundColor: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {n}
    </span>
  );
}

