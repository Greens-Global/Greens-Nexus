import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Users, Search, X } from 'lucide-react';
import { api } from '../api.js';
import { pollWhileVisible } from '../lib/pollWhileVisible';

// Company-wide map of where each person LAST punched from. Pins are the person's
// profile photo, ringed green when they're clocked in. Filter by company /
// department / country (+ on-site, clocked-in, name). Coordinates come from the
// punch itself, so a desktop clusters at ~IP accuracy and a phone is GPS-precise.

const RING = { in: '#16a34a', out: '#94a3b8' };
const fmtAcc = (m) => m >= 1000 ? `±${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}km` : `±${m}m`;
// Status label + color. On-site/off-site come from the geofence verdict; otherwise
// judge by ACCURACY, not geo_status - a punch reads "no_location" whenever there's
// no geofenced site to compare against, even with a pin-perfect phone GPS fix.
function locStatus(p) {
  if (p.geoStatus === 'in_fence') return { color: '#16a34a', label: `On site${p.workSiteName ? ` · ${p.workSiteName}` : ''}` };
  if (p.geoStatus === 'out_of_fence') return { color: '#d97706', label: `Off site${p.workSiteName ? ` · ${p.workSiteName}` : ''}` };
  const a = p.accuracyM || 0;
  if (a > 0 && a <= 100) return { color: '#2563eb', label: `GPS ${fmtAcc(a)}` };       // precise phone/GPS fix
  if (a > 0 && a <= 1000) return { color: '#64748b', label: `Approx. ${fmtAcc(a)}` };
  if (a > 1000) return { color: '#64748b', label: `Approx. ${fmtAcc(a)} (no GPS)` };    // IP/Wi-Fi, no GPS
  return { color: '#64748b', label: 'Located' };
}
const REFRESH_MS = 30000;
const initials = (n) => (n || '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const esc = (s) => String(s || '').replace(/"/g, '&quot;');
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function pinHtml(p, active) {
  const size = active ? 48 : 38;
  const ring = p.clockedIn ? RING.in : RING.out;
  const inner = p.photoUrl
    ? `<img src="${esc(p.photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover"/>`
    : `<div style="width:100%;height:100%;background:#334155;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${Math.round(size / 2.8)}px;font-family:Inter,sans-serif">${initials(p.name)}</div>`;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;border:3px solid ${ring};box-shadow:0 2px 10px rgba(0,0,0,.4);overflow:hidden;background:#fff">${inner}</div>`;
}

export default function Locations({ toastErr }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const markerByEmail = useRef({});
  const [people, setPeople] = useState(null);
  const [sel, setSel] = useState(null);       // focused email
  const [updated, setUpdated] = useState('');
  const [f, setF] = useState({ company: '', department: '', country: '', geo: '', clockedIn: false, q: '' });

  // Create the Leaflet map once.
  useEffect(() => {
    let map;
    try { map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([20, 40], 2); }
    catch { return; }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => { try { map.remove(); } catch { /* gone */ } mapRef.current = null; };
  }, []);

  const load = useCallback(() => {
    api.timeLocations()
      .then(r => { setPeople(r.people || []); setUpdated(new Date().toLocaleTimeString()); })
      .catch(e => { setPeople([]); toastErr && toastErr(e?.message || 'Could not load locations.'); });
  }, [toastErr]);
  useEffect(() => { load(); return pollWhileVisible(load, REFRESH_MS); }, [load]);

  // Deep-link: the timesheet (and elsewhere) can focus a specific person here. The
  // caller stashes the email in sessionStorage before navigating (robust against
  // this view mounting after the event would have fired), and may also dispatch a
  // live event while the view is already open.
  useEffect(() => {
    const stashed = sessionStorage.getItem('nexus:locateEmail');
    if (stashed) { sessionStorage.removeItem('nexus:locateEmail'); setSel(stashed.toLowerCase()); }
    const onLocate = (e) => { const em = e.detail?.email; if (em) setSel(em.toLowerCase()); };
    window.addEventListener('nexus:locate-person', onLocate);
    return () => window.removeEventListener('nexus:locate-person', onLocate);
  }, []);

  const all = people || [];
  const companies = useMemo(() => [...new Map(all.filter(p => p.companyId).map(p => [p.companyId, p.companyName || p.companyId])).entries()], [all]);
  const departments = useMemo(() => [...new Set(all.map(p => p.department).filter(Boolean))].sort(), [all]);
  const countries = useMemo(() => [...new Set(all.map(p => p.country).filter(Boolean))].sort(), [all]);

  const shown = useMemo(() => all.filter(p => {
    if (f.company && p.companyId !== f.company) return false;
    if (f.department && p.department !== f.department) return false;
    if (f.country && p.country !== f.country) return false;
    if (f.geo === 'on' && p.geoStatus !== 'in_fence') return false;
    if (f.geo === 'off' && p.geoStatus !== 'out_of_fence') return false;
    if (f.clockedIn && !p.clockedIn) return false;
    if (f.q && !(`${p.name} ${p.department} ${p.companyName}`.toLowerCase().includes(f.q.toLowerCase()))) return false;
    return true;
  }), [all, f]);

  // Redraw pins on any change to the shown set or selection.
  useEffect(() => {
    const map = mapRef.current, layer = markersRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markerByEmail.current = {};
    const bounds = [];
    shown.forEach(p => {
      const lat = parseFloat(p.lat), lng = parseFloat(p.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      const active = sel === p.email;
      const size = active ? 48 : 38;
      const m = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: pinHtml(p, active), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), zIndexOffset: active ? 1000 : 0 })
        .addTo(layer)
        .bindTooltip(`${p.name}${p.department ? ` · ${p.department}` : ''} · ${locStatus(p).label}`, { direction: 'top', offset: [0, -size / 2] })
        .on('click', () => setSel(p.email));
      markerByEmail.current[p.email] = [lat, lng];
      bounds.push([lat, lng]);
    });
    if (sel && markerByEmail.current[sel]) {
      try { map.setView(markerByEmail.current[sel], Math.max(map.getZoom(), 12), { animate: true }); } catch { /* noop */ }
    } else if (bounds.length) {
      try { map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 }); } catch { /* single/degenerate */ }
    }
  }, [shown, sel]);

  const clearFilters = () => setF({ company: '', department: '', country: '', geo: '', clockedIn: false, q: '' });
  const activeFilters = f.company || f.department || f.country || f.geo || f.clockedIn || f.q;
  const selP = shown.find(p => p.email === sel);

  const selStyle = { fontSize: 12.5, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--wk-line2)', background: 'var(--card)', fontFamily: 'var(--wk-font)', color: 'var(--ink)', maxWidth: 170 };

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><MapPin size={19} /></span>
          <div className="view-title-group">
            <h2 style={{ margin: 0 }}>Locations</h2>
            <p style={{ margin: '2px 0 0' }}>Where each person last punched from</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 12px' }}>
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={14} style={{ position: 'absolute', left: 8, color: 'var(--muted)' }} />
          <input placeholder="Search people" value={f.q} onChange={e => setF(s => ({ ...s, q: e.target.value }))}
            style={{ ...selStyle, paddingLeft: 26, maxWidth: 190 }} />
        </span>
        <select value={f.company} onChange={e => setF(s => ({ ...s, company: e.target.value }))} style={selStyle}>
          <option value="">All companies</option>
          {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={f.department} onChange={e => setF(s => ({ ...s, department: e.target.value }))} style={selStyle}>
          <option value="">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={f.country} onChange={e => setF(s => ({ ...s, country: e.target.value }))} style={selStyle}>
          <option value="">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={f.geo} onChange={e => setF(s => ({ ...s, geo: e.target.value }))} style={selStyle}>
          <option value="">Any site status</option>
          <option value="on">On site</option>
          <option value="off">Off site</option>
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={f.clockedIn} onChange={e => setF(s => ({ ...s, clockedIn: e.target.checked }))} /> Clocked in now
        </label>
        {activeFilters ? <button className="secondary-btn" onClick={clearFilters} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Clear</button> : null}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>{shown.length}</strong> shown{updated ? ` · updated ${updated}` : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 280px', gap: 12, alignItems: 'start' }}>
        <div ref={mapElRef} style={{ width: '100%', height: 'min(72vh, 660px)', borderRadius: 12, border: '1px solid var(--line)', overflow: 'hidden', background: 'var(--card)' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'min(72vh, 660px)', overflowY: 'auto' }}>
          {people === null ? (
            <div style={{ color: 'var(--muted)', fontSize: 13, padding: 8 }}>Loading…</div>
          ) : shown.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 4px', display: 'flex', alignItems: 'center', gap: 7 }}>
              <Users size={15} /> No one matches these filters, or no one has punched with a location yet.
            </div>
          ) : shown.map(p => {
            const active = sel === p.email;
            const g = locStatus(p);
            return (
              <button key={p.email} onClick={() => setSel(active ? null : p.email)}
                style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 10, cursor: 'pointer', display: 'flex', gap: 9, alignItems: 'center',
                  border: `1px solid ${active ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, background: active ? 'var(--wk-brand-tint)' : 'var(--card)', fontFamily: 'var(--wk-font)' }}>
                <span style={{ width: 34, height: 34, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, border: `2px solid ${p.clockedIn ? RING.in : RING.out}`, background: '#334155', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 12 }}>
                  {p.photoUrl ? <img src={p.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(p.name)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[p.department, p.companyName].filter(Boolean).join(' · ') || '—'}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, marginTop: 1 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: g.color }} />
                    <span style={{ color: 'var(--muted)' }}>{g.label} · {ago(p.at)}{p.clockedIn ? ' · on the clock' : ''}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selP && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
          Showing {selP.name}. Pin accuracy ±{selP.accuracyM >= 1000 ? `${(selP.accuracyM / 1000).toFixed(1)} km` : `${selP.accuracyM} m`}
          {selP.accuracyM > 1000 ? ' - this device had no GPS (punch from a phone for a precise fix).' : '.'}
        </div>
      )}
    </div>
  );
}
