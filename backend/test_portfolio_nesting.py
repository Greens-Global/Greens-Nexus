"""Sub-portfolios: a portfolio inside a portfolio (Sept 2026).

Nesting is one column, parent_id, and the tree is walked from it. What is worth
pinning is the two things that column makes possible and neither the model nor
the UI can defend against on its own: a cycle (a portfolio that is its own
ancestor hangs every walk of the tree), and what a delete does to the groups
inside the one being deleted.

Run with: python -m unittest test_portfolio_nesting -v
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
from routers.task_projects import (
    PortfolioBody, create_portfolio, update_portfolio, delete_portfolio,
    portfolio_descendants, _portfolio_parents, _would_cycle,
)

ACTOR = {"email": "actor@greensglobal.com", "level": 1}

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


class NestingTests(unittest.TestCase):
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
        # Nexus > Nexus Modules > Dashboard, the shape from the screenshot.
        self.root = self._pf("Nexus")
        self.mid = self._pf("Nexus Modules", self.root.id)
        self.leaf = self._pf("Dashboard", self.mid.id)

    def tearDown(self):
        self.db.close()

    def _pf(self, name, parent=""):
        p = models.TaskPortfolio(id=gen_id(), name=name, parent_id=parent, project_ids=[],
                                 created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        return p

    def _patch(self, pf, **fields):
        return update_portfolio(pf.id, PortfolioBody(**fields), db=self.db)

    # ── the tree ──────────────────────────────────────────────────────────
    def test_descendants_reach_every_depth_not_just_children(self):
        got = portfolio_descendants(_portfolio_parents(self.db), self.root.id)
        self.assertEqual(set(got), {self.mid.id, self.leaf.id})

    def test_a_leaf_has_no_descendants(self):
        self.assertEqual(portfolio_descendants(_portfolio_parents(self.db), self.leaf.id), [])

    def test_parent_id_is_serialized_for_the_client(self):
        self.assertEqual(self._patch(self.leaf, name="Dashboard")["parentId"], self.mid.id)

    # ── cycles ────────────────────────────────────────────────────────────
    def test_a_portfolio_cannot_be_its_own_parent(self):
        with self.assertRaises(HTTPException) as e:
            self._patch(self.root, parent_id=self.root.id)
        self.assertEqual(e.exception.status_code, 400)

    def test_a_portfolio_cannot_move_inside_its_own_descendant(self):
        # Nexus under Dashboard would close the loop two levels down.
        with self.assertRaises(HTTPException) as e:
            self._patch(self.root, parent_id=self.leaf.id)
        self.assertEqual(e.exception.status_code, 400)
        self.db.refresh(self.root)
        self.assertEqual(self.root.parent_id, "")

    def test_a_legal_move_still_goes_through(self):
        self._patch(self.leaf, parent_id=self.root.id)   # promote one level
        self.db.refresh(self.leaf)
        self.assertEqual(self.leaf.parent_id, self.root.id)

    def test_clearing_the_parent_returns_it_to_the_top_level(self):
        self._patch(self.leaf, parent_id="")
        self.db.refresh(self.leaf)
        self.assertEqual(self.leaf.parent_id, "")

    def test_an_unknown_parent_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            self._patch(self.leaf, parent_id="nope")
        self.assertEqual(e.exception.status_code, 404)

    def test_the_guard_terminates_on_an_already_cyclic_table(self):
        # Written by an older backend or by hand: a <-> b. The walk must stop.
        a, b = self._pf("A"), self._pf("B")
        a.parent_id, b.parent_id = b.id, a.id
        self.db.commit()
        self.assertTrue(_would_cycle(_portfolio_parents(self.db), a.id, b.id))
        self.assertEqual(portfolio_descendants(_portfolio_parents(self.db), a.id), [b.id])

    # ── create + delete ───────────────────────────────────────────────────
    def test_a_sub_portfolio_can_be_created_directly_under_a_parent(self):
        row = create_portfolio(PortfolioBody(name="Time Clock", parent_id=self.mid.id),
                               user=ACTOR, db=self.db)
        self.assertEqual(row["parentId"], self.mid.id)

    def test_creating_under_a_missing_parent_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            create_portfolio(PortfolioBody(name="Orphan", parent_id="nope"), user=ACTOR, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_binning_a_parent_LEAVES_the_tree_intact_for_restore(self):
        # Child-lifting moved to the purge (Sept 2026, Recycle Bin). While a
        # parent is only BINNED its children must keep pointing at it, or
        # restoring it would hand back a portfolio with nothing under it.
        # A binned parent reads as absent, so the children surface at the top
        # level meanwhile - see portfolioRowTree's lift-orphans pass.
        delete_portfolio(self.mid.id, user=ACTOR, db=self.db)
        self.db.refresh(self.leaf)
        self.assertEqual(self.leaf.parent_id, self.mid.id)

    def test_a_binned_parent_is_hidden_from_ordinary_reads(self):
        delete_portfolio(self.root.id, user=ACTOR, db=self.db)
        live = {p.name for p in self.db.query(models.TaskPortfolio).all()}
        self.assertNotIn("Nexus", live)
        self.assertIn("Nexus Modules", live)   # the child is untouched


if __name__ == "__main__":
    unittest.main()
