# External / non-MS365 users — Phase 4 (what shipped + how to finish it)

Built on branch `feat/external-users` (Jul 14 2026). Decisions: **Entra B2B guests** for login,
**row-level scoping required**. See the plan `~/.claude/plans/structured-kindling-pearl.md`.

## What shipped (code)

- **`identity_type` on `nexus_employees`** (`internal` | `guest` | `external`), default `internal`.
  Model + migration + HR API (create/update/serialize) + validation. HR form has an **Account type**
  picker; external/guest people show a badge on their card. So HR can now manage non-MS365 people as
  records with no login required.
- **`nexus_access_scopes` table + `auth.scoped_ids(email, module_id, db)` helper.** Row-level sandbox.
  Semantics (unit-tested):
  - returns `None` → unrestricted (normal user, no scope rows)
  - returns `set()` → **sees nothing** — an `identity_type='external'` user with no scope rows
    (fail-closed, least privilege)
  - returns `{ids}` → restricted to exactly those scope ids (applies to anyone with scope rows)
- **Scope CRUD** `/access-scopes/{email}` (admin-only) + a **“Company access” picker** on the person’s
  Access tab (shown for guest/external). Today it scopes by **company** (`module_id='company'`,
  `scope_type='entity'`, `scope_id=HrEntity.id`) — fits the MCD / Aarav Construction partner case.

## 4b — Entra B2B guests: NO code change needed

The token validator (`auth.py`) already accepts guests: it verifies against the tenant issuer +
our app’s audience, and B2B guests invited into our tenant get tokens from that same issuer/audience.
`_role_for` defaults unknown emails to `employee`, so a guest’s access comes purely from the job
role / group / scopes we assign to their email. **IT runbook:**

1. Entra admin → **External Identities → invite** the partner user as a guest (they sign in with
   their own email; keep **“Guests can invite” = No**).
2. Require **MFA** for guests (Conditional Access) — standard for external collaboration.
3. In Nexus: add an employee record for them with **Account type = Guest**, set their **work email**
   to the invited email, assign a job role/group, and (if they should be sandboxed) add **Company
   access** limits on their Access tab.
4. Off-boarding is one place: remove the Entra guest.

## 4c — enforcement: the one-liner each module owner adds

The scope table + helper are done and fail-closed. The remaining work is applying the filter inside
each **data endpoint** an external user can reach. Pattern:

```python
from auth import scoped_ids
allowed = scoped_ids(user["email"], "company", db)   # or "property-asset", etc.
if allowed is not None:
    q = q.filter(SomeModel.company.in_(allowed))       # empty set → zero rows (correct: fail-closed)
```

- **Property / Asset (Ankush)** is the planned first surface. `PropertyAsset.jsx` / `assets.py` are
  Ankush’s — he adds the two lines above to the property list/read endpoints, filtering by whatever
  the scope targets (company today; a `property` scope_type can be added later once properties expose
  stable ids). Coordinate before wiring.
- Any Visesh-owned company-aware endpoint can adopt the same call with `module_id='company'`.

Until an endpoint adopts the filter, scopes are recorded but not enforced there — so **do not give a
real external client access to a module before that module filters by `scoped_ids`.**

## Follow-ups
- New table `nexus_access_scopes` + column `identity_type` need **RLS on dev** and a **prod migration
  + RLS** at the next release (column self-migrates via the `main.py` ALTER; table via `create_all`).
- Optional later: a `property` scope_type + picker once the asset module exposes a property id list.
