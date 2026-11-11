// pdf.js legacy-build guard (11/12/2026). Runs with `npm run lint`, which CI
// runs on every PR.
//
// pdfjs-dist's modern build calls brand-new browser functions
// (Map.prototype.getOrInsertComputed) that older phones and computers do not
// have: Jeff's Android Chrome 140 showed "getOrInsertComputed is not a
// function" instead of his Time Sheet, so he could not sign it. The legacy
// build carries those functions itself. Every import of pdfjs-dist in src/
// (the library and its worker) must be the legacy one:
//   import('pdfjs-dist/legacy/build/pdf.mjs')
//   import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
// PDF Tools (public/pdf-editor-app/libs) ships its own legacy copy.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

const FILE_RE = /\.(?:[cm]?jsx?|tsx?)$/;
// Any quoted 'pdfjs-dist' specifier: an import, a dynamic import, a vi.mock.
const SPEC_RE = /['"](pdfjs-dist(?:\/[^'"]*)?)['"]/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (FILE_RE.test(name)) out.push(p);
  }
  return out;
}

export function scan(root) {
  const hits = [];
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(SPEC_RE)) {
        if (!m[1].startsWith('pdfjs-dist/legacy/')) {
          hits.push({ file: relative(root, file).split(sep).join('/'), line: i + 1, spec: m[1] });
        }
      }
    });
  }
  return hits;
}

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const hits = scan(root);
if (hits.length) {
  console.error('pdf.js must be imported from its legacy build (older browsers lack what the modern build calls):');
  for (const h of hits) console.error(`  src/${h.file}:${h.line}  '${h.spec}' -> use 'pdfjs-dist/legacy/build/...'`);
  exit(1);
}
console.log('check-pdfjs-legacy: every pdf.js import uses the legacy build.');
