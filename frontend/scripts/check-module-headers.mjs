// Module header guard (Neil, 11/06/2026). The module bar in the top header
// names the module (and the pages above a record), lights the open tab and
// carries the module's buttons (<ModuleActions>). A page under it never
// repeats the module or tab name as a title of its own - the old
// `.view-title-group` block (trail + h2 + tagline + icon tile) did exactly
// that. Runs with `npm run lint`, which CI runs on every PR.
//
// The files below still draw one: record pages whose title names the record
// (an asset, a job, an IT site), or screens not cleaned up yet. The list may
// only shrink: a listed file that no longer has one fails until it is
// removed from the list, so a cleaned file cannot quietly regain it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED = new Set([
  'asset/App.jsx',                    // the open asset's name
  'construction/job/JobPage.jsx',     // the open job's name
  'views/IT.jsx',                     // the open site's name
  'components/TimeTrackingAdmin.jsx',
  'views/Development.jsx',
  'views/Directory.jsx',
  'views/Locations.jsx',
  'views/RolesAccess.jsx',
  'views/Testing.jsx',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(p);
  }
  return out;
}

const found = new Set();
const errors = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split(sep).join('/');
  if (!readFileSync(file, 'utf8').includes('view-title-group')) continue;
  found.add(rel);
  if (!ALLOWED.has(rel)) errors.push(`${rel}: a page title block (view-title-group) - the module bar already names the module and the open tab; put the page's buttons in <ModuleActions>`);
}
for (const rel of ALLOWED) {
  if (!found.has(rel)) errors.push(`${rel}: no longer has a view-title-group - remove it from the list in scripts/check-module-headers.mjs`);
}

if (errors.length) {
  console.error(`module header guard: ${errors.length} problem(s)\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log('module header guard: ok');
