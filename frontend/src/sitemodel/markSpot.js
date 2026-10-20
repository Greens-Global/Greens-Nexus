// Mark an Issue on the Map (Charmi, Oct 20 2026) - the plain-data half: what
// a mark is called, where it is on the globe, and the hand-off that lets a
// ticket's Open on Map land on its spot. No three.js, no React.
import { uvToLatLng } from './siteModelDirections.js';

const NEAR_M = 18;   // a ground mark this close to a unit is "Near <unit>"
const UNIT_MARK_M = 6;   // a drawn mark this small, centered on a unit, names that unit

const buildingName = (model, id) => {
  const b = (model.buildings || []).find((x) => x.id === id) || (model.zones || []).find((x) => x.id === id);
  return b ? b.name || `Building ${id}` : '';
};

/** The unit whose footprint is nearest (u, v), within NEAR_M meters, or null. */
export function nearestUnit(model, u, v) {
  let best = null; let bestD = Infinity;
  (model.units || []).forEach((x) => {
    if (x.gone || x.wu == null) return;
    const du = Math.max(x.u - u, 0, u - (x.u + x.wu)); const dv = Math.max(x.v - v, 0, v - (x.v + x.dv));
    const d = Math.hypot(du, dv);
    if (d < bestD) { bestD = d; best = x; }
  });
  return best && bestD <= NEAR_M ? best : null;
}

/** "Unit C214 · Building C, Level 2", "Building C", "Near F001, Building F", "On the site". */
export function placeFor(model, mark) {
  if (!model || !mark) return '';
  const byName = (n) => (model.units || []).find((x) => x.n === n);
  const level = (x) => { const b = (model.buildings || []).find((y) => y.id === x.b); return b && b.floors > 1 ? `, Level ${x.f}` : ''; };
  const on = mark.unit ? byName(mark.unit) : null;
  if (on) return [`Unit ${on.n}`, `${buildingName(model, on.b)}${level(on)}`].filter((s) => s.trim()).join(' · ');
  if (mark.building) return buildingName(model, mark.building) || `Building ${mark.building}`;
  const near = nearestUnit(model, mark.u, mark.v);
  if (near) return [`Near ${near.n}`, buildingName(model, near.b)].filter(Boolean).join(', ');
  return 'On the site';
}

/** The unit whose footprint holds (u, v), or null. */
export function unitAt(model, u, v) {
  return (model.units || []).find((x) => !x.gone && x.wu != null && u >= x.u && u <= x.u + x.wu && v >= x.v && v <= x.v + x.dv) || null;
}

/** The mark as the ticket's map_spot (what POST /task-tickets checks), plus what the form shows.
 *  A drawn mark (pen or circle) is named by its CENTER - the unit it sits on when it
 *  is small, else "Near <unit>" - never by the unit the stroke happened to start on. */
export function spotFromMark(model, modelId, drawn) {
  let mark = drawn;
  if (drawn.r > 0) {
    // A small mark on one unit is that unit's; a bigger one covers several, so it is "Near" its middle one.
    const at = drawn.r <= UNIT_MARK_M ? unitAt(model, drawn.u, drawn.v) : null;
    mark = { ...drawn, unit: at ? at.n : '', building: at ? at.b : '' };
  }
  const ll = uvToLatLng(model, [mark.u, mark.v]);
  const near = !mark.unit && !mark.building ? nearestUnit(model, mark.u, mark.v) : null;
  return {
    modelId, u: mark.u, v: mark.v, y: mark.y || 0, r: mark.r || 0, outline: mark.outline || [],
    unit: mark.unit || '', building: mark.building || (near ? near.b : ''),
    place: placeFor(model, mark), lat: ll ? +ll[0].toFixed(6) : null, lng: ll ? +ll[1].toFixed(6) : null,
    // The unit the ticket names: the one marked, else Common Area (the server checks it).
    ticketUnit: mark.unit || 'Common Area',
  };
}
