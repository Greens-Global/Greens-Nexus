import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Search, MapPin, AlertTriangle } from 'lucide-react';
import { searchAddresses, metersBetween } from '../lib/addressSearch';
import { Spinner } from './AsyncState';

// Work site location, address first (Pranshu, Sep 30).
//
// 1. Search the address and pick one of up to five matches - the site takes
//    that address, and the map jumps to it in close-up satellite view.
// 2. Fine-tune: an address search lands on the street or the parcel, not
//    always the building people actually punch at, so once an address is
//    chosen the pin can be dragged (or the map clicked) to the exact spot.
//    The address stays the one picked; only the point moves, and the distance
//    from the address point is shown - far away is called out.
// Until an address is chosen the map only shows where things are: a site
// always starts from its address, never from a pin dropped at random.
//
// Same Leaflet Map/Satellite layers as Workforce Analytics -> Locations. The
// pin is an inline-SVG divIcon: Leaflet's default PNG icon 404s under Vite.
const PIN_ICON = L.divIcon({
  className: 'nexus-location-pin',
  html: '<svg width="34" height="34" viewBox="0 0 24 24" fill="hsl(217,91%,50%)" stroke="#fff" stroke-width="1.5"><path d="M12 22s8-7.58 8-13a8 8 0 1 0-16 0c0 5.42 8 13 8 13z"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>',
  iconSize: [34, 34],
  iconAnchor: [17, 33],
});
const FAR_M = 500;   // a pin this far from its address is probably a mistake

const distText = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export default function WorkSiteAddressMap({ lat, lng, radiusM, adjustable = false, onPick, onAdjust }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const onAdjustRef = useRef(onAdjust);
  useEffect(() => { onAdjustRef.current = onAdjust; });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState(null);   // null = not searched yet
  const [error, setError] = useState('');
  const has = lat !== '' && lng !== '' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  const point = has ? [Number(lat), Number(lng)] : null;
  // The address's own point - what a fine-tuned pin is measured against. Set
  // by a pick; a saved site starts from its saved point, framed on open.
  const [anchor, setAnchor] = useState(() => (has ? [Number(lat), Number(lng)] : null));
  const [fitKey, setFitKey] = useState(() => (has ? 1 : 0));   // bump = re-frame the map on the site

  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([33.1, -117.1], 9);
    } catch { return undefined; }
    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
    const hybrid = L.layerGroup([satellite, labels]);
    hybrid.addTo(map);   // satellite: the building is what the pin is placed on
    L.control.layers({ 'Map': street, 'Satellite': hybrid }, {}, { position: 'topright', collapsed: false }).addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => { try { map.remove(); } catch { /* gone */ } mapRef.current = null; markerRef.current = null; circleRef.current = null; };
  }, []);

  // Clicking the map moves the pin there - only once an address is chosen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const onClick = (e) => { if (adjustable) onAdjustRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }); };
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [adjustable]);

  // Draw (or move) the pin and its geofence circle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!point) {
      markerRef.current?.remove(); circleRef.current?.remove();
      markerRef.current = null; circleRef.current = null;
      return;
    }
    const r = Math.max(25, Number(radiusM) || 150);
    if (!circleRef.current) circleRef.current = L.circle(point, { radius: r, color: 'hsl(217,91%,50%)', weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
    else { circleRef.current.setLatLng(point); circleRef.current.setRadius(r); }
    if (!markerRef.current) {
      markerRef.current = L.marker(point, { icon: PIN_ICON, draggable: adjustable, keyboard: false, title: 'Drag to the exact spot' }).addTo(map);
      markerRef.current.on('dragend', () => { const p = markerRef.current.getLatLng(); onAdjustRef.current?.({ lat: p.lat, lng: p.lng }); });
      markerRef.current.on('drag', () => circleRef.current?.setLatLng(markerRef.current.getLatLng()));
    } else {
      markerRef.current.setLatLng(point);
    }
    if (markerRef.current.dragging) {
      if (adjustable) markerRef.current.dragging.enable(); else markerRef.current.dragging.disable();
    }
  }, [lat, lng, radiusM, adjustable]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Frame the site close enough to see the building (on a pick / on open).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !point || !fitKey) return;
    try { map.setView(point, 18); } catch { /* degenerate */ }
  }, [fitKey]);   // eslint-disable-line react-hooks/exhaustive-deps

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
    setAnchor([m.lat, m.lng]);
    setFitKey((k) => k + 1);
    setMatches(null); setQuery('');
  };

  const moved = point && anchor ? metersBetween(anchor, point) : 0;
  const far = moved > FAR_M;

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input className="form-input" style={{ flex: 1, fontSize: 12.5 }} value={query} aria-label="Search the site's address"
          placeholder="Type the full street address, e.g. 25260 N Centre City Pkwy, Escondido, CA 92026"
          onChange={e => { setQuery(e.target.value); setMatches(null); setError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }} />
        <button type="button" className="secondary-btn" onClick={run} disabled={busy || !query.trim()}
          style={{ padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={14} /> : <Search size={14} />} Search
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
                    Approximate - matches the street or area, not the exact building. Drag the pin onto the building after picking it.
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <div ref={mapElRef} aria-label="Map of the work site and its geofence"
        style={{ width: '100%', height: '100%', minHeight: 460, borderRadius: 10, border: '1px solid var(--line)', overflow: 'hidden', position: 'relative', zIndex: 0 }} />
      <p style={{ fontSize: 11, margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 5, color: far ? '#b45309' : 'var(--muted)' }}>
        {!point
          ? <><AlertTriangle size={12} /> Search the address to place this site.</>
          : !adjustable
            ? <>Search the address to confirm this site. The blue circle is the geofence.</>
            : far
              ? <><AlertTriangle size={12} /> The pin is {distText(moved)} from the address - make sure it is on the right building.</>
              : moved >= 5
                ? <>Pin moved {distText(moved)} from the address point. The blue circle is the geofence.</>
                : <>Drag the pin (or click the map) onto the exact building. The blue circle is the geofence.</>}
      </p>
    </div>
  );
}
