# Accounting Module TO-DO - Nexus + Standalone Finance Webapp

> STATUS: PARKED (Visesh, Aug 25 - "save this and we will pick it up later").
> Exploration is COMPLETE (3 deep sweeps below); decisions are CONFIRMED;
> detailed design appended at the bottom.
> When resuming: copy this to docs/Accounting-Module-Plan.md in the Nexus
> repo and write a memory entry (couldn't do either in plan mode).

## Context (draft - exploration in progress)

Neil asked Visesh to start the Accounting module (call, Aug 24: "Did you start
accounting?" - "I just created the environment"). A friend has built a finance
app (React/Vite + Supabase, ~3,100 files incl. Electron/mobile shells) at
`C:\Users\Vlow\Downloads\Finance-App-main (1)\Finance-App-main`.

The ask (Visesh, Aug 25):
1. Extract EVERY feature from the finance app (inventory).
2. Inside Nexus: an Accounting area in the NEXUS UI carrying the light
   surfaces - account reports, dashboards, "basic things".
3. The heavy accounting features live in a SEPARATE webapp derived from the
   finance app, which Nexus redirects/hands off into.
4. That standalone webapp must look EXACTLY like Sage Intacct (the team's
   reference tool - Charmi/Neil know Intacct; it's already in External Links).
5. This turn: plan only.

## Understanding so far

- Finance app: Lovable-scaffolded (has .lovable), Vite + TS, Supabase backend,
  Electron + Capacitor mobile shells, e2e + vitest, deploy configs for
  Vercel/Cloudflare/Hostinger. Inventory pending (Explore agents).
- Nexus: React 19 + Vite + FastAPI + Supabase (dev/prod projects), MSAL auth,
  grant-driven modules, existing `accounting.py` router stub.

## Decisions (confirmed with Visesh, Aug 25)

- Standalone app scope: FINANCE-ONLY - Finance + Petty Cash + Customers hubs;
  HR/Payroll hub OFF via per-org module flags (Nexus stays the one HR system).
- Hosting: Cloudflare Workers (already on Workers Paid; zone exists) at
  accounting.greensglobal.com.
- Database: NEW dedicated Greens-owned Supabase project for accounting
  (~+$25/mo Pro); fresh push of the 363 migrations + the missing
  internal_api_keys migration.

## Nexus-side facts (explored)

- Accounting module ALREADY REGISTERED end-to-end: `backend/routers/accounting.py`
  (grant-gated, 4 endpoints), 3 flat tables (accounting_trx, ramp_transactions,
  ama_entities), `frontend/src/views/Accounting.jsx` (1,042 lines, 11 sub-tabs:
  transactions, invoices, budgets, imports, ramp, vendors, ask-accountant, ama,
  mre, mri, reports) - only Ramp cards are real; the rest is mock consts.
  "Created the environment" = this scaffold. Same situation PropertyAsset was in.
- Module registration pattern documented (9 files) - already done for accounting.
- External-app integration: Nexus NEVER iframes cross-origin apps; the universal
  pattern is window.open link-out (ExternalLinks). The only local-app embed is
  the PDF editor (same-origin /pdf-editor-app/ + postMessage theme sync).
- SSO precedent: external_auth mints the BFF session cookie from a one-time
  token; app_url() for redirect-back. Egnyte OAuth = per-user token pattern.
- DB topology: Nexus backend = ONE SQLAlchemy engine/one DATABASE_URL (pool
  budget tight). Cleanest cross-app data access = HTTP (Egnyte/Ramp/UniFi
  shape), NOT a second engine. Supabase STORAGE creds are separate/easy.
- UI patterns to reuse for reports/dashboards: InvestorRelations module (9
  financial sub-tabs) as the structural template; TimeInsights as the report
  screen model; DashCard/StatCard + KPI_CATALOG (widgets.jsx) to surface
  accounting KPIs on dashboards; .wkc cards, .req-table/.stack-table,
  ModuleTabs, AsyncState.

## Feature inventory (finance app - "BusAcTa One", condensed)

A stripped fork of an accounting-firm SaaS keeping 4 hubs: FINANCE, PETTY
CASH, HR, CLIENTS (+ admin/internal/guide). ~280 tables, ~250 SQL functions;
POSTING LOGIC LIVES IN POSTGRES (post_journal_entry, post_invoice_journal,
enforce_journal_balance triggers, reverse_* fns) - migrations port functions,
not just tables.

FINANCE HUB (the crown jewels):
- GL: chart of accounts (8 types, tree, import wizard, templates), GL
  defaults, double-entry journal (typed recorders: expense/income/transfer/
  journal/payroll/bill/pay-vendor/budget), drafts, recurring schedules,
  day book, general ledger + client ledger (SQL RPCs w/ running balances).
- AP: vendor master (allowed GL accounts, merge, spend), vendor bills,
  vendor payments. AR: invoices + proformas (editor, PDF from drag-drop
  template builder, void/recall, numbering), payments application, WIP kiosk
  (billable events -> invoice), import-tasks from sibling app.
- Banking: statement import (XLSX/CSV/PDF w/ per-bank profiles - INDIAN
  banks: HDFC/SBI/ICICI/Axis/Kotak/AU/BOI), splits, merchant memory,
  auto-match rules, QBO-style reconciliation wizard + PDF rec reports.
- Budgets: budget journal (parallel ledger) + 5 budget-vs-actual reports.
- REPORTS (9): P&L (+book comparison), Balance Sheet, Cash Flow (AS-3
  direct, SQL RPC), A/R Aging, Unbilled WIP, Revenue per Client, Client
  Billing, Partner Settlement (w/ period locks + signoffs), Vendor
  Statement. Book-tag filter everywhere (both/tax_only/actual_only =
  the multi-book tax mechanism; no GST/VAT rate engine).
- Dashboards: Finance Overview (month rev/exp/cash KPIs, budget attainment,
  6-mo revenue trend, A/R aging, recent invoices), Accounts Overview.
- Customers: unified B2B firms + B2C direct clients + general; per-project
  pricing matrices (difficulty x return-type axes).
PETTY CASH HUB: entries, ledger, reconciliation wizard, own CoA flags,
  3 reports (P&L, cash flow, GL).
HR HUB (OVERLAPS NEXUS): employee directory/import/org chart, attendance
  (leaves, tardiness, biometric import), FULL PAYROLL (salary structures,
  runs w/ verification grid, slips, GL posting).
CLIENTS HUB: firm/direct-client shells (partially orphaned from nav).
ADMIN: orgs (multi-tenant + 14 per-org module flags), members, branding,
  PDF templates, monitoring (activity/log/login/perf/errors), SOC2 posture,
  DB usage. GUIDE hub: manual/sitemap/route-health/system design.
PLATFORM: Electron wrapper, separate productivity-tracker Electron app,
  Capacitor mobile config, Tally ERP import, Gemini doc-categorization edge
  fn, SMTP email edge fn, Twilio/WhatsApp OTP, internal cross-app API
  (x-internal-api-key) with /api/internal/{clients,employees,invoices,
  finance-summary,billing-status}.

HALF-BUILT/GOTCHAS: access control in nav is BYPASSED (RLS is the real
boundary); report Customize drawer stubs (cash-vs-accrual NOT working);
internal_api_keys table has NO migration (created ad hoc in remote DB);
two conflicting Supabase project refs; stale guide/manual from parent app;
~40% dead schema (esign/organizer/marketing/chat...); base currency INR;
no fixed-asset register (internal_assets = IT tracker); no inventory;
no Plaid (manual statement import only); OFX claim is false.

## Finance app architecture (explored)

- Stack: TanStack Start v1.16x SSR on Nitro (NOT plain Vite SPA), React 19,
  TS strict (0-error typecheck gate), Tailwind v4 CSS-first, shadcn new-york
  (47 primitives), TanStack Query v5 + file-based Router (237 routes, 812 TS
  files, 305 components). Lovable-origin but actively hardened (audit ledger,
  UTC fixes, pagination ceilings removed).
- Backend: Supabase-only data, 363 migrations, RLS in 167 of them = the real
  authz boundary. Server logic in TanStack server functions (23 modules), only
  2 edge functions (doc-categorize w/ Gemini, send-email). MULTI-TENANT orgs
  ("associate firms") enforced server-side via set_active_org()/RLS; roles
  super_admin|admin|member + external "client" portal role.
  CAUTION: two different Supabase project refs leak in-repo (config.toml vs
  MIGRATION_PLAN.md) - must resolve before deploy.
- Auth: Supabase email/password ONLY (single signInWithPassword call) + TOTP
  MFA gate + device-limit gate + email/WhatsApp OTP. `jose` dep present unused.
  SSO scaffolding exists: x-internal-api-key table (hashed, scoped - sibling
  apps already call /api/internal/* with it) and admin generateLink() used in
  4 places -> magic-link SSO handoff is the cheap path.
- Deploy: three targets (Cloudflare Workers legacy, Vercel preset, Node
  self-contained .output - documented Hostinger runbook, health at
  /api/health, pg_cron webhooks). Standalone hosting is a solved problem.
  Caution: default `npm run build` ships a PRE-BUILT committed .output - use
  build:node / build:vercel for clean builds.
- Theming: ONE token file (src/styles.css, OKLCH vars via @theme inline);
  existing `.theme-paper` flat theme is already near-Intacct; 14 per-hub
  accent themes to flatten; DB-driven branding (app_settings id='branding' -
  rename/logo with zero code). Nav is data-driven (use-nav.tsx) - Intacct
  top-nav restructure = shell + one config, not 237 routes.
  Rebrand estimate: ~3-5 days total for full Intacct look.
- Code health: good except TESTS (~4% unit coverage, node-env only, e2e
  skip-marked) - reskin verification will be visual, not automated.
- SSO friction to plan: MFA/device gates double-prompt (need SSO bypass flag),
  org must be set server-side at handoff, user provisioning/email mapping.

## To-do when we pick this up (working order)

Phase 0 - Stand up the fork (repo + infra):
- [ ] Fork the finance app into a Greens-owned repo (suggest: Greens-Global/
      greens-accounting); get the friend's blessing/license in writing.
- [ ] New dedicated Supabase project; `supabase db push` the 363 migrations;
      WRITE THE MISSING internal_api_keys migration (table exists only in the
      friend's remote DB); seed an org for Greens + entities.
- [ ] Resolve the two conflicting project refs in-repo (supabase/config.toml
      vs MIGRATION_PLAN.md); scrub friend's env/branding strings (~91 hits).
- [ ] Clean build via build target explicitly (NOT default `npm run build` -
      it ships a pre-built committed .output); deploy to Cloudflare Workers
      at accounting.greensglobal.com (Workers Paid already active).
- [ ] Turn HR/Payroll hub OFF via per-org module flags (Finance + Petty Cash
      + Customers stay). Ignore electron/, electron-tracker/, mobile/.

Phase 1 - Intacct reskin (est. ~3-5 days):
- [ ] Start from `.theme-paper` (already near-Intacct flat); new `sage` theme
      in src/lib/shared/theme.tsx + one :root token block in src/styles.css
      (muted corporate blue primary, gray sidebar, radius ~0.25rem, kill
      mesh/glass shadows).
- [ ] Flatten the 14 per-hub accent themes (styles.css:1017-1320).
- [ ] Top-nav Intacct layout: src/lib/routing/use-nav.tsx (data-driven) +
      src/components/shell/app-shell.tsx; density pass on ui/table.tsx.
- [ ] Rebrand via DB (app_settings id='branding') + string sweep
      (BusAcTa/TaxOps/offshoreaccounting/busacta.com).

Phase 2 - US adaptation:
- [ ] Base currency INR -> USD (fmtINR sites, currency-picker default).
- [ ] Dates to MM/DD/YYYY + 12h (Nexus-wide rule).
- [ ] US bank import: keep manual CSV/XLSX (Indian PDF parsers harmless);
      add profiles for Greens' banks (F&M, BofA, US Bank...) as needed.
- [ ] Decide multi-book tax tags usage for US books (or default 'both').

Phase 3 - SSO handoff (Nexus -> accounting app):
- [ ] Recommended: magic-link handoff. Nexus FastAPI endpoint (grant-gated,
      'accounting') -> POST accounting /api/internal/sso with
      x-internal-api-key -> supabaseAdmin.generateLink(magiclink, work_email)
      -> 302. Reuses existing scaffolding (keys.server.ts + generateLink
      already used in 4 places).
- [ ] SSO bypass flag for the TOTP MFA gate + device-limit gate (MSAL already
      MFA'd); set active org server-side in the handoff payload.
- [ ] User provisioning: map/auto-provision by Nexus work_email; decide who
      gets accounts (Charmi + Neil + accounting team first).

Phase 4 - Nexus-native surfaces (reports/dashboards/basics in Nexus UI):
- [ ] Extend the accounting app's /api/internal/* with a reports/KPIs
      endpoint (P&L, BS, cash flow, A/R aging, month KPIs) - it already has
      finance-summary/invoices/clients endpoints + hashed key auth.
- [ ] Nexus FastAPI proxy router (grant-gated 'accounting', cached, HTTP out
      via the Egnyte/Ramp shape - NOT a second DB engine).
- [ ] Rebuild frontend/src/views/Accounting.jsx: keep Ramp cards (real);
      replace mock tabs with: Overview (KPIs + revenue trend + A/R aging),
      Reports (read-only P&L/BS/CF/aging with period stepper), Invoices
      (recent, deep-link rows into the webapp), and an "Open Accounting"
      handoff button (SSO). Kill dead mock tabs (mre/mri/ama decide with
      Charmi). Model on InvestorRelations structure + TimeInsights visuals.
- [ ] Add accounting KPIs to dashboard/widgets.jsx KPI_CATALOG so they're
      placeable dashboard widgets.
- [ ] External Links: fix the wrong Intacct URL row (points at my.jive.com).

Phase 5 - Go-live:
- [ ] Chart of accounts import (wizard exists) from QuickBooks export.
- [ ] Charmi parallel run vs QuickBooks (like SwipeClock playbook: one clean
      month before any cutover talk).
- [ ] RLS/advisor posture check on the new Supabase; spend review (+~$25/mo
      Supabase + Workers usage).

Risk register: thin tests in the fork (visual verification only); posting
logic is ~250 Postgres functions (any schema change = SQL work); friend-repo
hygiene (secrets/refs); report Customize drawer is stubbed (cash-vs-accrual
NOT functional - set expectations with Charmi); Gemini/Twilio/SMTP
integrations need Greens' own keys or stay off.

---

## DETAILED DESIGN (appended after parking - full architecture pass)

Refines the to-do above. Where they differ, this section wins, EXCEPT hosting
(see note). Total estimate: ~6-7 engineering weeks, go-live ~10-11 weeks
(phases 3+4 parallelizable).

### Key refinements over the draft to-do
- IMPORT AS A SQUASH, NOT A GIT FORK: copy tree, secrets-scan, single initial
  commit - the friend's history may contain secrets/refs. Get WRITTEN IP
  assignment before Phase 1 ends.
- DELETE (not ignore) at import: committed `.output/` (pre-built bundle with
  the friend's Supabase ref BAKED IN - running it silently hits HIS database;
  nastiest gotcha), electron/, electron-tracker/, mobile/, .env*.
- HOSTING NOTE: designer recommends the Vercel preset (lowest ops, first-
  class support in repo); Visesh chose Cloudflare Workers (existing Workers
  Paid + zone). RESOLVE AT RESUME - Workers target is the repo default but
  flagged "legacy" in the app's own docs. Either works; pick one deliberately.
- TWO GO-LIVE BLOCKERS the draft missed:
  * FISCAL YEAR: app assumes India Apr-Mar; set to CALENDAR YEAR before
    posting anything (reports/budget periods hang off it).
  * 1099/TAX FILING: app has no US 1099 vendor tracking - QuickBooks stays
    the TAX system of record through the first year-end; Greens Accounting is
    the operational ledger.
- CLIENTS HUB RULE: its Customers = AR system of record ONLY; client
  management stays in Nexus (avoid recreating the HR dueling-masters problem).
- PAYROLL GL: don't keep the payroll module; launch with a recurring-JE
  template Charmi fills per pay period; later optional
  POST /api/internal/journal-entries so Nexus pushes the payroll-summary JE.
- CURRENCY: fmtINR uses en-IN lakh/crore grouping - replace with one
  formatCurrency util (en-US, org-driven), grep-kill fmtINR/rupee usages.
- Guide hub: HIDE (stale parent-app content).

### Phase plan (designed)
- P0 (2-3 days): ownership agreement, squash-import + prune, Supabase project
  (us-west-1), secrets scan.
- P1 (1 wk): db push 363 migrations (fix-forward failures, create storage
  buckets), WRITE the missing internal_api_keys migration (derive schema from
  src/lib/internal-api/keys.server.ts + types.ts; RLS deny-all/service-role),
  seeds (Greens org, module flags, branding row, US CoA, admin user, one
  Nexus API key), env matrix, staging deploy, smoke-test post_journal_entry
  and friends.
- P2 (2 wks): Intacct reskin + US adaptation. Tokens: near-white gray bg,
  flat white panels, 1px #d0d0d0 borders, 2px radius, shadows off, Intacct
  link-blue accent ~#2e77b9, dark blue-slate top bar ~#1b2a3e, 13px base.
  Flatten 14 hub themes. NEW src/components/shell/top-nav.tsx consuming
  use-nav.tsx data (dark top bar + white hub menubar w/ mega-menu dropdowns),
  mobile drawer fallback. Density pass on ui/table.tsx (py-1.5, 13px, gray
  header band, right-aligned numerics). Branding row. QA all reports.
  US: USD, MM/DD/YYYY+12h, calendar fiscal year, hide tax-tag UI behind a
  flag (do NOT rip schema), one US bank CSV mapping profile, accrual-only
  reports at launch (communicate to Neil/Charmi).
- P3 (1 wk): SSO. Nexus GET /api/accounting/sso (BFF + accounting grant) ->
  POST finance /api/internal/sso (x-internal-api-key; body email/full_name/
  role/next; RESTRICT to @greensglobal.com) -> find-or-create user w/
  app_metadata.sso_provider='nexus' + org membership -> admin.generateLink
  (magiclink, redirectTo /sso-landing?next=...) -> 302. Bypass TOTP +
  device-limit gates when sso_provider=='nexus' (MSAL already MFA'd).
  /sso-landing auto-selects the single org via set_active_org(). Grant
  removal = handoff lockout (SSO users have no password).
- P4 (1-1.5 wks): new read-only internal endpoints (same key check):
  /api/internal/reports/{summary,pnl,balance-sheet,cash-flow,ar-aging} +
  extended /api/internal/invoices (status/limit/href) - all calling the SAME
  Postgres report functions as the in-app reports. Nexus accounting.py:
  delete mocks, httpx proxy handlers /api/accounting/*, grant-gated, 5-min
  TTL cache, env ACCOUNTING_BASE_URL + ACCOUNTING_INTERNAL_KEY, NO second
  DB engine. Accounting.jsx rebuild: keep ramp; new overview (KPI row +
  recent invoices + Open Greens Accounting deep links); rebuilt reports
  (P&L/BS/CF/aging read-only) + invoices; kill transactions/budgets/imports/
  vendors/ask-accountant/ama/mre/mri mock tabs. KPI_CATALOG additions:
  acct_cash_balance, acct_ar_outstanding, acct_net_income_mtd,
  acct_overdue_invoices.
- P5 (1 wk build + 4-6 wks elapsed): US CoA import from QuickBooks export,
  customers/vendors/open AR-AP/opening trial balance at cutover, 1-month
  Charmi parallel run (GL+AR+AP only) vs QuickBooks, reconcile month-end.

### Designed risk mitigations
- Thin tests: build a golden-master harness BEFORE any SQL change (post a
  canonical JE/invoice/payment set on a scratch org, snapshot trial balance +
  reports, diff after changes).
- Never edit Postgres posting logic pre-go-live; all US adaptation stays in
  UI/settings.
- Critical files: finance app app-shell.tsx, styles.css, keys.server.ts;
  Nexus backend/routers/accounting.py, frontend/src/views/Accounting.jsx.

