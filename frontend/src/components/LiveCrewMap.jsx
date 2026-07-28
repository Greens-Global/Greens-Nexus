import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api.js';
import EnrolPhone from './EnrolPhone';

// Live location of clocked-in field crews (native app posts pings to /track/*).
// Markers coloured by geofence verdict; click a person to replay today's path.
const STATUS = {
  in_fence:     { color: '#16a34a', label: 'On site' },
  out_of_fence: { color: '#d97706', label: 'Off site' },
  low_accuracy: { color: '#64748b', label: 'Weak GPS' },
  no_location:  { color: '#64748b', label: 'No fix' },
};
const REFRESH_MS = 20000;

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function LiveCrewMap({ toastErr, employees = [] }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const pathRef = useRef(null);
  const [crew, setCrew] = useState(null);
  const [sel, setSel] = useState(null);          // email whose path is drawn
  const [updated, setUpdated] = useState('');
  const [enrol, setEnrol] = useState(false);

  // Create the Leaflet map once (same lifecycle as PortfolioMap).
  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([25.2, 55.3], 3);
    } catch { return; }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    pathRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // container may have measured 0x0 if this tab was hidden at mount
    setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => { try { map.remove(); } catch { /* already gone */ } mapRef.current = null; };
  }, []);

  const load = useCallback(() => {
    api.trackLive()
      .then(r => { setCrew(r.crew || []); setUpdated(new Date().toLocaleTimeString()); })
      .catch(e => { setCrew([]); toastErr && toastErr(e?.message || 'Could not load live locations.'); });
  }, [toastErr]);
  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS); return () => clearInterval(t); }, [load]);

  // Redraw crew markers whenever the live set changes.
  useEffect(() => {
    const map = mapRef.current, layer = markersRef.current;
    if (!map || !layer || !crew) return;
    layer.clearLayers();
    const bounds = [];
    crew.forEach(c => {
      const lat = parseFloat(c.lat), lng = parseFloat(c.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      const st = STATUS[c.geoStatus] || STATUS.no_location;
      L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 2, fillColor: st.color, fillOpacity: 1 })
        .addTo(layer)
        .bindTooltip(`${c.name} · ${st.label}${c.batteryPct >= 0 ? ` · ${c.batteryPct}%` : ''}`, { direction: 'top' })
        .on('click', () => setSel(c.email));
      bounds.push([lat, lng]);
    });
    if (bounds.length && !sel) { try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 }); } catch { /* degenerate */ } }
  }, [crew, sel]);

  // Draw the selected person's breadcrumb for today.
  useEffect(() => {
    const map = mapRef.current, layer = pathRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!sel) return;
    const today = new Date().toISOString().slice(0, 10);
    api.trackPath(sel, today).then(r => {
      const pts = (r.points || [])
        .map(p => [parseFloat(p.lat), parseFloat(p.lng)])
        .filter(([a, b]) => isFinite(a) && isFinite(b));
      if (!pts.length) return;
      L.polyline(pts, { color: '#2563eb', weight: 3, opacity: 0.85 }).addTo(layer);
      pts.forEach(pt => L.circleMarker(pt, { radius: 3, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 1 }).addTo(layer));
      try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 }); } catch { /* single point */ }
    }).catch(() => { /* no path today */ });
  }, [sel]);

  const list = crew || [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
        <strong style={{ color: 'var(--ink)' }}>{list.length}</strong> on shift &amp; tracking
        {updated && <span>· updated {updated}</span>}
        {sel && (
          <button className="secondary-btn" onClick={() => setSel(null)} style={{ fontSize: 12 }}>
            ← Back to all crew
          </button>
        )}
        <button className="secondary-btn" onClick={() => setEnrol(true)} style={{ fontSize: 12 }}>
          + Enrol phone
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', gap: 12 }}>
          {Object.values(STATUS).filter((v, i, a) => a.findIndex(x => x.label === v.label) === i).map(s => (
            <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, display: 'inline-block' }} />{s.label}
            </span>
          ))}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 260px', gap: 12, alignItems: 'start' }}>
        <div ref={mapElRef} style={{ width: '100%', height: 'min(68vh, 620px)', borderRadius: 12,
          border: '1px solid var(--line)', overflow: 'hidden', background: 'var(--card)' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'min(68vh, 620px)', overflowY: 'auto' }}>
          {crew === null ? (
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          ) : list.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 2px' }}>
              No one is clocked in with tracking right now. Crews appear here while they're on shift in the Nexus Fields app.
            </div>
          ) : list.map(c => {
            const st = STATUS[c.geoStatus] || STATUS.no_location;
            const active = sel === c.email;
            return (
              <button key={c.email} onClick={() => setSel(active ? null : c.email)}
                style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${active ? 'var(--wk-brand)' : 'var(--wk-line2)'}`,
                  background: active ? 'var(--wk-brand-tint)' : 'var(--card)', fontFamily: 'var(--wk-font)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>{c.name}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  {st.label}{c.workSiteName ? ` · ${c.workSiteName}` : ''}{c.distanceM ? ` (${c.distanceM} m)` : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {ago(c.at)}{c.batteryPct >= 0 ? ` · battery ${c.batteryPct}%` : ''}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {enrol && <EnrolPhone employees={employees} toastErr={toastErr} onClose={() => setEnrol(false)} />}
    </div>
  );
}
