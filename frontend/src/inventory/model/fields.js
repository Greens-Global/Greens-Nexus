// Item Management - Field cleaning (N/A tokens) and the closest-known-value suggestion used by the import.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).

// Spreadsheets use "N/A", "-", "none" etc. to mean "no value" - treat a whole-field
// placeholder as blank so it never renders (e.g. Model showing "DS-2CD2143G2-IU N/A").
const NA_TOKENS = new Set(['', 'n/a', 'na', 'n.a.', 'n.a', 'none', 'null', 'nil', '-', '–', '-']);
export const cleanField = v => { const s = String(v ?? '').trim(); return NA_TOKENS.has(s.toLowerCase()) ? '' : s; };

// Levenshtein edit distance - used only to catch import typos in free-text fields
// (Department / Location). Small inputs, so the plain two-row DP is plenty.
function _editDistance(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur  = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// A value that ALMOST matches an existing one (a typo) but isn't an exact match.
// Returns the existing value to suggest, or '' when the value is blank, already a
// known value, or too different to be a confident typo. This is what stops a
// misspelled "Constrcuction" from creating a phantom department that no filter
// finds - the import preview offers the correct spelling with one click.
export function suggestKnown(value, known) {
  const v = String(value ?? '').trim();
  if (!v || !known?.length) return '';
  const lower = v.toLowerCase();
  if (known.some(k => String(k).toLowerCase() === lower)) return '';   // already valid
  let best = '', bestD = Infinity;
  for (const k of known) {
    const d = _editDistance(v, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  // Confident-typo window: distance 1-2, scaled to length so short words don't
  // false-match ("IT" is not a typo of "HR").
  const tol = v.length <= 4 ? 1 : 2;
  return (best && bestD > 0 && bestD <= tol) ? best : '';
}
