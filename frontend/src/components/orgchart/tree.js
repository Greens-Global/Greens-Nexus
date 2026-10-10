// Org chart helpers shared by People > Org Chart (editable) and the Contact
// Directory's Org Chart lens (read-only). Pure functions over a generic tree:
// the caller says what a node's children are and what its key is, so the
// same code lays out People's employee records and the directory's contact
// rows without either screen learning the other's shape.

// Functional divisions color a chart. A fixed palette keeps each division's
// color stable across renders; the index comes from the sorted name list so
// the legend and the cards always agree.
export const DIVISION_PALETTE = [
  '212 90% 52%',   // blue
  '150 60% 40%',   // green
  '270 68% 58%',   // purple
  '26 88% 52%',    // orange
  '338 74% 56%',   // pink
  '188 72% 40%',   // teal
  '45 88% 48%',    // amber
  '0 72% 56%',     // red
];
export const divisionColor = (name, names) => {
  if (!name) return '';
  const i = names.indexOf(name);
  return DIVISION_PALETTE[(i < 0 ? 0 : i) % DIVISION_PALETTE.length];
};

// First render of a chart: roots and their direct reports at full size, every
// deeper team folded behind its count pill. Forty people drawn at once shrink
// to ant-sized cards; two levels stay readable.
export function initialCollapsed(roots, childrenOf, keyOf) {
  const out = new Set();
  const walk = (node, depth) => {
    const kids = childrenOf(node) || [];
    if (kids.length && depth >= 1) out.add(keyOf(node));
    kids.forEach((k) => walk(k, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

// Every key that has children, for "collapse all".
export function allBranchKeys(roots, childrenOf, keyOf) {
  const out = new Set();
  const walk = (node) => {
    const kids = childrenOf(node) || [];
    if (kids.length) out.add(keyOf(node));
    kids.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

// Direct and indirect reports under a node.
export function countBelow(node, childrenOf) {
  let n = 0;
  const stack = [...(childrenOf(node) || [])];
  while (stack.length) {
    const k = stack.pop();
    n += 1;
    for (const c of childrenOf(k) || []) stack.push(c);
  }
  return n;
}

export const clampZoom = (z) => Math.max(0.3, Math.min(1.6, +Number(z).toFixed(3)));
