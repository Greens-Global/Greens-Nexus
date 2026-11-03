// Plain helpers the person record's tabs share (11/03/2026).

export const fullName = e => [e?.firstName, e?.lastName].filter(Boolean).join(' ');

export const isExternalPerson = (e) => ['guest', 'external'].includes(e?.identityType || 'internal');

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
export const PICK_BOX = { height: 38, padding: '0 13px', borderRadius: 10, fontSize: 13.5, fontWeight: 400 };

export const FL = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.05em', textTransform: 'uppercase' };
export const BOX = { width: '100%', boxSizing: 'border-box' };
export const DATE_BOX = { width: '100%', boxSizing: 'border-box', height: 38, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, fontSize: 13.5, background: 'var(--card)' };
export const HINT = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
export const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginTop: 10 };

// What changed between the saved seed and the draft, key by key - the PATCH body.
export function changedKeys(saved, draft) {
  const out = {};
  for (const k of Object.keys(draft || {})) {
    if (JSON.stringify(draft[k] ?? null) !== JSON.stringify(saved?.[k] ?? null)) out[k] = draft[k];
  }
  return out;
}

// Cross-view jump (the nexus:navigate event).
export const goTo = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));
