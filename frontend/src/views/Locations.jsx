import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Users, Search, X, Smartphone, Monitor, Maximize2, Minimize2, ArrowUpDown, List as ListIcon, Map as MapIcon } from 'lucide-react';
import { api } from '../api.js';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { useIsMobile } from '../lib/useIsMobile';
import { SkeletonBlocks } from '../components/AsyncState';
import { ViewNotice } from '../components/workforce/WorkforceViews';
import { useWorkforceView } from '../components/workforce/viewContext';

// Company-wide map of where each person LAST punched from. Pins are the person's
// profile photo, ringed green when they're clocked in. Filter by company /
// department / country (+ on-site, clocked-in, name). Coordinates come from the
// punch itself, so a desktop clusters at ~IP accuracy and a phone is GPS-precise.

// Live clock state (from the person's latest punch): drives the pin/avatar ring.
const CLOCK = {
  working:  { color: '#16a34a', label: 'Working' },
  on_break: { color: '#d97706', label: 'On Break' },
  off:      { color: '#94a3b8', label: 'Not Clocked In' },
};
const clockOf = (p) => CLOCK[p.status] || (p.clockedIn ? CLOCK.working : CLOCK.off);
const fmtAcc = (m) => m >= 1000 ? `±${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}km` : `±${m}m`;
// Status label + color. On-site/off-site come from the geofence verdict; otherwise
// judge by ACCURACY, not geo_status - a punch reads "no_location" whenever there's
// no geofenced site to compare against, even with a pin-perfect phone GPS fix.
function locStatus(p) {
  if (p.geoStatus === 'in_fence') return { color: '#16a34a', label: `On Site${p.workSiteName ? ` · ${p.workSiteName}` : ''}` };
  // Not at any of their allowed sites (Sep 29) - never a site's name.
  if (p.geoStatus === 'out_of_fence') return { color: '#d97706', label: 'Out of Location' };
  // Tagged remote in People - Work Mode: anywhere is fine, nothing to flag (Neil, Sep 19).
  if (p.geoStatus === 'remote') return { color: '#2563eb', label: 'Remote' };
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
  const size = active ? 48 : 40;
  const c = clockOf(p);
  const inner = p.photoUrl
    ? `<img src="${esc(p.photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover"/>`
    : `<div style="width:100%;height:100%;background:#334155;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${Math.round(size / 2.8)}px;font-family:Inter,sans-serif">${initials(p.name)}</div>`;
  const dev = Math.round(size * 0.5), stat = Math.round(size * 0.34);
  const devEmoji = p.device === 'mobile' ? '📱' : '💻';
  // pfp ringed by clock status, with a device badge (top-left: phone=GPS / PC=no GPS)
  // and a status dot (top-right). A STALE pin (current punch had no location, so
  // this is a last-known spot) is dimmed with a dashed ring.
  return `<div style="position:relative;width:${size}px;height:${size}px;opacity:${p.locStale ? 0.55 : 1}">
    <div style="width:100%;height:100%;border-radius:50%;border:3px ${p.locStale ? 'dashed' : 'solid'} ${c.color};box-shadow:0 2px 10px rgba(0,0,0,.4);overflow:hidden;background:#fff">${inner}</div>
    <div title="${p.device === 'mobile' ? 'Phone - GPS' : 'Desktop - no GPS'}" style="position:absolute;top:-5px;left:-5px;width:${dev}px;height:${dev}px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,.15);box-shadow:0 1px 3px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:${Math.round(dev * 0.6)}px;line-height:1">${devEmoji}</div>
    <div style="position:absolute;top:-3px;right:-3px;width:${stat}px;height:${stat}px;border-radius:50%;background:${c.color};border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.35)"></div>
  </div>`;
}

// Layout (Neil, Sep 29: "the map is just too big and the number of people on
// the right that would show up seems too small"): the people list is the
// primary surface - dense one-line rows with status filters and sorting,
// about twice as many people on screen - and the map sits beside it at a
// size that still reads. "Full-Screen Map" takes the map over the whole
// screen on demand, with the list riding along as a panel. On a phone the two
// panes were squeezed side by side (the map became a 74px sliver); there it
// is a List | Map switch instead, and tapping a person opens them on the map.
const PANE_H = 'clamp(440px, calc(100dvh - 290px), 980px)';
const STATUS_TABS = [
  ['', 'All'], ['working', 'Working'], ['on_break', 'On Break'], ['off', 'Not Clocked In'],
];
const SORTS = [['status', 'Status'], ['name', 'Name'], ['recent', 'Last Punch'], ['department', 'Department']];
const STATUS_RANK = { working: 0, on_break: 1, off: 2 };
const statusKey = (p) => p.status || (p.clockedIn ? 'working' : 'off');

// Row layout follows the LIST's width (container query), not the window's:
// wide = one line with columns, narrow = name over a detail line.
const LIST_CSS = `
.wfl-list { container-type: inline-size; container-name: wfl; }
.wfl-row { display: grid; grid-template-columns: minmax(0, 2.2fr) 118px minmax(0, 1.5fr) 74px; align-items: center; column-gap: 12px;
  width: 100%; min-height: 42px; padding: 5px 12px; border: none; border-bottom: 1px solid var(--line); background: var(--card);
  text-align: left; cursor: pointer; font-family: var(--wk-font); color: var(--ink); }
.wfl-row:hover { background: var(--mist); }
.wfl-row[aria-selected="true"] { background: var(--wk-brand-tint); box-shadow: inset 3px 0 0 var(--wk-brand); }
.wfl-head { position: sticky; top: 0; z-index: 1; cursor: default; min-height: 32px; background: var(--card); font-size: 10.5px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .05em; color: var(--muted); white-space: nowrap; }
.wfl-head:hover { background: var(--card); }
.wfl-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.wfl-flex { display: inline-flex; align-items: center; gap: 6px; }
.wfl-sub { display: none; }
@container wfl (max-width: 480px) {
  .wfl-row { grid-template-columns: minmax(0, 1fr) auto; min-height: 50px; }
  .wfl-head, .wfl-loc, .wfl-last { display: none; }
  .wfl-sub { display: block; }
}`;

export default function Locations({ toastErr, embedded = false }) {
  const mapElRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const markerByEmail = useRef({});
  const fitRef = useRef(() => {});
  const listRef = useRef(null);
  const [people, setPeople] = useState(null);
  const [sel, setSel] = useState(null);       // focused email
  const [updated, setUpdated] = useState('');
  const [f, setF] = useState({ company: '', department: '', country: '', geo: '', status: '', q: '' });
  const [sort, setSort] = useState('status');
  const [full, setFull] = useState(false);    // Full-Screen Map
  const [pane, setPane] = useState('list');   // phone: 'list' | 'map'
  const phone = useIsMobile('(max-width: 900px)');
  const { inView } = useWorkforceView();

  // Create the Leaflet map once.
  useEffect(() => {
    let map;
    try { map = L.map(mapElRef.current, { scrollWheelZoom: true }).setView([20, 40], 2); }
    catch { return; }
    // Two base layers with a Map / Satellite toggle (Esri World Imagery is free, no key).
    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
    const hybrid = L.layerGroup([satellite, labels]);   // satellite + place/road labels on top
    hybrid.addTo(map);   // default to Satellite
    L.control.layers({ 'Map': street, 'Satellite': hybrid }, {}, { position: 'topright', collapsed: false }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // The map box changes size with Full Screen, the phone's List | Map
    // switch and the window - re-measure and re-frame whenever it does.
    const ro = new ResizeObserver(() => {
      try { map.invalidateSize(); fitRef.current(); } catch { /* torn down */ }
    });
    ro.observe(mapElRef.current);
    return () => { ro.disconnect(); try { map.remove(); } catch { /* gone */ } mapRef.current = null; };
  }, []);

  const load = useCallback(() => {
    api.timeLocations()
      .then(r => { setPeople(r.people || []); setUpdated(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })); })
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

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  // The team view (Workforce Analytics header) narrows everything below it.
  const everyone = useMemo(() => people || [], [people]);
  const all = useMemo(() => everyone.filter(p => inView(p.email)), [everyone, inView]);
  const companies = useMemo(() => [...new Map(all.filter(p => p.companyId).map(p => [p.companyId, p.companyName || p.companyId])).entries()], [all]);
  const departments = useMemo(() => [...new Set(all.map(p => p.department).filter(Boolean))].sort(), [all]);
  const countries = useMemo(() => [...new Set(all.map(p => p.country).filter(Boolean))].sort(), [all]);

  // Everything but the status tab - the tabs count against this.
  const filtered = useMemo(() => all.filter(p => {
    if (f.company && p.companyId !== f.company) return false;
    if (f.department && p.department !== f.department) return false;
    if (f.country && p.country !== f.country) return false;
    if (f.geo === 'on' && p.geoStatus !== 'in_fence') return false;
    if (f.geo === 'off' && p.geoStatus !== 'out_of_fence') return false;
    if (f.q && !(`${p.name} ${p.department} ${p.companyName} ${p.jobTitle}`.toLowerCase().includes(f.q.toLowerCase()))) return false;
    return true;
  }), [all, f]);
  const counts = useMemo(() => {
    const c = { '': filtered.length, working: 0, on_break: 0, off: 0 };
    for (const p of filtered) c[statusKey(p)] = (c[statusKey(p)] || 0) + 1;
    return c;
  }, [filtered]);
  const shown = useMemo(() => {
    const rows = f.status ? filtered.filter(p => statusKey(p) === f.status) : filtered;
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
    const cmp = {
      name: byName,
      recent: (a, b) => (b.statusAt || b.at || '').localeCompare(a.statusAt || a.at || '') || byName(a, b),
      department: (a, b) => (a.department || '~').localeCompare(b.department || '~') || byName(a, b),
      status: (a, b) => (STATUS_RANK[statusKey(a)] - STATUS_RANK[statusKey(b)]) || byName(a, b),
    }[sort];
    return [...rows].sort(cmp);
  }, [filtered, f.status, sort]);

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
      const size = active ? 48 : 40;
      const m = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: pinHtml(p, active), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), zIndexOffset: active ? 1000 : 0 })
        .addTo(layer)
        .bindTooltip(`${p.name}${p.department ? ` · ${p.department}` : ''} · ${clockOf(p).label} · ${locStatus(p).label}`, { direction: 'top', offset: [0, -size / 2] })
        .on('click', () => setSel(p.email));
      markerByEmail.current[p.email] = [lat, lng];
      bounds.push([lat, lng]);
    });
    fitRef.current = () => {
      if (sel && markerByEmail.current[sel]) {
        // Zoom right in on the selected person - as tight as their accuracy justifies
        // (a precise phone fix goes to street level; a coarse desktop blob stays wider
        // so it doesn't imply a false pinpoint).
        const acc = shown.find(x => x.email === sel)?.accuracyM || 0;
        const z = acc > 0 && acc <= 300 ? 18 : acc > 0 && acc <= 3000 ? 15 : 13;
        try { map.setView(markerByEmail.current[sel], z, { animate: true }); } catch { /* noop */ }
      } else if (bounds.length) {
        try { map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 }); } catch { /* single/degenerate */ }
      }
    };
    fitRef.current();
  }, [shown, sel]);

  // Picking on the map scrolls the list to that person.
  useEffect(() => {
    if (!sel) return;
    const row = listRef.current?.querySelector(`[data-person-row="${CSS.escape(sel)}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  const clearFilters = () => setF({ company: '', department: '', country: '', geo: '', status: '', q: '' });
  const activeFilters = f.company || f.department || f.country || f.geo || f.status || f.q;
  const selP = shown.find(p => p.email === sel);
  const pick = (email) => {
    const next = sel === email ? null : email;
    setSel(next);
    if (next && phone) setPane('map');
  };

  const selStyle = { fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--wk-line2)', background: 'var(--card)', fontFamily: 'var(--wk-font)', color: 'var(--ink)', maxWidth: 170 };
  const overlayBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 11px', borderRadius: 9, border: '1px solid rgba(0,0,0,.15)',
    background: 'var(--card)', color: 'var(--ink)', fontFamily: 'var(--wk-font)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,.25)' };
  const showMap = !phone || pane === 'map' || full;
  const showList = full ? !phone : (!phone || pane === 'list');

  const list = (
    <div ref={listRef} className="wfl-list" style={{
      display: showList ? 'flex' : 'none', flexDirection: 'column', minWidth: 0, border: '1px solid var(--wk-line2)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden',
      ...(phone && !full ? {} : { height: full ? '100%' : PANE_H }),
    }}>
      {/* Status tabs: how many are in each state, one tap to narrow. */}
      <div role="tablist" aria-label="Clock status" className="scroll-tabs" style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        {STATUS_TABS.map(([key, label]) => {
          const on = f.status === key;
          const dot = key ? CLOCK[key]?.color : null;
          return (
            <button key={key || 'all'} type="button" role="tab" aria-selected={on} onClick={() => setF(s => ({ ...s, status: key }))}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                fontFamily: 'var(--wk-font)', fontSize: 12.5, fontWeight: 700, background: on ? 'var(--wk-brand-tint)' : 'transparent', color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>
              {dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />}
              {label} <span style={{ fontWeight: 600, opacity: 0.75 }}>{counts[key] || 0}</span>
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          <ArrowUpDown size={12} />
          <select aria-label="Sort" value={sort} onChange={e => setSort(e.target.value)} style={{ ...selStyle, padding: '4px 6px', fontSize: 12 }}>
            {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: phone && !full ? 'visible' : 'auto' }}>
        {people === null ? (
          <div style={{ padding: 12 }}><SkeletonBlocks count={8} height={34} /></div>
        ) : shown.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13, padding: '16px 14px', display: 'flex', alignItems: 'center', gap: 7 }}>
            <Users size={15} /> {everyone.length && !all.length
              ? 'No one in this team view has punched with a location yet.'
              : 'No one matches these filters, or no one has punched with a location yet.'}
          </div>
        ) : (<>
          <div className="wfl-row wfl-head" aria-hidden>
            <span>Person</span><span>Status</span><span className="wfl-loc">Location</span><span className="wfl-last">Last Punch</span>
          </div>
          {shown.map(p => {
            const active = sel === p.email;
            const g = locStatus(p);
            const c = clockOf(p);
            const where = p.locStale ? `Last seen · ${g.label}` : g.label;
            const DevIcon = p.device === 'mobile' ? Smartphone : Monitor;
            return (
              <button key={p.email} type="button" className="wfl-row" data-person-row={p.email} aria-selected={active} onClick={() => pick(p.email)}
                title={`${p.name}${p.jobTitle ? ` · ${p.jobTitle}` : ''} - show on the map`}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <span style={{ width: 28, height: 28, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, border: `2px solid ${c.color}`, background: '#334155', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 10.5 }}>
                    {p.photoUrl ? <img src={p.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(p.name)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="wfl-cell" style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>
                      {p.name}{(p.department || p.companyName) && <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 12 }}> · {[p.department, p.companyName].filter(Boolean).join(' · ')}</span>}
                    </span>
                    <span className="wfl-cell wfl-sub" style={{ color: p.locStale ? '#b45309' : 'var(--muted)', fontSize: 11.5 }}>
                      {where} · {ago(p.at)}
                    </span>
                  </span>
                </span>
                <span className="wfl-cell wfl-flex" style={{ fontWeight: 700, color: c.color }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />{c.label}
                </span>
                <span className="wfl-cell wfl-flex wfl-loc" style={{ color: p.locStale ? '#b45309' : 'var(--muted)', fontStyle: p.locStale ? 'italic' : 'normal' }}>
                  <DevIcon size={12} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{where}</span>
                </span>
                <span className="wfl-cell wfl-last" style={{ color: 'var(--muted)', textAlign: 'right' }}>{ago(p.at)}</span>
              </button>
            );
          })}
        </>)}
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: 'var(--wk-font)' }}>
      <style>{LIST_CSS}</style>
      {!embedded && (
        <div className="view-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><MapPin size={19} /></span>
            <div className="view-title-group">
              <h2 style={{ margin: 0 }}>Locations</h2>
              <p style={{ margin: '2px 0 0' }}>Where each person last punched from</p>
            </div>
          </div>
        </div>
      )}

      <ViewNotice shown={all.length} total={everyone.length} />

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 12px' }}>
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: phone ? '1 1 100%' : '0 1 220px' }}>
          <Search size={14} style={{ position: 'absolute', left: 9, color: 'var(--muted)' }} />
          <input placeholder="Search People" aria-label="Search People" value={f.q} onChange={e => setF(s => ({ ...s, q: e.target.value }))}
            style={{ ...selStyle, paddingLeft: 28, maxWidth: 'none', width: '100%' }} />
        </span>
        {companies.length > 1 && (
          <select aria-label="Company" value={f.company} onChange={e => setF(s => ({ ...s, company: e.target.value }))} style={selStyle}>
            <option value="">All Companies</option>
            {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <select aria-label="Department" value={f.department} onChange={e => setF(s => ({ ...s, department: e.target.value }))} style={selStyle}>
          <option value="">All Departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        {countries.length > 1 && (
          <select aria-label="Country" value={f.country} onChange={e => setF(s => ({ ...s, country: e.target.value }))} style={selStyle}>
            <option value="">All Countries</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select aria-label="Site Status" value={f.geo} onChange={e => setF(s => ({ ...s, geo: e.target.value }))} style={selStyle}>
          <option value="">Any Site Status</option>
          <option value="on">On Site</option>
          <option value="off">Out of Location</option>
        </select>
        {activeFilters ? <button className="secondary-btn" onClick={clearFilters} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Clear</button> : null}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>{shown.length}</strong> shown{updated ? ` · updated ${updated}` : ''}
        </span>
      </div>

      {phone && !full && (
        <div role="tablist" aria-label="Locations layout" style={{ display: 'flex', gap: 4, padding: 4, marginBottom: 10, borderRadius: 11, background: 'var(--mist)', border: '1px solid var(--wk-line2)' }}>
          {[['list', 'List', ListIcon], ['map', 'Map', MapIcon]].map(([key, label, Icon]) => (
            <button key={key} type="button" role="tab" aria-selected={pane === key} onClick={() => setPane(key)}
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontFamily: 'var(--wk-font)', fontSize: 13.5, fontWeight: 700, background: pane === key ? 'var(--card)' : 'transparent',
                color: pane === key ? 'var(--ink)' : 'var(--muted)', boxShadow: pane === key ? '0 1px 4px rgba(0,0,0,.12)' : 'none' }}>
              <Icon size={15} /> {label}{key === 'list' ? ` (${shown.length})` : ''}
            </button>
          ))}
        </div>
      )}

      <div style={full
        ? { position: 'fixed', inset: 0, zIndex: 1300, background: 'var(--bg, var(--mist))', padding: 12, display: 'grid', gap: 12,
            gridTemplateColumns: phone ? 'minmax(0,1fr)' : 'minmax(0,1fr) min(440px, 36vw)' }
        : { display: 'grid', gap: 12, alignItems: 'start', gridTemplateColumns: phone ? 'minmax(0,1fr)' : 'minmax(0, 0.8fr) minmax(0, 1fr)' }}>
        {/* position:relative + z-index:0 contains Leaflet's GPU-composited tiles in
            their own stacking context, so they can't paint over modals (e.g. the
            profile-menu Screenshots viewer at z-1450) opened above the map. */}
        <div style={{ position: 'relative', zIndex: 0, display: showMap ? 'block' : 'none', minWidth: 0,
          height: full ? '100%' : phone ? 'max(360px, calc(100dvh - 300px))' : PANE_H }}>
          <div ref={mapElRef} aria-label="Map of last punch locations" style={{ width: '100%', height: '100%', borderRadius: 12, border: '1px solid var(--line)', overflow: 'hidden', background: 'var(--card)' }} />
          <button type="button" onClick={() => setFull(v => !v)} style={{ ...overlayBtn, position: 'absolute', left: 56, top: 10, zIndex: 500 }}
            title={full ? 'Exit full screen (Esc)' : 'Show the map across the whole screen'}>
            {full ? <><Minimize2 size={14} /> Exit Full Screen</> : <><Maximize2 size={14} /> Full-Screen Map</>}
          </button>
          {selP && (
            <div style={{ position: 'absolute', left: 10, right: 10, bottom: 10, zIndex: 500, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
              borderRadius: 10, background: 'var(--card)', boxShadow: '0 4px 16px rgba(0,0,0,.25)', fontSize: 12, color: 'var(--muted)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ color: 'var(--ink)' }}>{selP.name}</strong> · {clockOf(selP).label} · {locStatus(selP).label}.
                {selP.locStale && <span style={{ color: '#b45309', fontWeight: 600 }}> Last known location ({ago(selP.at)}) - their current session isn't sharing one.</span>}
                {' '}Accuracy ±{selP.accuracyM >= 1000 ? `${(selP.accuracyM / 1000).toFixed(1)} km` : `${selP.accuracyM} m`}
                {selP.accuracyM > 1000 ? ' - no GPS on this device (a phone punch gives a precise fix).' : '.'}
              </span>
              <button type="button" onClick={() => setSel(null)} aria-label="Show everyone" title="Show everyone"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={15} /></button>
            </div>
          )}
        </div>
        {list}
      </div>
    </div>
  );
}
