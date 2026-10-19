// The site model screen (Neil, Oct 11 2026): the 3D canvas plus the panel
// beside it. Two faces of one component:
//   customer - /map/{propertyId}: find a unit, read how to get there.
//   owner    - Asset Management property page: occupancy, out-of-service units,
//              tickets at a unit, and markup pins dropped on the exact spot.
// All server traffic belongs to the parent (SiteModelSection / PublicUnitFinder);
// this component only renders what it is given and reports what the user did.
//
// Oct 20 2026 (Ops review) - optional props, all off by default so Asset
// Management renders as before:
//   unitColors    { unitName: '#rrggbb' } - a layer's colors (owners only)
//   legend        node shown in place of the occupancy legend
//   hoverInfo(u)  a line for the hover tooltip (the active layer's fact)
//   renderUnitExtra(u)  node at the foot of the unit card (layer facts, links)
//   markers       { unitName: count } - 3D markers in place of the ticket counts
//   pinsEnabled   false hides markup pins (a screen without the pin grant)
//   hideSearch    true for the customer route page (one unit, nothing to search)
//   fitRoute      choosing a unit frames the whole route from the gate (customer page)
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createSiteModelViewer, unitKindLabel, unitDirections, doorSideName, reasonLabel, routeSteps } from './siteModelViewer.js';
import { planRoute } from './siteModelRoute.js';
import { SiteModelPlan2D } from './SiteModelPlan2D.jsx';
import { formatDateTime } from '../lib/datetime.js';
import { SiteModelHud } from './SiteModelHud.jsx';

const FONT = "'Inter', system-ui, sans-serif";
const PIN_CATEGORIES = [['maintenance', 'Maintenance'], ['inspection', 'Inspection'], ['note', 'Note']];
const chip = (bg) => ({ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: '#fff', background: bg });
const btn = { font: `500 13px ${FONT}`, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-color, #d9d6cc)', background: 'var(--bg-primary, #fff)', color: 'var(--text-primary, #1d1f1a)', cursor: 'pointer' };
const btnOn = { ...btn, background: '#1f6f4a', borderColor: '#1f6f4a', color: '#fff' };
// 884 <option>s must not re-render on every hover: memoized on the unit list.
const UnitList = memo(function UnitList({ units }) { return <datalist id="site-model-units">{units.map((x) => <option key={x.n} value={x.n} />)}</datalist>; });
const h2 = { fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #5f6358)', margin: '0 0 6px', fontWeight: 700 };
const card = { border: '1px solid var(--border-color, #d9d6cc)', borderRadius: 10, padding: 12, background: 'var(--bg-primary, #fff)' };

// Satellite = the property photo under the model; Illustrated = the same model
// drawn as a miniature with trees and traffic. Remembered per browser.
const LOOK_KEY = 'nexus.siteModel.look';
function readLook() { try { return localStorage.getItem(LOOK_KEY) === 'illustrated' ? 'illustrated' : 'satellite'; } catch { return 'satellite'; } }
function saveLook(v) { try { localStorage.setItem(LOOK_KEY, v); } catch { /* private window: the choice just is not remembered */ } }

export function normalizeQuery(q) {
  const s = (q || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z])(\d{1,3})([A-Z]?)$/);
  return m ? m[1] + m[2].padStart(3, '0') + m[3] : s;
}

export function SiteModelPanel({ model, mode = 'customer', images, pins = [], tickets = [], onAddPin, onRemovePin, onTogglePin, onOpenTicket, height = 560, initialUnit = '', unitColors = null, legend = null, hoverInfo = null, renderUnitExtra = null, markers = null, pinsEnabled = true, hideSearch = false, fitRoute = false }) {
  const stageRef = useRef(null); const viewerRef = useRef(null);
  const [selected, setSelected] = useState(() => initialUnit || null); const [building, setBuilding] = useState(null);
  const [query, setQuery] = useState(''); const [notFound, setNotFound] = useState('');
  const [xray, setXray] = useState(false); const [level, setLevel] = useState(0);
  const [placing, setPlacing] = useState(false); const [pending, setPending] = useState(null);
  const [pinTitle, setPinTitle] = useState(''); const [pinCat, setPinCat] = useState('maintenance');
  const [hover, setHover] = useState(null); const [noGl, setNoGl] = useState(false);
  const [look, setLook] = useState(readLook);
  const [touched, setTouched] = useState(false);
  const colorsRef = useRef(unitColors); colorsRef.current = unitColors;
  const selectedRef = useRef(null); const xrayRef = useRef(false);
  useEffect(() => { selectedRef.current = selected; xrayRef.current = xray; }, [selected, xray]);
  const byName = useMemo(() => Object.fromEntries((model.units || []).map((u) => [u.n, u])), [model]);
  const ticketsByUnit = useMemo(() => { const m = {}; tickets.forEach((t) => { const k = normalizeQuery(t.location || ''); if (k && byName[k]) (m[k] = m[k] || []).push(t); }); return m; }, [tickets, byName]);
  const maxLevel = useMemo(() => Math.max(1, ...(model.buildings || []).map((b) => b.floors || 1)), [model]);

  useEffect(() => {
    if (!stageRef.current) return undefined;
    let v;
    try {
      v = createSiteModelViewer(stageRef.current, model, {
        mode, style: look, images, colors: colorsRef.current, fitRoute, background: getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary') || '#dfe6e9',
        onSelectUnit: (u) => { setSelected(u ? u.n : null); if (u) { setBuilding(null); setQuery(u.n); } setLevel(v ? v.getState().level : 0); },
        onSelectBuilding: (b) => setBuilding(b),
        onPlacePin: (at) => { setPending(at); setPlacing(false); },
        onHover: (u, pos) => setHover(u ? { n: u.n, f: u.f, ...pos } : null),
      });
    } catch (e) {
      // No WebGL (old GPU, headless) - the panel still works as a unit list. A throw
      // after the canvas went in leaves it behind: take it out so the stage shows the note.
      stageRef.current.querySelectorAll('canvas').forEach((c) => c.remove());
      setNotFound(''); setNoGl(true); console.warn('[site-model] viewer unavailable', e);
      return undefined;
    }
    viewerRef.current = v;
    v.setPins(pins); if (xrayRef.current) v.setXray(true);
    // A look switch rebuilds the scene: keep the unit the person was looking at.
    const keep = selectedRef.current || initialUnit;
    if (keep && byName[keep]) setTimeout(() => { if (viewerRef.current === v) v.selectUnit(keep); }, 300);
    return () => { v.destroy(); viewerRef.current = null; };
  }, [model, look]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewerRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { viewerRef.current?.setPins(pins); }, [pins]);
  useEffect(() => { viewerRef.current?.setMarkers(markers || Object.fromEntries(Object.entries(ticketsByUnit).map(([k, v]) => [k, v.length]))); }, [ticketsByUnit, markers, look]);
  useEffect(() => { viewerRef.current?.setUnitColors?.(unitColors); }, [unitColors]);
  useEffect(() => { viewerRef.current?.setPlacing(placing); }, [placing]);

  const u = selected ? byName[selected] : null;
  const steps = useMemo(() => (u ? routeSteps(model, u) : []), [model, u]);
  // The 2D plan draws the same route the 3D view lays on the ground.
  const plan2d = useMemo(() => (noGl && u ? planRoute(model, u, steps) : null), [noGl, model, u, steps]);
  const bldg = (id) => (model.buildings || []).find((b) => b.id === id);
  const zone = (id) => (model.zones || []).find((z) => z.id === id);
  const live = model.live || { source: 'snapshot' };
  const unplaced = live.unplaced || [];
  const find = (e) => {
    e.preventDefault(); const name = normalizeQuery(query);
    // Without WebGL the viewer never mounted; the panel still answers from the unit list.
    const found = viewerRef.current ? viewerRef.current.selectUnit(name) : !!byName[name];
    if (found) { if (!viewerRef.current) { setSelected(name); setBuilding(null); } setQuery(name); setNotFound(''); return; }
    if (unplaced.some((x) => x.n === name)) setNotFound(`Unit ${name} is at this property but not on the map yet - the office can point you to it.`);
    else setNotFound(`No unit ${name || '?'} at this property.`);
  };
  const liveLine = live.source === 'file' ? `${live.system} · not in Cubby, updated when a new rent roll is loaded`
    : live.source === 'cubby'
    ? `Live from Cubby${live.asOf ? ` · ${formatDateTime(live.asOf)}` : ''}${live.error ? ' · last good answer, Cubby is not responding' : ''}`
    : `Cubby snapshot from ${live.asOf || 'the build date'}${live.enabled === false ? ' · live link off' : live.error ? ` · ${live.error}` : ''}`;
  const setLvl = (n) => { setLevel(n); viewerRef.current?.setLevel(n); };
  const owner = mode === 'owner';
  const active = (model.units || []).filter((x) => x.n[0] !== 'M' && !x.gone);
  const leased = active.filter((x) => x.l === 1).length; const bad = active.filter((x) => x.r === 0); const vacant = active.filter((x) => x.l === 0 && x.r === 1).length;
  const savePin = (e) => { e.preventDefault(); if (!pending || !pinTitle.trim()) return; onAddPin?.({ ...pending, title: pinTitle.trim(), category: pinCat }); setPending(null); setPinTitle(''); };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 14, fontFamily: FONT }} className="site-model">
      <style>{`.site-model{--sm-cols:1} @media (max-width: 900px){ .site-model{grid-template-columns:1fr !important} }`}</style>
      <div style={{ minWidth: 0 }}>
        {!hideSearch && <form onSubmit={find} style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <input id="site-model-search" value={query} onChange={(e) => { setQuery(e.target.value); setNotFound(''); }} placeholder="Find a unit, e.g. C214" aria-label="Unit number" list="site-model-units"
            style={{ flex: 1, minWidth: 160, padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border-color, #d9d6cc)', font: `500 14px ui-monospace, Menlo, monospace`, textTransform: 'uppercase', background: 'var(--bg-primary, #fff)', color: 'inherit' }} />
          <UnitList units={model.units || []} />
          <button type="submit" style={btnOn}>Find</button>
          {notFound && <span role="alert" style={{ fontSize: 12, color: '#c43d2f', alignSelf: 'center' }}>{notFound}</span>}
        </form>}
        <div ref={stageRef} onPointerDown={() => setTouched(true)} onWheel={() => setTouched(true)} style={{ position: 'relative', height: look === 'illustrated' ? height + 80 : height, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-color, #d9d6cc)', background: 'var(--bg-secondary, #dfe6e9)' }}>
          {hover && (() => { const hu = byName[hover.n]; const info = hu && hoverInfo ? hoverInfo(hu) : '';
            return <div role="tooltip" style={{ position: 'absolute', left: hover.x + 12, top: hover.y - 30, pointerEvents: 'none', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #d9d6cc)', padding: '4px 8px', borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.12)', zIndex: 2, lineHeight: 1.35, maxWidth: 260 }}>
              <div style={{ font: `600 12px ui-monospace, Menlo, monospace` }}>{hover.n}{hover.f > 1 ? ` · L${hover.f}` : ''}{hu?.w && hu?.d ? <span style={{ font: `400 11px ${FONT}`, color: 'var(--text-muted, #5f6358)' }}> · {hu.w} × {hu.d} ft</span> : null}</div>
              {owner && hu && <div style={{ fontSize: 11, color: 'var(--text-muted, #5f6358)' }}>{hu.l === 1 ? 'Leased' : hu.r === 0 ? 'Out of Service' : 'Vacant'}</div>}
              {info ? <div style={{ fontSize: 11, fontWeight: 600 }}>{info}</div> : null}
            </div>; })()}
          {placing && <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #d9d6cc)', padding: '5px 12px', borderRadius: 999, fontSize: 12, zIndex: 2 }}>Click a unit, a building or the ground to place the pin</div>}
          {noGl && <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
            <SiteModelPlan2D model={model} mode={mode} colors={owner ? unitColors : null} selected={selected} route={plan2d} onSelect={(x) => { setSelected(x.n); setBuilding(null); setQuery(x.n); setNotFound(''); }} />
            <div role="status" style={{ position: 'absolute', left: 10, top: 10, fontSize: 12, background: 'rgba(255,255,255,0.9)', padding: '3px 8px', borderRadius: 6, color: '#5f6358' }}>Flat plan - the 3D view is not available on this device.</div>
          </div>}
          {!noGl && <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, flexWrap: 'wrap', zIndex: 2 }}>
            <button type="button" style={btn} onClick={() => { viewerRef.current?.resetView?.(); setLevel(0); }} title="Back to the whole site">Reset View</button>
            {[['overview', 'Overview'], ['plan', 'Plan'], ['gate', 'From Gate']].map(([k, l]) => <button key={k} type="button" style={btn} onClick={() => viewerRef.current?.view(k)}>{l}</button>)}
            <span style={{ display: 'inline-flex', border: '1px solid var(--border-color, #d9d6cc)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-primary, #fff)' }} role="group" aria-label="Look">
              {[['satellite', 'Satellite'], ['illustrated', 'Illustrated']].map(([k, l]) => <button key={k} type="button" aria-pressed={look === k} onClick={() => { if (look !== k) { setLook(k); saveLook(k); setPlacing(false); setLevel(0); } }} style={{ ...btn, border: 0, borderRadius: 0, ...(look === k ? { background: '#1f6f4a', color: '#fff' } : {}) }}>{l}</button>)}
            </span>
            <button type="button" style={xray ? btnOn : btn} aria-pressed={xray} onClick={() => { setXray(!xray); viewerRef.current?.setXray(!xray); }}>See Inside</button>
            {maxLevel > 1 && <span style={{ display: 'inline-flex', border: '1px solid var(--border-color, #d9d6cc)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-primary, #fff)' }} role="group" aria-label="Level">
              {[0, ...Array.from({ length: maxLevel }, (_, i) => i + 1)].map((n) => <button key={n} type="button" aria-pressed={level === n} onClick={() => setLvl(n)} style={{ ...btn, border: 0, borderRadius: 0, ...(level === n ? { background: '#1f6f4a', color: '#fff' } : {}) }}>{n ? `L${n}` : 'All Levels'}</button>)}
            </span>}
          </div>}
          {!noGl && !touched && <div aria-hidden="true" className="sm-hint" style={{ position: 'absolute', left: '50%', top: 12, transform: 'translateX(-50%)', background: 'rgba(29,31,26,0.78)', color: '#fff', fontSize: 12, padding: '5px 12px', borderRadius: 999, zIndex: 2, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
            <span className="sm-hint-mouse">Drag to orbit · Scroll to zoom · Right-drag to pan</span><span className="sm-hint-touch">Drag to orbit · Pinch to zoom · Two fingers to pan</span>
          </div>}
          <style>{`.sm-hint-touch{display:none} @media (pointer: coarse){ .sm-hint-touch{display:inline} .sm-hint-mouse{display:none} }`}</style>
          <div style={{ position: 'absolute', right: 10, top: 10, fontSize: 10, color: '#3d4038', background: 'rgba(255,255,255,0.75)', padding: '2px 6px', borderRadius: 4, zIndex: 2, maxWidth: '60%', textAlign: 'right' }}>{look === 'illustrated' ? 'Illustrated, drawn to scale' : model.image?.attribution || ''} · 1 unit = 1 m</div>
          {look === 'illustrated' && <SiteModelHud model={model} owner={owner} live={live} unit={u}
            stats={{ active: active.length, leased, vacant, bad: bad.length, leasedPct: active.length ? Math.round(100 * leased / active.length) : 0 }}
            attention={bad} pins={pins} ticketsByUnit={ticketsByUnit}
            onPickUnit={(n) => viewerRef.current?.selectUnit(n)} onPickPin={(p) => viewerRef.current?.flyToPin(p)} />}
        </div>
      </div>
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        {owner && (
          <section>
            <h2 style={h2}>Inventory</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[[active.length, 'Active Units and Stalls'], [`${active.length ? (100 * leased / active.length).toFixed(1) : 0}%`, `Leased (${leased})`], [vacant, 'Vacant, Rentable'], [bad.length, 'Out of Service']].map(([v, l]) => (
                <div key={l} style={{ ...card, padding: '8px 10px' }}><b style={{ display: 'block', fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{v}</b><span style={{ fontSize: 11, color: 'var(--text-muted, #5f6358)' }}>{l}</span></div>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', fontSize: 12, marginTop: 8 }}>
              {legend || [['#5fae7d', 'Leased'], ['#e0b45a', 'Vacant'], ['#d65a4c', 'Out of Service'], ['#ff7a00', 'Selected']].map(([c, l]) => <span key={l}><i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, verticalAlign: -2, marginRight: 5, background: c }} />{l}</span>)}
            </div>
            <div style={{ fontSize: 12, color: live.source === 'cubby' && !live.error ? '#3f8f5f' : 'var(--text-muted, #5f6358)', marginTop: 6 }}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, marginRight: 6, verticalAlign: 0, background: live.source === 'cubby' && !live.error ? '#3f8f5f' : '#b8b4a8' }} />{liveLine}</div>
          </section>
        )}
        {owner && (unplaced.length || live.missing?.length) ? (
          <section style={card}>
            <h2 style={h2}>Not On The Map Yet ({unplaced.length})</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '0 0 6px' }}>Cubby has these units but the model does not place them. Add them to the build config to put them on the map.</p>
            {unplaced.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>{unplaced.map((x) => <li key={x.n}><span style={{ font: `500 12px ui-monospace, Menlo, monospace` }}>{x.n}</span> <span style={{ color: 'var(--text-muted, #5f6358)' }}>{x.w && x.d ? `${x.w} × ${x.d} ft` : ''}{x.group ? ` · ${x.group}` : ''}{x.r === 0 ? ' · out of service' : x.l ? ' · leased' : ' · vacant'}</span></li>)}</ul> : null}
            {live.missing?.length ? <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '8px 0 0' }}>No longer in Cubby ({live.missing.length}): {live.missing.slice(0, 12).join(', ')}{live.missing.length > 12 ? '…' : ''}</p> : null}
          </section>
        ) : null}
        {pending && (
          <section style={card}>
            <h2 style={h2}>New Pin</h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)' }}>{pending.unit ? <>Attached to unit <b>{pending.unit}</b></> : pending.building ? `On ${bldg(pending.building)?.name || pending.building}` : 'On the site'} · {pending.u.toFixed(1)}, {pending.v.toFixed(1)} m</div>
            <form onSubmit={savePin} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              <input id="site-model-pin-title" autoFocus value={pinTitle} onChange={(e) => setPinTitle(e.target.value)} placeholder="What needs attention?" maxLength={120} required style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-color, #d9d6cc)', font: `13px ${FONT}`, background: 'var(--bg-primary, #fff)', color: 'inherit' }} />
              <select id="site-model-pin-cat" value={pinCat} onChange={(e) => setPinCat(e.target.value)} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-color, #d9d6cc)', font: `13px ${FONT}`, background: 'var(--bg-primary, #fff)', color: 'inherit' }}>{PIN_CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <div style={{ display: 'flex', gap: 6 }}><button type="submit" style={btnOn}>Save Pin</button><button type="button" style={btn} onClick={() => setPending(null)}>Cancel</button></div>
            </form>
          </section>
        )}
        {u ? (
          <section style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ font: `500 26px ui-monospace, Menlo, monospace`, letterSpacing: '.02em' }}>{u.n}</div>
              {owner && (u.r === 0 ? <span style={chip('#c43d2f')}>Out of Service</span> : u.l === 1 ? <span style={chip('#3f8f5f')}>Leased</span> : <span style={chip('#c98a1b')}>Vacant</span>)}
            </div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, margin: '8px 0 0' }}>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Type</dt><dd style={{ margin: 0 }}>{unitKindLabel(u)}</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Size</dt><dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{u.w && u.d ? `${u.w} × ${u.d} ft (${(u.w * u.d).toLocaleString()} sq ft)` : u.d ? `${u.d} in. mailbox` : 'not listed'}</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Location</dt><dd style={{ margin: 0 }}>{bldg(u.b)?.name || zone(u.b)?.name || ''}{bldg(u.b)?.floors > 1 ? `, Level ${u.f}` : ''}</dd>
              {u.door && u.k !== 'park' && <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Door</dt><dd style={{ margin: 0 }}>{u.k === 'du' || u.k === 'ccdu' ? `Outside wall${doorSideName(model, u.door) ? `, ${doorSideName(model, u.door)}` : ''}` : 'Hallway'}</dd></>}
              {owner && <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Days vacant</dt><dd style={{ margin: 0 }}>{u.l ? '-' : typeof u.dvac === 'number' ? u.dvac : 'since the last build'}</dd>{u.r === 0 && <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Reason</dt><dd style={{ margin: 0 }}>{reasonLabel(u.why) || 'not given'}{u.note ? ` - ${u.note}` : ''}</dd></>}</>}
              {u.gone ? <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Cubby</dt><dd style={{ margin: 0, color: '#c43d2f' }}>No longer in Cubby's inventory</dd></> : null}
            </dl>
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border-color, #d9d6cc)', paddingTop: 8, fontSize: 13 }}>
              <b>How to Get There</b>
              {steps.length > 1 && <ol aria-label="Route steps" style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0 4px', padding: 0 }}>
                {steps.map((s, i) => <li key={i}><button type="button" onClick={() => viewerRef.current?.flyToStep?.(i)} title={noGl ? s.sub : `Show step ${i + 1} on the map`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border-color, #d9d6cc)', background: 'var(--bg-primary, #fff)', borderRadius: 999, padding: '2px 9px 2px 3px', font: `500 12px ${FONT}`, color: 'inherit', cursor: 'pointer' }}>
                  <span style={{ width: 18, height: 18, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: '#fff', background: s.end ? '#ff7a00' : '#1a73e8' }}>{i + 1}</span>{s.label}</button></li>)}
              </ol>}
              <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>{unitDirections(model, u).map((s, i) => <li key={i} style={{ margin: '3px 0' }}>{s}</li>)}</ol>
            </div>
            {owner && (ticketsByUnit[u.n]?.length ? (
              <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>Tickets at This Unit</b>
                <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>{ticketsByUnit[u.n].map((t) => <li key={t.id}><button type="button" onClick={() => onOpenTicket?.(t)} style={{ ...btn, padding: '4px 8px', fontSize: 12, width: '100%', textAlign: 'left' }}>#{t.id} · {t.title || t.subject || 'Ticket'}</button></li>)}</ul>
              </div>
            ) : null)}
            {renderUnitExtra ? renderUnitExtra(u) : null}
            {owner && pinsEnabled && <div style={{ marginTop: 10 }}><button type="button" style={btn} onClick={() => { const b = bldg(u.b); setPlacing(false); setPending({ u: u.u + u.wu / 2, v: u.v + u.dv / 2, y: b ? +((u.f - 1) * b.height / b.floors).toFixed(2) : 0, unit: u.n, building: u.b }); }}>Add Pin at This Unit</button></div>}
            {/* Per unit (Oct 14 2026): traced units say where their position came from. */}
            {u.tr === 2
              ? <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: 8 }}>Position from the plans; the plans carry no unit numbers, so this number was matched by size - confirm on site.</div>
              : u.tr
              ? <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: 8 }}>Position from the as-built plan.</div>
              : model.layout?.schematic && <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: 8 }}>Position is schematic until the as-built plan is traced.</div>}
          </section>
        ) : building ? (
          <section style={card}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{building.name}</div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, margin: '8px 0 0' }}>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Footprint</dt><dd style={{ margin: 0 }}>{Math.round((building.u[1] - building.u[0]) * 3.281)} × {Math.round((building.v[1] - building.v[0]) * 3.281)} ft</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Height</dt><dd style={{ margin: 0 }}>{Math.round(building.height * 3.281)} ft, {building.floors} level{building.floors > 1 ? 's' : ''}</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Units</dt><dd style={{ margin: 0 }}>{(model.units || []).filter((x) => x.b === building.id).length || 'none matched yet'}</dd>
            </dl>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '8px 0 0' }}>{building.note}</p>
          </section>
        ) : (
          <section style={card}><b>Find Your Unit</b><p style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)', margin: '6px 0 0' }}>Type a unit number above, or tap any unit on the model. Drag to orbit, scroll or pinch to zoom, right-drag or two fingers to pan.</p></section>
        )}
        {owner && (
          <>
            <section>
              <h2 style={h2}>Needs Attention ({bad.length})</h2>
              {bad.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflow: 'auto' }}>{bad.map((x) => <li key={x.n} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}><button type="button" onClick={() => viewerRef.current?.selectUnit(x.n)} style={{ border: 0, background: 'transparent', font: `500 12px ui-monospace, Menlo, monospace`, color: '#1f6f4a', cursor: 'pointer', padding: '2px 4px' }}>{x.n}</button><span style={{ color: 'var(--text-muted, #5f6358)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reasonLabel(x.why) || 'out of service'}{x.note ? ` - ${x.note}` : ''}</span></li>)}</ul> : <div style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)' }}>Every unit is rentable.</div>}
            </section>
            {pinsEnabled && <section>
              <h2 style={h2}>Pins ({pins.length})</h2>
              <div style={{ marginBottom: 6 }}><button type="button" style={placing ? btnOn : btn} onClick={() => setPlacing(!placing)}>{placing ? 'Click the model…' : 'Add Pin'}</button></div>
              {pins.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}>{pins.map((p) => (
                <li key={p.id} style={{ display: 'flex', gap: 6, fontSize: 12, alignItems: 'center', opacity: p.status === 'done' ? 0.55 : 1 }}>
                  <button type="button" onClick={() => viewerRef.current?.flyToPin(p)} style={{ border: 0, background: 'transparent', font: `500 12px ui-monospace, Menlo, monospace`, color: '#1f6f4a', cursor: 'pointer', padding: '2px 4px', flexShrink: 0 }}>{p.unit || p.building || 'site'}</button>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted, #5f6358)', textDecoration: p.status === 'done' ? 'line-through' : 'none' }}>{p.title} · {p.category}</span>
                  <button type="button" aria-label={p.status === 'done' ? 'Reopen pin' : 'Mark pin done'} title={p.status === 'done' ? 'Reopen' : 'Done'} onClick={() => onTogglePin?.(p)} style={{ ...btn, padding: '1px 7px', fontSize: 12 }}>✓</button>
                  <button type="button" aria-label="Remove pin" onClick={() => onRemovePin?.(p)} style={{ ...btn, padding: '1px 7px', fontSize: 12 }}>×</button>
                </li>))}</ul> : <div style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)' }}>No pins yet. Drop one on a unit, a building or anywhere on the site.</div>}
            </section>}
            {model.layout?.flags?.length ? <section><h2 style={h2}>Layout Notes</h2><ul style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', paddingLeft: 16, margin: 0 }}>{model.layout.flags.map((f, i) => <li key={i} style={{ margin: '3px 0' }}>{f}</li>)}<li style={{ margin: '3px 0' }}>Building letters were matched to footprints from imagery and unit sizes; every assignment is marked inferred in the build config.</li></ul></section> : null}
          </>
        )}
        {(model.sources || []).length > 0 && <section><h2 style={h2}>Sources</h2><ul style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', paddingLeft: 16, margin: 0 }}>{(model.sources || []).map((s, i) => <li key={i} style={{ margin: '3px 0' }}>{s}</li>)}</ul></section>}
      </aside>
    </div>
  );
}

export const siteModelImages = (id) => ({ detail: `/site-models/${id}/ground.jpg`, wide: `/site-models/${id}/ground-wide.jpg` });
