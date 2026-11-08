// Forms & Checklists (Neil, 11/02/2026) - the client half of the form rules.
// The server (backend/form_rules.py) has the final word; this mirror is what
// the fill screen uses to hide a field live, mark what is missing before the
// send, work a formula out as the person types, and decide which forms a
// shift card offers. Keep the two in step - a difference shows up as a 422
// the screen did not expect.
//
// A field def is a template field_defs entry: {token, label, type, required,
// description, options, validation, section, showIf {token, op, value},
// formula, repeat {group, max}}. Answers are {token: value}; a repeat group
// is answers[group] = [{token: value}, ...].
import { validateFieldValue, isEmptyValue, RESERVED_TYPES } from '../lib/mergeFieldTypes';
import { groupLabel } from './formsModel';
import { runFormula, fieldKey, FormulaError } from '../tasks/formula';

/** The field types only a form has. */
export const FORM_TYPES = ['photo', 'gps', 'scan', 'rating', 'yesno', 'signature'];

export const CATEGORY_LABEL = {
  inspection: 'Inspections', incident: 'Incident Reports', vehicle: 'Vehicle Checks',
  checklist: 'Checklists', safety: 'Safety', other: 'Other',
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL);
export const categoryLabel = (c) => CATEGORY_LABEL[c] || CATEGORY_LABEL.other;

const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const asBool = (v) => v === true || v === 'true' || v === 'True' || v === 'Yes' || v === 'yes' || v === 1 || v === '1';
const isBoolish = (v) => typeof v === 'boolean' || v === 'true' || v === 'false' || v === 'True' || v === 'False';

function sameValue(answer, wanted) {
  if (isBlank(answer)) return false;
  if (typeof wanted === 'boolean' || isBoolish(answer)) return asBool(answer) === asBool(wanted);
  if (Array.isArray(answer)) return answer.some((a) => String(a) === String(wanted));
  return String(answer).trim().toLowerCase() === String(wanted ?? '').trim().toLowerCase();
}

/** Whether a field shows, given the answers in its scope (a repeat row's
 *  answers laid over the form's). No showIf = always. */
export function isVisible(def, scope = {}) {
  const c = def?.showIf;
  if (!c || !c.token) return true;
  const a = scope[c.token];
  switch (c.op) {
    case 'ne': return !sameValue(a, c.value);
    case 'any': {
      const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return list.some((v) => sameValue(a, v));
    }
    case 'empty': return isBlank(a);
    case 'notEmpty': return !isBlank(a);
    default: return sameValue(a, c.value);
  }
}

/** Empty, by type: no photo, no stamp, no star, no Yes or No, nothing typed. */
export function isEmptyAnswer(def, v) {
  switch (def?.type) {
    case 'photo': return !Array.isArray(v) || v.length === 0;
    case 'gps': return !v || typeof v !== 'object' || v.lat === undefined || v.lat === null || v.lat === '';
    case 'rating': return !(Number(v) >= 1);
    case 'yesno': return !isBoolish(v);
    case 'signature':
    case 'scan': return !String(v ?? '').trim();
    default: return isEmptyValue(def?.type, v);
  }
}

const groupKey = (def) => (def?.repeat && def.repeat.group ? String(def.repeat.group) : '');

/** The repeat groups of a form: Map group -> {group, defs, max, section}. */
export function repeatGroups(defs) {
  const out = new Map();
  for (const d of defs || []) {
    const g = groupKey(d);
    if (!g) continue;
    if (!out.has(g)) out.set(g, { group: g, defs: [], max: Number(d.repeat.max) || 10, section: d.section || '' });
    out.get(g).defs.push(d);
  }
  return out;
}

/** Sections in order of first appearance; inside each, fields in order with
 *  a repeat group as ONE item where its first field sits:
 *  [{section, items: [{def} | {repeat, defs, max}]}]. */
export function groupDefs(defs) {
  const sections = [];
  const seenGroups = new Set();
  const groups = repeatGroups(defs);
  for (const d of defs || []) {
    const name = d.section || '';
    let s = sections.find((x) => x.section === name);
    if (!s) { s = { section: name, items: [] }; sections.push(s); }
    const g = groupKey(d);
    if (g) {
      if (seenGroups.has(g)) continue;
      seenGroups.add(g);
      const info = groups.get(g);
      s.items.push({ repeat: g, defs: info.defs, max: info.max });
    } else {
      s.items.push({ def: d });
    }
  }
  return sections;
}

const NUMERIC = new Set(['number', 'currency', 'rating']);
function formulaValue(def, v) {
  if (isBlank(v)) return null;
  if (NUMERIC.has(def?.type)) { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
  if (def?.type === 'yesno' || def?.type === 'checkbox') return asBool(v);
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') return v.siteName || '';
  return v;
}

/** Every top-level formula field worked out from the other answers
 *  ({Label} or {token} in the formula): {token: value}. A blank input makes
 *  a blank result; a broken formula is a blank, never a throw. */
export function computeFormulas(defs, answers = {}) {
  const list = (defs || []).filter((d) => !groupKey(d));
  const byKey = new Map();
  for (const d of list) { byKey.set(fieldKey(d.token), d); if (d.label) byKey.set(fieldKey(d.label), d); }
  const out = {};
  for (const d of list) {
    if (!d.formula) continue;
    const field = (name) => {
      const ref = byKey.get(fieldKey(name));
      if (!ref) throw new FormulaError(`Unknown field {${name}}.`);
      if (ref.formula) return out[ref.token] ?? null;   // an earlier formula; a later one reads blank
      return formulaValue(ref, answers[ref.token]);
    };
    const r = runFormula(String(d.formula), { field });
    out[d.token] = r.error ? null : r.value;
  }
  return out;
}

const rowHasContent = (row) => Object.values(row || {}).some((v) => !isBlank(v));

/** What the send carries: every visible top-level answer (a hidden field is
 *  dropped even when it still holds a value), formula results, and each
 *  repeat group as an ordered list of maps with its hidden tokens dropped
 *  and its empty rows gone. Tokens the form never defined are dropped. */
export function visibleAnswers(defs, answers = {}) {
  const out = {};
  const computed = computeFormulas(defs, answers);
  for (const d of defs || []) {
    if (groupKey(d)) continue;
    if (!isVisible(d, answers)) continue;
    if (d.formula) { if (computed[d.token] !== null && computed[d.token] !== undefined) out[d.token] = computed[d.token]; continue; }
    if (answers[d.token] !== undefined) out[d.token] = answers[d.token];
  }
  for (const [g, info] of repeatGroups(defs)) {
    const rows = Array.isArray(answers[g]) ? answers[g] : [];
    out[g] = rows.map((row) => {
      const scope = { ...answers, ...row };
      const o = {};
      for (const d of info.defs) {
        if (!isVisible(d, scope)) continue;
        if (row?.[d.token] !== undefined) o[d.token] = row[d.token];
      }
      return o;
    }).filter(rowHasContent);
  }
  return out;
}

/** One answer's problem ('' = fine) - what the submit checks, and what a
 *  field shows as it is typed (ui/FieldCheck). */
export function checkOne(def, v) {
  const empty = isEmptyAnswer(def, v);
  if (def.required && empty) return 'This field is required';
  if (empty) return '';
  if (def.type === 'rating') { const n = Number(v); return n >= 1 && n <= 5 ? '' : 'Pick 1 to 5 stars'; }
  if (def.type === 'gps') return Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lng)) ? '' : 'The location stamp is incomplete - stamp it again';
  if (def.type === 'photo') return v.every((u) => typeof u === 'string' && u) ? '' : 'A photo is still uploading';
  if (FORM_TYPES.includes(def.type) || RESERVED_TYPES.includes(def.type)) return '';
  return validateFieldValue(def, v);
}

/** Required and format checks over the VISIBLE fields: {token: message};
 *  a repeat row's problem is keyed `<group>.<row>.<token>`, a required group
 *  with no rows is keyed by the group. Empty = good to send. */
export function validateAnswers(defs, answers = {}) {
  const errs = {};
  for (const d of defs || []) {
    if (groupKey(d) || d.formula) continue;
    if (!isVisible(d, answers)) continue;
    const msg = checkOne(d, answers[d.token]);
    if (msg) errs[d.token] = msg;
  }
  for (const [g, info] of repeatGroups(defs)) {
    const rows = (Array.isArray(answers[g]) ? answers[g] : []).filter(rowHasContent);
    if (!rows.length && info.defs.some((d) => d.required)) { errs[g] = `Add at least one ${groupLabel(g, info.defs)}`; continue; }
    rows.forEach((row, i) => {
      const scope = { ...answers, ...row };
      for (const d of info.defs) {
        if (d.formula || !isVisible(d, scope)) continue;
        const msg = checkOne(d, row[d.token]);
        if (msg) errs[`${g}.${i}.${d.token}`] = msg;
      }
    });
  }
  return errs;
}

/** The site a shift is worked at: its own, else its team's. '' = unknown.
 *  A shift placed at a jobsite (Neil, 11/03/2026 - scheduled_shifts.jobsite)
 *  is worked THERE: 'site-<id>' is that company site; 'project-<id>' is a
 *  construction job, not the team's site, so only the company-wide forms show
 *  on it (and the entry is filed for the job - jobOfShift). */
export const shiftSite = (shift, teams) => {
  const js = String(shift?.jobsite || '');
  if (js.startsWith('site-')) return js.slice(5);
  if (js.startsWith('project-')) return shift?.workSiteId || '';
  return shift?.workSiteId || (teams || []).find((t) => t.id === shift?.groupId)?.workSiteId || '';
};

/** The construction job a shift is placed at ('' = none). */
export const jobOfShift = (shift) => {
  const js = String(shift?.jobsite || '');
  return js.startsWith('project-') ? js.slice(8) : '';
};

/** The forms a shift card offers (GET /forms/mine rows): Show On Shift Cards
 *  on, and company-wide or for this shift's site. */
export function formsForShift(forms, shift, teams) {
  const site = shiftSite(shift, teams);
  return (forms || []).filter((f) => f.showOnShifts && (!f.workSiteId || f.workSiteId === site));
}

const EARTH_M = 6371000;
/** Meters between two points. */
export function distanceM(lat1, lng1, lat2, lng2) {
  const rad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

/** The nearest work site with a position, within `maxM` (default 25 km):
 *  {id, name, distanceM} or null. */
export function nearestSite(sites, lat, lng, maxM = 25000) {
  let best = null;
  for (const s of sites || []) {
    if (!Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lng)) || (s.lat === '' || s.lng === '')) continue;
    const d = distanceM(lat, lng, s.lat, s.lng);
    if (d <= maxM && (!best || d < best.distanceM)) best = { id: s.id, name: s.name || '', distanceM: Math.round(d) };
  }
  return best;
}
