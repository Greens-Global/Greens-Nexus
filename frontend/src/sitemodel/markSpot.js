// Mark an Issue on the Map (Charmi, Oct 20 2026) - the plain-data half: what
// a mark is called, where it is on the globe, and the hand-off that lets a
// ticket's Open on Map land on its spot. No three.js, no React.
import { uvToLatLng } from './siteModelDirections.js';

const NEAR_M = 18;   // a ground mark this close to a unit is "Near <unit>"

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

/** The mark as the ticket's map_spot (what POST /task-tickets checks), plus what the form shows. */
export function spotFromMark(model, modelId, mark) {
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
