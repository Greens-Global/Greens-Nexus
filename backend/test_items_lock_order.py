"""Checkout PATCH lock order (Nov 2026, H5).

"Approve All" fires one PATCH per item of an order in parallel. Each used to
lock ITS OWN row first and then the whole order, so two of them could each
hold one row and wait on the other's - a deadlock Postgres broke by failing
one Approve. Now an order's rows are locked together, in id order (behind
the same advisory lock create_checkout takes on the order id), before
anything else is read; a solo checkout locks its own row. SQLite has no row
locks, so this pins the ORDER of the reads the locks ride on.

    python -m pytest test_items_lock_order.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import re
import unittest

from sqlalchemy import event

import database
from routers import items
from routers.items import CheckoutStatusUpdate

U = kit.user


class LockOrderTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        self.sql = []
        event.listen(database.engine, "before_cursor_execute", self._capture)

    def tearDown(self):
        event.remove(database.engine, "before_cursor_execute", self._capture)
        self.db.rollback()
        self.db.close()

    def _capture(self, _conn, _cursor, statement, _params, _ctx, _many):
        self.sql.append(" ".join(statement.split()))

    def _full_row_reads(self):
        """SELECTs of whole checkout rows (the ones FOR UPDATE rides on)."""
        return [s for s in self.sql
                if s.startswith("SELECT item_checkouts.id AS item_checkouts_id") and "FROM item_checkouts" in s]

    def test_an_orders_rows_are_locked_together_in_id_order_first(self):
        kit.add_item(self.db, "it-1")
        kit.add_item(self.db, "it-2")
        kit.add_checkout(self.db, "co-b", "it-2", "pending", order="ORD-1", allocator="")
        kit.add_checkout(self.db, "co-a", "it-1", "pending", order="ORD-1", allocator="")
        self.sql.clear()
        items.update_checkout("co-b", CheckoutStatusUpdate(status="approved", assigned_allocator_email=kit.ALLOC_A),
                              user=U(kit.MGR_A), db=self.db)
        reads = self._full_row_reads()
        self.assertTrue(reads, self.sql)
        first = reads[0]
        self.assertIn("item_checkouts.order_id = ?", first)
        self.assertRegex(first, r"ORDER BY item_checkouts\.id")
        # The row by its own id is never read (locked) ahead of the order.
        self.assertFalse(any(re.search(r"WHERE item_checkouts\.id = \?", s) for s in reads[:1]))

    def test_a_solo_checkout_locks_its_own_row(self):
        kit.add_item(self.db, "it-3")
        kit.add_checkout(self.db, "co-s", "it-3", "pending", allocator="")
        self.sql.clear()
        out = items.update_checkout("co-s", CheckoutStatusUpdate(status="approved", assigned_allocator_email=kit.ALLOC_A),
                                    user=U(kit.MGR_A), db=self.db)
        self.assertEqual(out["status"], "approved")
        self.assertIn("WHERE item_checkouts.id = ?", self._full_row_reads()[0])

    def test_parallel_approvals_of_one_order_still_send_one_bell(self):
        kit.add_item(self.db, "it-4")
        kit.add_item(self.db, "it-5")
        kit.add_checkout(self.db, "co-4", "it-4", "pending", order="ORD-2", allocator="")
        kit.add_checkout(self.db, "co-5", "it-5", "pending", order="ORD-2", allocator="")
        for cid in ("co-4", "co-5"):
            items.update_checkout(cid, CheckoutStatusUpdate(status="approved", assigned_allocator_email=kit.ALLOC_A),
                                  user=U(kit.MGR_A), db=self.db)
        self.assertEqual(len([n for n in kit.bells(self.db, "approved", "ORD-2")]), 1)
        self.assertEqual(len(kit.bells(self.db, "allocate_request", "ORD-2")), 1)


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
