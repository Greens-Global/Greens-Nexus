// Tickets > Reports helpers (TicketReports.jsx): the date presets and the
// duration wording. Kept apart from the component so it stays a
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
