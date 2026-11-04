"""
Asset Management's Company field (Neil, 11/03/2026: "A company field on
asset management would replace the inferred company").

  * the per-row save (POST /property-assets/changes) checks a CHANGED
    companyId: an unknown company is refused, a walled Administrator may
    assign only their own companies, may not take an asset from another
    company and may not clear it; a Super Administrator may do all three; an
    unchanged value is never re-checked; a row saved without the key keeps
    the company it has; the save still stamps `_rev` and keeps the log entry;
  * property_links.property_company prefers the field and falls back to the
    inference only while it is blank;
  * the one-time fill (asset_company_fill) sets blanks only, never
    overwrites, runs once, logs "Company set from ...", bumps `_rev`, and its
    dry run lists what it would do without writing;
  * preventive maintenance (the schedule's team must be the property's
    company), the schedule picker's teams, the tag sheet and the Construction
    company placement all read the field.

Throwaway sqlite file, no network.
Run with: python -m pytest test_property_company.py   (one file per process)
"""
import os
import tempfile
import unittest
from datetime import date, timedelta
from types import SimpleNamespace

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.pop("SUPABASE_URL", None)

from fastapi import HTTPException   # noqa: E402

import asset_company_fill as F       # noqa: E402
import auth                          # noqa: E402
import cache                         # noqa: E402
import construction_company          # noqa: E402
import database                      # noqa: E402
import models                        # noqa: E402
import property_links                # noqa: E402
from routers import maintenance as MW            # noqa: E402
from routers import property_assets as PA        # noqa: E402
from routers import property_tickets as P        # noqa: E402
from routers.task_util import gen_id             # noqa: E402

SUPER = {"email": "neil@greensglobal.com", "role": "owner", "level": 5}
ADMIN_A = {"email": "ann@greensglobal.com", "role": "administrator", "level": 4}     # walled to c1
ADMIN_NONE = {"email": "nobody@greensglobal.com", "role": "administrator", "level": 4}  # no company
EDITOR = {"email": "ed@greensglobal.com", "role": "employee", "level": 2}           # walls off -> unrestricted
MANAGER = "mia@greensglobal.com"


def changes(*rows, logs=()):
    return PA.Changes(properties=PA.RowOps(upsert=list(rows)), logs=PA.LogOps(append=list(logs)))


class PropertyCompanyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog,
                  models.PropertyWorkspaceMeta, models.HrEntity, models.HrDepartment, models.NexusEmployee,
                  models.NexusRole, models.NexusSetting, models.NexusGroup, models.NexusGroupMember,
                  models.NexusAccessScope, models.PropertyMaintenanceService, models.ConstructionProject):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.add(models.HrEntity(id="c1", name="Greens Storage", legal_name="Greens Storage LLC"))
        self.db.add(models.HrEntity(id="c2", name="Other Co"))
        self.db.add(models.HrEntity(id="c3", name="Twin"))
        self.db.add(models.HrEntity(id="c4", name="Elsewhere", legal_name="twin"))
        for email, company in ((SUPER["email"], "c1"), (ADMIN_A["email"], "c1"), (EDITOR["email"], "c1"),
                               (MANAGER, "c2"), (ADMIN_NONE["email"], "")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal", company=company))
        self.db.add(models.NexusRole(email=SUPER["email"], role="owner"))
        self.db.add(models.NexusRole(email=ADMIN_A["email"], role="administrator"))
        self.db.commit()
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # ── helpers ──
    def _asset(self, pid, rev="r0", **payload):
        payload = {"id": pid, "name": payload.pop("name", pid.title()), "kind": "property", **payload}
        self.db.add(models.PropertyAsset(id=pid, name=payload["name"], parent_id=payload.get("parentId", ""),
                                         payload=payload, updated_at=rev))
        self.db.commit()

    def _save(self, user, row, logs=(), rows=None, records=()):
        ch = changes(*(rows or [row]), logs=logs)
        ch.warranties = PA.RowOps(upsert=list(records))
        out = PA.post_changes(ch, db=self.db, user=user)
        self.db.expire_all()
        return out

    def _company(self, pid):
        self.db.expire_all()
        return (self.db.get(models.PropertyAsset, pid).payload or {}).get("companyId", "")

    def _refused(self, user, row):
        """The save answers 200 with the row in `refused` (per row, never the
        whole batch) - returned as (status_code, detail)."""
        out = PA.post_changes(changes(row), db=self.db, user=user)
        self.db.expire_all()
        got = [r for r in out["refused"] if r["id"] == row["id"]]
        self.assertEqual(len(got), 1, out)
        self.assertNotIn(row["id"], out["revs"])
        return SimpleNamespace(status_code=got[0]["status"], detail=got[0]["message"])

    # ── validation on the per-row save ──
    def test_an_unknown_company_is_refused(self):
        self._asset("gst")
        err = self._refused(SUPER, {"id": "gst", "name": "Gst", "companyId": "nope", "_rev": "r0"})
        self.assertEqual(err.status_code, 400)
        self.assertIn("not in Nexus", err.detail)
        self.assertEqual(self._company("gst"), "")

    def test_a_walled_administrator_assigns_only_their_own_companies(self):
        self._asset("gst")
        err = self._refused(ADMIN_A, {"id": "gst", "name": "Gst", "companyId": "c2", "_rev": "r0"})
        self.assertEqual(err.status_code, 403)
        self._save(ADMIN_A, {"id": "gst", "name": "Gst", "companyId": "c1", "_rev": "r0"})
        self.assertEqual(self._company("gst"), "c1")

    def test_an_administrator_with_no_company_assigns_none(self):
        self._asset("gst")
        self.assertEqual(self._refused(ADMIN_NONE, {"id": "gst", "name": "Gst", "companyId": "c1", "_rev": "r0"}).status_code, 403)

    def test_a_walled_administrator_cannot_take_or_clear_an_asset(self):
        self._asset("away", companyId="c2")
        self._asset("mine", companyId="c1")
        self.assertEqual(self._refused(ADMIN_A, {"id": "away", "name": "Away", "companyId": "c1", "_rev": "r0"}).status_code, 403)
        err = self._refused(ADMIN_A, {"id": "mine", "name": "Mine", "companyId": "", "_rev": "r0"})
        self.assertEqual(err.status_code, 403)
        self.assertIn("Super Administrator", err.detail)
        self.assertEqual((self._company("away"), self._company("mine")), ("c2", "c1"))

    def test_a_super_administrator_assigns_moves_and_clears(self):
        self._asset("gst", companyId="c1")
        out = self._save(SUPER, {"id": "gst", "name": "Gst", "companyId": "c2", "_rev": "r0"})
        self.assertEqual(self._company("gst"), "c2")
        self._save(SUPER, {"id": "gst", "name": "Gst", "companyId": "", "_rev": out["revs"]["gst"]})
        self.assertEqual(self._company("gst"), "")

    def test_an_unwalled_editor_assigns_any_company(self):
        """Levels 1-3 keep the walls switch's meaning: off = unrestricted."""
        self._asset("gst")
        self._save(EDITOR, {"id": "gst", "name": "Gst", "companyId": "c2", "_rev": "r0"})
        self.assertEqual(self._company("gst"), "c2")
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        try:
            rev = self.db.get(models.PropertyAsset, "gst").updated_at
            self.assertEqual(self._refused(EDITOR, {"id": "gst", "name": "Gst", "companyId": "c3", "_rev": rev}).status_code, 403)
        finally:
            cache.settings_config.invalidate()

    def test_an_unchanged_company_is_not_rechecked_and_a_missing_key_keeps_it(self):
        self._asset("away", companyId="c2")
        out = self._save(ADMIN_A, {"id": "away", "name": "Renamed", "companyId": "c2", "_rev": "r0"})
        self.assertEqual(self.db.get(models.PropertyAsset, "away").name, "Renamed")
        # A tab that never read the field: the row keeps its company.
        self._save(ADMIN_A, {"id": "away", "name": "Renamed Again", "_rev": out["revs"]["away"]})
        self.assertEqual(self._company("away"), "c2")

    def test_the_row_save_stamps_rev_and_keeps_the_log_entry(self):
        self._asset("gst")
        log = {"id": "lg1", "ts": "2026-11-03T10:00:00Z", "user": "Neil", "section": "Property", "propertyId": "gst",
               "action": "edited", "item": "Gst", "changes": [{"field": "Company", "from": "", "to": "Greens Storage"}]}
        out = self._save(SUPER, {"id": "gst", "name": "Gst", "companyId": "c1", "_rev": "r0"}, logs=[log])
        row = self.db.get(models.PropertyAsset, "gst")
        self.assertEqual(out["revs"]["gst"], row.updated_at)
        self.assertNotEqual(row.updated_at, "r0")
        self.assertEqual(self.db.get(models.PropertyActivityLog, "lg1").payload["changes"][0]["field"], "Company")
        # A stale copy is a conflict, never an overwrite - and its log entry is not kept.
        stale = {**log, "id": "lg2"}
        out2 = self._save(SUPER, {"id": "gst", "name": "Gst", "companyId": "c2", "_rev": "r0"}, logs=[stale])
        self.assertEqual(out2["conflicts"], ["gst"])
        self.assertEqual(self._company("gst"), "c1")
        self.assertIsNone(self.db.get(models.PropertyActivityLog, "lg2"))

    def test_a_new_asset_is_checked_like_a_change(self):
        self.assertEqual(self._refused(ADMIN_A, {"id": "new1", "name": "New", "companyId": "c2"}).status_code, 403)
        self._save(ADMIN_A, {"id": "new1", "name": "New", "companyId": "c1"})
        self.assertEqual(self._company("new1"), "c1")

    def test_the_picker_offers_what_the_caller_may_assign(self):
        self._asset("away", companyId="c2")
        got = {c["id"]: c["assignable"] for c in PA.assignable_companies(self.db, ADMIN_A)}
        self.assertEqual(got, {"c1": True, "c2": False})          # c2 named (an asset sits there), not offered
        self.assertFalse(PA.get_companies(db=self.db, user=ADMIN_A)["canClear"])
        full = PA.get_companies(db=self.db, user=SUPER)
        self.assertTrue(full["canClear"])
        self.assertTrue(all(c["assignable"] for c in full["companies"]))
        self.assertEqual(len(full["companies"]), 4)

    # ── the one reader ──
    def test_property_company_prefers_the_field_and_falls_back_while_blank(self):
        self._asset("set", entity="Greens Storage", companyId="c2")
        self._asset("blank", entity="greens storage llc")
        self._asset("twin", entity="Twin")                    # two companies answer to it
        self._asset("gone", entity="Other Co", companyId="deleted-co")
        get = lambda pid: property_links.property_company(self.db, self.db.get(models.PropertyAsset, pid))  # noqa: E731
        self.assertEqual((get("set"), get("blank"), get("twin"), get("gone")), ("c2", "c1", "", "c2"))

    # ── the one-time fill ──
    def _seed_fill(self):
        self._asset("ent", entity="Greens Storage")
        self._asset("lead", entity="Other Co")
        self._asset("parcel", parentId="lead")
        self._asset("mgr", contacts={"pm / asset manager": {"email": MANAGER}})
        self._asset("mgrparcel", parentId="mgr")          # its lead is only a manager guess too
        self._asset("twin", entity="Twin")
        self._asset("kept", entity="Greens Storage", companyId="c2")

    def test_the_dry_run_lists_and_writes_nothing(self):
        """Only strong answers are set; an asset-manager guess is listed for
        review, never written."""
        self._seed_fill()
        plan = F.dry_run(self.db)
        self.assertEqual({i["assetId"]: (i["companyId"], i["how"]) for i in plan["set"]},
                         {"ent": ("c1", "its Operating Entity"), "lead": ("c2", "its Operating Entity"),
                          "parcel": ("c2", "its lead property")})
        self.assertEqual({i["assetId"]: (i["companyId"], i["how"]) for i in plan["review"]},
                         {"mgr": ("c2", "its asset manager's company"),
                          "mgrparcel": ("c2", "its asset manager's company")})
        self.assertEqual([i["assetId"] for i in plan["blank"]], ["twin"])
        self.assertEqual(plan["kept"], 1)
        self.assertEqual(self._company("ent"), "")
        self.assertEqual(self.db.query(models.PropertyActivityLog).count(), 0)

    def test_the_fill_sets_strong_blanks_only_once_with_a_log_and_a_new_rev(self):
        self._seed_fill()
        self.assertEqual(F.fill(self.db), 3)
        self.db.expire_all()
        got = {p.id: (p.payload or {}).get("companyId", "") for p in self.db.query(models.PropertyAsset).all()}
        self.assertEqual(got, {"ent": "c1", "lead": "c2", "parcel": "c2", "mgr": "", "mgrparcel": "",
                               "twin": "", "kept": "c2"})
        self.assertEqual(self.db.get(models.PropertyAsset, "kept").updated_at, "r0")     # never touched
        self.assertEqual(self.db.get(models.PropertyAsset, "mgr").updated_at, "r0")      # a guess is never written
        self.assertNotEqual(self.db.get(models.PropertyAsset, "ent").updated_at, "r0")   # _rev bumped
        logs = {lg.property_id: lg.payload for lg in self.db.query(models.PropertyActivityLog).all()}
        self.assertEqual(set(logs), {"ent", "lead", "parcel"})
        self.assertEqual(logs["parcel"]["reason"], "Company set from its lead property")
        self.assertEqual(logs["ent"]["changes"], [{"field": "Company", "from": "", "to": "Greens Storage"}])
        self.assertGreater(self.db.get(models.PropertyWorkspaceMeta, 1).ts, 0)
        # The read still falls back to the guess while the field is blank.
        self.assertEqual(property_links.property_company(self.db, self.db.get(models.PropertyAsset, "mgr")), "c2")
        # Once: a later blank row is left for a person to set.
        self._asset("later", entity="Greens Storage")
        self.assertIsNone(F.fill(self.db))
        self.assertEqual(self._company("later"), "")

    def test_a_save_queued_before_the_fill_is_taken_and_keeps_the_company(self):
        """The deploy window: a tab queued an edit against the pre-fill rev.
        The fill is the only change since, so it is not a conflict - the edit
        lands and the filled company stays. Once anyone else saves the row,
        the old rev is an ordinary conflict again."""
        self._seed_fill()
        F.fill(self.db)
        out = self._save(EDITOR, {"id": "ent", "name": "Ent Renamed", "entity": "Greens Storage", "_rev": "r0"})
        self.assertEqual(out["conflicts"], [])
        row = self.db.get(models.PropertyAsset, "ent")
        self.assertEqual((row.name, (row.payload or {}).get("companyId")), ("Ent Renamed", "c1"))
        # An explicit blank from that tab is the pre-fill blank, not a clear.
        out = self._save(EDITOR, {"id": "lead", "name": "Lead", "entity": "Other Co", "companyId": "", "_rev": "r0"})
        self.assertEqual((out["conflicts"], self._company("lead")), ([], "c2"))
        # The row has moved on since: the pre-fill rev conflicts now.
        out = self._save(EDITOR, {"id": "ent", "name": "Old Tab", "entity": "Greens Storage", "_rev": "r0"})
        self.assertEqual(out["conflicts"], ["ent"])
        self.assertEqual(self.db.get(models.PropertyAsset, "ent").name, "Ent Renamed")
        # A row the fill never touched keeps the plain rule.
        out = self._save(EDITOR, {"id": "kept", "name": "Kept", "_rev": "stale"})
        self.assertEqual(out["conflicts"], ["kept"])

    def test_a_refused_row_does_not_drop_the_rest_of_the_batch(self):
        self._asset("mine")
        self._asset("away", companyId="c2")
        log_ok = {"id": "lg-ok", "propertyId": "mine", "action": "edited", "ts": "2026-11-03T10:00:00Z"}
        log_no = {"id": "lg-no", "propertyId": "away", "action": "edited", "ts": "2026-11-03T10:00:00Z"}
        out = self._save(ADMIN_A, None, rows=[
            {"id": "mine", "name": "Mine", "companyId": "c1", "_rev": "r0"},
            {"id": "away", "name": "Away", "companyId": "c1", "_rev": "r0"},
            {"id": "fresh", "name": "Fresh", "companyId": "c2"}], logs=[log_ok, log_no],
            records=[{"id": "w1", "propertyId": "fresh", "scope": "Roof"}])
        self.assertEqual({r["id"]: r["status"] for r in out["refused"]}, {"away": 403, "fresh": 403, "w1": 409})
        self.assertEqual((self._company("mine"), self._company("away")), ("c1", "c2"))
        self.assertIsNone(self.db.get(models.PropertyAsset, "fresh"))
        self.assertIsNone(self.db.get(models.PropertyRecord, "w1"))
        self.assertIsNotNone(self.db.get(models.PropertyActivityLog, "lg-ok"))
        self.assertIsNone(self.db.get(models.PropertyActivityLog, "lg-no"))   # the change it describes did not land

    def test_the_fill_runs_on_the_deployed_api_or_a_local_sqlite_only(self):
        saved = {k: os.environ.pop(k, None) for k in ("WEBSITE_SITE_NAME", "NEXUS_BACKGROUND_WORKER", "NEXUS_ASANA_SYNC_WORKER")}
        try:
            self.assertTrue(F.should_run("sqlite:///local.db"))
            self.assertFalse(F.should_run("postgresql://shared-dev"))
            os.environ["WEBSITE_SITE_NAME"] = "greens-nexus-api"
            self.assertTrue(F.should_run("postgresql://shared-dev"))
        finally:
            os.environ.pop("WEBSITE_SITE_NAME", None)
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    # ── the readers that used to infer ──
    def test_preventive_maintenance_reads_the_field(self):
        """The schedule's team must be the property's company - the FIELD's,
        not the manager's (c2) or the entity's (c1)."""
        self.db.add(models.HrDepartment(id="d1", company_id="c1", name="Construction & Maintenance"))
        self.db.add(models.HrDepartment(id="d3", company_id="c3", name="Construction & Maintenance"))
        self._asset("gst", entity="Greens Storage", companyId="c3",
                    contacts={"pm / asset manager": {"email": MANAGER}})
        body = dict(kind="calendar", subject="HVAC Filter Change", application="HVAC",
                    next_due=(date.today() + timedelta(days=5)).isoformat(), recurrence_unit="month",
                    recurrence_every=1)
        with self.assertRaises(HTTPException) as cm:
            P.create_schedule("gst", P.ScheduleBody(hr_department_id="d1", **body), user=SUPER, db=self.db)
        self.assertIn("company this property belongs to", cm.exception.detail)
        self.db.rollback()
        opts = P.schedule_options("gst", user=SUPER, db=self.db)
        self.assertEqual(opts["property"]["companyId"], "c3")
        self.assertTrue(all(d["companyId"] in ("c3", "") for d in opts["departments"]))

    def test_the_tag_sheet_names_the_property_company(self):
        self._asset("gst", companyId="c2")
        out = MW.place_tags(MW.TagsBody(property_id="gst"), user=SUPER, db=self.db)
        self.assertEqual(out["tags"][0]["companyName"], "Other Co")

    def test_construction_places_a_job_by_the_field(self):
        self._asset("gst", entity="Greens Storage", companyId="c2")
        self.assertEqual(construction_company.company_from_property(self.db, "gst"), "c2")
        self.db.add(models.ConstructionProject(
            id="job1", name="Old Job", company_id="", property_id="gst", status="active", archived=False,
            deleted_at="", manager_emails=[], worker_emails=[], executive_emails=[], created_by=ADMIN_A["email"],
            created_at="2026-11-01T00:00:00Z", modified_at="2026-11-01T00:00:00Z"))
        self.db.commit()
        plan = construction_company.dry_run(self.db)
        self.assertEqual([(i["projectId"], i["companyId"], i["source"]) for i in plan["place"]],
                         [("job1", "c2", "property")])


if __name__ == "__main__":
    unittest.main()
