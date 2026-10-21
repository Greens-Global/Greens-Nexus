// Operations - the storage facilities, read from Cubby (Oct 2026).
//
// Replaces the mock FMS / Reputation / Site Staff tabs. Nothing here is typed
// in: every figure comes from GET /facility-ops/summary, which reads the copy
// of Cubby the server syncs into the database every 15 minutes (Oct 15).
// One fetch feeds all four tabs and the facility picker, so switching either
// is instant. Nexus only reads - payments, leases and tenant edits stay in
// Cubby, and each tenant row links there.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDashboard, HandCoins, Warehouse, ListChecks, Scale, FileSpreadsheet, RefreshCw, TrendingUp, Gauge, Map as MapIcon, Lightbulb, Users, LineChart, Tags, ArrowUpRight, ShieldAlert, Percent, Target, CalendarClock, Wrench, Download } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { combine, PERIODS, periodRange } from '../operations/model';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { Overview, Collections, Units, Worklist } from '../operations/OpsTabs';
import RateManagement from '../operations/RateManagement';
import Reports from '../operations/Reports';
import Lookup from '../operations/Lookup';
import SyncStatus from '../operations/SyncStatus';
import Revenue from '../operations/Revenue';
import Portfolio from '../operations/Portfolio';
import ThirdPartyPanel from '../operations/ThirdPartyPanel';
import { isThirdParty } from '../operations/thirdParty';
import FacilityPicker from '../operations/FacilityPicker';
import { useRole } from '../contexts/RoleContext';
import '../operations/ops.css';
// Site Map (Oct 20): the 3D site model with layers. Lazy, so three.js loads only on that tab.
const SiteMap = lazy(() => import('../operations/SiteMap'));
// Pricing Insights (Visesh, Oct 20): insights from Cubby's pricing + the market. Lazy, its own chunk.
const PricingInsights = lazy(() => import('../operations/PricingInsights'));

const SYNC_POLL_MS = 3000;
const NOT_CONNECTED = "Cubby is not connected on this server yet. An administrator needs to set CUBBY_API_KEY in the API's app settings.";

// The bar is five dropdowns, like Accounting's (Visesh, Oct 21): every screen
// and every view inside one is a menu item, so nothing is picked from a row of
// pills or a View box in the page. The old tab keys did not change - a group
// is only how the bar draws them - so bookmarks and notification links land.
// A view inside a screen is `<screen>-<view>` (reports-scheduled); the screen's
// own key is its first view.
const TABS = [
  { key: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, items: [
    { key: 'overview',    label: 'Overview',        Icon: LayoutDashboard },
    // The Daily Flash for any set of properties, with its own picker and month (Neil, Oct 20).
    { key: 'portfolio',   label: 'Portfolio',       Icon: Gauge },
    { key: 'site-map',    label: 'Site Map',        Icon: MapIcon },
  ] },
  { key: 'facilities', label: 'Facilities', Icon: Warehouse, items: [
    { key: 'collections', label: 'Collections',     Icon: HandCoins },
    { key: 'units',       label: 'Units & Pricing', Icon: Warehouse },
    { key: 'worklist',    label: 'Worklist',        Icon: ListChecks },
  ] },
  // Ranked insights from Cubby's pricing, the rent roll and the market (Visesh,
  // Oct 20) - same door as Rate Management - one menu item per section.
  { key: 'pricing-menu', label: 'Pricing', Icon: Scale, items: [
    { key: 'market',              label: 'Rate Management',     Icon: Scale },
    { key: 'pricing',             label: 'Pricing Insights',    Icon: Lightbulb },
    { key: 'pricing-competitive', label: 'Competitive Pricing', Icon: Users },
    { key: 'pricing-trends',      label: 'Trends',              Icon: LineChart },
    { key: 'pricing-standard',    label: 'Standard Rates',      Icon: Tags },
    { key: 'pricing-ecri',        label: 'ECRI',                Icon: ArrowUpRight },
    { key: 'pricing-risk',        label: 'Revenue at Risk',     Icon: ShieldAlert },
    { key: 'pricing-discounts',   label: 'Discounts',           Icon: Percent },
  ] },
  // Rent changes for existing tenants (Neil, Oct 20) - managers and admins, or an Operations Full grant.
  { key: 'revenue-menu', label: 'Revenue Management', Icon: TrendingUp, items: [
    { key: 'revenue',            label: 'Tenants',      Icon: Users },
    { key: 'revenue-strategies', label: 'Strategies',   Icon: Target },
    { key: 'revenue-batches',    label: 'Rent Changes', Icon: TrendingUp },
  ] },
  { key: 'reports-menu', label: 'Reports', Icon: FileSpreadsheet, items: [
    { key: 'reports',           label: 'Reports',        Icon: FileSpreadsheet },
    { key: 'reports-scheduled', label: 'Scheduled',      Icon: CalendarClock },
    { key: 'reports-builder',   label: 'Report Builder', Icon: Wrench },
    { key: 'reports-exports',   label: 'Quick Exports',  Icon: Download },
  ] },
];
// A bar key -> the screen it opens and the view inside it.
const SCREEN_VIEWS = {
  pricing: { prefix: 'pricing', first: 'overview' },
  revenue: { prefix: 'revenue', first: 'tenants' },
  reports: { prefix: 'reports', first: 'reports' },
};
const screenOf = (key) => {
  for (const [screen, { prefix, first }] of Object.entries(SCREEN_VIEWS)) {
    if (key === screen) return { screen, view: first };
    if (key.startsWith(`${prefix}-`)) return { screen, view: key.slice(prefix.length + 1) };
  }
  return { screen: key, view: '' };
};
const viewKey = (screen, view) => (view === SCREEN_VIEWS[screen].first ? screen : `${SCREEN_VIEWS[screen].prefix}-${view}`);
// Tabs that work on one facility at a time and are not about a period. With
// All Facilities picked they open on the first facility (the first one with a
// site model, for the Site Map) and the dropdown shows which; the page's
// choice itself stays All, so the other tabs still see every facility.
const ONE_FACILITY = new Set(['market', 'revenue', 'site-map']);
const NO_PERIOD = new Set([...ONE_FACILITY, 'pricing']);
const leafKeys = (tabs) => tabs.flatMap((t) => (t.items ? t.items.map((i) => i.key) : [t.key]));

// The facility choice is remembered per viewer on this device and kept across tabs.
const FACILITY_KEY = 'nexus.ops.facility';
const readFacility = () => { try { return localStorage.getItem(FACILITY_KEY) || 'all'; } catch { return 'all'; } };
const saveFacility = (id) => { try { localStorage.setItem(FACILITY_KEY, id); } catch { /* not remembered */ } };

export default function FacilityOperations({ activeSub, onSubChange }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [refreshing, setRefreshing] = useState(false);
  // The ONE facility choice for every tab (Oct 20), remembered on this device.
  const [picked, setPickedState] = useState(readFacility);
  const setPicked = useCallback((id) => { setPickedState(id); saveFacility(id); }, []);
  const [period, setPeriod] = useState('this-month');
  // Where the last KPI / chart bar pointed: the card to scroll to and, for the
  // past-due table, what to narrow it to. `n` changes on every click so the
  // same target can be asked for twice.
  const [focus, setFocus] = useState(null);

  const load = useCallback(async (fresh = false) => {
    if (fresh) setRefreshing(true);
    else setState((s) => (s.data ? s : { status: 'loading', data: null, error: null }));
    try {
      const data = await api.getFacilityOps(fresh);
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      console.error('Operations: could not load facility figures', err);
      // Keep what is on screen when a refresh fails; only an empty screen shows the error.
      setState((s) => (s.data ? s : { status: 'error', data: null, error: err }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Stores another operator runs (CubeSmart, Oct 20 2026): their own read, so a
  // Cubby problem never hides them and theirs never hides Cubby's.
  const [thirdParty, setThirdParty] = useState([]);
  const loadThirdParty = useCallback(async () => {
    try {
      const r = await api.getThirdPartyFacilities?.();
      if (r) setThirdParty(r.facilities || []);
    } catch (err) {
      console.error('Operations: could not load the operator-managed stores', err);
    }
  }, []);
  useEffect(() => { loadThirdParty(); }, [loadThirdParty]);
  useEffect(() => pollWhileVisible(() => loadThirdParty(), 5 * 60 * 1000), [loadThirdParty]);

  // Refresh asks the server for a Cubby sync (it runs in the background), polls
  // until it is done, then re-reads the figures. A sync someone else started
  // counts too: wait for it instead of starting another.
  const [notice, setNotice] = useState('');
  // Only managers and above are told about the missing key; everyone sees the delayed chip.
  const role = useRole();
  const canSeeKeyHint = role?.can?.('manager') ?? false;
  const canRevenue = role?.canAccessModule ? role.canAccessModule('operations', 'manager', 'full') : canSeeKeyHint;
  const tabs = canRevenue ? TABS : TABS.filter((t) => t.key !== 'revenue-menu');
  // A menu's own key opens its first item; the old mock tab ids (fms,
  // reputation, site-staff) and anything else unknown open the Overview.
  const leaves = leafKeys(tabs);
  const group = tabs.find((t) => t.key === activeSub && t.items);
  const wanted = group ? group.items[0].key : activeSub;
  const sub = leaves.includes(wanted) ? wanted
    : (wanted === 'revenue' || String(wanted).startsWith('revenue-')) ? 'revenue' : 'overview';
  const { screen, view } = screenOf(sub);
  const onView = (s) => (v) => onSubChange?.(viewKey(s, v));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;   // StrictMode mounts twice; the second mount must turn it back on
    return () => { alive.current = false; };
  }, []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice('');
    try {
      await api.startCubbySync();
    } catch (err) {
      if (err?.status !== 409) {
        if (alive.current) { setNotice(err?.message || "Couldn't start a Cubby sync."); setRefreshing(false); }
        return;
      }
    }
    const until = Date.now() + 5 * 60 * 1000;
    while (alive.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
      try {
        const s = await api.getCubbySync();
        if (!s?.running) {
          if (s?.last?.status === 'failed' && alive.current) setNotice('The Cubby sync did not finish. The figures below are from the last good one.');
          break;
        }
      } catch { /* keep waiting; the read below still runs */ }
    }
    if (alive.current) await load(true);
  }, [load]);
  // Stay current without Refresh: re-read every 5 minutes while the tab is in
  // view (the server re-reads Cubby on its own every 15). Quiet - the figures
  // on screen stay put until the new ones arrive.
  useEffect(() => pollWhileVisible(() => load(), 5 * 60 * 1000), [load]);

  const facilities = useMemo(() => [...(state.data?.facilities || []), ...thirdParty], [state.data, thirdParty]);

  // True while the Site Map is on screen with its own search box.
  const [mapSearch, setMapSearch] = useState(false);
  // Which facilities have a site model, for the Site Map's first facility.
  const [modelIds, setModelIds] = useState(null);
  useEffect(() => {
    if (screen !== 'site-map' || modelIds) return undefined;
    let on = true;
    Promise.resolve()
      .then(() => api.getOpsSiteMapFacilities?.())
      .then((l) => { if (on) setModelIds((l || []).map((m) => m.facilityId)); })
      .catch(() => { if (on) setModelIds([]); });
    return () => { on = false; };
  }, [screen, modelIds]);

  // A remembered facility that is not on the list (yet, or any more) reads as All.
  const current = picked === 'all' || facilities.some((f) => f.id === picked) ? picked : 'all';
  const oneTab = ONE_FACILITY.has(screen);
  const firstOne = useMemo(() => {
    if (screen === 'site-map') return modelIds ? facilities.find((f) => modelIds.includes(f.id)) : null;
    return (state.data?.facilities || [])[0] || facilities[0];
  }, [screen, modelIds, facilities, state.data]);
  const shown = oneTab && current === 'all' ? (firstOne?.id || 'all') : current;
  const scope = useMemo(
    () => (shown === 'all' ? facilities : facilities.filter((f) => f.id === shown)),
    [facilities, shown],
  );
  const single = scope.length === 1 ? scope[0] : null;
  const data = useMemo(() => combine(scope), [scope]);
  const many = scope.length > 1;
  const range = useMemo(() => periodRange(period, facilities[0]?.asOf), [period, facilities]);

  const go = (tab, section, filter = null) => {
    setFocus({ section, filter, n: Date.now() });
    if (tab !== sub) onSubChange?.(tab);
  };
  const jump = (tab, shortName, section) => {
    const hit = facilities.find((f) => f.shortName === shortName);
    if (hit) setPicked(hit.id);
    go(tab, section);
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <ModuleTabs tabs={tabs} active={sub} onChange={onSubChange} />

      <div className="view-header">
        <div className="view-title-group">
          <h2>Operations</h2>
          <p>
            {state.data
              ? <>{`${state.data.organization || 'Storage facilities'} - ${(state.data.facilities || []).length} facilities from Cubby${thirdParty.length ? `, ${thirdParty.length} managed by an operator` : ''}, updates automatically - `}<SyncStatus data={state.data} syncing={refreshing} /></>
              : 'Storage facility figures from Cubby'}
          </p>
        </div>
        {state.data && (
          <button type="button" className="secondary-btn" onClick={refresh} disabled={refreshing}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} aria-hidden="true" /> {refreshing ? 'Syncing…' : 'Refresh'}
          </button>
        )}
      </div>
      {notice && <p className="ops-note" role="status" style={{ margin: '0 0 12px' }}>{notice}</p>}

      {state.status === 'loading' && <LoadingState size="view" label="Reading the facilities from Cubby" minHeight={320} onRetry={() => load()} />}

      {state.status === 'error' && (
        <ErrorBanner
          message={state.error?.status === 503
            ? 'Cubby is not connected yet. An administrator needs to add the Cubby API key.'
            : "Couldn't load the facility figures from Cubby."}
          onRetry={() => load()} />
      )}

      {state.status === 'ready' && !facilities.length && (
        <div className="dash-card"><div className="ops-empty">
          {state.data?.syncStatus === 'not_configured' ? NOT_CONNECTED : 'Cubby returned no facilities for this account.'}
        </div></div>
      )}

      {state.status === 'ready' && facilities.length > 0 && state.data?.cubbyConfigured === false && canSeeKeyHint && (
        <p className="ops-note" role="status" style={{ margin: '0 0 12px' }}>
          Cubby is not connected on this server, so these figures are from the last sync and will not update. An administrator needs to set CUBBY_API_KEY in the API's app settings.
        </p>
      )}

      {state.status === 'ready' && facilities.length > 0 && screen === 'portfolio' && <Portfolio />}

      {state.status === 'ready' && facilities.length > 0 && screen !== 'portfolio' && (
        <div className="ops-root">
          <div className="ops-bar-top">
            <FacilityPicker facilities={facilities} value={shown} onChange={setPicked} allowAll={!oneTab} />
            <div className="ops-bar-right">
              {/* The Site Map has its own search on the map (units here, tenants anywhere) - one box, not two.
                  Until that map is on screen (loading, failed, no site model) this Lookup stands in. */}
              {(screen !== 'site-map' || !mapSearch) && <Lookup />}
              {!NO_PERIOD.has(screen) && (
                <label className="ops-period">
                  <span>Period</span>
                  <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                    {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
          {!NO_PERIOD.has(screen) && (
            <p className="ops-note">
              Occupancy, rent and balances are as of today. Move-ins, collections and failed payments cover {range.label.toLowerCase()} ({formatDate(range.from)} - {formatDate(range.to)}).
            </p>
          )}

          {screen === 'overview' && <ThirdPartyPanel facilities={scope.filter(isThirdParty)} canUpload={canSeeKeyHint} onSaved={loadThirdParty} />}
          {screen === 'overview' && <Overview data={data} facilities={facilities} scope={scope} many={many} range={range} focus={focus} go={go} onPick={setPicked} onJump={jump} />}
          {screen === 'collections' && <Collections data={data} scope={scope} trend={state.data.trend} many={many} range={range} focus={focus} go={go} />}
          {screen === 'units' && <Units data={data} many={many} focus={focus} go={go}
            unitClasses={state.data.unitClasses} canEditClasses={canSeeKeyHint} onClassesSaved={() => load(true)} />}
          {screen === 'worklist' && <Worklist data={data} many={many} focus={focus} go={go} />}
          {screen === 'market' && <RateManagement facility={single} />}
          {screen === 'reports' && <Reports data={data} facilities={facilities} scope={scope} range={range} section={view} onSection={onView('reports')} />}
          {screen === 'revenue' && (canRevenue
            ? <Revenue facility={single} section={view} onSection={onView('revenue')} />
            : <div className="dash-card"><div className="ops-empty">Revenue Management is for managers and administrators.</div></div>)}
          {screen === 'site-map' && (current === 'all' && modelIds === null
            ? <LoadingState size="section" label="Loading the site map" minHeight={420} />
            : <Suspense fallback={<LoadingState size="section" label="Loading the site map" minHeight={420} />}><SiteMap facility={single} facilities={facilities} onPick={setPicked} modelIds={modelIds} onMapSearch={setMapSearch} /></Suspense>)}
          {screen === 'pricing' && (
            <Suspense fallback={<LoadingState size="section" label="Loading pricing insights" minHeight={320} />}>
              <PricingInsights facility={single && !isThirdParty(single) ? single : null} onPick={setPicked} onGo={onSubChange} section={view} onSection={onView('pricing')} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}
