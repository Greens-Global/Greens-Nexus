// Operations - the storage facilities, read from Cubby (Oct 2026).
//
// Replaces the mock FMS / Reputation / Site Staff tabs. Nothing here is typed
// in: every figure comes from GET /facility-ops/summary, which reads Cubby.
// One fetch feeds all four tabs and the facility picker, so switching either
// is instant. Nexus only reads - payments, leases and tenant edits stay in
// Cubby, and each tenant row links there.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, HandCoins, Warehouse, ListChecks, Scale, FileSpreadsheet, RefreshCw } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { combine, PERIODS, periodRange } from '../operations/model';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { Overview, Collections, Units, Worklist } from '../operations/OpsTabs';
import Market from '../operations/Market';
import Reports from '../operations/Reports';
import Lookup from '../operations/Lookup';
import '../operations/ops.css';

const TABS = [
  { key: 'overview',    label: 'Overview',        Icon: LayoutDashboard },
  { key: 'collections', label: 'Collections',     Icon: HandCoins },
  { key: 'units',       label: 'Units & Pricing', Icon: Warehouse },
  { key: 'worklist',    label: 'Worklist',        Icon: ListChecks },
  { key: 'market',      label: 'Market Rates',    Icon: Scale },
  { key: 'reports',     label: 'Reports',         Icon: FileSpreadsheet },
];
// Market Rates keeps its own records and compares one facility at a time, so
// the period and the "as of today" note do not apply to it.
const TAB_KEYS = new Set(TABS.map((t) => t.key));

export default function FacilityOperations({ activeSub, onSubChange }) {
  // The old mock tab ids (fms, reputation, site-staff) may still be bookmarked.
  const sub = TAB_KEYS.has(activeSub) ? activeSub : 'overview';
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const [picked, setPicked] = useState('all');
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
  // Stay current without Refresh: re-read every 5 minutes while the tab is in
  // view (the server re-reads Cubby on its own every 15). Quiet - the figures
  // on screen stay put until the new ones arrive.
  useEffect(() => pollWhileVisible(() => load(), 5 * 60 * 1000), [load]);

  const facilities = useMemo(() => state.data?.facilities || [], [state.data]);
  const scope = useMemo(
    () => (picked === 'all' ? facilities : facilities.filter((f) => f.id === picked)),
    [facilities, picked],
  );
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
      <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />

      <div className="view-header">
        <div className="view-title-group">
          <h2>Operations</h2>
          <p>
            {state.data
              ? `${state.data.organization || 'Storage facilities'} - ${facilities.length} facilities - from Cubby as of ${formatDateTime(state.data.fetchedAt)}, updates automatically`
              : 'Storage facility figures from Cubby'}
          </p>
        </div>
        {state.data && (
          <button type="button" className="secondary-btn" onClick={() => load(true)} disabled={refreshing}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {state.status === 'loading' && <LoadingState size="view" label="Reading the facilities from Cubby" minHeight={320} onRetry={() => load()} />}

      {state.status === 'error' && (
        <ErrorBanner
          message={state.error?.status === 503
            ? 'Cubby is not connected yet. An administrator needs to add the Cubby API key.'
            : "Couldn't load the facility figures from Cubby."}
          onRetry={() => load()} />
      )}

      {state.status === 'ready' && !facilities.length && (
        <div className="dash-card"><div className="ops-empty">Cubby returned no facilities for this account.</div></div>
      )}

      {state.status === 'ready' && facilities.length > 0 && (
        <div className="ops-root">
          <div className="ops-bar-top">
            <div className="ops-pills" role="group" aria-label="Facility">
              <button type="button" className="ops-pill" aria-pressed={picked === 'all'} onClick={() => setPicked('all')}>All Facilities</button>
              {facilities.map((f) => (
                <button type="button" key={f.id} className="ops-pill" aria-pressed={picked === f.id} onClick={() => setPicked(f.id)}>{f.shortName}</button>
              ))}
            </div>
            <div className="ops-bar-right">
              <Lookup />
              {sub !== 'market' && (
                <label className="ops-period">
                  <span>Period</span>
                  <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                    {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
          {sub !== 'market' && (
            <p className="ops-note">
              Occupancy, rent and balances are as of today. Move-ins, collections and failed payments cover {range.label.toLowerCase()} ({formatDate(range.from)} - {formatDate(range.to)}).
            </p>
          )}

          {sub === 'overview' && <Overview data={data} facilities={facilities} scope={scope} many={many} range={range} focus={focus} go={go} onPick={setPicked} onJump={jump} />}
          {sub === 'collections' && <Collections data={data} scope={scope} trend={state.data.trend} many={many} range={range} focus={focus} go={go} />}
          {sub === 'units' && <Units data={data} many={many} focus={focus} go={go} />}
          {sub === 'worklist' && <Worklist data={data} many={many} focus={focus} go={go} />}
          {sub === 'market' && <Market facility={scope.length === 1 ? scope[0] : null} facilities={facilities} onPick={setPicked} />}
          {sub === 'reports' && <Reports data={data} facilities={facilities} scope={scope} range={range} />}
        </div>
      )}
    </div>
  );
}
