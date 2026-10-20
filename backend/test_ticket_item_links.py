"""
Tickets <-> equipment (Oct 2026, routers/ticket_items.py).

A ticket names the item(s) it is about. Pinned here:
  * a requester may link only what they hold (assigned or checked out);
  * a desk agent may link any item in the ticket's company, nothing outside it;
  * an armed company wall is never crossed - 404 for another company's item;
  * GET /task-tickets/by-item/{id} and the drawer's "Other Tickets for This
    Item" show only tickets the caller may see (tickets.ListScope);
  * every link and unlink writes a ticket activity row;
  * a deleted ticket or item (soft, or the item row gone) never 500s.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.

Run with: python -m pytest test_ticket_item_links.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers import tickets as T  # noqa: E402
from routers import ticket_items as TI  # noqa: E402

REQ = {"email": "req@greensglobal.com", "level": 1}          # plain employee, company co1
OTHER = {"email": "other@greensglobal.com", "level": 1}      # plain employee, company co1
AGENT = {"email": "agent@greensglobal.com", "level": 1}      # desk agent, company co1
AGENT2 = {"email": "agent2@greensglobal.com", "level": 1}    # desk agent, company co2
FAR = {"email": "far@greensglobal.com", "level": 1}          # plain employee, company co2


class TicketItemLinkTests(unittest.TestCase):
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
        for m in (models.TaskTicket, models.TaskActivity, models.NexusEmployee, models.NexusNotification,
                  models.TaskNotification, models.NexusGroup, models.NexusGroupMember, models.NexusSetting,
                  models.Item, models.ItemCheckout, models.TicketItemLink, models.NexusAccessScope):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.add(models.NexusGroup(id="g-desk", name="Service Desk", allowed_modules="tickets:editor"))
        for who in (AGENT, AGENT2):
            self.db.add(models.NexusGroupMember(group_id="g-desk", email=who["email"]))
        for who, co in ((REQ, "co1"), (OTHER, "co1"), (AGENT, "co1"), (AGENT2, "co2"), (FAR, "co2")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=who["email"].split("@")[0],
                                             work_email=who["email"], status="active",
                                             identity_type="internal", company=co))
        self.laptop = self._item("Dell Laptop", "co1", serial="GG-00001", assigned=REQ["email"])
        self.drill = self._item("Drill", "co1", serial="GG-00002")
        self.printer = self._item("Printer", "co1", serial="GG-00003", assigned=OTHER["email"])
        self.far_item = self._item("India Laptop", "co2", serial="GG-00004", assigned=FAR["email"])
        # The drill is checked out to the requester (in their hands).
        self.db.add(models.ItemCheckout(id=gen_id(), item_id=self.drill, item_name="Drill",
                                        requested_by="Req", requested_by_email=REQ["email"],
                                        raised_by="Req", status="allocated", created_at=now_iso()))
        self.db.commit()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        self.addCleanup(cache.settings_config.invalidate)

    def tearDown(self):
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────
    def _item(self, name, company, serial="", assigned=""):
        iid = gen_id()
        self.db.add(models.Item(id=iid, name=name, company_id=company, serial_number=serial,
                                assigned_to_email=assigned, assigned_to_name=assigned.split("@")[0],
                                status="permanently_assigned" if assigned else "available",
                                created_at=now_iso()))
        return iid

    def walls_on(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def _create(self, user, item_ids=None, requester="", **kw):
        body = T.TicketBody(subject=kw.pop("subject", "Laptop will not boot"), requester_email=requester,
                            item_ids=item_ids, **kw)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

    def _link(self, user, ticket_id, *item_ids):
        return TI.link_items(ticket_id, TI.ItemLinkBody(item_ids=list(item_ids)), user=user, db=self.db)

    def _status(self, fn, *a, **kw):
        with self.assertRaises(HTTPException) as ctx:
            fn(*a, **kw)
        self.db.rollback()
        return ctx.exception.status_code

    def _activity(self, ticket_id, kind):
        return [a.detail for a in self.db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_id == ticket_id, models.TaskActivity.type == kind).all()]

    # ── requester: only what they hold ───────────────────────────────────
    def test_requester_links_their_assigned_and_checked_out_items_at_intake(self):
        t = self._create(REQ, item_ids=[self.laptop, self.drill])
        out = TI.ticket_items(t["id"], user=REQ, db=self.db)
        self.assertEqual([i["name"] for i in out["items"]], ["Dell Laptop", "Drill"])
        self.assertEqual(out["items"][0]["serialNumber"], "GG-00001")
        self.assertEqual(out["items"][1]["heldBy"], REQ["email"])          # the checkout holder
        self.assertEqual(sorted(self._activity(t["id"], "item_linked")),
                         ["linked equipment Dell Laptop (GG-00001)", "linked equipment Drill (GG-00002)"])

    def test_requester_cannot_link_someone_elses_item(self):
        self.assertEqual(self._status(self._create, REQ, item_ids=[self.printer]), 403)
        self.assertEqual(self.db.query(models.TaskTicket).count(), 0)      # nothing written
        t = self._create(REQ)
        self.assertEqual(self._status(self._link, REQ, t["id"], self.printer), 403)

    def test_requester_options_are_only_their_own(self):
        out = TI.item_options(user=REQ, db=self.db)
        self.assertFalse(out["desk"])
        self.assertEqual(sorted(i["name"] for i in out["items"]), ["Dell Laptop", "Drill"])
        self.assertTrue(all(i["mine"] for i in out["items"]))

    def test_a_watcher_may_look_but_not_link(self):
        t = self._create(REQ, watcher_emails=[OTHER["email"]])
        TI.ticket_items(t["id"], user=OTHER, db=self.db)                  # reading is fine
        self.assertEqual(self._status(self._link, OTHER, t["id"], self.printer), 403)

    # ── desk agent: the ticket's company ─────────────────────────────────
    def test_agent_links_any_item_in_the_tickets_company(self):
        t = self._create(REQ)
        out = self._link(AGENT, t["id"], self.printer)
        self.assertEqual([i["name"] for i in out["items"]], ["Printer"])
        self.assertTrue(out["items"][0]["canUnlink"])

    def test_agent_options_put_the_requesters_items_first(self):
        t = self._create(REQ)
        out = TI.item_options(ticket_id=t["id"], user=AGENT, db=self.db)
        names = [i["name"] for i in out["items"]]
        self.assertEqual(names[:2], ["Dell Laptop", "Drill"])
        self.assertIn("Printer", names)
        self.assertNotIn("India Laptop", names)                            # another company's (tagged) item

    def test_agent_cannot_link_another_companys_item_even_with_walls_off(self):
        t = self._create(REQ)
        self.assertEqual(self._status(self._link, AGENT, t["id"], self.far_item), 422)

    def test_cross_company_is_404_once_the_walls_are_armed(self):
        self.walls_on()
        t = self._create(REQ)
        self.assertEqual(self._status(self._link, AGENT, t["id"], self.far_item), 404)
        # The far agent cannot even open the co1 ticket.
        self.assertEqual(self._status(self._link, AGENT2, t["id"], self.far_item), 404)
        self.assertEqual(self._status(TI.item_options, ticket_id=t["id"], user=AGENT2, db=self.db), 404)
        # Nor read the co1 laptop's ticket history.
        self.assertEqual(self._status(TI.tickets_for_item, self.laptop, user=FAR, db=self.db), 404)

    def test_agent_with_two_companies_still_matches_the_ticket(self):
        self.walls_on()
        self.db.add(models.NexusAccessScope(id=gen_id(), email=AGENT["email"], module_id="tickets",
                                                 scope_type="entity", scope_id="co2"))
        self.db.commit()
        t = self._create(REQ)
        self.assertEqual(self._status(self._link, AGENT, t["id"], self.far_item), 422)
        self._link(AGENT, t["id"], self.laptop)                            # same company - fine

    # ── by-item and Other Tickets for This Item ──────────────────────────
    def test_by_item_shows_only_tickets_the_caller_may_see(self):
        mine = self._create(REQ, item_ids=[self.laptop], subject="Mine")
        theirs = self._create(OTHER, subject="Theirs")
        self._link(AGENT, theirs["id"], self.laptop)
        self.assertEqual([r["subject"] for r in TI.tickets_for_item(self.laptop, user=REQ, db=self.db)["tickets"]],
                         ["Mine"])
        self.assertEqual(sorted(r["subject"] for r in TI.tickets_for_item(self.laptop, user=AGENT, db=self.db)["tickets"]),
                         ["Mine", "Theirs"])
        # The drawer's other-tickets list follows the same rule.
        req_view = TI.ticket_items(mine["id"], user=REQ, db=self.db)["items"][0]
        self.assertEqual(req_view["otherCount"], 0)
        agent_view = TI.ticket_items(mine["id"], user=AGENT, db=self.db)["items"][0]
        self.assertEqual([x["subject"] for x in agent_view["otherTickets"]], ["Theirs"])

    # ── unlink + activity ────────────────────────────────────────────────
    def test_unlink_writes_activity_and_respects_who_linked(self):
        t = self._create(REQ, item_ids=[self.laptop])
        self._link(AGENT, t["id"], self.printer)
        # The requester may take back their own link, not the desk's.
        self.assertEqual(self._status(TI.unlink_item, t["id"], self.printer, user=REQ, db=self.db), 403)
        out = TI.unlink_item(t["id"], self.laptop, user=REQ, db=self.db)
        self.assertEqual([i["name"] for i in out["items"]], ["Printer"])
        TI.unlink_item(t["id"], self.printer, user=AGENT, db=self.db)
        self.assertEqual(sorted(self._activity(t["id"], "item_unlinked")),
                         ["removed equipment Dell Laptop (GG-00001)", "removed equipment Printer (GG-00003)"])
        self.assertEqual(self._status(TI.unlink_item, t["id"], self.printer, user=AGENT, db=self.db), 404)

    def test_linking_twice_is_one_link(self):
        t = self._create(REQ, item_ids=[self.laptop])
        self._link(REQ, t["id"], self.laptop, self.laptop)
        self.assertEqual(self.db.query(models.TicketItemLink).count(), 1)
        self.assertEqual(len(self._activity(t["id"], "item_linked")), 1)

    # ── deletes never 500 ────────────────────────────────────────────────
    def test_deleted_ticket_drops_out_of_by_item(self):
        gone = self._create(REQ, item_ids=[self.laptop], subject="Gone")
        kept = self._create(REQ, item_ids=[self.laptop], subject="Kept")
        row = self.db.get(models.TaskTicket, gone["id"])
        row.deleted_at = now_iso()
        self.db.commit()
        self.assertEqual([r["subject"] for r in TI.tickets_for_item(self.laptop, user=AGENT, db=self.db)["tickets"]],
                         ["Kept"])
        self.assertEqual(TI.ticket_items(kept["id"], user=AGENT, db=self.db)["items"][0]["otherCount"], 0)

    def test_deleted_or_purged_item_still_renders_on_the_ticket(self):
        t = self._create(REQ, item_ids=[self.laptop, self.drill])
        laptop = self.db.get(models.Item, self.laptop)
        laptop.deleted_at = now_iso()                                     # soft delete
        self.db.delete(self.db.get(models.Item, self.drill))              # purged for good
        self.db.commit()
        items = {i["id"]: i for i in TI.ticket_items(t["id"], user=REQ, db=self.db)["items"]}
        self.assertTrue(items[self.laptop]["deleted"])
        self.assertTrue(items[self.drill]["removed"])
        self.assertEqual(items[self.drill]["name"], "Drill")              # the stored name
        # A deleted item cannot be linked again, and by-item on a purged one is 404.
        self.assertEqual(self._status(self._link, AGENT, self._create(REQ)["id"], self.laptop), 404)
        self.assertEqual(self._status(TI.tickets_for_item, self.drill, user=AGENT, db=self.db), 404)
        TI.unlink_item(t["id"], self.drill, user=AGENT, db=self.db)       # unlinking it is fine


if __name__ == "__main__":
    unittest.main()
