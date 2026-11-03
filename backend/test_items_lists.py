"""Items lists, the change probe and the Recycle Bin (Nov 2026, M5 / M6).

  * GET /items/checkouts and /items/assignments return EVERY live row and
    cap only the finished history (a flat cap used to drop live rows once
    the tables grew - an item someone held vanished from the lists);
  * GET /items/signature no longer serializes and hashes both whole tables
    on every poll: it is a count + xmin aggregate on Postgres (empty on
    SQLite, where the client always refetches);
  * GET /items/deleted is a read - it never deletes. Deleting forever is the
    explicit POST /items/recycle-bin/delete-expired, which keeps any item
    with checkout or assignment history and stays inside the company wall.

    python -m pytest test_items_lists.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import inspect
import unittest

import models
from routers import items

U = kit.user


class ListCapTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_live_checkouts_are_never_capped(self):
        for n in range(6):
            kit.add_item(self.db, f"it-{n}")
            # The live ones are the OLDEST - a newest-first cap dropped exactly them.
            status = "allocated" if n < 3 else "returned"
            kit.add_checkout(self.db, f"co-{n}", f"it-{n}", status, created_at=f"2026-10-0{n + 1}T10:00:00+00:00")
        out = items.list_checkouts(history_limit=2, user=U(kit.MGR_A), db=self.db)
        ids = [c["id"] for c in out]
        self.assertEqual(set(ids), {"co-0", "co-1", "co-2", "co-5", "co-4"})
        self.assertEqual(ids, sorted(ids, key=lambda i: next(c["createdAt"] for c in out if c["id"] == i), reverse=True))

    def test_live_assignments_are_never_capped(self):
        for n in range(5):
            kit.add_item(self.db, f"ip-{n}", ownership="permanent")
            status = "active" if n < 2 else "closed"
            kit.add_assignment(self.db, f"as-{n}", f"ip-{n}", status, created_at=f"2026-10-0{n + 1}T10:00:00+00:00")
        ids = {a["id"] for a in items.list_assignments(history_limit=1, user=U(kit.MGR_A), db=self.db)}
        self.assertEqual(ids, {"as-0", "as-1", "as-4"})

    def test_an_employee_still_sees_only_their_own(self):
        kit.add_item(self.db, "it-x")
        kit.add_checkout(self.db, "co-mine", "it-x", "returned")
        kit.add_checkout(self.db, "co-theirs", "it-x", "returned", requester=kit.EMP_A2)
        ids = {c["id"] for c in items.list_checkouts(user=U(kit.EMP_A), db=self.db)}
        self.assertEqual(ids, {"co-mine"})


class SignatureTests(unittest.TestCase):
    def test_the_probe_never_serializes_the_tables(self):
        src = inspect.getsource(items.items_signature)
        self.assertNotIn("string_agg", src)
        self.assertNotIn("md5(", src)
        self.assertIn("xmin", src)
        db = kit.fresh()
        try:
            self.assertEqual(items.items_signature(db=db), {"items": "", "checkouts": ""})   # SQLite: always refetch
        finally:
            db.close()


class RecycleBinTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        old = "2026-01-01T10:00:00+00:00"
        kit.add_item(self.db, "gone-1", deleted_at=old)
        kit.add_item(self.db, "gone-hist", deleted_at=old)
        kit.add_item(self.db, "gone-b", kit.COB, deleted_at=old)
        kit.add_item(self.db, "recent", deleted_at="2099-01-01T10:00:00+00:00")
        kit.add_checkout(self.db, "co-h", "gone-hist", "returned")

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_opening_the_bin_deletes_nothing(self):
        items.list_deleted_items(user=U(kit.OWNER), db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.Item).count(), 4)

    def test_deleting_forever_is_explicit_keeps_history_and_stays_inside_the_wall(self):
        with kit.walls():
            boss = U(kit.OWNER) | {"level": 4}          # an Administrator of company A: walled
            out = items.delete_expired_forever(user=boss, db=self.db)
        self.assertEqual(out, {"deleted": 1, "kept": 1})
        self.db.expire_all()
        left = {i.id for i in self.db.query(models.Item).all()}
        self.assertEqual(left, {"gone-hist", "gone-b", "recent"})


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
