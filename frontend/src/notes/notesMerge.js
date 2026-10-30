// Two people, one note (Neil, Oct 30 2026): merging their saves and showing
// what changed between two versions. Pure functions over the note's HTML.
//
// A note is a list of top-level BLOCKS - a paragraph, a heading, a whole
// list, a table, a quote, a voice note or video player. Merging is a 3-way
// merge of those blocks against the copy both people started from (the
// base): a block only one side changed takes that side's change, a block
// both changed the same way is taken once, and only a block both changed
// DIFFERENTLY is a clash for the person to settle - never the whole note.

/** The note's top-level blocks as HTML strings (bare text is wrapped in <p>). */
export function blocksOf(html) {
  const src = (html || '').trim();
  if (!src) return [];
  const doc = new DOMParser().parseFromString(`<body>${src}</body>`, 'text/html');
  const out = [];
  doc.body.childNodes.forEach((node) => {
    if (node.nodeType === 1) out.push(node.outerHTML);
    else if (node.nodeType === 3 && node.textContent.trim()) out.push(`<p>${escapeHtml(node.textContent.trim())}</p>`);
  });
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Longest common subsequence of two arrays: the matched index pairs, in order. */
export function lcsPairs(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length;
  // Trim the common head and tail first - most saves change one spot.
  let head = 0;
  while (head < n && head < m && eq(a[head], b[head])) head += 1;
  let tail = 0;
  while (tail < n - head && tail < m - head && eq(a[n - 1 - tail], b[m - 1 - tail])) tail += 1;
  const A = a.slice(head, n - tail), B = b.slice(head, m - tail);
  const rows = A.length, cols = B.length;
  const len = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      len[i][j] = eq(A[i], B[j]) ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const pairs = [];
  for (let i = 0; i < head; i += 1) pairs.push([i, i]);
  let i = 0, j = 0;
  while (i < rows && j < cols) {
    if (eq(A[i], B[j])) { pairs.push([i + head, j + head]); i += 1; j += 1; }
    else if (len[i + 1][j] >= len[i][j + 1]) i += 1;
    else j += 1;
  }
  for (let k = 0; k < tail; k += 1) pairs.push([n - tail + k, m - tail + k]);
  return pairs;
}

const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * 3-way merge of block lists. Returns parts in order: { ok: [blocks] } or
 * { clash: { base, mine, theirs } } (each a block list).
 */
export function merge3(base, mine, theirs) {
  const toMine = new Map(lcsPairs(base, mine).map(([b, m]) => [b, m]));
  const toTheirs = new Map(lcsPairs(base, theirs).map(([b, t]) => [b, t]));
  const parts = [];
  const push = (blocks) => {
    if (!blocks.length) return;
    const last = parts[parts.length - 1];
    if (last?.ok) last.ok.push(...blocks); else parts.push({ ok: [...blocks] });
  };
  const chunk = (b, m, t) => {
    if (same(m, b)) push(t);
    else if (same(t, b)) push(m);
    else if (same(m, t)) push(m);
    else parts.push({ clash: { base: b, mine: m, theirs: t } });
  };
  let ib = 0, im = 0, it = 0;
  for (let i = 0; i < base.length; i += 1) {
    if (!toMine.has(i) || !toTheirs.has(i)) continue;
    const m = toMine.get(i), t = toTheirs.get(i);
    if (m < im || t < it) continue;
    chunk(base.slice(ib, i), mine.slice(im, m), theirs.slice(it, t));
    push([base[i]]);
    ib = i + 1; im = m + 1; it = t + 1;
  }
  chunk(base.slice(ib), mine.slice(im), theirs.slice(it));
  return parts;
}

/** A clash settled: 'mine', 'theirs' or 'both' (mine, then theirs). */
function settle(clash, choice) {
  if (choice === 'theirs') return clash.theirs;
  if (choice === 'both') return [...clash.mine, ...clash.theirs.filter((b) => !clash.mine.includes(b))];
  return clash.mine;
}

/**
 * Merge the note bodies. { html, clashes } - html settles every clash with
 * `choices[k]` (default 'mine'), clashes lists them for the screen.
 */
export function mergeNotes(baseHtml, mineHtml, theirsHtml, choices = {}) {
  const parts = merge3(blocksOf(baseHtml), blocksOf(mineHtml), blocksOf(theirsHtml));
  const clashes = [];
  const out = [];
  parts.forEach((p) => {
    if (p.ok) { out.push(...p.ok); return; }
    const k = clashes.length;
    clashes.push(p.clash);
    out.push(...settle(p.clash, choices[k] || 'mine'));
  });
  return { html: out.join(''), clashes };
}

/** The title is one line: one side's change wins; both changing it differently is a clash. */
export function mergeTitle(base, mine, theirs) {
  const b = base || '', m = mine || '', t = theirs || '';
  if (m === b || m === t) return { title: t, clash: false };
  if (t === b) return { title: m, clash: false };
  return { title: m, clash: true, mine: m, theirs: t };
}

// ── what changed (Version History) ────────────────────────────────────────
const textOf = (html) => {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

function wordDiff(oldText, newText) {
  const a = oldText.split(/(\s+)/).filter(Boolean);
  const b = newText.split(/(\s+)/).filter(Boolean);
  const pairs = lcsPairs(a, b);
  let i = 0, j = 0;
  let out = '';
  const flush = (ti, tj) => {
    const del = a.slice(i, ti).join(''), ins = b.slice(j, tj).join('');
    if (del.trim()) out += `<del>${escapeHtml(del)}</del>`; else out += escapeHtml(del);
    if (ins.trim()) out += `<ins>${escapeHtml(ins)}</ins>`; else if (!del) out += escapeHtml(ins);
  };
  pairs.forEach(([pi, pj]) => { flush(pi, pj); out += escapeHtml(a[pi]); i = pi + 1; j = pj + 1; });
  flush(a.length, b.length);
  return out;
}

/**
 * The newer body marked against the older one: unchanged blocks as they
 * are, a removed block struck in red, an added block in green, and a block
 * that was edited shown word by word. Both bodies are server-sanitized
 * HTML; the word-level lines are escaped text. { html, added, removed, changed }.
 */
export function diffNotes(olderHtml, newerHtml) {
  const a = blocksOf(olderHtml), b = blocksOf(newerHtml);
  const pairs = lcsPairs(a, b);
  const out = [];
  let added = 0, removed = 0, changed = 0;
  let i = 0, j = 0;
  const gap = (ti, tj) => {
    const dels = a.slice(i, ti), ins = b.slice(j, tj);
    const n = Math.min(dels.length, ins.length);
    for (let k = 0; k < n; k += 1) {
      const t1 = textOf(dels[k]), t2 = textOf(ins[k]);
      if (t1 && t2) { changed += 1; out.push(`<div class="nt-diff-mod">${wordDiff(t1, t2)}</div>`); }
      else { removed += 1; added += 1; out.push(`<div class="nt-diff-del">${dels[k]}</div>`, `<div class="nt-diff-add">${ins[k]}</div>`); }
    }
    dels.slice(n).forEach((d) => { removed += 1; out.push(`<div class="nt-diff-del">${d}</div>`); });
    ins.slice(n).forEach((d) => { added += 1; out.push(`<div class="nt-diff-add">${d}</div>`); });
  };
  pairs.forEach(([pi, pj]) => { gap(pi, pj); out.push(a[pi]); i = pi + 1; j = pj + 1; });
  gap(a.length, b.length);
  return { html: out.join(''), added, removed, changed };
}
