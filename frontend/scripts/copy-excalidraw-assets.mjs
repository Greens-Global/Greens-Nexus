// Self-host the whiteboard engine's fonts (Notes boards, Neil 11/02/2026).
//
// @excalidraw/excalidraw fetches its fonts from a CDN unless
// window.EXCALIDRAW_ASSET_PATH points elsewhere; Nexus's CSP allows fonts and
// scripts from our own origin only, so Board.jsx points the engine at
// /excalidraw-assets/ and this script fills that folder from the installed
// package before every build and dev run (package.json prebuild / predev).
// The folder is gitignored - the package is the source of truth.
//
// Only the families a board can use are copied. Xiaolai (the CJK fallback,
// 12 MB) is left out on purpose: no Nexus board is written in Chinese, and
// shipping it would quadruple the asset footprint for nothing.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(here, '..', 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
const OUT = join(here, '..', 'public', 'excalidraw-assets', 'fonts');
// Nunito = the engine's "Normal" sans (Clean), Excalifont = hand-drawn
// (Sketch), Virgil = the legacy hand font older files may name, Cascadia =
// code, Liberation = the Helvetica fallback, plus the three the picker offers.
const FAMILIES = ['Nunito', 'Excalifont', 'Virgil', 'Cascadia', 'Liberation', 'Lilita', 'ComicShanns', 'Assistant'];

if (!existsSync(SRC)) {
  console.error(`copy-excalidraw-assets: ${SRC} is missing - run npm install first`);
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let bytes = 0;
for (const fam of FAMILIES) {
  const from = join(SRC, fam);
  if (!existsSync(from)) { console.warn(`copy-excalidraw-assets: no ${fam} folder in the package, skipped`); continue; }
  cpSync(from, join(OUT, fam), { recursive: true });
  for (const f of readdirSync(join(OUT, fam))) bytes += statSync(join(OUT, fam, f)).size;
}
console.log(`copy-excalidraw-assets: ${FAMILIES.length} families, ${Math.round(bytes / 1024)} KB -> public/excalidraw-assets/fonts`);
