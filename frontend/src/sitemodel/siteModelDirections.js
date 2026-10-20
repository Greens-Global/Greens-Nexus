// Open the way to a unit in Google Maps (Visesh, Oct 20 2026). Google can only
// route on public roads, so directions go to the ENTRANCE GATE the in-lot
// route starts from (siteModelRoute.js); the Nexus path takes over from there.
// The unit's own spot is a separate pin link. Pure - no DOM.

import { geoFrame } from './siteModelGeo.js';
import { findRoute } from './siteModelRoute.js';

const fix = (x) => (+x).toFixed(6);

/** Model u, v (meters) -> [lat, lng] through the model's geo frame, or null without one. */
export function uvToLatLng(model, uv) {
  if (!model || !model.frame || !uv || model.frame.lat0 == null || model.frame.lon0 == null) return null;
  const [lon, lat] = geoFrame(model.frame).uvToLl(uv[0], uv[1]);
  return [lat, lon];
}

/** The gate to send people to: an id or gate object in `opts.gate`, else the
 *  one the route to `opts.unit` starts from, else the first (main) gate. */
export function directionsGate(model, opts = {}) {
  const gates = ((model && model.gates) || []).filter((x) => x && x.uv);
  if (!gates.length) return null;
  if (opts.gate) {
    const id = typeof opts.gate === 'string' ? opts.gate : opts.gate.id;
    const hit = gates.find((x) => x.id === id);
    if (hit) return hit;
  }
  if (opts.unit) {
    const r = findRoute(model, opts.unit);
    if (r && r.gate) return gates.find((x) => x.id === r.gate.id) || r.gate;
  }
  return gates[0];
}

/** Driving directions in Google Maps. With a unit: THROUGH the main gate and
 *  ending at the unit's own parking spot (where the in-lot route ends - the
 *  stall's aisle end or the roll-up door), so "Open in Google Maps" lands at the
 *  unit, not just at the facility (Visesh, Oct 20). Without a unit: to the gate.
 *  opts: { unit, gate, gateLatLng: [lat, lng] (the office-set entrance pin wins
 *  over the plan's gate) }. Null without a geo frame. */
export function googleMapsDirectionsUrl(model, opts = {}) {
  const gate = directionsGate(model, opts);
  const gll = opts.gateLatLng && opts.gateLatLng[0] != null ? opts.gateLatLng
    : gate && (gate.ll ? [gate.ll[1], gate.ll[0]] : uvToLatLng(model, gate.uv));
  if (opts.unit) {
    let end = null;
    try { const r = findRoute(model, opts.unit); if (r && r.goal) end = r.goal; } catch { end = null; }
    const u = opts.unit;
    const ll = uvToLatLng(model, end || [u.u + u.wu / 2, u.v + u.dv / 2]);
    if (ll) {
      const via = gll ? `&waypoints=${fix(gll[0])},${fix(gll[1])}` : '';
      return `https://www.google.com/maps/dir/?api=1&destination=${fix(ll[0])},${fix(ll[1])}${via}&travelmode=driving`;
    }
  }
  if (!gll) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${fix(gll[0])},${fix(gll[1])}&travelmode=driving`;
}

/** A Google Maps pin on the unit's own spot (its center). Null without a geo frame. */
export function googleMapsUnitPinUrl(model, unit) {
  if (!unit) return null;
  const ll = uvToLatLng(model, [unit.u + unit.wu / 2, unit.v + unit.dv / 2]);
  if (!ll) return null;
  return `https://www.google.com/maps/search/?api=1&query=${fix(ll[0])},${fix(ll[1])}`;
}
