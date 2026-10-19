import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { LoadingState } from './AsyncState';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api.js';
import EnrolPhone from './EnrolPhone';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { formatDistance } from '../lib/distance';
import { formatDate, formatTime } from '../lib/datetime';

// Location Trail map (Oct 20 2026, backend/routers/location_trail.py).
//   Team mode (People > Time > Location Trail): live positions of the people
//   in the viewer's scope who are clocked in and pinged in the last ~15
//   minutes (web pings from the Time Clock, or the Nexus Fields phone app),
//   and one person's trail for a chosen day with their punches on it.
//   Self mode (`self`, from the Time Clock page): only
//   that person's own trail for a chosen day.
const STATUS = {
  in_fence:     { color: '#16a34a', label: 'On Site' },
  out_of_fence: { color: '#d97706', label: 'Out of Location' },
  remote:       { color: '#2563eb', label: 'Remote' },
  low_accuracy: { color: '#64748b', label: 'Weak GPS' },
  no_location:  { color: '#64748b', label: 'Located' },
};
const PUNCH = {
  in:          { color: '#16a34a', label: 'Clock In' },
  break_start: { color: '#d97706', label: 'Break Start' },
  break_end:   { color: '#2563eb', label: 'Break End' },
  out:         { color: '#b91c1c', label: 'Clock Out' },
};
const REFRESH_MS = 60000;
const TRAIL_COLOR = '#2563eb';
const utc = (iso) => (iso ? `${String(iso).slice(0, 19)}Z` : '');
// The viewer's LOCAL calendar date (toISOString is UTC).
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(utc(iso)).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} hr ago`;
}
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

export default function LiveCrewMap({ toastErr, employees = [], people = [], self = false, canEnroll = false }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const pathRef = useRef(null);
  const [crew, setCrew] = useState(self ? [] : null);
  const [sel, setSel] = useState(self ? 'me' : '');    // email whose trail is drawn ('me' = the viewer)
  const [day, setDay] = useState(localDay());
  // The loaded trail, tagged with the person + day it is for: { key, data }.
  const [loaded, setLoaded] = useState({ key: '', data: null });
  const [updated, setUpdated] = useState('');
  const [enrol, setEnrol] = useState(false);

  // Create the Leaflet map once (same lifecycle as PortfolioMap).
  useEffect(() => {
    let map;
    try {
      map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([33.5, -117.1], 4);
    } catch { return undefined; }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    pathRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // the container may have measured 0x0 if this tab was hidden at mount
    const t = setTimeout(() => { try { map.invalidateSize(); } catch { /* torn down */ } }, 120);
    return () => { clearTimeout(t); try { map.remove(); } catch { /* already gone */ } mapRef.current = null; };
  }, []);

  const load = useCallback(() => {
    if (self) return;
    api.locationTrailLive()
      .then(r => { setCrew(r?.crew || []); setUpdated(formatTime(new Date())); })
      .catch(e => { setCrew(c => c || []); toastErr && toastErr(e?.message || 'Could not load live locations.'); });
  }, [toastErr, self]);
  useEffect(() => { load(); return self ? undefined : pollWhileVisible(load, REFRESH_MS); }, [load, self]);

  // Live markers (team mode, nobody selected).
  useEffect(() => {
    const map = mapRef.current, layer = markersRef.current;
    if (!map || !layer) return;
    try { layer.clearLayers(); } catch { /* torn down */ }
    if (!crew || sel) return;
    const bounds = [];
    crew.forEach(c => {
      const lat = num(c.lat), lng = num(c.lng);
      if (lat === null || lng === null) return;
      const st = STATUS[c.geoStatus] || STATUS.no_location;
      L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 2, fillColor: c.onBreak ? '#94a3b8' : st.color, fillOpacity: 1 })
        .addTo(layer)
        .bindTooltip(`${c.name} - ${c.onBreak ? 'On Break' : st.label} - ${ago(c.at)}`, { direction: 'top' })
        .on('click', () => setSel(c.email));
      bounds.push([lat, lng]);
    });
    if (bounds.length) { try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 }); } catch { /* degenerate */ } }
  }, [crew, sel]);

  // One person's trail for the chosen day.
  useEffect(() => {
    if (!sel || !day) return undefined;
    let live = true;
    const key = `${sel}|${day}`;
    api.locationTrailDay(self ? '' : sel, day)
      .then(r => { if (live) setLoaded({ key, data: r || { points: [], punches: [] } }); })
      .catch(e => { if (live) { setLoaded({ key, data: { points: [], punches: [] } }); toastErr && toastErr(e?.message || 'Could not load the trail.'); } });
    return () => { live = false; };
  }, [sel, day, toastErr, self]);
  const trail = sel && loaded.key === `${sel}|${day}` ? loaded.data : null;
  const trailBusy = !!sel && !trail;

  useEffect(() => {
    const map = mapRef.current, layer = pathRef.current;
    if (!map || !layer) return;
    try { layer.clearLayers(); } catch { /* torn down */ }
    if (!sel || !trail) return;
    const pts = (trail.points || []).map(p => ({ ...p, ll: [num(p.lat), num(p.lng)] }))
      .filter(p => p.ll[0] !== null && p.ll[1] !== null);
    const all = pts.map(p => p.ll);
    if (pts.length > 1) L.polyline(all, { color: TRAIL_COLOR, weight: 3, opacity: 0.85 }).addTo(layer);
    pts.forEach(p => L.circleMarker(p.ll, { radius: 4, color: TRAIL_COLOR, fillColor: TRAIL_COLOR, fillOpacity: 1 })
      .addTo(layer).bindTooltip(`${formatTime(utc(p.at))}${p.workSiteName ? ` - ${p.workSiteName}` : ''}`, { direction: 'top' }));
    (trail.punches || []).forEach(p => {
      const lat = num(p.lat), lng = num(p.lng);
      if (lat === null || lng === null) return;
      const k = PUNCH[p.kind] || PUNCH.in;
      L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2, fillColor: k.color, fillOpacity: 1 })
        .addTo(layer).bindTooltip(`${k.label} ${formatTime(utc(p.at))}`, { direction: 'top' });
      all.push([lat, lng]);
    });
    if (all.length) { try { map.fitBounds(all, { padding: [40, 40], maxZoom: 16 }); } catch { /* single point */ } }
  }, [sel, trail]);

  const list = useMemo(() => crew || [], [crew]);
  const choices = useMemo(() => {
    const m = new Map();
    list.forEach(c => m.set(c.email, c.name));
    (people || []).forEach(p => { if (p?.email && !m.has(p.email)) m.set(p.email, p.name || p.email); });
    return [...m.entries()].map(([email, name]) => ({ email, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [list, people]);
  const selName = trail?.name || choices.find(c => c.email === sel)?.name || sel;
  const pointCount = trail?.points?.length || 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
        {!self && (<>
          <span><strong style={{ color: 'var(--ink)' }}>{list.length}</strong> clocked in and sharing location</span>
          {updated && <span>- updated {updated}</span>}
        </>)}
        {!self && (
          <select className="form-input" aria-label="Person" value={sel} onChange={e => setSel(e.target.value)}
            style={{ fontSize: 12, width: 220, maxWidth: '100%' }}>
            <option value="">Everyone Live Now</option>
            {choices.map(c => <option key={c.email} value={c.email}>{c.name}</option>)}
          </select>
        )}
        {sel && (
          <input className="form-input" type="date" aria-label="Day" value={day} max={localDay()}
            onChange={e => setDay(e.target.value)} style={{ fontSize: 12, width: 150 }} />
        )}
        {!self && sel && (
          <button className="secondary-btn" onClick={() => setSel('')} style={{ fontSize: 12 }}>Back to Everyone</button>
        )}
        {canEnroll && !self && (
          <button className="secondary-btn" onClick={() => setEnrol(true)} style={{ fontSize: 12 }}>Enroll Phone</button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <div ref={mapElRef} data-testid="trail-map" style={{ flex: '1 1 420px', minWidth: 0, height: 'min(62vh, 560px)', borderRadius: 12,
          border: '1px solid var(--line)', overflow: 'hidden', background: 'var(--card)', position: 'relative', zIndex: 0 }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'min(62vh, 560px)', overflowY: 'auto', flex: '1 1 240px', maxWidth: '100%', minWidth: 0 }}>
          {sel ? (
            trailBusy && !trail ? <LoadingState compact /> : (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                  {self ? 'My Trail' : selName} - {formatDate(day)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {pointCount ? `${pointCount} location ${pointCount === 1 ? 'point' : 'points'}` : 'No location points on this day.'}
                </div>
                {(trail?.punches || []).map((p, i) => {
                  const k = PUNCH[p.kind] || PUNCH.in;
                  return (
                    <div key={`${p.at}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: k.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{k.label}</span>
                      <span style={{ color: 'var(--muted)' }}>{formatTime(utc(p.at))}{p.lat ? '' : ' - No Location'}</span>
                    </div>
                  );
                })}
              </>
            )
          ) : crew === null ? (
            <LoadingState compact />
          ) : list.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 2px' }}>
              No one on your team is clocked in and sharing a location right now. People appear here while they are
              clocked in with Nexus open, once their company turns on Location Trail While Clocked In. Pick a person
              above to see a past day.
            </div>
          ) : list.map(c => {
            const st = STATUS[c.geoStatus] || STATUS.no_location;
            return (
              <button key={c.email} onClick={() => setSel(c.email)}
                style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 10, cursor: 'pointer',
                  border: '1px solid var(--wk-line2)', background: 'var(--card)', fontFamily: 'var(--wk-font)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: c.onBreak ? '#94a3b8' : st.color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>{c.name}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  {c.onBreak ? 'On Break' : st.label}{c.workSiteName ? ` - ${c.workSiteName}` : ''}{c.distanceM ? ` (${formatDistance(c.distanceM)})` : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {ago(c.at)}{c.source === 'mobile' ? ' - phone app' : ''}{c.batteryPct >= 0 ? ` - battery ${c.batteryPct}%` : ''}
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
