import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Search, Loader2 } from 'lucide-react';
import { reverseGeocode, geocodeSearch } from '../asset/lib/geo.js';

// Click-to-pick location map, shared by the Company Setup Overview form
// (fills Registered Address) and the per-company Work Sites form (fills
// address + lat/long) - Sep 18/19, Pranshu. Same Leaflet + OpenStreetMap-tile
// approach as LiveCrewMap/PortfolioMap (no API key), but with a single
// draggable marker plus a text search box instead of a read-only pin set.
// Geocoding goes through lib/geo.js's shared Nominatim rate-limit queue, so
// this can't get the app IP-blocked even alongside other geocode() callers
// elsewhere on the page.
//
// Leaflet's default L.marker icon is a pair of PNGs referenced by a relative
// path baked into its CSS at build time - under Vite that path 404s and the
// pin renders as a broken-image glyph (reported Sep 19). Using a divIcon
// with an inline SVG sidesteps bundling entirely, so there's no asset path
// to get wrong.
const PIN_ICON = L.divIcon({
  className: 'nexus-location-pin',
  html: '<svg width="30" height="30" viewBox="0 0 24 24" fill="hsl(217,91%,50%)" stroke="#fff" stroke-width="1.5"><path d="M12 22s8-7.58 8-13a8 8 0 1 0-16 0c0 5.42 8 13 8 13z"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>',
  iconSize: [30, 30],
  iconAnchor: [15, 29],   // tip of the pin, not its center, marks the actual point
});

export default function LocationPickerMap({ onLocationPicked, initialLatLng, placeholder = 'Search for a place or address…' }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onPickedRef = useRef(onLocationPicked);
  onPickedRef.current = onLocationPicked;
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView(initialLatLng || [20, 0], initialLatLng ? 13 : 2);
    } catch { return; }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);

    const placeMarker = (latlng) => {
      if (markerRef.current) markerRef.current.setLatLng(latlng);
      else markerRef.current = L.marker(latlng, { draggable: true, icon: PIN_ICON }).addTo(map)
        .on('dragend', () => resolveAddress(markerRef.current.getLatLng()));
    };
    const resolveAddress = (latlng) => {
      placeMarker(latlng);
      reverseGeocode(latlng.lat, latlng.lng).then((address) => {
        onPickedRef.current?.(address || '', [latlng.lat, latlng.lng]);
      });
    };
    map.on('click', (e) => resolveAddress(e.latlng));
    if (initialLatLng) placeMarker(initialLatLng);

    return () => { try { map.remove(); } catch { /* already gone */ } mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const hit = await geocodeSearch(q);
      if (!hit) return;
      const [lat, lng] = hit.coord;
      const map = mapRef.current;
      if (!map) return;
      map.setView([lat, lng], 15);
      if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
      else markerRef.current = L.marker([lat, lng], { draggable: true, icon: PIN_ICON }).addTo(map)
        .on('dragend', () => reverseGeocode(markerRef.current.getLatLng().lat, markerRef.current.getLatLng().lng)
          .then((address) => onPickedRef.current?.(address || '', [markerRef.current.getLatLng().lat, markerRef.current.getLatLng().lng])));
      onPickedRef.current?.(hit.address || q, [lat, lng]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          className="form-input" style={{ flex: 1, fontSize: 12.5 }} placeholder={placeholder}
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
        />
        <button type="button" className="secondary-btn" onClick={runSearch} disabled={searching || !query.trim()} style={{ padding: '0 12px', display: 'inline-flex', alignItems: 'center' }}>
          {searching ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={14} />}
        </button>
      </div>
      <div ref={mapElRef} style={{ width: '100%', height: '100%', minHeight: 320, borderRadius: 10, border: '1px solid var(--line)', overflow: 'hidden' }} />
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0' }}>Search, or click/drag the pin on the map.</p>
    </div>
  );
}
