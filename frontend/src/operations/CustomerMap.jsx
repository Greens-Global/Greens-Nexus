// Operations > Dashboard > Customer Map (Neil, Oct 21 2026; trade area
// analysis, Visesh, Oct 22 2026). Where each Greens facility's current
// customers live: a heat map, a hex grid or dots, distance rings, the comp-set
// competitors, and the Trade Area Statistics beside the map. The server
// (ops_customer_geo.build_map) places the points and sends only aggregated
// groups - rounded point, facility, unit kind, tenure bucket, rent band, a
// count and a rent sum - plus the trade area figures for the filtered set, so
// the map and the numbers always agree. Nothing personal is behind a dot.
// Leaflet + OpenStreetMap (grayed so the data is the only color), like the
// asset portfolio map. Lazy-loaded from FacilityOperations.jsx.
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { isThirdParty } from './thirdParty';
import { createHeat, drawCompetitors, drawDots, drawFacilities, drawHexes } from './customerMapLayers';
import {
  COLOR_BY, STATE_NAMES, bandLabel, bucketLabel, decodePoints, legendFor, tradeBounds,
} from './tradeArea';
import './customerMap.css';

const RING_MILES = [1, 2, 3, 5, 10, 50];
const DEFAULT_RINGS = [1, 3, 5, 10];
const RING_KEY = 'nexus.ops.customerMap.rings';
const PREFS_KEY = 'nexus.ops.customerMap.prefs';
const VIEWS = [['heat', 'Heat Map'], ['hex', 'Hex Grid'], ['dots', 'Dots']];
const KIND_OPTIONS = [['all', 'All'], ['storage', 'Self-Storage'], ['vehicle', 'Vehicle/RV']];
const SINCE_OPTIONS = [['all', 'All'], ['90', 'New in Last 90 Days'], ['365', 'New in Last 12 Months']];
const DEFAULT_PREFS = { view: 'heat', colorBy: 'kind', kind: 'all', since: 'all', band: 'all', competitors: true };

const n = (v) => Number(v || 0).toLocaleString('en-US');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');
const plural = (c, one, many) => `${n(c)} ${c === 1 ? one : many}`;
const miles = (v) => (v == null ? '-' : `${Number(v).toFixed(v < 10 ? 1 : 0)} ${v === 1 ? 'mile' : 'miles'}`);

function readRings() {
  try {
    const saved = JSON.parse(localStorage.getItem(RING_KEY) || 'null');
    if (Array.isArray(saved)) return saved.filter((m) => RING_MILES.includes(m));
  } catch { /* not remembered */ }
  return DEFAULT_RINGS;
}

function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      const p = { ...DEFAULT_PREFS, ...saved };
      if (!VIEWS.some(([k]) => k === p.view)) p.view = DEFAULT_PREFS.view;
      if (!COLOR_BY.some((c) => c.key === p.colorBy)) p.colorBy = DEFAULT_PREFS.colorBy;
      if (!KIND_OPTIONS.some(([k]) => k === p.kind)) p.kind = 'all';
      if (!SINCE_OPTIONS.some(([k]) => k === p.since)) p.since = 'all';
      if (!['all', '0', '1', '2', '3'].includes(String(p.band))) p.band = 'all';
      return p;
    }
  } catch { /* not remembered */ }
  return DEFAULT_PREFS;
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="cm-seg" role="group" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} type="button" className={value === k ? 'on' : ''} aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

function Pick({ label, value, options, onChange }) {
  return (
    <label className="cm-pick">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map(([k, text]) => <option key={k} value={k}>{text}</option>)}
      </select>
    </label>
  );
}

// ── The map ───────────────────────────────────────────────────────────────────
function MapCanvas({ data, points, view, colorBy, rings, showCompetitors, fitKey, resetTick }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layers = useRef({});
  const fitted = useRef('');
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [hexLegend, setHexLegend] = useState([]);

  useEffect(() => {
    let map;
    try {
      map = L.map(elRef.current, { preferCanvas: true, scrollWheelZoom: true }).setView([33.3, -117.1], 9);
    } catch {
      Promise.resolve().then(() => setFailed(true));   // after this effect, not inside it
      return undefined;
    }
    // Gray tiles (CSS filter on this layer only) so the data is the only color.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap', className: 'cm-tiles' }).addTo(map);
    let heat = null;
    try { heat = createHeat(map); } catch { heat = null; }
    layers.current = {
      data: L.layerGroup().addTo(map), facs: L.layerGroup().addTo(map), comps: L.layerGroup().addTo(map), heat,
    };
    mapRef.current = map;
    const onZoom = () => setZoom(map.getZoom());
    map.on('zoomend', onZoom);
    const t = setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => {
      clearTimeout(t);
      try { heat?.destroy(); } catch { /* gone */ }
      try { map.remove(); } catch { /* already removed */ }
      mapRef.current = null;
      fitted.current = '';
    };
  }, []);

  // Default view: the trade area (where ~90% of the customers live), set when
  // the facility changes or on Reset View - a filter keeps the person's view.
  useEffect(() => {
    const map = mapRef.current;
    const want = `${fitKey}|${resetTick}`;
    if (!map || fitted.current === want) return;
    const bounds = tradeBounds(points, data.facilities, data.greens);
    if (!bounds) return;
    fitted.current = want;
    try { map.fitBounds(bounds, { padding: [56, 56], maxZoom: 14 }); } catch { /* one point is fine */ }
  }, [points, data, fitKey, resetTick]);

  useEffect(() => {
    const map = mapRef.current;
    const { data: layer, heat } = layers.current;
    if (!map || !layer) return;
    try {
      if (view === 'heat') {
        layer.clearLayers();
        heat?.set(points);
      } else {
        heat?.set([]);
        if (view === 'hex') setHexLegend(drawHexes(layer, map, points) || []);
        else drawDots(layer, map, points, colorBy);
      }
    } catch { /* a drawing hiccup must not blank the screen */ }
  }, [points, view, colorBy, zoom]);

  useEffect(() => {
    const layer = layers.current.facs;
    if (!layer) return;
    const shown = new Set(data.facilities.map((f) => f.id));
    const ringCounts = Object.fromEntries(Object.entries(data.byFacility || {}).map(([id, s]) => [id, s.rings || []]));
    drawFacilities(layer, {
      facilities: data.facilities, others: (data.greens || []).filter((g) => !shown.has(g.id)),
      rings, ringCounts, labelRings: data.facilities.length <= 2,
    });
  }, [data, rings]);

  useEffect(() => {
    const layer = layers.current.comps;
    if (!layer) return;
    drawCompetitors(layer, showCompetitors ? data.competitors || [] : []);
  }, [data, showCompetitors]);

  const legend = view === 'dots' ? legendFor(colorBy, points, data.rentBands) : null;
  return (
    <div className="cm-map-wrap">
      {failed && <p className="cm-map-failed">The map couldn&apos;t load - check your internet connection.</p>}
      <div ref={elRef} className="cm-map" aria-label="Customer map" role="img" />
      <div className="cm-legend" aria-label="Legend">
        {view === 'heat' && (
          <>
            <span className="cm-legend-title">Customer Density</span>
            <span className="cm-heat-scale"><i /><em>Fewer</em><em>More</em></span>
          </>
        )}
        {view === 'hex' && (
          <>
            <span className="cm-legend-title">Customers per Hexagon</span>
            {hexLegend.map((c) => (
              <span key={c.max}><i style={{ background: c.color }} />{c.min === c.max ? n(c.max) : `${n(c.min)}-${n(c.max)}`}</span>
            ))}
          </>
        )}
        {legend && (
          <>
            <span className="cm-legend-title">{COLOR_BY.find((c) => c.key === colorBy)?.label}</span>
            {legend.map((x) => <span key={x.label}><i style={{ background: x.color }} />{x.label}</span>)}
            <span><i className="cm-key-cluster" />Group (zoom in to split)</span>
            <span><i className="cm-key-zip" />ZIP Area Only</span>
          </>
        )}
        <span className="cm-legend-keys">
          <span><i className="cm-key-fac" />Greens Store</span>
          {showCompetitors && (data.competitors || []).length > 0 && <span><i className="cm-key-comp" />Competitor</span>}
        </span>
      </div>
    </div>
  );
}

// ── Trade Area Statistics ─────────────────────────────────────────────────────
function DistanceChart({ buckets, total }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="cm-dist" role="table" aria-label="Distance Distribution">
      {buckets.map((b) => (
        <div className="cm-dist-row" role="row" key={bucketLabel(b)}>
          <span role="cell" className="cm-dist-l">{bucketLabel(b)}</span>
          <span role="cell" className="cm-dist-bar" aria-hidden="true"><i style={{ width: `${(b.count / max) * 100}%` }} /></span>
          <span role="cell" className="cm-dist-n">{n(b.count)}</span>
          <span role="cell" className="cm-dist-p">{pct(b.count, total)}</span>
        </div>
      ))}
    </div>
  );
}

function StatsPanel({ data, onShowOverlap }) {
  const st = data.stats || {};
  const total = st.customers || 0;
  const r = st.radii || {};
  const many = data.facilities.length > 1;
  const name = (id) => data.facilities.find((f) => f.id === id)?.shortName || '';
  const overlaps = Object.entries(data.byFacility || {}).flatMap(([id, s]) => (s.closer || []).map((c) => ({ from: id, ...c })));
  return (
    <div className="cm-side">
      <div className="dash-card cm-stat-card">
        <div className="dash-card-title">Trade Area Statistics</div>
        {total === 0 ? (
          <p className="ops-empty cm-none">No customers on the map match these filters.</p>
        ) : (
          <>
            <p className="cm-headline"><b>80%</b> of customers live within <b>{miles(r['80'])}</b></p>
            <div className="cm-tiles">
              <div><span>50% Within</span><b>{miles(r['50'])}</b></div>
              <div><span>90% Within</span><b>{miles(r['90'])}</b></div>
              <div><span>Median Distance</span><b>{miles(st.median)}</b></div>
              <div><span>Average (Within 50 Mi)</span><b>{miles(st.mean)}</b></div>
            </div>
            <div className="cm-sub">Distance Distribution</div>
            <DistanceChart buckets={st.buckets || []} total={total} />
            <p className="cm-hint">
              {many ? 'Each customer is measured from their own facility. ' : ''}
              Of the {plural(total, 'customer', 'customers')} on the map.
            </p>
          </>
        )}
      </div>

      <div className="dash-card cm-stat-card">
        <div className="dash-card-title">Outside 50 Miles</div>
        <p className="cm-big">{n(st.outside50?.count)}</p>
        <p className="cm-hint">{st.outside50?.count ? 'Customers living more than 50 miles from their facility - left out of the default view.' : 'Every customer on the map lives within 50 miles.'}</p>
        {(st.outside50?.regions || []).length > 0 && (
          <ul className="cm-list">
            {st.outside50.regions.map((g) => <li key={g.state}><span>{STATE_NAMES[g.state] || g.state}</span><b>{n(g.count)}</b></li>)}
          </ul>
        )}
      </div>

      {st.competitorsWithin && (
        <div className="dash-card cm-stat-card">
          <div className="dash-card-title">Competitors Within</div>
          <div className="cm-tiles cm-tiles-3">
            {['3', '5', '10'].map((k) => <div key={k}><span>{k} Miles</span><b>{n(st.competitorsWithin[k])}</b></div>)}
          </div>
          <p className="cm-hint">{many ? 'Of the nearest shown store. ' : ''}From the Rate Management comp sets; competitors without a map position are left out.</p>
        </div>
      )}

      <div className="dash-card cm-stat-card">
        <div className="dash-card-title">Overlap Between Greens Stores</div>
        {overlaps.length === 0 ? (
          <p className="cm-hint">Every customer here lives closest to the store they rent at.</p>
        ) : (
          <>
            <ul className="cm-list">
              {overlaps.slice(0, 8).map((o) => (
                <li key={`${o.from}|${o.facilityId}`}>
                  <span>{many ? `${name(o.from)}: ` : ''}{plural(o.count, 'customer lives', 'customers live')} closer to {o.shortName}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="cm-link" onClick={onShowOverlap}>Show on Map</button>
          </>
        )}
      </div>
    </div>
  );
}

function Comparison({ data }) {
  const rows = data.facilities.map((f) => ({ f, s: data.byFacility?.[f.id] || {} })).filter((x) => x.s.customers);
  if (rows.length < 2) return null;
  const by80 = rows.filter((x) => x.s.radii?.['80']).sort((a, b) => b.s.radii['80'] - a.s.radii['80']);
  const far = by80[0]; const near = by80[by80.length - 1];
  const ratio = far && near && near.s.radii['80'] ? far.s.radii['80'] / near.s.radii['80'] : 0;
  return (
    <div className="dash-card cm-compare">
      <div className="dash-card-title">Facility Comparison</div>
      {ratio >= 1.5 && (
        <p className="cm-hint">{far.f.shortName} draws from {ratio.toFixed(1)}x as far as {near.f.shortName} (80% of customers within {miles(far.s.radii['80'])} vs {miles(near.s.radii['80'])}).</p>
      )}
      <div className="cm-table-scroll">
        <table className="cm-table">
          <thead>
            <tr>
              <th scope="col">Facility</th><th scope="col">Customers</th><th scope="col">50% Within</th>
              <th scope="col">80% Within</th><th scope="col">90% Within</th><th scope="col">Median</th>
              <th scope="col">Vehicle/RV</th><th scope="col">Closer to Another Store</th><th scope="col">Competitors Within 5 Mi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f, s }) => (
              <tr key={f.id}>
                <td>{f.shortName || f.name}</td>
                <td>{n(s.customers)}</td>
                <td>{miles(s.radii?.['50'])}</td>
                <td>{miles(s.radii?.['80'])}</td>
                <td>{miles(s.radii?.['90'])}</td>
                <td>{miles(s.median)}</td>
                <td>{s.vehiclePct == null ? '-' : `${s.vehiclePct}%`}</td>
                <td>{n((s.closer || []).reduce((t, c) => t + c.count, 0))}</td>
                <td>{s.competitorsWithin ? n(s.competitorsWithin['5']) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── The screen ────────────────────────────────────────────────────────────────
export default function CustomerMap({ facility, state = '' }) {
  // TPM stores are not in Cubby, so they have no customers here.
  if (facility && isThirdParty(facility)) {
    return <div className="dash-card"><div className="ops-empty">{facility.shortName || facility.name} is run by another operator, so its customers are not in Cubby. Pick a Greens facility to see its customers.</div></div>;
  }
  return <CustomerMapBody facilityId={facility?.id || 'all'} state={state} />;
}

function CustomerMapBody({ facilityId, state }) {
  const [prefs, setPrefsRaw] = useState(readPrefs);
  const [rings, setRingsRaw] = useState(readRings);
  const [tick, setTick] = useState(0);
  const [resetTick, setResetTick] = useState(0);
  const setRings = (next) => {
    setRingsRaw(next);
    try { localStorage.setItem(RING_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  };
  const setPrefs = (patch) => setPrefsRaw((p) => {
    const next = { ...p, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
    return next;
  });

  const { kind, since, band } = prefs;
  const base = `${facilityId}|${state}`;
  const key = `${base}|${kind}|${since}|${band}`;
  // The answer for `key`. Another filter's answer for the same facility stays
  // on screen while the new one loads; a different facility shows a skeleton.
  const [got, setGot] = useState({ key: null, base: null, data: null, error: null });
  useEffect(() => {
    let on = true;
    api.getOpsCustomerMap({ facility: facilityId, state, kind, since, band })
      .then((data) => { if (on) setGot({ key, base, data, error: null }); })
      .catch((error) => { if (on) setGot((g) => (g.key === key && g.data ? g : { key, base, data: null, error })); });
    return () => { on = false; };
  }, [facilityId, state, kind, since, band, key, base, tick]);
  const res = got.key === key && got.error ? { status: 'error', error: got.error }
    : got.base === base && got.data ? { status: 'ready', data: got.data, refreshing: got.key !== key }
      : { status: 'loading' };

  // While the first placing pass runs, look again every minute.
  const pending = res.data?.total?.pending || 0;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [pending]);

  const points = useMemo(() => decodePoints(res.data), [res.data]);

  if (res.status === 'loading') return <SkeletonBlocks count={2} height={260} />;
  if (res.status === 'error') {
    return (
      <ErrorBanner
        message={res.error?.status === 403 ? 'The Customer Map is for managers and administrators.' : "Couldn't load the customer map."}
        onRetry={() => { setGot({ key: null, base: null, data: null, error: null }); setTick((x) => x + 1); }} />
    );
  }

  const data = res.data;
  const total = data.total || { current: 0, placed: 0, zipOnly: 0, missing: 0, pending: 0 };
  const done = total.current - total.pending;
  const toggle = (m) => setRings(rings.includes(m) ? rings.filter((x) => x !== m) : [...rings, m].sort((a, b) => a - b));
  const bandOptions = [['all', 'All'], ...(data.rentBands || []).map((b) => [String(b.band), bandLabel(b)])];
  const filtered = kind !== 'all' || since !== 'all' || band !== 'all';

  if (!data.facilities.length) {
    return <div className="dash-card"><div className="ops-empty">No Greens facilities from Cubby to show here.</div></div>;
  }

  return (
    <div className="cm-root">
      <div className="cm-toolbar">
        <Segmented label="Map View" options={VIEWS} value={prefs.view} onChange={(view) => setPrefs({ view })} />
        {prefs.view === 'dots' && (
          <Pick label="Color By" value={prefs.colorBy} options={COLOR_BY.map((c) => [c.key, c.label])} onChange={(colorBy) => setPrefs({ colorBy })} />
        )}
        <Pick label="Unit Kind" value={kind} options={KIND_OPTIONS} onChange={(v) => setPrefs({ kind: v })} />
        <Pick label="Customers" value={since} options={SINCE_OPTIONS} onChange={(v) => setPrefs({ since: v })} />
        {bandOptions.length > 1 && <Pick label="Rent Band" value={band} options={bandOptions} onChange={(v) => setPrefs({ band: v })} />}
        {filtered && <button type="button" className="cm-link" onClick={() => setPrefs({ kind: 'all', since: 'all', band: 'all' })}>Clear Filters</button>}
        {res.refreshing && <span className="cm-updating" role="status">Updating...</span>}
      </div>
      <div className="cm-toolbar">
        <div className="cm-rings" role="group" aria-label="Distance Rings">
          <span className="cm-label">Rings</span>
          {RING_MILES.map((m) => (
            <button key={m} type="button" className={`cm-chip${rings.includes(m) ? ' on' : ''}`} aria-pressed={rings.includes(m)} onClick={() => toggle(m)}>
              {m} {m === 1 ? 'Mile' : 'Miles'}
            </button>
          ))}
        </div>
        <div className="cm-rings">
          {(data.competitors || []).length > 0 && (
            <button type="button" className={`cm-chip${prefs.competitors ? ' on' : ''}`} aria-pressed={prefs.competitors}
              onClick={() => setPrefs({ competitors: !prefs.competitors })}>
              Competitors ({n(data.competitors.length)})
            </button>
          )}
          <button type="button" className="cm-chip" onClick={() => setResetTick((x) => x + 1)}>Reset View</button>
        </div>
      </div>

      <p className="ops-note cm-coverage">
        Showing {n(total.placed)} of {plural(total.current, 'current customer', 'current customers')}
        {total.missing ? ` - ${n(total.missing)} have no usable address in Cubby` : ''}
        {total.zipOnly ? `, ${n(total.zipOnly)} placed by ZIP code only` : ''}.
        {total.pending > 0 && ` Placing customers on the map - ${n(done)} of ${n(total.current)} done.`}
        {filtered && ` Filters on: ${n(data.stats?.customers)} match.`}
      </p>

      <div className="cm-grid">
        <div className="dash-card cm-map-card">
          {total.placed === 0 && total.pending > 0 ? (
            <div className="ops-empty cm-placing">
              Placing customers on the map - {n(done)} of {n(total.current)} done. Addresses are looked up about one a second, so the first pass takes an hour or two.
            </div>
          ) : (
            <MapCanvas data={data} points={points} view={prefs.view} colorBy={prefs.colorBy} rings={rings}
              showCompetitors={prefs.competitors} fitKey={base} resetTick={resetTick} />
          )}
        </div>
        <StatsPanel data={data} onShowOverlap={() => setPrefs({ view: 'dots', colorBy: 'overlap' })} />
      </div>

      {facilityId === 'all' && <Comparison data={data} />}

      <p className="cm-privacy">Points are rounded to about 100 m and grouped; hover figures are totals and averages. Nexus stores no customer addresses.</p>
    </div>
  );
}
