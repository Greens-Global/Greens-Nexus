# External Users - Rollout Guide (Aug 17, reworked Aug 18)

> **Update (Aug 18 evening, Visesh-approved): externals now sign in WITHOUT
> Microsoft at all.** The primary flow is Nexus's own passwordless login:
> a branded invitation email with a single-use activation link, then 6-digit
> one-time codes (SMS via sent.dm to a verified phone, email otherwise) that
> mint the SAME session cookie employees get. The Entra B2B guest sections
> below are LEGACY fallback only (env flag `NEXUS_EXTERNAL_GRAPH_INVITE=true`;
> default off) - no tenant invitations, no User.Invite.All consent, and no
> Microsoft account are needed for the primary flow anymore.
>
> **RELEASE STEP (LOUD): new table `external_login_codes`.** `create_all`
> builds it with RLS DISABLED. On BOTH dev and prod, as part of this release,
> run:
>
> ```sql
> ALTER TABLE external_login_codes ENABLE ROW LEVEL SECURITY;
> ```
>
> then run `get_advisors` to confirm 0 rls_disabled findings. It stores only
> HASHED codes/tokens, but the rate-limit metadata (emails, IPs, attempt
> counts) must never be anon-readable.
>
> **Env vars:** `NEXUS_SENTDM_KEY` (sent.dm API key - optional; without it
> every code simply goes by email), plus the existing `NEXUS_FROM_EMAIL` +
> `AZURE_CLIENT_SECRET` (Mail.Send) that ticket email already uses.
> **UI:** externals now live under People > **External** (admin-only tab with
> an active-count badge) - the primary management surface; the Roles & Access
> People tab keeps the person-card flow for GRANTS.

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

> **Update (Aug 18, Visesh):** invitations are now sent FROM NEXUS, and
> externals live in the **Roles & Access > People tab** like any employee -
> there is no separate External Users tab. Their access is granted through the
> normal machinery (job roles / groups - any module), not a special external
> grant set. One NEW one-time Entra step is required first: grant the app
> registration the **User.Invite.All** application permission (section 2a,
> step 3). Sign-in now always shows the Microsoft account picker, so a guest
> on a shared/work browser can pick the invited address instead of being
> silently SSO'd into an existing work account (the Pranshu test case).

## 1. What Neil's 7-9 people will experience (passwordless, Aug 18)

1. They receive a branded Nexus email: "Greens Global invited you to Nexus"
   with an **Accept Invitation** button (single-use link, 7-day expiry), sent
   the moment an admin invites them from People > External.
2. The link opens the activation page: it greets them by name, shows who
   invited them and their company, with their email read-only (the link
   arriving in that inbox is the proof of ownership).
   - Phone on file (or added right there): a 6-digit code arrives by text
     (sent.dm) - verifying it also marks the phone verified, so future
     sign-in codes go by SMS. Doubles as a second factor.
   - No phone / prefers email: a 6-digit code arrives by email instead.
3. Entering the code signs them straight in - same session cookie employees
   get, ~30-day idle life. No Microsoft account, no password, nothing to
   install.
4. Returning later: the Nexus sign-in page has a quiet **Partner Sign-In**
   link under Continue with Microsoft -> enter email -> enter the 6-digit
   code (texted to the verified phone, else emailed; "Send to My Email
   Instead" is always available) -> in. The email step always answers
   generically, so the screen never confirms whether an account exists.
5. Inside, the sidebar shows ONLY the modules their assigned roles/groups
   grant (a fresh invite has none - assign access on their People card). No
   people pickers, no manager broadcasts, no company data beyond the grants.
6. In Tasks/Tickets they see only items they are assigned to, follow, raised,
   or that live in a project they were explicitly added to - never the
   company-wide task list or the help-desk queue.
7. If they are deactivated/expired/removed, codes stop being issued (the
   request screen stays generic), live sessions are revoked immediately, and
   any leftover cookie is refused by the per-request allowlist check.

Off-boarding = one click (Deactivate in Nexus - immediate: sessions and
outstanding codes are revoked on the spot; Remove erases them entirely).

Security posture behind the flow (enforced + unit-tested in
`backend/test_external_auth.py`): codes are 6 digits, hashed at rest with
per-code salts, 10-minute expiry, single-use, a new request voids prior ones;
invite tokens are 48 random bytes, hashed, single-use, 7-day expiry, bound to
the email; 5 failed verifies kills the code and locks the email for 15
minutes; max 5 code requests per email AND per IP per hour + a 30s resend
throttle - all counted in the `external_login_codes` table so the limits hold
across gunicorn's 8 worker processes; no code or token is ever logged; audit
rows are written for invite sent / activated / login success / lockout.
Authentication only: `auth.apply_external_policy` remains the authorization
authority on every request.

---

## 2. Inviting the 7-9 people - People > External tab

### 2a. One-time server setup (env vars, not Entra)

The primary flow needs NO Entra portal work. On the Azure App Service (dev,
then prod at release):

1. `NEXUS_FROM_EMAIL` + `AZURE_CLIENT_SECRET` with the **Mail.Send**
   application permission - ALREADY in place (ticket email uses the same
   plumbing, `backend/graph_mail.py`). Nothing to do unless mail is broken.
2. `NEXUS_SENTDM_KEY` - the sent.dm API key (docs.sent.dm; free tier covers
   500 sends/day). OPTIONAL: without it every one-time code simply goes by
   email; with it, codes text to verified phones. Add when Visesh has the key.
3. `NEXUS_EXTERNAL_GRAPH_INVITE` - leave UNSET. Setting it `true` falls back
   to the legacy Microsoft B2B invitations (Appendix A).

### 2b-legacy preface (superseded - see Appendix A for the old Entra steps)

<details>
<summary>LEGACY Entra B2B one-time checks (only if NEXUS_EXTERNAL_GRAPH_INVITE=true)</summary>

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

</details>

### 2c. The invite itself

**People > External** (admin-only tab, active-count badge; the same actions
also live on the person card under Roles & Access > People) > **Invite
External User**: email (the EXACT address they will sign in with), name,
company, optional mobile phone (enables texted codes once verified), optional
expiry. **Send Invite** does both halves at once: creates the allowlist row
AND emails the branded activation link (single-use, 7 days). The person also
appears in the Roles & Access People tab with an **External** badge - but
NOT in the People directory, its counts, New joiners, or By department (the
External tab is their home). **Access is granted on their person card the
normal way** - assign a job role or add groups, any module, exactly like an
employee; until you do, they are fail-closed to the app shell. Per-person
invite states:

- **Invite Sent** - the activation email went out. **Resend Invite** mints a
  FRESH link (killing the old one) and emails it - safe any time.
- **Invite Failed** - the row exists, but the email did not go out (mail
  config - the toast says exactly what). Fix, then **Resend Invite**.
- **Invited Manually** - legacy Graph path only.

---

## 3. Nexus-side rollout (dev first, then prod)

Schema changes: five new columns on `nexus_employees` (`external_company`,
`invited_by`, `expires_at`, `invite_status`, `phone_verified_at` - all in BOTH
migration lists in `backend/main.py`, self-applying on deploy) **plus ONE NEW
TABLE, `external_login_codes`** (created by `create_all` on startup).

**MANDATORY RLS STEP at release, on BOTH dev and prod:**

```sql
ALTER TABLE external_login_codes ENABLE ROW LEVEL SECURITY;
```

Then run `get_advisors` and confirm 0 rls_disabled findings. Do this right
after each deploy (dev first, prod at release) - the standing gap from
CLAUDE.md recurs exactly here.

Order of operations:

1. **Merge this branch to `dev`** (announce in team chat first - the dev API
   restarts). Wait ~4 min for the Azure deploy; migrations + create_all apply
   themselves on startup. Frontend deploys via Cloudflare in ~1 min.
2. **Enable RLS on `external_login_codes` (dev)** - the SQL above - and run
   `get_advisors`.
3. Optional: add `NEXUS_SENTDM_KEY` to the dev App Service settings so codes
   can text (email codes work without it).
4. On dev.nexus as an admin: **People > External > Invite External User** -
   invite ONE test address (a Gmail you control, phone optional). Then, on
   their person card (Roles & Access > People), assign access the normal way
   (e.g. a group granting Tasks/Tickets). Rows enrolled before this rework
   (e.g. the Pranshu test row) surface in the External tab automatically -
   nothing to migrate; press Resend Invite to send them the new-style
   activation link.
5. Run the 10-minute test script (section 6) against dev with that guest.
6. **Release to prod** the normal way (PR dev -> main). Repeat the RLS step
   and env vars on prod.
7. On prod: invite the real 7-9 emails from People > External (after Visesh
   confirms the list - section 7), then assign each their role/groups.
   UI only, no SQL and no Entra portal needed per person.
8. Add each person to the projects/tickets they should work: Tasks > project >
   Share/members, or assign tasks to their email. Until they are added to
   something, their Tasks screen is simply empty (fail-closed).

**Off-boarding, two speeds, both Nexus-side and both IMMEDIATE (Aug 18: they
also revoke every live session and outstanding code on the spot):**
- **Deactivate** blocks sign-in instantly, keeps the record, reversible with
  Reactivate.
- **Remove** is permanent: erases the person row, group memberships, role,
  and scopes - they would have to be re-invited from scratch. Tasks/comments
  they took part in are kept (the email simply no longer resolves to a
  person).
(If anyone was ever invited via the LEGACY Entra path, deleting that guest in
Entra > Users is optional tidy-up - irrelevant to the passwordless flow.)

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
    in) and are path-gated: app-shell endpoints plus the API prefixes their
    ACTUAL grants map to (`MODULE_API_PREFIXES` covers the full module
    catalog - Aug 18 rework: any module is grantable through normal
    roles/groups, and each endpoint's own grant/level gate still applies on
    top exactly as for employees); no grants = app shell only; everything
    else 403s. Cached like the role cache (60s TTL,
    `invalidate_external_cache`).
- `backend/bff_session.py` - `normalize_email` now delegates to the shared
  resolver so cookie logins (what dev/prod actually use) resolve guests
  identically.
- `backend/models.py` - `NexusEmployee` + `external_company`, `invited_by`,
  `expires_at`, `invite_status` (appended; used only on guest/external rows).
- `backend/main.py` - the four ALTER lines in BOTH migration lists (SQLite +
  Postgres) + registers the new router.
- `backend/routers/external_users.py` (new) - admin-gated lifecycle CRUD:
  GET/POST `/external-users`, PATCH `/external-users/{email}` (edit /
  deactivate / reactivate), POST `/external-users/{email}/invite` (resend),
  DELETE `/external-users/{email}` (permanent Remove: hard-deletes the person
  row + group memberships + role + scopes; guest/external rows only, never
  employees). It manages the rows and the invitation, NOT access - grants flow
  through the normal groups/job-roles machinery (Aug 18 rework). Enrolling
  ALSO sends the Entra B2B invitation via Graph `POST /v1.0/invitations`
  (reusing `graph_mail.py`'s cached app-only token - no second Graph client;
  sync endpoints run on FastAPI's threadpool so the call never blocks the
  event loop). Graph failures never block enrollment: the row is created,
  `invite_status` records sent/failed/manual, and the response carries the
  exact remedy. Rejects company-domain emails and emails already in People.
- `backend/bff_session.py` + `frontend/src/authConfig.js` - the INTERACTIVE
  sign-in (both the BFF authorize URL and the MSAL loginRedirect request)
  always carries `prompt=select_account`, so guests on a browser with a live
  work session get the account picker instead of silent SSO into the wrong
  account. Silent token acquisition is untouched.
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
- `backend/test_external_users.py` (new) - 30 tests: claim resolution,
  default-deny, active/inactive/expired gating, employee-cap, directory
  exclusion, task/ticket scoping, normal-group grant resolution, invite flow
  (Graph stubbed: success/403/conflict/unconfigured/resend), and Remove
  (row + memberships gone, employees untouchable, removed-assignee tasks still
  display). Plus the existing `test_auth_access.py` route sweep still passes.

Frontend
- `frontend/src/api.js` - the five external-users endpoints (appended).
- `frontend/src/contexts/RoleContext.jsx` - `isExternal` from `/roles/me`.
- `frontend/src/components/Sidebar.jsx` + `MobileMenu.jsx` - externals see
  ONLY granted modules in the nav (no baseline screens).
- `frontend/src/App.jsx` - `ProtectedView` enforces the same rule at render
  time and auto-navigates an external landing on a non-granted view (e.g. the
  default dashboard) to their first granted module.
- `frontend/src/bffAuth.js` + `views/LoginPage.jsx` - a 403 from `/auth/me`
  (guest not enrolled / deactivated) lands on the sign-in screen immediately
  with the server's explanation, instead of a 23s retry spinner.
- `frontend/src/views/ExternalUsersPanel.jsx` + `views/RolesAccess.jsx` -
  Aug 18 rework: NO separate tab. Externals merge into the Roles & Access
  **People** tab (External badge, "External" department, partner company in
  the company filter; the Pranshu test row and any pre-rework guest rows
  surface automatically). "Invite External User" sits next to the People
  search; the invite modal is email/name/company/expiry only - no grant
  checkboxes. The selected external's card shows an external section (invite
  pill, Resend Invite, Edit, Deactivate/Reactivate, permanent Remove with a
  confirm spelling out the difference) above the SAME job-role/tier/groups
  controls every employee gets.
- `frontend/src/views/ExternalUsersPanel.test.jsx` - render-smoke + behavior
  tests for the modal (no grant checkboxes) and the person section
  (resend / confirm-gated remove).

Passwordless flow + External tab (Aug 18 evening):
- `backend/routers/external_auth.py` (new) - the PUBLIC passwordless
  endpoints: `/external-auth/activate/{lookup,send-code,verify}`,
  `/external-auth/request-code`, `/external-auth/login-verify`; branded
  invite/code emails; hashed codes/tokens; DB-backed rate limits + lockout;
  audit rows; mints the BFF session cookie on success.
- `backend/sentdm.py` (new) - tiny sent.dm client (POST
  https://api.sent.dm/v3/messages, Bearer `NEXUS_SENTDM_KEY`, SMS channel);
  any failure degrades to the emailed code.
- `backend/models.py` + BOTH `main.py` migration lists - `external_login_codes`
  table (NEW - RLS at release!), `nexus_employees.phone_verified_at` (the
  existing `phone` column is reused for the number).
- `backend/bff_session.py` - `create_passwordless_session` (same cookie/store
  as employees, no Entra tokens, idle expiry governs) + `revoke_sessions`;
  `routers/auth_bff.py` `/auth/me` falls back to the person row for the name.
- `backend/routers/external_users.py` - invitations now go through
  `external_auth.issue_invite` (fresh single-use link per send); legacy Graph
  B2B path kept behind `NEXUS_EXTERNAL_GRAPH_INVITE=true`; phone in the
  create/update API; deactivate/remove call `revoke_credentials`.
- `backend/test_external_auth.py` (new, 19 tests) - the security requirements
  as tests (hashing, single-use, expiry, lockout, hourly caps, throttle,
  anti-enumeration, revocation, session resolution under the policy).
- `frontend/src/views/ExternalActivate.jsx` (new) + `/activate/{token}` route
  (App.jsx + main.jsx PUBLIC_PATH) - branded activation page; render-smoke in
  `ExternalActivate.test.jsx`.
- `frontend/src/views/LoginPage.jsx` - quiet **Partner Sign-In** link ->
  email -> code screens (30s resend throttle, email fallback); employees'
  MSAL flow untouched. Shared client helpers in `frontend/src/lib/externalAuth.js`.
- `frontend/src/views/HR.jsx` - **External** tab on the People module
  (admin-only, active-count badge) rendering the shared `ExternalUsersPanel`
  list (invite/status pills/Edit/Deactivate/Remove/Resend - ONE
  implementation with the Roles & Access person card); externals filtered
  OUT of the directory list, KPI cards, New joiners, and By department.

## 5. What remains / risks

- **Committed on the worktree branch, not pushed/deployed.** Merge to dev,
  then release to prod per section 3. **Release checklist: RLS on
  `external_login_codes` (dev + prod) and, optionally, `NEXUS_SENTDM_KEY`.**
- Invitation and code emails come from the Nexus sender mailbox
  (`NEXUS_FROM_EMAIL`) - tell recipients to check spam on first contact. The
  activation link and redirects use `app_url()` (NEXUS_APP_URL /
  WEBSITE_SITE_NAME), so dev invites land on dev.nexus and prod on
  nexus.greensglobal.com automatically.
- SMS delivery needs `NEXUS_SENTDM_KEY` (ask Visesh to create the sent.dm
  account/key); until set, codes go by email only - fully functional.
- Anyone who already redeemed a LEGACY Entra guest invite (e.g. Pranshu's
  test) can still use Continue with Microsoft - the allowlist check is
  identical on both paths. Partner Sign-In works for them too once they
  activate (Resend Invite sends the new-style link). New invites are
  passwordless-only unless the legacy flag is on.
- **Any module is now grantable to an external (Visesh's call, Aug 18) - so
  the admin doing the granting carries the judgment.** Tasks/Tickets stay
  participation-scoped at item level regardless of grant, but most other
  modules show org-wide data to ANY grant holder (e.g. Documents shows every
  shared-folder document via `documents._visible`, KB likewise). Grant beyond
  Tasks/Tickets only when exposing that content is intended, or wait for
  per-external scoping (`nexus_access_scopes` exists; the per-endpoint filters
  from `docs/External-Users-Phase4.md` 4c are the follow-up). This deviates
  from the July plan's "restricted external set" leaning - deliberate, per
  Visesh: "they can have access to anything ... through roles and access just
  like any normal employee."
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
- A future NEW module needs its API prefixes added to `auth.py`'s
  `MODULE_API_PREFIXES` before an external's grant on it opens anything - a
  module missing from the map stays closed to externals even when granted.
  Fail-closed on purpose.

## 6. 10-minute test script (one guest end to end, on dev)

Need: one test external mailbox you can read (a personal Gmail works); a
phone you can receive texts on if `NEXUS_SENTDM_KEY` is set.

1. As admin on dev.nexus: **People > External > Invite External User** (the
   test email, name, company "Test Co", your test phone). Expect the row with
   an **Invite Sent** pill and the External tab badge to tick up. If **Invite
   Failed**, fix the mail config the toast names, then **Resend Invite**.
   On their person card (Roles & Access > People), add them to a group
   granting Tasks/Tickets (normal Groups machinery).
2. Confirm the People directory/KPI cards did NOT change (externals are
   excluded from Total people / Active / New joiners / By department).
3. Open the invitation email, press **Accept Invitation**: the activation page
   greets them by name and shows who invited them. Press **Text Me a Code**
   (or Email Me a Code without sent.dm) - enter the 6 digits - you land
   inside Nexus with ONLY Tasks/Tickets in the sidebar, "External" on the
   profile chip. Wrong-code twice first if you want to see the error copy.
4. Reuse check: open the SAME activation link again - "This link is not
   valid" (single-use proven).
5. Returning sign-in: sign out, press **Partner Sign-In** on the login page,
   enter the email - the generic "if this account exists" message shows -
   enter the code from your phone (or "Send to My Email Instead") - you are
   back in. Try a bogus email first: identical generic message.
6. As admin: assign a test task to the guest (or add them to a test project).
   Guest refreshes: exactly that task appears; company tasks do not. Raise a
   ticket as the guest; confirm they never see other people's tickets.
7. As admin: check the bell - no change for managers; confirm the guest never
   shows up in any people picker (e.g. Items assign, HR) or the directory.
8. As admin: **Deactivate** on their row - the guest's session dies on their
   next request (revoked immediately) and Partner Sign-In stops issuing codes
   (still the generic message). **Reactivate** to continue.
9. Supabase dev: confirm `external_login_codes` has RLS enabled and
   `get_advisors` shows 0 rls_disabled.

## 7. ASK-VISESH (needed before enrolling the real people)

1. The list from Neil: **7-9 names + emails + companies** (MCD / Aarav
   Construction / OSM?) plus mobile numbers where texting codes is wanted.
   The email each person will SIGN IN with is the one to invite - confirm
   each with the person, not a guess.
2. **The sent.dm API key** (`NEXUS_SENTDM_KEY`): create the account at
   sent.dm, add the key to dev + prod App Service settings. Optional - email
   codes work without it - but texted codes are the better experience and the
   phone doubles as a second factor.
3. Which role/groups each person gets (there is no automatic default -
   a fresh invite has NO access until assigned). Suggested starting point:
   one shared group granting Tasks (Editor) + Tickets (Editor). Remember most
   other modules show org-wide data to any grant holder (section 5).
4. Expiration policy: leave blank, or stamp e.g. 6 months on each row?
5. Which projects/teams each person should be added to in Tasks (their screen
   is empty until someone adds/assigns them).
6. Is it acceptable that externals can resolve staff names via the directory
   read (section 5)? Default answer is yes (same info as email/Teams
   collaboration exposes), but it is Neil's call to make once.
7. Prod release timing for the RLS statement (section 3) - it must run right
   after the prod deploy.
