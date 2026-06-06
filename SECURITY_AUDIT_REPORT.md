# Greens Nexus — Security Audit Report
**Application:** Greens Nexus Master Portal  
**URL:** https://dev.nexus.greensglobal.com  
**Audit Date:** 6 June 2026  
**Last Updated:** 6 June 2026 — remediation pass applied to `dev` branch (commit `b5b9604`)  
**Prepared by:** Engineering Team  
**Stack:** React + Azure AD (MSAL) + Supabase + FastAPI (Azure App Service)

---

## Executive Summary

This report assesses the security posture of the Greens Nexus portal across authentication, API authorization, data access controls, infrastructure, and readiness for financial data at scale (10,000+ users).

**Overall Rating: 7.5 / 10 — Significant hardening applied. Two items remain before financial data in production.**

A full remediation pass was applied on 6 June 2026 covering all critical and high authorization gaps, SSL, CORS, and input validation. The two remaining blockers for financial data are Supabase RLS tightening (H1) and confirming the auth bypass flag is off in Azure (H4).

| Category | Original Rating | Current Rating | Status |
|---|---|---|---|
| Authentication (login/identity) | 8/10 | 8/10 | No change — Azure AD is enterprise-grade |
| Authorisation (role enforcement) | 3/10 | **9/10** | All API endpoints now enforce roles server-side |
| Data security (Supabase RLS) | 5/10 | 5/10 | Open item — H1 still needs SQL fix |
| Transport security | 4/10 | **9/10** | SSL verification restored on all backend connections |
| Infrastructure / secrets | 5/10 | 5/10 | Open item — H2/H4 require manual action |
| Frontend hardening (CSP) | 7/10 | **8/10** | File upload validation added |
| Scalability to 10,000 users | 4/10 | 4/10 | Rate limiting and audit logging still pending |

---

## Finding Status

### Critical Findings

---

#### C1 — Any employee can approve, reject, or allocate requisitions
**File:** `backend/routers/requisitions.py`  
**Original Severity:** Critical  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

All six PATCH action endpoints now enforce role-based access at the API layer:

| Endpoint | Required Role |
|---|---|
| `approve` | Manager+ (level 3) |
| `reject` | Manager+ (level 3) |
| `allocate` | Supervisor+ (level 2) |
| `initiate-return` | Own item, or Supervisor+ |
| `confirm-return` | Supervisor+ (level 2) |
| `mark-lost` | Supervisor+ (level 2) |

The UI restrictions remain unchanged — the backend now mirrors them.

---

#### C2 — Any employee can create hardware assets
**File:** `backend/routers/requisitions.py`  
**Original Severity:** Critical  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

`POST /hardware-assets` now requires `administrator` role (level 4). Employees and managers receive a 401 if they call this endpoint directly.

---

#### C3 — Financial data visible to all managers with no department scoping
**File:** `backend/routers/accounting.py`  
**Original Severity:** Critical  
**Status: OPEN — accepted risk, monitor**

Accounting data (transactions, RAMP, AMA) is gated behind `require_manager` which is the correct intent — all managers have cross-department visibility by design. This is a business decision, not a misconfiguration. Flagged for review if the organisation later requires department-level financial isolation.

---

#### C4 — Full requisition export available to any authenticated user
**File:** `backend/routers/requisitions.py` line 250  
**Original Severity:** High  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

`GET /requisitions/export/excel` now requires `manager` role (level 3). Employees calling this endpoint receive a 401.

---

### High Severity Findings

---

#### H1 — Supabase RLS policies allow unrestricted read of notification and inventory data
**File:** `supabase_realtime_setup.sql`  
**Severity:** High  
**Status: OPEN — requires SQL change in Supabase dashboard**

The RLS policies on `nexus_notifications` and `inventory_requests` still use `USING (true)`, meaning the anon key can read all rows. The backend API now enforces per-user scoping for all reads (notifications use token email; inventory requests filter by token for non-managers), which mitigates the risk significantly. However, a direct Supabase query using the anon key bypasses the backend entirely.

**Required fix (run in Supabase SQL Editor):**
```sql
-- nexus_notifications: only deliver to the addressed recipient
DROP POLICY IF EXISTS "anon_read_notifications" ON nexus_notifications;
CREATE POLICY "anon_read_notifications"
  ON nexus_notifications FOR SELECT TO anon
  USING (recipient = '' OR recipient IS NULL OR recipient = current_setting('request.jwt.claims', true)::json->>'email');

-- inventory_requests: only the requester or authenticated managers
DROP POLICY IF EXISTS "anon_read_inventory_requests" ON inventory_requests;
CREATE POLICY "user_read_own_inventory_requests"
  ON inventory_requests FOR SELECT TO anon
  USING (requested_by_email = current_setting('request.jwt.claims', true)::json->>'email');
```

---

#### H2 — UniFi Cloud API key stored in .env file
**File:** `backend/.env`  
**Severity:** High  
**Status: OPEN — requires manual action**

The `UNIFI_API_KEY` remains in the local `.env` file. This file is excluded from Git but lives on disk.

**Actions required:**
1. Rotate the UniFi API key in UniFi Cloud Dashboard
2. Move the key to Azure App Service → Configuration → Application Settings
3. Remove the value from the local `.env` file (replace with a placeholder comment)

---

#### H3 — SSL certificate verification disabled in backend
**Files:** `backend/unifi_client.py`, `backend/database.py`  
**Severity:** High  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

Both SSL overrides removed:
- `unifi_client.py`: `verify=False` removed from `httpx.AsyncClient`
- `database.py`: `check_hostname = False` and `verify_mode = ssl.CERT_NONE` removed; standard `ssl.create_default_context()` now used

All backend traffic to Supabase and UniFi Cloud now verifies TLS certificates.

---

#### H4 — Authentication bypass flag present in environment
**File:** `backend/.env`, `backend/auth.py`  
**Severity:** High (Critical if in production)  
**Status: OPEN — requires verification**

`NEXUS_SKIP_AUTH=true` in the local `.env` is correct for local development. Must be confirmed absent from the Azure App Service production and staging environments.

**Action required:** Azure Portal → App Service → Configuration → Application Settings — confirm `NEXUS_SKIP_AUTH` is not present or is set to `false`.

---

#### H5 — No rate limiting on any API endpoint
**File:** `backend/main.py`  
**Severity:** High  
**Status: OPEN — not yet implemented**

No rate limiting middleware exists. At 10,000 users this creates a denial-of-service and data extraction risk. Recommended: add `slowapi` with per-user limits (~5 req/min on exports, ~60 req/min on general endpoints).

---

#### H6 — `/roles/sync` endpoint was unauthenticated *(new finding)*
**File:** `backend/routers/roles.py`  
**Original Severity:** High  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

`POST /roles/sync` was publicly accessible with no authentication. Anyone could POST a list of emails and seed them into the roles table as `employee`. Now requires `administrator` role (level 4).

---

#### H7 — Any authenticated user could read any person's notifications *(new finding)*
**File:** `backend/routers/notifications.py`  
**Original Severity:** High  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

`GET /notifications` previously accepted an `email` query parameter and returned that user's notifications to anyone. Identity is now derived exclusively from the verified Azure AD token — the email parameter is ignored entirely.

`PATCH /notifications/{id}/read` previously accepted `email` in the request body. Now uses the token email.

---

#### H8 — Any authenticated user could read any person's inventory requests *(new finding)*
**File:** `backend/routers/inventory_requests.py`  
**Original Severity:** High  
**Status: FIXED — commit `b5b9604`, 6 June 2026**

`GET /inventory-requests` now enforces token-based scoping: non-managers (level < 3) only receive their own requests regardless of any query parameter. Managers retain full visibility.

---

### Medium Severity Findings

| # | Issue | Status |
|---|---|---|
| M1 | Reviews endpoint had no authentication | **FIXED** — `get_current_user` added to router (commit `b5b9604`) |
| M2 | File uploads had no type or size validation | **FIXED** — JPEG/PNG/GIF/WebP allowlist + 10 MB limit enforced before upload (commit `b5b9604`) |
| M3 | MSAL silent failure returns empty auth header, allowing unauthenticated requests | **OPEN** — low exploitability; backend rejects tokenless requests |
| M4 | Role assignment accepts any string as email with no format validation | **OPEN** |
| M5 | Supabase service key used in backend code | **OPEN** — ensure it never appears in logs; rotate periodically |
| M6 | Stale CORS origin (`vlow2k.github.io`) was present | **FIXED** — removed from allowed origins (commit `b5b9604`) |

---

### Low Severity Findings

| # | Issue | Status |
|---|---|---|
| L1 | No audit logging for role changes, approvals, or financial data access | **OPEN** — required for compliance |
| L2 | CSP `img-src` includes `data:` and `blob:` URIs | **Accepted** — required for image upload preview |
| L3 | Auth error messages reveal expected header format | **OPEN** — low priority |
| L4 | Supabase anon key visible in frontend bundle | **Accepted** — by design; risk is contained if H1 is fixed |

---

## Authentication Assessment (What's Working Well)

- **Azure AD / MSAL** — enterprise-grade identity; Microsoft manages MFA, conditional access, and key rotation
- **Token validation** — backend verifies Azure AD public key, audience, and issuer correctly
- **Session storage** — tokens cleared on browser close; not accessible cross-origin
- **Content Security Policy** — added 6 June 2026; blocks XSS script injection, restricts fetch targets, prevents clickjacking
- **HTTPS everywhere** — Cloudflare Pages (frontend) and Azure App Service (backend) both enforce TLS
- **SSL verification** — restored 6 June 2026 on all backend-to-backend connections

---

## Readiness for Financial Data

**Current verdict: Nearly ready — two items must be confirmed first.**

| Requirement | Status |
|---|---|
| Only authorised roles can view financial data | **Pass** — `require_manager` enforced on all accounting endpoints |
| All requisition/approval actions role-gated at API layer | **Pass** — fixed 6 June 2026 |
| SSL verification on all backend connections | **Pass** — fixed 6 June 2026 |
| Auth bypass disabled in production | **Verify** — confirm `NEXUS_SKIP_AUTH` absent from Azure App Service config (H4) |
| Supabase RLS enforces user-level isolation | **Fail** — H1 SQL fix still required |
| All financial actions are audit logged | **Fail** — L1 still pending |
| Rate limiting prevents bulk data extraction | **Fail** — H5 still pending |

Once H1 (Supabase RLS) and H4 (Azure config verification) are confirmed, the system is at a defensible baseline for financial data. Rate limiting and audit logging should follow as the next sprint's priority.

---

## Scalability to 10,000 Users

The identity layer (Azure AD) scales to millions of users without changes. Remaining bottlenecks:

1. **No rate limiting** (H5) — a misbehaving client can degrade the API for all users
2. **No database connection pooling** — at 10,000 users, SQLAlchemy without PgBouncer will hit connection limits on Supabase
3. **Supabase Realtime** — targeted channel subscriptions (already implemented) scale well within Supabase Pro tier
4. **Excel export** — blocking server-side operation; should move to a background job with a download link at scale

---

## Remediation Roadmap

### Completed — 6 June 2026 (commit `b5b9604`)
- [x] Role checks on all requisition action endpoints (C1)
- [x] Hardware asset creation restricted to administrator (C2)
- [x] Requisition export restricted to managers (C4)
- [x] SSL certificate verification restored — database and UniFi client (H3)
- [x] `/roles/sync` gated behind administrator auth (H6)
- [x] Notifications scoped to token identity (H7)
- [x] Inventory request list scoped to token identity for non-managers (H8)
- [x] Reviews router requires authentication (M1)
- [x] File upload type and size validation (M2)
- [x] Stale CORS origin removed (M6)
- [x] Content Security Policy headers added via Cloudflare `_headers` (commit `9a2120a`)

### Immediate — Manual actions required
- [ ] Verify `NEXUS_SKIP_AUTH` is absent/false in Azure App Service config (H4)
- [ ] Rotate UniFi API key; move to Azure App Service environment variables (H2)
- [ ] Apply Supabase RLS SQL fix for `nexus_notifications` and `inventory_requests` (H1)

### Next Sprint
- [ ] Add `slowapi` rate limiting to FastAPI — exports ≤5/min, general ≤60/min (H5)
- [ ] Implement audit logging table for financial actions, role changes, and approvals (L1)
- [ ] Add Pydantic `EmailStr` validation on role assignment endpoint (M4)

---

*Report generated by internal engineering audit, 6 June 2026. Updated same day following remediation pass.*
