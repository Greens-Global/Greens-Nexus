// Operations > Dashboard > Customer Map (Neil, Oct 21 2026): each Greens
// facility's current customers plotted around it, with 1 / 2 / 3 / 5 / 10 /
// 50 mile rings. The server places the points (ops_customer_geo.py) and sends
// only rounded coordinates with a count - no names, ids or addresses - so a
// dot has nothing personal behind it. Leaflet + OpenStreetMap, like the asset
// portfolio map. Lazy-loaded from FacilityOperations.jsx.
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { isThirdParty } from './thirdParty';
import './customerMap.css';

const RING_MILES = [1, 2, 3, 5, 10, 50];
const DEFAULT_RINGS = [1, 3, 5, 10];
const METERS_PER_MILE = 1609.344;
const COLORS = ['#0f766e', '#2563eb', '#c2410c', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f', '#a16207'];
const RING_KEY = 'nexus.ops.customerMap.rings';

const n = (v) => Number(v || 0).toLocaleString('en-US');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');
const plural = (c, one, many) => `${n(c)} ${c === 1 ? one : many}`;

function readRings() {
  try {
    const saved = JSON.parse(localStorage.getItem(RING_KEY) || 'null');
    if (Array.isArray(saved)) return saved.filter((m) => RING_MILES.includes(m));
  } catch { /* not remembered */ }
  return DEFAULT_RINGS;
}

function MapCanvas({ data, rings, colorOf }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const ringRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let map;
    try {
      map = L.map(elRef.current, { preferCanvas: true, scrollWheelZoom: true }).setView([33.3, -117.1], 9);
    } catch {
      Promise.resolve().then(() => setFailed(true));   // after this effect, not inside it
      return undefined;
    }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    ringRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const t = setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => {
      clearTimeout(t);
      try { map.remove(); } catch { /* already removed */ }
      mapRef.current = null;
    };
  }, []);

  // Customers and facilities; the view fits them when the data changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds = [];
    for (const p of data.points) {
      const color = colorOf(p.facilityId);
      const approx = p.precision === 'zip';
      L.circleMarker([p.lat, p.lng], {
        radius: Math.min(10, 3 + Math.sqrt(p.count) * 1.4),
        color, weight: approx ? 1.5 : 0.5, dashArray: approx ? '3 3' : null,
        fillColor: color, fillOpacity: approx ? 0.12 : 0.55,
      }).addTo(layer).bindTooltip(`${plural(p.count, 'customer', 'customers')}${approx ? ' (ZIP area, approximate)' : ''}`);
      bounds.push([p.lat, p.lng]);
    }
    for (const f of data.facilities) {
      if (f.lat == null || f.lng == null) continue;
      const icon = L.divIcon({ className: 'cm-fac-icon', html: `<span style="background:${colorOf(f.id)}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] });
      L.marker([f.lat, f.lng], { icon, zIndexOffset: 1000, keyboard: false })
        .addTo(layer).bindTooltip(f.shortName || f.name, { direction: 'top', permanent: data.facilities.length <= 6 });
      bounds.push([f.lat, f.lng]);
    }
    if (bounds.length) {
      try { map.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 }); } catch { /* one point is fine */ }
    }
  }, [data, colorOf]);

  useEffect(() => {
    const group = ringRef.current;
    if (!group) return;
    group.clearLayers();
    for (const f of data.facilities) {
      if (f.lat == null || f.lng == null) continue;
      for (const miles of rings) {
        L.circle([f.lat, f.lng], { radius: miles * METERS_PER_MILE, color: colorOf(f.id), weight: 1.5, opacity: 0.8, fill: false, interactive: false })
          .addTo(group);
      }
    }
  }, [data, rings, colorOf]);

  return (
    <div className="cm-map-wrap">
      {failed && <p className="cm-map-failed">The map couldn't load - check your internet connection.</p>}
      <div ref={elRef} className="cm-map" aria-label="Customer map" role="img" />
    </div>
  );
}

export default function CustomerMap({ facility, state = '' }) {
  // TPM stores are not in Cubby, so they have no customers here.
  if (facility && isThirdParty(facility)) {
    return <div className="dash-card"><div className="ops-empty">{facility.shortName || facility.name} is run by another operator, so its customers are not in Cubby. Pick a Greens facility to see its customers.</div></div>;
  }
  return <CustomerMapBody facilityId={facility?.id || 'all'} state={state} />;
}

function CustomerMapBody({ facilityId, state }) {
  const key = `${facilityId}|${state}`;
  // The answer for `key`; another key's answer on hand means this one is loading.
  const [got, setGot] = useState({ key: null, data: null, error: null });
  const [rings, setRingsRaw] = useState(readRings);
  const [tick, setTick] = useState(0);
  const setRings = (next) => {
    setRingsRaw(next);
    try { localStorage.setItem(RING_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  };

  useEffect(() => {
    let on = true;
    api.getOpsCustomerMap({ facility: facilityId, state })
      .then((data) => { if (on) setGot({ key, data, error: null }); })
      .catch((error) => { if (on) setGot((g) => (g.key === key && g.data ? g : { key, data: null, error })); });
    return () => { on = false; };
  }, [facilityId, state, key, tick]);
  const res = got.key !== key ? { status: 'loading' } : got.error ? { status: 'error', error: got.error } : { status: 'ready', data: got.data };

  // While the first placing pass runs, look again every minute.
  const pending = res.data?.total?.pending || 0;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [pending]);

  const colorOf = useMemo(() => {
    const ids = (res.data?.facilities || []).map((f) => f.id);
    return (id) => COLORS[Math.max(0, ids.indexOf(id)) % COLORS.length];
  }, [res.data]);

  if (res.status === 'loading') return <SkeletonBlocks count={2} height={260} />;
  if (res.status === 'error') {
    return (
      <ErrorBanner
        message={res.error?.status === 403 ? 'The Customer Map is for managers and administrators.' : "Couldn't load the customer map."}
        onRetry={() => { setGot({ key: null, data: null, error: null }); setTick((x) => x + 1); }} />
    );
  }

  const data = res.data;
  const total = data.total || { current: 0, placed: 0, zipOnly: 0, missing: 0, pending: 0 };
  const done = total.current - total.pending;
  const toggle = (miles) => setRings(rings.includes(miles) ? rings.filter((m) => m !== miles) : [...rings, miles].sort((a, b) => a - b));

  if (!data.facilities.length) {
    return <div className="dash-card"><div className="ops-empty">No Greens facilities from Cubby to show here.</div></div>;
  }

  return (
    <div className="cm-root">
      <div className="cm-toolbar">
        <div className="cm-rings" role="group" aria-label="Distance Rings">
          <span className="cm-label">Rings</span>
          {RING_MILES.map((m) => (
            <button key={m} type="button" className={`cm-chip${rings.includes(m) ? ' on' : ''}`} aria-pressed={rings.includes(m)} onClick={() => toggle(m)}>
              {m} {m === 1 ? 'Mile' : 'Miles'}
            </button>
          ))}
        </div>
        <div className="cm-legend" aria-label="Legend">
          <span><i className="cm-key-fac" /> Facility</span>
          <span><i className="cm-key-dot" /> Customers (bigger dot = more at one point)</span>
          <span><i className="cm-key-zip" /> ZIP area only (approximate)</span>
        </div>
      </div>

      <p className="ops-note cm-coverage" role="status">
        Showing {n(total.placed)} of {plural(total.current, 'current customer', 'current customers')}
        {total.missing ? ` - ${n(total.missing)} have no usable address in Cubby` : ''}
        {total.zipOnly ? `, ${n(total.zipOnly)} placed by ZIP code only` : ''}.
        {total.pending > 0 && ` Placing customers on the map - ${n(done)} of ${n(total.current)} done.`}
      </p>

      <div className="cm-grid">
        <div className="dash-card cm-map-card">
          {total.placed === 0 && total.pending > 0 ? (
            <div className="ops-empty cm-placing">
              Placing customers on the map - {n(done)} of {n(total.current)} done. Addresses are looked up about one a second, so the first pass takes an hour or two.
            </div>
          ) : (
            <MapCanvas data={data} rings={rings} colorOf={colorOf} />
          )}
        </div>

        <div className="dash-card cm-side">
          <div className="dash-card-title">Customers Within</div>
          <table className="cm-table">
            <thead><tr><th scope="col">Distance</th><th scope="col">Customers</th><th scope="col">Share</th></tr></thead>
            <tbody>
              {data.rings.map((r) => (
                <tr key={r.miles} className={rings.includes(r.miles) ? 'on' : ''}>
                  <td>{r.miles} {r.miles === 1 ? 'Mile' : 'Miles'}</td>
                  <td>{n(r.count)}</td>
                  <td>{pct(r.count, data.placed)}</td>
                </tr>
              ))}
              <tr>
                <td>Beyond 50 Miles</td>
                <td>{n(data.beyond)}</td>
                <td>{pct(data.beyond, data.placed)}</td>
              </tr>
            </tbody>
          </table>
          <p className="cm-hint">
            {facilityId === 'all' && data.facilities.length > 1
              ? 'Each customer is measured from their own facility. '
              : ''}
            Shares are of the {n(data.placed)} customers on the map.
          </p>
          {data.facilities.length > 1 && (
            <ul className="cm-facs">
              {data.facilities.map((f) => {
                const c = data.coverage[f.id] || {};
                return (
                  <li key={f.id}>
                    <i style={{ background: colorOf(f.id) }} />
                    <span>{f.shortName || f.name}</span>
                    <span className="cm-num">{n(c.placed)} of {n(c.current)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <p className="cm-privacy">Points are rounded to about 100 m. Nexus stores no customer addresses.</p>
    </div>
  );
}
