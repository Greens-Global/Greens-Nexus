# External Users - Rollout Guide (Aug 17)

Neil: "External users must be connected and turned on today - I have 7-9 people
that need access asap."

Chosen path: **Microsoft Entra B2B guest invitations** + a **Nexus allowlist**.
This is exactly what the July plan recommended (Tier B in
`docs/Roles-Access-Dynamic-and-External-Plan.md`, and
`docs/External-Users-Phase4.md` section 4b), now actually enforced in code.
No new login system, no new app registration, no new tenant settings beyond
turning on invitations. Employees are completely unaffected.

One deliberate hardening beyond the July doc: Phase 4 said "a guest token needs
zero new auth code" because `_role_for` defaulted unknown emails to employee.
That default meant ANY guest invited into the tenant (by anyone, for any
reason, e.g. Teams collaboration) could open Nexus as a baseline employee.
That is now closed: **non-company identities are default-denied unless an
active external-user row exists in Nexus** (see "What was implemented").

---

> **Update (Aug 18, Visesh):** invitations are now sent FROM NEXUS. Adding a
> person in Roles & Access > External Users sends the Microsoft invitation
> email automatically via Graph - nobody needs the Entra portal per person.
> One NEW one-time Entra step is required first: grant the app registration
> the **User.Invite.All** application permission (section 2a, step 3).

## 1. What Neil's 7-9 people will experience

1. They receive a Microsoft invitation email ("Greens Global invited you..."),
   sent the moment an admin invites them from the Nexus panel.
2. They click **Accept invitation** once and sign in:
   - a work Microsoft account (their own company's M365) signs in directly;
   - a Gmail/other personal address gets a Microsoft-emailed one-time passcode
     (no password to create, nothing to install).
3. They open the normal Nexus URL (nexus.greensglobal.com / dev.nexus...),
   press **Continue with Microsoft**, and sign in with their own email.
4. Nexus checks its allowlist. If Visesh has enrolled that email and it is
   active, they land inside; the sidebar shows ONLY what they were granted
   (default: **Tasks** and **Tickets**). No Dashboard, no Time Clock, no My HR,
   no People, no company data.
5. In Tasks/Tickets they see only items they are assigned to, follow, raised,
   or that live in a project they were explicitly added to - never the
   company-wide task list or the help-desk queue.
6. If they are NOT enrolled (or were deactivated/expired), the sign-in bounces
   back to the Nexus login screen with a red notice: "This account is not set
   up for Nexus. Ask your Greens Global contact to add you as an external
   user." Being a tenant guest alone grants nothing.

Off-boarding = one click (Deactivate in Nexus - takes effect within ~60s) and
optionally deleting the guest in Entra.

---

## 2. Entra admin steps (Visesh, tonight - portal only, ~10 min once)

All in https://entra.microsoft.com with an admin account.

### 2a. One-time checks (before the first invite)

1. **External collaboration settings**
   Entra ID > External Identities > External collaboration settings:
   - "Guest invite settings": anything EXCEPT "No one in the organization can
     invite guest users". Recommended: "Only users assigned to specific admin
     roles can invite guest users" (you invite them yourself).
   - "Guest user access": the default "Limited access" (or the most
     restrictive option) is fine - Nexus does not rely on guests reading the
     directory.
   - Leave "Guests can invite" off.
2. **Email one-time passcode** (covers Gmail/non-Microsoft addresses)
   Entra ID > External Identities > All identity providers > Email one-time
   passcode > confirm it is **enabled** (it is the default on current tenants).
3. **Grant User.Invite.All so Nexus can send the invitations** (NEW, one-time)
   The backend sends invitations with its existing app-only Graph credentials
   (`backend/graph_mail.py`, driven by the `AZURE_CLIENT_ID` /
   `AZURE_CLIENT_SECRET` app settings on the Azure App Service - the SAME
   Nexus app registration that already sends mail via Mail.Send; its client id
   in code is `be6f1e37-83a8-4a29-8b46-96d20beb32f9`). Exact clicks:
   Entra ID > **App registrations** > (that Nexus app) > **API permissions** >
   **Add a permission** > **Microsoft Graph** > **Application permissions** >
   search **User.Invite.All** > check it > **Add permissions** > then press
   **Grant admin consent for Greens Global** (the button above the table).
   Until this is done, inviting from Nexus still creates the allowlist row but
   the invite is marked **Invite Failed** with this exact instruction - fix
   the permission, then press **Resend Invite** on each row.
4. **App registration - verify, no other changes expected**
   The code uses tenant `40966012-...dc60` as the authority and app
   `be6f1e37-...32f9` for both the SPA and the BFF confidential client
   (`backend/auth.py`, `frontend/src/authConfig.js`). Guests invited into OUR
   tenant get tokens from OUR tenant with OUR app's audience, so the
   single-tenant registration works for them as-is. Verify only:
   - Entra ID > Enterprise applications > (the Nexus app) > Properties >
     **"Assignment required?"** - if it is **Yes**, either set it to **No** or
     assign each guest to the app under Users and groups. If it is No (the
     default), nothing to do.
   - No redirect-URI changes. Guests consent to the same
     openid/profile/email scopes on first sign-in.
5. **MFA for guests** (recommended, not blocking): if Security Defaults are on,
   guests already get MFA prompts. With Entra P1, add a Conditional Access
   policy "require MFA for guest and external users" instead.

### 2b. Inviting the 7-9 people - from Nexus, not the portal

Roles & Access > External Users > **Invite External User**: email (the EXACT
address they will sign in with), name, company, optional expiry, module grants
(defaults pre-checked). **Send Invite** does both halves at once: creates the
allowlist row AND sends the Microsoft invitation email (Graph
`POST /v1.0/invitations`, redirect target = the Nexus URL for that
environment via `app_url()`). Per-row states:

- **Invite Sent** - Microsoft delivered the redemption email. Re-sending any
  time is safe (**Resend Invite** just emails the redemption link again).
- **Invite Failed** - the row exists and will work once the person is a guest,
  but the email did not go out. The toast/tooltip says why (usually the
  User.Invite.All consent above, or Graph creds missing locally). Fix, then
  **Resend Invite** - or invite manually in Entra > Users > New user > Invite
  external user with the same address.
- **Invited Manually** - the address already exists in the tenant (already a
  guest or a member); nothing needed to be sent.

The person can accept the invite at any time; Nexus access only works once
BOTH the invite is redeemed and their Nexus row is active.

---

## 3. Nexus-side rollout (dev first, then prod)

There are **no new tables** - only four new columns on `nexus_employees`
(`external_company`, `invited_by`, `expires_at`, `invite_status`) plus rows in existing tables
(`nexus_employees`, `nexus_groups`, `nexus_group_members`). The columns are in
BOTH migration lists in `backend/main.py`, so they self-apply on deploy.
**No new RLS work is required for this release** (nothing new for the anon key
to see). Still run `get_advisors` after the release per the standing rule.

Order of operations:

1. **Merge this branch to `dev`** (announce in team chat first - the dev API
   restarts). Wait ~4 min for the Azure deploy; the two migration lines apply
   themselves on startup. Frontend deploys via Cloudflare in ~1 min.
2. Do the one-time **User.Invite.All** consent (section 2a step 3) so invites
   can actually send.
3. On dev.nexus as an admin: **Roles & Access > External Users > Invite
   External User** - invite ONE test address (a Gmail you control) with the
   default grants. This sends the Microsoft invite AND auto-creates the
   "External - Tasks (Editor) + Tickets (Editor)" access group on first use.
4. Run the 10-minute test script (section 6) against dev with that guest.
5. **Release to prod** the normal way (PR dev -> main). Migrations self-apply
   on the prod deploy the same way.
6. On prod: invite the real 7-9 emails from Roles & Access > External Users
   (after Visesh confirms the list - section 7). UI only, no SQL and no Entra
   portal needed per person.
7. Add each person to the projects/tickets they should work: Tasks > project >
   Share/members, or assign tasks to their email. Until they are added to
   something, their Tasks screen is simply empty (fail-closed).

**Deactivating someone is Nexus-side only** - Deactivate on their row blocks
their sign-in within ~60 seconds regardless of Entra. Deleting the Entra guest
account afterwards (Entra > Users) is OPTIONAL cleanup, not required for
lockout; do it when the relationship truly ends so the tenant stays tidy.

---

## 4. What was implemented (file by file)

Backend
- `backend/auth.py` - the core:
  - `email_from_claims()`: shared claim resolver; employees resolve exactly as
    before; B2B-guest `#EXT#` UPNs resolve deterministically to the INVITED
    email (prefers plain `email`/`unique_name` claims, else un-mangles the
    UPN). Used by both Bearer and BFF paths.
  - `apply_external_policy()`: runs on EVERY request identity (Bearer, cookie,
    Act As). Company-domain emails (`NEXUS_INTERNAL_DOMAINS`, default
    greensglobal.com + greensg.onmicrosoft.com) pass through untouched. Any
    other email must have an ACTIVE, unexpired `identity_type='guest'/
    'external'` row in `nexus_employees` or the request 403s (default-deny).
    Allowlisted externals are hard-capped at employee level (manager
    broadcasts/bypasses can never reach them even if a nexus_roles row slips
    in) and are path-gated: app-shell endpoints plus only the API prefixes
    their module grants map to (`EXTERNAL_MODULE_PREFIXES`); everything else
    403s. Cached like the role cache (60s TTL, `invalidate_external_cache`).
- `backend/bff_session.py` - `normalize_email` now delegates to the shared
  resolver so cookie logins (what dev/prod actually use) resolve guests
  identically.
- `backend/models.py` - `NexusEmployee` + `external_company`, `invited_by`,
  `expires_at`, `invite_status` (appended; used only on guest/external rows).
- `backend/main.py` - the three ALTER lines in BOTH migration lists (SQLite +
  Postgres) + registers the new router.
- `backend/routers/external_users.py` (new) - admin-gated CRUD:
  GET/POST `/external-users`, PATCH `/external-users/{email}`, GET
  `/external-users/meta`, POST `/external-users/{email}/invite` (resend).
  Enrolling ALSO sends the Entra B2B invitation via Graph
  `POST /v1.0/invitations` (reusing `graph_mail.py`'s cached app-only token -
  no second Graph client; sync endpoints run on FastAPI's threadpool so the
  call never blocks the event loop). Graph failures never block enrollment:
  the row is created, `invite_status` records sent/failed/manual, and the
  response carries the exact remedy. Grants restricted to the external-safe set
  (tasks/tickets/documents/sop/external-links; viewer/editor only, never
  full/owner). Access flows through ONE auto-managed "External - ..." group
  per distinct grant set (visible/auditable in the Groups tab). Rejects
  company-domain emails and emails already in People.
- `backend/routers/myhr.py` - `/myhr/directory` now EXCLUDES guest/external
  rows (NULL-safe), so externals never appear in any people picker,
  assignment list, or name-resolution surface built on the directory.
- `backend/routers/roles.py` - `/roles/me` returns `is_external` (and reports
  the employee cap for externals).
- `backend/routers/task_util.py`, `tasks.py`, `task_projects.py` - task
  visibility helpers now recognize an external caller: the org-wide ('Nexus
  Global') default does NOT apply to them; they see only tasks/projects they
  explicitly participate in. Employees' visibility is byte-identical.
- `backend/routers/tickets.py` - `_has_desk_grant` is always False for
  externals: their grant opens the module, but they are participants-only
  (own/watched tickets), never the company agent queue, and can never write
  internal notes.
- `backend/test_external_users.py` (new) - 19 tests: claim resolution,
  default-deny, active/inactive/expired gating, employee-cap, directory
  exclusion, task/ticket scoping, admin CRUD. Plus the existing
  `test_auth_access.py` route sweep still passes.

Frontend
- `frontend/src/api.js` - the four external-users endpoints (appended).
- `frontend/src/contexts/RoleContext.jsx` - `isExternal` from `/roles/me`.
- `frontend/src/components/Sidebar.jsx` + `MobileMenu.jsx` - externals see
  ONLY granted modules in the nav (no baseline screens).
- `frontend/src/App.jsx` - `ProtectedView` enforces the same rule at render
  time and auto-navigates an external landing on a non-granted view (e.g. the
  default dashboard) to their first granted module.
- `frontend/src/bffAuth.js` + `views/LoginPage.jsx` - a 403 from `/auth/me`
  (guest not enrolled / deactivated) lands on the sign-in screen immediately
  with the server's explanation, instead of a 23s retry spinner.
- `frontend/src/views/ExternalUsersPanel.jsx` (new) + tab wired into
  `views/RolesAccess.jsx` - the admin panel: list (name, company, status,
  invite-delivery pill, expiry, grant pills), Invite External User modal
  (email/name/company/expiry + module checkboxes with Viewer/Editor; Send
  Invite creates the row AND emails the Microsoft invitation), Resend Invite,
  Edit, Deactivate/Reactivate.
- `frontend/src/views/ExternalUsersPanel.test.jsx` (new) - render-smoke tests.

Build/test status: backend 724/725 green (the one error is the pre-existing
`test_unifi_cloud` env-dependent script, unrelated); frontend 103/103 tests +
`npm run build` green; live smoke on a local backend verified enroll ->
guest-boundary -> deactivate end to end.

## 5. What remains / risks

- **Committed on the worktree branch, not pushed/deployed.** Merge to dev,
  then release to prod per section 3. No new env vars, no RLS, no manual SQL.
- **One human step gates invite sending: the User.Invite.All admin consent**
  (section 2a step 3). Until then every invite lands as Invite Failed with
  that instruction; the allowlist rows still work, so a manually-invited
  guest can sign in regardless.
- Invitation emails come from Microsoft Invitations
  (invites@microsoft.com), not a Greens mailbox - tell recipients to check
  spam. The redirect after redemption uses `app_url()` (NEXUS_APP_URL /
  WEBSITE_SITE_NAME), so dev invites land on dev.nexus and prod on
  nexus.greensglobal.com automatically.
- **Documents / Knowledge Base grants are org-visible.** The Documents module
  shows every shared-folder document to ANY grant holder (`documents._visible`),
  and KB likewise. They are grantable to externals but deliberately NOT in the
  default set - grant them only when exposing all of that content is intended,
  or wait for per-external scoping there (`nexus_access_scopes` exists; the
  per-endpoint filters from `docs/External-Users-Phase4.md` 4c are the follow-up).
- Externals CAN read `/myhr/directory` output (staff names/emails/photos - the
  GAL-equivalent) because Tasks needs it to show assignee names instead of raw
  emails. They never appear IN it. If Neil wants staff hidden from externals
  too, that needs a name-resolution rework - flag it, don't quietly change it.
- Deep-link reads inside the task family (a single task by guessed id) rely on
  non-guessable ids in places, same as for employees today - the list/search/
  delta surfaces are scoped. Existing posture, unchanged for staff.
- The `#EXT#` claim handling matters only for the localhost Bearer mode; on
  dev/prod (cookie mode) the synthetic MSAL account already carries the
  server-resolved email, so the whole app agrees on the guest's identity.
- Multiple gunicorn workers each hold the 60s external cache - a deactivation
  is instant on the worker that handled it and within ~60s everywhere. Same
  tradeoff as the existing role cache.
- Adding a NEW module to the external-safe set is a two-line deliberate act in
  `auth.py` (`EXTERNAL_MODULE_PREFIXES`) - check what its endpoints expose
  org-wide first. This is fail-closed on purpose.

## 6. 10-minute test script (one guest end to end, on dev)

Need: one test external mailbox you can read (a personal Gmail works).

1. As admin on dev.nexus: Roles & Access > External Users > Invite External
   User (the test email, name, company "Test Co", default grants). Expect the
   row to appear with an **Invite Sent** pill and Tasks/Tickets pills. If it
   says **Invite Failed**, do the User.Invite.All consent (section 2a step 3)
   and press **Resend Invite**.
2. Open the invitation email in the test mailbox, accept, complete the
   OTP/sign-in.
3. Default-deny check: as admin, **Deactivate** the row; the guest refreshes
   dev.nexus within a minute and lands back on the sign-in screen with the red
   "deactivated" notice. **Reactivate** to continue. (A never-enrolled tenant
   guest gets the same treatment - the allowlist row is the only door.)
4. Sign in again as the guest: expect to land inside with ONLY Tasks and
   Tickets in the sidebar. Tasks list is empty (they're in nothing yet).
5. As admin: assign any test task to the guest's email (or add them to a test
   project). Guest refreshes: exactly that task appears; company tasks do not.
6. As guest: raise a ticket; confirm it appears for them; confirm they do NOT
   see other people's tickets.
7. As admin: check the bell - no change for managers; confirm the guest never
   shows up in any people picker (e.g. Items assign, HR).
8. As admin: press **Resend Invite** on the row - expect a "sent" toast and a
   second redemption email in the test mailbox (idempotent re-invite proven).
9. Supabase dev: run `get_advisors` - expect no new RLS findings.

## 7. ASK-VISESH (needed before enrolling the real people)

1. The list from Neil: **7-9 names + emails + companies** (MCD / Aarav
   Construction / OSM?). The email each person will SIGN IN with is the one to
   invite AND enroll - confirm each with the person, not a guess.
2. Confirm the default module set: proposal = **Tasks (Editor) + Tickets
   (Editor)** only. Documents/Knowledge Base show ALL shared company content
   to any grant holder - include them only if Neil explicitly wants that.
3. Expiration policy: leave blank, or stamp e.g. 6 months on each row?
4. Which projects/teams each person should be added to in Tasks (their screen
   is empty until someone adds/assigns them).
5. Is it acceptable that externals can resolve staff names via the directory
   read (section 5)? Default answer is yes (same info as email/Teams
   collaboration exposes), but it is Neil's call to make once.
6. MFA for guests: Security Defaults prompt is on by default - confirm nothing
   in the tenant disabled it.
