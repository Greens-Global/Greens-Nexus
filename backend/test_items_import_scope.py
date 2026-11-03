"""CSV import stays inside the company wall and out of the Recycle Bin (Nov 2026, M7).

  * a row matches (and so updates) only the caller's own items - by serial
    or by content - never another company's;
  * never an item in the Recycle Bin, unless the import asks to restore
    those (`restore_deleted`);
  * a serial taken by an item the import may not touch is reported in
    `conflicts` and skipped - the serial index is unique, so creating a
    second one was a 500.

    python -m pytest test_items_import_scope.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import unittest

import models
from routers import items
from routers.items import ItemImportRequest, ItemImportRow

U = kit.user


def _rows(*rows, restore=False):
    return ItemImportRequest(items=[ItemImportRow(**r) for r in rows], restore_deleted=restore)


class ImportScopeTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        kit.add_item(self.db, "it-b", kit.COB, name="Drill", serial_number="GG-00010")
        kit.add_item(self.db, "it-gone", kit.COA, name="Saw", serial_number="GG-00020",
                     deleted_at="2026-10-20T10:00:00+00:00")
        kit.add_item(self.db, "it-b-twin", kit.COB, name="Ladder", item_type="Tools")

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _import(self, body):
        with kit.walls():
            return items.import_items(body, user=U(kit.MGR_A), db=self.db)

    def test_another_companys_serial_is_a_conflict_never_an_update(self):
        out = self._import(_rows({"name": "My Drill", "serial_number": "GG-00010"}))
        self.assertEqual((out["created"], out["updated"], out["skipped"]), (0, 0, 1))
        self.assertEqual(out["conflicts"][0]["serial"], "GG-00010")
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Item, "it-b").name, "Drill")

    def test_content_matching_never_reaches_across_the_wall(self):
        out = self._import(_rows({"name": "Ladder", "item_type": "Tools"}))
        self.assertEqual((out["created"], out["updated"]), (1, 0))
        new = self.db.query(models.Item).filter(models.Item.name == "Ladder", models.Item.id != "it-b-twin").one()
        self.assertEqual(new.company_id, kit.COA)

    def test_a_recycle_bin_serial_is_skipped_unless_restoring(self):
        out = self._import(_rows({"name": "Saw v2", "serial_number": "GG-00020"}))
        self.assertEqual(out["skipped"], 1)
        self.assertIn("Recycle Bin", out["conflicts"][0]["reason"])
        out = self._import(_rows({"name": "Saw v2", "serial_number": "GG-00020"}, restore=True))
        self.assertEqual((out["updated"], out["restored"]), (1, 1))
        self.db.expire_all()
        item = self.db.get(models.Item, "it-gone")
        self.assertEqual((item.name, item.deleted_at or ""), ("Saw v2", ""))

    def test_new_serials_skip_every_taken_one(self):
        out = self._import(_rows({"name": "Fresh"}))
        self.assertEqual(out["created"], 1)
        new = self.db.query(models.Item).filter(models.Item.name == "Fresh").one()
        self.assertNotIn(new.serial_number, {"GG-00010", "GG-00020"})


def tearDownModule():
    kit.cleanup()


if __name__ == "__main__":
    unittest.main()
