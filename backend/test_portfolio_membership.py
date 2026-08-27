"""Portfolio membership is stored on both sides - TaskProject.portfolio_id and
TaskPortfolio.project_ids - and has to agree whichever screen you edit from.

Editing a PORTFOLIO already kept both in step; editing a PROJECT set only its
own column, so picking a portfolio from the project form saved and then showed
nothing on the Portfolios screen (Sagar, Aug 27).

Run with: python -m unittest test_portfolio_membership
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar.shoundik@greensglobal.com"

from fastapi.testclient import TestClient
import auth
import database
import models
import main

ME = (os.environ.get("NEXUS_DEV_EMAIL") or "").strip().lower()
c = TestClient(main.app)


def _seed():
    models.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    try:
        if not db.query(models.NexusRole).filter(models.NexusRole.email == ME).first():
            db.add(models.NexusRole(email=ME, role="administrator", assigned_by="test"))
            db.commit()
    finally:
        db.close()
    getattr(auth, "_role_cache", {}).clear()


def mk_portfolio(name, project_ids=None):
    r = c.post("/task-portfolios", json={"name": name, "project_ids": project_ids or []})
    assert r.status_code in (200, 201), r.text
    return r.json()


def mk_project(name, **body):
    r = c.post("/task-projects", json={"name": name, **body})
    assert r.status_code in (200, 201), r.text
    return r.json()


def portfolio(pid):
    return next(p for p in c.get("/task-portfolios").json() if p["id"] == pid)


def project(pid):
    return next(p for p in c.get("/task-projects").json() if p["id"] == pid)


class PortfolioMembershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _seed()
        if not ME or c.get("/task-portfolios").status_code >= 400:
            raise unittest.SkipTest(
                "needs this module's own dev-auth env; run: python -m unittest test_portfolio_membership")

    def test_setting_a_portfolio_from_the_project_form_maps_it(self):
        pf = mk_portfolio("Q3 Growth")
        pr = mk_project("Website")
        c.patch(f"/task-projects/{pr['id']}", json={"portfolio_id": pf["id"]})
        self.assertIn(pr["id"], portfolio(pf["id"])["projectIds"])
        self.assertEqual(project(pr["id"])["portfolioId"], pf["id"])

    def test_creating_a_project_inside_a_portfolio_maps_it(self):
        pf = mk_portfolio("New Build")
        pr = mk_project("Fresh", portfolio_id=pf["id"])
        self.assertIn(pr["id"], portfolio(pf["id"])["projectIds"])

    def test_clearing_the_portfolio_removes_it_from_the_list(self):
        pf = mk_portfolio("Temporary")
        pr = mk_project("Movable", portfolio_id=pf["id"])
        c.patch(f"/task-projects/{pr['id']}", json={"portfolio_id": ""})
        self.assertNotIn(pr["id"], portfolio(pf["id"])["projectIds"])
        # project_to_dict runs portfolio_id through _nz, so "no portfolio" comes
        # back as null rather than an empty string.
        self.assertFalse(project(pr["id"])["portfolioId"])

    def test_moving_between_portfolios_leaves_only_one_holding_it(self):
        a = mk_portfolio("From")
        b = mk_portfolio("To")
        pr = mk_project("Mover", portfolio_id=a["id"])
        c.patch(f"/task-projects/{pr['id']}", json={"portfolio_id": b["id"]})
        self.assertNotIn(pr["id"], portfolio(a["id"])["projectIds"])
        self.assertIn(pr["id"], portfolio(b["id"])["projectIds"])

    def test_the_portfolio_side_still_works(self):
        # The direction that already worked must keep working.
        pf = mk_portfolio("From Portfolio")
        pr = mk_project("Added There")
        c.patch(f"/task-portfolios/{pf['id']}", json={"name": "From Portfolio",
                                                      "project_ids": [pr["id"]]})
        self.assertEqual(project(pr["id"])["portfolioId"], pf["id"])

    def test_an_unrelated_edit_does_not_change_membership_or_order(self):
        pf = mk_portfolio("Ordered")
        one = mk_project("One", portfolio_id=pf["id"])
        two = mk_project("Two", portfolio_id=pf["id"])
        before = portfolio(pf["id"])["projectIds"]
        c.patch(f"/task-projects/{one['id']}", json={"description": "renamed"})
        self.assertEqual(portfolio(pf["id"])["projectIds"], before)
        self.assertEqual(before, [one["id"], two["id"]])

    def test_re_saving_the_same_portfolio_keeps_the_project_in_place(self):
        # A save that does not change membership must not shuffle the project
        # to the end of somebody's carefully ordered portfolio.
        pf = mk_portfolio("Stable")
        one = mk_project("First", portfolio_id=pf["id"])
        two = mk_project("Second", portfolio_id=pf["id"])
        c.patch(f"/task-projects/{one['id']}", json={"portfolio_id": pf["id"]})
        self.assertEqual(portfolio(pf["id"])["projectIds"], [one["id"], two["id"]])

class StaleMembershipTests(unittest.TestCase):
    """Rows that drifted BEFORE the two-way write existed - linked by an older
    backend, by the Asana sync, or by hand. The Projects screen badged three
    projects while the Portfolios screen listed one (Sagar, Aug 27), so the read
    has to reconcile rather than trust the portfolio's own list.
    """

    @classmethod
    def setUpClass(cls):
        _seed()
        if not ME or c.get("/task-portfolios").status_code >= 400:
            raise unittest.SkipTest(
                "needs this module's own dev-auth env; run: python -m unittest test_portfolio_membership")

    @staticmethod
    def _write_stale_list(portfolio_id, project_ids):
        """Put the portfolio's stored list back the way an older build left it,
        without going through the endpoint that would fix it."""
        db = database.SessionLocal()
        try:
            pf = db.query(models.TaskPortfolio).filter(models.TaskPortfolio.id == portfolio_id).first()
            pf.project_ids = list(project_ids)
            db.commit()
        finally:
            db.close()

    def test_a_project_pointing_here_shows_even_when_the_list_missed_it(self):
        pf = mk_portfolio("Q3 Growth Initiatives")
        one = mk_project("Website Relaunch", portfolio_id=pf["id"])
        two = mk_project("Test Project", portfolio_id=pf["id"])
        three = mk_project("Handover - Arnav Kapoor", portfolio_id=pf["id"])
        self._write_stale_list(pf["id"], [one["id"]])          # what the old build stored
        ids = portfolio(pf["id"])["projectIds"]
        self.assertEqual(set(ids), {one["id"], two["id"], three["id"]})
        self.assertEqual(ids[0], one["id"])                     # curated order still leads

    def test_a_project_moved_elsewhere_does_not_linger(self):
        a = mk_portfolio("Old Home")
        b = mk_portfolio("New Home")
        pr = mk_project("Mover", portfolio_id=b["id"])
        self._write_stale_list(a["id"], [pr["id"]])             # a's list never heard about the move
        self.assertNotIn(pr["id"], portfolio(a["id"])["projectIds"])
        self.assertIn(pr["id"], portfolio(b["id"])["projectIds"])

    def test_a_member_that_points_nowhere_is_kept(self):
        # Portfolios built before portfolio_id was written have members that
        # point at nothing. Reading must not quietly drop them.
        pf = mk_portfolio("Legacy")
        pr = mk_project("Untagged")
        self._write_stale_list(pf["id"], [pr["id"]])
        self.assertIn(pr["id"], portfolio(pf["id"])["projectIds"])

    def test_a_deleted_project_falls_out_of_the_list(self):
        pf = mk_portfolio("With A Ghost")
        pr = mk_project("Doomed", portfolio_id=pf["id"])
        self._write_stale_list(pf["id"], [pr["id"], "no-such-project"])
        self.assertEqual(portfolio(pf["id"])["projectIds"], [pr["id"]])

    def test_creating_a_portfolio_with_projects_badges_those_projects(self):
        # The mirror of the reported bug: built in one go from the portfolio
        # side, the Projects list showed no portfolio on any of them.
        one = mk_project("Picked One")
        two = mk_project("Picked Two")
        pf = mk_portfolio("Built In One Go", project_ids=[one["id"], two["id"]])
        self.assertEqual(project(one["id"])["portfolioId"], pf["id"])
        self.assertEqual(project(two["id"])["portfolioId"], pf["id"])
        self.assertEqual(portfolio(pf["id"])["projectIds"], [one["id"], two["id"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
