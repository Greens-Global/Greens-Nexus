"""The permission matrix (11/12/2026): for every grantable module, every grant
level (none / viewer / editor / full) and every tier (employee 1, supervisor
2, manager 3, administrator 4, Super Administrator 5), who may call what -
through the real API, one person per (module, tier, grant).

Rules under test (Pranshu, 11/12/2026):
  - Viewer < Editor < Full; a stored `owner` reads as `full`.
  - Tier checks are unchanged: a Full grant never passes a Manager /
    Administrator / Super Administrator tier check.
  - Administrators open every module without a grant (inside their company
    wall; the walls are off here) except Personal Financial Statements and
    Compensation (Super Administrator only) and deleting people / the
    Workflows organization face (Super Administrator by tier).

"allowed" = the gate passed = any status except 401 / 403 (a 404 / 422 /
400 / 5xx after the gate counts: the request reached the handler). Writes
that only test a dependency-level gate send `{}` - FastAPI runs every
dependency before it validates the body, so a 422 proves the gate passed and
nothing is written. Routes whose gate sits inside the handler get a valid
body and seeded rows, reset before every call (`prep`).

Each run prints the matrix and writes backend/access_matrix_report.md
(untracked). The Owner-level migration (`retire_owner_level_once`) is pinned
by test_roles_tiers.test_owner_grant_level_retired_once - not repeated here.

    python -m pytest test_access_matrix.py -s
"""
import os
import time
import unittest
from unittest import mock

import levels_testkit as kit

kit.bind_db()
os.environ["NEXUS_QA_MODULE"] = "true"        # routers/qa.py reads it at import
os.environ["NEXUS_PFS_FILE_LOCK"] = "off"     # pfs_access.file_gate's code lock

from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import database  # noqa: E402
import egnyte_oauth  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import marketing_ads, unifi  # noqa: E402
from services import egnyte as egnyte_svc  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
TIERS = {1: "employee", 2: "supervisor", 3: "manager", 4: "administrator", 5: "owner"}
TIER_WORDS = {1: "Employee", 2: "Supervisor", 3: "Manager", 4: "Administrator", 5: "Super Admin"}
GRANTS = {0: "none", 1: "viewer", 2: "editor", 3: "full"}
CRED_OWNER, PIN_OWNER = "mx.credowner" + D, "mx.pinowner" + D
WEEK = {"start": "2026-11-09", "end": "2026-11-15"}


def route(method, path, grant, tier, body=None, allow=None, prep=None, note=""):
    """One probe. `grant` = the lowest grant level that opens it (0 = every
    signed-in person, None = no grant does), `tier` = the lowest tier that
    opens it with no grant (None = no tier). `allow(tier, grant)` overrides
    the plain rule for the few routes where the two axes combine."""
    return dict(method=method, path=path, body=body, grant=grant, tier=tier, allow=allow, prep=prep, note=note)


def _tasks_create(t, g):           # router gate needs a Tasks grant (or admin); creating needs Editor or Manager
    return t >= 4 or (g >= 1 and (t >= 3 or g >= 2))


def _tasks_manage(t, g):           # grant (or admin) to enter + Manager tier; Full is lifted to Manager inside Tasks
    return t >= 4 or (g >= 1 and t >= 3) or g >= 3


def _ir_view(t, g):                # require_ir_view keeps the Supervisor floor under the grant (portal investors)
    return t >= 4 or (t >= 2 and g >= 1)


def _consolidated(t, g):           # require_unlimited: an Administrator is fail-closed on consolidated figures (Neil, 11/02/2026)
    return t >= 5 or (g >= 3 and t < 4)


def _hr_not_manager(min_grant, bypass):
    # team_people_gate (Neil, Oct 22 "Manager calls HR"): the Manager tier is held to its team's
    # read-only /hr allowlist whatever People / Compensation grant it holds.
    return lambda t, g: t >= bypass or (g >= min_grant and t != 3)


def _reset_cred(db):
    c = db.get(models.VaultCredential, "c1")
    c.deleted_at, c.owner_email = "", CRED_OWNER


def _reset_pin(db):
    n = db.get(models.DevNote, "pin-theirs")
    n.status, n.purge_at = "open", ""


def _reset_pfs(db):
    if db.get(models.PfsProfile, "pfs1") is None:
        db.add(models.PfsProfile(id="pfs1", name="Guarantor"))


CRED = {"name": "New", "dept": "IT", "secret": "Sup3r-secret-pw!"}
PIN = {"kind": "bug", "priority": "normal", "comment": "The button is off", "route": "tasks"}

# module id -> [routes]. The paths were read from the routers on 11/12/2026.
MATRIX = {
    "accounting": [
        route("GET", "/accounting/saved-reports", 1, 4),
        route("POST", "/accounting/import-hub/rules", 2, 4, {}),
        route("POST", "/accounting/allocations/runs", 3, 5, {}, allow=_consolidated,
              note="consolidated: Full below Administrator, or Super; an Administrator is fail-closed (require_unlimited)"),
    ],
    "hr": [
        route("GET", "/hr/employees", 1, 4),
        route("POST", "/hr/employees", 2, 4, {}, allow=_hr_not_manager(2, 4), note="Manager tier team-limited, grant or not"),
        route("POST", "/leave-balances/recalculate", 3, 4, note="is_hr path (_hr_global)"),
        route("DELETE", "/hr/employees/e-nobody", None, 5, note="require_owner: Super Administrator by tier"),
    ],
    "hr_comp": [
        route("GET", "/hr/employees/e-nobody/workers-comp", 1, 5, allow=_hr_not_manager(1, 5),
              note="bypass_level=owner: Administrator refused; Manager tier team-limited"),
        route("POST", "/hr/employees/e-nobody/workers-comp", 2, 5, {}, allow=_hr_not_manager(2, 5), note="Manager tier team-limited"),
    ],
    "tasks": [
        route("GET", "/tasks", 1, 4),
        route("POST", "/tasks", 2, 4, {"title": "Fix the gate"}, allow=_tasks_create, note="Manager with any Tasks grant also creates"),
        route("GET", "/tasks/activity", 3, 4, allow=_tasks_manage, note="Manager with any Tasks grant also"),
        route("POST", "/tasks/meta/custom-statuses", 3, 4, {}, allow=_tasks_manage, note="Manager with any Tasks grant also"),
    ],
    "credvault": [
        route("GET", "/credvault/credentials", 1, 4),
        route("POST", "/credvault/credentials", 2, 4, CRED),
        route("DELETE", "/credvault/credentials/c1", 3, 4, prep=_reset_cred, note="someone else's credential (_can_modify)"),
        route("GET", "/credvault/logs", 1, 4, note="the activity log lists for every grant holder; filtered, not refused"),
    ],
    "testing": [
        route("GET", "/qa/runs", 1, 4),
        route("POST", "/qa/cases", 2, 4, {}),
        route("DELETE", "/qa/runs/run-nobody", 3, 4),
    ],
    "egnyte": [
        route("GET", "/egnyte/folder?path=/Shared", 1, 2, note="supervisor+ or an egnyte / hr grant (_is_privileged)"),
        route("POST", "/egnyte/fs/move", 2, 2, {"path": "/Shared/A/x.pdf", "destination": "/Shared/B/x.pdf"}),
        route("POST", "/egnyte/fs/delete", 3, 2, {"path": "/Shared/A/x.pdf"}, note="require_deleter = level 2 or Full"),
        route("GET", "/egnyte/wiring", None, 3),
    ],
    "build-mode": [
        route("GET", "/dev-notes", 1, 5, note="dev_notes._allowed: a grant or is_global_admin - an Administrator is refused"),
        route("POST", "/dev-notes", 2, 5, PIN),
        route("PATCH", "/dev-notes/pin-theirs", 3, 5, {"status": "dismissed"}, prep=_reset_pin, note="someone else's pin"),
        route("POST", "/dev-notes/purge", None, 5),
    ],
    "employee-tracking": [
        route("GET", "/timeclock/locations", 1, 4),
        route("GET", "/timeclock/monitoring/companies", 3, 4, note="the monitoring policy"),
    ],
    "documents": [
        route("GET", "/documents/library", 0, 1, note="every signed-in person; the rows are filtered"),
        route("POST", "/esign/templates", 2, 4, {}, note="also an hr:editor (not seeded here)"),
        route("POST", "/esign/requests/r-nobody/void", 3, 4, note="also an hr:editor"),
        route("GET", "/esign/requests", None, 4, note="People only - a documents Full is refused"),
    ],
    "workflows": [
        route("GET", "/workflows", 1, 4),
        route("POST", "/workflows", 2, 4, {}),
        route("POST", "/workflows/w-nobody/reown", 3, 4, {}),
        route("POST", "/workflows/settings/pause-all", None, 5, {}, note="GA = require_owner"),
    ],
    "pfs": [
        route("GET", "/pfs/profiles", 1, 5, note="bypass_level=owner: Administrator refused"),
        route("DELETE", "/pfs/profiles/pfs1", 3, 5, prep=_reset_pfs),
    ],
    "investor-relations": [
        route("GET", "/investor-relations/funds", 1, 4, allow=_ir_view, note="Supervisor floor under the grant"),
        route("POST", "/investor-relations/funds", 2, 3, {}),
        route("DELETE", "/investor-relations/funds/f-nobody", 3, 4),
    ],
    "marketing": [
        route("GET", "/marketing/ads/status", 1, 4),
        route("PUT", "/marketing/ads/budgets", 2, 4, {}),
        route("PUT", "/marketing/ads/campaigns/facilities", 3, 4, {}),
        route("POST", "/marketing/ads/oauth/start", None, 4),
    ],
    "external-links": [
        route("GET", "/external-links", 0, 1, note="every signed-in person"),
        route("POST", "/external-links", 2, 3, {}),
        route("DELETE", "/external-links/1", 3, 4),
    ],
    "operations": [
        route("GET", "/facility-ops/settings", 1, 2),
        route("PUT", "/facility-ops/rates/draft", 2, 3, {}),
        route("PUT", "/facility-ops/settings", 3, 4, {}),
        route("POST", "/ops-budget/upload", 3, 4, {}),
    ],
    "workforce-scorecard": [
        route("GET", "/workforce-scorecard/report", 1, 4),
        route("GET", "/workforce-scorecard/config", None, 4),
    ],
    "sop": [
        route("GET", "/kb/pages", 0, 1, note="every signed-in person"),
        route("POST", "/kb/pages", 2, 3, {}),
        route("POST", "/kb/collections", 3, 3, {}),
    ],
    "bi": [
        route("GET", "/dashboards/insights", 1, 2),
    ],
    "shifts": [
        route("GET", f"/timeclock/schedule?start={WEEK['start']}&end={WEEK['end']}", 1, 3),
        route("POST", "/timeclock/schedule", 2, 3, {}),
        route("POST", "/timeclock/schedule/clear", 3, 3, {"start_date": WEEK["start"], "end_date": WEEK["end"]}),
        route("POST", "/timeclock/schedule/import", 3, 3, {"rows": []}),
        route("POST", "/timeclock/shift-requests/sr-nobody/decide", 3, 3, {"approve": True}, note="Full acts as a manager inside Shifts"),
    ],
    "inventory": [
        route("GET", "/items", 0, 1, note="every signed-in person"),
        route("POST", "/items", 2, 3, {}),
        route("DELETE", "/items/i-nobody", 3, 5),
    ],
    "property-asset": [
        route("GET", "/property-assets/workspace", 1, 4),
        route("POST", "/property-assets/changes", 2, 4, {}),
    ],
    "it": [
        route("GET", "/unifi/overview", 1, 4),
    ],
}


def expected(r, tier, grant) -> bool:
    if r["allow"]:
        return r["allow"](tier, grant)
    by_tier = r["tier"] is not None and tier >= r["tier"]
    by_grant = r["grant"] is not None and grant >= r["grant"]
    return by_tier or by_grant


def person_email(module, tier, grant) -> str:
    return f"mx.{module}.t{tier}.{GRANTS[grant]}{D}" if grant else f"mx.none.t{tier}{D}"


class AccessMatrixTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app, raise_server_exceptions=False)
        db = database.SessionLocal()
        try:
            kit.reset(db)
            for tier in TIERS:
                kit.person(db, person_email("", tier, 0), role=TIERS[tier] if tier > 1 else "")
            for module in MATRIX:
                for grant in (1, 2, 3):
                    emails = [person_email(module, t, grant) for t in TIERS]
                    for tier, em in zip(TIERS, emails):
                        kit.person(db, em, role=TIERS[tier] if tier > 1 else "")
                    gid = f"g-{module}-{GRANTS[grant]}"
                    db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=f"{module}:{GRANTS[grant]}"))
                    for em in emails:
                        db.add(models.NexusGroupMember(group_id=gid, email=em))
            kit.person(db, CRED_OWNER)
            kit.person(db, PIN_OWNER)
            db.add(models.VaultCredential(id="c1", name="Bank", dept="IT", owner_email=CRED_OWNER, created_by=CRED_OWNER))
            db.add(models.DevNote(id="pin-theirs", created_by=PIN_OWNER, status="open", comment="Off by one", kind="bug"))
            db.add(models.PfsProfile(id="pfs1", name="Guarantor"))
            db.commit()
        finally:
            db.close()
        kit.refresh()

        async def _no_unifi():
            return [], [], []
        for p in (
            mock.patch.object(egnyte_svc, "configured", lambda: True),
            mock.patch.object(egnyte_oauth, "oauth_configured", lambda: False),
            mock.patch.object(egnyte_svc, "list_folder", lambda *a, **k: {"files": [], "folders": []}),
            mock.patch.object(egnyte_svc, "move_item", lambda *a, **k: {"ok": True}),
            mock.patch.object(egnyte_svc, "delete_item", lambda *a, **k: {"ok": True}),
            mock.patch.object(marketing_ads.google_ads, "status", lambda db: {"connected": False}),
            mock.patch.object(unifi, "fetch_all", _no_unifi),
        ):
            p.start()
            cls.addClassCleanup(p.stop)

    def _call(self, r, email):
        if r["prep"]:
            db = database.SessionLocal()
            try:
                r["prep"](db)
                db.commit()
            finally:
                db.close()
        kit.as_(email)
        kw = {"json": r["body"]} if r["body"] is not None else {}
        return self.client.request(r["method"], r["path"], **kw).status_code

    def test_matrix(self):
        started = time.time()
        failures, cells, calls = [], {}, 0
        for module, routes in MATRIX.items():
            for r in routes:
                for tier in TIERS:
                    got = {}
                    for grant in GRANTS:
                        code = self._call(r, person_email(module, tier, grant))
                        calls += 1
                        allowed = code not in (401, 403)
                        got[grant] = allowed
                        if allowed != expected(r, tier, grant):
                            failures.append(f"{module} {r['method']} {r['path']} tier={TIERS[tier]} grant={GRANTS[grant]}: "
                                            f"got {code} ({'allowed' if allowed else 'refused'}), expected "
                                            f"{'allowed' if expected(r, tier, grant) else 'refused'}")
                    cells[(module, r["method"], r["path"], tier)] = got
        report = self._report(cells, failures, calls, time.time() - started)
        print("\n" + report)
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "access_matrix_report.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(report)
        self.assertEqual(failures, [], "\n" + "\n".join(failures))

    @staticmethod
    def _cell(got: dict) -> str:
        if got[0]:
            return "tier"
        for grant in (1, 2, 3):
            if got[grant]:
                return GRANTS[grant]
        return "never"

    def _report(self, cells, failures, calls, seconds) -> str:
        lines = ["# Access matrix - who opens what", "",
                 "Cell = the lowest grant level that opened the route for that tier; `tier` = open with no grant; "
                 "`never` = no grant opens it. Allowed = any status but 401 / 403. "
                 f"{calls} requests, {seconds:.1f}s, {len(failures)} mismatches.", ""]
        for module, routes in MATRIX.items():
            lines += [f"## {module}", "", "| Route | " + " | ".join(TIER_WORDS[t] for t in TIERS) + " |",
                      "|---|" + "---|" * len(TIERS)]
            for r in routes:
                row = [self._cell(cells[(module, r["method"], r["path"], t)]) for t in TIERS]
                label = f"{r['method']} {r['path']}" + (f" ({r['note']})" if r["note"] else "")
                lines.append(f"| {label} | " + " | ".join(row) + " |")
            lines.append("")
        if failures:
            lines += ["## Mismatches", ""] + [f"- {f}" for f in failures] + [""]
        return "\n".join(lines)

    def test_owner_grant_level_reads_as_full(self):
        """`tasks:owner` on a group behaves exactly as `tasks:full`: the rank is
        Full's and the Tasks router lifts the holder to Manager (Manage opens)."""
        em = "mx.legacy.owner" + D
        db = database.SessionLocal()
        try:
            kit.person(db, em)
            kit.grant(db, em, "tasks:owner")
            db.commit()
            kit.refresh()
            self.assertEqual(auth._module_level(em, "tasks", db), auth._MODULE_LEVEL_RANK["full"])
        finally:
            db.close()
        kit.as_(em)
        self.assertEqual(self.client.get("/tasks/activity").status_code, 200)
        self.assertEqual(self.client.post("/tasks", json={"title": "Legacy owner creates"}).status_code, 201)


if __name__ == "__main__":
    unittest.main()
