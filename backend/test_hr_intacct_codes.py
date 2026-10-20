"""People > Sync Employee Codes From Intacct (Charmi, Oct 21 2026).

Matching (work email first, exact name, name + company, conflicts), the
preview, apply, HR-only access, a clear 424 with nothing changed when
Intacct or the accounting app cannot be reached, Intacct read directly when
configured else the ledger fallback, and the nightly job honoring its
per-company switch. Intacct and the accounting app are replaced by fakes -
nothing leaves the machine.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_hr_intacct_codes.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import intacct_client  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting as acct  # noqa: E402
from routers import hr_intacct_codes as codes  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HR = "hr.codes.test@greensglobal.com"          # hr:editor
VIEWER = "viewer.codes.test@greensglobal.com"  # hr:viewer
NOBODY = "plain.codes.test@greensglobal.com"   # no grant
CO_A, CO_B = "co-codes-a", "co-codes-b"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _emp(eid, first, last, email="", code="", company=CO_A, **kw):
    return models.NexusEmployee(id=eid, first_name=first, last_name=last, work_email=email, employee_code=code,
                                company=company, status="active", identity_type=kw.pop("identity_type", "internal"),
                                deleted_at=kw.pop("deleted_at", ""), **kw)


PEOPLE = [
    _emp("e-amy", "Amy", "Bolanos", "amy@greensglobal.com", "GG-001"),            # email -> E100
    _emp("e-raj", "Raj", "Patel", "raj@greensglobal.com", ""),                    # "Patel, Raj" by name -> E101
    _emp("e-sam-a", "Sam", "Lee", "sam.a@greensglobal.com", "GG-003", CO_A),       # two Sam Lees, entity picks A -> E102
    _emp("e-sam-b", "Sam", "Lee", "sam.b@greensglobal.com", "GG-004", CO_B),
    _emp("e-kim-1", "Kim", "Ng", "kim1@greensglobal.com", "GG-005", CO_A),         # two Kim Ngs, no entity -> conflict
    _emp("e-kim-2", "Kim", "Ng", "kim2@greensglobal.com", "GG-006", CO_A),
    _emp("e-same", "Ana", "Ruiz", "ana@greensglobal.com", "E105"),                # already right -> keep
    _emp("e-none", "Zed", "Nobody", "zed@greensglobal.com", "GG-007"),            # no Intacct row
    _emp("e-held", "Bo", "Holder", "bo@greensglobal.com", "E106"),                # holds E106 by hand
    _emp("e-want", "Cy", "Wants", "cy@greensglobal.com", "GG-008"),               # Intacct says E106 -> conflict
    _emp("e-two", "Di", "Double", "di@greensglobal.com", "GG-009"),               # two Intacct rows on one email
    _emp("e-bee", "Bea", "Beta", "bea@greensglobal.com", "", CO_B),               # company B, email, empty code
    _emp("e-ext", "Guest", "Person", "guest@partner.com", "", identity_type="external"),
    _emp("e-hr", "Hana", "Rivers", HR, "GG-010"),
    _emp("e-viewer", "Vic", "Viewer", VIEWER, "GG-011"),
    _emp("e-nobody", "Pat", "Plain", NOBODY, "GG-012"),
]

INTACCT = [
    {"employeeId": "E100", "name": "Bolanos, Amy", "email": "AMY@greensglobal.com", "status": "active", "location": "15000", "locationName": "Greens Escondido"},
    {"employeeId": "E101", "name": "Patel, Raj", "email": "raj.personal@gmail.com", "status": "active"},
    {"employeeId": "E102", "name": "Sam Lee", "email": "", "status": "active", "location": "15000", "locationName": "Alpha Company LLC"},
    {"employeeId": "E103", "name": "Kim Ng", "email": "", "status": "active"},
    {"employeeId": "E105", "name": "Ana Ruiz", "email": "ana@greensglobal.com", "status": "active"},
    {"employeeId": "E106", "name": "Cy Wants", "email": "cy@greensglobal.com", "status": "active"},
    {"employeeId": "E107", "name": "Di Double", "email": "di@greensglobal.com", "status": "active"},
    {"employeeId": "E108", "name": "Di Double Two", "email": "di@greensglobal.com", "status": "inactive"},
    {"employeeId": "E109", "name": "Bea Beta", "email": "bea@greensglobal.com", "status": "active"},
    {"employeeId": "E110", "name": "Only Intacct", "email": "only@greensglobal.com", "status": "active"},
]


def _data():
    return {"source": "intacct", "employees": [codes._norm_record(p) for p in INTACCT]}


class Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="Alpha Company"))
            db.add(models.HrEntity(id=CO_B, name="Beta Company"))
            db.add(models.NexusGroup(id="grp-codes-ed", name="Codes HR", allowed_modules="hr:editor"))
            db.add(models.NexusGroup(id="grp-codes-vw", name="Codes Viewers", allowed_modules="hr:viewer"))
            db.add(models.NexusGroupMember(group_id="grp-codes-ed", email=HR))
            db.add(models.NexusGroupMember(group_id="grp-codes-vw", email=VIEWER))
            for p in PEOPLE:
                db.add(models.NexusEmployee(**{c.name: getattr(p, c.name) for c in models.NexusEmployee.__table__.columns
                                               if getattr(p, c.name) is not None}))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.fetches = 0

        def fake_fetch():
            self.fetches += 1
            return _data()
        self._fetch, codes.fetch_intacct_employees = codes.fetch_intacct_employees, fake_fetch

    def tearDown(self):
        codes.fetch_intacct_employees = self._fetch
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.query(models.HrEntity).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(("grp-codes-ed", "grp-codes-vw"))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(("grp-codes-ed", "grp-codes-vw"))).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key == codes.SETTINGS_KEY).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.action == "Employee code from Intacct").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def code_of(self, eid):
        db = database.SessionLocal()
        try:
            return db.query(models.NexusEmployee).execution_options(include_deleted=True).filter(models.NexusEmployee.id == eid).first().employee_code
        finally:
            db.close()

    def preview(self):
        _as(HR)
        r = self.client.get("/hr/intacct-codes/preview")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class MatchingTests(Base):
    def test_rules(self):
        out = self.preview()
        rows = {r["employeeId"]: r for r in out["rows"]}
        self.assertNotIn("e-ext", rows)   # externals never get codes
        amy = rows["e-amy"]
        self.assertEqual((amy["action"], amy["matchBy"], amy["intacctCode"]), ("update", "email", "E100"))
        self.assertTrue(amy["replacesNexusCode"])          # GG-001 was set in Nexus
        self.assertFalse(amy["autoEligible"])              # so the nightly job leaves it for HR
        raj = rows["e-raj"]
        self.assertEqual((raj["action"], raj["matchBy"], raj["intacctCode"]), ("update", "name", "E101"))
        self.assertFalse(raj["autoEligible"])              # name only: never automatic
        self.assertEqual((rows["e-sam-a"]["matchBy"], rows["e-sam-a"]["intacctCode"]), ("name_company", "E102"))
        self.assertEqual(rows["e-sam-b"]["action"], "no_match")
        for k in ("e-kim-1", "e-kim-2"):
            self.assertEqual(rows[k]["action"], "conflict")
            self.assertIn("more than one", rows[k]["reason"])
        self.assertEqual(rows["e-same"]["action"], "keep")
        self.assertEqual(rows["e-none"]["action"], "no_match")
        self.assertEqual(rows["e-want"]["action"], "conflict")
        self.assertIn("Bo Holder", rows["e-want"]["reason"])
        self.assertEqual(rows["e-two"]["action"], "conflict")
        self.assertIn("E107", rows["e-two"]["reason"])
        bea = rows["e-bee"]
        self.assertEqual((bea["action"], bea["autoEligible"], bea["replacesNexusCode"]), ("update", True, False))
        self.assertEqual([r["employeeId"] for r in out["notInNexus"]], ["E110"])
        self.assertEqual(out["counts"]["conflict"], 4)
        self.assertEqual(out["source"], "intacct")

    def test_name_key(self):
        self.assertEqual(codes.name_key("Desai, Charmi"), "charmi desai")
        self.assertEqual(codes.name_key("  CHARMI   Desai "), "charmi desai")
        self.assertNotEqual(codes.name_key("Charmi Desa"), codes.name_key("Charmi Desai"))   # never fuzzy
        self.assertEqual(codes.org_key("Alpha Company, LLC"), "alpha company")

    def test_removed_person_still_holds_a_code(self):
        db = database.SessionLocal()
        try:
            db.add(_emp("e-gone", "Old", "Timer", "old@greensglobal.com", "E109", deleted_at="2026-09-01T00:00:00Z"))
            db.commit()
        finally:
            db.close()
        rows = {r["employeeId"]: r for r in self.preview()["rows"]}
        self.assertEqual(rows["e-bee"]["action"], "conflict")
        self.assertIn("removed from Nexus", rows["e-bee"]["reason"])


class ApplyTests(Base):
    def test_apply_writes_and_audits(self):
        _as(HR)
        r = self.client.post("/hr/intacct-codes/apply", json={"items": [
            {"employeeId": "e-amy", "code": "E100"},
            {"employeeId": "e-raj", "code": "E101"},
            {"employeeId": "e-kim-1", "code": "E103"},     # conflict: refused
            {"employeeId": "e-bee", "code": "E999"},       # not what Intacct says now
        ]})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(sorted(a["to"] for a in out["applied"]), ["E100", "E101"])
        self.assertEqual(sorted(s["employeeId"] for s in out["skipped"]), ["e-bee", "e-kim-1"])
        self.assertEqual(self.code_of("e-amy"), "E100")
        self.assertEqual(self.code_of("e-raj"), "E101")
        self.assertEqual(self.code_of("e-kim-1"), "GG-005")
        self.assertEqual(self.code_of("e-bee"), "")
        db = database.SessionLocal()
        try:
            logs = db.query(models.AuditLog).filter(models.AuditLog.action == "Employee code from Intacct").all()
            self.assertEqual(len(logs), 2)
            self.assertTrue(all(lg.user_email == HR for lg in logs))
            self.assertIn('"GG-001", "E100"', next(lg.details for lg in logs if lg.resource_id == "e-amy"))
            state = codes.load_state(db)
            self.assertEqual(state["synced"], {"e-amy": "E100", "e-raj": "E101"})
        finally:
            db.close()
        # Applied rows now read Keep.
        rows = {r["employeeId"]: r for r in self.preview()["rows"]}
        self.assertEqual(rows["e-amy"]["action"], "keep")

    def test_swap_needs_both_rows(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == "e-held").first().employee_code = "GG-020"
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == "e-bee").first().employee_code = "E106"
            db.commit()
        finally:
            db.close()
        # e-want -> E106 is held by e-bee, who moves to E109 in the same pass.
        rows = {r["employeeId"]: r for r in self.preview()["rows"]}
        self.assertEqual(rows["e-want"]["action"], "update")
        r = self.client.post("/hr/intacct-codes/apply", json={"items": [{"employeeId": "e-want", "code": "E106"}]})
        self.assertEqual(r.json()["applied"], [])
        self.assertIn("still held", r.json()["skipped"][0]["reason"])
        r = self.client.post("/hr/intacct-codes/apply", json={"items": [{"employeeId": "e-want", "code": "E106"},
                                                                        {"employeeId": "e-bee", "code": "E109"}]})
        self.assertEqual(len(r.json()["applied"]), 2)
        self.assertEqual((self.code_of("e-want"), self.code_of("e-bee")), ("E106", "E109"))

    def test_empty_pick(self):
        _as(HR)
        self.assertEqual(self.client.post("/hr/intacct-codes/apply", json={"items": []}).status_code, 400)


class AccessTests(Base):
    def test_hr_only(self):
        for who in (VIEWER, NOBODY):
            _as(who)
            self.assertEqual(self.client.get("/hr/intacct-codes/preview").status_code, 403, who)
            self.assertEqual(self.client.post("/hr/intacct-codes/apply", json={"items": [{"employeeId": "e-amy", "code": "E100"}]}).status_code, 403)
            self.assertEqual(self.client.put("/hr/intacct-codes/settings", json={"companyId": CO_A, "nightly": True}).status_code, 403)
        self.assertEqual(self.code_of("e-amy"), "GG-001")
        self.assertEqual(self.fetches, 0)

    def test_scoped_admin_sees_only_their_companies(self):
        db = database.SessionLocal()
        try:
            db.add(models.NexusAccessScope(id="scope-codes-test", email=HR, module_id="hr", scope_type="company", scope_id=CO_B))
            db.commit()
        finally:
            db.close()
        try:
            out = self.preview()
            self.assertEqual({r["company"] for r in out["rows"]}, {CO_B})
            self.assertEqual(out["notInNexus"], [])
            r = self.client.post("/hr/intacct-codes/apply", json={"items": [{"employeeId": "e-amy", "code": "E100"}]})
            self.assertEqual(r.json()["applied"], [])
            self.assertEqual(self.code_of("e-amy"), "GG-001")
            self.assertEqual(self.client.put("/hr/intacct-codes/settings", json={"companyId": CO_A, "nightly": True}).status_code, 404)
            self.assertEqual([c["id"] for c in self.client.get("/hr/intacct-codes/settings").json()["companies"]], [CO_B])
        finally:
            db = database.SessionLocal()
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.id == "scope-codes-test").delete()
            db.commit()
            db.close()


class UnreachableTests(Base):
    def test_clear_error_nothing_changed(self):
        def down():
            raise codes.IntacctUnavailable("Could not reach the accounting service (ConnectError). Nothing was changed - try again in a few minutes.")
        codes.fetch_intacct_employees = down
        _as(HR)
        r = self.client.get("/hr/intacct-codes/preview")
        self.assertEqual(r.status_code, 424)
        self.assertIn("Could not reach", r.json()["detail"])
        r = self.client.post("/hr/intacct-codes/apply", json={"items": [{"employeeId": "e-amy", "code": "E100"}]})
        self.assertEqual(r.status_code, 424)
        self.assertEqual(self.code_of("e-amy"), "GG-001")

    def _no_direct(self):
        """Intacct's own settings off, so the ledger is the source."""
        saved = {k: os.environ.pop(k, None) for k in intacct_client.REQUIRED_ENV}
        self.addCleanup(lambda: [os.environ.__setitem__(k, v) for k, v in saved.items() if v is not None])

    def test_real_fetch_errors(self):
        self._no_direct()
        fetch = self._fetch
        base, key, get = acct._ACCT_BASE, acct._ACCT_KEY, httpx.get
        try:
            acct._ACCT_BASE, acct._ACCT_KEY = "", ""
            with self.assertRaises(codes.IntacctUnavailable) as e:
                fetch()
            self.assertIn("not configured", str(e.exception))
            acct._ACCT_BASE, acct._ACCT_KEY = "https://acct.invalid", "k"

            def boom(*a, **k):
                raise httpx.ConnectError("refused")
            httpx.get = boom
            with self.assertRaises(codes.IntacctUnavailable) as e:
                fetch()
            self.assertIn("Could not reach", str(e.exception))
        finally:
            acct._ACCT_BASE, acct._ACCT_KEY, httpx.get = base, key, get

    def test_ledger_fallback_when_intacct_is_not_configured(self):
        self._no_direct()
        fetch = self._fetch
        base, key, get = acct._ACCT_BASE, acct._ACCT_KEY, httpx.get
        seen = []

        def fake_get(url, params=None, headers=None, timeout=None):
            seen.append((url, params))
            req = httpx.Request("GET", url)
            return httpx.Response(200, json={"ok": True, "kind": "employee", "values": [{"code": "E101", "name": "Patel, Raj", "lines": 4}]}, request=req)
        direct, intacct_client.fetch_employees = intacct_client.fetch_employees, lambda: self.fail("Intacct read without settings")
        try:
            acct._ACCT_BASE, acct._ACCT_KEY, httpx.get = "https://acct.invalid", "k", fake_get
            data = fetch()
        finally:
            acct._ACCT_BASE, acct._ACCT_KEY, httpx.get = base, key, get
            intacct_client.fetch_employees = direct
        self.assertEqual(data["source"], "ledger")
        # Only the ledger is asked - never the old accounting employees route.
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0][0].endswith(codes.LEDGER_PATH))
        self.assertEqual(seen[0][1], {"kind": "employee"})
        db = database.SessionLocal()
        try:
            out = codes.build_preview(db, None, data)
        finally:
            db.close()
        self.assertEqual(out["sourceLabel"], "Ledger codes, names only")
        rows = {r["employeeId"]: r for r in out["rows"]}
        self.assertEqual((rows["e-raj"]["matchBy"], rows["e-raj"]["autoEligible"]), ("name", False))

    def _direct_on(self):
        saved = {k: os.environ.get(k) for k in intacct_client.REQUIRED_ENV}
        for k in intacct_client.REQUIRED_ENV:
            os.environ[k] = f"test-{k.lower()}"

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.addCleanup(restore)

    def test_direct_intacct_first_when_configured(self):
        self._direct_on()
        fetch = self._fetch
        rows = [{"employeeId": "E100", "printAs": "Bolanos, Amy", "firstName": "Amy", "lastName": "Bolanos",
                 "email": "Amy@greensglobal.com", "status": "active", "locationId": "15000",
                 "locationName": "Greens Escondido", "whenModified": "10/01/2026 10:00:00"}]
        get = httpx.get

        def no_ledger(*a, **k):
            raise AssertionError("ledger read while Intacct is configured")
        direct, intacct_client.fetch_employees = intacct_client.fetch_employees, lambda: rows
        try:
            httpx.get = no_ledger
            data = fetch()
        finally:
            httpx.get = get
            intacct_client.fetch_employees = direct
        self.assertEqual(data["source"], "intacct")
        rec = data["employees"][0]
        self.assertEqual((rec["employeeId"], rec["name"], rec["email"], rec["location"], rec["locationName"]),
                         ("E100", "Bolanos, Amy", "amy@greensglobal.com", "15000", "Greens Escondido"))
        db = database.SessionLocal()
        try:
            out = codes.build_preview(db, None, data)
        finally:
            db.close()
        self.assertEqual(out["sourceLabel"], "Intacct (direct)")
        amy = next(r for r in out["rows"] if r["employeeId"] == "e-amy")
        self.assertEqual((amy["action"], amy["matchBy"], amy["intacctCode"]), ("update", "email", "E100"))

    def test_direct_intacct_error_is_a_clear_424(self):
        self._direct_on()
        codes.fetch_intacct_employees = self._fetch

        def bad():
            raise intacct_client.IntacctError("Intacct sign-in failed: Invalid Web Services Authorization.")
        direct, intacct_client.fetch_employees = intacct_client.fetch_employees, bad
        try:
            _as(HR)
            r = self.client.get("/hr/intacct-codes/preview")
        finally:
            intacct_client.fetch_employees = direct
        self.assertEqual(r.status_code, 424)
        self.assertIn("Intacct sign-in failed", r.json()["detail"])
        self.assertIn("Nothing was changed", r.json()["detail"])


class NightlyTests(Base):
    def _run(self, fetch=None):
        db = database.SessionLocal()
        try:
            return codes.run_nightly(db, day="2026-10-21", fetch=fetch or _data)
        finally:
            db.close()

    def test_off_by_default(self):
        self.assertEqual(self._run(), {"skipped": "off"})
        self.assertEqual(self.code_of("e-bee"), "")
        _as(HR)
        comps = self.client.get("/hr/intacct-codes/settings").json()["companies"]
        self.assertTrue(comps and not any(c["nightly"] for c in comps))

    def test_on_applies_only_confident_rows_of_that_company(self):
        _as(HR)
        self.assertEqual(self.client.put("/hr/intacct-codes/settings", json={"companyId": CO_B, "nightly": True}).status_code, 200)
        out = self._run()
        self.assertEqual(out["applied"], 1)
        self.assertEqual(self.code_of("e-bee"), "E109")       # company B, email, empty code
        self.assertEqual(self.code_of("e-amy"), "GG-001")     # company A is off
        # Company A on: Amy's GG-001 was set in Nexus, Raj is a name match - both wait for HR.
        self.client.put("/hr/intacct-codes/settings", json={"companyId": CO_A, "nightly": True})
        out = self._run()
        self.assertEqual(out["applied"], 0)
        self.assertGreaterEqual(out["review"], 2)
        self.assertEqual(self.code_of("e-amy"), "GG-001")
        self.assertEqual(self.code_of("e-raj"), "")
        # Once HR applied Amy, a later change in Intacct flows through at night.
        self.client.post("/hr/intacct-codes/apply", json={"items": [{"employeeId": "e-amy", "code": "E100"}]})
        INTACCT[0]["employeeId"] = "E100A"
        try:
            self.assertEqual(self._run()["applied"], 1)
            self.assertEqual(self.code_of("e-amy"), "E100A")
            # A code typed by hand afterwards is never replaced at night.
            db = database.SessionLocal()
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == "e-amy").first().employee_code = "HAND-1"
            db.commit()
            db.close()
            self._run()
            self.assertEqual(self.code_of("e-amy"), "HAND-1")
        finally:
            INTACCT[0]["employeeId"] = "E100"

    def test_unreachable_changes_nothing(self):
        _as(HR)
        self.client.put("/hr/intacct-codes/settings", json={"companyId": CO_B, "nightly": True})

        def down():
            raise codes.IntacctUnavailable("Could not reach the accounting service")
        out = self._run(fetch=down)
        self.assertFalse(out["ok"])
        self.assertIn("Could not reach", out["error"])
        self.assertEqual(self.code_of("e-bee"), "")
        self.assertFalse(self.client.get("/hr/intacct-codes/settings").json()["lastRun"]["ok"])

    def test_tick_runs_once_a_day_after_the_hour(self):
        _as(HR)
        self.client.put("/hr/intacct-codes/settings", json={"companyId": CO_B, "nightly": True})
        early = datetime(2026, 10, 21, codes.NIGHTLY_HOUR_UTC - 1, tzinfo=timezone.utc)
        late = datetime(2026, 10, 21, codes.NIGHTLY_HOUR_UTC + 1, tzinfo=timezone.utc)
        self.assertIsNone(codes.nightly_tick(early, fetch=_data))
        self.assertEqual(codes.nightly_tick(late, fetch=_data)["applied"], 1)
        self.assertIsNone(codes.nightly_tick(late, fetch=_data))
        self.assertEqual(self.code_of("e-bee"), "E109")


if __name__ == "__main__":
    unittest.main()
