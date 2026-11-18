// Plain helpers the person record's tabs share (11/03/2026).

export const fullName = e => [e?.firstName, e?.lastName].filter(Boolean).join(' ');

export const isExternalPerson = (e) => ['guest', 'external'].includes(e?.identityType || 'internal');

// The statuses the directory's Inactive tab holds (Neil, Oct 12): Left and
// Inactive people stay in Nexus with their record, out of the working list.
export const INACTIVE_STATUSES = new Set(['inactive', 'offboarded']);

/** The ONE people tally (11/05/2026) - the People overview tiles and the
 *  directory tabs both read it. Three different sets, three honest names:
 *    people      the company's own people still here (Total People)
 *    active      of those, status Active (the Active tile)
 *    current     every row the Current tab lists: people + external users
 *  So Total = Active + Onboarding (+ any other live status) and
 *  Current = Total + external. The tab was labeled "Active" and read 57
 *  against the Active tile's 55 (Neil, 11/05/2026). */
export function peopleTallies(employees = [], externals = []) {
  const live = (e) => !INACTIVE_STATUSES.has(e.status || 'active');
  const people = employees.filter(e => !isExternalPerson(e) && live(e));
  const all = [...employees, ...externals];
  return {
    people: people.length,
    active: people.filter(e => e.status === 'active').length,
    onboarding: people.filter(e => e.status === 'onboarding').length,
    external: externals.filter(e => isExternalPerson(e) && live(e)).length,
    current: all.filter(live).length,
    inactive: all.filter(e => !live(e)).length,
  };
}

// "••••1234" - the last four only.
export function maskId(v) {
  const s = (v || '').replace(/\s/g, '');
  return s.length > 4 ? `${'•'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}` : s;
}

// Days until an ISO date (negative = past). '' -> null.
export function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

// Rows for the Tasks people picker (PersonSelect) from employee records.
export const pickRows = (list) => {
  const seen = new Set();
  return list.filter(e => {
    const em = (e.workEmail || '').toLowerCase();
    if (!em || seen.has(em)) return false;
    seen.add(em);
    return true;
  }).map(e => ({ email: e.workEmail.toLowerCase(), name: fullName(e), external: isExternalPerson(e) }));
};
export const PICK_BOX = { height: 38, padding: '0 13px', borderRadius: 10, fontSize: 13, fontWeight: 400 };

export const FL = { fontSize: 12, fontWeight: 500, color: 'var(--muted)', display: 'block', marginBottom: 6 };
export const BOX = { width: '100%', boxSizing: 'border-box' };
export const DATE_BOX = { width: '100%', boxSizing: 'border-box', height: 38, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, fontSize: 13, background: 'var(--card)' };
export const HINT = { fontSize: 12, color: 'var(--muted)', marginTop: 4 };
export const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginTop: 10 };

// What changed between the saved seed and the draft, key by key - the PATCH body.
// A record block (personal, contractor, compliance) sends only ITS keys that
// changed, and the server merges them into what it holds (People review,
// 11/11/2026): the whole block read when the page opened would write back
// whatever changed since - a contractor's next invoice number moved on by a
// finalized period, an emergency contact the person updated in My HR.
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function changedKeys(saved, draft) {
  const out = {};
  for (const k of Object.keys(draft || {})) {
    const a = draft[k], b = saved?.[k];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    if (isPlain(a) && isPlain(b)) {
      const part = {};
      for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[sub] ?? null) !== JSON.stringify(b[sub] ?? null)) part[sub] = sub in a ? a[sub] : '';
      }
      out[k] = part;
    } else {
      out[k] = a;
    }
  }
  return out;
}

// Cross-view jump (the nexus:navigate event).
export const goTo = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));
