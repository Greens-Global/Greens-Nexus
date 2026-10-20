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
//
// Oct 20 2026 (Visesh's review of the rebuild - "this looks worse than the normal one"):
//   Illustrated is the default look again; Satellite stays a button.
//
// Oct 20 2026 (Visesh: the satellite view "looks so flat and I want reality"):
//   Satellite is real terrain draped with the photo (siteModelGround.js), and
//   the look is a View dropdown (dropdowns, not pills). "Realistic 3D" (Google
//   Photorealistic 3D Tiles) is offered to owners only, and only when the build
//   carries VITE_GOOGLE_MAPS_KEY; the customer page stays on Satellite (Google
//   bills per session). Where Google has no 3D coverage it falls back to Satellite.
//   statusOf(u)   'leased' | 'vacant' | 'bad' - ONE answer for the badge, the
//                 inventory tiles, the legend counts and Needs Attention (Ops
//                 passes the rent roll's word). Default: a lease wins over
//                 Cubby's unrentable flag (ACTIVE_LEASE is not out of service).
//   fill          the map fills the screen height and the panel beside it is
//                 the same height and scrolls on its own (Ops Site Map); the
//                 long lists fold away (Needs Attention, Not on the Map, Sources).
//
// Oct 20 2026 (Visesh: "this looks glitchy when you have to scroll down to see
// options"): in `fill` mode every map control sits ON the map - the one search
// (SiteMapSearch, top-left), the screen's own controls + View (`toolbar`,
// top-right), the camera (bottom-left) and the legend (bottom-right, with
// `legendHint` behind an info button). The map and the panel are exactly the
// height left under them, re-measured whenever the page above changes, and
// the canvas is out of flow so it can never stretch the grid past the screen.
// The panel puts the picked unit first (Inventory folds to one line), opens
// Needs Attention when nothing is picked, and takes `asideExtra`. More fill-only
// props: remoteSearch(q) / onRemoteHit(hit) (Cubby lookup in the map search),
// placeName. Without `fill` (Asset Management, the customer pages) nothing changes.
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Globe, Info, X } from 'lucide-react';
import { createSiteModelViewer, unitKindLabel, unitDirections, doorSideName, reasonLabel, routeSteps } from './siteModelViewer.js';
import { planRoute } from './siteModelRoute.js';
import { SiteModelPlan2D } from './SiteModelPlan2D.jsx';
import { formatDateTime, formatTime } from '../lib/datetime.js';
import { SiteModelHud } from './SiteModelHud.jsx';
import { SiteMapSearch } from './SiteMapSearch.jsx';
import { normalizeQuery } from './unitQuery.js';
import SectionPicker from '../operations/SectionPicker.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { PHONE_QUERY } from '../lib/keys.js';

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
// Fill mode (Ops Site Map): the grid rows can never grow past the measured
// height, the canvas is out of flow, and every control floats on the map.
const FILL_CSS = `
.sm-fill{grid-template-columns:minmax(0,1fr) 360px;grid-template-rows:minmax(0,1fr)}
@media (max-width:1500px){.sm-fill{grid-template-columns:minmax(0,1fr) 340px}}
.sm-fill .sm-main,.sm-fill .sm-aside,.sm-fill .sm-stage{min-height:0}
.sm-fill .sm-stage{container:smstage/inline-size}
.sm-fill .sm-stage>canvas{position:absolute;inset:0}
.sm-fill .sm-aside{padding:0 14px;border:1px solid var(--border-color,#d9d6cc);border-radius:12px;background:var(--bg-primary,#fff);scrollbar-width:thin}
.sm-fill .sm-aside>:first-child{border-top:0 !important}
.sm-tail{flex:1 0 auto;display:flex;flex-direction:column;justify-content:flex-end}
.sm-grow{border-top:1px solid var(--border-color,#d9d6cc)}
.sm-grow[data-open="true"]{flex:1 1 0;min-height:200px;display:flex;flex-direction:column}
.sm-grow-head{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:11px 0;border:0;background:transparent;color:inherit;font:600 13px 'Inter',system-ui,sans-serif;text-align:left;cursor:pointer}
.sm-grow-head:focus-visible{outline:2px solid #2a78d6;outline-offset:1px}
.sm-grow-head .sm-chev{color:var(--text-muted,#5f6358);font-size:11px}
.sm-grow[data-open="true"] .sm-chev{transform:rotate(90deg)}
.sm-grow-body{flex:1 1 0;min-height:0;overflow-y:auto;margin:0 -6px 10px;padding:0 6px;scrollbar-width:thin;overscroll-behavior:contain}
.sm-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:11px 0;font-size:12.5px;color:var(--text-muted,#5f6358)}
.sm-strip b{color:var(--text-primary,#1d1f1a);font-weight:600}
.sm-dot{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:5px;vertical-align:1px}
.sm-icon-btn{display:inline-grid;place-items:center;width:32px;height:32px;flex:none;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;padding:0}
.sm-icon-btn:hover{background:var(--bg-secondary,#eef0ec)}
.sm-icon-btn:focus-visible,.sm-cam:focus-visible,.sm-cam-select:focus-visible{outline:2px solid #2a78d6;outline-offset:1px}
.sm-ov{position:absolute;z-index:3;background:rgba(255,255,255,.96);color:#1d1f1a;border:1px solid rgba(20,40,30,.08);border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.12);font:400 13px/1.3 'Inter',system-ui,sans-serif}
.sm-ov .sm-icon-btn:hover{background:#eef0ec}
.sm-ov-tl{position:absolute;z-index:4;top:10px;left:10px;width:min(300px,calc(100% - 20px))}
.sm-ov-tr{top:10px;right:10px;display:flex;align-items:center;gap:2px;padding:3px}
.sm-ov-tr>*+*{border-left:1px solid #e3e1da;padding-left:2px}
.sm-ov-bl{left:10px;bottom:10px;display:flex;align-items:center;padding:3px;max-width:calc(100% - 20px);overflow-x:auto;scrollbar-width:none}
.sm-ov-bl::-webkit-scrollbar{display:none}
.sm-cam{height:30px;padding:0 11px;border:0;border-radius:7px;background:transparent;color:#1d1f1a;font:500 13px 'Inter',system-ui,sans-serif;white-space:nowrap;cursor:pointer;flex:none}
.sm-cam:hover{background:#eef0ec}
.sm-cam[data-on="true"]{background:#1f6f4a;color:#fff}
.sm-cam .sm-short{display:none}
.sm-cam-select{height:30px;border:0;border-radius:7px;background:transparent;color:#1d1f1a;font:500 13px 'Inter',system-ui,sans-serif;padding:0 6px;cursor:pointer;flex:none}
.sm-div{width:1px;height:18px;background:#e3e1da;margin:0 3px;flex:none}
.sm-ov-br{position:absolute;z-index:3;right:10px;bottom:10px;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:min(600px,calc(100% - 20px));pointer-events:none}
.sm-ov-br>*{pointer-events:auto}
.sm-ov-br .sm-ov{position:relative}
.sm-legend{display:flex;align-items:center;gap:4px;padding:5px 4px 5px 11px;font-size:12px;min-height:38px;box-sizing:border-box}
.sm-legend-items{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}
.sm-legend-items>span{white-space:nowrap}
.sm-sw{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.sm-legend-info{position:relative;display:inline-flex}
.sm-legend-info .sm-icon-btn{width:28px;height:28px;color:#5f6358}
.sm-legend-tip{position:absolute !important;bottom:calc(100% + 10px);right:-4px;width:260px;padding:9px 11px;font-size:12px;line-height:1.45}
.sm-credit{font-size:10px;line-height:1.35;color:#3d4038;background:rgba(255,255,255,.72);padding:1px 6px;border-radius:4px;max-width:100%;text-align:right;overflow-wrap:anywhere}
.sm-ov .ops-section--map{gap:0}
.sm-ov .ops-section--map .ops-facility-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sm-ov .ops-section--map .ops-facility-box select{height:30px;min-width:0;width:auto;max-width:200px;border-color:transparent;background:transparent;color:#1d1f1a;font-weight:500}
.sm-ov .ops-section--map .ops-facility-box select option{color:#1d1f1a;background:#fff}
.sm-ov .ops-section--map .ops-facility-box svg{color:#5f6358}
.sm-ov .ops-section--map .ops-facility-box select:hover{background:#eef0ec}
.sm-search{position:relative;margin:0}
.sm-search-box{display:flex;align-items:center;gap:8px;height:38px;padding:0 6px 0 11px;background:rgba(255,255,255,.97);color:#5f6358;border:1px solid rgba(20,40,30,.1);border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.12);cursor:text;box-sizing:border-box}
.sm-search-box:focus-within{border-color:#2a78d6}
.sm-search-box input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#1d1f1a;font:400 13.5px 'Inter',system-ui,sans-serif;padding:0}
.sm-search-box input::placeholder{color:#7a7f75}
.sm-search-x{display:inline-grid;place-items:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:#5f6358;cursor:pointer;padding:0}
.sm-search-x:hover{background:#eef0ec}
.sm-search-pop{position:absolute;top:calc(100% + 6px);left:0;width:max(100%,340px);max-width:calc(100cqw - 20px);max-height:min(360px,55cqh);overflow-y:auto;background:#fff;color:#1d1f1a;border:1px solid rgba(20,40,30,.1);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.16);padding:4px 0;font:400 13px 'Inter',system-ui,sans-serif}
.sm-sr-list{list-style:none;margin:0;padding:0}
.sm-sr-group{padding:8px 12px 4px;font-size:12px;font-weight:600;color:#5f6358}
.sm-sr-row{display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer}
.sm-sr-row[data-active="true"]{background:#eef3fb}
.sm-sr-row[data-off="true"]{cursor:default}
.sm-sr-unit{font:600 12.5px ui-monospace,Menlo,monospace;min-width:48px}
.sm-sr-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-sr-muted{color:#6b7068}
.sm-sr-word{font-size:12px;color:#5f6358;white-space:nowrap}
.sm-sr-link{font-size:12px;color:#1f6f4a;white-space:nowrap;display:inline-flex;align-items:center;gap:3px}
.sm-sr-msg{margin:4px 8px;padding:7px 9px;border-radius:7px;background:#fff6e5;color:#7a4a00;font-size:12.5px}
.sm-sr-note{margin:0;padding:8px 12px;font-size:12.5px;color:#6b7068}
@container smstage (max-width:1000px){
  .sm-ov-br{bottom:52px}
}
@container smstage (max-width:680px){
  .sm-ov-tl{width:calc(100% - 20px)}
  .sm-ov-tr{top:56px;left:10px;right:10px}
  .sm-ov-tr .ops-section--map{flex:1 1 0;min-width:0}
  .sm-ov .ops-section--map .ops-facility-box select{padding:0 22px 0 28px}
  .sm-ov .ops-section--map .ops-facility-icon{left:8px} .sm-ov .ops-section--map .ops-facility-chev{right:6px}
  .sm-ov .ops-section--map .ops-facility-box,.sm-ov .ops-section--map .ops-facility-box select{width:100%;max-width:none}
  .sm-cam .sm-long{display:none} .sm-cam .sm-short{display:inline}
  .sm-ov-br{bottom:52px}
}
@container smstage (max-width:520px){
  .sm-legend-items{gap:4px 8px}
  .sm-credit{font-size:9px}
}
@media (max-width:900px){.sm-fill{grid-template-rows:none} .sm-tail,.sm-grow[data-open="true"]{flex:none;min-height:0} .sm-grow-body{flex:none;max-height:320px}}
@media (pointer:coarse){
  .sm-cam,.sm-cam-select{height:42px}
  .sm-cam{padding:0 13px}
  .sm-div{height:24px}
  .sm-ov .ops-section--map .ops-facility-box select{height:42px}
  .sm-legend-info .sm-icon-btn,.sm-icon-btn{width:42px;height:42px}
  .sm-legend{min-height:46px}
  .sm-search-box{height:44px}
  .sm-search-x{width:40px;height:40px}
  .sm-sr-row{min-height:44px}
  @container smstage (max-width:1000px){ .sm-ov-br{bottom:64px} }
  @container smstage (max-width:680px){ .sm-ov-tr{top:62px} }
}
`;

const LOOK_KEY = 'nexus.siteModel.look';
function readLook() { try { const v = localStorage.getItem(LOOK_KEY); return v === 'satellite' || v === 'photoreal' ? v : 'illustrated'; } catch { return 'illustrated'; } }
// The Google key is a browser key restricted to the Nexus domains (siteModelPhotoreal.js).
const PHOTOREAL_KEY = !!(import.meta.env && import.meta.env.VITE_GOOGLE_MAPS_KEY);
const ELEVATION_CREDIT = 'Elevation: AWS Terrain Tiles (USGS, others)';
function saveLook(v) { try { localStorage.setItem(LOOK_KEY, v); } catch { /* private window: the choice just is not remembered */ } }

/** A unit's occupancy from the model's live flags: a lease wins over the
 *  rentability flag (Cubby marks a leased unit unrentable with ACTIVE_LEASE). */
export function defaultStatus(u) { return u.l === 1 ? 'leased' : u.r === 0 ? 'bad' : 'vacant'; }
const STATUS_WORD = { leased: 'Leased', vacant: 'Vacant', bad: 'Out of Service' };
const STATUS_COLOR = { leased: '#3f8f5f', vacant: '#c98a1b', bad: '#c43d2f' };
const SWATCH = { leased: '#5fae7d', vacant: '#e0b45a', bad: '#d65a4c' };

/** A folding section of the side panel - closed by default, the count in its title. */
function Fold({ title, count, open = false, flat = false, children }) {
  return (
    <details open={open} className="sm-fold" style={flat ? { borderTop: '1px solid var(--border-color, #d9d6cc)' } : { ...card, padding: 0 }}>
      <summary style={{ padding: flat ? '11px 0' : '9px 12px', cursor: 'pointer', font: `600 13px ${FONT}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>{count != null ? `${title} (${count})` : title}</span><span aria-hidden="true" className="sm-chev" style={{ color: 'var(--text-muted, #5f6358)', fontSize: 11 }}>▶</span>
      </summary>
      <div style={{ padding: flat ? '0 0 12px' : '0 12px 12px' }}>{children}</div>
    </details>
  );
}

/** The one fold of the Ops panel that fills the room left under everything
 *  else and scrolls on its own (Needs Attention): no Show All, no blank card
 *  under the last section. The caller keys it on `open`, so it re-opens /
 *  closes when its default changes (a unit picked or cleared). */
function GrowFold({ title, count, open = false, children }) {
  const [on, setOn] = useState(open);
  const id = useId();
  return (
    <div className="sm-grow" data-open={on}>
      <button type="button" className="sm-grow-head" aria-expanded={on} aria-controls={id} onClick={() => setOn((o) => !o)}>
        <span>{count != null ? `${title} (${count})` : title}</span><span aria-hidden="true" className="sm-chev">▶</span>
      </button>
      {on && <div id={id} className="sm-grow-body">{children}</div>}
    </div>
  );
}

/** Needs Attention rows: the first few, then Show All - a long list (50 at
 *  Temecula) must not push the rest of the panel a page down. */
const ATTN_FIRST = 6;
function AttentionList({ units, onPick, scroll, every = false }) {
  const [more, setAll] = useState(false); const all = every || more;
  if (!units.length) return <div style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)' }}>Every unit is rentable.</div>;
  const shown = all ? units : units.slice(0, ATTN_FIRST);
  return (
    <>
      <ul className="sm-attn" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: scroll && all ? 260 : undefined, overflow: scroll && all ? 'auto' : undefined }}>
        {shown.map((x) => <li key={x.n}><button type="button" className="sm-attn-row" onClick={() => onPick(x.n)}>
          <span className="sm-attn-unit">{x.n}</span><span className="sm-attn-why">{reasonLabel(x.why) || 'Out of service'}{x.note ? ` - ${x.note}` : ''}</span>
        </button></li>)}
      </ul>
      {units.length > ATTN_FIRST && !every && <button type="button" className="sm-attn-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'Show Fewer' : `Show All ${units.length}`}</button>}
    </>
  );
}

/** Ops panel: the folds after the unit card share the room left at the foot
 *  of the panel (Needs Attention grows into it; folded, they sit at the bottom). */
const TailWrap = ({ tail, children }) => (tail ? <div className="sm-tail">{children}</div> : <>{children}</>);

export { normalizeQuery };

export function SiteModelPanel({ model, mode = 'customer', images, pins = [], tickets = [], onAddPin, onRemovePin, onTogglePin, onOpenTicket, height = 560, initialUnit = '', unitColors = null, legend = null, hoverInfo = null, renderUnitExtra = null, markers = null, pinsEnabled = true, hideSearch = false, fitRoute = false, statusOf = null, fill = false, toolbar = null, legendHint = '', asideExtra = null, remoteSearch = null, onRemoteHit = null, placeName = '' }) {
  const stageRef = useRef(null); const viewerRef = useRef(null);
  const [selected, setSelected] = useState(() => initialUnit || null); const [building, setBuilding] = useState(null);
  const [query, setQuery] = useState(''); const [notFound, setNotFound] = useState('');
  const [xray, setXray] = useState(false); const [level, setLevel] = useState(0);
  const [placing, setPlacing] = useState(false); const [pending, setPending] = useState(null);
  const [pinTitle, setPinTitle] = useState(''); const [pinCat, setPinCat] = useState('maintenance');
  const [hover, setHover] = useState(null); const [noGl, setNoGl] = useState(false);
  const [lookPref, setLook] = useState(readLook);
  const [photoFailed, setPhotoFailed] = useState(false); const [googleCredit, setGoogleCredit] = useState('');
  // Realistic 3D only for owners with a key, and not where it already failed to load.
  const canPhoto = PHOTOREAL_KEY && mode === 'owner' && !photoFailed;
  const look = lookPref === 'photoreal' && !canPhoto ? 'satellite' : lookPref;
  const [touched, setTouched] = useState(false);
  const colorsRef = useRef(unitColors); colorsRef.current = unitColors;
  const selectedRef = useRef(null); const xrayRef = useRef(false);
  useEffect(() => { selectedRef.current = selected; xrayRef.current = xray; }, [selected, xray]);
  const byName = useMemo(() => Object.fromEntries((model.units || []).map((u) => [u.n, u])), [model]);
  const ticketsByUnit = useMemo(() => { const m = {}; tickets.forEach((t) => { const k = normalizeQuery(t.location || ''); if (k && byName[k]) (m[k] = m[k] || []).push(t); }); return m; }, [tickets, byName]);
  const maxLevel = useMemo(() => Math.max(1, ...(model.buildings || []).map((b) => b.floors || 1)), [model]);
  // See Inside only means something where units sit inside a real building
  // (not open stalls tagged with a section letter, e.g. Temecula).
  const hasInterior = useMemo(() => {
    const ids = new Set((model.buildings || []).filter((b) => b.kind !== 'office').map((b) => b.id));
    return (model.units || []).some((u) => ids.has(u.b));
  }, [model]);
  const statusFn = statusOf || defaultStatus;
  // fill: the map + panel take the rest of the screen below where they start
  // (min 380px). Re-measured on resize, when anything on the page changes size
  // (a notice above, a wrapped line, a sidebar collapse) and once the fonts are
  // in; only a change of 2px or more is stored, so it settles in one pass.
  const rootRef = useRef(null); const asideRef = useRef(null); const [fillH, setFillH] = useState(600);
  useLayoutEffect(() => {
    if (!fill || !rootRef.current) return undefined;
    const size = () => {
      const el = rootRef.current; if (!el || window.innerWidth <= 900) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // the page's own padding under the map (the app shell pads its content)
      let below = 0;
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        below += (parseFloat(cs.marginBottom) || 0) + (n === el ? 0 : (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0));
      }
      const h = Math.max(380, Math.floor(window.innerHeight - top - Math.max(12, below)));
      setFillH((p) => (Math.abs(p - h) >= 2 ? h : p));
    };
    size(); window.addEventListener('resize', size);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
    if (ro) { ro.observe(document.documentElement); if (rootRef.current.parentElement) ro.observe(rootRef.current.parentElement); }
    let live = true; document.fonts?.ready?.then(() => { if (live) size(); });
    return () => { live = false; window.removeEventListener('resize', size); ro?.disconnect(); };
  }, [fill]);
  // The drag hint goes after five seconds even if nobody touches the map.
  useEffect(() => { if (!fill) return undefined; const t = setTimeout(() => setTouched(true), 5000); return () => clearTimeout(t); }, [fill]);
  const [hintOpen, setHintOpen] = useState(false);

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
        onAttribution: (c) => setGoogleCredit(c),
        onPhotorealFallback: () => setPhotoFailed(true),
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
  const phone = useIsMobile(PHONE_QUERY);
  useEffect(() => {
    if (!fill || !selected || !asideRef.current) return undefined;
    asideRef.current.scrollTop = 0;
    if (!phone) return undefined;
    // Phone: the panel stacks under a tall map, so the card would open below the
    // fold. Once the camera has started its flight, scroll so the card's top sits
    // a little under mid-screen - the unit stays in sight above it.
    const t = setTimeout(() => {
      const card = asideRef.current?.querySelector('.sm-unit'); if (!card) return;
      const top = card.getBoundingClientRect().top; const vh = window.innerHeight;
      if (top > vh * 0.6 || top < 0) window.scrollBy({ top: top - vh * 0.42, behavior: 'smooth' });
    }, 350);
    return () => clearTimeout(t);
  }, [fill, selected, phone]);
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
  const leased = active.filter((x) => statusFn(x) === 'leased').length; const bad = active.filter((x) => statusFn(x) === 'bad'); const vacant = active.filter((x) => statusFn(x) === 'vacant').length;
  const leasedPct = active.length ? (100 * leased / active.length).toFixed(1) : '0';
  const pickHere = (n) => { const ok = viewerRef.current ? viewerRef.current.selectUnit(n) : !!byName[n]; if (ok && !viewerRef.current) { setSelected(n); setBuilding(null); } return ok; };
  const clearPick = () => { if (viewerRef.current) viewerRef.current.clearSelection(); else setSelected(null); };
  const setView = (k) => { if (look !== k) { setLook(k); saveLook(k); setPlacing(false); setLevel(0); } };
  const viewOptions = [...(canPhoto ? [{ value: 'photoreal', label: 'Realistic 3D' }] : []), { value: 'satellite', label: 'Satellite' }, { value: 'illustrated', label: 'Illustrated' }];
  const credit = look === 'illustrated' ? 'Illustrated, drawn to scale' : look === 'photoreal' ? `Map data: ${googleCredit || 'Google'}` : `${model.image?.attribution || 'Imagery: Esri'} · ${ELEVATION_CREDIT}`;
  const flat = fill && owner;   // the Ops panel: one card, sections divided by lines
  const box = flat ? { padding: '12px 0', borderTop: '1px solid var(--border-color, #d9d6cc)' } : card;
  const liveOk = live.source === 'cubby' && !live.error;
  const sources = (model.sources || []).length > 0 && <Fold title="Sources" flat={flat}><ul style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', paddingLeft: 16, margin: 0 }}>{(model.sources || []).map((s, i) => <li key={i} style={{ margin: '3px 0' }}>{s}</li>)}</ul></Fold>;
  const attnOpen = !u && !building && !pending && !phone;
  const savePin = (e) => { e.preventDefault(); if (!pending || !pinTitle.trim()) return; onAddPin?.({ ...pending, title: pinTitle.trim(), category: pinCat }); setPending(null); setPinTitle(''); };

  return (
    <div ref={rootRef} style={{ display: 'grid', gridTemplateColumns: fill ? undefined : 'minmax(0, 1fr) 320px', gap: 14, fontFamily: FONT, '--sm-h': `${fillH}px` }} className={`site-model${fill ? ' sm-fill' : ''}`}>
      <style>{`.site-model{--sm-cols:1} .sm-fold>summary{list-style:none} .sm-fold>summary::-webkit-details-marker{display:none} .sm-fold[open] .sm-chev{transform:rotate(90deg)}
        .sm-fill{height:var(--sm-h)} .sm-fill .sm-main{display:flex;flex-direction:column;height:100%} .sm-fill .sm-stage{flex:1;min-height:0}
        .sm-fill .sm-aside{height:100%;overflow-y:auto;padding-right:4px;overscroll-behavior:contain}
        .sm-attn-row{display:flex;align-items:center;gap:10px;width:100%;min-height:28px;padding:3px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:400 12px 'Inter',system-ui,sans-serif;text-align:left;cursor:pointer}
        .sm-attn-row:hover{background:var(--bg-secondary,#eef0ec)} .sm-attn-row:focus-visible,.sm-attn-more:focus-visible{outline:2px solid #2a78d6;outline-offset:1px}
        .sm-attn-unit{font:500 12px ui-monospace,Menlo,monospace;color:#1f6f4a;flex:none;min-width:44px}
        .sm-attn-why{color:var(--text-muted,#5f6358);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
        .sm-attn-more{margin-top:6px;border:0;background:transparent;color:#1f6f4a;font:600 12.5px 'Inter',system-ui,sans-serif;padding:4px 6px;border-radius:6px;cursor:pointer}
        @media (pointer: coarse){ .sm-attn-row{min-height:44px;font-size:13px} .sm-attn-unit{font-size:13px} .sm-attn-more{min-height:44px} }
        @media (max-width: 900px){ .site-model{grid-template-columns:1fr !important} .sm-fill{height:auto} .sm-fill .sm-main{height:auto} .sm-fill .sm-stage{flex:none;height:62vh;min-height:360px} .sm-fill .sm-aside{height:auto;overflow:visible;padding-right:0} }`}</style>
      {fill && <style>{FILL_CSS}</style>}
      <div style={{ minWidth: 0 }} className="sm-main">
        {!hideSearch && !fill && <form onSubmit={find} style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <input id="site-model-search" value={query} onChange={(e) => { setQuery(e.target.value); setNotFound(''); }} placeholder="Find a unit, e.g. C214" aria-label="Unit number" list="site-model-units"
            style={{ flex: 1, minWidth: 160, padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border-color, #d9d6cc)', font: `500 14px ui-monospace, Menlo, monospace`, textTransform: 'uppercase', background: 'var(--bg-primary, #fff)', color: 'inherit' }} />
          <UnitList units={model.units || []} />
          <button type="submit" style={btnOn}>Find</button>
          {notFound && <span role="alert" style={{ fontSize: 12, color: '#c43d2f', alignSelf: 'center' }}>{notFound}</span>}
        </form>}
        <div ref={stageRef} className="sm-stage" onPointerDown={() => setTouched(true)} onWheel={() => setTouched(true)} style={{ position: 'relative', height: fill ? undefined : typeof height === 'number' && look === 'illustrated' ? height + 80 : height, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-color, #d9d6cc)', background: 'var(--bg-secondary, #dfe6e9)' }}>
          {hover && (() => { const hu = byName[hover.n]; const info = hu && hoverInfo ? hoverInfo(hu) : '';
            return <div role="tooltip" style={{ position: 'absolute', left: hover.x + 12, top: hover.y - 30, pointerEvents: 'none', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #d9d6cc)', padding: '4px 8px', borderRadius: 8, boxShadow: '0 4px 14px rgba(0,0,0,0.12)', zIndex: 2, lineHeight: 1.35, maxWidth: 260 }}>
              <div style={{ font: `600 12px ui-monospace, Menlo, monospace` }}>{hover.n}{hover.f > 1 ? ` · L${hover.f}` : ''}{hu?.w && hu?.d ? <span style={{ font: `400 11px ${FONT}`, color: 'var(--text-muted, #5f6358)' }}> · {hu.w} × {hu.d} ft</span> : null}</div>
              {owner && hu && <div style={{ fontSize: 11, color: 'var(--text-muted, #5f6358)' }}>{STATUS_WORD[statusFn(hu)]}</div>}
              {info ? <div style={{ fontSize: 11, fontWeight: 600 }}>{info}</div> : null}
            </div>; })()}
          {placing && <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #d9d6cc)', padding: '5px 12px', borderRadius: 999, fontSize: 12, zIndex: 2 }}>Click a unit, a building or the ground to place the pin</div>}
          {noGl && <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
            <SiteModelPlan2D model={model} mode={mode} colors={owner ? unitColors : null} selected={selected} route={plan2d} onSelect={(x) => { setSelected(x.n); setBuilding(null); setQuery(x.n); setNotFound(''); }} />
            <div role="status" style={{ position: 'absolute', left: 10, top: fill ? undefined : 10, bottom: fill ? 10 : undefined, fontSize: 12, background: 'rgba(255,255,255,0.9)', padding: '3px 8px', borderRadius: 6, color: '#5f6358' }}>Flat plan - the 3D view is not available on this device.</div>
          </div>}
          {!noGl && !fill && <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, flexWrap: 'wrap', zIndex: 2 }}>
            <button type="button" style={btn} onClick={() => { viewerRef.current?.resetView?.(); setLevel(0); }} title="Back to the whole site">Reset View</button>
            {[['overview', 'Overview'], ['plan', 'Plan'], ['gate', 'From Gate']].map(([k, l]) => <button key={k} type="button" style={btn} onClick={() => viewerRef.current?.view(k)}>{l}</button>)}
            <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 4px 0 10px', cursor: 'default' }}>
              <span>View</span>
              <select aria-label="View" value={look} onChange={(e) => { const k = e.target.value; if (look !== k) { setLook(k); saveLook(k); setPlacing(false); setLevel(0); } }}
                style={{ font: `500 13px ${FONT}`, border: 0, background: 'transparent', color: 'inherit', padding: '6px 2px', cursor: 'pointer' }}>
                {canPhoto && <option value="photoreal">Realistic 3D</option>}
                <option value="satellite">Satellite</option>
                <option value="illustrated">Illustrated</option>
              </select>
            </label>
            {hasInterior && <button type="button" style={xray ? btnOn : btn} aria-pressed={xray} title="Open the buildings to see the units inside" onClick={() => { setXray(!xray); viewerRef.current?.setXray(!xray); }}>See Inside</button>}
            {maxLevel > 1 && <span style={{ display: 'inline-flex', border: '1px solid var(--border-color, #d9d6cc)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-primary, #fff)' }} role="group" aria-label="Level">
              {[0, ...Array.from({ length: maxLevel }, (_, i) => i + 1)].map((n) => <button key={n} type="button" aria-pressed={level === n} onClick={() => setLvl(n)} style={{ ...btn, border: 0, borderRadius: 0, ...(level === n ? { background: '#1f6f4a', color: '#fff' } : {}) }}>{n ? `L${n}` : 'All Levels'}</button>)}
            </span>}
          </div>}
          {!noGl && !touched && <div aria-hidden="true" className="sm-hint" style={{ position: 'absolute', left: '50%', top: fill ? '50%' : 12, transform: fill ? 'translate(-50%, -50%)' : 'translateX(-50%)', background: 'rgba(29,31,26,0.78)', color: '#fff', fontSize: 12, padding: '5px 12px', borderRadius: 999, zIndex: 2, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
            <span className="sm-hint-mouse">Drag to orbit · Scroll to zoom · Right-drag to pan</span><span className="sm-hint-touch">Drag to orbit · Pinch to zoom · Two fingers to pan</span>
          </div>}
          <style>{`.sm-hint-touch{display:none} @media (pointer: coarse){ .sm-hint-touch{display:inline} .sm-hint-mouse{display:none} }`}</style>
          {!fill && <div style={{ position: 'absolute', right: 10, top: 10, fontSize: 10, color: '#3d4038', background: 'rgba(255,255,255,0.75)', padding: '2px 6px', borderRadius: 4, zIndex: 2, maxWidth: '60%', textAlign: 'right' }}>{look === 'illustrated' ? 'Illustrated, drawn to scale' : look === 'photoreal' ? `Map data: ${googleCredit || 'Google'}` : `${model.image?.attribution || 'Imagery: Esri'} · ${ELEVATION_CREDIT}`} · 1 unit = 1 m</div>}
          {fill && <>
            <div className="sm-ov-tl">
              <SiteMapSearch units={model.units || []} placeName={placeName} statusWord={owner ? (x) => STATUS_WORD[statusFn(x)] : null}
                onPickUnit={pickHere} unplaced={unplaced} remoteSearch={owner ? remoteSearch : null} onRemoteHit={onRemoteHit} />
            </div>
            <div className="sm-ov sm-ov-tr">
              {toolbar}
              <SectionPicker label="View" icon={Globe} value={look} onChange={setView} options={viewOptions} className="ops-section--map" />
            </div>
            {!noGl && <div className="sm-ov sm-ov-bl" role="group" aria-label="Camera">
              <button type="button" className="sm-cam" onClick={() => { viewerRef.current?.resetView?.(); setLevel(0); }} title="Back to the whole site" aria-label="Reset View"><span className="sm-long">Reset View</span><span className="sm-short" aria-hidden="true">Reset</span></button>
              {[['overview', 'Overview', 'Overview'], ['plan', 'Plan', 'Plan'], ['gate', 'From Gate', 'Gate']].map(([k, l, sh]) => (
                <button key={k} type="button" className="sm-cam" onClick={() => viewerRef.current?.view(k)} aria-label={l}><span className="sm-long">{l}</span><span className="sm-short" aria-hidden="true">{sh}</span></button>
              ))}
              {hasInterior && <><span className="sm-div" aria-hidden="true" /><button type="button" className="sm-cam" data-on={xray} aria-pressed={xray} title="Open the buildings to see the units inside" onClick={() => { setXray(!xray); viewerRef.current?.setXray(!xray); }}>See Inside</button></>}
              {maxLevel > 1 && <><span className="sm-div" aria-hidden="true" /><select className="sm-cam-select" aria-label="Level" value={level} onChange={(e) => setLvl(Number(e.target.value))}>
                {[0, ...Array.from({ length: maxLevel }, (_, i) => i + 1)].map((n) => <option key={n} value={n}>{n ? `Level ${n}` : 'All Levels'}</option>)}
              </select></>}
            </div>}
            <div className="sm-ov-br">
              {(legend || owner) && <div className="sm-ov sm-legend">
                <div className="sm-legend-items">{legend || ['leased', 'vacant', 'bad'].map((k) => <span key={k}><i className="sm-sw" style={{ background: SWATCH[k] }} />{STATUS_WORD[k]}</span>)}</div>
                {legendHint && <span className="sm-legend-info">
                  <button type="button" className="sm-icon-btn" aria-label="About This Layer" aria-expanded={hintOpen} title={legendHint}
                    onClick={() => setHintOpen((o) => !o)} onBlur={() => setHintOpen(false)}><Info size={14} aria-hidden="true" /></button>
                  {hintOpen && <span role="tooltip" className="sm-ov sm-legend-tip">{legendHint}</span>}
                </span>}
              </div>}
              <div className="sm-credit">{credit} · <span style={{ whiteSpace: 'nowrap' }}>1 unit = 1 m</span></div>
            </div>
          </>}
          {look === 'illustrated' && <SiteModelHud compact={fill} model={model} owner={owner} live={live} unit={u}
            stats={{ active: active.length, leased, vacant, bad: bad.length, leasedPct: active.length ? Math.round(100 * leased / active.length) : 0 }}
            attention={bad} pins={pins} ticketsByUnit={ticketsByUnit} pinsEnabled={pinsEnabled}
            onPickUnit={(n) => viewerRef.current?.selectUnit(n)} onPickPin={(p) => viewerRef.current?.flyToPin(p)} />}
        </div>
      </div>
      <aside ref={asideRef} style={{ display: 'flex', flexDirection: 'column', gap: flat ? 0 : 12, minWidth: 0 }} className="sm-aside">
        {owner && flat && u ? (
          <div className="sm-strip" title={liveLine}>
            <b>{active.length} Units</b><span aria-hidden="true">·</span><span>{Math.round(Number(leasedPct))}% Leased</span><span aria-hidden="true">·</span>
            <span><i className="sm-dot" style={{ background: liveOk ? '#3f8f5f' : '#b8b4a8' }} />{liveOk ? `Live${live.asOf ? ` ${formatTime(live.asOf)}` : ''}` : live.source === 'file' ? 'Rent Roll' : 'Snapshot'}</span>
          </div>
        ) : owner && (
          <section style={flat ? { padding: '12px 0' } : undefined}>
            {flat
              ? <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, margin: '0 0 8px' }}>
                  <h2 style={{ font: `600 14px ${FONT}`, margin: 0 }}>Inventory</h2>
                  <span style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)' }}>{active.length} Units{active.length ? ` · ${leasedPct}% Leased` : ''}</span>
                </div>
              : <h2 style={h2}>Inventory · {active.length} Units{active.length ? ` · ${(100 * leased / active.length).toFixed(1)}% Leased` : ''}</h2>}
            {/* One set of numbers: these tiles are the occupancy legend (same statusOf as the badge and the map colors). */}
            <div style={{ display: 'flex', gap: 6 }}>
              {[['leased', leased], ['vacant', vacant], ['bad', bad.length]].map(([k, v]) => (
                <div key={k} style={{ ...card, padding: flat ? '6px 8px' : '6px 9px', flex: flat && k === 'bad' ? '1.3 1 0' : '1 1 0', minWidth: 0 }}>
                  <b style={{ display: 'block', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
                  <span style={{ fontSize: 11, color: 'var(--text-muted, #5f6358)', whiteSpace: 'nowrap' }}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 4, background: SWATCH[k] }} />{STATUS_WORD[k]}</span>
                </div>
              ))}
            </div>
            {legend && !fill ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', fontSize: 12, marginTop: 8 }}>{legend}</div> : null}
            <div style={{ fontSize: 12, color: live.source === 'cubby' && !live.error ? '#3f8f5f' : 'var(--text-muted, #5f6358)', marginTop: 6 }}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, marginRight: 6, verticalAlign: 0, background: live.source === 'cubby' && !live.error ? '#3f8f5f' : '#b8b4a8' }} />{liveLine}</div>
          </section>
        )}
        {owner && (unplaced.length || live.missing?.length) && !fill ? (
          <Fold title="Not on the Map" count={unplaced.length}>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '0 0 6px' }}>Cubby has these units but the model does not place them. Add them to the build config to put them on the map.</p>
            {unplaced.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>{unplaced.map((x) => <li key={x.n}><span style={{ font: `500 12px ui-monospace, Menlo, monospace` }}>{x.n}</span> <span style={{ color: 'var(--text-muted, #5f6358)' }}>{x.w && x.d ? `${x.w} × ${x.d} ft` : ''}{x.group ? ` · ${x.group}` : ''}{x.r === 0 ? ' · out of service' : x.l ? ' · leased' : ' · vacant'}</span></li>)}</ul> : null}
            {live.missing?.length ? <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '8px 0 0' }}>No longer in Cubby ({live.missing.length}): {live.missing.slice(0, 12).join(', ')}{live.missing.length > 12 ? '…' : ''}</p> : null}
          </Fold>
        ) : null}
        {pending && (
          <section style={box}>
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
          <section style={box} className="sm-unit">
            <div style={{ display: 'flex', justifyContent: flat ? 'flex-start' : 'space-between', alignItems: 'center', gap: flat ? 10 : 8 }}>
              <div style={{ font: `500 ${flat ? 22 : 26}px ui-monospace, Menlo, monospace`, letterSpacing: '.02em' }}>{u.n}</div>
              {owner && <span style={chip(STATUS_COLOR[statusFn(u)])}>{STATUS_WORD[statusFn(u)]}</span>}
              {flat && <button type="button" className="sm-icon-btn" style={{ marginLeft: 'auto' }} aria-label={`Close Unit ${u.n}`} title="Close" onClick={clearPick}><X size={16} aria-hidden="true" /></button>}
            </div>
            {flat ? (
              <p style={{ fontSize: 12.5, color: 'var(--text-muted, #5f6358)', margin: '4px 0 0', lineHeight: 1.45 }}>
                {[unitKindLabel(u), u.w && u.d ? `${u.w} × ${u.d} ft` : u.d ? `${u.d} in. mailbox` : '',
                  `${bldg(u.b)?.name || zone(u.b)?.name || ''}${bldg(u.b)?.floors > 1 ? `, Level ${u.f}` : ''}`,
                  u.door && u.k !== 'park' ? (u.k === 'du' || u.k === 'ccdu' ? `Outside Wall${doorSideName(model, u.door) ? `, ${doorSideName(model, u.door)}` : ''}` : 'Hallway Door') : ''].filter(Boolean).join(' · ')}
                {u.gone ? <span style={{ display: 'block', color: '#c43d2f' }}>No longer in Cubby's inventory</span> : null}
              </p>
            ) : <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, margin: '8px 0 0' }}>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Type</dt><dd style={{ margin: 0 }}>{unitKindLabel(u)}</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Size</dt><dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{u.w && u.d ? `${u.w} × ${u.d} ft (${(u.w * u.d).toLocaleString()} sq ft)` : u.d ? `${u.d} in. mailbox` : 'not listed'}</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Location</dt><dd style={{ margin: 0 }}>{bldg(u.b)?.name || zone(u.b)?.name || ''}{bldg(u.b)?.floors > 1 ? `, Level ${u.f}` : ''}</dd>
              {u.door && u.k !== 'park' && <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Door</dt><dd style={{ margin: 0 }}>{u.k === 'du' || u.k === 'ccdu' ? `Outside wall${doorSideName(model, u.door) ? `, ${doorSideName(model, u.door)}` : ''}` : 'Hallway'}</dd></>}
              {owner && !renderUnitExtra && statusFn(u) !== 'leased' && <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Days Vacant</dt><dd style={{ margin: 0 }}>{typeof u.dvac === 'number' ? u.dvac : 'Since the last build'}</dd></>}
              {owner && statusFn(u) === 'bad' && <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Reason</dt><dd style={{ margin: 0 }}>{reasonLabel(u.why) || 'Not given'}{u.note ? ` - ${u.note}` : ''}</dd></>}
              {u.gone ? <><dt style={{ color: 'var(--text-muted, #5f6358)' }}>Cubby</dt><dd style={{ margin: 0, color: '#c43d2f' }}>No longer in Cubby's inventory</dd></> : null}
            </dl>}
            {owner && (ticketsByUnit[u.n]?.length ? (
              <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>Tickets at This Unit</b>
                <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>{ticketsByUnit[u.n].map((t) => <li key={t.id}><button type="button" onClick={() => onOpenTicket?.(t)} style={{ ...btn, padding: '4px 8px', fontSize: 12, width: '100%', textAlign: 'left' }}>#{t.id} · {t.title || t.subject || 'Ticket'}</button></li>)}</ul>
              </div>
            ) : null)}
            {renderUnitExtra ? renderUnitExtra(u) : null}
            <details open={!owner} className="sm-route" style={{ marginTop: 10, borderTop: '1px solid var(--border-color, #d9d6cc)', paddingTop: 8, fontSize: 13 }}>
              <summary style={{ cursor: owner ? 'pointer' : 'default', fontWeight: 700, listStyle: owner ? undefined : 'none' }}>How to Get There</summary>
              {steps.length > 1 && <ol aria-label="Route steps" style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0 4px', padding: 0 }}>
                {steps.map((s, i) => <li key={i}><button type="button" onClick={() => viewerRef.current?.flyToStep?.(i)} title={noGl ? s.sub : `Show step ${i + 1} on the map`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border-color, #d9d6cc)', background: 'var(--bg-primary, #fff)', borderRadius: 999, padding: '2px 9px 2px 3px', font: `500 12px ${FONT}`, color: 'inherit', cursor: 'pointer' }}>
                  <span style={{ width: 18, height: 18, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: '#fff', background: s.end ? '#ff7a00' : '#1a73e8' }}>{i + 1}</span>{s.label}</button></li>)}
              </ol>}
              <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>{unitDirections(model, u).map((s, i) => <li key={i} style={{ margin: '3px 0' }}>{s}</li>)}</ol>
            </details>
            {owner && pinsEnabled && <div style={{ marginTop: 10 }}><button type="button" style={btn} onClick={() => { const b = bldg(u.b); setPlacing(false); setPending({ u: u.u + u.wu / 2, v: u.v + u.dv / 2, y: b ? +((u.f - 1) * b.height / b.floors).toFixed(2) : 0, unit: u.n, building: u.b }); }}>Add Pin at This Unit</button></div>}
            {/* Per unit (Oct 14 2026): traced units say where their position came from. */}
            {u.tr === 2
              ? <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: 8 }}>Position from the plans; the plans carry no unit numbers, so this number was matched by size - confirm on site.</div>
              : u.tr
              ? <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: 8 }}>Position from the as-built plan.</div>
              : model.layout?.schematic && <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: 8 }}>Position is schematic until the as-built plan is traced.</div>}
          </section>
        ) : building ? (
          <section style={box}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{building.name}</div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, margin: '8px 0 0' }}>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Footprint</dt><dd style={{ margin: 0 }}>{Math.round((building.u[1] - building.u[0]) * 3.281)} × {Math.round((building.v[1] - building.v[0]) * 3.281)} ft</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Height</dt><dd style={{ margin: 0 }}>{Math.round(building.height * 3.281)} ft, {building.floors} level{building.floors > 1 ? 's' : ''}</dd>
              <dt style={{ color: 'var(--text-muted, #5f6358)' }}>Units</dt><dd style={{ margin: 0 }}>{(model.units || []).filter((x) => x.b === building.id).length || 'none matched yet'}</dd>
            </dl>
            <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '8px 0 0' }}>{building.note}</p>
          </section>
        ) : flat ? (
          <p className="sm-pick-hint" style={{ ...box, fontSize: 13, color: 'var(--text-muted, #5f6358)', margin: 0 }}>Pick a unit on the map or search to see its tenant, rent and tickets.</p>
        ) : (
          <section style={card}><b>{owner ? 'Pick a Unit' : 'Find Your Unit'}</b><p style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)', margin: '6px 0 0' }}>{owner ? 'Type a unit number above or click any unit on the map to see its tenant, rent and tickets here.' : 'Type a unit number above, or tap any unit on the model. Drag to orbit, scroll or pinch to zoom, right-drag or two fingers to pan.'}</p></section>
        )}
        {owner && (
          <TailWrap tail={flat}>
            {flat
              ? <GrowFold key={attnOpen ? 'open' : 'shut'} title="Needs Attention" count={bad.length} open={attnOpen}>
                <AttentionList units={bad} onPick={pickHere} every />
              </GrowFold>
              : <Fold title="Needs Attention" count={bad.length} open={fill && !u && !phone} flat={flat}>
                <AttentionList units={bad} onPick={pickHere} scroll={!fill} />
              </Fold>}
            {fill ? asideExtra : null}
            {fill && (unplaced.length || live.missing?.length) ? (
              <Fold title="Not on the Map" count={unplaced.length} flat={flat}>
                <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '0 0 6px' }}>Cubby has these units but the map does not place them yet.</p>
                {unplaced.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>{unplaced.map((x) => <li key={x.n}><span style={{ font: `500 12px ui-monospace, Menlo, monospace` }}>{x.n}</span> <span style={{ color: 'var(--text-muted, #5f6358)' }}>{x.w && x.d ? `${x.w} × ${x.d} ft` : ''}{x.group ? ` · ${x.group}` : ''}</span></li>)}</ul> : null}
                {live.missing?.length ? <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '8px 0 0' }}>No longer in Cubby ({live.missing.length}): {live.missing.slice(0, 12).join(', ')}{live.missing.length > 12 ? '…' : ''}</p> : null}
              </Fold>
            ) : null}
            {pinsEnabled && <Fold title="Pins" count={pins.length} open>
              <div style={{ marginBottom: 6 }}><button type="button" style={placing ? btnOn : btn} onClick={() => setPlacing(!placing)}>{placing ? 'Click the model…' : 'Add Pin'}</button></div>
              {pins.length ? <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}>{pins.map((p) => (
                <li key={p.id} style={{ display: 'flex', gap: 6, fontSize: 12, alignItems: 'center', opacity: p.status === 'done' ? 0.55 : 1 }}>
                  <button type="button" onClick={() => viewerRef.current?.flyToPin(p)} style={{ border: 0, background: 'transparent', font: `500 12px ui-monospace, Menlo, monospace`, color: '#1f6f4a', cursor: 'pointer', padding: '2px 4px', flexShrink: 0 }}>{p.unit || p.building || 'site'}</button>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted, #5f6358)', textDecoration: p.status === 'done' ? 'line-through' : 'none' }}>{p.title} · {p.category}</span>
                  <button type="button" aria-label={p.status === 'done' ? 'Reopen pin' : 'Mark pin done'} title={p.status === 'done' ? 'Reopen' : 'Done'} onClick={() => onTogglePin?.(p)} style={{ ...btn, padding: '1px 7px', fontSize: 12 }}>✓</button>
                  <button type="button" aria-label="Remove pin" onClick={() => onRemovePin?.(p)} style={{ ...btn, padding: '1px 7px', fontSize: 12 }}>×</button>
                </li>))}</ul> : <div style={{ fontSize: 13, color: 'var(--text-muted, #5f6358)' }}>No pins yet. Drop one on a unit, a building or anywhere on the site.</div>}
            </Fold>}
            {model.layout?.flags?.length ? <Fold title="Layout Notes" flat={flat}><ul style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', paddingLeft: 16, margin: 0 }}>{model.layout.flags.map((f, i) => <li key={i} style={{ margin: '3px 0' }}>{f}</li>)}<li style={{ margin: '3px 0' }}>Building letters were matched to footprints from imagery and unit sizes; every assignment is marked inferred in the build config.</li></ul></Fold> : null}
            {flat ? sources : null}
          </TailWrap>
        )}
        {!flat && sources}
      </aside>
    </div>
  );
}

export const siteModelImages = (id) => ({ detail: `/site-models/${id}/ground.jpg`, wide: `/site-models/${id}/ground-wide.jpg` });
