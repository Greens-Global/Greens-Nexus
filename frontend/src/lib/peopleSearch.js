// Canonical ranking for every people-picker/@mention search box in Nexus.
//
// A query that prefixes someone's FIRST name is what a person typing "sai"
// actually means ("find Sai") - a substring hit buried in someone else's last
// name ("Charmi De-sai") is a coincidence, not the intent, and used to rank
// ahead of the real match whenever it came first alphabetically. Ranked:
//   1. query prefixes the first name (case-insensitive)
//   2. query prefixes any other word of the name - a last name ("wil" finds
//      Amy Wilson ahead of a mid-word hit)
//   3. everything else that matches name or email at all
// Each tier is then sorted alphabetically by name, so within a tier the order
// is predictable rather than "whatever order the directory happened to load
// in" (Sagar, Aug 27).
export function matchPeople(people, query, { limit } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return limit ? (people || []).slice(0, limit) : (people || []);
  const scored = [];
  for (const p of people || []) {
    const name = (p.name || '').toLowerCase();
    // A stand-in key ("id:42" for someone with no work email) is not
    // searchable text - only a real address is.
    const raw = (p.email || '').toLowerCase();
    const email = raw.includes('@') ? raw : '';
    if (!name.includes(q) && !email.includes(q)) continue;
    const words = name.split(/\s+/).filter(Boolean);
    const rank = (words[0] || '').startsWith(q) || name.startsWith(q) ? 0
      : words.some(w => w.startsWith(q)) ? 1 : 2;
    scored.push({ p, rank });
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

// Several-word people finder (Neil, Oct 25 2026 - Act As with 100+ people):
// every word typed must match SOMETHING about the person - the name, the
// email, or one of the context fields (title, department, company, site,
// role...) - so "hr aus" finds the HR people at Austin without a name.
// Ranked like matchPeople on the first word against the name (first-name
// prefix, then another name word, then any name/email hit), with people
// found only through a context field last. `fields` names the context keys
// to search; `limit` caps the result. Returns { list, total, words } so a
// capped list can say how many more matched.
export function findPeople(people, query, { fields = [], limit = 0 } = {}) {
  const words = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = people || [];
  if (!words.length) return { list: limit ? all.slice(0, limit) : all, total: all.length, words };
  const scored = [];
  for (const p of all) {
    const name = (p.name || '').toLowerCase();
    const rawEmail = (p.email || '').toLowerCase();
    const email = rawEmail.includes('@') ? rawEmail : '';   // stand-in keys are not searchable
    const ctx = fields.map((f) => String(p[f] || '').toLowerCase()).join(' \u0001 ');
    if (!words.every((w) => name.includes(w) || email.includes(w) || ctx.includes(w))) continue;
    const q = words[0];
    const parts = name.split(/\s+/).filter(Boolean);
    const rank = (parts[0] || '').startsWith(q) ? 0
      : parts.some((w) => w.startsWith(q)) ? 1
      : name.includes(q) || email.includes(q) ? 2 : 3;
    scored.push({ p, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || (a.p.name || '').localeCompare(b.p.name || ''));
  const list = scored.map((s) => s.p);
  return { list: limit ? list.slice(0, limit) : list, total: list.length, words };
}
