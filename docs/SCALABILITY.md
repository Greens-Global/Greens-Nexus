# Nexus - Scalability & Production Readiness

A single-page map of how Nexus scales and where the deliberate limits are, for
technical due diligence. Every claim here is backed by code in this repo and the
linked detail docs. Written 2026-08-01.

## Posture in one paragraph

Nexus is a React 19 + FastAPI + Supabase Postgres app, deployed on Azure App
Service (Always On) behind Cloudflare, with the frontend on Cloudflare/GitHub
Pages. It is engineered for correctness and cost-efficiency at its current scale
(~180 employees) with the specific next scaling steps identified, costed, and
triggered rather than pre-built. The caching, pooling, authorization, and
observability fundamentals are in place and verified; the deferred items are
documented with the exact signal that should un-defer each.

## How it scales today

**Database load.** A shared SQLAlchemy engine with a tuned Queue pool
(`backend/database.py`, sized against Supabase's 60-connection ceiling with the
incident math inline), routed through the Supavisor pooler. Hot, slow-changing
reads are served from an in-process TTL cache with single-flight population
(`backend/cache.py`) - people directory, permission grants, item types,
approver/allocator lists, settings - each invalidated by a commit-driven hook so
a write is never stale to the writer. Verified: 100 identical reads collapse to
2 SELECTs.

**Network / client load.** Three layers: `api.js` (auth, retry, Act-As), a
short-TTL request cache with mutation invalidation, and TanStack Query for the
reference-data reads (`docs/DATA-FETCHING.md`). ETag/304 revalidation
(`middleware_hardening.py`) makes unchanged responses near-free on the wire.
Polling is visibility-aware (`lib/pollWhileVisible.js`) - background tabs make
zero requests, which was previously most of the API's traffic.

**Cold starts.** Eliminated at the infra level (Always On, both environments).

## Security posture

- **Data layer contained:** every table has RLS enabled; the public anon key was
  empirically probed against sensitive tables (employees, vault, HR docs,
  payroll, roles) on dev AND prod - reads return 0 rows, writes are rejected
  (42501). App-layer authorization is regression-tested (`test_auth_access.py`,
  591 routes swept).
- **Abuse:** per-IP throttles on auth failures and e-sign token guessing, tuned
  so a signed-in user is never affected (only token-less requests count).
- **Secrets:** the credential vault fails CLOSED on a deployed server without its
  real key rather than using fake crypto.
- **Events:** security events land in the audit trail + logs; uncaught client
  errors report to the server (`/client-errors`, Sentry-ready).
- Detail: `docs/SECURITY-TODO.md`, `docs/ENTERPRISE-HARDENING.md`.

## Operational readiness

- CI gate on dev + main: auth tests, build, bundle budget, dependency scans
  (`.github/workflows/ci.yml`).
- Schema-drift checker catches the missing-column outage class
  (`check_schema_drift.py`); found and closed a real drift on both DBs.
- Release checklist (`docs/RELEASE-CHECKLIST.md`) and disaster-recovery runbook
  with a quarterly restore rehearsal (`docs/DR-RUNBOOK.md`).
- Dependencies patched off known CVEs (pyjwt, pypdf, pillow, python-multipart,
  python-dotenv, fastapi, starlette).

## Deferred, with un-defer triggers (the honest scaling roadmap)

| Item | Why deferred | Un-defer when |
|---|---|---|
| **Redis** (shared cache/locks/rate-limits) | In-process caches are correct and fast now; per-worker is fine at this scale | Cross-worker staleness becomes user-visible, a second region/instance is added, or workers exceed ~16 |
| **Per-user RLS policies** on the sensitive ~15 tables | App-layer authz works and the anon key is already contained; per-user policies are a large, correctness-critical design task | Before onboarding external/B2B users who authenticate directly to Postgres |
| **Cursor pagination + delta endpoints** | ETags already make unchanged refetches near-free; lists are in the hundreds | Any core list crosses ~2,000 rows or ~1 MB gzipped |
| **Alembic migrations** | Additive ALTER lists + the drift checker cover the real failure mode | First destructive (drop/rename/type-change) migration, or drift causes an incident despite the checker |
| **RoleContext -> TanStack Query** | Holds bespoke 401-recovery, anti-flash loading, and optimistic updates; converting needs runtime click-testing | Done as a focused, browser-tested change - never a blind autonomous swap |
| **Distributed tracing (OpenTelemetry)** | One backend + one DB; the error reporter + query metrics answer today's "where's the time" questions | Backend splits into multiple services, or a slow-request cause becomes hard to locate |

## What a buyer's engineer should verify

```
# frontend
cd frontend && npm ci && npm run build && npx eslint src --quiet
# backend
cd backend && pip install -r requirements.txt
python -m unittest test_auth_access -v          # authorization boundary
python check_schema_drift.py                    # schema integrity
```

All pass as of 2026-08-01 (the one unrelated test that needs UniFi credentials
is skipped).
