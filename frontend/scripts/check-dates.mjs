// Date guard (Neil, Oct 19 2026: "think like you have five more engineers
// under you ... control that flow so it can't mess up"). Runs with
// `npm run lint`, which CI runs on every PR.
//
// A native <input type="date"> follows the computer's region, so on an Indian
// or European laptop it shows 20-10-2026 - and toLocale*String / ad-hoc
// Intl.DateTimeFormat calls do the same in text. Every new date box must be
// DateField (tasks/components.jsx) and every new date in text must go through
// lib/datetime.js (formatDate / formatTime / formatDateTime).
//
// Code written before this guard is listed in date-guard-baseline.json and
// allowed for now. A file may only go DOWN from its baseline count, never up;
// a new file starts at zero. After moving old code over, run
// `node scripts/check-dates.mjs --update` to lower the baseline.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const BASELINE = fileURLToPath(new URL('./date-guard-baseline.json', import.meta.url));

const PATTERNS = {
  'type="date"': /type=["']date["']/g,
  'type="datetime-local"': /type=["']datetime-local["']/g,
  // A computed type that can come out as a date box, e.g.
  // type={f.type === 'date' ? 'date' : 'text'} - the literal pattern above
  // never saw these (a Tasks custom field slipped through that way).
  'type={...date...}': /type=\{[^}]*['"]date['"]/g,
  'toLocaleDateString(': /\.toLocaleDateString\(/g,
  'toLocaleTimeString(': /\.toLocaleTimeString\(/g,
  'Intl.DateTimeFormat(': /Intl\.DateTimeFormat\(/g,
};
// The shared helpers themselves (tests are skipped in walk).
// datetime-local is guarded since Oct 21 2026: a DateField plus the 12-hour
// TimeField (tasks/components.jsx) replace it. A bare native time box is not
// guarded yet - its older uses outside Tasks still need moving to TimeField.
const ALLOWED = new Set(['lib/datetime.js', 'lib/displayTz.js']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

function scan() {
  const counts = {};
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [key, re] of Object.entries(PATTERNS)) {
      const n = (text.match(re) || []).length;
      if (n) (counts[rel] ||= {})[key] = n;
    }
  }
  return counts;
}

const counts = scan();
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log('date guard: baseline written');
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const over = [];
for (const [file, byKey] of Object.entries(counts)) {
  for (const [key, n] of Object.entries(byKey)) {
    const allowed = base[file]?.[key] || 0;
    if (n > allowed) over.push(`  ${file}: ${n} x ${key} (allowed ${allowed})`);
  }
}
if (over.length) {
  console.error('date guard: new region-dependent date code found:\n' + over.join('\n'));
  console.error('\nUse DateField (tasks/components.jsx) for date boxes and formatDate / formatTime /');
  console.error('formatDateTime (lib/datetime.js) for dates in text - they follow the Nexus date');
  console.error('setting (MM/DD/YYYY by default) instead of the computer region.');
  console.error('See frontend/scripts/check-dates.mjs.');
  process.exit(1);
}
console.log('date guard: ok');
