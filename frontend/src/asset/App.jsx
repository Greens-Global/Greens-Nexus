import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { MoreHorizontal, Download, Trash2, Upload, Plus, Building2, Truck, Wrench } from 'lucide-react';

import { PT } from './lib/propertyFields.js';
import { ASSET_SCHEMAS, inferAssetKind } from './lib/vehicleFields.js';
import { RECORD_TYPES } from './lib/recordTypes.jsx';
import { normLabel, genId, toNumber, snapMap } from './lib/format.js';
import { editGuard } from './lib/editGuard.js';
import { makeLogEntry, appendLog, diffChanges, recordDisplayName } from './lib/logging.js';
import {
  LOG_SECTION_TO_TAB, UNDOABLE_FIELD_KEYS, recordViewsFor, stripTabsFor, recordLabel, recordHint, assetSub, parseAssetSub,
  PORTFOLIO_TABS, OVERVIEW_SUB, portfolioSub, parsePortfolioSub, portfolioTabLabel,
} from './lib/navigation.js';
import { TIMELINE_FIELDS, permitColumns } from './lib/timelineFields.js';
import { useNexusStore } from './lib/useNexusStore.js';
import { useAssetCompanies, companyName, companyIdOf } from './lib/companies.js';
import { egnyteFolderOf, normalizeEgnyteFolder } from './lib/egnyteFolder.js';
import { DEFAULT_VIEW, decodeView, encodeView, presetView, normalizeFilters } from './lib/portfolioQuery.js';
import { exportPortfolioCsv } from './lib/portfolioCsv.js';
import { useTabSignals } from './lib/tabSignals.js';
import { patchAssetRow } from './lib/assetPatch.js';
import AnchoredMenu from '../components/AnchoredMenu';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
import { useIsMobile } from '../lib/useIsMobile';
import { useTableValue } from '../tasks/tableCols.jsx';

import { ToastHost, pushToast } from './components/shared/ToastHost.jsx';
import { SyncStatus } from './components/shared/SyncStatus.jsx';
import { CollectionTable } from './components/shared/CollectionTable.jsx';
import { RecordModal } from './components/shared/RecordModal.jsx';

import { Portfolio } from './components/portfolio/Portfolio.jsx';
import { AssetOverviewPage } from './components/asset/AssetOverviewPage.jsx';
import { AssetTitleBand } from './components/asset/AssetTitleBand.jsx';
import { ParcelManager } from './components/asset/ParcelManager.jsx';
import { AddAssetModal } from './components/asset/AddAssetModal.jsx';
import { TimelineTracker } from './components/asset/TimelineTracker.jsx';
import { SimpleRecordTable } from './components/shared/SimpleRecordTable.jsx';
import { AssetEgnyteDocs, ConnectEgnyteEmpty } from './components/asset/AssetEgnyteDocs.jsx';
import { SimpleRowModal } from './components/shared/SimpleRowModal.jsx';
import { TimelineStatusModal } from './components/asset/TimelineStatusModal.jsx';

import { VserviceSection } from './components/maintenance/VserviceSection.jsx';
import { PropertyMaintenanceSection } from './components/maintenance/PropertyMaintenanceSection.jsx';
import { PropertyTicketComposer } from './components/maintenance/ticketMounts';

import { ReviewFlagsPanel } from './components/manage/ReviewFlagsPanel.jsx';
import { DataGapsPanel, TrashPanel } from './components/portfolio/PortfolioPanels.jsx';
import { MENU_PANEL, MenuItem, menuKeys, useMenu } from './components/portfolio/menuParts.jsx';

import { OverviewTab } from './components/tabs/OverviewTab.jsx';
import { FleetTab } from './components/tabs/FleetTab.jsx';
import { DevelopmentTab } from './components/tabs/DevelopmentTab.jsx';
import { MaintenanceTab } from './components/tabs/MaintenanceTab.jsx';
import { DatesTab } from './components/tabs/DatesTab.jsx';
import { ActivityTab } from './components/tabs/ActivityTab.jsx';

import { exportAssetCsvAsFile, exportAssetPdf } from './lib/csvExport.js';
import { ticketMaintenanceRows } from './lib/propertyTickets.js';
import { useSession } from './lib/session.js';
import { api } from '../api.js';
import { AddItemModal } from '../views/InventoryManagement.jsx';
import { useTrailCrumbs } from '../components/PageTrail';
import ModuleTabs, { ModuleActions } from '../components/ModuleTabs';
import NewButton from '../components/NewButton';

// "+ New" on every portfolio tab (Neil, 11/13/2026: "+ New" is the one create button).
const NEW_ITEMS = [
  { key: 'property', label: 'Property', hint: 'A site, a building or land', Icon: Building2 },
  { key: 'vehicle', label: 'Vehicle', hint: 'A car, a truck, a van', Icon: Truck },
  { key: 'equipment', label: 'Heavy Equipment', hint: 'A loader, a lift, a generator', Icon: Wrench },
  { key: 'import', label: 'Import From a Spreadsheet...', hint: 'Many at once, from a CSV', Icon: Upload, sep: true },
];
const ADD_NOUN = { warranties: 'Warranty', inspections: 'Inspection', documents: 'Plan or Document', utilities: 'Utility', ahj: 'Authority', vendors: 'Vendor', permit: 'Permit', vservice: 'Service Record', odometer: 'Odometer Reading', vdocs: 'Document' };
const NOOP = () => {};
const freshView = () => ({ ...DEFAULT_VIEW, filters: normalizeFilters({}), mode: '' });

export default function App({ activeSub = null, onSubChange = null } = {}) {
  const session = useSession();
  const canManage = session?.can ? session.can('manager') : false;
  // The Egnyte folder (Neil, 11/05/2026): editors connect it once; only an
  // Asset Management Owner (or a Super Administrator) changes it - the server
  // enforces both (routers/property_assets.may_repin_egnyte).
  const canEditAssets = session.level >= 4 || ['editor', 'full', 'owner'].includes(session.moduleLevel);
  const mayRepinEgnyte = session.level >= 5 || session.moduleLevel === 'owner';
  const me = useMemo(() => ({ name: session.name || '', email: session.email || '' }), [session.name, session.email]);
  const phone = useIsMobile();

  // `store` is the whole app's data: { properties, warranties, inspections, documents, ahj,
  // utilities, vendors, logs, vservice, odometer, vdocs, maintenance, _ts }. useNexusStore
  // owns hydration (localStorage -> IndexedDB -> server reconcile) and background sync - see
  // lib/useNexusStore.js and lib/sync.js. This component only ever reads `store` and calls
  // `setStore(updater)`; it never touches localStorage/IndexedDB/the network directly.
  const [store, setStore, loading, serverOk] = useNexusStore();

  const [view, setView] = useState('portfolio');       // 'portfolio' | a strip tab or record collection key (lib/navigation.js)
  const [activeId, setActiveId] = useState(null);        // currently open asset's id, or null
  // The portfolio's top menu (Neil, 11/17/2026): which tab is open when no asset is, and the
  // Properties register's view (filters, grouping, sort, mode, columns). Both ride the
  // address (lib/navigation.js portfolioSub) so Back and a pasted link reproduce them.
  const [portTab, setPortTab] = useState(() => parsePortfolioSub(activeSub)?.tab || 'overview');
  const [pview, setPview] = useState(() => { const p = parsePortfolioSub(activeSub); return p?.view ? { ...freshView(), ...decodeView(p.view) } : freshView(); });
  // The view string last written to the address: changes settle for a moment before they
  // become a history entry, so a run of filter clicks is one Back, not ten.
  const [committed, setCommitted] = useState(() => parsePortfolioSub(activeSub)?.view || '');
  const [storedMode, setStoredMode] = useTableValue('asset-portfolio', 'mode', 'list');
  const [savedViews, setSavedViews] = useTableValue('asset-portfolio', 'views', []);
  const mode = pview.mode || storedMode || 'list';
  // Where an open asset came from: the tab, the words Back says, the list prev / next walks.
  const [origin, setOrigin] = useState(null);
  const propertyList = useRef({ ids: [], label: 'Properties' });
  // The asset last opened (fleet cards, Neil 11/02/2026): Back to the portfolio outlines its
  // card in the live accent, so you land where you were.
  const [lastOpenedId, setLastOpenedId] = useState(null);
  if (activeId && activeId !== lastOpenedId) setLastOpenedId(activeId);
  const [leaveAsk, setLeaveAsk] = useState(false);        // "unsaved changes" confirm dialog
  const [pendingNav, setPendingNav] = useState(null);     // navigation to run after that dialog resolves
  const [filters, setFilters] = useState({});             // per-tab search text, keyed by tab (or shared group)
  const [modal, setModal] = useState(null);                // the currently-open record/asset/timeline modal, if any
  const [equipmentItemModal, setEquipmentItemModal] = useState(null); // staged Heavy Equipment asset awaiting its paired Item Management entry
  const [lastManageVisit, setLastManageVisit] = useState(() => { try { return localStorage.getItem('nexus_manage_seen') || ''; } catch { return ''; } });
  const [highlight, setHighlight] = useState(null);
  const [reportFor, setReportFor] = useState(null);          // Report a Problem on a phone
  const [openTickets, setOpenTickets] = useState(null);      // ids of properties with open tickets, once asked for
  // Ticket bells and emails deep-link here (Property Tickets, Oct 2026): sub
  // "tickets|needs-action|services:<propertyId>[:<ticketId>]" opens that
  // property's Maintenance on that tab (and the ticket). Consumed once, then the
  // address becomes the asset's own.
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

  // The register's view settles, then becomes the address.
  const viewStr = encodeView(pview);
  useEffect(() => {
    if (viewStr === committed) return undefined;
    const t = setTimeout(() => setCommitted(viewStr), 700);
    return () => clearTimeout(t);
  }, [viewStr, committed]);

  // Every open asset is a URL (Oct 2026): "a:<id>:<view>" under /property-asset, so a
  // tab can be bookmarked, shared, reloaded and walked with the browser's Back. The
  // portfolio's tabs are "asset-overview", "asset-portfolio[~view]", "asset-fleet"...
  // State writes the segment; a segment arriving from outside (a pasted link, Back)
  // sets the state - each side skips when the other already matches.
  const wantSub = assetSub(activeId, view === 'portfolio' ? 'property' : view) || portfolioSub(portTab, committed);
  useEffect(() => {
    if (loading) return;
    // A ticket link is consumed by the render block above (it sets subSeen); its
    // state change lands here, where the address is rewritten to the asset's own
    // URL and subSeen is cleared so the same bell link works again later.
    if (ticketSub && activeSub !== subSeen) return;
    if ((activeSub || OVERVIEW_SUB) !== wantSub) { onSubChange?.(wantSub); if (ticketSub) setSubSeen(null); }
  }, [wantSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loading || ticketSub) return;
    const target = parseAssetSub(activeSub);
    if (target) {
      if (target.id === activeId && target.view === view) return;
      if (!store.properties.some((p) => p.id === target.id && !p.deleted)) {
        if (!store.properties.length) return;   // nothing loaded at all: not a verdict on the link
        pushToast?.('That asset is no longer in Asset Management.', 'mut');
        onSubChange?.(portfolioSub(portTab, committed));
        return;
      }
      const go = () => { setActiveId(target.id); setView(target.view); if (target.item) setHighlight({ tab: target.view, section: target.view === 'permit' ? 'Permit' : '', field: '', item: target.item, at: Date.now() }); };
      if (editGuard.dirty) { onSubChange?.(wantSub); setPendingNav(() => go); setLeaveAsk(true); } else go();
      return;
    }
    const place = parsePortfolioSub(activeSub);
    if (!place) return;
    const go = () => {
      if (activeId) { setActiveId(null); setView('portfolio'); }
      if (place.tab !== portTab) setPortTab(place.tab);
      if (place.tab === 'properties' && place.view !== committed) { setPview({ ...freshView(), ...decodeView(place.view) }); setCommitted(place.view); }
    };
    if (activeId && editGuard.dirty) { onSubChange?.(wantSub); setPendingNav(() => go); setLeaveAsk(true); } else go();
  }, [activeSub, loading]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The Company picker's list and whether this person may leave an asset with none.
  const companyList = useAssetCompanies();
  // The panel opened in place under a portfolio tab's first row: Trash, Data Gaps, Flagged.
  const [panel, setPanel] = useState(null);
  const { open: moreOpen, setOpen: setMoreOpen, btn: moreBtn, panel: morePanel, close: closeMore } = useMenu();
  // Per-asset numbers for the tiles (occupancy, % complete) - one read, refreshed with the store.
  const [metrics, setMetrics] = useState({});
  useEffect(() => { let alive = true; api.getAssetMetrics().then((m) => { if (alive && m) setMetrics(m); }).catch(() => {}); return () => { alive = false; }; }, [store._ts]);
  // The spec sheet's edit state, for the header's Cancel / Save Changes.
  const [editState, setEditState] = useState({ editing: false, dirty: false });
  useEffect(() => editGuard.subscribe(() => setEditState((s) => (s.editing === editGuard.editing && s.dirty === editGuard.dirty) ? s : { editing: editGuard.editing, dirty: editGuard.dirty })), []);

  const markManageSeen = useCallback(() => {
    const now = new Date().toISOString();
    setLastManageVisit(now);
    try { localStorage.setItem('nexus_manage_seen', now); } catch { /* ignore */ }
  }, []);

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
        // A company the person may not assign, move or clear: the server's words say why.
        const why = d.status === 403 ? (/compan/i.test(d.message || '') ? d.message : "you don't have edit access to Asset Management")
          : d.status === 400 ? (d.message || 'the server refused the change')
          : d.status === 422 ? 'the server rejected the data shape'
          : `save failed (error ${d.status || 'network'})`;
        pushToast(`Could not save - ${why}. Your last change was not stored.`, 'bad');
      }
    };
    // A row someone else saved since this tab read it: the server kept theirs,
    // the workspace was re-pulled; say so rather than overwrite in silence.
    const onConflict = (e) => {
      const rows = e?.detail?.rows || [];
      const names = rows.map((r) => r.name || r.scope || r.type || r.item || r.description || r.id).filter(Boolean).slice(0, 3);
      const n = (e?.detail?.ids || []).length || 1;
      const what = names.length ? names.join(', ') + (n > names.length ? ` and ${n - names.length} more` : '') : (n === 1 ? 'One record' : `${n} records`);
      pushToast?.(`Not saved: ${what} - someone else changed ${n === 1 ? 'it' : 'them'} first. Reloaded with their version; your version is kept on this device for this session.`, 'mut');
    };
    window.addEventListener('nexus:asset-save-failed', onSaveFailed);
    window.addEventListener('nexus:asset-save-conflict', onConflict);
    return () => { window.removeEventListener('nexus:asset-save-failed', onSaveFailed); window.removeEventListener('nexus:asset-save-conflict', onConflict); };
  }, []);

  // Officers/execs/admins (role check) can see private-flagged assets; everyone else can't.
  const canSeePrivate = session && (session.level >= 5 || /owner|officer|exec|admin/i.test(session.role || ''));
  const visibleProperties = useMemo(() => store.properties.filter((p) => !p.deleted && (!p.private || canSeePrivate)), [store.properties, canSeePrivate]);
  const deletedProperties = store.properties.filter((p) => p.deleted && (!p.private || canSeePrivate));
  const findAsset = (id) => visibleProperties.find((p) => p.id === id);
  const active = activeId ? findAsset(activeId) : null;
  const recordsFor = (coll) => (store[coll] || []).filter((r) => r.propertyId === activeId);
  const signals = useTabSignals({ store, assets: visibleProperties });

  // Stable, so the portfolio's memoized cards are not re-rendered for a new function. `item`
  // names a row to highlight: a record's words, or for a permit / timeline a row index (the
  // tabs pass the index), turned here into the words that table highlights by.
  const propsRef = useRef(store.properties);
  useEffect(() => { propsRef.current = store.properties; }, [store.properties]);
  const openAsset = useCallback((id, tab = 'property', item = '') => {
    setActiveId(id); setView(tab);
    if (item === '' || item == null) return;
    let words = String(item);
    if ((tab === 'permit' || tab === 'timeline') && /^\d+$/.test(words)) {
      const asset = propsRef.current.find((p) => p.id === id);
      const rows = tab === 'permit' ? (asset?.permits || []) : (asset?.timeline || []);
      const row = rows[Number(words)];
      const cols = tab === 'permit' ? permitColumns(rows) : TIMELINE_FIELDS;
      words = row ? (cols.map(([k]) => String(row[k] ?? '').trim()).find(Boolean) || '') : '';
    }
    if (words) setHighlight({ tab, section: tab === 'permit' ? 'Permit' : tab === 'timeline' ? 'Timeline' : '', field: '', item: words, at: Date.now() });
  }, []);
  // An asset opened from a tab remembers the tab and its list: Back names it, "< 7 of 23 >" walks it.
  const openFrom = useCallback((tab) => (id, v = 'property', item = '') => {
    if (tab === 'properties') setOrigin({ tab, label: propertyList.current.label || 'Properties', ids: propertyList.current.ids });
    else setOrigin({ tab, label: portfolioTabLabel(tab), ids: null });
    openAsset(id, v, item);
  }, [openAsset]);
  const openers = useMemo(() => Object.fromEntries(PORTFOLIO_TABS.map(([k]) => [k, openFrom(k)])), [openFrom]);

  /** Open a portfolio tab, from anywhere (another tab's "-> Properties", the asset's Back). */
  const goTab = useCallback((tab, opts = {}) => {
    const go = () => {
      setActiveId(null); setView('portfolio'); setPanel(null);
      setPortTab(tab);
      if (tab === 'properties' && opts.preset) {
        const p = presetView(opts.preset, me);
        if (p) { const next = { ...freshView(), ...p, filters: normalizeFilters(p.filters) }; setPview(next); setCommitted(encodeView(next)); }
      }
    };
    if (editGuard.dirty) { setPendingNav(() => go); setLeaveAsk(true); } else go();
  }, [me]);

  // Which properties have open tickets - asked for only when a filter needs it.
  const loadTickets = useCallback(() => {
    if (openTickets || !api.getMaintenancePortfolio) return;
    Promise.resolve(api.getMaintenancePortfolio()).then((r) => {
      const rows = Array.isArray(r) ? r : (r?.properties || r?.rows || []);
      setOpenTickets(new Set(rows.filter((x) => Number(x.open) > 0).map((x) => x.propertyId)));
    }).catch(() => setOpenTickets(new Set()));
  }, [openTickets]);

  // Export CSV is "everything tied to an asset" - that includes its closed
  // tickets summarized as maintenance records, which live in Tickets, not in
  // the store. Fetched at export time; if that fails the file says so
  // instead of silently leaving them out.
  const exportCsvWithTickets = async (asset) => {
    let ticketMaintenance = null;
    try { ticketMaintenance = ticketMaintenanceRows(await api.getPropertyTickets(asset.id), asset); }
    catch { /* exported with a "Not included" row */ }
    exportAssetCsvAsFile(asset, store, { ticketMaintenance, companies: companyList.companies });
  };

  /** All navigation goes through this - it's what enforces the unsaved-changes guard. */
  const navigate = (nextView, after = null) => {
    const go = () => {
      if (nextView === 'manage') { setActiveId(null); setView('portfolio'); setPortTab('activity'); return; }
      setView(nextView);
      if (after) after();
    };
    if (editGuard.dirty) { setPendingNav(() => go); setLeaveAsk(true); }
    else go();
  };

  /** "Go to" from the Activity Log: jump straight to the asset + tab + field a log entry touched. */
  const goToLogEntry = (entry) => {
    const tab = LOG_SECTION_TO_TAB[entry.section] || 'property';
    if (entry.propertyId) setActiveId(entry.propertyId);
    if (!activeId) setOrigin({ tab: 'activity', label: 'Activity', ids: null });
    setView(tab);
    setHighlight({ tab, section: entry.section, field: entry.changes?.[0]?.field || '', item: entry.item || '', at: Date.now() });
  };

  /** Dates' Mark Paid / Mark Renewed (and any one-asset patch from a tab): the top-level keys and
   *  their snapshot values, ONE Activity entry, saved through the per-row sync. */
  const onPatchAsset = useCallback((id, patch, changes = []) => {
    setStore((s) => {
      const idx = s.properties.findIndex((p) => p.id === id);
      if (idx < 0) return s;
      const next = patchAssetRow(s.properties[idx], patch);
      return appendLog({ ...s, properties: s.properties.map((p, i) => (i === idx ? next : p)) },
        makeLogEntry({ section: 'Property', property: next.name, propertyId: id, action: 'edited', item: next.name, changes }));
    });
  }, [setStore]);

  /** The register's bulk line: Set Company / Set Asset Manager / Set Stage on the selected
   *  properties (and their linked parcels) - one row save and one Activity entry per asset. */
  const bulkSet = useCallback((ids, field, value) => {
    const names = companyList.companies;
    // [{ id, patch, change }] for every asset the choice would change.
    const plan = (props) => {
      const pick = new Set(ids);
      props.forEach((p) => { if (p.parentId && pick.has(p.parentId)) pick.add(p.id); });
      return props.filter((p) => pick.has(p.id) && !p.deleted).map((p) => {
        const isProp = inferAssetKind(p) === 'property';
        if (field === 'company') return companyIdOf(p) === value ? null : { id: p.id, patch: { companyId: value }, change: { field: 'Company', from: companyName(names, companyIdOf(p)), to: companyName(names, value) } };
        if (field === 'manager') return String(p.manager || '') === value ? null : { id: p.id, patch: { manager: value }, change: { field: isProp ? 'PM / Asset Manager' : 'Assigned to / Operator', from: p.manager || '', to: value } };
        return String(p.devStage || '') === value ? null : { id: p.id, patch: { devStage: value }, change: { field: isProp ? 'Development Stage' : 'Status', from: p.devStage || '', to: value } };
      }).filter(Boolean);
    };
    const n = plan(store.properties).length;
    setStore((s) => plan(s.properties).reduce((next, { id, patch, change }) => {
      const row = patchAssetRow(next.properties.find((x) => x.id === id), patch);
      return appendLog({ ...next, properties: next.properties.map((x) => (x.id === id ? row : x)) },
        makeLogEntry({ section: 'Property', property: row.name, propertyId: id, action: 'edited', item: row.name, changes: [change] }));
    }, s));
    pushToast(n ? `Changed ${n} ${n === 1 ? 'asset' : 'assets'}` : 'Nothing to change - they already read that way', n ? 'ok' : 'mut');
  }, [setStore, store.properties, companyList.companies]);

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

      // Company (11/03/2026): an id on the row, never a snapshot value; the log
      // names the companies. The server checks the change on the row save.
      if ('Company' in draft) {
        const from = companyIdOf(asset);
        const to = String(draft.Company || '').trim();
        if (from !== to) {
          flat.companyId = to;
          changes.push({ field: 'Company', from: companyName(companyList.companies, from), to: companyName(companyList.companies, to) });
        }
      }

      // Egnyte Folder (11/03/2026): the pinned path on the row, never a snapshot
      // value, stored as the server normalizes it; the server checks the change.
      if ('Egnyte Folder' in draft) {
        const from = egnyteFolderOf(asset);
        const to = normalizeEgnyteFolder(draft['Egnyte Folder']);
        if (from !== to) {
          flat.egnyteFolder = to;
          changes.push({ field: 'Egnyte Folder', from, to });
        }
      }

      if (kind === 'property') {
        snapshot = PT.map((group) => ({
          group: group.group,
          fields: group.fields.filter((f) => f.type !== 'company' && f.type !== 'egnyte').map((f) => {
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
    // A trashed asset's card is gone from the grid; Back must not outline anything for it.
    setLastOpenedId((cur) => (cur === id ? null : cur));
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
  const PURGE_COLLECTIONS = ['warranties', 'inspections', 'documents', 'ahj', 'utilities', 'vendors', 'vservice', 'odometer', 'vdocs', 'maintenance'];
  // What Delete Forever's ask names (Neil, Oct 30 2026 - hold to confirm).
  const recordsOf = (id) => PURGE_COLLECTIONS.reduce((n, coll) => n + (store[coll] || []).filter((r) => r.propertyId === id).length, 0);
  const purgeAsset = (id) => setStore((s) => {
    const next = { ...s, properties: s.properties.filter((p) => p.id !== id), logs: (s.logs || []).filter((l) => l.propertyId !== id) };
    for (const coll of PURGE_COLLECTIONS) {
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

  const assetKind = active ? inferAssetKind(active) : null;
  const recordViews = active ? recordViewsFor(assetKind) : [];
  const onRecords = recordViews.includes(view);
  const recCount = (key) => (!active ? 0 : key === 'permit' ? (active.permits || []).length : recordsFor(key).length);
  const withRows = recordViews.filter((k) => recCount(k) > 0 || k === view);
  const hasTimeline = !!active && ((active.timeline || []).length > 0 || view === 'timeline');
  const openAdd = (coll) => {
    if (coll === 'permit') setModal({ type: 'plist', field: 'permits', index: null, fields: permitColumns(active?.permits) });
    else setModal({ type: 'row', coll, id: null });
  };
  // The asset's tabs (Neil, 11/17/2026): Overview, Maintenance, Records (a dropdown of the
  // collections that have rows, and "Add ..." for the empty ones), Timeline only when there is
  // one, Activity. Vehicles and equipment: Overview, Records, Activity.
  const assetTabs = !active ? [] : stripTabsFor(assetKind).filter(([k]) => k !== 'timeline' || hasTimeline).map(([key, label]) => (key === 'records' ? {
    key: 'records', label,
    items: [
      ...withRows.map((k) => ({ key: k, label: recordLabel(k), hint: String(recCount(k)) })),
      ...recordViews.filter((k) => !withRows.includes(k)).map((k) => ({ key: `add:${k}`, label: `Add ${ADD_NOUN[k] || recordLabel(k)}`, Icon: Plus })),
    ],
  } : { key, label }));
  const onAssetTab = (key) => {
    if (key.startsWith('add:')) { const coll = key.slice(4); navigate(coll, () => openAdd(coll)); return; }
    navigate(key);
  };

  // The portfolio's top menu: a tab shows when it has something to show (the one open always
  // does); a plain number after a name only when something waits - never a pill.
  const portfolioTabs = PORTFOLIO_TABS.filter(([k]) => k === portTab
    || (k === 'fleet' ? signals.hasFleet : k === 'development' ? signals.hasPipeline : k === 'maintenance' ? (signals.maintenanceKnown !== false && signals.maintenanceAllowed) : true))
    .map(([key, label]) => ({
      key, label,
      ...(key === 'maintenance' && signals.maintenanceOpen ? { count: signals.maintenanceOpen } : {}),
      ...(key === 'dates' && signals.datesPassed ? { count: signals.datesPassed, countTone: 'red' } : {}),
    }));

  // Back names where the asset was opened from ("<- Properties", a saved view's name).
  const backLabel = origin?.label || (assetKind && assetKind !== 'property' ? 'Fleet' : 'Properties');
  const backTab = origin?.tab || (assetKind && assetKind !== 'property' ? 'fleet' : 'properties');
  const backToList = () => goTab(backTab);
  useTrailCrumbs(active ? [{ label: backLabel, onClick: backToList }] : null);

  // "< 7 of 23 >": the list it was opened from (the register's filtered, sorted rows), else
  // every asset of its kind by name.
  const walkIds = useMemo(() => {
    if (!active) return [];
    if (origin?.ids?.includes(active.id)) return origin.ids;
    const kindOf = (a) => (inferAssetKind(a) === 'property' ? 'property' : 'fleet');
    const k = kindOf(active);
    return visibleProperties.filter((a) => kindOf(a) === k && (!a.parentId || a.id === active.id))
      .sort((a, b) => String(a.siteName || a.name).localeCompare(String(b.siteName || b.name))).map((a) => a.id);
  }, [active, origin, visibleProperties]);
  const walkTo = (id) => {
    if (!id) return;
    const target = findAsset(id);
    const kind = target ? inferAssetKind(target) : 'property';
    const keep = view === 'property' || view === 'activity'
      || (kind === 'property' ? (view === 'maintenance' || (view === 'timeline' && (target?.timeline || []).length) || recordViewsFor('property').includes(view)) : recordViewsFor(kind).includes(view));
    const go = () => { setActiveId(id); setView(keep ? view : 'property'); };
    if (editGuard.dirty) { setPendingNav(() => go); setLeaveAsk(true); } else go();
  };
  const at = active ? walkIds.indexOf(active.id) : -1;
  const position = at < 0 ? null : {
    index: at, total: walkIds.length,
    onPrev: at > 0 ? () => walkTo(walkIds[at - 1]) : null,
    onNext: at < walkIds.length - 1 ? () => walkTo(walkIds[at + 1]) : null,
  };

  // Each record table draws its own search, Export and "+ New" in its toolbar row (the floating
  // search above the title is gone); a permit or timeline search writes filters.permit / .timeline.
  const setQuery = (key) => (text) => setFilters((f) => ({ ...f, [key]: text }));

  const flagCount = visibleProperties.reduce((n, p) => n + ((p.reviewFlags || []).length), 0);
  const portfolioActions = (
    <>
      <NewButton items={NEW_ITEMS} menuLabel="New asset" onPick={(key) => (key === 'import'
        ? setModal({ type: 'property', id: null, mode: 'import' })
        : setModal({ type: 'property', id: null, draft: key === 'property' ? undefined : { kind: key } }))} />
      <button ref={moreBtn} type="button" className="secondary-btn pt-more-btn" aria-label="More" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
        <MoreHorizontal size={16} />
      </button>
      <AnchoredMenu anchorRef={moreBtn} open={moreOpen} onClose={() => setMoreOpen(false)} align="end" minWidth={240} style={MENU_PANEL} aria-label="More">
        <div ref={morePanel} onKeyDown={menuKeys}>
          <MenuItem Icon={Trash2} hint={deletedProperties.length ? String(deletedProperties.length) : ''} onClick={() => { closeMore(); setPanel('trash'); }}>Trash</MenuItem>
          <MenuItem Icon={Upload} onClick={() => { closeMore(); setModal({ type: 'property', id: null, mode: 'import' }); }}>Import From a Spreadsheet</MenuItem>
          <MenuItem Icon={Download} onClick={() => {
            closeMore();
            const ids = portTab === 'properties' ? propertyList.current.ids : null;
            const list = ids ? ids.map(findAsset).filter(Boolean) : visibleProperties;
            exportPortfolioCsv(list, visibleProperties, companyList.companies, metrics);
          }}>Export as CSV</MenuItem>
        </div>
      </AnchoredMenu>
    </>
  );
  const copyLink = () => {
    const seg = window.location.pathname.split('/').filter(Boolean)[0] || 'property-asset';
    const url = `${window.location.origin}/${seg}/${portfolioSub('properties', encodeView({ ...pview, mode }))}`;
    Promise.resolve(navigator.clipboard?.writeText(url)).then(() => pushToast('Link copied - it opens this view for anyone who can see Asset Management.', 'ok'))
      .catch(() => pushToast('Could not copy the link - copy it from the address bar.', 'mut'));
  };
  const tabProps = { store, assets: visibleProperties, goTab, companies: companyList.companies, metrics, session, canEdit: canEditAssets };
  const findUnit = () => {
    const scroll = () => setTimeout(() => document.getElementById('gt-model')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    if (view !== 'property') navigate('property', scroll); else scroll();
  };

  return (
    <div className="asset-shell" style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <ToastHost />
      <SyncStatus />

      {leaveAsk && (
        <UnsavedChangesPrompt
          onKeepEditing={() => { setLeaveAsk(false); setPendingNav(null); }}
          onDiscard={() => { editGuard.cancel?.(); setLeaveAsk(false); const go = pendingNav; setPendingNav(null); go ? go() : (setActiveId(null), setView('portfolio')); }}
          onSave={() => { editGuard.save?.(); setLeaveAsk(false); const go = pendingNav; setPendingNav(null); go ? go() : (setActiveId(null), setView('portfolio')); }}
        />
      )}

      {/* ---------------- The portfolio: its top menu and the open tab ---------------- */}
      {!active && (
        <>
          <ModuleTabs tabs={portfolioTabs.map((t) => ({ ...t }))} active={portTab} onChange={(k) => goTab(k)} />
          {/* Every tab's first row: "+ New" and "..." on the right. Properties puts its view's
              name on the left (Portfolio draws its own row); Overview and the rest show none -
              the tab already names the page (Neil, 11/17/2026). */}
          {portTab !== 'properties' && (
            <ModuleActions>
              <div className="pt-first-row"><div className="pt-first-actions">{portfolioActions}</div></div>
            </ModuleActions>
          )}
          {panel === 'trash' && <TrashPanel deleted={deletedProperties} onRecover={recoverAsset} onPurge={purgeAsset} recordsOf={recordsOf} onClose={() => setPanel(null)} />}
          {panel === 'gaps' && <DataGapsPanel assets={visibleProperties.filter((p) => inferAssetKind(p) === 'property')} onOpen={openers.properties} onDelete={(id) => deleteAsset(id, true)} serverOk={serverOk} onClose={() => setPanel(null)} />}
          {panel === 'flags' && <ReviewFlagsPanel props={visibleProperties} onClearFlag={toggleFlag} onOpen={openers.properties} onPushFix={pushFieldFix} onClose={() => setPanel(null)} />}

          {portTab === 'properties' && (
            <>
              {(pview.id === 'missing' || flagCount > 0) && !panel && !phone && (
                <div className="pt-aside-links">
                  {pview.id === 'missing' && <button type="button" className="pt-link" onClick={() => setPanel('gaps')}>Show what each property is missing</button>}
                  {flagCount > 0 && <button type="button" className="pt-link" onClick={() => setPanel('flags')}>Review {flagCount} flagged {flagCount === 1 ? 'field' : 'fields'}</button>}
                </div>
              )}
              <Portfolio assets={visibleProperties} store={store} metrics={metrics} companies={companyList.companies} canClearCompany={companyList.canClear}
                view={{ ...pview, mode }} onView={(next) => setPview({ ...next, mode: next.mode && next.mode !== storedMode ? next.mode : '' })}
                mode={mode} onMode={(k) => { setStoredMode(k); setPview((v) => ({ ...v, mode: '' })); }}
                saved={Array.isArray(savedViews) ? savedViews : []} onSaveViews={setSavedViews} me={me}
                openAsset={openers.properties} lastOpenedId={lastOpenedId} serverOk={serverOk} loading={loading}
                onBulkSet={bulkSet} canEdit={canEditAssets} openTickets={openTickets} onNeedTickets={loadTickets} onCopyLink={copyLink}
                onListChange={(ids, label) => { propertyList.current = { ids, label }; }} actions={portfolioActions} />
            </>
          )}
          {portTab === 'overview' && <OverviewTab {...tabProps} openAsset={openers.overview} onPatchAsset={onPatchAsset} />}
          {portTab === 'fleet' && <FleetTab {...tabProps} openAsset={openers.fleet} />}
          {portTab === 'development' && <DevelopmentTab {...tabProps} openAsset={openers.development} />}
          {portTab === 'maintenance' && <MaintenanceTab {...tabProps} openAsset={openers.maintenance} />}
          {portTab === 'dates' && <DatesTab {...tabProps} openAsset={openers.dates} onPatchAsset={onPatchAsset} />}
          {portTab === 'activity' && (
            <ActivityTab {...tabProps} openAsset={openers.activity} logs={store.logs || []} onGoTo={goToLogEntry} onUndo={undoLogEntry} canUndo={canUndo}
              lastSeen={lastManageVisit} onSeen={markManageSeen} />
          )}
        </>
      )}

      {/* ---------------- An open asset ---------------- */}
      {active && (
        <>
          <AssetTitleBand asset={active} all={visibleProperties} companies={companyList.companies} metric={metrics[active.id]} phone={phone}
            position={position} canEdit={view === 'property'} editing={editState.editing} dirty={editState.dirty} serverOk={serverOk}
            onEdit={() => editGuard.startEdit?.()} onCancel={() => editGuard.cancel?.()} onSave={() => editGuard.save?.()}
            onTogglePrivate={() => togglePrivate(active.id)} onDuplicate={() => duplicateAsset(false)}
            onExportPdf={() => exportAssetPdf(active, store)} onExportCsv={() => exportCsvWithTickets(active)}
            onReportProblem={assetKind === 'property' ? () => setReportFor({ id: active.id, name: active.name }) : null}
            onFindUnit={assetKind === 'property' ? findUnit : null} />
          <ParcelManager active={active} all={store.properties} onOpen={(id) => openAsset(id, 'property')} onLink={linkParcel} onUnlink={unlinkParcel} onTogglePrimary={togglePrimaryParcel} onMove={moveParcelOrder} onRenameGroup={renameGroup} onDuplicate={() => duplicateAsset(true)} onSetAssembled={setAssembled} />
          {/* The asset's tabs ride the module bar; a phone keeps the strip here, under the title band. */}
          <ModuleTabs tabs={assetTabs} active={onRecords ? view : view} onChange={onAssetTab} />

          {onRecords && withRows.length > 1 && (
            <div className="at-subrow">
              <div className="at-subtabs scroll-tabs" role="tablist" aria-label="Records">
                {withRows.map((key) => (
                  <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'is-on' : ''} onClick={() => navigate(key)}
                    title={recordHint(key) || undefined}>
                    {recordLabel(key)} <span className="at-subtab-n">{recCount(key)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {onRecords && recordHint(view) && <div className="at-hint">{recordLabel(view)} - {recordHint(view)}</div>}

          {view === 'property' && (
            <AssetOverviewPage asset={active} store={store} editing={editState.editing} onTab={navigate} onGoTo={goToLogEntry}
              onStartEdit={(field) => { if (field) setHighlight({ tab: 'property', section: '', field: String(field).toLowerCase(), item: '', at: Date.now() }); editGuard.startEdit?.(); }}
              onSaveEntityCode={(code) => setEntityCode(active.id, code)} onOpenAsset={(id) => openAsset(id, 'property')}
              detailFormProps={{
                p: active, onSaveImages: saveImages, onSaveDetail: saveDetail, onSaveContact: saveContact,
                highlight: highlight?.tab === 'property' ? highlight : null, onOpenLead: (id) => openAsset(id, 'property'), onFlag: toggleFlag,
                companies: companyList.companies, canClearCompany: companyList.canClear, egnyteLocked: !!egnyteFolderOf(active) && !mayRepinEgnyte,
              }} />
          )}

          {view === 'activity' && (
            <ActivityTab {...tabProps} assets={[active]} openAsset={openAsset} logs={(store.logs || []).filter((l) => l.propertyId === active.id)}
              onGoTo={goToLogEntry} onUndo={undoLogEntry} canUndo={canUndo} lastSeen={lastManageVisit} onSeen={NOOP} scopeName={active.name} />
          )}

          {view === 'documents' && (
            <AssetEgnyteDocs asset={active} canConnect={canEditAssets} hideUnconnected={!recordsFor('documents').length}
              onConnect={(path) => saveDetail({ 'Egnyte Folder': path })} />
          )}
          {['warranties', 'inspections', 'documents', 'vdocs', 'utilities', 'ahj', 'vendors', 'odometer'].map((coll) => (
            view === coll && (
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
                emptyNode={coll !== 'documents' ? null : egnyteFolderOf(active)
                  ? <div className="at-empty">The asset&apos;s plans and documents are listed above, from its Egnyte folder.</div>
                  : <ConnectEgnyteEmpty asset={active} canConnect={canEditAssets} onConnect={(path) => saveDetail({ 'Egnyte Folder': path })} />}
              />
            )
          ))}

          {view === 'maintenance' && (
            <PropertyMaintenanceSection p={active} rows={recordsFor('maintenance')} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'maintenance' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'maintenance', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'maintenance', id })} onSaveUnits={(units) => setTenantUnits(active.id, units)} onQuickAdd={(patch) => saveRecord('maintenance', null, patch)} ticketFocus={ticketFocus} />
          )}
          {view === 'vservice' && (
            <VserviceSection p={active} rows={recordsFor('vservice')} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'vservice' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'vservice', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'vservice', id })} onQuickAdd={(patch) => saveRecord('vservice', null, patch)} />
          )}

          {view === 'timeline' && (
            <>
              <TimelineTracker rows={active.timeline} />
              <SimpleRecordTable
                title="Development Timeline"
                subtitle={active.name}
                rows={active.timeline}
                cols={TIMELINE_FIELDS}
                query={filters.timeline || ''}
                onQueryChange={setQuery('timeline')}
                highlightItem={highlight?.section === 'Timeline' ? highlight.item : ''}
                onAdd={() => setModal({ type: 'plist', field: 'timeline', index: null, fields: TIMELINE_FIELDS.filter(([k]) => k !== 'status') })}
                onEdit={(i) => setModal({ type: 'plist', field: 'timeline', index: i, fields: TIMELINE_FIELDS.filter(([k]) => k !== 'status') })}
                onStatusClick={(i, current) => setModal({ type: 'tstatus', index: i, current })}
              />
            </>
          )}
          {view === 'permit' && (
            <SimpleRecordTable
              title="Permits"
              subtitle={active.name}
              rows={active.permits}
              cols={permitColumns(active.permits)}
              query={filters.permit || ''}
              onQueryChange={setQuery('permit')}
              highlightItem={highlight?.section === 'Permit' ? highlight.item : ''}
              onAdd={() => setModal({ type: 'plist', field: 'permits', index: null, fields: permitColumns(active.permits) })}
              onEdit={(i) => setModal({ type: 'plist', field: 'permits', index: i, fields: permitColumns(active.permits) })}
              onDelete={(i) => deletePropertyListRow('permits', i, permitColumns(active.permits))}
            />
          )}
        </>
      )}

      {reportFor && <PropertyTicketComposer property={reportFor} onClose={() => setReportFor(null)} />}

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
          companies={companyList.companies}
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
                  { label: 'Linked item serial', value: createdItem?.serialNumber || '' },
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
