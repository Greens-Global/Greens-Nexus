// Add Time (Oct 14 2026): the words the modal and its tests share. Kept out
// of the component file so fast refresh keeps working there.
export const DAY_MS = 86400000;
export const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const nextDay = (ds) => localKey(new Date(new Date(`${ds}T12:00:00`).getTime() + DAY_MS));
export const weekday = (ds) => new Date(`${ds}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
export const monthDay = (ds) => new Date(`${ds}T12:00:00`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
export const hm = (min) => `${Math.floor((min || 0) / 60)}h ${String((min || 0) % 60).padStart(2, '0')}m`;
export const t12 = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(h)) return hhmm || '';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')}${h >= 12 ? 'p' : 'a'}`;
};
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
export const BREAKS = [0, 30, 45, 60];
export const TYPES = ['Work', 'Sick Day', 'Vacation', 'Personal'];
export const TONE = { red: 'hsl(var(--color-red))', amber: '#b45309', green: 'hsl(var(--color-green))', ink: 'var(--ink)', muted: 'var(--muted)' };

/** What a day chip says under its date. */
export function dayNote(d) {
  if (d.locked) return { text: 'Locked', tone: 'muted' };
  if (d.state === 'live') return { text: 'On the Clock', tone: 'green' };
  if (d.state === 'needs_out') return { text: 'Needs Out', tone: 'red' };
  if (d.state === 'needs_in') return { text: 'Needs In', tone: 'red' };
  if (d.state === 'has_time') return { text: hm(d.workedMin), tone: 'ink' };
  if (d.timeOff) return { text: `Off - ${cap(d.timeOff)}`, tone: 'amber' };
  if (d.holiday) return { text: 'Holiday', tone: 'amber' };
  if (d.shift) return { text: `${t12(d.shift.start)} - ${t12(d.shift.end)}`, tone: 'muted' };
  if (d.usual) return { text: 'Usual Hours', tone: 'muted' };
  return { text: 'No Time', tone: 'muted' };
}

/** The sentence a preview row says for a judged day. */
export function planText(r) {
  if (r.action === 'add') return `Add ${hm(r.minutes)}${r.breakMin ? ` (${r.breakMin}m break)` : ''}`;
  if (r.action === 'fill_out') return `Clock-out only - closes the open shift (${hm(r.minutes)})`;
  if (r.action === 'fill_in') return `Clock-in only - pairs the clock-out (${hm(r.minutes)})`;
  return `Skipped - ${r.reason || 'cannot take time'}`;
}
