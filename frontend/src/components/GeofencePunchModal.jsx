import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, Loader2, Printer } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { formatTimeTz, useDisplayTz } from '../lib/displayTz';

// Geofence Punch view (Charmi, Sep 25 - SwipeClock's "Geofence Punch For
// <name>" screen): one person's In and Out punches for a period on a map,
// each company work site drawn as its fence circle, every punch pinned green
// (inside a fence), red (outside), grey (GPS only / remote) or slashed grey
// (no GPS captured). All Punches / Out of Fence toggle, a site picker that
// recentres the map, and the punch table underneath: Date, GPS, Punch Time,
// Punch Type, Punch Location, Latitude, Longitude, Accuracy. An outside punch
// shows the street address (looked up once, from OpenStreetMap) with the
// nearest site and distance.

const COLORS = { in_fence: '#15803d', out_of_fence: '#dc2626', remote: '#6b7280', low_accuracy: '#6b7280', gps_only: '#6b7280', no_location: '#9ca3af' };
const LABEL = { in_fence: 'Inside geofence', out_of_fence: 'Outside geofence', remote: 'Remote', low_accuracy: 'Low accuracy', no_location: 'No GPS captured' };

function pinSvg(color, slashed) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36"><path d="M13 1C6.4 1 1 6.4 1 13c0 9 12 22 12 22s12-13 12-22C25 6.4 19.6 1 13 1z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="4.5" fill="#fff"/>${slashed ? '<path d="M4 4L22 22" stroke="#dc2626" stroke-width="3"/>' : ''}</svg>`;
}
const iconFor = (status) => L.divIcon({ className: '', html: pinSvg(COLORS[status] || COLORS.no_location, status === 'no_location'), iconSize: [26, 36], iconAnchor: [13, 35], popupAnchor: [0, -30] });

function Pin({ status, size = 14 }) {
  return <span aria-label={LABEL[status] || status} title={LABEL[status] || status} style={{ display: 'inline-block', width: size, height: size * 1.38 }} dangerouslySetInnerHTML={{ __html: pinSvg(COLORS[status] || COLORS.no_location, status === 'no_location').replace('width="26" height="36"', `width="${size}" height="${Math.round(size * 1.38)}"`) }} />;
}

const KIND = { in: 'In', out: 'Out' };
const geoCache = new Map();
async function reverseGeocode(lat, lng) {
  const key = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18`, { headers: { Accept: 'application/json' } });
    const d = await r.json();
    const a = d?.address || {};
    const line = [[a.house_number, a.road].filter(Boolean).join(' '), a.city || a.town || a.village || a.hamlet, a.state, a.postcode].filter(Boolean).join(', ');
    const out = line || d?.display_name || '';
    geoCache.set(key, out);
    return out;
  } catch { geoCache.set(key, ''); return ''; }
}

export default function GeofencePunchModal({ email, name, start, end, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [onlyOut, setOnlyOut] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [addresses, setAddresses] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const tz = useDisplayTz();

  useEffect(() => {
    let alive = true;
    api.timeGeofencePunches(email, start, end)
      .then((d) => { if (!alive) return; setData(d); setSelected(new Set((d.punches || []).map((p) => p.id))); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load the punches.'); });
    return () => { alive = false; };
  }, [email, start, end]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const punches = useMemo(() => (data?.punches || []).filter((p) => !onlyOut || p.geoStatus === 'out_of_fence'), [data, onlyOut]);
  const sites = useMemo(() => data?.sites || [], [data]);

  // Street addresses for outside punches, looked up lazily and cached.
  useEffect(() => {
    const need = (data?.punches || []).filter((p) => p.geoStatus === 'out_of_fence' && p.lat && p.lng && addresses[p.id] === undefined).slice(0, 25);
    if (!need.length) return;
    let alive = true;
    (async () => {
      for (const p of need) {
        const a = await reverseGeocode(p.lat, p.lng);
        if (!alive) return;
        setAddresses((m) => ({ ...m, [p.id]: a }));
      }
    })();
    return () => { alive = false; };
  }, [data, addresses]);

  // The map: tiles, fence circles, punch pins.
  useEffect(() => {
    if (!mapEl.current || !data) return undefined;
    let map = mapRef.current;
    if (!map) {
      map = L.map(mapEl.current, { scrollWheelZoom: true }).setView([33.2, -117.0], 10);
      const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
      const satellite = L.layerGroup([
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
      ]);
      street.addTo(map);
      L.control.layers({ Map: street, Satellite: satellite }, null, { position: 'topleft', collapsed: false }).addTo(map);
      mapRef.current = map;
    }
    if (layerRef.current) layerRef.current.remove();
    const group = L.featureGroup().addTo(map);
    layerRef.current = group;
    const bounds = [];
    for (const s of sites) {
      L.circle([s.lat, s.lng], { radius: s.radiusM, color: '#2563eb', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.18 }).bindTooltip(`${s.name} · ${s.radiusM} m fence`).addTo(group);
      L.circleMarker([s.lat, s.lng], { radius: 3, color: '#1d4ed8', fillColor: '#1d4ed8', fillOpacity: 1 }).addTo(group);
      if (!siteId || siteId === s.id) bounds.push([s.lat, s.lng]);
    }
    for (const p of punches) {
      if (!p.lat || !p.lng || !selected.has(p.id)) continue;
      const lat = Number(p.lat), lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const m = L.marker([lat, lng], { icon: iconFor(p.geoStatus) }).addTo(group);
      const status = p.geoStatus === 'in_fence' ? 'In Fence' : p.geoStatus === 'out_of_fence' ? 'Out of Fence' : LABEL[p.geoStatus] || p.geoStatus;
      m.bindPopup(`<div style="font:12px/1.5 Inter,system-ui"><b>Employee:</b> ${data.name}<br/><b>${p.workSiteName || 'Nearest site'}:</b> ${status}${p.distanceM ? ` (${p.distanceM.toLocaleString('en-US')} m)` : ''}<br/><b>Time:</b> ${formatDate(p.localDate)} ${KIND[p.kind] || p.kind} @ ${formatTimeTz(p.at)}<br/><b>GPS:</b> ${p.lat}, ${p.lng}<br/><b>Accuracy:</b> <span style="color:#2563eb;font-weight:700">${p.accuracyM} m</span></div>`);
      if (p.accuracyM > 0) L.circle([lat, lng], { radius: p.accuracyM, color: COLORS[p.geoStatus] || '#6b7280', weight: 1, fillOpacity: 0.08 }).addTo(group);
      if (!siteId) bounds.push([lat, lng]);
    }
    if (siteId) {
      const s = sites.find((x) => x.id === siteId);
      if (s) map.setView([s.lat, s.lng], 16);
    } else if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    }
    setTimeout(() => map.invalidateSize(), 50);
    return undefined;
  }, [data, punches, sites, siteId, selected, tz]);

  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const outCount = (data?.punches || []).filter((p) => p.geoStatus === 'out_of_fence').length;
  const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, padding: '8px 10px', background: 'var(--bg-secondary, #f3f4f6)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
  const td = { padding: '8px 10px', borderBottom: '1px solid var(--line)', fontSize: 12.5, verticalAlign: 'middle' };
  const btn = (on) => ({ padding: '6px 14px', border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--line)'}`, background: on ? 'var(--wk-brand, #2b45e1)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)', borderRadius: 8, fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer', letterSpacing: '.03em', textTransform: 'uppercase' });

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation" style={{ zIndex: 2000 }}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={`Geofence punches for ${name || email}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 'min(1400px, 97vw)', maxHeight: '94vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header" style={{ padding: '14px 20px 10px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Geofence Punch For {data?.name || name || email}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {start && end ? `${formatDate(start)} - ${formatDate(end)}` : 'All dates'}{data?.remote ? ' · marked Remote (nothing is flagged)' : ''}{data?.assignedSiteId ? ` · assigned to ${sites.find((s) => s.id === data.assignedSiteId)?.name || 'one site'}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={btn(!onlyOut)} onClick={() => setOnlyOut(false)}>All Punches</button>
            <button type="button" style={btn(onlyOut)} onClick={() => setOnlyOut(true)}>Out of Fence{outCount ? ` (${outCount})` : ''}</button>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Work site" style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line)', fontFamily: 'inherit', fontSize: 12.5, background: 'var(--card)', color: 'var(--ink)', minWidth: 200 }}>
              <option value="">All work sites</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.assigned ? ' (assigned)' : ''}</option>)}
            </select>
            <button type="button" onClick={() => window.print()} aria-label="Print" title="Print" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><Printer size={16} /></button>
            <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
        </div>
        <div style={{ padding: '0 20px 16px', overflowY: 'auto' }}>
          {error && <div style={{ color: '#dc2626', fontSize: 13, padding: '10px 0' }}>{error}</div>}
          {!data && !error && <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>}
          <div ref={mapEl} style={{ height: 'min(480px, 48vh)', borderRadius: 10, border: '1px solid var(--line)', display: data ? 'block' : 'none' }} />
          {data && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontSize: 11.5, color: 'var(--muted)', padding: '10px 0' }}>
                {['in_fence', 'out_of_fence', 'remote', 'no_location'].map((k) => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pin status={k} size={11} /> = {LABEL[k]}</span>)}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                  <button type="button" className="secondary-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setSelected(new Set((data.punches || []).map((p) => p.id)))}>Select All</button>
                  <button type="button" className="secondary-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setSelected(new Set())}>Deselect All</button>
                </span>
              </div>
              <div className="req-table-wrapper">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Date</th><th style={{ ...th, width: 34 }} /><th style={{ ...th, width: 40 }}>GPS</th><th style={th}>Punch Time</th><th style={th}>Punch Type</th><th style={th}>Punch Location</th><th style={th}>Latitude</th><th style={th}>Longitude</th><th style={th}>Accuracy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {punches.length === 0 && <tr><td colSpan={9} style={{ ...td, color: 'var(--muted)' }}>No Punches to Display</td></tr>}
                    {punches.map((p) => {
                      const out = p.geoStatus === 'out_of_fence';
                      const rowBg = out ? 'rgba(220,38,38,0.08)' : p.geoStatus === 'in_fence' ? 'rgba(21,128,61,0.08)' : undefined;
                      const where = p.geoStatus === 'in_fence' ? (p.workSiteName || 'Work site')
                        : out ? (addresses[p.id] || (addresses[p.id] === '' ? `${p.distanceM.toLocaleString('en-US')} m from ${p.workSiteName || 'the nearest site'}` : 'Looking up address...'))
                        : p.geoStatus === 'remote' ? 'Remote' : p.geoStatus === 'no_location' ? 'No GPS captured' : (p.workSiteName ? `Near ${p.workSiteName}` : 'GPS only');
                      return (
                        <tr key={p.id} style={{ background: rowBg }}>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{new Date(`${p.localDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                          <td style={td}><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label="Show on map" /></td>
                          <td style={td}><Pin status={p.geoStatus} /></td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatTimeTz(p.at)}</td>
                          <td style={td}>{KIND[p.kind] || p.kind}</td>
                          <td style={{ ...td, maxWidth: 320 }}>{where}{out && addresses[p.id] ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.distanceM.toLocaleString('en-US')} m from {p.workSiteName || 'the nearest site'}</div> : null}</td>
                          <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{p.lat ? Number(p.lat).toFixed(5) : '-'}</td>
                          <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{p.lng ? Number(p.lng).toFixed(5) : '-'}</td>
                          <td style={{ ...td, color: '#2563eb', fontWeight: 700 }}>{p.lat ? `${p.accuracyM}m` : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
