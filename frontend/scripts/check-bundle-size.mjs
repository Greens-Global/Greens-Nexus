// Bundle budget (Aug 1, 2026) - runs automatically after every `npm run build`
// (see package.json "postbuild"). Fails the build when a chunk or the total
// grows past budget, so bundle bloat is caught at the commit that causes it
// instead of surfacing as "the app got slow sometime this quarter".
//
// Budgets are set ~15% above the Aug 2026 baseline. If you hit one honestly
// (a genuinely needed dependency), raise it deliberately in this file in the
// same PR - the point is that growth is a decision, not an accident.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/assets', import.meta.url));

const PER_CHUNK_KB = 1000;   // largest today: vendor-pdf ~848 KB
// Raised 8500 -> 8600 (Aug 18, 2026): the Tasks module's project-scoped
// custom fields (Location dropdown on Create/Edit Project) pushed total JS
// to 8501 KB, tripping the old cap and silently failing the dev Cloudflare
// Pages build (same postbuild check runs there). A deliberate, small bump
// for a genuinely needed feature, not a pressure valve.
//
// Raised 8600 -> 8700 (Aug 25, 2026): Task-module project templates added
// 31 KB (8594 -> 8625 measured with real env, see below), and dev was already
// sitting 6 KB under the cap - so a modest feature tipped it. Same failure
// shape as the Aug 18 bump: it passed CI and then failed the Cloudflare Pages
// build AND archive-assets on the merge commit, leaving dev serving the
// PREVIOUS frontend while its backend had already moved on.
//
// A number to watch, not to keep nudging. Headroom is now ~75 KB; the next
// thing that wants a bump should shrink something first - the Tasks chunk
// carries every sub-view statically (see the INEFFECTIVE_DYNAMIC_IMPORT
// warnings at build time) and is the obvious place to start.
//
// LOCAL WIP (Tailwind + shadcn migration, uncommitted): 8700 -> 8800. The
// radix-ui primitives (~140 KB, dialog/dropdown/select/etc.) are a one-time
// cost - every converted screen reuses them and sheds inline-style JSX. This
// bump ships WITH the migration commit (growth is a decision, not an
// accident); do not land it separately.
// Aug 25: 8800 -> 8850. Per-person geofence UI on the People profile (address
// search reuses the existing geocode helper; net add ~4 KB). Deliberate.
const TOTAL_KB     = 8850;

// Named exemptions, so one oversized lazy chunk does not force the cap up for
// EVERY chunk. An entry here is a deliberate decision with a reason, not a
// pressure valve - anything unlisted still fails at PER_CHUNK_KB.
const CHUNK_EXEMPT = {
  // heic2any bundles libheif, a full HEIC decoder. It is loaded by a dynamic
  // import() in construction/lib/upload.js and ONLY when a worker uploads an
  // iPhone HEIC, so it never ships on first paint for anyone else. Reviewed
  // Aug 4, 2026 - if this grows, prefer converting HEIC server-side (pillow +
  // pillow-heif) over raising this number again.
  'vendor-heic': 1400,
};
const capFor = (file) => {
  const hit = Object.keys(CHUNK_EXEMPT).find((k) => file.startsWith(k));
  return hit ? CHUNK_EXEMPT[hit] : PER_CHUNK_KB;
};

let total = 0;
const offenders = [];
for (const f of readdirSync(DIST)) {
  if (!f.endsWith('.js')) continue;
  const kb = statSync(join(DIST, f)).size / 1024;
  total += kb;
  const cap = capFor(f);
  if (kb > cap) offenders.push(`${f}: ${Math.round(kb)} KB (budget ${cap} KB)`);
}

if (total > TOTAL_KB) offenders.push(`TOTAL JS: ${Math.round(total)} KB (budget ${TOTAL_KB} KB)`);

if (offenders.length) {
  console.error('\nBundle budget exceeded:');
  for (const o of offenders) console.error('  - ' + o);
  console.error('\nEither shrink the change or raise the budget deliberately in scripts/check-bundle-size.mjs.');
  process.exit(1);
}
console.log(`bundle budget OK: total JS ${Math.round(total)} KB (cap ${TOTAL_KB} KB), no chunk over ${PER_CHUNK_KB} KB`);
