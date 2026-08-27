// Canonical ranking for every people-picker/@mention search box in Nexus.
//
// A query that prefixes someone's FIRST name is what a person typing "sai"
// actually means ("find Sai") - a substring hit buried in someone else's last
// name ("Charmi De-sai") is a coincidence, not the intent, and used to rank
// ahead of the real match whenever it came first alphabetically. Ranked:
//   1. query prefixes the first name (case-insensitive)
//   2. everything else that matches name or email at all
// Each tier is then sorted alphabetically by name, so within a tier the order
// is predictable rather than "whatever order the directory happened to load
// in" (Sagar, Aug 27).
export function matchPeople(people, query, { limit } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return limit ? (people || []).slice(0, limit) : (people || []);
  const scored = [];
  for (const p of people || []) {
    const name = (p.name || '').toLowerCase();
    const email = (p.email || '').toLowerCase();
    if (!name.includes(q) && !email.includes(q)) continue;
    const firstName = name.split(/\s+/)[0] || '';
    scored.push({ p, rank: firstName.startsWith(q) ? 0 : 1 });
  }
  scored.sort((a, b) => a.rank - b.rank || (a.p.name || '').localeCompare(b.p.name || ''));
  const out = scored.map((s) => s.p);
  return limit ? out.slice(0, limit) : out;
}

// Enter-key handler for a people-search input: picks the top-ranked (index 0)
// result, the same "Enter takes the first suggestion" behavior every other
// autocomplete gives. Wire as onKeyDown={onEnterPickFirst(filtered, onPick)}.
export function onEnterPickFirst(matches, onPick) {
  return (e) => {
    if (e.key !== 'Enter') return;
    if (!matches || matches.length === 0) return;
    e.preventDefault();
    onPick(matches[0]);
  };
}
