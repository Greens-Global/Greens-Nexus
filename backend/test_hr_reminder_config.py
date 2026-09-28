"""HR & Compliance Reminders timing (Sep 2026) - the admin picks when each
HR reminder fires instead of the days being hard-coded in reminders.py.

Covers: the defaults reproduce the old hard-coded behavior exactly; a custom
list fires on those days only; disabled means nothing; validation rejects bad
input; the per-day dedupe holds when the list changes; the e-sign chase reads
its numbers; and the endpoint gates + audit row.

    python -m pytest test_hr_reminder_config.py
"""
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import hr_reminder_config as hrc
import main
import models
import reminders

models.Base.metadata.create_all(bind=database.engine)

HR = "hrrem.hr@greensglobal.com"          # HR team member (hr:full grant)
HRV = "hrrem.hrview@greensglobal.com"     # HR viewer grant only
MGR = "hrrem.mgr@greensglobal.com"        # plain manager
ADMIN = "hrrem.admin@greensglobal.com"    # Global Admin (level 4)
EMP = "hrrem.emp@greensglobal.com"        # employee, no grants
GRP_FULL = "grp-hrrem-full"
GRP_VIEW = "grp-hrrem-view"
EMP_ID = "emp-hrrem-subject"


def _in_days(n):
    return (datetime.now(timezone.utc).date() + timedelta(days=n)).isoformat()


# The conditions reminders.py used before this change, verbatim.
LEGACY = {
    "rightToWork":    lambda d: d in (60, 30, 14, 7, 3, 1, 0) or -7 <= d < 0,
    "contractEnd":    lambda d: d in (30, 14, 7, 1, 0),
    "newStarter":     lambda d: d in (7, 3, 1, 0),
    "documentExpiry": lambda d: d in (30, 14, 7, 1, 0),
    "esignExpiring":  lambda d: 0 <= d <= 3,
}


def _save_raw(cfg):
    db = database.SessionLocal()
    try:
        row = db.query(models.NexusSetting).filter(models.NexusSetting.key == hrc._SETTINGS_KEY).first()
        if not row:
            row = models.NexusSetting(key=hrc._SETTINGS_KEY)
            db.add(row)
        row.value = json.dumps(cfg)
        db.commit()
    finally:
        db.close()
    cache.settings_config.invalidate()


class _Base(unittest.TestCase):
    def setUp(self):
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GRP_FULL, name="HR Rem Full", allowed_modules="hr:full"))
            db.add(models.NexusGroupMember(group_id=GRP_FULL, email=HR))
            db.add(models.NexusGroup(id=GRP_VIEW, name="HR Rem View", allowed_modules="hr:viewer"))
            db.add(models.NexusGroupMember(group_id=GRP_VIEW, email=HRV))
            db.add(models.NexusRole(email=MGR, role="manager"))
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.add(models.NexusRole(email=EMP, role="employee"))
            db.add(models.NexusRole(email=HR, role="employee"))
            db.add(models.NexusRole(email=HRV, role="employee"))
            db.commit()
        finally:
            db.close()
        self._flush()

    def tearDown(self):
        self._cleanup()
        self._flush()

    def _flush(self):
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == hrc._SETTINGS_KEY).delete()
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id.in_([GRP_FULL, GRP_VIEW])).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(
                models.NexusGroup.id.in_([GRP_FULL, GRP_VIEW])).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("hrrem.%")).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.id == EMP_ID).delete(synchronize_session=False))
            db.query(models.NexusNotification).filter(
                models.NexusNotification.ref_id == EMP_ID).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(
                models.AuditLog.action == "hr_reminder_settings_updated",
                models.AuditLog.user_email.like("hrrem.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()


# ── Pure config + predicate ─────────────────────────────────────────────────
class DefaultsAndPredicateTests(unittest.TestCase):
    def test_defaults_reproduce_the_old_hard_coded_days_exactly(self):
        cfg = hrc.defaults()
        for key, legacy in LEGACY.items():
            for d in range(-400, 401):
                self.assertEqual(reminders._fires(cfg[key], d), legacy(d), f"{key} at d={d}")

    def test_defaults_for_the_chase_match_the_old_constants(self):
        self.assertEqual(hrc.DEFAULTS["esignChase"],
                         {"enabled": True, "firstNudgeAfterDays": 3, "maxNudges": 3})

    def test_custom_list_fires_on_those_days_only(self):
        entry = {"enabled": True, "daysBefore": [90, 45, 5]}
        fired = [d for d in range(-30, 400) if reminders._fires(entry, d)]
        self.assertEqual(fired, [5, 45, 90])

    def test_disabled_fires_nothing(self):
        entry = dict(hrc.defaults()["rightToWork"], enabled=False)
        self.assertFalse(any(reminders._fires(entry, d) for d in range(-400, 401)))

    def test_unknown_offset_is_none(self):
        self.assertFalse(reminders._fires(hrc.defaults()["contractEnd"], None))


class ValidationTests(unittest.TestCase):
    def test_lists_are_deduped_and_sorted_latest_first(self):
        cfg = hrc.validate({"contractEnd": {"daysBefore": [1, 30, 7, 30, 0, 7.0]}})
        self.assertEqual(cfg["contractEnd"]["daysBefore"], [30, 7, 1, 0])

    def test_partial_payload_keeps_the_rest(self):
        cfg = hrc.validate({"newStarter": {"enabled": False}})
        self.assertFalse(cfg["newStarter"]["enabled"])
        self.assertEqual(cfg["newStarter"]["daysBefore"], [7, 3, 1, 0])
        self.assertEqual(cfg["rightToWork"], hrc.DEFAULTS["rightToWork"])

    def test_rejects_bad_input(self):
        bad = [
            "not an object",
            {"nope": {}},
            {"contractEnd": "x"},
            {"contractEnd": {"daysBefore": "30"}},
            {"contractEnd": {"daysBefore": [-1]}},
            {"contractEnd": {"daysBefore": [366]}},
            {"contractEnd": {"daysBefore": [1.5]}},
            {"contractEnd": {"daysBefore": ["7"]}},
            {"contractEnd": {"daysBefore": [True]}},
            {"contractEnd": {"daysBefore": list(range(11))}},
            {"contractEnd": {"daysAfter": [1]}},          # only visa has after-days
            {"contractEnd": {"enabled": "yes"}},
            {"rightToWork": {"daysAfter": [0]}},          # after-days start at 1
            {"esignChase": {"firstNudgeAfterDays": 0}},
            {"esignChase": {"firstNudgeAfterDays": 31}},
            {"esignChase": {"maxNudges": 11}},
            {"esignChase": {"maxNudges": -1}},
            {"esignChase": {"daysBefore": [1]}},
        ]
        for payload in bad:
            with self.assertRaises(hrc.ReminderConfigError, msg=repr(payload)):
                hrc.validate(payload)

    def test_accepts_the_edges(self):
        cfg = hrc.validate({"contractEnd": {"daysBefore": [365, 0]},
                            "esignChase": {"firstNudgeAfterDays": 30, "maxNudges": 0},
                            "rightToWork": {"daysAfter": []}})
        self.assertEqual(cfg["contractEnd"]["daysBefore"], [365, 0])
        self.assertEqual(cfg["esignChase"]["maxNudges"], 0)
        self.assertEqual(cfg["rightToWork"]["daysAfter"], [])

    def test_ten_distinct_days_is_the_limit(self):
        hrc.validate({"contractEnd": {"daysBefore": list(range(10))}})


# ── The daily scan reading the saved config ─────────────────────────────────
class ScanTests(_Base):
    def _subject(self, *, visa_in=None, contract_in=None):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == EMP_ID).delete()
            db.add(models.NexusEmployee(
                id=EMP_ID, first_name="Rita", last_name="Reminder", work_email="hrrem.subject@greensglobal.com",
                status="active", deleted_at="",
                compliance={"expiryDate": _in_days(visa_in)} if visa_in is not None else {},
                contractor={"contract_end": _in_days(contract_in)} if contract_in is not None else {}))
            db.commit()
        finally:
            db.close()

    def _bells(self, ntype):
        db = database.SessionLocal()
        try:
            return (db.query(models.NexusNotification)
                    .filter(models.NexusNotification.ref_id == EMP_ID,
                            models.NexusNotification.type == ntype,
                            models.NexusNotification.recipient == HR).all())
        finally:
            db.close()

    def _clear_bells(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == EMP_ID).delete()
            db.commit()
        finally:
            db.close()

    def test_default_visa_day_fires_to_the_hr_team(self):
        self._subject(visa_in=14)
        reminders.run_daily_scan()
        self.assertEqual(len(self._bells("hr_expiry")), 1)

    def test_default_off_day_does_not_fire(self):
        self._subject(visa_in=45)
        reminders.run_daily_scan()
        self.assertEqual(self._bells("hr_expiry"), [])

    def test_custom_list_fires_on_its_day_and_not_the_old_ones(self):
        _save_raw({"rightToWork": {"daysBefore": [45], "daysAfter": []}})
        self._subject(visa_in=45)
        reminders.run_daily_scan()
        self.assertEqual(len(self._bells("hr_expiry")), 1)
        self._clear_bells()
        self._subject(visa_in=14)                 # an old default day, no longer listed
        reminders.run_daily_scan()
        self.assertEqual(self._bells("hr_expiry"), [])
        self._subject(visa_in=-2)                 # after-days cleared
        reminders.run_daily_scan()
        self.assertEqual(self._bells("hr_expiry"), [])

    def test_disabled_type_sends_nothing(self):
        _save_raw({"contractEnd": {"enabled": False}})
        self._subject(contract_in=7)
        reminders.run_daily_scan()
        self.assertEqual(self._bells("hr_contract_end"), [])

    def test_changing_the_list_mid_day_does_not_resend(self):
        """Today's reminder already went out; the admin then edits the list
        (keeping today's offset, and adding earlier days). The next scan the
        same day - a deploy restart - must not ping again, and a newly added
        earlier day must not fire for a date that has already passed."""
        self._subject(visa_in=14)
        reminders.run_daily_scan()
        self.assertEqual(len(self._bells("hr_expiry")), 1)
        _save_raw({"rightToWork": {"daysBefore": [120, 90, 21, 14, 10]}})
        reminders.run_daily_scan()
        reminders.run_daily_scan()
        self.assertEqual(len(self._bells("hr_expiry")), 1)

    def test_adding_an_earlier_day_does_not_retro_fire(self):
        # 45 days out: adding 90 and 60 (both already behind us) fires nothing.
        _save_raw({"rightToWork": {"daysBefore": [90, 60, 30]}})
        self._subject(visa_in=45)
        reminders.run_daily_scan()
        self.assertEqual(self._bells("hr_expiry"), [])


# ── E-sign chase numbers ────────────────────────────────────────────────────
class ChaseConfigTests(_Base):
    def setUp(self):
        super().setUp()
        self.req = f"req-hrrem-{uuid.uuid4()}"
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()
        db = database.SessionLocal()
        try:
            db.query(models.HrSignParty).filter(models.HrSignParty.request_id == self.req).delete()
            db.query(models.HrSignRequest).filter(models.HrSignRequest.id == self.req).delete()
            db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == self.req).delete()
            db.commit()
        finally:
            db.close()
        super().tearDown()

    def _envelope(self, quiet_days, auto_chases=0):
        ago = (datetime.now(timezone.utc) - timedelta(days=quiet_days)).isoformat()
        db = self.db
        db.add(models.HrSignRequest(id=self.req, title="Offer", status="pending", routing="sequential",
                                    current_order=1, created_by="hrrem.sender@greensglobal.com",
                                    expires_on="", created_at=ago))
        pid = f"party-{uuid.uuid4()}"
        db.add(models.HrSignParty(id=pid, request_id=self.req, name="Sam", email="hrrem.signer@greensglobal.com",
                                  kind="internal", party_role="signer", ordinal=1, status="notified"))
        db.add(models.HrSignEvent(id=str(uuid.uuid4()), request_id=self.req, party_id=pid,
                                  type="sent", detail="notified", at=ago, seq=1))
        for i in range(auto_chases):
            db.add(models.HrSignEvent(id=str(uuid.uuid4()), request_id=self.req, party_id=pid, type="reminded",
                                      detail=f"automatic reminder ({i + 1} of 3)", at=ago, seq=2 + i))
        db.commit()
        return pid

    def _auto(self, pid):
        return (self.db.query(models.HrSignEvent)
                .filter(models.HrSignEvent.request_id == self.req, models.HrSignEvent.party_id == pid,
                        models.HrSignEvent.type == "reminded").count())

    def test_a_longer_quiet_period_waits(self):
        _save_raw({"esignChase": {"firstNudgeAfterDays": 7}})
        pid = self._envelope(quiet_days=5)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._auto(pid), 0)

    def test_a_shorter_quiet_period_chases_sooner(self):
        _save_raw({"esignChase": {"firstNudgeAfterDays": 1}})
        pid = self._envelope(quiet_days=1)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._auto(pid), 1)

    def test_lowering_the_cap_below_what_was_sent_stops_chasing(self):
        _save_raw({"esignChase": {"maxNudges": 1}})
        pid = self._envelope(quiet_days=10, auto_chases=2)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._auto(pid), 2)

    def test_disabled_chase_does_nothing(self):
        _save_raw({"esignChase": {"enabled": False}})
        pid = self._envelope(quiet_days=10)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._auto(pid), 0)


# ── Endpoints ───────────────────────────────────────────────────────────────
class EndpointTests(_Base):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        self._flush()

    def test_view_gate(self):
        for who, code in ((EMP, 401), (MGR, 200), (HRV, 200), (HR, 200), (ADMIN, 200)):
            self._as(who)
            self.assertEqual(self.client.get("/hr-reminder-settings").status_code, code, who)

    def test_get_returns_defaults_and_edit_flag(self):
        self._as(MGR)
        body = self.client.get("/hr-reminder-settings").json()
        self.assertEqual(body["config"], hrc.DEFAULTS)
        self.assertEqual(body["defaults"], hrc.DEFAULTS)
        self.assertFalse(body["canEdit"])
        self._as(HR)
        self.assertTrue(self.client.get("/hr-reminder-settings").json()["canEdit"])

    def test_save_gate(self):
        payload = {"config": {"contractEnd": {"daysBefore": [21, 7]}}}
        for who in (EMP, MGR, HRV):
            self._as(who)
            self.assertEqual(self.client.put("/hr-reminder-settings", json=payload).status_code, 401, who)
        for who in (HR, ADMIN):
            self._as(who)
            self.assertEqual(self.client.put("/hr-reminder-settings", json=payload).status_code, 200, who)

    def test_save_validates_and_audits(self):
        self._as(ADMIN)
        r = self.client.put("/hr-reminder-settings", json={"contractEnd": {"daysBefore": [400]}})
        self.assertEqual(r.status_code, 422)
        self.assertIn("between 0 and 365", r.json()["detail"])
        r = self.client.put("/hr-reminder-settings", json={"contractEnd": {"daysBefore": [7, 21, 7]}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["config"]["contractEnd"]["daysBefore"], [21, 7])
        self.assertEqual(r.json()["updatedBy"], ADMIN)
        # The scan sees it.
        db = database.SessionLocal()
        try:
            self.assertEqual(hrc.get_config(db)["contractEnd"]["daysBefore"], [21, 7])
            row = (db.query(models.AuditLog)
                   .filter(models.AuditLog.action == "hr_reminder_settings_updated",
                           models.AuditLog.user_email == ADMIN).one())
            details = json.loads(row.details)
            self.assertEqual(list(details), ["contractEnd"])
            self.assertEqual(details["contractEnd"]["from"]["daysBefore"], [30, 14, 7, 1, 0])
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
