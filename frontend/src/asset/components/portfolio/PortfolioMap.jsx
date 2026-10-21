import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { pinFor, hasAddress } from '../../lib/geo.js';

// Continental-US-ish bounding box: with both US and international assets the map
// fits the US pins, so one overseas outlier does not zoom it out to the globe.
const isUSLatLng = ([lat, lng]) => lat >= 15 && lat <= 72 && lng >= -170 && lng <= -50;

/**
 * Portfolio-wide Leaflet + OpenStreetMap view. Every pin is known before the
 * first paint - a coordinate in the asset's Google Maps link, else the point
 * the server geocoded (lib/geo.js pinFor) - so the map opens fitted to the
 * portfolio. Assets with nothing to place are listed under the map by name,
 * each a link to the asset, with the reason.
 */
export function PortfolioMap({ assets, openProperty }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const [failed, setFailed] = useState(false);

  const list = (assets || []).filter((a) => !a.deleted);
  const placed = list.map((a) => [a, pinFor(a)]).filter(([, p]) => p);
  const unplaced = list.filter((a) => !pinFor(a));
  // The map is rebuilt only when the pins change, not on every render of the
  // portfolio (a search keystroke, a background pull) - that snapped the view
  // back and lost the person's pan and zoom.
  const pinKey = placed.map(([a, p]) => a.id + ':' + p.join(',')).join('|');

  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([39.5, -98.35], 4);
    } catch {
      setFailed(true);
      return undefined;
    }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    mapRef.current = map;
    const pinLayer = L.layerGroup().addTo(map);
    const bounds = [];
    const boundsUS = [];
    for (const [asset, latLng] of placed) {
      L.circleMarker(latLng, { radius: 8, color: '#fff', weight: 2, fillColor: '#0f766e', fillOpacity: 1 })
        .addTo(pinLayer)
        .bindTooltip(asset.name || 'Asset', { direction: 'top' })
        .on('click', () => openProperty && openProperty(asset.id));
      bounds.push(latLng);
      if (isUSLatLng(latLng)) boundsUS.push(latLng);
    }
    const use = boundsUS.length ? boundsUS : bounds;
    if (use.length) {
      try { map.fitBounds(use, { padding: [40, 40], maxZoom: 13 }); } catch { /* a single point is fine */ }
    }
    // Leaflet measures its container at creation; mounted inside a hidden tab it
    // measured 0x0, so re-measure once layout has settled.
    const t = setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => {
      clearTimeout(t);
      try { mapRef.current && mapRef.current.remove(); } catch { /* already removed */ }
      mapRef.current = null;
    };
  }, [pinKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, fontSize: '0.78rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
        {failed ? (
          <span style={{ color: 'hsl(var(--color-red))', fontWeight: 600 }}>Map couldn't load - check your internet connection.</span>
        ) : (
          <span><strong style={{ color: 'var(--text-primary)' }}>{placed.length}</strong> of {list.length} assets on the map</span>
        )}
      </div>
      <div ref={mapElRef} style={{ width: '100%', height: 'min(70vh, 640px)', borderRadius: 12, border: '1px solid var(--border-color)', overflow: 'hidden', backgroundColor: 'var(--bg-secondary)' }} />
      {unplaced.length > 0 && (
        <div style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Not on the map yet ({unplaced.length}) - {unplaced.some(hasAddress) ? 'a new address is placed within about ten minutes' : 'add a street address or a Google Maps link'}:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {unplaced.map((a) => (
              <button key={a.id} type="button" className="secondary-btn" onClick={() => openProperty && openProperty(a.id)}
                title={hasAddress(a) ? (a.geo && a.geo.lat === null ? 'The address could not be placed - check it on the asset' : 'Waiting for the address to be placed') : 'No address on this asset'}
                style={{ fontSize: '0.78rem', padding: '5px 10px' }}>
                {a.name}{!hasAddress(a) ? ' · no address' : a.geo && a.geo.lat === null ? ' · address not found' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
