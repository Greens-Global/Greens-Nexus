// Pure helpers for the schedule grid extras (ShiftScheduleExtras.jsx):
// time-off labels, availability text, Print and spreadsheet parsing.
import { formatDate } from '../lib/datetime';

export const TIMEOFF_LABELS = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', other: 'Other' };
export const timeOffLabel = (t) => TIMEOFF_LABELS[t] || t;

const hm12 = (hhmm) => {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const dayBefore = (key) => { const [y, m, d] = key.split('-').map(Number); return isoOf(new Date(y, m - 1, d - 1)); };

// Where a shift dated `key` (YYYY-MM-DD) stands against `clock` - the time in
// the shift's OWN zone ({ date, minutes }, lib/datetime zoneClock), since its
// start and end are that zone's wall clock, not the viewer's: 'ahead', 'on'
// or 'over'. An overnight shift is still on the morning after its date.
export function shiftPhase(s, key, clock) {
  const a = toMin(s.start), b = toMin(s.end);
  const overnight = b < a;
  if (key > clock.date) return 'ahead';
  if (key === clock.date) {
    if (clock.minutes < a) return 'ahead';
    return overnight || clock.minutes < b ? 'on' : 'over';
  }
  return overnight && key === dayBefore(clock.date) && clock.minutes < b ? 'on' : 'over';
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "Mon 9:00 AM - 1:00 PM · Tue unavailable" - availability for a row's tooltip.
const DAY3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const availText = (list) => (list || [])
  .map(a => `${DAY3[a.weekday]} ${a.kind === 'unavailable' ? 'unavailable' : `${hm12(a.start)} - ${hm12(a.end)}`}`).join(' · ');

// ── Print ────────────────────────────────────────────────────────────────
// A plain black-on-white page in a new window: people down the side, days
// across, a week per table (a month prints as its weeks).
export function printSchedule({ title, days, groups, byCell, openByDate, offOn, holOn, notes }) {
  const w = window.open('', '_blank');
  if (!w) return false;
  const chip = (s) => `<div class="s" style="border-color:${esc(s.color || '#64748b')}"><b>${esc(s.code || 'Shift')}</b> ${esc(hm12(s.start))} - ${esc(hm12(s.end))}${s.label ? `<div class="l">${esc(s.label)}</div>` : ''}</div>`;
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const table = (wk) => {
    const head = wk.map(d => {
      const ds = isoOf(d);
      return `<th>${esc(d.toLocaleDateString('en-US', { weekday: 'short' }))} ${esc(formatDate(ds))}${notes?.[ds] ? `<div class="n">${esc(notes[ds])}</div>` : ''}</th>`;
    }).join('');
    const open = wk.some(d => (openByDate[isoOf(d)] || []).length)
      ? `<tr><td class="who">Open shifts</td>${wk.map(d => `<td>${(openByDate[isoOf(d)] || []).map(chip).join('')}</td>`).join('')}</tr>` : '';
    const body = groups.map(g => `<tr><td class="g" colspan="${wk.length + 1}">${esc(g.name)}</td></tr>`
      + g.members.map(m => `<tr><td class="who">${esc(m.name || m.email)}</td>${wk.map(d => {
        const ds = isoOf(d);
        const items = byCell[`${m.email}|${ds}`] || [];
        if (items.length) return `<td>${items.map(chip).join('')}</td>`;
        const off = offOn(m.email, ds);
        if (off) return `<td class="off">${off.status === 'approved' ? 'Off' : 'Requested off'}</td>`;
        const hol = holOn(m.email, ds);
        return `<td class="off">${hol ? esc(hol.name || 'Holiday') : ''}</td>`;
      }).join('')}</tr>`).join('')).join('');
    return `<table><thead><tr><th class="who">Employee</th>${head}</tr></thead><tbody>${open}${body}</tbody></table>`;
  };
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>
    body{font-family:Inter,Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 12px}
    table{border-collapse:collapse;width:100%;margin-bottom:18px;font-size:11px;page-break-inside:auto}
    th,td{border:1px solid #bbb;padding:4px 5px;vertical-align:top;text-align:left}th{background:#f3f4f6}
    td.who,th.who{width:140px;font-weight:700}td.g{background:#e5e7eb;font-weight:800}td.off{color:#9f1239}
    .s{border-left:3px solid #64748b;padding-left:4px;margin-bottom:3px}.l,.n{color:#555;font-weight:400}
    tr{page-break-inside:avoid}@page{size:landscape;margin:12mm}
  </style></head><body><h1>${esc(title)}</h1>${weeks.map(table).join('')}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
  return true;
}

// Reads the same columns Export writes, so an exported week can be edited in
// Excel and brought back. The server validates every row again.
const HEADERS = {
  date: ['date', 'day date'], email: ['email', 'work email'], employee: ['employee', 'name'],
  start: ['start', 'start time'], end: ['end', 'end time'], shift: ['shift type', 'shift', 'code'],
  label: ['label'], note: ['note', 'notes'], break: ['unpaid break (min)', 'unpaid break', 'break'],
  open: ['open spots', 'open slots'],
};

// A spreadsheet date cell -> 'YYYY-MM-DD', or '' when it can't be read.
export function sheetDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return isoOf(v);
  if (typeof v === 'number' && v > 0) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);   // Excel's day zero
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s : '';
}

// A spreadsheet time cell -> 'HH:MM'; '' for an empty cell, null when unreadable.
export function sheetTime(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') {
    const min = Math.round((v % 1) * 1440) % 1440;
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }
  const m = String(v).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i) || String(v).trim().match(/^(\d{1,2}):(\d{2})()$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseScheduleSheet(aoa, employees = []) {
  const [head = [], ...body] = aoa || [];
  const col = {};
  head.forEach((h, i) => {
    const k = String(h ?? '').trim().toLowerCase();
    for (const [f, names] of Object.entries(HEADERS)) if (names.includes(k) && col[f] === undefined) col[f] = i;
  });
  if (col.date === undefined || (col.email === undefined && col.employee === undefined)) {
    return { rows: [], problems: ['The first row needs a Date column and an Email or Employee column.'] };
  }
  const byName = {};
  employees.forEach(e => { if (e.name) byName[e.name.trim().toLowerCase()] = e.email; });
  const rows = [], problems = [];
  body.forEach((r, i) => {
    const n = i + 2;
    const get = (f) => (col[f] === undefined ? '' : r[col[f]] ?? '');
    if (!r || r.every(v => String(v ?? '').trim() === '')) return;
    const date = sheetDate(get('date'));
    if (!date) { problems.push(`Row ${n}: the date can't be read.`); return; }
    let email = String(get('email')).trim().toLowerCase();
    const who = String(get('employee')).trim();
    const spots = Number(get('open')) || 0;
    const open = !email && (spots > 0 || /^open( shift)?$/i.test(who));
    if (!email && !open) {
      email = byName[who.toLowerCase()] || '';
      if (!email) { problems.push(`Row ${n}: ${who ? `no one called "${who}" is on the schedule` : 'there is no email or employee'}.`); return; }
    }
    const start = sheetTime(get('start')), end = sheetTime(get('end'));
    if (start === null || end === null) { problems.push(`Row ${n}: a time can't be read.`); return; }
    const brk = get('break');
    rows.push({
      row: n, email: open ? '' : email, date, start, end,
      shift: String(get('shift')).trim(), label: String(get('label')).trim(), note: String(get('note')).trim(),
      break_min: String(brk).trim() === '' ? null : Math.max(0, Math.round(Number(brk)) || 0),
      open_slots: open ? Math.max(1, spots) : null,
    });
  });
  return { rows, problems };
}

// The schedule's View menu defaults (Sep 30): everything shown, people rows.
export const DEFAULT_VIEW_PREFS = { mine: false, rowsBy: 'people', teams: true, open: true, conflicts: true, availability: true, photos: true, sunday: true };
