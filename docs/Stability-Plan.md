# Stability Plan - Greens Nexus (production-grade)

Status: active (Aug 4 2026). Owner: Visesh. Goal: failures become **small,
invisible, detected, and reversible** - the app stays stable through deploys,
cache churn, and auth expiry. This is not "zero bugs" (no system achieves that);
it's "no user-visible outage."

Companion docs: [`BFF-Migration-Plan.md`](BFF-Migration-Plan.md) (auth track).

---

## Current state - what's ALREADY solved (don't rebuild)

Frontend deploy/cache stability is largely done:
- **Immutable hashed assets** + **`index.html: no-cache`** + **`version.json: no-store`** (`frontend/public/_headers`).
- **Self-healing chunk errors:** `ViewErrorBoundary` detects `ChunkLoadError` /
  dynamic-import failures and reloads; `RootErrorBoundary` reloads; the whole app
  is wrapped so a crash never renders blank.
- **"New version" nudge:** `useBuildVersion` polls `version.json`; `UpdateBanner`
  offers a refresh when a running tab is on superseded code.
- **Unhashed files** get a `?v=<build id>` stamp (`stampUnhashedAssets` in
  `vite.config.js`), so guard.js/the PDF engine bust per deploy.
- **Asset archive:** CI "Archive assets to R2" already uploads built assets.
- Backend `/health` liveness; a synthetic uptime ping (`uptime.yml`).
- CI is a real merge gate (lint, backend boot/auth tests, build + bundle budget).

## The real gaps (this plan)

1. **Backend deploys restart the worker** -> the 502 / CORS-storm window. No blue-green.
2. **R2 archive isn't wired as a fallback origin** -> an old chunk still 404s, so
   the self-heal is a *reload* not a *seamless* fetch.
3. **No error observability / RUM** -> a white screen is invisible until a user
   complains ("you failed me"). This is the biggest gap.
4. **No defined SLOs or alerts** -> nobody is paged; regressions are noticed by luck.
5. **Cloudflare edge cache rules unaudited** -> the actual root cause of the Jul 28
   HTML poisoning lived in the zone config, not the repo.

---

## Target SLOs

| Signal | Target |
|---|---|
| Prod API + frontend availability | **99.9%/month** (~43 min error budget) |
| API latency | p95 < **800 ms**, p99 < **2 s** (excl. known-heavy exports) |
| API error rate (5xx) | < **0.5%** of requests |
| Login success rate | > **99%** |
| User-visible white screen | ~**0** (error boundary -> reload always catches) |
| Deploy | **zero 5xx spike** during a release |

## Alert metrics (the alerting spec)

Severity: **P1** = page immediately (user-facing outage), **P2** = notify within
the hour (degradation), **P3** = digest/review.

| # | Metric | Condition | Sev | Source tool |
|---|---|---|---|---|
| 1 | Synthetic availability | `/health` fails 2 consecutive checks (~2 min) | P1 | Cloudflare Health Checks / uptime.yml |
| 2 | API 5xx rate | > 2% over 5 min | P1 | Azure App Insights |
| 2b| API 5xx rate | > 0.5% over 15 min | P2 | Azure App Insights |
| 3 | 502 rate spike | any sustained 502s (the stalled-event-loop signal) | P1 | Azure App Insights / Cloudflare |
| 4 | API p95 latency | > 2 s over 10 min (event-loop-block symptom) | P2 | Azure App Insights |
| 5 | DB readiness | `/health/ready` returns 503 | P1 | Azure health probe |
| 6 | Deploy warm-up | slot not `ready` within warm-up window | auto | Azure slot swap (blocks swap) |
| 7 | Frontend error spike | error events/min above baseline, esp. new release | P2 | Sentry |
| 8 | ChunkLoadError volume | spike after a deploy (signals stale-asset / R2 gap) | P2 | Sentry |
| 9 | Unhandled backend exception | any NEW issue in a release | P2 | Sentry |
| 10| Login failure rate | auth success < 98% over 15 min | P1 | Sentry / backend metric |
| 11| Bundle budget | JS over cap | block | CI (already enforced) |
| 12| RLS advisor | any `rls_disabled_in_public` finding | P3 | scheduled `get_advisors` |
| 13| TLS cert expiry | < 14 days | P2 | Cloudflare / uptime |

Route P1 to a pager (phone) + Teams; P2/P3 to Teams/email.

---

## Workstreams & tasks (owner-tagged)

### A. Backend blue-green (kills the deploy outage)
- **[You]** Upgrade the App Service plan to **Standard+** and enable a **staging
  slot**; run **≥2 instances**.
- **[You]** Edit `.github/workflows/main_greens-nexus-api.yml` to **deploy to the
  staging slot -> wait for `/health/ready` -> swap** (I can hand you the exact YAML
  to paste; I can't push workflow files - my token lacks `workflow` scope).
- **[Me - done]** `/health/ready` deep readiness probe (DB check) for slot warm-up.
- **[You]** Point the Azure health-check path at `/health/ready`.

### B. R2 fallback (makes the self-heal seamless)
- **[Me - done]** `infra/cloudflare/r2-asset-fallback.worker.js`.
- **[You]** Confirm the CI R2 key layout, deploy the Worker on the `/assets/*`
  route (dev then prod), bind the R2 bucket. Verify the `X-Asset-Source` header.

### C. Observability (see failures before users do)
- **[You]** Create Sentry project(s) -> get frontend + backend DSNs; enable Azure
  **Application Insights** on both App Services.
- **[Me - on your DSN]** Wire `@sentry/react` (frontend) + `sentry-sdk` (backend),
  tagged with the **build/release id**, gated on the DSN env var (inert when unset).
  One commit once you have the DSN.

### D. Alerting
- **[You]** Configure the rules in the table above in Sentry / App Insights /
  Cloudflare; wire P1 -> pager.
- **[Me]** Ensure the app emits what alerts need (release tags, `/health/ready`).

### E. Cloudflare edge cache audit (the Jul 28 root cause)
- **[You - 15 min]** In the zone dashboard: confirm **no "Cache Everything" page
  rule** hits the HTML; confirm **Cache Deception Armor** is on; confirm HTML is
  `no-cache` at the edge, `/assets/*` immutable. This is where the poisoning came
  from - repo headers can't override a bad zone rule.

### F. Auth (separate track)
- **[BFF plan]** eliminates the login white screen. See `BFF-Migration-Plan.md`.

---

## Shipped in this commit
- `/health/ready` readiness probe (A).
- `infra/cloudflare/r2-asset-fallback.worker.js` (B, ready to deploy).
- This plan + alert spec.

## The honest through-line
None of this makes failure impossible. It makes failure **small** (blue-green,
2 instances), **invisible** (self-heal + R2 fallback + graceful boundaries),
**seen** (Sentry + alerts), and **reversible** (slot swap = instant rollback).
That is what "production-grade" means - and it's the same shape Amazon uses, at
your scale.
