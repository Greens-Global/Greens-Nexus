// Type scale guard (Neil, 11/12/2026). Runs with `npm run lint`, which CI
// runs on every PR.
//
// Every text size is one of the sizes in src/lib/typeScale.js (FS / the
// --fs-* tokens in style.css). This counts the sizes that are NOT on the
// scale - inline `fontSize: 12.5`, `fontSize: '0.78rem'`, CSS `font-size:
// 12.5px` and the `font: 600 12.5px ...` shorthand, both sides of a
// `fontSize: a ? 12 : 13` conditional, in .js / .jsx / .css -
// and fails when a file has more than its baseline. rem is read at the 16px
// root; em depends on its parent and is not judged.
//
// Code written before the scale is listed in type-guard-baseline.json. A file
// may only go DOWN from its baseline count, never up; a new file starts at
// zero. Old screens move over one module at a time (SNAP in typeScale.js says
// where each old size lands); after moving one, run
// `node scripts/check-type.mjs --update` to lower the baseline.
//
// A size that must stay off the scale carries `type-ok: <why>` in a comment
// on the same line (the 16px phone form fields that stop iOS zooming in). A
// file that builds a PRINTED page (an A4 report, a print view) carries
// `type-ok-file: <why>` once - paper has its own sizes; the scale is for
// screens.
//
// `node scripts/check-type.mjs --report` lists what is left, by module.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onScale, snapFor } from '../src/lib/typeScale.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const BASELINE = fileURLToPath(new URL('./type-guard-baseline.json', import.meta.url));

// The scale itself.
const ALLOWED = new Set(['lib/typeScale.js']);

// Each pattern with the [value, unit] pairs it captures.
const NUM = String.raw`(['"\`]?)(\d*\.?\d+)(px|rem|em)?`;
const PATTERNS = [
  [/fontSize\s*:\s*(['"`]?)(\d*\.?\d+)(px|rem|em)?\1/g, (m) => [[m[2], m[3]]]],
  // fontSize: big ? '1rem' : '0.82rem' - both sides.
  [new RegExp(String.raw`fontSize\s*:\s*[^?,}\n]+\?\s*${NUM}\1\s*:\s*${NUM}\4`, 'g'), (m) => [[m[2], m[3]], [m[5], m[6]]]],
  [/font-size\s*:\s*(\d*\.?\d+)(px|rem|em)\b/g, (m) => [[m[1], m[2]]]],
  [/\bfont\s*:\s*(?:(?:[a-z-]+|\d{3})\s+)*(\d*\.?\d+)(px|rem|em)\b/g, (m) => [[m[1], m[2]]]],
];

function px(value, unit) {
  const n = parseFloat(value);
  if (unit === 'em') return null;                    // relative to its parent
  if (unit === 'rem') return Math.round(n * 16 * 100) / 100;
  return n;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|css)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Every off-scale size in a file: [{ line, size }].
function offScale(text) {
  const hits = [];
  if (text.includes('type-ok-file:')) return hits;
  text.split('\n').forEach((line, i) => {
    if (line.includes('type-ok')) return;
    for (const [re, pairs] of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        for (const [value, unit] of pairs(m)) {
          const size = px(value, unit);
          if (size !== null && !onScale(size)) hits.push({ line: i + 1, size });
        }
      }
    }
  });
  return hits;
}

function scan() {
  const found = {};
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const hits = offScale(readFileSync(file, 'utf8'));
    if (hits.length) found[rel] = hits;
  }
  return found;
}

const found = scan();
const counts = Object.fromEntries(Object.entries(found).map(([f, h]) => [f, h.length]));

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log('type guard: baseline written');
  process.exit(0);
}

if (process.argv.includes('--report')) {
  const byModule = {};
  for (const [file, n] of Object.entries(counts)) {
    const mod = file.split('/').slice(0, 2).join('/');
    byModule[mod] = (byModule[mod] || 0) + n;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`type guard: ${total} off-scale sizes in ${Object.keys(counts).length} files\n`);
  for (const [mod, n] of Object.entries(byModule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${mod}`);
  }
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const over = [];
for (const [file, hits] of Object.entries(found)) {
  const allowed = base[file] || 0;
  if (hits.length <= allowed) continue;
  over.push(`  ${file}: ${hits.length} off-scale sizes (allowed ${allowed})`);
  for (const h of hits.slice(0, 8)) {
    over.push(`      line ${h.line}: ${h.size}px - use ${snapFor(h.size)}`);
  }
  if (hits.length > 8) over.push(`      ...and ${hits.length - 8} more`);
}
if (over.length) {
  console.error('type guard: text sizes off the type scale:\n' + over.join('\n'));
  console.error('\nUse a size from src/lib/typeScale.js (FS.meta 11, label 12, body 13, read 14,');
  console.error('title 15, section 18, page 24, figure 32) or the --fs-* tokens in style.css.');
  console.error('A size that must stay off the scale carries `type-ok: <why>` on its line.');
  process.exit(1);
}
console.log('type guard: ok');
