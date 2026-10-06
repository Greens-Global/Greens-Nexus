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
// Sep 24, 2026: 9400 -> 9600. Accounting feedback batch (Visesh): journal
// entry view behind the entry number on search results and drill-downs,
// report comparison columns, dimension filters, the monthly cash forecast and
// the per-entity reconciliation list. Measured 9403 before the batch, so the
// headroom is for the batch itself.
// Sep 26, 2026: 9600 -> 9650. Settings split into Global / Company Settings,
// per-company job roles, the Settings Tools tab, and self-service help (the
// "?" help widget, a hand-written search over the guide and Knowledge Base,
// and suggested articles in the ticket form). CI measured 9640 KB, +~65 KB
// net. Paid for most of it first: the legacy Nexus Access Manager screen
// (views/Admin.jsx, 37 KB, a duplicate of Settings > Access) was deleted in
// the same PR. The 50 KB bump covers the rest with a little headroom.
// Sep 28, 2026: 9650 -> 9700. dev itself measured 9650 KB on CI - zero
// headroom left - so the Tasks mobile fix (floating + on Home, New Task sheet
// kept above the iPhone keyboard) tipped it with under 1 KB. Owner asked
// (Sagar). The mammoth note above is still the real lever.
// Sep 29, 2026: 9700 -> 9800. Shifts QA gap list item 6 (Day and Month
// views, filter, Excel export, drag and drop, day notes, shift activities)
// plus D3 measured 9717 KB on CI - 17 KB over. Owner asked (Sagar). Splitting
// the Shifts screen into lazy chunks would not move this number (the budget
// sums every shipped .js file); only dropping a dependency does.
// Sep 29, 2026: 9800 -> 9900. Accounting, from the 09/25 call with Neil and
// Charmi (Visesh): the Reports toolbar as dropdowns with the book selector,
// memorized reports, the ledger grid with a filter per column and the
// reader's own column layout, reporting packages built into a PDF, and who
// may read which entities. dev was at 9700 of 9700 then; the Reports, Packages and
// Access work measured 9708 locally (+8 KB - the old toolbar and chip row
// came out as the new one went in). The rest of the headroom is for the
// modules the same call asked for and this batch carries. pdf-lib was already
// shipped (vendor-pdf), so the PDFs add no dependency.
// Sep 29, 2026: 9900 -> 10000. The Shifts work above and the accounting
// batch landed the same day: together they measure 9900 KB, exactly the
// cap, so the next kilobyte from anyone would fail the build. The accounting
// batch is about 180 KB in all (Reports with the column layouts, Packages,
// Access, PFS Builder, Leasing). Needs the owner's nod like the bumps above
// (Visesh).
// Sep 30, 2026: 10000 -> 10050. Shifts laid out like Teams Shifts (Visesh:
// the team grid with photos and colored shift blocks, and a Requests page
// with New Request) measured 9999 KB locally - 1 KB under the cap, and CI's
// clean install reads higher than a local build, so the Cloudflare build
// would have failed and left the old frontend serving. +14 KB for the
// feature; the old team table came out as the grid went in. No new
// dependency. Needs the owner's nod like the bumps above (Visesh).
// Sep 30, 2026: 10050 -> 10150. The 09/29 accounting call (Charmi, Neil):
// Filters, chips, the Excel writer, the General Ledger report, the saved
// reports screen, PFS from the ledger, MRI, package adjustments, the Send
// dialog, the priority bar and the Intacct access import - about 76 KB of
// new screens, measured at 10076 KB. Deliberate; every piece was asked for.
// Oct 1, 2026: 10150 -> 10200. Neil's Oct 1 Ticket review (PR #407): the
// rich-text intake, Requester picker, help-topic Which One? lists, Latest
// Comment column, requester Mark Resolved, satisfaction survey and the
// department on/off settings - about 16 KB, less 5.5 KB for the retired Report
// a Bug composer, so ~10 KB net. Dev measured 10144 KB in CI (6 KB under),
// so it tipped at 10154 KB. Deliberate; every piece was asked for.
// Oct 2, 2026: 10200 -> 10320. Charmi's 09/30 call + the Shifts QA against
// Teams (Visesh: "do recommended ... make it big clean and easier"): the
// Schedule rebuilt with a side-panel editor, Day/Week/Month, Share dialog,
// context menus and keyboard support; a Requests inbox with tabs; the Shifts
// settings category; Workday shift requests; pay history priced per day and
// the Time Clock settings section; Accounting figures through <Amount />.
// Measured exactly 10200 KB locally after merging dev's Locations work, and
// CI's clean install reads about 10 KB higher. +120 KB of headroom for the
// batch; the old ShiftsPanel, ShiftSelfService and modal editors came out as
// the new screens went in. No new dependency. Deliberate; every piece was
// asked for (Visesh, 10/02).
// Oct 2, 2026 (late): 10400 -> 10480. Charmi's export batch: the report's
// Export menu now builds ledger-line files (linesExport.js: PDF / Excel /
// CSV) and Save to Files opens the full Files browser. ~5 KB over.
// Oct 2, 2026 (evening): 10320 -> 10400. Charmi + Neil's accounting batch:
// columns per picked employee, Egnyte destination + folder browser, Journals
// filter, Flux Analysis, drill from every figure, PFS classification + Move
// to + liabilities/real estate from the ledger + Excel + co-borrower +
// Schedule E/C + jewelry, Budget / Vendors & Customers / Allocations tabs,
// Export for Intacct. Measured 10295 KB locally (25 KB under), CI reads about
// 10 KB higher. +80 KB headroom. No new dependency. Deliberate; every piece
// was asked for (Visesh, 10/02: "build all of it").
// Oct 6, 2026: 10480 -> 10750. Charmi + Neil's 10/04 review batch: MRE
// (a new Reporting tab), loan amortization schedules + rate stress tests,
// the Loans rebuild (detail, payment history, manual loans, Egnyte folders),
// PFS Affiliated Entities + per-file lock + first page, the MRI rent roll
// filters / notes / tenant card, Dashboard / Reporting / Tools dropdowns.
// Measured 10654 KB locally; CI reads about 10 KB higher. No new dependency.
// Deliberate; every piece was asked for (Visesh, 10/06: "fix all of these").
// Oct 7, 2026: 10750 -> 10850. Property tickets (#434, Neil 10/05 + Pranshu
// 10/06): the property picker on ticket forms, Property Walkthrough (many
// tickets at one property in one submit), the Asset Management Maintenance
// tab's Support-style ticket tables, Needs Action -> maintenance record with
// recurring services, the nested Maintenance Log with filters, and the world
// currency picker. CI measured 10809 KB with dev at 10743 (dev was 7 KB under
// the cap, so any feature tipped it). No new dependency. Deliberate.
const TOTAL_KB     = 10850;

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
