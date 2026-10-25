// People this browser picked lately in any people picker (Oct 25 2026). A
// picker with no Frequent group shows them first while nothing is typed, so
// the same few names are one click away. Convenience only - storage may be
// blocked or empty, and then the group just is not there.
const KEY = 'nexus:people-recent';
const MAX = 5;
// A list this short shows everyone on one screen; a Recent group would only
// repeat names.
export const RECENT_MIN_LIST = 13;

export function readRecentPeople() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((e) => typeof e === 'string' && e).slice(0, MAX) : [];
  } catch { return []; }
}

export function noteRecentPerson(email) {
  const em = String(email || '').toLowerCase();
  // Real addresses only: a picker that keys someone without a work email by
  // a stand-in ("id:42") must not spend a Recent slot on them.
  if (!em.includes('@')) return;
  try { localStorage.setItem(KEY, JSON.stringify([em, ...readRecentPeople().filter((e) => e !== em)].slice(0, MAX))); }
  catch { /* storage blocked */ }
}

// The recent people who are in `people`, most recent first - none for a
// short list.
export function recentRows(people) {
  if (!people || people.length < RECENT_MIN_LIST) return [];
  const by = new Map(people.map((p) => [p.email, p]));
  return readRecentPeople().map((e) => by.get(e)).filter(Boolean);
}
