# BFF Migration Plan - Greens Nexus auth hardening

Status: proposal (Aug 4 2026). Owner: Visesh. Purpose: replace browser-held MSAL
tokens with a Backend-For-Frontend (BFF) session so the white-screen / stuck-on-
Employee class of bug is eliminated structurally, and tokens leave the browser.

## Why

Today the SPA holds the Entra token (localStorage) and renews it silently via a
hidden iframe that depends on third-party cookies. Browsers increasingly block
those, so renewal fails and the app is left with a dead token -> white screen
(`RoleContext` can't resolve) or silent downgrade to `employee`. All the recent
band-aids (`_maybeReauth`, `AuthStuckOverlay`, the RoleContext retry, keep-last-
known-role) treat symptoms. BFF removes the cause: the browser stops renewing
tokens at all.

## Target architecture

- The **FastAPI backend becomes a confidential OAuth client**. It does the Entra
  code exchange and all token refreshes server-to-server (no iframe, no 3p
  cookies, refresh token ~90-day sliding instead of the SPA's 24h cap).
- The browser holds only an **opaque, HttpOnly, Secure session cookie**. It can't
  read tokens; XSS can't exfiltrate them.
- Tokens live in a **server-side session store** (Postgres table), encrypted at
  rest (reuse the Fernet / `NEXUS_VAULT_KEY` pattern from the credential vault).

## The clean seam (why this is tractable)

`backend/auth.py:get_current_user` is the single choke point: it validates the
Bearer ID token and returns `{email, role, level}`. **Every** `require_module_grant`
/ `require_team_write` / router dependency consumes that output. BFF rewrites
*only* `get_current_user` (Bearer -> session cookie) and the frontend's token
acquisition. The whole authorization layer, RLS model, and grant logic are
untouched.

## Prerequisite: same-site cookie (RESOLVED - low risk)

The frontend and backend are on **different registrable domains** today
(`nexus.greensglobal.com` vs `greens-nexus-api-*.azurewebsites.net`), so a
backend-set cookie would be a blocked **third-party** cookie. BFF needs the API
to be **same-site** as the app.

**Confirmed feasible on both environments:** dev AND prod are Cloudflare-fronted.
So Phase 0 is a **Cloudflare Worker/route** that reverse-proxies
`nexus.greensglobal.com/api/*` -> the Azure backend, on each zone. Cookie becomes
first-party (`SameSite=Lax`), and this is config, not a re-architecture. It also
retires the randomized `*.azurewebsites.net` host from the user-facing surface
and lets us tighten CSP `connect-src` toward `'self'`.

## Decisions (locked Aug 4 2026 - defaults, override any)

1. **Same-site:** Cloudflare route `/api/*` -> Azure, per environment.
2. **Session store:** Postgres `server_sessions` table (no new infra; reuse Supabase PG).
3. **Token encryption at rest:** reuse Fernet / `NEXUS_VAULT_KEY` (already in prod).
4. **Confidential client:** add a client secret + web redirect to the EXISTING
   Nexus app reg (`be6f1e37-…`); keep the clientId.
5. **CSRF:** double-submit token (`X-CSRF-Token`), checked on state-changing methods.
6. **Cookie:** `HttpOnly; Secure; SameSite=Lax; Path=/`.

Explicitly unaffected: the silent **agent/device-token** auth (timeclock capture /
"Silent App User") does NOT use user MSAL - BFF leaves it alone. Step-up MFA and
Act-As are preserved via the session (`auth_time` on the row; `X-Act-As-Session`
unchanged). Local dev keeps `NEXUS_SKIP_AUTH`.

## Backend work

1. **Entra:** turn the app reg into a confidential client - add a client
   secret (or cert) in Key Vault, register the web redirect `…/auth/callback`.
   Keep the SPA reg only until Phase 4.
2. **Session store:** `server_sessions` table - `sid` (opaque, in cookie),
   `user_email`, `access_token`/`refresh_token`/`id_token` (Fernet-encrypted),
   `expires_at`, `auth_time` (for step-up), `csrf_token`, `created_at`,
   `last_seen`. RLS-enable it (backend-only, like every other table).
3. **New endpoints** (`routers/auth_bff.py`):
   - `GET /auth/login` -> redirect to Entra authorize (Auth Code + PKCE), state
     in a short-lived signed cookie.
   - `GET /auth/callback` -> exchange code, create session row, set the session
     cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`), redirect to app.
   - `POST /auth/logout` -> delete session row + clear cookie.
   - `GET /auth/me` -> `{email, name, role, level}` for the app to bootstrap.
4. **Rewrite `get_current_user`:** read the session cookie -> load session ->
   refresh the access token server-side if within skew of expiry -> return the
   same `{email, role, level}`. Preserve exactly: the `X-Act-As-Session`
   impersonation path, and the `NEXUS_SKIP_AUTH` / `NEXUS_DEV_EMAIL` local dev
   bypass (a fake local session).
5. **CSRF:** cookies auto-send, so add a double-submit CSRF token (returned by
   `/auth/me`, echoed in an `X-CSRF-Token` header) checked on all state-changing
   methods. Strict CORS: exact-origin allowlist, `credentials: true`, no `*`.
6. **Step-up MFA:** re-auth still forces `prompt=login`; store the fresh
   `auth_time` on the session; `/stepup/verify` reads it from the session
   instead of a client token. Behavior preserved.

## Frontend work

1. Delete MSAL (`msalInstance`, `authConfig`, `getAuthHeader` Bearer logic).
2. `api.js`: every request uses `credentials: 'include'`; drop the Bearer
   header; attach `X-CSRF-Token` on mutations. **Collapse all recovery to one
   rule:** on `401`, redirect to `/auth/login` (preserving the current route to
   return to). This replaces `_maybeReauth`, the RoleContext retry, and
   `AuthStuckOverlay`.
3. Login = redirect to `/auth/login`. Logout = `POST /auth/logout`.
4. `RoleContext` simplifies: read `/auth/me` once; no token juggling, no
   keep-last-known hack needed (the fetch stops failing spuriously). Keep the
   "never downgrade on transient error" guard as belt-and-suspenders.

## Rollout (phased, dev-first, reversible)

- **Phase 0 - prerequisites** *(blocks everything; split by owner):*
  - **You (portal):** (a) add a client secret to the Nexus app reg (`be6f…`) +
    register web redirect `https://nexus.greensglobal.com/api/auth/callback` (and
    the dev host); (b) put the secret in Azure app settings (or Key Vault); (c)
    create the Cloudflare route `nexus.greensglobal.com/api/*` -> Azure backend on
    the dev zone first, then prod.
  - **Me (code):** a tiny `/api/health` behind the new route to prove the proxy +
    first-party cookie round-trip on dev before any auth code lands.
- **Phase 1 - dual-mode backend:** ship `/auth/*` + session store; make
  `get_current_user` accept **either** a valid Bearer (existing) **or** a
  session cookie (new). Nothing breaks; Bearer users keep working.
- **Phase 2 - frontend behind a flag:** cookie mode on dev only; verify login,
  refresh across a multi-day tab, step-up, Act-As, logout.
- **Phase 3 - flip default** to cookie; keep the Bearer path as fallback for one
  release.
- **Phase 4 - remove** MSAL, the Bearer branch, and the SPA app-reg. Done.

## Risks & mitigations

- **Same-site cookie** (above) - the #1 risk; validate the proxy before any code.
- **CSRF** - double-submit token + SameSite + strict CORS.
- **Session theft** - HttpOnly/Secure cookie; encrypt tokens at rest; short
  session idle timeout + server-side revocation (logout actually kills it,
  unlike a stateless JWT).
- **Local dev** - preserve `NEXUS_SKIP_AUTH`; add a dev-only `/auth/login` that
  mints a local session for `NEXUS_DEV_EMAIL`.
- **8 gunicorn workers** - session store is Postgres (shared), not in-process, so
  no affinity needed.

## Effort (rough)

Phase 0: 0.5-1 day (mostly Entra + Cloudflare config). Phase 1: ~2 days. Phase
2-3: ~2 days incl. testing across step-up/Act-As. Phase 4: 0.5 day. Its own
branch, not bundled with feature work.

## Not doing (explicitly)

Not moving to a stateless JWT-in-cookie (loses server-side revocation). Not
touching RLS, grants, or the `require_*` layer. Not a big-bang cutover - the
dual-mode Phase 1 is what makes this safe.
