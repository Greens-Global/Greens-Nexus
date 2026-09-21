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
// Sep 14: 8850 -> 8950. The Business Intelligence module's report charts
// (Treemap, FunnelChart) pulled recharts sub-modules that weren't in the
// bundle before - CI measured 8876 KB (this repo's clean-install size; local
// dev-cache builds read lower). A real, reviewed feature cost, not creep.
//
// Sep 17: 8950 -> 9050. The Documents/Nexus Sign work (unit-aware Word import,
// the variable library, {{token}} extraction) measured +35 KB on CI's clean
// install - 8928 on dev, 8963 here. dev was already sitting 22 KB under the
// cap, so a modest feature tipped it: the same shape as the Aug 18 and Aug 25
// bumps. Note this change REMOVED the client-side docx2pdf converter; the 35
// KB is what the feature costs after that saving, not before it.
//
// Nothing cheap is left to shrink inside this module - mammoth (vendor-docx,
// 497 KB) looks like the obvious target now that Word -> PDF is server-side,
// but SOP.jsx and docBuilderImport.js both still import it, and both already
// do so dynamically. The standing advice holds and is now the ONLY lever
// left: the Tasks chunk (295 KB) carries every sub-view statically (see the
// INEFFECTIVE_DYNAMIC_IMPORT warnings at build time). The next bump should be
// refused until someone splits it.
//
// Sep 19, 2026: 9050 -> 9200. Nexus Assistant Phase 0 (AssistantWidget.jsx)
// added react-markdown + remark-gfm to render the chat widget's replies -
// CI measured 9179 KB. The parser itself is already lazy-loaded (only
// fetched once someone opens the widget and gets a reply), but this budget
// sums every shipped .js file regardless of load timing, so splitting it
// into its own chunk doesn't move this number - only the real dependency
// cost does. The widget is mounted globally (every screen, every user), so
// this is a real ongoing cost, not a one-view feature.
//
// Sep 21, 2026: 9200 -> 9300. Documents/Nexus Sign: the template fill form
// now asks for EVERY {{variable}} a template uses (server-listed tokens), and
// the Template Fields panel (TemplateFieldsPanel.jsx) lets the author set the
// type of each one after pasting from Word or importing a .docx - so the form
// asks for a date as a date. Measured +5 KB here; the total was already 9195
// after the Assistant bump above, so 5 KB tipped it, exactly the shape of the
// Aug 18 / Aug 25 / Sep 17 bumps.
//
// This bump is taken AGAINST the standing advice above ("refused until someone
// splits the Tasks chunk"), knowingly and with the owner asked (Sagar, Sep 21).
// Note the lever that advice names does not move THIS number: the budget sums
// every shipped .js file, so splitting a chunk changes chunk sizes, not the
// total. Only dropping a real dependency does. The honest next step is
// mammoth (vendor-docx, 497 KB) - SOP.jsx and docBuilderImport.js are the two
// callers left, both already dynamic, so what remains is proving nothing else
// pulls it statically.
// Sep 22, 2026: 9300 -> 9400. Accounting Dashboard (Visesh): the finance
// dashboard from Nexus Accounting now lives in the Accounting view as its own
// tabs (Overview / Cash / Performance / Close / Data) - the shared calculation
// modules (accounting/dashboard/model, compiled from the accounting app's
// TypeScript), 29 widgets and four tab screens. Measured +138 KB, total 9331.
// Taken deliberately for a whole new module, owner asked. The mammoth note
// above still names the real lever.
const TOTAL_KB     = 9400;

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
