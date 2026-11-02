"""Forms & Checklists (Neil, 11/02/2026) - plan Task 2: the Forms block on
the Insights board (routers/dashboards.py).

- GET /dashboards/insights carries a `forms` module: `entries_7d` (neutral),
  `follow_up_open` (warning while above zero, so it reaches Needs Attention;
  neutral at zero) and a `by_template` breakdown of the week's entries by
  form, six at most.
- The block never carries an answer value - counts and titles only.
- /insights/drilldown: `follow_up_open` lists the entries (title; submitter,
  site and the date as MM/DD/YYYY); `entries_7d` lists the week by form.
- Both refuse anyone below supervisor; a supervisor reads them.
- A submit after a read moves the count - DocFormEntry is a watched model,
  so the commit drops the board's cache.

Run alone (one file per process): python -m pytest test_forms_insights.py
"""
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"

import atexit  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import dashboards  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


CO_A = "fins-co-a"
SITE_A = "fins-site-a"
ADMIN = "fins.admin@greensglobal.com"       # administrator
MGR = "fins.mgr@greensglobal.com"           # manager; REP reports to them
SUP = "fins.sup@greensglobal.com"           # supervisor (level 2) - the floor
REP = "fins.rep@greensglobal.com"           # employee, site A
ODOMETER = 987654                            # a value that must never reach the board

PEOPLE = {
    ADMIN: dict(company=CO_A, department="Operations"),
    MGR: dict(company=CO_A, department="Operations"),
    SUP: dict(company=CO_A, department="Operations"),
    REP: dict(company=CO_A, department="Operations", manager_email=MGR, work_site_ids=json.dumps([SITE_A])),
}
ROLES = {ADMIN: "administrator", MGR: "manager", SUP: "supervisor"}
FIELDS = [
    {"token": "odometer", "label": "Odometer", "type": "number", "required": True, "section": "Vehicle"},
    {"token": "remark", "label": "Remark", "type": "multiline", "section": "Vehicle"},
]


class FormsInsightsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)

    def setUp(self):
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="Greens A"))
            db.add(models.HrWorkSite(id=SITE_A, name="North Yard"))
            db.add(models.HrCompanyWorkSite(id=f"{CO_A}:{SITE_A}", company_id=CO_A, site_id=SITE_A))
            for em, extra in PEOPLE.items():
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                            last_name="Fins", work_email=em, status="active", deleted_at="",
                                            **extra))
            for em, role in ROLES.items():
                db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
            db.commit()
        finally:
            db.close()
        self._flush()
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self._flush()

    def _flush(self):
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()
        cache.people_directory.invalidate()
        cache.dashboard_insights.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("fins.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("fins.%")).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id == CO_A).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id == SITE_A).delete(synchronize_session=False)
            db.query(models.HrCompanyWorkSite).filter(models.HrCompanyWorkSite.company_id == CO_A).delete(synchronize_session=False)
            db.query(models.DocFormEntry).delete(synchronize_session=False)
            db.query(models.DocTemplateVersion).delete(synchronize_session=False)
            db.query(models.DocTemplate).delete(synchronize_session=False)
            db.query(models.WorkflowEvent).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("fins.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _template(self, name):
        self._as(ADMIN)
        r = self.client.post("/documents/templates", json={
            "name": name, "docType": "form", "category": "vehicle", "status": "active",
            "fieldDefs": FIELDS, "audience": "company"})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _submit(self, tid, who=REP, note=""):
        self._as(who)
        r = self.client.post(f"/forms/{tid}/entries", json={
            "entryKey": str(uuid.uuid4()), "answers": {"odometer": ODOMETER, "remark": note}, "source": "phone",
            "workSiteId": SITE_A})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _review(self, eid, status, who=MGR):
        self._as(who)
        r = self.client.post(f"/forms/entries/{eid}/review", json={"status": status, "note": "see me"})
        self.assertEqual(r.status_code, 200, r.text)

    def _age(self, eid, days):
        """Move an entry's submit time back `days` days (past the week)."""
        row = self.db.query(models.DocFormEntry).filter(models.DocFormEntry.id == eid).first()
        row.submitted_at = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        self.db.commit()
        cache.dashboard_insights.invalidate()

    def _forms_block(self, who=MGR):
        self._as(who)
        r = self.client.get("/dashboards/insights")
        self.assertEqual(r.status_code, 200, r.text)
        blocks = [m for m in r.json()["modules"] if m["id"] == "forms"]
        self.assertEqual(len(blocks), 1, "no forms block on the board")
        return blocks[0]

    def _drill(self, metric, who=MGR, status=200):
        self._as(who)
        r = self.client.get("/dashboards/insights/drilldown", params={"module": "forms", "metric": metric})
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    # ── the block ────────────────────────────────────────────────────────────

    def test_forms_block_counts_the_week_and_open_follow_ups_and_breaks_down_by_form(self):
        vehicle = self._template("Vehicle Check")
        walk = self._template("Site Walk")
        a = self._submit(vehicle["id"])
        b = self._submit(vehicle["id"], note="a secret note value")
        self._submit(walk["id"])
        old = self._submit(walk["id"])
        self._age(old["id"], 10)                                  # last week's - out of the 7-day count
        self._review(a["id"], "follow_up")
        self._review(old["id"], "follow_up")                      # old but still open - counted
        self._review(b["id"], "reviewed")

        block = self._forms_block()
        self.assertEqual(block["label"], "Forms")
        self.assertEqual(block["nav"], "documents")
        stats = {s["key"]: s for s in block["stats"]}
        self.assertEqual(list(stats), ["entries_7d", "follow_up_open"])
        self.assertEqual(stats["entries_7d"]["value"], 3)
        self.assertEqual(stats["entries_7d"]["tone"], "neutral")
        self.assertEqual(stats["entries_7d"]["label"], "Entries (7d)")
        self.assertTrue(stats["entries_7d"]["drill"])
        self.assertEqual(stats["follow_up_open"]["value"], 2)
        self.assertEqual(stats["follow_up_open"]["tone"], "warning")
        self.assertEqual(stats["follow_up_open"]["label"], "Needs Follow-Up")
        self.assertTrue(stats["follow_up_open"]["drill"])
        self.assertEqual(block["breakdown"], [
            {"label": "Vehicle Check", "value": 2, "tone": "neutral"},
            {"label": "Site Walk", "value": 1, "tone": "neutral"},
        ])
        # counts and titles only - never an answer
        text = json.dumps(block)
        self.assertNotIn(str(ODOMETER), text)
        self.assertNotIn("secret", text)
        self.assertNotIn("answers", text)

    def test_follow_up_open_reads_neutral_at_zero(self):
        vehicle = self._template("Vehicle Check")
        self._submit(vehicle["id"])
        stats = {s["key"]: s for s in self._forms_block()["stats"]}
        self.assertEqual(stats["follow_up_open"]["value"], 0)
        self.assertEqual(stats["follow_up_open"]["tone"], "neutral")

    def test_breakdown_keeps_the_six_largest_forms(self):
        for i in range(8):
            tpl = self._template(f"Form {i}")
            for _ in range(i + 1):
                self._submit(tpl["id"])
        breakdown = self._forms_block()["breakdown"]
        self.assertEqual(len(breakdown), 6)
        self.assertEqual([b["value"] for b in breakdown], [8, 7, 6, 5, 4, 3])
        self.assertEqual(breakdown[0]["label"], "Form 7")

    def test_an_empty_table_still_gives_a_block_of_zeros(self):
        stats = {s["key"]: s["value"] for s in self._forms_block()["stats"]}
        self.assertEqual(stats, {"entries_7d": 0, "follow_up_open": 0})

    # ── drill-downs ──────────────────────────────────────────────────────────

    def test_follow_up_open_drills_to_the_entries(self):
        vehicle = self._template("Vehicle Check")
        a = self._submit(vehicle["id"])
        self._submit(vehicle["id"])                               # stays submitted - not listed
        self._review(a["id"], "follow_up")
        out = self._drill("follow_up_open")
        self.assertEqual(out["kind"], "list")
        self.assertEqual(out["title"], "Needs Follow-Up")
        self.assertEqual(out["total"], 1)
        self.assertEqual(len(out["rows"]), 1)
        row = out["rows"][0]
        self.assertEqual(row["label"], "Vehicle Check")
        today = datetime.now(timezone.utc).strftime("%m/%d/%Y")
        self.assertEqual(row["detail"], f"Rep Fins · North Yard · {today}")
        self.assertNotIn(str(ODOMETER), json.dumps(out))

    def test_entries_7d_drills_to_a_by_form_list(self):
        vehicle = self._template("Vehicle Check")
        walk = self._template("Site Walk")
        self._submit(vehicle["id"])
        self._submit(vehicle["id"])
        old = self._submit(walk["id"])
        self._age(old["id"], 10)
        self._submit(walk["id"])
        out = self._drill("entries_7d")
        self.assertEqual(out["kind"], "by_person")                # label / value rows, as the board draws them
        self.assertEqual(out["title"], "Entries (7d) by Form")
        self.assertEqual(out["rows"], [{"label": "Vehicle Check", "value": 2}, {"label": "Site Walk", "value": 1}])
        self.assertEqual(out["total"], 3)

    def test_an_unknown_forms_metric_is_404(self):
        self._drill("odometer", status=404)

    def test_drillable_lists_exactly_what_the_dispatch_handles(self):
        self.assertEqual(dashboards.DRILLABLE.get("forms"), {"entries_7d", "follow_up_open"})

    # ── access and freshness ─────────────────────────────────────────────────

    def test_below_supervisor_is_refused_and_a_supervisor_reads(self):
        self._as(REP)
        self.assertEqual(self.client.get("/dashboards/insights").status_code, 403)
        self.assertEqual(self.client.get("/dashboards/insights/drilldown",
                                         params={"module": "forms", "metric": "follow_up_open"}).status_code, 403)
        vehicle = self._template("Vehicle Check")
        self._submit(vehicle["id"])
        block = self._forms_block(who=SUP)
        self.assertEqual({s["key"]: s["value"] for s in block["stats"]}["entries_7d"], 1)
        self.assertEqual(self._drill("entries_7d", who=SUP)["total"], 1)

    def test_a_new_entry_moves_the_count_because_the_model_is_watched(self):
        self.assertIn(cache.dashboard_insights, cache._WATCHED.get("DocFormEntry", ()))
        vehicle = self._template("Vehicle Check")
        before = {s["key"]: s["value"] for s in self._forms_block()["stats"]}["entries_7d"]
        self._submit(vehicle["id"])
        after = {s["key"]: s["value"] for s in self._forms_block()["stats"]}["entries_7d"]
        self.assertEqual(after, before + 1)


if __name__ == "__main__":
    unittest.main()
