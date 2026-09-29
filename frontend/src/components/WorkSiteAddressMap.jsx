import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Search, Loader2, MapPin, AlertTriangle } from 'lucide-react';
import { searchAddresses } from '../lib/addressSearch';

// Work site location, address first (Pranshu, Sep 30). Replaces the
// click/drag-a-pin picker: a pin dropped by hand was not reliable, and a
// geofence in the wrong place tags every punch there with the wrong site.
// Search the address, pick the right match from the list, and the site takes
// that address's coordinates. The map below only SHOWS the site and its
// geofence circle - it cannot be clicked or dragged.
//
// Same Leaflet Map/Satellite layers as Workforce Analytics -> Locations. The
// pin is an inline-SVG divIcon: Leaflet's default PNG icon 404s under Vite.
const PIN_ICON = L.divIcon({
  className: 'nexus-location-pin',
  html: '<svg width="30" height="30" viewBox="0 0 24 24" fill="hsl(217,91%,50%)" stroke="#fff" stroke-width="1.5"><path d="M12 22s8-7.58 8-13a8 8 0 1 0-16 0c0 5.42 8 13 8 13z"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>',
  iconSize: [30, 30],
  iconAnchor: [15, 29],
});

export default function WorkSiteAddressMap({ lat, lng, radiusM, onPick }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState(null);   // null = not searched yet
  const [error, setError] = useState('');

  const has = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== '' && lng !== '';

  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([33.1, -117.1], 9);
    } catch { return undefined; }
    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
    const hybrid = L.layerGroup([satellite, labels]);
    street.addTo(map);   // street map by default: the address is what is being checked
    L.control.layers({ 'Map': street, 'Satellite': hybrid }, {}, { position: 'topright', collapsed: false }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => { try { map.remove(); } catch { /* gone */ } mapRef.current = null; layerRef.current = null; };
  }, []);

  // Draw the site and its geofence whenever the point or radius changes.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!has) return;
    const p = [Number(lat), Number(lng)];
    const r = Math.max(25, Number(radiusM) || 150);
    L.circle(p, { radius: r, color: 'hsl(217,91%,50%)', weight: 2, fillOpacity: 0.12, interactive: false }).addTo(layer);
    L.marker(p, { icon: PIN_ICON, interactive: false, keyboard: false }).addTo(layer);
    try { map.fitBounds(L.latLng(p).toBounds(r * 2.6), { maxZoom: 17 }); } catch { /* degenerate */ }
  }, [lat, lng, radiusM, has]);

  async function run() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setError('');
    try { setMatches(await searchAddresses(q)); }
    catch { setMatches(null); setError('Could not reach the address search. Check the connection and try again.'); }
    finally { setBusy(false); }
  }

  const pick = (m) => {
    onPick({ address: m.address, lat: m.lat, lng: m.lng });
    setMatches(null); setQuery('');
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input className="form-input" style={{ flex: 1, fontSize: 12.5 }} value={query} aria-label="Search the site's address"
          placeholder="Type the full street address, e.g. 25260 N Centre City Pkwy, Escondido, CA 92026"
          onChange={e => { setQuery(e.target.value); setMatches(null); setError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }} />
        <button type="button" className="secondary-btn" onClick={run} disabled={busy || !query.trim()}
          style={{ padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={14} />} Search
        </button>
      </div>

      {error && <p style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', margin: '0 0 8px' }}>{error}</p>}
      {matches && (
        <div role="listbox" aria-label="Address matches" style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
          {matches.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
              No address found. Check the spelling, or try just the street and ZIP code.
            </div>
          ) : matches.map((m, i) => (
            <button key={`${m.lat},${m.lng},${i}`} type="button" role="option" aria-selected={false} onClick={() => pick(m)}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none',
                borderTop: i ? '1px solid var(--line)' : 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--ink)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--mist)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
              <MapPin size={13} style={{ flexShrink: 0, marginTop: 2, color: m.exact ? 'hsl(var(--color-green))' : '#b45309' }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                {m.address}
                {!m.exact && (
                  <span style={{ display: 'block', fontSize: 11, color: '#b45309', marginTop: 2 }}>
                    Approximate - matches the street or area, not the exact building.
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <div ref={mapElRef} aria-label="Map of the work site and its geofence"
        style={{ width: '100%', height: '100%', minHeight: 460, borderRadius: 10, border: '1px solid var(--line)', overflow: 'hidden', position: 'relative', zIndex: 0 }} />
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 5 }}>
        {has
          ? <>The blue circle is the geofence. Punches inside it count as at this site.</>
          : <><AlertTriangle size={12} /> Search the address to place this site.</>}
      </p>
    </div>
  );
}
