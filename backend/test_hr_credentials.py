"""Licenses & Certifications and Work Limits (Neil, 11/11/2026, Deputy parity).

HR sets up the types and adds a person's records (only the last four of a
number are kept; a type's length fills the expiry); a manager reads their
own team's and changes nothing; a company-limited HR person never reaches
another company's people; a shift type that needs a license warns in the
planner when the person placed holds none valid on the day; an expired one
shows on the Records Audit; removing one keeps the row. Work Limits HR sets
for one person tighten the shift rules, salaried people included.

    python -m pytest test_hr_credentials.py
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_credentials  # noqa: E402
import hr_record_audit  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import shift_rules  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
HR = "hana.hr" + D
SCOPED = "sam.scoped" + D     # Full People grant limited to company B
MGR = "max.mgr" + D           # manager tier: own team only
EMP = "erin.emp" + D          # reports to Max, company A
OTHER = "omar.other" + D      # company B
CO_A, CO_B = "co-a", "co-b"


def _iso(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


class CredentialTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusAccessScope,
                  models.NexusRole, models.HrEntity, models.HrCredentialType, models.HrCredential,
                  models.HrDocument, models.Shift, models.AuditLog):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO_A, name="Company A"))
        db.add(models.HrEntity(id=CO_B, name="Company B"))
        people = ((HR, "", CO_A), (SCOPED, "", CO_B), (MGR, "", CO_A), (EMP, MGR, CO_A), (OTHER, "", CO_B))
        for i, (em, mgr, co) in enumerate(people):
            db.add(models.NexusEmployee(id=f"e{i}", first_name=em.split(".")[0].title(), last_name="T",
                                        work_email=em, manager_email=mgr, company=co, status="active",
                                        deleted_at=""))
        db.add(models.NexusRole(email=MGR, role="manager", display_name="Max"))
        db.add(models.NexusGroup(id="g-hr", name="People HR", allowed_modules="hr:full"))
        for em in (HR, SCOPED, MGR):
            db.add(models.NexusGroupMember(group_id="g-hr", email=em))
        db.add(models.NexusAccessScope(id="s1", email=SCOPED, module_id="hr", scope_type="entity", scope_id=CO_B))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.ids = {em: f"e{i}" for i, (em, _m, _c) in enumerate(people)}

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client

    def _type(self, name="Forklift Certification", **kw):
        r = self._as(HR).post("/hr/credential-types", json={"name": name, **kw})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _add(self, eid, type_id, who=HR, **kw):
        return self._as(who).post(f"/hr/employees/{eid}/credentials", json={"typeId": type_id, **kw})

    # ── records ────────────────────────────────────────────────────────────
    def test_a_type_length_fills_the_expiry_and_only_the_last_four_are_kept(self):
        t = self._type(validityMonths=36)
        r = self._add(self.ids[EMP], t["id"], issuedOn="2026-01-31", number="D 123-4567 89", issuer="DMV")
        self.assertEqual(r.status_code, 201, r.text)
        rec = r.json()["credentials"][0]
        self.assertEqual(rec["expiresOn"], "2029-01-31")
        self.assertEqual(rec["numberLast4"], "6789")
        db = database.SessionLocal()
        try:
            row = db.query(models.HrCredential).one()
            self.assertEqual(row.number_last4, "6789")
            self.assertNotIn("1234567", str({c.name: getattr(row, c.name) for c in row.__table__.columns}))
        finally:
            db.close()

    def test_a_type_that_expires_needs_a_date_and_one_that_does_not_never_has_one(self):
        t = self._type()
        self.assertEqual(self._add(self.ids[EMP], t["id"]).status_code, 400)
        never = self._type("Notary Commission Training", expires=False)
        r = self._add(self.ids[EMP], never["id"], expiresOn="2030-01-01")
        self.assertEqual(r.status_code, 201, r.text)
        rec = next(c for c in r.json()["credentials"] if c["typeId"] == never["id"])
        self.assertEqual((rec["expiresOn"], rec["state"]), ("", "no_expiry"))

    def test_the_state_words(self):
        self.assertEqual(hr_credentials.state(_iso(-1)), "expired")
        self.assertEqual(hr_credentials.state(_iso(10)), "expiring")
        self.assertEqual(hr_credentials.state(_iso(200)), "valid")
        self.assertEqual(hr_credentials.state(""), "no_expiry")

    def test_a_manager_reads_their_team_and_changes_nothing(self):
        t = self._type()
        self.assertEqual(self._add(self.ids[EMP], t["id"], expiresOn=_iso(90)).status_code, 201)
        r = self._as(MGR).get(f"/hr/employees/{self.ids[EMP]}/credentials")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["canEdit"])
        self.assertEqual(len(r.json()["credentials"]), 1)
        self.assertEqual(self._add(self.ids[EMP], t["id"], who=MGR, expiresOn=_iso(90)).status_code, 403)
        self.assertEqual(self._as(MGR).get(f"/hr/employees/{self.ids[OTHER]}/credentials").status_code, 404)
        self.assertEqual(self._as(MGR).get("/hr/credentials").status_code, 403)

    def test_company_limited_hr_never_reaches_another_company(self):
        t = self._type()
        self.assertEqual(self._as(SCOPED).get(f"/hr/employees/{self.ids[EMP]}/credentials").status_code, 404)
        self.assertEqual(self._add(self.ids[EMP], t["id"], who=SCOPED, expiresOn=_iso(90)).status_code, 404)
        # Every-company types need company-wide access.
        r = self._as(SCOPED).post("/hr/credential-types", json={"name": "OSHA 10"})
        self.assertEqual(r.status_code, 403)
        r = self._as(SCOPED).post("/hr/credential-types", json={"name": "OSHA 10", "companyId": CO_B})
        self.assertEqual(r.status_code, 201, r.text)
        # A company's own type is not offered for another company's people.
        self.assertEqual(self._add(self.ids[EMP], r.json()["id"], expiresOn=_iso(90)).status_code, 400)

    def test_removing_keeps_the_row(self):
        t = self._type()
        rec = self._add(self.ids[EMP], t["id"], expiresOn=_iso(90)).json()["credentials"][0]
        r = self._as(HR).delete(f"/hr/credentials/{rec['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["credentials"], [])
        db = database.SessionLocal()
        try:
            row = db.query(models.HrCredential).one()
            self.assertTrue(row.removed_at)
            self.assertEqual(row.removed_by, HR)
        finally:
            db.close()

    def test_proof_must_be_this_persons_document(self):
        t = self._type()
        db = database.SessionLocal()
        db.add(models.HrDocument(id="d-other", employee_id=self.ids[OTHER], kind="certificate",
                                 file_name="x.pdf", storage_path="x"))
        db.add(models.HrDocument(id="d-mine", employee_id=self.ids[EMP], kind="certificate",
                                 file_name="card.pdf", storage_path="y"))
        db.commit()
        db.close()
        self.assertEqual(self._add(self.ids[EMP], t["id"], expiresOn=_iso(90), documentId="d-other").status_code, 400)
        r = self._add(self.ids[EMP], t["id"], expiresOn=_iso(90), documentId="d-mine")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["credentials"][0]["documentName"], "card.pdf")

    def test_my_hr_shows_my_own_without_the_proof_or_note(self):
        t = self._type()
        self._add(self.ids[EMP], t["id"], expiresOn=_iso(90), note="Checked by Hana")
        r = self._as(EMP).get("/myhr/credentials")
        self.assertEqual(r.status_code, 200, r.text)
        rec = r.json()["credentials"][0]
        self.assertEqual(rec["name"], "Forklift Certification")
        self.assertNotIn("note", rec)
        self.assertNotIn("documentId", rec)

    def test_the_report_lists_everyone_in_reach_by_state(self):
        t = self._type()
        self._add(self.ids[EMP], t["id"], expiresOn=_iso(-3))
        self._add(self.ids[MGR], t["id"], expiresOn=_iso(400))
        r = self._as(HR).get("/hr/credentials?state=expired")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["workEmail"] for x in r.json()["credentials"]], [EMP])

    # ── the planner and the audit ─────────────────────────────────────────
    def _shift_type(self, required):
        db = database.SessionLocal()
        db.add(models.Shift(id="st-fork", name="Forklift", required_credentials=hr_credentials.clean_required(db, required)))
        db.commit()
        db.close()

    def _warn(self, day):
        db = database.SessionLocal()
        try:
            return hr_credentials.shift_warnings(db, [{"id": "s1", "email": EMP, "date": day, "shiftId": "st-fork"}]).get("s1", [])
        finally:
            db.close()

    def test_a_shift_that_needs_a_license_warns_until_one_is_on_file(self):
        t = self._type()
        self._shift_type([t["id"]])
        self.assertEqual(self._warn(_iso(5)), ["Needs Forklift Certification - none on file."])
        self._add(self.ids[EMP], t["id"], issuedOn=_iso(-300), expiresOn=_iso(3))
        self.assertEqual(self._warn(_iso(1)), [])
        self.assertTrue(self._warn(_iso(5))[0].startswith("Forklift Certification expires "))
        self.assertTrue(self._warn(_iso(5))[0].endswith(", before this shift."))
        # Open shifts and types that need nothing never warn.
        db = database.SessionLocal()
        try:
            self.assertEqual(hr_credentials.shift_warnings(db, [{"id": "o", "email": "", "date": _iso(5), "shiftId": "st-fork"}]), {})
        finally:
            db.close()

    def test_the_check_dialog_says_it(self):
        t = self._type()
        self._shift_type([t["id"]])
        r = self._as(MGR).get("/timeclock/schedule/check", params={
            "email": EMP, "date": _iso(5), "start": "09:00", "end": "17:00", "shift_id": "st-fork"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Needs Forklift Certification - none on file.", r.json()["warnings"])
        self.assertIn("Needs Forklift Certification - none on file.", r.json()["ruleWarnings"])

    def test_share_asks_a_reason_for_a_missing_license(self):
        t = self._type()
        self._shift_type([t["id"]])
        db = database.SessionLocal()
        db.add(models.ScheduledShift(id="draft-1", employee_email=EMP, work_date=_iso(5), shift_id="st-fork",
                                     start_hhmm="09:00", end_hhmm="17:00", published=0, created_by=MGR))
        db.commit()
        db.close()
        r = self._as(MGR).get("/timeclock/schedule/publish/review", params={"start": _iso(0), "end": _iso(10)})
        self.assertEqual(r.status_code, 200, r.text)
        w = [x for x in r.json().get("warnings", []) if x["text"] == "Needs Forklift Certification - none on file."]
        self.assertEqual(len(w), 1, r.json())
        self.assertEqual((w[0]["kind"], w[0]["soft"]), ("rule", False))

    def test_an_archived_type_cannot_be_newly_required(self):
        t = self._type()
        self.assertEqual(self._as(HR).patch(f"/hr/credential-types/{t['id']}", json={"archived": True}).status_code, 200)
        db = database.SessionLocal()
        try:
            with self.assertRaises(hr_credentials.CredentialError):
                hr_credentials.clean_required(db, [t["id"]])
        finally:
            db.close()

    def test_an_expired_license_is_on_the_records_audit(self):
        t = self._type()
        self._add(self.ids[EMP], t["id"], expiresOn=_iso(-2))
        db = database.SessionLocal()
        try:
            emp = db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
            self.assertTrue(any(g.startswith("Forklift Certification expired ") for g in hr_record_audit.gaps(db, emp)))
        finally:
            db.close()
        # A renewal on file clears it.
        self._add(self.ids[EMP], t["id"], expiresOn=_iso(300))
        db = database.SessionLocal()
        try:
            emp = db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
            self.assertFalse(any("Forklift" in g for g in hr_record_audit.gaps(db, emp)))
        finally:
            db.close()

    # ── Work Limits ────────────────────────────────────────────────────────
    def test_work_limits_save_and_read(self):
        eid = self.ids[EMP]
        r = self._as(HR).put(f"/hr/employees/{eid}/work-limits", json={"limits": {"maxHoursWeek": 20, "maxShiftsWeek": 0}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["limits"]["maxHoursWeek"], 20)
        self.assertEqual(self._as(HR).put(f"/hr/employees/{eid}/work-limits", json={"limits": {"maxHoursDay": 30}}).status_code, 400)
        self.assertEqual(self._as(MGR).get(f"/hr/employees/{eid}/work-limits").json()["limits"]["maxHoursWeek"], 20)
        self.assertEqual(self._as(MGR).put(f"/hr/employees/{eid}/work-limits", json={"limits": {}}).status_code, 403)

    def test_hr_sets_availability_through_the_same_save(self):
        eid = self.ids[EMP]
        r = self._as(HR).put(f"/hr/employees/{eid}/availability",
                             json={"days": [{"weekday": 0, "kind": "unavailable", "note": "School"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(d["weekday"], d["kind"]) for d in r.json()["days"]], [(0, "unavailable")])
        mine = self._as(EMP).get("/timeclock/availability/mine").json()
        self.assertEqual([(d["weekday"], d["note"]) for d in mine["days"]], [(0, "School")])
        self.assertEqual(self._as(MGR).get(f"/hr/employees/{eid}/availability").status_code, 200)
        self.assertEqual(self._as(MGR).put(f"/hr/employees/{eid}/availability", json={"days": []}).status_code, 403)


class WorkLimitRuleTests(unittest.TestCase):
    MON = date(2026, 11, 2)

    def _s(self, i, d, start="08:00", end="18:00", paid=600):
        return {"id": f"s{i}", "date": d.isoformat(), "start": start, "end": end, "paidMin": paid}

    def test_hours_a_day(self):
        out = shift_rules.evaluate([self._s(1, self.MON)], {}, "none", limits={"maxHoursDay": 8})
        self.assertEqual(out, {"s1": ["10h 00m scheduled this day (their limit is 8h)."]})

    def test_shifts_a_week_warns_from_the_one_past_the_limit(self):
        shifts = [self._s(i, self.MON + timedelta(days=i), paid=240) for i in range(4)]
        out = shift_rules.evaluate(shifts, {}, "none", limits={"maxShiftsWeek": 3})
        self.assertEqual(out, {"s3": ["4 shifts this week (their limit is 3)."]})

    def test_their_week_cap_is_named_when_it_is_the_tighter(self):
        shifts = [self._s(i, self.MON + timedelta(days=i)) for i in range(3)]
        out = shift_rules.evaluate(shifts, {"ruleMaxWeekHours": 40}, "none", limits={"maxHoursWeek": 20})
        self.assertIn("30h 00m scheduled this week (their limit is 20h).", out["s2"])
        # The company cap still speaks for itself when it is the tighter one.
        out = shift_rules.evaluate(shifts, {"ruleMaxWeekHours": 20}, "none", limits={"maxHoursWeek": 25})
        self.assertIn("30h 00m scheduled this week (20h is the most).", out["s2"])

    def test_rest_takes_the_longer_minimum_and_applies_to_salaried(self):
        a = self._s(1, self.MON, "08:00", "22:00", 840)
        b = self._s(2, self.MON + timedelta(days=1), "06:00", "10:00", 240)
        self.assertEqual(shift_rules.evaluate([a, b], {"ruleMinRestHours": 8}, "none"), {})
        out = shift_rules.evaluate([a, b], {"ruleMinRestHours": 8, "_salaried": True}, "none",
                                   limits={"minRestHours": 10})
        self.assertEqual(out, {"s2": ["Only 8h 00m rest before this shift (10h minimum)."]})

    def test_clean_limits(self):
        self.assertEqual(shift_rules.clean_limits({"maxHoursDay": "8", "maxShiftsWeek": 0, "x": 5}), {"maxHoursDay": 8})
        for bad in ({"maxHoursDay": 8.5}, {"maxHoursWeek": 200}, {"minRestHours": True}, {"maxDaysInRow": "a"}):
            with self.assertRaises(ValueError):
                shift_rules.clean_limits(bad)


if __name__ == "__main__":
    unittest.main()
