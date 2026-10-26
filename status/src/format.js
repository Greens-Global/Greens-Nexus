// US formats only (CLAUDE.md): MM/DD/YYYY and 12-hour times, Pacific.
import { ZONE } from './state.js';

export function usDate(dateOrIso, zone = ZONE) {
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, month: '2-digit', day: '2-digit', year: 'numeric' }).format(d);
}

export function usTime(dateOrIso, zone = ZONE) {
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(d);
}

export function usDateTime(dateOrIso, zone = ZONE) {
  return `${usDate(dateOrIso, zone)} ${usTime(dateOrIso, zone)}`;
}

// A YYYY-MM-DD Pacific day key -> MM/DD/YYYY (no time-zone shifting).
export function dayLabel(day) {
  const [y, m, d] = day.split('-');
  return `${m}/${d}/${y}`;
}

export function duration(fromIso, toIso) {
  const mins = Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
