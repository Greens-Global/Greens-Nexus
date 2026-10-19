"""
Ticket saved replies (Oct 2026, routers/ticket_saved_replies.py) - through
the real routes (TestClient). Covered:

  - desk agents only: a requester gets 403 on every route;
  - an agent creates, edits and deletes their own personal replies, and
    nobody else sees them;
  - shared replies: a supervisor creates, edits and deletes them; an agent
    sees them but cannot edit, delete or create one, nor share their own;
  - company wall: another company's shared reply is not listed and is 404;
  - the body is sanitized (scripts, handlers and javascript: links go);
  - use_count goes up when a reply is used.

Throwaway sqlite. No network.

Run with: python -m pytest test_ticket_saved_replies.py -q
"""
import json
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import FastAPI                     # noqa: E402
from fastapi.testclient import TestClient       # noqa: E402

import auth                                     # noqa: E402
import cache                                    # noqa: E402
import database                                 # noqa: E402
import models                                   # noqa: E402
from routers import ticket_saved_replies as R   # noqa: E402
from routers.task_util import gen_id            # noqa: E402

REQ = "req@greensglobal.com"
AGENT = "agent@greensglobal.com"
AGENT2 = "agent2@greensglobal.com"
SUP = "sup@greensglobal.com"
INDIA_SUP = "india.sup@greensglobal.com"
INDIA_AGENT = "india.agent@greensglobal.com"
GA = "ga@greensglobal.com"

USERS = {REQ: 1, AGENT: 1, AGENT2: 1, SUP: 2, INDIA_SUP: 2, INDIA_AGENT: 1, GA: 4}


class SavedReplyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        app = FastAPI()
        app.include_router(R.router)
        cls.who = {"email": REQ}
        app.dependency_overrides[auth.get_current_user] = lambda: {
            "email": cls.who["email"], "role": "employee", "level": USERS[cls.who["email"]]}
        cls.c = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.TicketSavedReply, models.NexusEmployee, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting):
            self.db.query(m).delete()
        self.db.commit()
        for email, co in ((REQ, "co1"), (AGENT, "co1"), (AGENT2, "co1"), (SUP, "co1"),
                          (INDIA_SUP, "co2"), (INDIA_AGENT, "co2"), (GA, "co1")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name="X", company=co,
                                             status="active", identity_type="internal"))
        self.db.add(models.NexusRole(email=GA, role="administrator"))
        # Explicit desk access: tickets editor = agent, tickets full = supervisor.
        self.db.add(models.NexusSetting(key="ticket_desk_access", value=json.dumps({"mode": "explicit"})))
        self.db.add(models.NexusGroup(id="agents", name="Agents", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroup(id="sups", name="Supervisors", allowed_modules="tickets:full"))
        for email in (AGENT, AGENT2, INDIA_AGENT):
            self.db.add(models.NexusGroupMember(group_id="agents", email=email))
        for email in (SUP, INDIA_SUP):
            self.db.add(models.NexusGroupMember(group_id="sups", email=email))
        self.db.add(models.NexusGroup(id="ga", name="Global Admins", is_global_admin=1))
        self.db.add(models.NexusGroupMember(group_id="ga", email=GA))
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        self.addCleanup(cache.settings_config.invalidate)

    def as_(self, email):
        type(self).who["email"] = email
        return self.c

    def make(self, who, **body):
        body.setdefault("title", "Password Reset")
        body.setdefault("body", "<p>Hi {requester_first_name}, try this.</p>")
        r = self.as_(who).post("/ticket-saved-replies", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def titles(self, who, **params):
        r = self.as_(who).get("/ticket-saved-replies", params=params)
        self.assertEqual(r.status_code, 200, r.text)
        return sorted(x["title"] for x in r.json())

    def test_requester_has_no_access(self):
        self.assertEqual(self.as_(REQ).get("/ticket-saved-replies").status_code, 403)
        self.assertEqual(self.as_(REQ).post("/ticket-saved-replies", json={"title": "A", "body": "b"}).status_code, 403)
        reply = self.make(SUP, shared=True)
        self.assertEqual(self.as_(REQ).delete(f"/ticket-saved-replies/{reply['id']}").status_code, 403)
        self.assertEqual(self.as_(REQ).post(f"/ticket-saved-replies/{reply['id']}/use").status_code, 403)

    def test_agent_personal_crud(self):
        mine = self.make(AGENT, title="My Reply")
        self.assertFalse(mine["shared"])
        self.assertTrue(mine["canEdit"])
        self.assertEqual(self.titles(AGENT), ["My Reply"])
        self.assertEqual(self.titles(AGENT2), [])           # personal = mine only
        self.assertEqual(self.titles(SUP), [])
        r = self.as_(AGENT).patch(f"/ticket-saved-replies/{mine['id']}", json={"title": "Renamed"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["title"], "Renamed")
        self.assertEqual(self.as_(AGENT2).patch(f"/ticket-saved-replies/{mine['id']}", json={"title": "X"}).status_code, 404)
        self.assertEqual(self.as_(SUP).delete(f"/ticket-saved-replies/{mine['id']}").status_code, 404)
        self.assertEqual(self.as_(AGENT).delete(f"/ticket-saved-replies/{mine['id']}").status_code, 204)
        self.assertEqual(self.titles(AGENT), [])

    def test_supervisor_shared_crud_and_agent_cannot_edit_shared(self):
        self.assertEqual(self.as_(AGENT).post("/ticket-saved-replies", json={"title": "S", "body": "<p>x</p>", "shared": True}).status_code, 403)
        shared = self.make(SUP, title="Shared One", shared=True)
        self.assertTrue(shared["shared"])
        self.assertEqual(shared["companyId"], "co1")
        listed = self.as_(AGENT).get("/ticket-saved-replies").json()
        self.assertEqual([x["title"] for x in listed], ["Shared One"])
        self.assertFalse(listed[0]["canEdit"])
        self.assertEqual(self.as_(AGENT).patch(f"/ticket-saved-replies/{shared['id']}", json={"title": "Mine Now"}).status_code, 403)
        self.assertEqual(self.as_(AGENT).delete(f"/ticket-saved-replies/{shared['id']}").status_code, 403)
        r = self.as_(SUP).patch(f"/ticket-saved-replies/{shared['id']}", json={"body": "<p>Updated</p>"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["body"], "<p>Updated</p>")
        self.assertEqual(self.as_(SUP).delete(f"/ticket-saved-replies/{shared['id']}").status_code, 204)
        self.assertEqual(self.titles(AGENT), [])

    def test_agent_cannot_share_their_own(self):
        mine = self.make(AGENT, title="Mine")
        r = self.as_(AGENT).patch(f"/ticket-saved-replies/{mine['id']}", json={"shared": True})
        self.assertEqual(r.status_code, 403)
        own_sup = self.make(SUP, title="Sup Personal")
        r = self.as_(SUP).patch(f"/ticket-saved-replies/{own_sup['id']}", json={"shared": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["shared"])
        self.assertIn("Sup Personal", self.titles(AGENT))

    def test_other_company_cannot_see_shared(self):
        greens = self.make(SUP, title="Greens Only", shared=True)
        self.make(INDIA_SUP, title="India Only", shared=True)
        self.assertEqual(self.titles(INDIA_AGENT), ["India Only"])
        self.assertEqual(self.titles(AGENT), ["Greens Only"])
        self.assertEqual(self.as_(INDIA_SUP).patch(f"/ticket-saved-replies/{greens['id']}", json={"title": "X"}).status_code, 404)
        self.assertEqual(self.as_(INDIA_SUP).delete(f"/ticket-saved-replies/{greens['id']}").status_code, 404)
        self.assertEqual(self.as_(INDIA_AGENT).post(f"/ticket-saved-replies/{greens['id']}/use").status_code, 404)
        # Asking for another company's replies by id is 404 too.
        self.assertEqual(self.as_(INDIA_AGENT).get("/ticket-saved-replies", params={"company_id": "co1"}).status_code, 404)
        # A Global Admin sees both, and can narrow to one ticket's company.
        self.assertEqual(self.titles(GA), ["Greens Only", "India Only"])
        self.assertEqual(self.titles(GA, company_id="co2"), ["India Only"])
        # Shared for another company: created only inside the wall.
        r = self.as_(SUP).post("/ticket-saved-replies", json={"title": "T", "body": "<p>b</p>", "shared": True, "company_id": "co2"})
        self.assertEqual(r.status_code, 404)

    def test_body_is_sanitized(self):
        r = self.make(AGENT, body='<p onclick="steal()">Hello <b>{agent_name}</b></p><script>alert(1)</script>'
                                   '<a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>'
                                   '<img src="x" onerror="alert(1)">')
        body = r["body"]
        for bad in ("<script", "onclick", "onerror", "javascript:", "<img"):
            self.assertNotIn(bad, body)
        self.assertIn("<b>{agent_name}</b>", body)
        self.assertIn('<a href="https://example.com">ok</a>', body)
        self.assertEqual(self.as_(AGENT).post("/ticket-saved-replies", json={"title": "Empty", "body": "<p> </p>"}).status_code, 422)
        self.assertEqual(self.as_(AGENT).post("/ticket-saved-replies", json={"title": "  ", "body": "<p>x</p>"}).status_code, 422)

    def test_use_count(self):
        shared = self.make(SUP, shared=True)
        for _ in range(3):
            self.assertEqual(self.as_(AGENT).post(f"/ticket-saved-replies/{shared['id']}/use").status_code, 204)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TicketSavedReply).filter_by(id=shared["id"]).one().use_count, 3)
        mine = self.make(AGENT2)
        self.assertEqual(self.as_(AGENT).post(f"/ticket-saved-replies/{mine['id']}/use").status_code, 404)


if __name__ == "__main__":
    unittest.main()
