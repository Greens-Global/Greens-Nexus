"""Batch-moving projects between portfolios (Sept 2026).

Portfolio membership is stored on BOTH sides - TaskProject.portfolio_id and
TaskPortfolio.project_ids - and portfolio_project_ids() exists because those two
have drifted before, showing one project on the Portfolios screen and three on
Projects. A move is therefore a remove AND an add that must not be separable,
which is why it is one endpoint in one transaction rather than a PATCH per
project from the client.

Run with: python -m unittest test_portfolio_move -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers.task_util import gen_id, now_iso
from routers.task_projects import move_projects_between_portfolios, MoveProjectsBody

# A test that DELETES rows must prove its own isolation before it deletes any.
#
# unittest runs every module named on one command line in ONE process, so
# `import database` happens once: whichever module is imported FIRST fixes
# DATABASE_URL for all of them, and the assignment above is a dead letter for
# the rest. Run after a module that does not set it (test_app_boot does not),
# and these setUp() deletes land in the developer's real local greens_nexus.db.
# That is not hypothetical - it happened on 2026-09-07 and took the local task,
# project and portfolio rows with it. So the binding is checked, not assumed.
def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()


class MoveProjectsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskProject, models.TaskPortfolio):
            self.db.query(m).delete()
        self.db.commit()
        self.a = self._portfolio("Accounting")
        self.b = self._portfolio("IT Development")
        self.p1 = self._project("#General - Accounting", self.a.id)
        self.p2 = self._project("#Taxes - Accounting", self.a.id)
        self.loose = self._project("Greens Storage Website", "")
        self.a.project_ids = [self.p1.id, self.p2.id]
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _portfolio(self, name):
        p = models.TaskPortfolio(id=gen_id(), name=name, project_ids=[],
                                 created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        return p

    def _project(self, name, portfolio_id):
        p = models.TaskProject(id=gen_id(), name=name, portfolio_id=portfolio_id,
                               created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        return p

    def _move(self, projects, dest):
        return move_projects_between_portfolios(
            MoveProjectsBody(project_ids=[p.id for p in projects], portfolio_id=dest), db=self.db)

    def _refresh(self):
        for row in (self.a, self.b, self.p1, self.p2, self.loose):
            self.db.refresh(row)

    # ── both sides, always ────────────────────────────────────────────────
    def test_a_move_rewrites_the_project_and_both_portfolios(self):
        self._move([self.p1], self.b.id)
        self._refresh()
        self.assertEqual(self.p1.portfolio_id, self.b.id)
        self.assertEqual(self.a.project_ids, [self.p2.id])   # left the source's list
        self.assertEqual(self.b.project_ids, [self.p1.id])   # and joined the destination's

    def test_a_batch_spanning_two_sources_lands_together(self):
        self._move([self.p1, self.loose], self.b.id)
        self._refresh()
        self.assertEqual(self.b.project_ids, [self.p1.id, self.loose.id])
        self.assertEqual(self.a.project_ids, [self.p2.id])

    def test_moving_out_of_every_portfolio(self):
        self._move([self.p1, self.p2], "")
        self._refresh()
        self.assertEqual(self.p1.portfolio_id, "")
        self.assertEqual(self.a.project_ids, [])

    def test_arriving_projects_go_to_the_end_of_a_curated_order(self):
        self.b.project_ids = ["already-there"]
        self.db.commit()
        self._move([self.p1], self.b.id)
        self._refresh()
        self.assertEqual(self.b.project_ids, ["already-there", self.p1.id])

    def test_a_project_already_in_the_destination_is_left_alone(self):
        r = self._move([self.p1], self.a.id)
        self._refresh()
        self.assertEqual(r["moved"], 0)
        self.assertEqual(self.a.project_ids, [self.p1.id, self.p2.id])   # order untouched

    def test_a_project_listed_twice_moves_once(self):
        r = move_projects_between_portfolios(
            MoveProjectsBody(project_ids=[self.p1.id, self.p1.id], portfolio_id=self.b.id), db=self.db)
        self._refresh()
        self.assertEqual(r["moved"], 1)
        self.assertEqual(self.b.project_ids, [self.p1.id])

    # ── refusals ──────────────────────────────────────────────────────────
    def test_an_empty_selection_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            move_projects_between_portfolios(MoveProjectsBody(project_ids=[], portfolio_id=self.b.id), db=self.db)
        self.assertEqual(e.exception.status_code, 422)

    def test_an_unknown_destination_is_refused_before_anything_moves(self):
        with self.assertRaises(HTTPException) as e:
            move_projects_between_portfolios(
                MoveProjectsBody(project_ids=[self.p1.id], portfolio_id="nope"), db=self.db)
        self.assertEqual(e.exception.status_code, 404)
        self._refresh()
        self.assertEqual(self.p1.portfolio_id, self.a.id)

    def test_every_portfolio_comes_back_not_just_the_two_touched(self):
        # The client replaces its whole list from this: a move rewrites the
        # source as well as the destination, and refreshing one leaves the other
        # showing a project it no longer holds.
        r = self._move([self.p1], self.b.id)
        self.assertEqual({p["name"] for p in r["portfolios"]}, {"Accounting", "IT Development"})


if __name__ == "__main__":
    unittest.main()
