// Add Time From Record (Oct 27 2026; was Duplicate Day): the words and the
// review grid's arithmetic the modal and its tests share. Kept out of the
// component file so fast refresh keeps working there.
import { hm, nextDay } from './addTime';

/** Every YYYY-MM-DD from start to end, both included (62 at most). */
export function periodDays(start, end) {
  const out = [];
  if (!start || !end || end < start) return out;
  for (let ds = start; ds <= end && out.length < 62; ds = nextDay(ds)) out.push(ds);
  return out;
}

/** The sentence a preview row says for a judged day. */
export function dupPlanText(r) {
  if (r.action === 'add') return `Add ${hm(r.minutes)}`;
  if (r.action === 'replace') return `Replace ${hm(r.existingMin)} with ${hm(r.minutes)}`;
  if (r.action === 'clear') return `Clear ${hm(r.existingMin)} - Off`;
  if (r.action === 'off') return 'Off - nothing to add';
  return `Skipped - ${r.reason || 'cannot take the day'}`;
}

/** What is being copied: "Copying 8:30a - 5:30p, break 12:00p - 12:30p, Sick Day". */
export function dupTemplateText(template, t12) {
  const shifts = (template || []).map((s) => {
    const at = (v) => { const [hhmm, plus] = String(v || '').split(' '); return `${t12(hhmm)}${plus ? ' (next day)' : ''}`; };
    const brk = (s.breaks || []).map(([a, b]) => `break ${at(a)} - ${at(b)}`);
    return [`${at(s.in)} - ${at(s.out)}`, ...brk, s.category || ''].filter(Boolean).join(', ');
  });
  return shifts.length ? `Copying ${shifts.join('; ')}` : 'Copying';
}

// ── The review grid ─────────────────────────────────────────────────────────
// A row: { type: 'Work' | 'Sick Day' | 'Vacation' | 'Personal' | 'Off',
//          in: 'HH:MM', out: 'HH:MM', breaks: [{ start, end }], category }.
// A time at or before the clock-in is the next morning (an overnight shift),
// the same rule Add Time and the server's template use.

export const ROW_TYPES = ['Work', 'Sick Day', 'Vacation', 'Personal', 'Off'];
export const LEAVE_TYPES = ['Sick Day', 'Vacation', 'Personal'];

const toMin = (hhmm) => { if (!/^\d{1,2}:\d{2}$/.test(String(hhmm || ''))) return NaN; const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** The grid's leave type for a punch category, the way the server's
 *  _leave_class reads it (sick; vacation / PTO / paid time off / annual
 *  leave; personal) - '' for work. */
export function leaveTypeOf(category) {
  const c = String(category || '');
  if (/\bsick\b/i.test(c)) return 'Sick Day';
  if (/\b(vacation|pto|paid time off|annual leave)\b/i.test(c)) return 'Vacation';
  if (/\bpersonal\b/i.test(c)) return 'Personal';
  return '';
}

/** Paid minutes of a row: in to out, less its breaks (leave rows have none). */
export function rowMinutes(r) {
  if (!r || r.type === 'Off') return 0;
  const a = toMin(r.in);
  let b = toMin(r.out);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  if (b < a) b += 1440;
  let brk = 0;
  if (!LEAVE_TYPES.includes(r.type)) {
    for (const x of r.breaks || []) {
      let s = toMin(x.start), e = toMin(x.end);
      if (Number.isNaN(s) || Number.isNaN(e)) continue;
      if (s < a) s += 1440;
      if (e < a) e += 1440;
      if (e > s) brk += e - s;
    }
  }
  return Math.max(0, b - a - brk);
}

/** India Contractor day credit (india_contractor_pay.work_halves): Full at
 *  8 h worked, Half at 4 h, else None; leave is paid from the balance. */
export function creditOf(r, cfg) {
  if (!cfg) return '';
  if (r?.type === 'Off') return 'None';
  if (LEAVE_TYPES.includes(r?.type)) return r.type === 'Personal' ? 'None' : 'Paid Leave';
  const m = rowMinutes(r);
  return m >= cfg.fullMin ? 'Full' : m >= cfg.halfMin ? 'Half' : 'None';
}
export const CREDIT_WORD = { full: 'Full', half: 'Half', none: 'None', leave: 'Paid Leave' };

/** A day's punches (the server's shifts, UTC) as one template row in the
 *  display zone: the first clock-in to the last clock-out, every break and
 *  every gap between two shifts as a break (a split shift keeps its hours). */
export function rowFromShifts(shifts, toLocal) {
  const ps = (shifts || []).filter((s) => s.wellFormed !== false).flatMap((s) => s.punches || []);
  if (!ps.length) return null;
  const hhmm = (at) => toLocal(at).slice(11, 16);
  const first = ps[0];
  const breaks = [];
  for (let i = 1; i < ps.length - 1; i += 1) {
    const p = ps[i], q = ps[i + 1];
    if ((p.kind === 'break_start' && q.kind === 'break_end') || (p.kind === 'out' && q.kind === 'in')) {
      breaks.push({ start: hhmm(p.at), end: hhmm(q.at) });
      i += 1;
    }
  }
  const cat = first.category || '';
  const type = leaveTypeOf(cat) || 'Work';
  return { type, in: hhmm(first.at), out: hhmm(ps[ps.length - 1].at), breaks: type === 'Work' ? breaks : [], category: type === 'Work' ? cat : '' };
}

/** "9:00a - 5:00p" of a day's punches, for the row's Existing note. */
export function shiftsText(shifts, toLocal, t12) {
  return (shifts || []).map((s) => {
    const ps = s.punches || [];
    const a = ps[0], b = ps[ps.length - 1];
    if (!a) return '';
    const t = (p) => t12(toLocal(p.at).slice(11, 16));
    return b && b !== a && b.kind === 'out' ? `${t(a)} - ${t(b)}` : `${t(a)} (open)`;
  }).filter(Boolean).join(', ');
}

/** What the row's day is and whether it can be picked. */
export function dayGate(d) {
  if (!d) return { ok: false, text: '' };
  if (d.locked) return { ok: false, text: 'Locked - Unlock The Period First', title: d.locked, tone: 'muted' };
  if (d.future) return { ok: false, text: 'Not Yet', tone: 'muted' };
  if (d.state === 'live') return { ok: false, text: 'On The Clock', tone: 'green' };
  const has = (d.shifts || []).length > 0;
  if (has && d.pendingFix) return { ok: false, text: 'Punch Fix Waiting - Decide It First', tone: 'amber', existing: true };
  return { ok: true, existing: has };
}

/** The rows a mode starts with: All Working Days / All Days take every
 *  pickable day of theirs that has no punches yet (a day with punches is
 *  Skip until HR picks it, which then replaces them); Pick Days starts empty. */
export function defaultPicks(days, mode) {
  const out = new Set();
  if (mode === 'days') return out;
  for (const d of days || []) {
    const g = dayGate(d);
    if (!g.ok || g.existing) continue;
    if (mode === 'all' || d.working) out.add(d.date);
  }
  return out;
}

/** The HR record batches behind a day's punches, each once: [{ batchId, reason }]
 *  (punchMeta.entrySource === 'hr_record' - the card's tag and its reason). */
export function recordOf(segs, punchMeta = {}) {
  const out = [];
  for (const s of segs || []) {
    const ids = [s.inId, s.outId, ...(s.breaks || []).flatMap((b) => [b.startId, b.endId])];
    for (const id of ids) {
      const m = id && punchMeta[id];
      if (m?.entrySource === 'hr_record' && !out.some((r) => r.batchId === m.batchId)) out.push({ batchId: m.batchId || '', reason: m.recordReason || '' });
    }
  }
  return out;
}

/** The server's rows for the picked days (`rows` of POST /duplicate-day).
 *  `toUtc(wall)` / `offsetAt(wall)` are the display zone's conversions. */
export function recordRows(dates, rowFor, existing, toUtc, offsetAt) {
  return dates.map((ds) => {
    const r = rowFor(ds);
    const replace = !!existing(ds);
    if (r.type === 'Off') return { date: ds, kind: 'off', replace };
    const at = (h) => toUtc(`${h < r.in ? nextDay(ds) : ds}T${h}`);
    const leave = LEAVE_TYPES.includes(r.type);
    return {
      date: ds, kind: 'work', replace,
      category: leave ? r.type : (r.category || ''),
      in_at: toUtc(`${ds}T${r.in}`), out_at: at(r.out),
      breaks: leave ? [] : (r.breaks || []).filter((b) => b.start && b.end).map((b) => ({ start_at: at(b.start), end_at: at(b.end) })),
      tz_offset_min: offsetAt(`${ds}T${r.in}`),
    };
  });
}
