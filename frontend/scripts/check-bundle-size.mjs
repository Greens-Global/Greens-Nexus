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
// Oct 7, 2026: 10850 -> 11050. Accounting / Time Clock / Asset Management
// feedback (#465, Neil / Charmi / Priyanka 10/07): PFS affiliated shares,
// investments block and encrypted PDF, Loans stress + dismissals, MRI / MRE
// grids, Dashboard Customize, Reports drill chips and Ledger Search
// operators, the property Financing section. CI measured 10947 KB. No new
// dependency. Deliberate.
// Oct 10, 2026: 11050 -> 11300. Two Pranshu PRs landing on top of the #465
// batch (dev measured 11024 KB): Legal + the Implementation Guide (#464,
// Neil 10/06, ~+60 KB) and hiring packets / interview recordings / packets
// per role (#477, Neil 10/08, ~+120 KB). CI measured 11083 and 11143 KB
// separately; together ~11200. No new dependency. Same lines in both PRs so
// the second to merge does not conflict. Deliberate.
// Oct 12, 2026: 11300 -> 11500. dev itself went over after #489 (the
// workforce scorecard): its own CI measured 11314 KB, so every PR on top
// failed the budget. #517 (Tasks / Support / Shifts, Neil 10/12) and #518
// (What's New, Neil 10/12) add a few KB each (a clean build: dev 11112 KB,
// #518 11117 KB). CI measures ~200 KB more than a clean local build because
// its VITE_SUPABASE_* variables keep the Supabase client in. No new
// dependency. Same lines in both PRs so the second to merge does not
// conflict. Deliberate.
// Oct 12, 2026: 11500 -> 12000. Site Models (Neil): the to-scale 3D property
// model (Asset Management property page + the public /map/{id} unit finder)
// brings three.js, ~690 KB minified, in its own vendor-three chunk so it only
// loads for those two screens. Measured 11576 KB total with it in. A whole
// new capability, taken deliberately; the mammoth note above still names the
// cheapest real lever if the total needs to come back down.
// Oct 13, 2026: 12000 -> 12250. Nothing new here: the Site Models bump above
// was measured before Operations (#525, recharts screens on live Cubby data)
// reached dev, and this release also brings the Weather Call, Tasks (automation,
// checklists, threads, timer) and Motion stacks. CI measured 12065 KB with all
// of them together. No dependency beyond three.js. Deliberate.
// Oct 14, 2026: 12250 -> 12350. dev itself measured 12226 KB on CI, so any
// feature tipped it; #561 (task templates, recurring subtasks, the shared
// Repeat menu, ticket collaborators, tasks from tickets) measured 12252 KB.
// All app code, no new dependency. Deliberate.
// Oct 15, 2026: 12350 -> 12550. The accounting feedback batch (Visesh, 10/14 -
// 10/15): Loan Planning (#568), the Import Hub statement and payroll
// converters (#566, #570), and on top of them the Profitability / Employee
// Compensation reports (#569, measured 12376 KB) and Flux review / Actual vs
// Budget / books on every report (#571). All app code, no new dependency.
// Same lines in #569 and #571 so the second to merge does not conflict.
// Deliberate.
// Oct 15, 2026: 12550 -> 12750. dev itself measured 12519 KB on CI, so any
// feature tipped it again; #564 (Hiring: offer letter first, no-login
// intake, the hiring board and screening task) measured 12582 KB. All app
// code, no new dependency. Deliberate.
// Oct 18, 2026: 12750 -> 12950. dev itself measured 12706 KB on CI; #639
// (What's New: audience, following, requests, known issues, deprecations,
// guided tours, attachments, production tracking) measured 12810 KB. All
// app code, no new dependency. Deliberate.
// Oct 20, 2026: 12950 -> 13150. The merge of #661 (Time Clock audit: location
// trail map in People > Time, own-card controls, employee time zones, period
// close / break settings) measured 12974 KB and failed the dev Cloudflare
// Pages build and archive-assets. leaflet was already in the bundle; all app
// code, no new dependency. Deliberate.
// Oct 20, 2026: 13150 -> 13500. The Ops review release (Neil's Oct 20 call):
// Rate Management, Revenue Management, Portfolio (Daily Flash), Reports +
// Report Builder, CubeSmart-managed stores, ticket <-> property links and the
// Ops Site Map / customer unit map with the site model rebuild measured
// 13165 KB together (dev 12777). The builder, Site Map and public unit map are
// already lazy chunks; this sums every shipped file regardless. App code only,
// no new dependency. Deliberate.
// Oct 21, 2026: 13500 -> 13700. The Operations batch (#722, Miranda / Neil
// 10/21): the five dropdown menus, Rate Management rebuilt as the four CMA
// screens, the Ops Budget dashboard, the Push to Cubby settings switch, the
// facility listbox and State filter. CI measured 13589 KB on the merge
// commit, so the dev Cloudflare Pages build failed and left dev serving the
// previous frontend while its backend had moved on. App code only, no new
// dependency. Deliberate (Visesh).
// Oct 22, 2026: 13700 -> 13950. The Customer Map trade area (#736: heat map,
// hex grid, clusters and the statistics panel - its own lazy chunk, ~27 KB)
// on top of the Oct 21-22 batches (CMA, Ops Budget, Workday Purchase
// Requests, Hummingbird, Rate History, the accounting batch). CI measured
// 13712 KB (a clean local build reads ~13505 - CI's clean install runs about
// 200 KB higher, see above). No new dependency: the heat map and hexes are
// drawn by hand. Deliberate (Visesh).
// Oct 23, 2026: Hiring Setup (offer upload, Make An Offer on
// one screen, offboarding packages) fits under the cap below: 13996 KB on a
// clean local build with the planner batch. App code only, no new dependency.
// Oct 22 2026: 13950 -> 14250. Planner parity batch (PR #765) measured
// 14033 KB on CI: the Board's Group / Columns / label lanes / card previews,
// the Calendar's Unscheduled pane, colored labels with Manage > Labels, web
// links and checklist item to subtask, and My Day. A clean local build reads
// 13828 KB. My Day and Manage > Labels already load with their tab (their
// own chunks); this sums every shipped file regardless. App code only, no
// new dependency. Deliberate (Neil).
// Oct 23 2026: 14250 -> 14600. dev already read 14241 KB on CI after the
// dashboard count (#776) and Keep Private (#778); the Tasks Home pass (four
// tiles, a grouped Tasks card, Projects at Risk, Team Workload, a My Day card,
// one widget header) adds about 12 KB (14049 KB on a clean local build). App
// code only, no new dependency. Deliberate (Neil, who approved the plan
// knowing the cap would move).
// Oct 24 2026: Build Mode (src/devnotes, a lazy 85 KB chunk) measured 14086 KB
// on a plain build. Dev builds (CF_PAGES_BRANCH=dev) also carry its source
// stamps - data-nx-src="<fileId>:<line>:<col>" on host elements with a
// handler or an aria / role attribute plus each component's root element
// (scripts/nxsrc-plugin.mjs): +317 KB. The stamps are debugging metadata
// that never ships to production, so a dev-stamped build gets its own
// allowance on top of the cap instead of the cap moving for everyone: the
// prod budget below is unchanged, and the stamped dev build (14669 KB after
// the 10/23 accounting work landed on dev) is judged against cap + 350 KB.
// The same condition as vite.config.js decides whether stamps are on. The
// two bigger stamp modes (text elements too: +718 KB; every element:
// +1919 KB) do not fit any budget and stay local-only.
// Oct 26 2026: 14600 -> 14700. dev read 14586 KB on CI; Build Mode's
// screenshots with no prompt (#796, the modern-screenshot dependency, 22 KB)
// and the simpler Build Mode strip (#797) measured 14611 / 14618 KB. The
// library is a dynamic import in its own chunk (vendor-screenshot in
// vite.config.js) - left in the catch-all it pushed vendor-react, the
// first-paint chunk, to 1009 KB - so nobody downloads it until a pin's
// screenshot is taken. Deliberate (Pranshu).
// Oct 27 2026: 14700 -> 15200. The HR Keka gap release (custom fields,
// People Analytics, Approvals, HR letters, Duplicate Day, headcount and the
// careers page, Ask HR, probation, leave depth, salary advances, exits,
// goals / 1:1s / reviews, India Contractor Extra Time) is ~340 KB of new app
// code: a clean local build read 14836 KB against dev's 14497 KB. Every new
// screen is already its own lazy chunk (Analytics, Exits, Performance,
// Reviews, Careers, Approvals, Year End, the Team Leave Calendar and the
// Extra Time queue load with their tab) - first paint (index) grew 3.5 KB -
// but this cap sums every shipped file, so lazy loading cannot lower it. CI's
// clean install reads ~200 KB above a local build, so 15200 leaves ~150 KB.
// App code only, no new dependency. Needs Neil's OK with the release.
const NX_SRC_ON    = process.env.CF_PAGES_BRANCH === 'dev' || !!process.env.VITE_NX_SRC;
// Oct 28 2026: 15200 -> 15600. The Workflows module (builder, runs and the
// actions review, templates, catalog browser, Settings panel) is ~135 KB in
// lazy chunks (Builder 80, Workflows 48, Settings 7), +168 KB total: a clean
// local build read 15004 KB against the HR release's 14836 KB. CI's clean install reads ~200 KB above a local
// build, so 15600 leaves ~400 KB. App code only, no new dependency. Needs
// Neil's OK with the release (he OK'd the Oct 27 raise the same way).
const TOTAL_KB     = 15600 + (NX_SRC_ON ? 350 : 0);

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
