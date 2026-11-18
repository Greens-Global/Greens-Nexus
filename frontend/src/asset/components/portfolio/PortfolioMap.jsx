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
export function PortfolioMap({ assets, openProperty, noun = 'assets' }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const [failed, setFailed] = useState(false);
  // The map drew but its street tiles did not come (offline, a blocked host): say so in a
  // plain line rather than leave a gray box that reads as an empty map.
  const [tilesFailed, setTilesFailed] = useState(false);

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
    let tileErrors = 0;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' })
      .on('tileerror', () => { tileErrors += 1; if (tileErrors >= 3) setTilesFailed(true); })
      .on('tileload', () => { tileErrors = 0; setTilesFailed(false); })
      .addTo(map);
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
    <div className="pt-map">
      <div className="pt-map-line">
        {failed ? (
          <span className="is-red">The map couldn't load - check your internet connection.</span>
        ) : (
          <span>{placed.length === list.length ? `All ${list.length} ${noun} are on the map.` : `${placed.length} of ${list.length} ${noun} are on the map.`}</span>
        )}
        {!failed && tilesFailed && <span className="is-red"> The street map isn't loading, so the pins sit on a blank background.</span>}
      </div>
      <div ref={mapElRef} className="pt-map-canvas" />
      {unplaced.length > 0 && (
        <div className="pt-map-missing">
          <div className="pt-map-missing-head">
            Not on the map yet - {unplaced.some(hasAddress) ? 'a new address is placed within about ten minutes' : 'add a street address or a Google Maps link'}:
          </div>
          <div className="pt-map-missing-list">
            {unplaced.map((a, i) => (
              <span key={a.id}>
                {i > 0 && <span className="pt-sep" aria-hidden="true">·</span>}
                <button type="button" className="pt-link is-ink" onClick={() => openProperty && openProperty(a.id)}
                  title={hasAddress(a) ? (a.geo && a.geo.lat === null ? 'The address could not be placed - check it on the asset' : 'Waiting for the address to be placed') : 'No address on this asset'}>
                  {a.siteName && !a.parentId ? a.siteName : a.name}
                </button>
                <span className="pt-dim">{!hasAddress(a) ? ' (no address)' : a.geo && a.geo.lat === null ? ' (address not found)' : ''}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
