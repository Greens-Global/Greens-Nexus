// Operations > Portfolio: the small pure pieces - which properties a group
// picks, what the viewer last chose, and how a figure the data cannot support
// reads. The figures themselves are added up on the server (ops_portfolio.py).

const KEY = 'nexus:ops-portfolio:';

// The viewer's last selection: [] = every connected property. Browser storage
// can be missing or blocked; the board then simply starts at All.
export function loadSelection(email) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + (email || '')) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSelection(email, ids) {
  try { localStorage.setItem(KEY + (email || ''), JSON.stringify(ids || [])); } catch { /* per-viewer convenience only */ }
}

// Quick picks: by state, by market, by who manages the property. A group with
// one value only (every property in California) is not worth a chip.
export function groupsOf(properties) {
  const out = [];
  const add = (kind, label, pick) => {
    const values = [...new Set(properties.map(pick).filter(Boolean))].sort();
    if (values.length < 2) return;
    for (const v of values) out.push({ kind, label: `${label}: ${v}`, ids: properties.filter((p) => pick(p) === v).map((p) => p.id) });
  };
  add('managedBy', 'Managed By', (p) => p.managedBy);
  add('state', 'State', (p) => p.state);
  add('market', 'Market', (p) => p.market);
  return out;
}

// Toggle one property. Starting from All (an empty list), the first untick
// means "all but this one".
export function toggle(ids, id, properties) {
  const all = properties.filter((p) => p.connected).map((p) => p.id);
  const now = ids.length ? ids : all;
  const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
  const sameAsAll = next.length === all.length && all.every((x) => next.includes(x));
  return sameAsAll ? [] : next;
}

export function selectionLabel(ids, properties) {
  const connected = properties.filter((p) => p.connected);
  if (!ids.length) return `All Properties (${connected.length})`;
  if (ids.length === 1) return properties.find((p) => p.id === ids[0])?.shortName || '1 Property';
  return `${ids.length} Properties`;
}

// "12.34%" or a dash; the server sends percentages already multiplied out.
export const pctText = (v) => (v == null ? '-' : `${Number(v).toFixed(2)}%`);
export const signed = (n) => (n == null ? '-' : `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`);
export const net = (m) => (m ? m.ins - m.outs : null);

// The twelve months a person can pick, newest first, ending at `asOf`.
export function monthChoices(asOf) {
  const [y, m] = String(asOf || '').split('-').map(Number);
  if (!y) return [];
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${names[d.getMonth()]} ${d.getFullYear()}` };
  });
}
