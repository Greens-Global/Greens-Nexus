// Icons on diagram boxes (Neil, 11/08/2026, inspired by stack-diagram's logo
// tiles - but never a brand logo): `Gate | lock` puts a Lucide glyph on the
// box, `Gate | drawing:gate` one of the Training drawings
// (kb/components/drawings.jsx, reused as it is - never a second copy).
//
// On the board a glyph is VECTOR: the icon is rendered once into a detached
// SVG and each of its shapes becomes a plain board element (a line, a box, an
// ellipse) grouped with the box. Nothing is uploaded, no image file, no data
// URL, nothing fetched (the CSP is self only), and a glyph costs a few small
// elements in the scene. Glyphs are tinted the ink color: they say what a box
// is, they are not logos.
//
// Engine-free: `glyphShapes` hands neutral shapes to the adapter
// (engine/excalidraw.jsx `diagram.build`), which turns them into elements.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  AlarmSmoke, ArrowUpDown, Bell, Bot, Box, Bug, Briefcase, Building, Building2, Calculator, Calendar, Camera, Car, Cctv,
  ClipboardList, Clock, Cloud, Cog, Construction, Container, Cpu, CreditCard, Database, DollarSign, DoorClosed, DoorOpen,
  Droplet, Droplets, Fan, Fence, FileSignature, FileText, Flame, Folder, Forklift, Gauge, Globe, HardDrive, HardHat,
  Hammer, House, Key, KeyRound, Landmark, LayoutDashboard, Leaf, Lightbulb, Link, Lock, LockOpen, LogIn, Mail, MapPin,
  MessageSquare, Monitor, Network, Package, Phone, Plug, QrCode, Receipt, Router, ScanLine, Server, Settings, Shield,
  ShieldCheck, Ship, Siren, Smartphone, Snowflake, SprayCan, Store, Sun, Thermometer, Trash2, TreePine, Trees, Truck,
  User, Users, Video, Warehouse, Waves, Wifi, Workflow, Wrench, Zap,
} from 'lucide-react';
import Drawing, { DRAWING_NAMES } from '../../../kb/components/drawings';

/** The icons a box may carry, by the name written after `|`. A curated set
 *  (sites, buildings, systems, people, money) keeps the bundle small. */
export const ICONS = Object.freeze({
  'alarm-smoke': AlarmSmoke, 'arrow-up-down': ArrowUpDown, bell: Bell, bot: Bot, box: Box, bug: Bug, briefcase: Briefcase,
  building: Building, 'building-2': Building2, calculator: Calculator, calendar: Calendar, camera: Camera, car: Car,
  cctv: Cctv, 'clipboard-list': ClipboardList, clock: Clock, cloud: Cloud, cog: Cog, construction: Construction,
  container: Container, cpu: Cpu, 'credit-card': CreditCard, database: Database, 'dollar-sign': DollarSign,
  'door-closed': DoorClosed, 'door-open': DoorOpen, droplet: Droplet, droplets: Droplets, fan: Fan, fence: Fence,
  'file-signature': FileSignature, 'file-text': FileText, flame: Flame, folder: Folder, forklift: Forklift, gauge: Gauge,
  globe: Globe, 'hard-drive': HardDrive, 'hard-hat': HardHat, hammer: Hammer, house: House, key: Key, 'key-round': KeyRound,
  landmark: Landmark, 'layout-dashboard': LayoutDashboard, leaf: Leaf, lightbulb: Lightbulb, link: Link, lock: Lock,
  'lock-open': LockOpen, 'log-in': LogIn, mail: Mail, 'map-pin': MapPin, 'message-square': MessageSquare, monitor: Monitor,
  network: Network, package: Package, phone: Phone, plug: Plug, 'qr-code': QrCode, receipt: Receipt, router: Router,
  'scan-line': ScanLine, server: Server, settings: Settings, shield: Shield, 'shield-check': ShieldCheck, ship: Ship,
  siren: Siren, smartphone: Smartphone, snowflake: Snowflake, 'spray-can': SprayCan, store: Store, sun: Sun,
  thermometer: Thermometer, 'trash-2': Trash2, 'tree-pine': TreePine, trees: Trees, truck: Truck, user: User, users: Users,
  video: Video, warehouse: Warehouse, waves: Waves, wifi: Wifi, workflow: Workflow, wrench: Wrench, zap: Zap,
});
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
// A few words people will reach for that the set spells differently.
const ALIASES = { home: 'house', trash: 'trash-2', email: 'mail', camera2: 'camera', door: 'door-closed', electric: 'zap', water: 'droplet', people: 'users', person: 'user', money: 'dollar-sign', gear: 'cog', office: 'building' };

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');

/** A drawing by its name or a short form of it: `gate` is facility-gate,
 *  `roll-up-door` is door-roll-up. Ambiguous short forms find nothing. */
export function drawingName(raw) {
  const n = slug(raw);
  if (!n) return '';
  if (DRAWING_NAMES.includes(n)) return n;
  const parts = n.split('-').sort().join('-');
  const same = DRAWING_NAMES.filter((d) => d.split('-').sort().join('-') === parts);
  if (same.length === 1) return same[0];
  const tail = DRAWING_NAMES.filter((d) => d.endsWith(`-${n}`) || d.startsWith(`${n}-`));
  return tail.length === 1 ? tail[0] : '';
}

/** What was written after `|` -> { glyph, unknown }: `glyph` is an icon name
 *  or `drawing:<name>` ('' for none); `unknown` the words that matched
 *  nothing (the sheet says so quietly). */
export function readGlyph(raw) {
  const s = String(raw || '').trim();
  if (!s) return { glyph: '', unknown: '' };
  const m = s.match(/^drawing\s*:\s*(.+)$/i);
  if (m) {
    const d = drawingName(m[1]);
    return d ? { glyph: `drawing:${d}`, unknown: '' } : { glyph: '', unknown: s };
  }
  const n = slug(s);
  const name = ICONS[n] ? n : ALIASES[n] && ICONS[ALIASES[n]] ? ALIASES[n] : '';
  return name ? { glyph: name, unknown: '' } : { glyph: '', unknown: s };
}

export const isDrawing = (glyph) => String(glyph || '').startsWith('drawing:');
/** The glyph's footprint on a box: icons are square, drawings 200 x 110. */
export function glyphSize(glyph) {
  return isDrawing(glyph) ? { w: 64, h: 35 } : { w: 20, h: 20 };
}

// The Training drawings' theme tokens, as fixed colors for the board (the
// board's own dark mode inverts them like everything else on it).
const DRAWING_TOKENS = {
  '--kb-dim': '#868e96', '--kb-line': '#ced4da', '--kb-paper': '#ffffff', '--kb-card': '#ffffff',
  '--kb-green-soft': '#d3f9d8', '--kb-green': '#15803d',
};

/** The glyph drawn into an SVG (the sheet's preview) at x, y, w x h. */
export function GlyphSvg({ glyph, x, y, w, h, color }) {
  if (!glyph) return null;
  if (isDrawing(glyph)) {
    const vars = { '--kb-ink': color, ...DRAWING_TOKENS };
    return (
      <g transform={`translate(${x} ${y})`} style={vars} aria-hidden="true">
        <Drawing name={glyph.slice(8)} style={{ width: w, height: h, overflow: 'visible' }} />
      </g>
    );
  }
  const Icon = ICONS[glyph];
  return Icon ? <Icon x={x} y={y} width={w} height={h} color={color} strokeWidth={2} aria-hidden="true" /> : null;
}

// ---- SVG -> neutral shapes ---------------------------------------------------

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** An SVG path's `d` -> its subpaths as point lists ({ points, closed }),
 *  curves and arcs flattened. Covers every command (absolute and relative). */
export function pathPolylines(d, steps = 8) {
  const out = [];
  const tokens = String(d || '').match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  let i = 0; let cmd = ''; let x = 0; let y = 0; let sx = 0; let sy = 0;
  let cur = null; let lastC = null; let lastQ = null;
  const num = () => Number(tokens[i++]);
  const start = () => { if (cur && cur.points.length > 1) out.push(cur); cur = { points: [[x, y]], closed: false }; };
  const to = (nx, ny) => { if (!cur) start(); cur.points.push([nx, ny]); x = nx; y = ny; };
  const cubic = (x1, y1, x2, y2, ex, ey) => {
    const [x0, y0] = [x, y];
    for (let k = 1; k <= steps; k += 1) {
      const t = k / steps; const u = 1 - t;
      to(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
    lastC = [x2, y2];
  };
  const quad = (x1, y1, ex, ey) => {
    const [x0, y0] = [x, y];
    for (let k = 1; k <= steps; k += 1) {
      const t = k / steps; const u = 1 - t;
      to(u * u * x0 + 2 * u * t * x1 + t * t * ex, u * u * y0 + 2 * u * t * y1 + t * t * ey);
    }
    lastQ = [x1, y1];
  };
  const arc = (rx, ry, phiDeg, large, sweep, ex, ey) => {
    // SVG 1.1 F.6.5: endpoint to center parameterization.
    const [x0, y0] = [x, y];
    if (!rx || !ry) { to(ex, ey); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (phiDeg * Math.PI) / 180; const c = Math.cos(phi); const s = Math.sin(phi);
    const dx = (x0 - ex) / 2; const dy = (y0 - ey) / 2;
    const x1p = c * dx + s * dy; const y1p = -s * dx + c * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const f = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (f * rx * y1p) / ry; const cyp = (-f * ry * x1p) / rx;
    const cx = c * cxp - s * cyp + (x0 + ex) / 2; const cy = s * cxp + c * cyp + (y0 + ey) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(2, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * steps / 2));
    for (let k = 1; k <= n; k += 1) {
      const t = t1 + (dt * k) / n;
      to(cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c);
    }
    x = ex; y = ey;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i += 1; continue; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0; const oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    if (C === 'Z') { if (cur) { cur.closed = true; to(sx, sy); out.push(cur); cur = null; } x = sx; y = sy; lastC = lastQ = null; continue; }
    if (C === 'M') {
      x = ox + num(); y = oy + num(); sx = x; sy = y; start();
      cmd = rel ? 'l' : 'L';   // later pairs are line-tos
    } else if (C === 'L') to(ox + num(), oy + num());
    else if (C === 'H') to(ox + num(), y);
    else if (C === 'V') to(x, oy + num());
    else if (C === 'C') cubic(ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num());
    else if (C === 'S') {
      const [rx, ry] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
      cubic(rx, ry, ox + num(), oy + num(), ox + num(), oy + num());
    } else if (C === 'Q') quad(ox + num(), oy + num(), ox + num(), oy + num());
    else if (C === 'T') {
      const [qx, qy] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
      quad(qx, qy, ox + num(), oy + num());
    } else if (C === 'A') {
      const rx = num(); const ry = num(); const rot = num(); const large = num(); const sweep = num();
      arc(rx, ry, rot, large, sweep, ox + num(), oy + num());
    } else { i += 1; continue; }
    if (C !== 'C' && C !== 'S') lastC = null;
    if (C !== 'Q' && C !== 'T') lastQ = null;
  }
  if (cur && cur.points.length > 1) out.push(cur);
  return out;
}

const attr = (el, name) => {
  for (let n = el; n && n.getAttribute; n = n.parentNode) {
    const v = n.getAttribute(name);
    if (v != null && v !== '') return v;
    if (n.tagName?.toLowerCase() === 'svg' && n.parentNode?.tagName?.toLowerCase() !== 'g') break;
  }
  return null;
};
const colorOf = (v, ink) => {
  if (!v || v === 'none') return null;
  if (v === 'currentColor') return ink;
  const m = v.match(/^var\((--[\w-]+)\)$/);
  if (m) return m[1] === '--kb-ink' ? ink : DRAWING_TOKENS[m[1]] || ink;
  return v;
};
const n0 = (v) => Number(v) || 0;
const pts = (s) => { const v = (String(s || '').match(NUM) || []).map(Number); const o = []; for (let k = 0; k + 1 < v.length; k += 2) o.push([v[k], v[k + 1]]); return o; };

/** Every drawable child of a rendered <svg> as neutral shapes in its own
 *  units: { kind: 'rect' | 'ellipse' | 'line', ..., stroke, fill, width }.
 *  `ink` stands in for currentColor and the drawings' ink token. */
export function svgShapes(svg, ink = '#1c2420') {
  const out = [];
  for (const el of svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')) {
    const tag = el.tagName.toLowerCase();
    const stroke = colorOf(attr(el, 'stroke'), ink);
    const fill = colorOf(attr(el, 'fill') ?? 'black', ink);
    const width = n0(attr(el, 'stroke-width') ?? 1);
    const paint = { stroke, fill, width: stroke ? width : 0 };
    if (!stroke && !fill) continue;
    if (tag === 'rect') out.push({ kind: 'rect', x: n0(el.getAttribute('x')), y: n0(el.getAttribute('y')), w: n0(el.getAttribute('width')), h: n0(el.getAttribute('height')), r: n0(el.getAttribute('rx') ?? el.getAttribute('ry')), ...paint });
    else if (tag === 'circle') { const r = n0(el.getAttribute('r')); out.push({ kind: 'ellipse', x: n0(el.getAttribute('cx')) - r, y: n0(el.getAttribute('cy')) - r, w: 2 * r, h: 2 * r, ...paint }); }
    else if (tag === 'ellipse') { const rx = n0(el.getAttribute('rx')); const ry = n0(el.getAttribute('ry')); out.push({ kind: 'ellipse', x: n0(el.getAttribute('cx')) - rx, y: n0(el.getAttribute('cy')) - ry, w: 2 * rx, h: 2 * ry, ...paint }); }
    else if (tag === 'line') out.push({ kind: 'line', points: [[n0(el.getAttribute('x1')), n0(el.getAttribute('y1'))], [n0(el.getAttribute('x2')), n0(el.getAttribute('y2'))]], closed: false, ...paint, fill: null });
    else if (tag === 'polyline' || tag === 'polygon') {
      const p = pts(el.getAttribute('points'));
      if (tag === 'polygon' && p.length) p.push(p[0]);
      if (p.length > 1) out.push({ kind: 'line', points: p, closed: tag === 'polygon', ...paint, fill: tag === 'polygon' ? fill : null });
    } else if (tag === 'path') {
      for (const sub of pathPolylines(el.getAttribute('d'))) out.push({ kind: 'line', points: sub.points, closed: sub.closed, ...paint, fill: sub.closed ? fill : null });
    }
  }
  return out;
}

// One render per glyph (in its own units); placing is a scale and a shift.
const unitCache = new Map();
function unitShapes(glyph, ink) {
  const key = `${glyph}|${ink}`;
  if (unitCache.has(key)) return unitCache.get(key);
  const host = document.createElement('div');
  const root = createRoot(host);
  let shapes;
  try {
    flushSync(() => root.render(<svg><GlyphSvg glyph={glyph} x={0} y={0} w={isDrawing(glyph) ? 200 : 24} h={isDrawing(glyph) ? 110 : 24} color={ink} /></svg>));
    const svg = host.querySelector('svg svg') || host.querySelector('svg');
    shapes = svg ? svgShapes(svg, ink) : [];
  } catch { shapes = []; } finally { root.unmount(); }
  unitCache.set(key, shapes);
  return shapes;
}

/** A glyph's shapes placed at x, y, w x h (board units), ready for the
 *  adapter. [] for no glyph or one that will not render. */
export function glyphShapes(glyph, { x, y, w, h, ink = '#1c2420' }) {
  if (!glyph || typeof document === 'undefined') return [];
  const unit = isDrawing(glyph) ? { w: 200, h: 110 } : { w: 24, h: 24 };
  const s = Math.min(w / unit.w, h / unit.h);
  const ox = x + (w - unit.w * s) / 2; const oy = y + (h - unit.h * s) / 2;
  const width = (v) => Math.max(0.5, Math.round(v * s * 100) / 100);
  return unitShapes(glyph, ink).map((p) => (p.kind === 'line'
    ? { ...p, points: p.points.map(([px, py]) => [ox + px * s, oy + py * s]), width: width(p.width) }
    : { ...p, x: ox + p.x * s, y: oy + p.y * s, w: p.w * s, h: p.h * s, r: (p.r || 0) * s, width: width(p.width) }));
}
