// Tickets > Reports helpers (TicketReports.jsx): the date presets, the
// duration wording and the Weekly Email hint. Kept apart from the component so it stays a
// components-only module (fast refresh) and the presets can be tested.

// Local YYYY-MM-DD (what the API takes) - never shown to anyone.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

export function presetRange(key, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (key === 'this_week') return [iso(mondayOf(t)), iso(t)];
  if (key === 'last_week') { const m = addDays(mondayOf(t), -7); return [iso(m), iso(addDays(m, 6))]; }
  if (key === 'this_quarter') return [iso(new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1)), iso(t)];
  return [iso(addDays(t, -29)), iso(t)];
}

export function fmtHours(h) {
  if (h == null) return '-';
  return h < 48 ? `${h.toFixed(1)} hrs` : `${(h / 24).toFixed(1)} days`;
}

// What the Weekly Email switch means for this person (the server decides
// who is mailed - backend/ticket_reports.py weekly_status).
export function weeklyHint(pref) {
  if (!pref) return '';
  if (!pref.deskEnabled) return 'The Monday email is turned off for the whole desk in the ticket notification settings.';
  if (pref.defaultOn) {
    return pref.on
      ? 'As a desk supervisor you get last week\'s report every Monday morning. You can turn it off.'
      : 'You turned off the Monday report. Desk supervisors get it unless they turn it off.';
  }
  return pref.on
    ? 'You turned on last week\'s report every Monday morning.'
    : 'Off unless you turn it on - each supervisor chooses for themselves.';
}
