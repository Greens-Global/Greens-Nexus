import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { reverseGeocode } from '../asset/lib/geo.js';

// Click-to-pick location map for the Company Setup Overview form (Sep 18,
// Pranshu: "Map...from where we can zoom me in select th location and that
// location should get added...in Registered Address field"). Same
// Leaflet + OpenStreetMap-tile approach as LiveCrewMap/PortfolioMap (no API
// key), but with a single draggable marker instead of a read-only pin set.
// Reverse geocoding goes through lib/geo.js's shared Nominatim rate-limit
// queue, so this can't get the app IP-blocked even if paired with other
// geocode() callers elsewhere on the page.
export default function LocationPickerMap({ onAddressPicked }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onPickedRef = useRef(onAddressPicked);
  onPickedRef.current = onAddressPicked;

  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([20, 0], 2);
    } catch { return; }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);

    const placeMarker = (latlng) => {
      if (markerRef.current) markerRef.current.setLatLng(latlng);
      else markerRef.current = L.marker(latlng, { draggable: true }).addTo(map)
        .on('dragend', () => resolveAddress(markerRef.current.getLatLng()));
    };
    const resolveAddress = (latlng) => {
      placeMarker(latlng);
      reverseGeocode(latlng.lat, latlng.lng).then((address) => {
        if (address) onPickedRef.current?.(address, [latlng.lat, latlng.lng]);
      });
    };
    map.on('click', (e) => resolveAddress(e.latlng));

    return () => { try { map.remove(); } catch { /* already gone */ } mapRef.current = null; markerRef.current = null; };
  }, []);

  return (
    <div>
      <div ref={mapElRef} style={{ width: '100%', height: '100%', minHeight: 320, borderRadius: 10, border: '1px solid var(--line)', overflow: 'hidden' }} />
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0' }}>Click or drag the pin to fill in the registered address.</p>
    </div>
  );
}
