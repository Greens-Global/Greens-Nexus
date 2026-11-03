"""The Settings walls (Settings fix plan, PR 1, 11/02/2026).

  - The organization's mail plumbing (task / ticket notify sender, reply-to,
    Always CC, email replies) and the Daily Briefing / Weekly Digest /
    Workforce Scorecard mode and test recipients are Super Administrator
    only - and only a CHANGE is refused (a form sends its whole copy back).
  - Settings saves are checked (types, bounds, unknown keys dropped).
  - The labor budget is HR++'s: stripped from every other caller, never
    changed by them, never dropped by their reset.
  - Organization-wide records need company-wide access; a walled
    Administrator reads only their own companies' pay rules, leave
    balances, logs and recipients.
  - Read-modify-write settings merge into what is stored NOW under the row
    lock (scoped_settings.merge_save) - a stale copy never wins, the first
    insert race never 500s.
  - Company overrides keep only what differs from the organization's value.

    python -m pytest -q test_settings_walls.py
"""
import json
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import scoped_settings  # noqa: E402
import task_notify  # noqa: E402

SUPER = "sam.walls@greensglobal.com"       # owner - a Super Administrator
ADMIN = "ada.walls@greensglobal.com"       # administrator - walled to C1
MGR = "max.walls@greensglobal.com"         # manager in C1
EMP1 = "eve.walls@greensglobal.com"        # employee in C1
EMP2 = "ian.walls@greensglobal.com"        # employee in C2
C1, C2 = "co-walls-1", "co-walls-2"


def _settle():
    auth.invalidate_role_cache()
    cache.settings_config.invalidate()


class _Harness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusRole, models.HrEntity, models.NexusSetting,
                  models.NexusDailyBriefingLog, models.TaskEmailLog, models.Task):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.HrEntity(id=C1, name="Walls One", country="US"))
        self.db.add(models.HrEntity(id=C2, name="Walls Two", country="US"))
        for em, first, co in ((SUPER, "Sam", C1), (ADMIN, "Ada", C1), (MGR, "Max", C1),
                              (EMP1, "Eve", C1), (EMP2, "Ian", C2)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Walls",
                                             company=co, status="active"))
        for em, role in ((SUPER, "owner"), (ADMIN, "administrator"), (MGR, "manager")):
            self.db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
        self.db.commit()
        _settle()
        self._as(SUPER)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        _settle()
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _walls_on(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        _settle()

    def _setting(self, key):
        self.db.expire_all()
        row = self.db.get(models.NexusSetting, key)
        return json.loads(row.value) if row and row.value else None


# ── The mail plumbing ────────────────────────────────────────────────────────
class PlumbingCase(_Harness):
    def test_a_walled_administrator_cannot_change_the_task_sender(self):
        task_notify.save_settings(self.db, {"fromMailbox": "tasks@greensglobal.com"}, "seed")
        self._as(ADMIN)
        r = self.client.put("/tasks/notify/settings", json={"fromMailbox": "evil@elsewhere.com"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self._setting("task_notify_config")["fromMailbox"], "tasks@greensglobal.com")

    def test_the_whole_form_sent_back_unchanged_still_saves_the_rest(self):
        task_notify.save_settings(self.db, {"fromMailbox": "tasks@greensglobal.com", "defaultCc": ["ops@greensglobal.com"]}, "seed")
        self._as(ADMIN)
        form = self.client.get("/tasks/notify/settings").json()
        form["dueSoonDays"] = 5
        form["defaultCc"] = ["OPS@greensglobal.com"]   # the same address, as typed
        r = self.client.put("/tasks/notify/settings", json=form)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting("task_notify_config")["dueSoonDays"], 5)

    def test_a_manager_is_refused_a_plumbing_change(self):
        with self.assertRaises(PermissionError):
            task_notify.save_settings(self.db, {"replyTo": "x@greensglobal.com"}, MGR, {"email": MGR, "level": 3})
        with self.assertRaises(PermissionError):
            task_notify.save_settings(self.db, {"inboundEnabled": True}, MGR, {"email": MGR, "level": 3})

    def test_a_super_administrator_changes_it(self):
        r = self.client.put("/tasks/notify/settings", json={"replyTo": "tasks@greensglobal.com", "inboundEnabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting("task_notify_config")["replyTo"], "tasks@greensglobal.com")

    def test_bad_values_never_reach_the_readers(self):
        for bad in ({"dueSoonDays": "soon"}, {"dueSoonDays": 400}, {"defaultCc": ["not an email"]},
                    {"enabledEvents": "all"}, {"batchWindowMinutes": -1}):
            r = self.client.put("/tasks/notify/settings", json=bad)
            self.assertEqual(r.status_code, 400, (bad, r.text))
        r = self.client.put("/tasks/notify/settings", json={"madeUpKey": 1, "enabledEvents": {"created": 0, "bogus": True}})
        self.assertEqual(r.status_code, 200, r.text)
        stored = self._setting("task_notify_config")
        self.assertNotIn("madeUpKey", stored)
        self.assertIs(stored["enabledEvents"]["created"], False)
        self.assertNotIn("bogus", stored["enabledEvents"])

    def test_the_ticket_sender_is_a_super_administrator_s(self):
        self._as(ADMIN)
        r = self.client.put("/task-tickets/notify/settings", json={"defaultCc": ["spy@elsewhere.com"]})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.put("/task-tickets/notify/settings", json={"autoCloseDays": 7})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.put("/task-tickets/notify/settings", json={"autoCloseDays": "never"})
        self.assertEqual(r.status_code, 400, r.text)
        self._as(SUPER)
        r = self.client.put("/task-tickets/notify/settings", json={"defaultCc": ["desk@greensglobal.com"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting("ticket_notify_config")["defaultCc"], ["desk@greensglobal.com"])
        self.assertEqual(self._setting("ticket_notify_config")["autoCloseDays"], 7)

    def test_the_task_email_log_shows_only_the_caller_s_companies(self):
        for tid, co in (("t-walls-1", C1), ("t-walls-2", C2)):
            self.db.add(models.Task(id=tid, title=f"Task {co}", company_id=co, created_by=SUPER))
            self.db.add(models.TaskEmailLog(id=str(uuid.uuid4()), task_id=tid, event_type="created",
                                            idempotency_key=str(uuid.uuid4()), recipient=EMP1, subject=f"About {co}",
                                            status="sent", created_at="2026-11-02T10:00:00"))
        self.db.add(models.TaskEmailLog(id=str(uuid.uuid4()), task_id="gone", event_type="created",
                                        idempotency_key=str(uuid.uuid4()), recipient=EMP1, subject="Purged",
                                        status="sent", created_at="2026-11-02T10:00:00"))
        self.db.commit()
        self.assertEqual(self.client.get("/tasks/notify/log").json()["total"], 3)
        self._as(ADMIN)
        out = self.client.get("/tasks/notify/log").json()
        self.assertEqual(out["total"], 1)
        self.assertEqual([r["subject"] for r in out["rows"]], [f"About {C1}"])


class ScheduledEmailCase(_Harness):
    def test_mode_and_test_recipients_are_a_super_administrator_s(self):
        self._as(ADMIN)
        self.assertEqual(self.client.put("/daily-briefing/config", json={"mode": "live"}).status_code, 403)
        self.assertEqual(self.client.put("/daily-briefing/config", json={"test_recipients": ["me@x.com"]}).status_code, 403)
        self.assertEqual(self.client.put("/weekly-digest/config", json={"mode": "live"}).status_code, 403)
        self.assertEqual(self.client.put("/workforce-scorecard/config", json={"mode": "test"}).status_code, 403)
        # Unchanged mode sent back with another key: fine.
        r = self.client.put("/daily-briefing/config", json={"mode": "off", "leadMinutes": 90})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(SUPER)
        self.assertEqual(self.client.put("/daily-briefing/config", json={"mode": "test"}).status_code, 200)

    def test_the_briefing_log_lists_only_the_caller_s_people(self):
        for em in (EMP1, EMP2):
            self.db.add(models.NexusDailyBriefingLog(id=str(uuid.uuid4()), employee_email=em, briefing_date="2026-11-02",
                                                     mode="off", created_at="2026-11-02T10:00:00"))
        self.db.commit()
        self.assertEqual(self.client.get("/daily-briefing/log").json()["total"], 2)
        self._as(ADMIN)
        out = self.client.get("/daily-briefing/log").json()
        self.assertEqual([r["employeeEmail"] for r in out["rows"]], [EMP1])
        other = self.db.query(models.NexusDailyBriefingLog).filter_by(employee_email=EMP2).first()
        self.assertEqual(self.client.delete(f"/daily-briefing/log/{other.id}").status_code, 404)


# ── The labor budget ─────────────────────────────────────────────────────────
class LaborBudgetCase(_Harness):
    URL = "/timeclock/shift-requests/settings"

    def test_stripped_for_everyone_but_hr_plus(self):
        self.assertEqual(self.client.put(self.URL, json={"laborBudgetHours": 900}).status_code, 200)
        self.assertEqual(self.client.get(self.URL).json()["laborBudgetHours"], 900)
        for who in (EMP1, MGR):
            self._as(who)
            body = self.client.get(self.URL).json()
            self.assertNotIn("laborBudgetHours", body, who)
            self.assertNotIn("laborBudgetAmount", body, who)
            self.assertFalse(body["canSeeLaborBudget"])

    def test_a_manager_never_changes_it_and_a_reset_never_takes_it(self):
        self._walls_on()   # the manager's reach is their company
        r = self.client.put(f"{self.URL}?company={C1}", json={"laborBudgetHours": 500, "defaultGraceMin": 9})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(MGR)
        r = self.client.put(f"{self.URL}?company={C1}", json={"laborBudgetHours": 1})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.put(f"{self.URL}?company={C1}", json={"defaultGraceMin": 12})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.delete(f"{self.URL}?company={C1}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting(f"shift_requests_config:{C1}"), {"laborBudgetHours": 500})

    def test_a_group_s_reset_clears_only_its_own_keys(self):
        r = self.client.put(f"{self.URL}?company={C1}", json={"laborBudgetHours": 500, "defaultGraceMin": 9, "swaps": True})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.delete(f"{self.URL}?company={C1}&keys=timeZone,weekStart,defaultGraceMin")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting(f"shift_requests_config:{C1}"), {"laborBudgetHours": 500, "swaps": True})
        r = self.client.delete(f"{self.URL}?company={C1}&keys=laborBudgetHours,laborBudgetAmount,swaps")
        self.assertIsNone(self._setting(f"shift_requests_config:{C1}"))   # nothing left: the row goes


# ── Organization-wide records, and reads inside the walls ────────────────────
class OrgWideCase(_Harness):
    def test_a_walled_administrator_cannot_change_the_brand(self):
        self._as(ADMIN)
        self.assertEqual(self.client.put("/branding/config", json={"accent": "blue"}).status_code, 403)
        self.assertEqual(self.client.put("/ca-review/settings", json={"minWage": 17.5}).status_code, 403)
        self._as(SUPER)
        r = self.client.put("/branding/config", json={"accent": "blue", "navMotion": "subtle"})
        self.assertEqual(r.status_code, 200, r.text)
        # A save without the strength keeps the one stored (read under the lock).
        r = self.client.put("/branding/config", json={"accent": "green"})
        self.assertEqual(r.json()["navMotion"], "subtle")

    def test_pay_rules_answer_only_for_the_caller_s_companies(self):
        self._as(ADMIN)
        self.assertEqual(self.client.get(f"/timeclock/payroll/rounding?company={C2}").status_code, 404)
        body = self.client.get(f"/timeclock/payroll/rounding?company={C1}").json()
        self.assertEqual([c["id"] for c in body["companies"]], [C1])
        # The tenant rule is every company's: company-wide access only.
        self.assertEqual(self.client.put("/timeclock/payroll/rounding", json={"enabled": True, "nearestMin": 5}).status_code, 403)

    def test_leave_balances_and_sender_overrides_stay_inside_the_walls(self):
        self._as(ADMIN)
        out = self.client.get("/leave-balances/admin").json()
        self.assertEqual({p["company"] for p in out["people"]}, {C1})
        self.assertEqual([c["id"] for c in out["companies"]], [C1])
        self.assertFalse(out["canSetup"])
        self.assertEqual(self.client.get("/hr/signature-sender-overrides").json()["senderOverrides"], [])
        self.assertEqual(self.client.put("/hr/signature-sender-overrides", json={"overrides": []}).status_code, 403)

    def test_bad_pay_rule_values_are_refused(self):
        r = self.client.put("/timeclock/payroll/autolunch", json={"enabled": True, "afterMin": 0, "deductMin": 30})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.put("/timeclock/payroll/breakpolicy",
                            json={"enabled": True, "paidBreakMin": 10, "restMaxMin": 90, "longBreakMin": 75})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.put("/timeclock/payroll/autolunch", json={"enabled": True, "afterMin": 360, "deductMin": 30})
        self.assertEqual(r.status_code, 200, r.text)

    def test_roles_me_says_how_far_the_caller_reaches(self):
        me = self.client.get("/roles/me").json()
        self.assertTrue(me["is_global_admin"])
        self.assertIsNone(me["manage_companies"])
        self.assertFalse(me["company_walled"])
        self._as(ADMIN)
        me = self.client.get("/roles/me").json()
        self.assertFalse(me["is_global_admin"])
        self.assertEqual(me["manage_companies"], [C1])
        self.assertTrue(me["company_walled"])


# ── Lost updates and sparse overrides ────────────────────────────────────────
class MergeCase(_Harness):
    def test_a_stale_session_merges_into_what_is_stored_now(self):
        task_notify.save_settings(self.db, {"dueSoonDays": 2}, "seed")
        other = database.SessionLocal()
        try:
            task_notify.get_settings(other)        # this session read the row before the other save
            task_notify.save_settings(self.db, {"dueSoonDays": 6}, "first")
            task_notify.save_settings(other, {"batchWindowMinutes": 0}, "second")
        finally:
            other.close()
        stored = self._setting("task_notify_config")
        self.assertEqual(stored["dueSoonDays"], 6)          # never undone by the stale copy
        self.assertEqual(stored["batchWindowMinutes"], 0)

    def test_the_first_insert_race_merges_instead_of_failing(self):
        # Another request stores the row between this one's look and its insert.
        real = scoped_settings.lock_row
        calls = {"n": 0}

        def lagging(db, key):
            calls["n"] += 1
            if calls["n"] == 1:
                side = database.SessionLocal()
                side.add(models.NexusSetting(key="race_key", value=json.dumps({"a": 1})))
                side.commit()
                side.close()
                return None
            return real(db, key)
        scoped_settings.lock_row = lagging
        try:
            out = scoped_settings.merge_save(self.db, "race_key", lambda s: {**s, "b": 2}, "t")
            self.db.commit()
        finally:
            scoped_settings.lock_row = real
        self.assertEqual(out, {"a": 1, "b": 2})
        self.assertEqual(self._setting("race_key"), {"a": 1, "b": 2})

    def test_company_overrides_keep_only_what_differs(self):
        import hr_letters
        import hr_probation
        hr_probation.save_settings(self.db, "", {"months": 3, "reminderDays": 14}, "t")
        # The whole form sent back as the organization has it: nothing pinned.
        org = {k: v for k, v in hr_probation.settings(self.db, "").items() if k in ("months", "reminderDays", "letterheadId")}
        hr_probation.save_settings(self.db, C1, org, "t")
        self.assertIsNone(self._setting(f"{hr_probation.SETTING_KEY}:{C1}"))
        hr_probation.save_settings(self.db, C1, {**org, "months": 6}, "t")
        self.assertEqual(self._setting(f"{hr_probation.SETTING_KEY}:{C1}"), {"months": 6})
        # A later organization change still reaches the company.
        hr_probation.save_settings(self.db, "", {"reminderDays": 30}, "t")
        self.assertEqual(hr_probation.settings(self.db, C1)["reminderDays"], 30)
        self.assertEqual(hr_probation.settings(self.db, C1)["months"], 6)

        # Letters: a type or the letterhead left out keeps what is stored.
        key = hr_letters.TYPE_KEYS[0]
        scoped_settings.save(self.db, hr_letters.SETTINGS_BASE, "", {"letterheadId": "", key: {"on": False, "templateId": ""}}, "t")
        self.db.commit()
        hr_letters.save_settings(self.db, C1, {hr_letters.TYPE_KEYS[-1]: {"on": False, "templateId": ""}}, "t")
        self.db.commit()
        self.assertFalse(hr_letters.settings_for(self.db, C1)[key]["on"])   # inherited, not the code default
        stored = self._setting(f"{hr_letters.SETTINGS_BASE}:{C1}")
        self.assertNotIn("letterheadId", stored or {})


# ── Records every company shares: Super Administrators only (Neil, 11/02/2026)
class OrgRecordCase(_Harness):
    def _full_grant_manager(self):
        """MGR (level 3) with Full People and Full Tickets grants, walls off."""
        self.db.add(models.NexusGroup(id="g-walls-full", name="Walls Full", allowed_modules="hr:full,tickets:full"))
        self.db.add(models.NexusGroupMember(group_id="g-walls-full", email=MGR))
        self.db.commit()
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.query(models.NexusGroupMember).filter_by(group_id="g-walls-full").delete()
        self.db.query(models.NexusGroup).filter_by(id="g-walls-full").delete()
        self.db.query(models.HrInterviewTemplate).delete()
        self.db.commit()
        cache.module_grants.invalidate()
        super().tearDown()

    def _writes(self, tid):
        return [
            ("put", "/branding/config", {"accent": "blue"}),
            ("put", "/branding/email-theme", {}),
            ("put", "/ticket-property/rules", {"requiredTopics": ["Leak"]}),
            ("put", "/ca-review/settings", {"minWage": 17.5}),
            ("post", "/hr/interview-templates", {"name": "Site Manager", "questions": ["Why here?"]}),
            ("put", f"/hr/interview-templates/{tid}", {"name": "Renamed", "questions": ["Why?"]}),
            ("delete", f"/hr/interview-templates/{tid}", None),
            ("put", "/leave-balances/policies", {"policies": {}}),
            ("put", "/hr/signature-sender-overrides", {"overrides": []}),
        ]

    def _call(self, method, url, body):
        fn = getattr(self.client, method)
        return fn(url) if body is None else fn(url, json=body)

    def test_an_administrator_and_a_full_grant_holder_are_refused_every_org_record(self):
        self._full_grant_manager()
        self.db.add(models.HrInterviewTemplate(id="tpl-walls", name="General", questions=[], created_by=SUPER))
        self.db.commit()
        for who in (ADMIN, MGR):          # level 4 (walled), level 3 with Full grants (walls off)
            self._as(who)
            for method, url, body in self._writes("tpl-walls"):
                r = self._call(method, url, body)
                self.assertIn(r.status_code, (401, 403), (who, method, url, r.text))   # require_administrator answers 401
        self.assertIsNotNone(self.db.get(models.HrInterviewTemplate, "tpl-walls"))
        # An Administrator with no wall near them (a member of no company) is refused too.
        self.db.query(models.NexusEmployee).filter_by(work_email=ADMIN).update({"company": ""})
        self.db.commit()
        self._as(ADMIN)
        self.assertEqual(self.client.put("/branding/config", json={"accent": "blue"}).status_code, 403)

    def test_a_super_administrator_changes_every_org_record(self):
        self.db.add(models.HrInterviewTemplate(id="tpl-walls", name="General", questions=[], created_by=SUPER))
        self.db.commit()
        for method, url, body in self._writes("tpl-walls"):
            r = self._call(method, url, body)
            self.assertNotEqual(r.status_code, 403, (method, url, r.text))
            self.assertLess(r.status_code, 500, (method, url, r.text))

    def test_the_leave_start_date_stays_per_company_for_a_walled_administrator(self):
        self._as(ADMIN)
        r = self.client.put("/leave-balances/cutover", json={"date": "2026-01-01", "company": C1})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.put("/leave-balances/cutover", json={"date": "2026-01-01", "company": ""})
        self.assertEqual(r.status_code, 403, r.text)


# ── Review follow-ups ────────────────────────────────────────────────────────
class DeskRosterCase(_Harness):
    URL = "/task-tickets/notify/settings"

    def _seed(self, **cfg):
        import ticket_notify
        ticket_notify.save_settings(self.db, cfg, "seed")

    def test_another_company_s_desk_is_kept_as_stored(self):
        self._seed(agentEmailsByCompany={C2: [EMP2]})
        self._as(ADMIN)
        r = self.client.put(self.URL, json={"agentEmailsByCompany": {C1: [EMP1], C2: [ADMIN]}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting("ticket_notify_config")["agentEmailsByCompany"], {C1: [EMP1], C2: [EMP2]})
        # Left out of the patch, another company's desk is still kept.
        r = self.client.put(self.URL, json={"agentEmailsByCompany": {}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._setting("ticket_notify_config")["agentEmailsByCompany"], {C2: [EMP2]})

    def test_the_fallback_desk_and_the_ticket_admin_are_a_super_administrator_s(self):
        self._seed(agentEmails=[EMP1], ticketAdminEmail=EMP1)
        self._as(ADMIN)
        self.assertEqual(self.client.put(self.URL, json={"agentEmails": [EMP1, ADMIN]}).status_code, 403)
        self.assertEqual(self.client.put(self.URL, json={"ticketAdminEmail": ADMIN}).status_code, 403)
        # Sent back unchanged (another order, another case): no change.
        r = self.client.put(self.URL, json={"agentEmails": [EMP1.upper()], "ticketAdminEmail": EMP1, "autoCloseDays": 3})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(SUPER)
        self.assertEqual(self.client.put(self.URL, json={"agentEmails": [EMP1, EMP2]}).status_code, 200)

    def test_only_nexus_people_go_on_a_desk(self):
        self._as(ADMIN)
        r = self.client.put(self.URL, json={"agentEmailsByCompany": {C1: ["outsider@elsewhere.com"]}})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("not on the Nexus People list", r.text)
        self._as(SUPER)
        r = self.client.put(self.URL, json={"agentEmails": ["partner@elsewhere.com"]})
        self.assertEqual(r.status_code, 400, r.text)


class ReviewFollowUpCase(_Harness):
    def test_the_mode_check_reads_the_locked_value(self):
        import settings_walls
        order = []
        real_lock, real_refuse = scoped_settings.lock_row, settings_walls.refuse_change

        def lock(db, key):
            order.append(("lock", key))
            return real_lock(db, key)

        def refuse(*a, **k):
            order.append(("check", ""))
            return real_refuse(*a, **k)
        scoped_settings.lock_row, settings_walls.refuse_change = lock, refuse
        try:
            for url in ("/daily-briefing/config", "/weekly-digest/config", "/workforce-scorecard/config"):
                order.clear()
                self.assertEqual(self.client.put(url, json={"mode": "off"}).status_code, 200, url)
                self.assertEqual(order[0][0], "lock", url)
                self.assertIn(("check", ""), order, url)
        finally:
            scoped_settings.lock_row, settings_walls.refuse_change = real_lock, real_refuse

    def test_the_task_log_walls_by_the_task_s_owner_when_it_has_no_company(self):
        for tid, owner in (("t-own-1", EMP1), ("t-own-2", EMP2)):
            self.db.add(models.Task(id=tid, title=f"Owned by {owner}", company_id="", owner_email=owner, created_by=owner))
            for _ in range(2):
                self.db.add(models.TaskEmailLog(id=str(uuid.uuid4()), task_id=tid, event_type="created",
                                                idempotency_key=str(uuid.uuid4()), recipient=EMP1,
                                                subject=f"About {tid}", status="sent", created_at="2026-11-02T10:00:00"))
        self.db.commit()
        self._as(ADMIN)
        out = self.client.get("/tasks/notify/log?limit=1").json()
        self.assertEqual(out["total"], 2)          # counted in the database, not the page
        self.assertEqual([r["taskId"] for r in out["rows"]], ["t-own-1"])

    def test_repeats_and_case_in_a_stored_list_are_no_change(self):
        row = models.NexusSetting(key="task_notify_config",
                                  value=json.dumps({"defaultCc": ["Ops@greensglobal.com", "ops@greensglobal.com"]}))
        self.db.add(row)
        self.db.commit()
        self._as(ADMIN)
        r = self.client.put("/tasks/notify/settings", json={"defaultCc": ["ops@greensglobal.com"], "dueSoonDays": 3})
        self.assertEqual(r.status_code, 200, r.text)

    def test_domains_in_another_order_are_no_change(self):
        ent = self.db.get(models.HrEntity, C1)
        ent.domains = "a.example.com,b.example.com"
        self.db.commit()
        self._as(ADMIN)
        r = self.client.patch(f"/hr/entities/{C1}", json={"domains": "B.example.com, a.example.com", "notes": "hi"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.patch(f"/hr/entities/{C1}", json={"domains": "c.example.com"})
        self.assertEqual(r.status_code, 403, r.text)

    def test_test_sends_and_resends_stay_inside_the_walls(self):
        from routers import workforce_scorecard as wsc_router
        self._as(ADMIN)
        # The digest: another company's person is not there; another address is refused.
        self.assertEqual(self.client.post("/weekly-digest/test-send", json={"employee_email": EMP2}).status_code, 404)
        r = self.client.post("/weekly-digest/test-send", json={"employee_email": EMP1, "to": ["inbox@elsewhere.com"]})
        self.assertEqual(r.status_code, 403, r.text)
        # The scorecard: the same rule for the addresses.
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP1).first()
        real = wsc_router._recipient
        wsc_router._recipient = lambda db, email, cfg: (emp, None, "all") if email == EMP1 else (None, None, "")
        try:
            r = self.client.post("/workforce-scorecard/test-send", json={"manager_email": EMP1, "to": ["inbox@elsewhere.com"]})
            self.assertEqual(r.status_code, 403, r.text)
            self.assertEqual(self.client.post("/workforce-scorecard/test-send", json={"manager_email": EMP2}).status_code, 404)
        finally:
            wsc_router._recipient = real
        # Force resends of another company's person: not found.
        digest = models.NexusWeeklyDigestLog(id=str(uuid.uuid4()), employee_email=EMP2, week_start="2026-10-26")
        card = models.NexusWorkforceScorecardLog(id=str(uuid.uuid4()), manager_email=EMP2, week_start="2026-10-26")
        self.db.add_all([digest, card])
        self.db.commit()
        self.assertEqual(self.client.delete(f"/weekly-digest/log/{digest.id}").status_code, 404)
        self.assertEqual(self.client.delete(f"/workforce-scorecard/log/{card.id}").status_code, 404)
        self.assertIsNotNone(self.db.get(models.NexusWeeklyDigestLog, digest.id))


if __name__ == "__main__":
    unittest.main()
