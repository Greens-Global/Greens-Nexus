// Operations > Customer Map - the Leaflet drawing (Oct 22 2026). No new
// dependency: the heat map is our own canvas in a map pane, the hex grid is
// plain L.polygon, clusters are a grid per zoom level (tradeArea.js does the
// math). Everything a tooltip shows is a sum over aggregated groups.
import L from 'leaflet';
import {
  colorOf, count, dotRadius, escapeHtml, gridCluster, hexBin, hexClasses, hexColor, hexCorners,
  majority, milesText, mixGradient, mixOf, summarize, summaryHtml,
} from './tradeArea';

const METERS_PER_MILE = 1609.344;
const CLUSTER_PX = 44;          // grid cell while zoomed out
const CLUSTER_UNTIL_ZOOM = 14;  // from this zoom on, every point is its own dot
const HEX_PX = 20;              // hexagon side on screen
const BRAND = 'var(--wk-brand, #15803d)';

const project = (map, zoom) => (p) => map.project([p.lat, p.lng], zoom);

// ── Heat map: a canvas in its own pane, under the markers ─────────────────────
const HEAT_STOPS = [[0, [37, 99, 235, 0]], [0.25, [37, 99, 235, 150]], [0.5, [16, 185, 129, 190]],
  [0.7, [250, 204, 21, 215]], [0.85, [249, 115, 22, 230]], [1, [220, 38, 38, 240]]];
let palette = null;
function heatPalette() {
  if (palette) return palette;
  palette = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let k = 1;
    while (k < HEAT_STOPS.length - 1 && HEAT_STOPS[k][0] < t) k += 1;
    const [t0, c0] = HEAT_STOPS[k - 1]; const [t1, c1] = HEAT_STOPS[k];
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    for (let j = 0; j < 4; j += 1) palette[i * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return palette;
}

export function createHeat(map) {
  const pane = map.getPane('cmHeat') || map.createPane('cmHeat');
  pane.style.zIndex = 350;
  pane.style.pointerEvents = 'none';
  const canvas = document.createElement('canvas');
  canvas.className = 'cm-heat';
  pane.appendChild(canvas);
  let points = [];

  function draw() {
    const size = map.getSize();
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    canvas.width = size.x; canvas.height = size.y;
    canvas.style.visibility = '';
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx || !points.length || !size.x || !size.y) return;     // a hidden map has no pixels to read
    const zoom = map.getZoom();
    const r = Math.max(10, Math.min(30, 8 + (zoom - 8) * 3));
    // Sum customers into r/2 cells first, so a block of 40 people reads hotter
    // than one person - and scale to the busiest cells on screen, not one outlier.
    const cell = r / 2;
    const cells = new Map();
    for (const p of points) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      if (pt.x < -r || pt.y < -r || pt.x > size.x + r || pt.y > size.y + r) continue;
      const key = `${Math.floor(pt.x / cell)},${Math.floor(pt.y / cell)}`;
      const c = cells.get(key) || { x: 0, y: 0, n: 0 };
      c.x += pt.x * p.count; c.y += pt.y * p.count; c.n += p.count;
      cells.set(key, c);
    }
    if (!cells.size) return;
    const values = [...cells.values()].map((c) => c.n).sort((a, b) => a - b);
    const max = Math.max(1, values[Math.floor(values.length * 0.97)] || values[values.length - 1]);
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = r * 2;
    const sctx = sprite.getContext('2d');
    if (!sctx) return;
    const g = sctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = g; sctx.fillRect(0, 0, r * 2, r * 2);
    for (const c of cells.values()) {
      ctx.globalAlpha = Math.max(0.06, Math.min(1, c.n / max));
      ctx.drawImage(sprite, c.x / c.n - r, c.y / c.n - r);
    }
    const img = ctx.getImageData(0, 0, size.x, size.y);
    const px = img.data; const pal = heatPalette();
    for (let i = 3; i < px.length; i += 4) {
      const a = px[i];
      if (!a) continue;
      const o = a * 4;
      px[i - 3] = pal[o]; px[i - 2] = pal[o + 1]; px[i - 1] = pal[o + 2]; px[i] = pal[o + 3];
    }
    ctx.putImageData(img, 0, 0);
  }
  const hide = () => { canvas.style.visibility = 'hidden'; };
  const redraw = () => { try { draw(); } catch { /* a canvas-less browser draws nothing */ } };
  map.on('moveend zoomend resize', redraw);
  map.on('zoomstart', hide);
  return {
    set(next) { points = next || []; redraw(); },
    destroy() {
      map.off('moveend zoomend resize', redraw);
      map.off('zoomstart', hide);
      canvas.remove();
    },
  };
}

// ── Dots, with grid clusters while zoomed out ─────────────────────────────────
export function drawDots(layer, map, points, colorBy) {
  layer.clearLayers();
  const zoom = map.getZoom();
  const groups = gridCluster(points, project(map, zoom), zoom >= CLUSTER_UNTIL_ZOOM ? 0 : CLUSTER_PX);
  groups.sort((a, b) => b.count - a.count);           // small dots drawn last, on top
  for (const g of groups) {
    const mix = mixOf(g.members, colorBy);
    const s = summarize(g.members);
    const approx = g.single && s.approx === s.count;
    const tip = summaryHtml(s, g.single ? null : `${count(g.count)} Customers Nearby - Zoom In to Split`);
    if (g.single && g.count < 4) {
      const color = colorOf(colorBy, majority(mix));
      L.circleMarker([g.lat, g.lng], {
        radius: dotRadius(g.count), color: approx ? color : '#fff', weight: approx ? 1.5 : 1,
        dashArray: approx ? '3 2' : null, fillColor: color, fillOpacity: approx ? 0.3 : 0.72,
      }).addTo(layer).bindTooltip(tip, { direction: 'top', className: 'cm-tooltip' });
      continue;
    }
    const d = Math.round(dotRadius(g.count) * 2 + (g.single ? 0 : 8));
    const fill = g.single ? colorOf(colorBy, majority(mix)) : mixGradient(mix, colorBy);
    const html = g.single
      ? `<span class="cm-dot${approx ? ' zip' : ''}" style="width:${d}px;height:${d}px;background:${fill}">${count(g.count)}</span>`
      : `<span class="cm-cluster" style="width:${d}px;height:${d}px;background:${fill}"><b>${count(g.count)}</b></span>`;
    L.marker([g.lat, g.lng], {
      icon: L.divIcon({ className: 'cm-dot-icon', html, iconSize: [d, d], iconAnchor: [d / 2, d / 2] }),
      keyboard: false,
    }).addTo(layer).bindTooltip(tip, { direction: 'top', className: 'cm-tooltip' })
      .on('click', () => { if (!g.single) map.setView([g.lat, g.lng], Math.min(18, zoom + 2)); });
  }
}

// ── Hex grid ──────────────────────────────────────────────────────────────────
export function drawHexes(layer, map, points) {
  layer.clearLayers();
  const zoom = map.getZoom();
  const bins = hexBin(points, project(map, zoom), HEX_PX);
  const classes = hexClasses(bins.map((b) => b.count));
  for (const b of bins) {
    const corners = hexCorners(b.cx, b.cy, HEX_PX).map((c) => map.unproject([c.x, c.y], zoom));
    L.polygon(corners, { color: '#fff', weight: 1, fillColor: hexColor(b.count, classes), fillOpacity: 0.78 })
      .addTo(layer)
      .bindTooltip(summaryHtml(summarize(b.members), `${count(b.count)} ${b.count === 1 ? 'Customer' : 'Customers'} in This Hexagon`),
        { direction: 'top', sticky: true, className: 'cm-tooltip' });
  }
  return classes;
}

// ── Facilities, rings, competitors ────────────────────────────────────────────
function north(lat, lng, miles) {
  return [lat + miles / 69.05, lng];
}

/**
 * Greens pins (the shown facilities branded; other Greens stores muted, for
 * the overlap picture) and the distance rings, each labeled on its edge with
 * the customers inside it when few facilities are shown.
 */
export function drawFacilities(layer, { facilities, others, rings, ringCounts, labelRings }) {
  layer.clearLayers();
  for (const f of facilities) {
    if (f.lat == null || f.lng == null) continue;
    for (const miles of rings) {
      L.circle([f.lat, f.lng], { radius: miles * METERS_PER_MILE, color: '#14532d', weight: 1.3, opacity: 0.7,
        dashArray: '5 5', fill: false, interactive: false }).addTo(layer);
      if (labelRings) {
        const c = (ringCounts[f.id] || []).find((r) => r.miles === miles);
        const html = `<span>${miles} mi${c ? ` · ${count(c.count)} ${c.count === 1 ? 'customer' : 'customers'}` : ''}</span>`;
        L.marker(north(f.lat, f.lng, miles), {
          icon: L.divIcon({ className: 'cm-ring-label', html, iconSize: null }), interactive: false, keyboard: false,
        }).addTo(layer);
      }
    }
  }
  for (const f of others) {
    if (f.lat == null || f.lng == null) continue;
    L.marker([f.lat, f.lng], {
      icon: L.divIcon({ className: 'cm-fac-pin other', html: `<span class="cm-pin">G</span>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      keyboard: false, zIndexOffset: 800,
    }).addTo(layer).bindTooltip(`Greens ${escapeHtml(f.shortName)} (Other Store)`, { direction: 'top' });
  }
  for (const f of facilities) {
    if (f.lat == null || f.lng == null) continue;
    const html = `<span class="cm-pin" style="background:${BRAND}">G</span><span class="cm-pin-name">${escapeHtml(f.shortName || f.name)}</span>`;
    L.marker([f.lat, f.lng], {
      icon: L.divIcon({ className: 'cm-fac-pin', html, iconSize: [26, 26], iconAnchor: [13, 13] }),
      keyboard: false, zIndexOffset: 1000,
    }).addTo(layer).bindTooltip(escapeHtml(f.name || f.shortName), { direction: 'top' });
  }
}

export function drawCompetitors(layer, competitors) {
  layer.clearLayers();
  for (const c of competitors) {
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: 'cm-comp-pin', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      keyboard: false, zIndexOffset: 700,
    }).addTo(layer).bindTooltip(`<b>${escapeHtml(c.name)}</b><br>Competitor, ${milesText(c.miles)} from the nearest Greens store`,
      { direction: 'top', className: 'cm-tooltip' });
  }
}
