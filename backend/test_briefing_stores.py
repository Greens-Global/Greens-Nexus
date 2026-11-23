"""Stores in the Daily Briefing (Neil, 11/20/2026) - as tests.

The wording of a store's line (occupancy, the change on last week, vacant,
past due, leads waiting), who is sent the lines (Administrators and Operations
grant holders - not a supervisor by tier), which stores (the facility access
rules; a store Cubby no longer lists and a store with a stale snapshot are
left out), the block in the email (plain lines, never counted in the summary)
and My Briefing's payload. Its own throwaway database.

    python -m pytest test_briefing_stores.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import briefing_stores                 # noqa: E402
import cache                           # noqa: E402
import daily_briefing                  # noqa: E402
import database                        # noqa: E402
import models                          # noqa: E402

ADMIN = "admin.stores.test@greensglobal.com"
GRANTED = "ops.stores.test@greensglobal.com"        # employee tier, Operations viewer grant
NARROW = "one.stores.test@greensglobal.com"         # Operations grant, a rule naming one store
SUPER = "super.stores.test@greensglobal.com"        # supervisor by tier, no grant
TODAY = "2026-11-20"


def _snap(fid, day, total, rented, vacant, due=0, tenants=0):
    return models.CubbyDailySnapshot(id=f"{fid}:{day}", facility_id=fid, snapshot_date=day, units_total=total, units_rented=rented,
                                     units_vacant=vacant, past_due_cents=due, past_due_tenants=tenants)


class LineWording(unittest.TestCase):
    def test_the_whole_line(self):
        latest = {"units_total": 807, "units_rented": 779, "units_vacant": 18, "past_due_cents": 785300, "past_due_tenants": 22}
        prior = {"units_total": 807, "units_rented": 776, "units_vacant": 21}
        self.assertEqual(briefing_stores.line_for("Oak Street", latest, prior, 2), {
            "name": "Oak Street",
            "text": "96.5% occupied, up 0.3 points on last week. 18 vacant, $7,853 past due from 22 tenants, 2 leads waiting more than a week."})

    def test_down_level_and_one_point(self):
        base = {"units_total": 200, "units_vacant": 10, "past_due_cents": 0, "past_due_tenants": 0}
        self.assertEqual(briefing_stores.line_for("A", {**base, "units_rented": 150}, {**base, "units_rented": 152})["text"],
                         "75% occupied, down 1 point on last week. 10 vacant, nothing past due.")
        self.assertEqual(briefing_stores.line_for("A", {**base, "units_rented": 150}, {**base, "units_rented": 150})["text"],
                         "75% occupied, level with last week. 10 vacant, nothing past due.")

    def test_no_last_week_one_tenant_one_lead(self):
        latest = {"units_total": 100, "units_rented": 70, "units_vacant": 30, "past_due_cents": 12050, "past_due_tenants": 1}
        self.assertEqual(briefing_stores.line_for("A", latest, None, 1)["text"],
                         "70% occupied. 30 vacant, $120 past due from 1 tenant, 1 lead waiting more than a week.")

    def test_a_store_with_no_units_on_file_never_divides(self):
        self.assertEqual(briefing_stores.line_for("A", {"units_total": 0, "units_rented": 0, "units_vacant": 0})["text"],
                         "No storage units on file. 0 vacant, nothing past due.")


class WhoAndWhich(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.CubbyDailySnapshot, models.CubbyLead, models.CubbyFacility, models.OpsAccessRule,
                  models.NexusGroupMember, models.NexusGroup, models.NexusRole):
            self.db.query(m).delete()
        db = self.db
        db.add(models.NexusRole(email=ADMIN, role="administrator"))
        db.add(models.NexusRole(email=SUPER, role="supervisor"))
        db.add(models.NexusRole(email=GRANTED, role="employee"))
        db.add(models.NexusRole(email=NARROW, role="employee"))
        db.add(models.NexusGroup(id="grp-stores-test", name="Stores", allowed_modules="operations:viewer"))
        for em in (GRANTED, NARROW):
            db.add(models.NexusGroupMember(group_id="grp-stores-test", email=em))
        db.add(models.OpsAccessRule(id="r-narrow", subject_type="person", subject_id=NARROW, facility_ids=["f-oak"], tenant_details=False))
        db.add(models.CubbyFacility(facility_id="f-oak", name="Oak Street", enabled=True))
        db.add(models.CubbyFacility(facility_id="f-canyon", name="Canyon Road", enabled=True))
        db.add(models.CubbyFacility(facility_id="f-stale", name="Stale Store", enabled=True))
        db.add(models.CubbyFacility(facility_id="f-gone", name="Gone Store", enabled=False))
        db.add(_snap("f-oak", "2026-11-20", 800, 772, 18, 785300, 22))
        db.add(_snap("f-oak", "2026-11-13", 800, 768, 22))
        db.add(_snap("f-canyon", "2026-11-19", 500, 350, 104))          # yesterday's is recent enough
        db.add(_snap("f-canyon", "2026-11-10", 500, 355, 99))           # the day a week before is missing: the nearest older one
        db.add(_snap("f-stale", "2026-11-12", 100, 90, 10))             # eight days old: left out
        db.add(_snap("f-gone", "2026-11-20", 100, 90, 10))
        db.add(models.CubbyLead(id="f-canyon:1", facility_id="f-canyon", lead_id="1", status="NEW", created_at="2026-11-01T10:00:00Z"))
        db.add(models.CubbyLead(id="f-canyon:2", facility_id="f-canyon", lead_id="2", status="NEW", created_at="2026-11-18T10:00:00Z"))    # two days: not waiting yet
        db.add(models.CubbyLead(id="f-canyon:3", facility_id="f-canyon", lead_id="3", status="CONVERTED", created_at="2026-10-01T10:00:00Z"))
        db.commit()
        cache.module_grants.invalidate()

    def tearDown(self):
        self.db.close()

    def test_an_administrator_reads_every_live_store_by_name(self):
        self.assertEqual(briefing_stores.lines(self.db, ADMIN, TODAY), [
            {"name": "Canyon Road", "text": "70% occupied, down 1 point on last week. 104 vacant, nothing past due, 1 lead waiting more than a week."},
            {"name": "Oak Street", "text": "96.5% occupied, up 0.5 points on last week. 18 vacant, $7,853 past due from 22 tenants."},
        ])

    def test_an_operations_grant_holder_is_sent_them_and_a_supervisor_by_tier_is_not(self):
        self.assertEqual([x["name"] for x in briefing_stores.lines(self.db, GRANTED, TODAY)], ["Canyon Road", "Oak Street"])
        self.assertEqual(briefing_stores.lines(self.db, SUPER, TODAY), [])
        self.assertEqual(briefing_stores.lines(self.db, "nobody.stores.test@greensglobal.com", TODAY), [])

    def test_a_facility_rule_narrows_the_stores(self):
        self.assertEqual([x["name"] for x in briefing_stores.lines(self.db, NARROW, TODAY)], ["Oak Street"])

    def test_my_briefing_carries_them(self):
        noon = datetime(2026, 11, 20, 12, 0)
        with mock.patch.object(daily_briefing, "_recipient_local_now", lambda db, email: noon):
            self.assertEqual([x["name"] for x in daily_briefing.my_briefing(self.db, ADMIN)["stores"]], ["Canyon Road", "Oak Street"])
            self.assertEqual(daily_briefing.my_briefing(self.db, SUPER)["stores"], [])

    def test_a_failed_read_costs_the_lines_never_the_page(self):
        with mock.patch.object(briefing_stores, "lines", side_effect=RuntimeError("boom")):
            self.assertEqual(daily_briefing._page_stores(self.db, ADMIN, TODAY), [])


class EmailBlock(unittest.TestCase):
    SECTIONS = {"needs_to_know": [{"title": "Door repair", "detail": "Updated", "url": "https://n/tasks", "module": "tasks"}]}
    STORES = [{"name": "Oak Street", "text": "96.5% occupied. 18 vacant, $7,853 past due from 22 tenants."},
              {"name": "Canyon <Road>", "text": "70% occupied. 104 vacant, nothing past due."}]

    def test_plain_lines_under_one_heading_and_never_counted(self):
        subject, html = daily_briefing.render_email("Amy", TODAY, dict(self.SECTIONS), "Good morning", stores=self.STORES)
        self.assertIn(">Stores</div>", html)
        self.assertIn("Oak Street:</span> 96.5% occupied. 18 vacant, $7,853 past due from 22 tenants.", html)
        self.assertIn("Canyon &lt;Road&gt;:</span>", html)             # a store's name is text, never markup
        self.assertIn("/operations'", html)
        self.assertIn(">1</span> update", html)                        # the summary counts the update, not the stores
        self.assertNotIn("stores", subject.lower())
        self.assertLess(html.index(">Updates for You"), html.index(">Stores</div>"))

    def test_no_stores_no_block(self):
        for stores in (None, []):
            _, html = daily_briefing.render_email("Amy", TODAY, dict(self.SECTIONS), "Good morning", stores=stores)
            self.assertNotIn(">Stores</div>", html)


if __name__ == "__main__":
    unittest.main()
