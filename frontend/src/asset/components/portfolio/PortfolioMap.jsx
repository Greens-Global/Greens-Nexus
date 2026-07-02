import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { geocode, coordFromUrl } from '../../lib/geo.js';
import { snapMap } from '../../lib/format.js';

// Continental-US-ish bounding box, used only to prefer fitting the map to US pins when the
// portfolio has both US and international assets (so a single overseas outlier doesn't zoom
// the map out to the whole globe). Falls back to fitting every pin if there are no US ones.
const isUSLatLng = ([lat, lng]) => lat >= 15 && lat <= 72 && lng >= -170 && lng <= -50;

/**
 * Portfolio-wide Leaflet + OpenStreetMap view: drops a pin for every non-deleted asset and
 * fits the map to bounds. Assets with a usable Google Maps link get an exact pin instantly
 * (parsed client-side via coordFromUrl, no network call); everything else is geocoded from
 * its address, one at a time, through the rate-limited Nominatim queue in lib/geo.js.
 */
export function PortfolioMap({ assets, openProperty }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState({ phase: 'loading', placed: 0, total: 0, noAddress: 0 });

  useEffect(() => {
    let cancelled = false;
    const list = (assets || []).filter((a) => !a.deleted);
    setStatus({ phase: 'loading', placed: 0, total: list.length, noAddress: 0 });

    // The original build loaded Leaflet from a CDN at runtime here and could fail if the
    // browser had no network access; L.map() can still throw defensively (e.g. detached
    // container), so this stays guarded and surfaces the same "couldn't load" status.
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([39.5, -98.35], 4);
    } catch {
      setStatus((s) => ({ ...s, phase: 'err' }));
      return;
    }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    mapRef.current = map;
    const pinLayer = L.layerGroup().addTo(map);

    // Leaflet sizes itself from the container's dimensions at creation time; if this view
    // was mounted while its tab/panel was hidden (display:none), it'll have measured 0x0.
    // Re-measuring once on a short delay, after layout has settled, fixes that.
    setTimeout(() => {
      try {
        map.invalidateSize();
      } catch {
        // map may already be torn down
      }
    }, 120);

    setStatus((s) => ({ ...s, phase: 'ready' }));

    const boundsUS = [];
    const boundsAll = [];
    const fitToBounds = () => {
      const use = boundsUS.length ? boundsUS : boundsAll;
      if (!use.length) return;
      try {
        map.fitBounds(use, { padding: [40, 40], maxZoom: 13 });
      } catch {
        // bounds can be degenerate (e.g. a single point) — fitBounds is best-effort
      }
    };

    const addPin = (asset, latLng) => {
      if (cancelled) return;
      L.circleMarker(latLng, { radius: 8, color: '#fff', weight: 2, fillColor: '#0f766e', fillOpacity: 1 })
        .addTo(pinLayer)
        .bindTooltip(asset.name || 'Asset', { direction: 'top' })
        .on('click', () => openProperty && openProperty(asset.id));
      boundsAll.push(latLng);
      if (isUSLatLng(latLng)) boundsUS.push(latLng);
      setStatus((s) => ({ ...s, placed: s.placed + 1 }));
    };

    // First pass, synchronous: place every asset that already has an exact pin available
    // (a pasted Google Maps link with coordinates) and build the queue of everything else
    // that needs a real geocode lookup.
    const geocodeQueue = [];
    list.forEach((asset) => {
      const linkedCoord = coordFromUrl(asset.mapUrl || snapMap(asset)['google maps link']);
      if (linkedCoord) {
        addPin(asset, linkedCoord);
        return;
      }
      const address = [asset.address, asset.city, asset.state, asset.country].filter(Boolean).join(', ');
      if (!address || !(asset.address || asset.city)) {
        setStatus((s) => ({ ...s, noAddress: s.noAddress + 1 }));
        return;
      }
      geocodeQueue.push([asset, address]);
    });
    fitToBounds();

    // Second pass, async: work through the geocode queue one address at a time. geocode()
    // itself is globally rate-limited (see lib/geo.js), so this just needs to wait for each
    // lookup to resolve before starting the next — no additional delay needed here.
    const processQueue = (i) => {
      if (cancelled || i >= geocodeQueue.length) {
        fitToBounds();
        setStatus((s) => ({ ...s, phase: 'done' }));
        return;
      }
      const [asset, address] = geocodeQueue[i];
      setStatus((s) => ({ ...s, phase: 'geocoding' }));
      geocode(address).then((latLng) => {
        if (cancelled) return;
        if (latLng) addPin(asset, latLng);
        else setStatus((s) => ({ ...s, noAddress: s.noAddress + 1 }));
        processQueue(i + 1);
      });
    };
    processQueue(0);

    return () => {
      cancelled = true;
      try {
        mapRef.current && mapRef.current.remove();
      } catch {
        // already removed
      }
      mapRef.current = null;
    };
  }, [assets]);

  const statusLine =
    status.phase === 'err' ? (
      <span style={{ color: 'hsl(var(--color-red))', fontWeight: 600 }}>
        Map couldn't load — check your internet connection.
      </span>
    ) : (
      <span>
        <strong style={{ color: 'var(--text-primary)' }}>{status.placed}</strong> of {status.total} assets on the map
        {status.phase === 'geocoding' ? ' · locating addresses…' : ''}
        {status.noAddress ? ` · ${status.noAddress} without a mappable address` : ''}
      </span>
    );

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10,
          fontSize: '0.78rem',
          color: 'var(--text-secondary)',
          flexWrap: 'wrap',
        }}
      >
        {statusLine}
      </div>
      <div
        ref={mapElRef}
        style={{
          width: '100%',
          height: 'min(70vh, 640px)',
          borderRadius: 12,
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
          backgroundColor: 'var(--bg-secondary)',
        }}
      />
    </div>
  );
}
