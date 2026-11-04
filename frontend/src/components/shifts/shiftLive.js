// Instant edits on the Shift Planner (Neil, 11/04/2026: "it should be instant
// when a shift gets added and then in the background it should sync with the
// server"). A change is { adds, removes, patches }:
//   adds     - shifts to show (a guess with a `live-` id while it saves; the
//              server's own copy once it answers)
//   removes  - [{ id, pending }]: pending = a SHARED shift, which stays on
//              the team's schedule marked for removal until the next share
//              (the server's rule, routers/timeclock.delete_scheduled);
//              otherwise it goes
//   patches  - [{ id, fields }]: fields laid over the shift
// applyLive lays the changes over the schedule the server last sent, in
// order. The grid reads only the result, so a guess and the real thing look
// the same and the swap is invisible.

let seq = 0;

const minutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};

export function spanMinutes(start, end) {
  const a = minutes(start), b = minutes(end);
  return b > a ? b - a : b + 24 * 60 - a;   // an overnight shift runs past midnight
}

export function applyLive(data, changes) {
  if (!data || !changes?.length) return data;
  let list = data.scheduled || [];
  for (const c of changes) {
    if (c.removes?.length) {
      const by = new Map(c.removes.map((r) => [r.id, r]));
      list = list.flatMap((s) => {
        const r = by.get(s.id);
        if (!r) return [s];
        return r.pending ? [{ ...s, pendingDelete: true, published: false }] : [];
      });
    }
    if (c.patches?.length) {
      const by = new Map(c.patches.map((p) => [p.id, p.fields]));
      list = list.map((s) => (by.has(s.id) ? { ...s, ...by.get(s.id) } : s));
    }
    if (c.adds?.length) {
      const ids = new Set(c.adds.map((s) => s.id));
      list = [...list.filter((s) => !ids.has(s.id)), ...c.adds];
    }
  }
  return { ...data, scheduled: list, openShifts: list.filter((s) => !s.email) };
}

// The shift a create call will make, from the same payload it is sent
// (employee_email, work_date, shift_id, start_hhmm, ...), drawn as a draft.
export function draftFrom(payload, presets = []) {
  const p = payload.shift_id ? presets.find((x) => x.id === payload.shift_id) : null;
  const start = (payload.start_hhmm || p?.start || '09:00').slice(0, 5);
  const end = (payload.end_hhmm || p?.end || '17:00').slice(0, 5);
  const breakMin = payload.break_min ?? p?.breakMin ?? 0;
  const email = (payload.employee_email || '').toLowerCase();
  const own = payload.color || '';
  return {
    id: `live-${++seq}`, email, date: payload.work_date, shiftId: payload.shift_id || '',
    start, end, label: payload.label || '', note: payload.note || '',
    published: false, hasChanges: false, pendingDelete: false, was: null,
    openSlots: email ? 0 : Math.max(1, Number(payload.open_slots) || 1),
    weatherStatus: '', weatherDecisionId: '', breakMin,
    paidMin: Math.max(0, spanMinutes(start, end) - breakMin),
    activities: payload.activities || [], groupId: payload.group_id || '', jobsite: payload.jobsite || '',
    ownColor: own, timezone: p?.timezone || '', code: p ? (p.code || p.name || '') : '', shiftName: p?.name || '',
    color: own || p?.color || '#64748b', conflicts: [], ruleWarnings: [], live: true,
  };
}

// A shift dropped somewhere else (or copied there): the copy is a new draft;
// a move removes the original by the delete rule.
export function movedTo(s, email, date, duplicate) {
  const copy = { ...s, id: `live-${++seq}`, email: (email || '').toLowerCase(), date,
    published: false, hasChanges: false, pendingDelete: false, was: null, conflicts: [], ruleWarnings: [], live: true };
  if (!copy.email) copy.openSlots = Math.max(1, Number(s.openSlots) || 1);
  else copy.openSlots = 0;
  return { adds: [copy], removes: duplicate ? [] : [{ id: s.id, pending: !!s.published || !!s.hasChanges }] };
}

// An edit: the fields a PATCH sends, as the grid shows them. A SHARED shift
// keeps its published look until the share, so it is marked hasChanges.
export function editedFields(s, payload) {
  const start = (payload.start_hhmm || s.start).slice(0, 5);
  const end = (payload.end_hhmm || s.end).slice(0, 5);
  const breakMin = payload.break_min ?? s.breakMin ?? 0;
  const out = { start, end, breakMin, paidMin: Math.max(0, spanMinutes(start, end) - breakMin) };
  if (payload.label !== undefined) out.label = payload.label;
  if (payload.note !== undefined) out.note = payload.note;
  if (payload.shift_id !== undefined) out.shiftId = payload.shift_id;
  if (payload.activities !== undefined) out.activities = payload.activities;
  if (payload.color !== undefined) { out.ownColor = payload.color; if (payload.color) out.color = payload.color; }
  if (s.published || s.hasChanges) { out.hasChanges = true; out.published = false; }
  return out;
}
