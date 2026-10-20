// A typed unit number as the model spells it: "c 21" -> "C021", "b211a" -> "B211A".
// Its own module so the panel and the map search can both use it without
// importing each other.
export function normalizeQuery(q) {
  const s = (q || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z])-?(\d{1,3})([A-Z]?)$/);
  return m ? m[1] + m[2].padStart(3, '0') + m[3] : s;
}
