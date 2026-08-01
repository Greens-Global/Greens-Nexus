# Enterprise Hardening - status of the 13-point gap analysis

Tracks the enterprise-readiness pass started 2026-08-01. Each item is either
shipped (with where), or a deliberate decision to defer (with why + trigger).

## Shipped (2026-08-01)

| # | Item | What shipped |
|---|---|---|
| 2 | Rate limiting / abuse detection | `middleware_hardening.py`: per-IP auth-failure throttle (60/5min -> 120s block) + the e-sign token-guessing throttle now logs to the security trail |
| 3 | Secrets not fail-safe | Vault fails CLOSED on a deployed API without `NEXUS_VAULT_KEY` (503, not fake dev crypto) - `routers/credvault.py` |
| 4 | Security events to nowhere | `security_log()` writes throttle trips + lockouts to `audit_logs` (visible in the in-app Activity Log) AND stdout |
| 5 | Migrations by convention | `check_schema_drift.py` - compares models vs the live DB, exit 1 on drift; found + closed a real 2-column drift on dev+prod during this pass |
| 8 | No HTTP caching semantics | `ETagMiddleware` - every JSON GET carries an ETag + `no-cache`; unchanged responses become empty 304s |
| 9 | No performance guardrails | `frontend/scripts/check-bundle-size.mjs` runs on every build (postbuild), fails past budget |
| 10 | No observability | `errorReporter.js` + `/client-errors` -> uncaught JS errors and crashed views land in the audit trail; `NEXUS_SENTRY_DSN` init point wired in `main.py` (inert until a DSN is set) |
| 12 | Thin CI gate | `.github/workflows/ci.yml` extended to dev+main: auth-boundary tests, build+bundle budget, `pip-audit` + `npm audit` |
| 13 | Recovery untested | `DR-RUNBOOK.md` - restore procedures + a quarterly rehearsal checklist |
| - | Dependency CVEs | Upgraded pyjwt, pypdf, pillow, python-multipart, python-dotenv, fastapi, starlette off known-vuln versions; pinned in `requirements.txt` |

## Verified, no change needed

| # | Item | Finding |
|---|---|---|
| 1 | Single trust tier at DB | The service-role posture is real but the anon key is FULLY contained: probed every sensitive table (nexus_employees, vault_credentials, hr_documents, payroll_rates, nexus_roles) on dev AND prod with the anon key - reads return 0 rows, writes 42501 (RLS violation). The lockout works today. The upgrade below (real per-user policies) is defense-in-depth, not a hole. |

## Foundation adopted (2026-08-01)

**TanStack Query (React Query)** is now the standard client data layer - the
scalable-from-day-1 foundation for a product built to sell. Client cache keyed
by request, automatic dedup, background refresh, and mutation/identity
invalidation, sitting on top of the existing `api.js` fetch engine (auth/retry
unchanged). Foundation + the reference-data read layer are converted and
verified; remaining screens convert mechanically per `docs/DATA-FETCHING.md`,
one branch at a time (the two cache layers coexist, so a half-migrated app is
correct at every step). Deliberately NOT big-banged - that would be the
un-enterprise move.

## Deferred - with the trigger that should un-defer it

**#1 (part 2) - real per-user RLS policies on the ~15 most sensitive tables.**
Today RLS is used as a total lockout (enabled, no policies) and authorization
lives in FastAPI. Writing per-user `USING`/`WITH CHECK` policies (HR, payroll,
vault, e-sign) would mean a FastAPI bug can't over-expose data. NOT done now
because it's a large, correctness-critical design task that must be modeled
against the JWT `email` claim and tested per table - a rushed policy that's too
tight breaks the app, too loose does nothing. **Trigger:** schedule as its own
branch before onboarding any external/B2B users who authenticate directly.

**#6 - shared cache (Redis).** All caching is in-process per worker (see
`cache.py`), correct and fast at current scale. Redis buys globally-consistent
cache/rate-limit/locks. **Trigger:** cross-worker staleness becomes visible to
users, OR a second region/instance is added, OR worker count grows past ~16.
Adopting it now would be complexity without payoff.

**#7 - delta/paginated list endpoints.** Big lists return every row; fine at
hundreds. ETags (shipped) already make unchanged re-fetches nearly free, which
covers most of the pain without an API-contract change. **Trigger:** any core
list (items, tasks, people) crosses ~2,000 rows or a list response exceeds
~1 MB gzipped. Then add cursor pagination + a `?since=` delta param and move
those modules from polling to the Supabase realtime-ping pattern the bell uses.

**#11 - Alembic migrations.** The hand-maintained ALTER lists work and now have
a drift checker (#5) catching the exact failure mode that bit before. A full
Alembic retrofit across 146 tables is high-risk for low marginal gain right
now. **Trigger:** the next time schema drift causes an incident despite the
checker, or when a destructive migration (drop/rename/type-change) is genuinely
needed - Alembic's down-migrations matter there; the additive-only ALTER
pattern can't express them safely.
