// Engine import guard (Neil, 11/02/2026: "requiring Excalidraw may not scale
// with time"). Runs with `npm run lint`, which CI runs on every PR.
//
// The Notes board's drawing engine is a replaceable part behind ONE adapter:
// src/notes/board/engine/ (index.js is the contract and the lazy loader,
// excalidraw.jsx the only module that imports the package). Nothing else in
// src/ may import `@excalidraw/...` - not a component, not a helper, not a
// stylesheet - so swapping the engine is a change to that folder alone. The
// vitest mock (frontend/vitest.setup.js) sits outside src/ and is not scanned;
// a test file's `vi.mock('@excalidraw/excalidraw', ...)` is not an import.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argv, exit } from 'node:process';

export const PACKAGE = '@excalidraw/';
/** The one folder (relative to src/) allowed to import the package. */
export const ENGINE_DIR = 'notes/board/engine';
// `from '@excalidraw/...'`, `import('@excalidraw/...')`, `import '@excalidraw/...'`,
// `require('@excalidraw/...')` and a stylesheet's `@import '@excalidraw/...'`.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]@excalidraw\//;
const FILE_RE = /\.(?:[cm]?jsx?|tsx?|s?css)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (FILE_RE.test(name)) out.push(p);
  }
  return out;
}

/** Every import of the package outside the engine folder: [{ file, line, text }]. */
export function scan(root) {
  const hits = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === ENGINE_DIR || rel.startsWith(`${ENGINE_DIR}/`)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (IMPORT_RE.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

function main() {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const hits = scan(src);
  if (hits.length) {
    console.error('engine guard: the drawing engine is imported outside src/notes/board/engine/:');
    for (const h of hits) console.error(`  src/${h.file}:${h.line}  ${h.text}`);
    console.error('\nEvery engine call goes through the adapter (src/notes/board/engine/index.js: loadEngine()).');
    console.error('Add what you need to the Engine contract there instead. See frontend/scripts/check-engine-imports.mjs.');
    exit(1);
  }
  console.log('engine guard: ok');
}

if (argv[1] && pathToFileURL(argv[1]).href === import.meta.url) main();
