# Security TODO

Running list of security items for Greens Nexus. Started 2026-06-17.

## ✅ Done (2026-06-17)
- **Prod RLS lockdown.** 12 tables had RLS *disabled* on prod (readable/writable via the
  public anon key), including PII: `nexus_employees`, `hr_candidates`, `hr_documents`,
  `hr_leave_requests`, `hr_leave_balances`, `hr_stage_events`, `hr_provision_runs`,
  `hr_provision_steps`, `nexus_groups`, `nexus_group_members`, `item_cart`,
  `item_assignments`. → Enabled RLS on all 12 (migration
  `enable_rls_on_exposed_tables_match_dev`). Advisor now clean; prod == dev.
- **Storage bucket listing.** Dropped broad `anon_read_*` SELECT policies on
  `checkout-photos` / `item-photos` / `return-photos` so files can't be enumerated.
  Public URL access still works.

## ✅ Done (2026-08-01)
- **Item 2 - mock data out of the bundle.** `INIT_HW_ASSETS` (fake assets with
  serials) and the hardcoded `DEPT_SUPERVISORS` name map removed from
  `RequisitionContext.jsx`. The fake assets were also being SEEDED into the real
  DB whenever `hardware_assets` was empty - that path now migrates real
  localStorage data only, or nothing.
- **Item 3 - endpoint authorization audit.** Swept all 591 registered routes by
  introspecting the FastAPI dependency tree: 23 routes lack a standard auth
  dependency and every one is deliberately public with its own defense (token
  credential, HMAC webhook signature, agent device token, CI token header, or
  public read-only config). Locked in as a permanent test:
  `backend/test_auth_access.py` fails if anyone adds an unauthenticated route
  without explicitly allowlisting it, and also asserts 401-without-token and
  403-without-grant behavior.
- **Item 6 - advisors re-run.** Security advisors on dev AND prod: zero ERROR,
  zero WARN. Every table has RLS enabled (the only findings are INFO
  "RLS enabled, no policies", which is the intended backend-only posture).
  The old open items - `stepup_sessions`, `item_custom_fields`, `hr_sign_*`,
  `page_help` - are all resolved on both databases.
- **Item 7a - e-sign token-guessing throttle.** Per-IP limiter on all
  `/esign/public/*` lookups in `routers/esign.py`: 20 unknown-token misses per
  15 min → 429 + log line. Legit signers never hit it (only wrong tokens
  count). Verified: 404s until the cap, then 429s; other IPs unaffected.
- **Item 5** - superseded by the shipped grant-driven model:
  `require_module_grant` enforces group grants server-side on every gated
  router; now regression-tested by `test_auth_access.py`.

## 🔲 Still open

1. **Item 4 - evidence photos live in public buckets.** Product call needed:
   handover/receipt/return photos can contain people, locations, serials.
   Moving them private requires signed-URL serving in the items module and a
   rewrite of stored public URLs - plan it as its own branch. (Bucket LISTING
   is already blocked; the URLs are unguessable but shareable forever.)
2. **Item 7c - `NEXUS_APP_URL` on prod Azure** (e-sign email links) - user
   action, see RELEASE-CHECKLIST.md step 8.
3. **`NEXUS_VAULT_KEY` on prod Azure** before real secrets enter the vault
   (Jul 22 release note) - user action, generate with
   `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
   and set it in App Service configuration. Never commit it.

## 🔲 Older items (original list, kept for history)

1. **Sanity-check nothing broke from the RLS change.** Log in as a normal user; confirm
   Item Management, notification bell (realtime), cart, and assignments all load. If
   realtime stopped (the bell uses Supabase directly via the anon key), add scoped
   SELECT policies on those tables instead of relying on backend-only access.

2. **Remove hardcoded mock data from the frontend bundle.** `RequisitionContext.jsx`
   ships `INIT_HW_ASSETS` (fake assets w/ serials + real names) and a department→manager
   map. It's downloaded by every user. Replace with API-sourced data; delete the seed.

3. **Audit backend authorization, endpoint by endpoint.** Client-side "Access Restricted"
   pages are UI-only — NOT security. Confirm every sensitive endpoint (HR, items, admin,
   roles, groups) returns 403 server-side for under-privileged users, not just a hidden
   screen. This is the real boundary.

4. **Sensitive evidence photos.** Handover/receipt/return photos sit in *public* buckets.
   Decide whether they should be private + served via signed URLs (they can contain
   people/locations/serials). At minimum for `hr-docs` (already private) confirm the
   signed-URL access pattern before HR ships.

5. **Tie into the roles/access redesign.** Every rule in the new team-scoped model must
   be enforced server-side (backend + RLS), never by hiding UI. Carry this into Phase 1.

6. **Re-run `get_advisors` (security + performance) after any DDL.** Make it a habit
   after schema changes — it catches missing-RLS regressions immediately.

7. **E-sign public endpoints (added 2026-07-03, feat/hr-esign).** `/esign/public/{token}`
   is intentionally unauthenticated (the 43-char `token_urlsafe(32)` is the credential).
   Follow-ups: (a) add rate-limiting/lockout on token guessing (currently only entropy
   protects it — fine short-term, log-watch it); (b) enable RLS on the 4 new
   `hr_sign_*` tables after first deploy (dev + prod at release); (c) set
   `NEXUS_APP_URL=https://nexus.greensglobal.com` on prod Azure so external signing
   links in emails don't point at dev.
