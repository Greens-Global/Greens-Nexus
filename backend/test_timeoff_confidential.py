"""Confidential time off (Neil, Sep 29): "make a personal leave confidential
where it doesn't show the reason publicly, but it would show to the manager
or the approver only."

A confidential request's note and decision note reach only its viewers -
the requester, their approver (direct manager; else the company's HR
contact; else the administrators) and whoever decided it. Everyone else who
may see the request at all sees its type and dates ("Time off - Medical",
Neil Sep 30: never "medical cancer treatment"). Only approvers decide it, and
nobody decides their own time off.

    python -m pytest test_timeoff_confidential.py
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text  # noqa: E402
with database.engine.connect() as _c:
    # A local sqlite file older than the column (CI builds a fresh one).
    for _sql in ("ALTER TABLE time_off_requests ADD COLUMN confidential INTEGER DEFAULT 0",):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

EMP = "conf.emp@greensglobal.com"        # reports to MGR
MGR = "conf.mgr@greensglobal.com"        # EMP's manager (level 3)
PEER = "conf.peer@greensglobal.com"      # another manager with an unscoped People editor grant
HRG = "conf.hrg@greensglobal.com"        # plain employee with a People editor grant
HRC = "conf.hrc@greensglobal.com"        # HR contact of CO
ADM = "conf.adm@greensglobal.com"        # administrator
NOMGR = "conf.nomgr@greensglobal.com"    # no manager on file, company CO -> HR contact decides
ORPHAN = "conf.orphan@greensglobal.com"  # no manager, company without an HR contact -> admins decide
CO, CO2, GRANT = "co-conf-test", "co-conf-test-2", "grant-conf-ed"
MON, NEXT_MON = "2026-11-16", "2026-11-23"
ALL = (EMP, MGR, PEER, HRG, HRC, ADM, NOMGR, ORPHAN)


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO, name="Conf Co", hr_contact_email=HRC))
            db.add(models.HrEntity(id=CO2, name="Conf Co 2", hr_contact_email=""))
            for em, mgr, co in ((EMP, MGR, CO), (MGR, ADM, CO), (PEER, ADM, CO), (HRG, ADM, CO), (HRC, ADM, CO),
                                (ADM, "", CO), (NOMGR, "", CO), (ORPHAN, "", CO2)):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                            last_name="Test", work_email=em, manager_email=mgr, company=co,
                                            status="active", deleted_at=""))
            db.add(models.NexusRole(email=MGR, role="manager"))
            db.add(models.NexusRole(email=PEER, role="manager"))
            db.add(models.NexusRole(email=ADM, role="administrator"))
            db.add(models.NexusGroup(id=GRANT, name="conf-ed", allowed_modules="hr:editor"))
            for em in (PEER, HRG, HRC):
                db.add(models.NexusGroupMember(group_id=GRANT, email=em))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.in_(ALL)).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.in_(ALL)).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_([CO, CO2])).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GRANT).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GRANT).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email.in_(ALL)).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.in_(ALL)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _request(self, who=EMP, type_="sick", note="Chemo appointment", confidential=True, day=MON):
        self._as(who)
        r = self.client.post("/timeclock/timeoff", json={"type": type_, "start_date": day, "end_date": day,
                                                          "note": note, "confidential": confidential})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _listed(self, who, req_id):
        self._as(who)
        r = self.client.get("/timeclock/timeoff")
        self.assertEqual(r.status_code, 200, r.text)
        return next((x for x in r.json() if x["id"] == req_id), None)

    def _decide(self, who, req_id, status="approved", note=""):
        self._as(who)
        return self.client.patch(f"/timeclock/timeoff/{req_id}", json={"status": status, "note": note})


class ViewerTests(_Base):
    def test_the_requester_sees_their_own(self):
        req = self._request()
        self.assertTrue(req["confidential"])
        self.assertEqual((req["type"], req["note"], req["redacted"]), ("sick", "Chemo appointment", False))
        self._as(EMP)
        mine = self.client.get("/timeclock/timeoff/mine").json()[0]
        self.assertEqual((mine["type"], mine["note"]), ("sick", "Chemo appointment"))

    def test_the_manager_sees_it_and_may_decide(self):
        req = self._request()
        row = self._listed(MGR, req["id"])
        self.assertEqual((row["type"], row["note"], row["redacted"], row["canDecide"]),
                         ("sick", "Chemo appointment", False, True))

    def test_other_managers_and_hr_grants_see_the_type_but_not_the_note(self):
        req = self._request()
        for who in (PEER, HRG, ADM):   # an administrator is not EMP's approver - MGR is
            row = self._listed(who, req["id"])
            self.assertIsNotNone(row, who)
            self.assertEqual((row["type"], row["note"], row["redacted"], row["canDecide"]),
                             ("sick", "", True, False), who)
            self.assertEqual((row["startDate"], row["endDate"], row["status"]), (MON, MON, "pending"))
            self.assertIn("Mgr", row["reviewer"])

    def test_a_plain_request_is_unchanged(self):
        req = self._request(type_="vacation", note="Beach", confidential=False)
        row = self._listed(PEER, req["id"])
        self.assertEqual((row["type"], row["note"], row["redacted"], row["confidential"]),
                         ("vacation", "Beach", False, False))

    def test_the_schedule_grid_redacts_per_caller(self):
        req = self._request()
        for who, full in ((MGR, True), (PEER, False)):
            self._as(who)
            r = self.client.get(f"/timeclock/schedule?start={MON}&end={MON}")
            self.assertEqual(r.status_code, 200, r.text)
            t = next(x for x in r.json()["timeoff"] if x["email"] == EMP)
            if full:
                self.assertEqual((t["type"], t["note"]), ("sick", "Chemo appointment"))
            else:
                self.assertEqual((t["type"], t["note"], t["redacted"]), ("sick", "", True))
        self.assertTrue(req["confidential"])

    def test_the_shift_warning_never_carries_the_note(self):
        self._request()
        self._as(PEER)
        w = self.client.get(f"/timeclock/schedule/check?email={EMP}&date={MON}&start=09:00&end=17:00").json()["warnings"]
        self.assertTrue(any("time off" in x.lower() for x in w), w)
        self.assertFalse(any("chemo" in x.lower() for x in w), w)


class DecisionTests(_Base):
    def test_only_the_approver_decides_a_confidential_request(self):
        req = self._request()
        for who in (PEER, HRG, ADM):
            r = self._decide(who, req["id"])
            self.assertEqual(r.status_code, 403, (who, r.text))
            self.assertIn("confidential", r.json()["detail"])
        r = self._decide(MGR, req["id"], note="Take care")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["decideNote"], "Take care")
        # Still private after the decision - the decision note too.
        row = self._listed(PEER, req["id"])
        self.assertEqual((row["type"], row["note"], row["decideNote"], row["status"]),
                         ("sick", "", "", "approved"))

    def test_nobody_decides_their_own_time_off(self):
        req = self._request(who=MGR, type_="vacation", confidential=False)
        r = self._decide(MGR, req["id"])
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("your own", r.json()["detail"])

    def test_the_hr_contact_decides_when_there_is_no_manager(self):
        req = self._request(who=NOMGR)
        row = self._listed(HRC, req["id"])
        self.assertEqual((row["type"], row["canDecide"]), ("sick", True))
        self.assertEqual(self._decide(PEER, req["id"]).status_code, 403)
        self.assertEqual(self._decide(HRC, req["id"]).status_code, 200)

    def test_administrators_decide_when_there_is_nobody_else(self):
        req = self._request(who=ORPHAN)
        self.assertEqual(self._decide(HRC, req["id"]).status_code, 403)
        row = self._listed(ADM, req["id"])
        self.assertEqual((row["type"], row["canDecide"]), ("sick", True))
        self.assertEqual(self._decide(ADM, req["id"]).status_code, 200)

    def test_plain_requests_are_decided_as_before(self):
        req = self._request(type_="vacation", confidential=False)
        self.assertEqual(self._decide(PEER, req["id"]).status_code, 200)


class SideChannelTests(_Base):
    def test_bells_about_a_confidential_request_name_the_type_never_the_note(self):
        self._request()
        db = database.SessionLocal()
        try:
            bells = db.query(models.NexusNotification).filter(models.NexusNotification.recipient.in_(ALL)).all()
        finally:
            db.close()
        self.assertTrue(bells)
        for b in bells:
            self.assertNotIn("chemo", f"{b.title} {b.body}".lower())
            self.assertIn("sick", b.body)

    def test_filing_on_behalf_can_mark_it_confidential(self):
        self._as(MGR)
        r = self.client.post("/timeclock/timeoff/on-behalf", json={"employee_email": EMP, "type": "sick",
                                                                    "start_date": MON, "end_date": MON,
                                                                    "note": "Surgery", "confidential": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["type"], r.json()["confidential"]), ("sick", True))
        row = self._listed(PEER, r.json()["id"])
        self.assertEqual((row["type"], row["note"]), ("sick", ""))

    def test_copying_a_schedule_keeps_it_confidential(self):
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id="to-conf-copy", employee_email=EMP, type="sick", note="Private",
                                         start_date=MON, end_date=MON, status="approved", confidential=1,
                                         created_at="2026-11-01T00:00:00"))
            db.commit()
        finally:
            db.close()
        self._as(PEER)   # copying never makes the scheduler a viewer
        r = self.client.post("/timeclock/schedule/copy", json={"source_start": MON, "source_end": "2026-11-22",
                                                               "target_start": NEXT_MON, "include_timeoff": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["timeoffCopied"], 1)
        db = database.SessionLocal()
        try:
            new = (db.query(models.TimeOffRequest)
                   .filter(models.TimeOffRequest.employee_email == EMP, models.TimeOffRequest.start_date == NEXT_MON).one())
            self.assertEqual((new.confidential, new.requested_by, new.status), (1, PEER, "pending"))
            new_id = new.id
        finally:
            db.close()
        row = self._listed(PEER, new_id)
        self.assertEqual((row["type"], row["note"], row["redacted"]), ("sick", "", True))


class BriefingTests(_Base):
    def test_the_briefing_names_the_type_to_everyone(self):
        import daily_briefing
        req = self._request()
        db = database.SessionLocal()
        try:
            r = db.query(models.TimeOffRequest).filter(models.TimeOffRequest.id == req["id"]).one()
            self.assertEqual(daily_briefing._leave_labeler(db, MGR)(r), "sick")
            self.assertEqual(daily_briefing._leave_labeler(db, PEER)(r), "sick")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
