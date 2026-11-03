"""Item Management QR tags and phone scan (Items phase 4, Neil 11/02/2026).

GET /items/by-code resolves what a phone scanned or a person typed - the
item's own link (<app>/itemmanagement/item/<id>), its id or its serial - to
the item, walled exactly like GET /items: outside the caller's companies it
is a 404 (the same answer as "no such item"), never a 403. POST /items/tags
returns what a printed tag needs, with the company name taken from the
item's company (white-label), and leaves walled ids off.

    python -m pytest test_items_scan.py -q
"""
import _items_testkit as kit  # noqa: I001 - first: binds the throwaway database

import os
import unittest
from unittest import mock

import models
from routers import items
from routers.items import ItemTagsIn

A, B = kit.COA, kit.COB
U = kit.user


class ItemScanTests(unittest.TestCase):
    def setUp(self):
        self.db = kit.fresh()
        self.db.query(models.HrEntity).delete()
        self.db.add(models.HrEntity(id=A, name="Alpha Storage"))
        self.db.add(models.HrEntity(id=B, name="Beta Builders"))
        self.db.commit()
        kit.add_item(self.db, "it-a", A, name="Hammer Drill", serial_number="GG-00042")
        kit.add_item(self.db, "it-b", B, name="Laser Level", serial_number="GG-00043")
        kit.add_item(self.db, "it-old", A, name="Old Ladder", serial_number="AT 7781-X")
        kit.add_item(self.db, "it-gone", A, name="Gone Saw", serial_number="GG-00044", deleted_at="2026-10-01T00:00:00+00:00")

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def code(self, who, code):
        return items.item_by_code(code=code, user=U(who), db=self.db)

    # ── what a code means ────────────────────────────────────────────────────
    def test_the_items_own_link_resolves_on_any_host(self):
        for link in ("https://nexus.example.com/itemmanagement/item/it-a",
                     "http://localhost:5174/itemmanagement/item/it-a/",
                     "https://nexus.example.com/itemmanagement/item:it-a",
                     "https://nexus.example.com/inventory/item/it-a?from=tag"):
            got = self.code(kit.EMP_A, link)
            self.assertEqual(got["id"], "it-a", link)
            self.assertEqual(got["matchedBy"], "link")

    def test_serials_match_however_they_are_typed(self):
        for typed in ("GG-00042", "gg-00042", " GG00042 ", "gg 42", "42", "00042"):
            self.assertEqual(self.code(kit.EMP_A, typed)["id"], "it-a", typed)
        # An old tag's serial read with different spacing or dashes.
        self.assertEqual(self.code(kit.EMP_A, "at7781x")["id"], "it-old")
        self.assertEqual(self.code(kit.EMP_A, "AT-7781-X")["matchedBy"], "serial")

    def test_the_item_id_alone_resolves(self):
        self.assertEqual(self.code(kit.EMP_A, "it-a")["matchedBy"], "id")

    def test_unknown_codes_and_other_sites_are_404(self):
        for junk in ("", "   ", "nothing-here", "https://example.com/some/page", "https://evil.example/GG-00042",
                     "https://nexus.example.com/itemmanagement/item/no-such-id"):
            kit.refused(self, 404, self.code, kit.EMP_A, junk)

    def test_a_deleted_item_is_not_found(self):
        kit.refused(self, 404, self.code, kit.MGR_A, "GG-00044")
        kit.refused(self, 404, self.code, kit.MGR_A, "https://x/itemmanagement/item/it-gone")

    # ── walls ────────────────────────────────────────────────────────────────
    def test_another_companys_item_is_404_with_the_walls_on(self):
        with kit.walls():
            kit.refused(self, 404, self.code, kit.EMP_A, "GG-00043")
            kit.refused(self, 404, self.code, kit.MGR_A, "https://x/itemmanagement/item/it-b")
            self.assertEqual(self.code(kit.MGR_B, "GG-00043")["id"], "it-b")
            # A Super Administrator is never walled.
            self.assertEqual(self.code(kit.OWNER, "GG-00043")["id"], "it-b")

    def test_walls_off_changes_nothing(self):
        with kit.walls(False):
            self.assertEqual(self.code(kit.EMP_A, "GG-00043")["id"], "it-b")

    def test_the_answer_carries_the_items_company_name(self):
        got = self.code(kit.OWNER, "GG-00043")
        self.assertEqual(got["companyName"], "Beta Builders")
        self.assertEqual(got["serialNumber"], "GG-00043")

    # ── tags ─────────────────────────────────────────────────────────────────
    def test_tags_come_back_in_order_with_company_names(self):
        rows = items.item_tags(ItemTagsIn(ids=["it-old", "it-a", "it-a", "missing"]), user=U(kit.MGR_A), db=self.db)["tags"]
        self.assertEqual([r["id"] for r in rows], ["it-old", "it-a"])
        self.assertEqual(rows[1], {"id": "it-a", "name": "Hammer Drill", "serialNumber": "GG-00042",
                                   "itemType": "Other", "location": "", "companyName": "Alpha Storage"})

    def test_tags_leave_walled_and_deleted_items_off(self):
        with kit.walls():
            rows = items.item_tags(ItemTagsIn(ids=["it-a", "it-b", "it-gone"]), user=U(kit.MGR_A), db=self.db)["tags"]
        self.assertEqual([r["id"] for r in rows], ["it-a"])

    def test_an_untagged_item_takes_the_printers_company_name(self):
        kit.add_item(self.db, "it-shared", "", name="Shared Cart")
        rows = items.item_tags(ItemTagsIn(ids=["it-shared"]), user=U(kit.OWNER), db=self.db)["tags"]
        self.assertEqual(rows[0]["companyName"], "Alpha Storage")

    def test_too_many_tags_at_once_is_refused(self):
        kit.refused(self, 400, items.item_tags, ItemTagsIn(ids=[f"x{i}" for i in range(items._TAG_MAX + 1)]),
                    user=U(kit.MGR_A), db=self.db)

    # ── review fixes (11/02/2026) ────────────────────────────────────────────
    def test_tags_carry_the_apps_public_address(self):
        # M1: the QR address is the app's public URL, never the printing tab's.
        with mock.patch.dict(os.environ, {"NEXUS_APP_URL": "https://nexus.example.com/"}):
            got = items.item_tags(ItemTagsIn(ids=["it-a"]), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(got["publicBase"], "https://nexus.example.com")
        with mock.patch.dict(os.environ, {"NEXUS_APP_URL": "", "WEBSITE_SITE_NAME": "greens-nexus-api-dev-x"}):
            got = items.item_tags(ItemTagsIn(ids=[]), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(got, {"tags": [], "publicBase": "https://dev.nexus.greensglobal.com"})
        # A local server (neither set) sends nothing - the sheet uses its own origin.
        with mock.patch.dict(os.environ, {"NEXUS_APP_URL": "", "WEBSITE_SITE_NAME": ""}):
            got = items.item_tags(ItemTagsIn(ids=["it-a"]), user=U(kit.MGR_A), db=self.db)
        self.assertEqual(got["publicBase"], "")

    def test_a_loose_serial_that_fits_several_items_is_a_choice(self):
        # L6: two items whose serials only differ in spacing - pick one, never a guess.
        kit.add_item(self.db, "it-old2", A, name="Old Ladder Two", serial_number="AT-7781X")
        err = kit.refused(self, 409, self.code, kit.MGR_A, "at7781x")
        self.assertEqual(sorted(c["id"] for c in err.detail["choices"]), ["it-old", "it-old2"])
        self.assertEqual(err.detail["message"], "Several items match - pick one")

    def test_the_gg_expansion_wins_over_a_loose_match(self):
        # L6: "42" is GG-00042 even when another serial reads "4-2" loosely.
        kit.add_item(self.db, "it-42", A, name="Odd Tag", serial_number="4-2")
        self.assertEqual(self.code(kit.MGR_A, "42")["id"], "it-a")

    def test_the_loose_match_never_reads_past_the_wall(self):
        # L5: another company's look-alike serial neither matches nor makes it ambiguous.
        kit.add_item(self.db, "it-old-b", B, name="Beta Ladder", serial_number="AT-7781-X")
        with kit.walls():
            self.assertEqual(self.code(kit.MGR_A, "at7781x")["id"], "it-old")
            self.assertEqual(self.code(kit.MGR_B, "at7781x")["id"], "it-old-b")
            kit.refused(self, 409, self.code, kit.OWNER, "at7781x")   # sees both

    def test_by_code_carries_the_same_activity_as_the_list(self):
        # L7: the scanned item knows it is requested, by whom and when it is due.
        kit.add_checkout(self.db, "co-1", "it-a", "pending")
        got = self.code(kit.EMP_A, "GG-00042")
        listed = next(d for d in items.list_items(user=U(kit.EMP_A), db=self.db) if d["id"] == "it-a")
        for key in ("hasActiveRequest", "activeRequestedBy", "activeDueDate", "activeDueDay"):
            self.assertEqual(got[key], listed[key], key)
        self.assertTrue(got["hasActiveRequest"])

    def test_the_routes_are_registered_where_the_screen_calls_them(self):
        paths = {(r.path, tuple(sorted(r.methods))) for r in items.router.routes}
        self.assertIn(("/items/by-code", ("GET",)), paths)
        self.assertIn(("/items/tags", ("POST",)), paths)


if __name__ == "__main__":
    unittest.main()
