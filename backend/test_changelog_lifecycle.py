"""What's New after release (Oct 18 2026) - routers/changelog_lifecycle.py
and its hooks in task_config / changelog_reach / changelog_extras.

  - Edits never overwrite the server's fields (issue, prodAt, mergeSha);
    gallery images, attachments and tour images must be Nexus storage.
  - A feature request's status rings the requester's bell once per status;
    Shipped waits for its update's release.
  - Known issues and rollbacks bell the update's readers and followers, one
    row each, updated in place when resolved; clearing one takes them away.
  - Deprecations remind 7 days and 1 day before, each once, to the people
    with the screen's module.
  - The screen card puts open issues and coming removals first.
  - Tours: read, finished, counted.
  - Live in production: a merge commit on main stamps prodAt (dev only).

Throwaway sqlite, no network. Run with: python -m unittest test_changelog_lifecycle -v
"""
import os
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import HTTPException           # noqa: E402

import cache                                # noqa: E402
import database                             # noqa: E402
import models                               # noqa: E402
from routers import changelog_extras as X   # noqa: E402
from routers import changelog_lifecycle as L  # noqa: E402
from routers import items                   # noqa: E402
from routers import task_config as T        # noqa: E402

ADMIN = {"email": "admin@greensglobal.com", "level": 3}
AMY = {"email": "amy@greensglobal.com", "level": 1}       # Tickets grant
BOB = {"email": "bob@greensglobal.com", "level": 1}       # no grants
NOW = datetime.now(timezone.utc)
STORE = "https://x.supabase.co/storage/v1/object/public/"


def ago(**kw):
    return (NOW - timedelta(**kw)).isoformat()


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskChangelogEntry, models.ChangelogEntryView, models.ChangelogEntryHistory,
                  models.ChangelogFeedback, models.ChangelogSubscription, models.NexusNotification,
                  models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusSetting,
                  models.ChangelogSeen):
            self.db.query(m).delete()
        self.db.add_all([
            models.NexusEmployee(id="1", work_email=AMY["email"], first_name="Amy", last_name="Bolanos", company="c1", status="active"),
            models.NexusEmployee(id="2", work_email=BOB["email"], first_name="Bob", last_name="Lee", company="c2", status="active"),
            models.NexusEmployee(id="3", work_email=ADMIN["email"], first_name="Ada", last_name="Min", company="c1", status="active"),
            models.NexusGroup(id="g1", name="Desk", allowed_modules="tickets:editor"),
            models.NexusGroupMember(group_id="g1", email=AMY["email"]),
        ])
        self.db.commit()
        cache.module_grants.clear() if hasattr(cache.module_grants, "clear") else None

    def tearDown(self):
        self.db.close()

    def _entry(self, id_, **payload):
        base = {"title": id_, "type": "Bug Fix", "module": "Tickets", "status": "Released", "releasedAt": ago(hours=1)}
        self.db.add(models.TaskChangelogEntry(id=id_, payload={**base, **payload}, created_at=ago(hours=1), updated_at=""))
        self.db.commit()

    def _payload(self, id_):
        self.db.expire_all()
        return self.db.query(models.TaskChangelogEntry).filter_by(id=id_).one().payload

    def _bells(self, email=None, ref=None):
        q = self.db.query(models.NexusNotification)
        if email:
            q = q.filter_by(recipient=email)
        if ref:
            q = q.filter_by(ref_id=ref)
        self.db.expire_all()
        return q.all()

    def _viewed(self, entry_id, email):
        self.db.add(models.ChangelogEntryView(id=f"v-{entry_id}-{email}", entry_id=entry_id, email=email,
                                              views=1, first_at=ago(minutes=5), last_at=ago(minutes=5)))
        self.db.commit()


class CleanPayload(_Case):
    def test_an_edit_keeps_the_servers_fields(self):
        self._entry("e1", issue={"kind": "known", "note": "Slow", "at": ago(hours=1)}, prodAt=ago(hours=2), mergeSha="abc")
        body = T.ChangelogEntryBody(payload={"title": "e1 edited", "status": "Released", "issue": None, "prodAt": "", "mergeSha": "x"})
        T.update_changelog("e1", body, ADMIN, self.db)
        p = self._payload("e1")
        self.assertEqual(p["title"], "e1 edited")
        self.assertEqual(p["issue"]["note"], "Slow")
        self.assertEqual(p["mergeSha"], "abc")
        self.assertTrue(p["prodAt"])

    def test_a_new_update_cannot_bring_its_own(self):
        out = T.create_changelog(T.ChangelogEntryBody(payload={"title": "n", "status": "Draft", "prodAt": ago(hours=1),
                                                               "issue": {"kind": "known"}}), ADMIN, self.db)
        self.assertNotIn("prodAt", out)
        self.assertNotIn("issue", out)

    def test_media_must_be_nexus_storage(self):
        with mock.patch.object(items, "_STORAGE_PREFIX", STORE):
            ok = L.clean_payload({"images": [STORE + "task-files/whats-new/a.png", "data:image/png;base64,AAA"],
                                  "attachments": [{"name": "Guide.pdf", "url": STORE + "task-files/whats-new/g.pdf", "size": 10}]}, None)
            self.assertEqual(len(ok["images"]), 2)
            self.assertEqual(ok["attachments"][0]["name"], "Guide.pdf")
            with self.assertRaises(HTTPException):
                L.clean_payload({"images": ["https://evil.example/x.png"]}, None)
            with self.assertRaises(HTTPException):
                L.clean_payload({"attachments": [{"name": "x", "url": "data:application/pdf;base64,AA"}]}, None)
            with self.assertRaises(HTTPException):
                L.clean_payload({"tour": [{"title": "Hi", "image": "https://evil.example/t.png"}]}, None)

    def test_tour_steps_are_trimmed(self):
        p = L.clean_payload({"tour": [{"title": "One", "body": "b", "selector": "#x"}, {"title": "", "body": ""}, "junk"]}, None)
        self.assertEqual(p["tour"], [{"title": "One", "body": "b", "image": "", "selector": "#x"}])

    def test_deprecation_reminders_reset_when_the_date_moves(self):
        before = {"deprecation": {"removeOn": "2026-11-15", "reminded": ["7d"]}}
        same = L.clean_payload({"deprecation": {"removeOn": "2026-11-15", "what": "Old Report"}}, before)
        self.assertEqual(same["deprecation"]["reminded"], ["7d"])
        moved = L.clean_payload({"deprecation": {"removeOn": "2026-12-01"}}, before)
        self.assertEqual(moved["deprecation"]["reminded"], [])
        self.assertNotIn("deprecation", L.clean_payload({"deprecation": {"removeOn": ""}}, before))
        with self.assertRaises(HTTPException):
            L.clean_payload({"deprecation": {"removeOn": "soon"}}, None)


class Requests(_Case):
    def _request(self, entry_id="e1", email=AMY["email"], id_="r1"):
        self.db.add(models.ChangelogFeedback(id=id_, entry_id=entry_id, email=email, kind="request", helpful=1,
                                             note="Export to Excel please", created_at=ago(days=1)))
        self.db.commit()

    def test_each_status_rings_once_in_one_row(self):
        self._entry("e1")
        self._request()
        L.set_request_status("r1", L.RequestStatusBody(status="Planned", note="Next sprint"), ADMIN, self.db)
        bells = self._bells(AMY["email"], L.REQUEST_REF + "r1")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Your Request Is Planned")
        self.assertIn("Next sprint", bells[0].body)
        bells[0].read_by = AMY["email"]
        self.db.commit()
        L.set_request_status("r1", L.RequestStatusBody(status="Planned", note="Still next sprint"), ADMIN, self.db)
        self.assertEqual(self._bells(AMY["email"], L.REQUEST_REF + "r1")[0].read_by, AMY["email"])   # not rung again
        L.set_request_status("r1", L.RequestStatusBody(status="In Progress"), ADMIN, self.db)
        bells = self._bells(AMY["email"], L.REQUEST_REF + "r1")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Your Request Is In Progress")
        self.assertEqual(bells[0].read_by, "")

    def test_shipped_waits_for_the_release(self):
        self._entry("e1")
        self._entry("fix", status="Draft")
        self._request()
        out = L.set_request_status("r1", L.RequestStatusBody(status="Shipped", shippedEntryId="fix"), ADMIN, self.db)
        self.assertEqual(out["status"], "Shipped")
        self.assertFalse(out["shippedReleased"])
        self.assertEqual(self._bells(AMY["email"]), [])
        T.publish_changelog("fix", ADMIN, self.db)
        bells = self._bells(AMY["email"], L.REQUEST_REF + "r1")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Your Request Shipped")
        self.assertIn('"fix"', bells[0].body)
        self.assertIn('"sub": "fix"', bells[0].action)

    def test_bad_status_and_missing_update(self):
        self._entry("e1")
        self._request()
        with self.assertRaises(HTTPException):
            L.set_request_status("r1", L.RequestStatusBody(status="Done"), ADMIN, self.db)
        with self.assertRaises(HTTPException):
            L.set_request_status("r1", L.RequestStatusBody(status="Shipped", shippedEntryId="nope"), ADMIN, self.db)
        with self.assertRaises(HTTPException):
            L.set_request_status("zz", L.RequestStatusBody(status="Planned"), ADMIN, self.db)

    def test_my_requests_and_a_request_on_its_own(self):
        self._entry("e1")
        self._request()
        self._request(email=BOB["email"], id_="r2")
        made = L.raise_request(L.NewRequestBody(note="Dark mode for reports", module="Reports"), AMY, self.db)
        self.assertEqual(made["entryId"], "")
        mine = L.my_requests(AMY, self.db)
        self.assertEqual({r["note"] for r in mine}, {"Export to Excel please", "Dark mode for reports"})
        self.assertEqual(mine[-1]["entryTitle"], "e1")
        with self.assertRaises(HTTPException):
            L.raise_request(L.NewRequestBody(note="  "), AMY, self.db)
        admin_rows = X.list_feedback(ADMIN, self.db)
        general = next(r for r in admin_rows if r["id"] == made["id"])
        self.assertEqual((general["status"], general["entryTitle"], general["module"]), ("New", "", "Reports"))

    def test_deleting_the_shipped_update_unlinks_requests(self):
        self._entry("e1")
        self._entry("fix")
        self._request()
        L.set_request_status("r1", L.RequestStatusBody(status="Shipped", shippedEntryId="fix"), ADMIN, self.db)
        T.delete_changelog("fix", self.db)
        r = self.db.query(models.ChangelogFeedback).filter_by(id="r1").one()
        self.assertEqual((r.status, r.shipped_entry_id), ("Shipped", ""))


class Issues(_Case):
    def test_readers_and_followers_hear_once_and_then_the_fix(self):
        self._entry("e1", screen="tickets")
        self._viewed("e1", AMY["email"])
        self.db.add(models.ChangelogSubscription(email=BOB["email"], modules=["tickets"], categories=[]))
        self.db.commit()
        out = L.raise_issue("e1", L.IssueBody(kind="rolledBack", note="Totals were wrong", workaround="Use the old report"), ADMIN, self.db)
        self.assertEqual(out["issue"]["kind"], "rolledBack")
        self.assertEqual({b.recipient for b in self._bells(ref=L.ISSUE_REF + "e1")}, {AMY["email"], BOB["email"]})
        amy = self._bells(AMY["email"], L.ISSUE_REF + "e1")[0]
        self.assertEqual(amy.title, "Rolled Back: e1")
        self.assertIn("Use the old report", amy.body)
        first_at = out["issue"]["at"]
        again = L.raise_issue("e1", L.IssueBody(kind="known", note="Totals still off"), ADMIN, self.db)
        self.assertEqual(again["issue"]["at"], first_at)              # the same open issue, edited
        L.resolve_issue("e1", L.ResolveBody(note="Totals fixed"), ADMIN, self.db)
        bells = self._bells(AMY["email"], L.ISSUE_REF + "e1")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Fixed: e1")
        self.assertFalse(L.issue_active(self._payload("e1")))
        actions = [h.action for h in self.db.query(models.ChangelogEntryHistory).filter_by(entry_id="e1").all()]
        self.assertIn("issue", actions)
        self.assertIn("resolved", actions)

    def test_only_released_updates_and_a_real_fix(self):
        self._entry("d", status="Draft")
        with self.assertRaises(HTTPException):
            L.raise_issue("d", L.IssueBody(note="x"), ADMIN, self.db)
        self._entry("e1")
        with self.assertRaises(HTTPException):
            L.resolve_issue("e1", L.ResolveBody(), ADMIN, self.db)        # nothing open
        L.raise_issue("e1", L.IssueBody(note="x"), ADMIN, self.db)
        with self.assertRaises(HTTPException):
            L.resolve_issue("e1", L.ResolveBody(fixEntryId="e1"), ADMIN, self.db)
        with self.assertRaises(HTTPException):
            L.raise_issue("e1", L.IssueBody(kind="meh", note="x"), ADMIN, self.db)

    def test_clearing_takes_the_bells_away(self):
        self._entry("e1")
        self._viewed("e1", AMY["email"])
        L.raise_issue("e1", L.IssueBody(note="x"), ADMIN, self.db)
        self.assertEqual(len(self._bells(ref=L.ISSUE_REF + "e1")), 1)
        out = L.clear_issue("e1", ADMIN, self.db)
        self.assertNotIn("issue", out)
        self.assertEqual(self._bells(ref=L.ISSUE_REF + "e1"), [])

    def test_the_screen_card_leads_with_the_issue(self):
        self._entry("old", screen="tickets", releasedAt=ago(days=40))
        self._entry("new", screen="tickets")
        L.raise_issue("old", L.IssueBody(note="Broken export"), ADMIN, self.db)
        hints = X.changelog_hints("tickets", AMY, self.db)
        self.assertEqual([(h["kind"], h["id"]) for h in hints], [("issue", "old"), ("new", "new")])
        self.assertEqual(hints[0]["note"], "Broken export")
        self.assertEqual(X.changelog_hints("tickets", BOB, self.db)[0]["kind"], "issue")   # everyone on the screen


class Deprecations(_Case):
    def _dep(self, days, **kw):
        day = (datetime.now(L._PACIFIC).date() + timedelta(days=days)).isoformat()
        self._entry("dep", screen="tickets", deprecation={"removeOn": day, "what": "The Old Queue",
                                                          "replacement": "Smart Queue", "reminded": []}, **kw)

    def test_seven_days_then_one_day_each_once(self):
        self._dep(5)
        self.assertEqual(L.deprecation_tick(self.db), 1)              # Amy has the Tickets grant
        bells = self._bells(AMY["email"], L.DEPRECATION_REF + "dep")
        self.assertEqual(bells[0].title, "Going Away in 5 Days")
        self.assertIn("Use Smart Queue instead.", bells[0].body)
        self.assertEqual(self._bells(BOB["email"]), [])
        self.assertEqual(L.deprecation_tick(self.db), 0)
        later = datetime.now(timezone.utc) + timedelta(days=4)
        self.assertEqual(L.deprecation_tick(self.db, now=later), 1)
        bells = self._bells(AMY["email"], L.DEPRECATION_REF + "dep")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Going Away Tomorrow")
        self.assertEqual(self._payload("dep")["deprecation"]["reminded"], ["1d", "7d"])
        self.assertEqual(L.deprecation_tick(self.db, now=later), 0)

    def test_far_off_hidden_or_unreleased_wait(self):
        self._dep(20)
        self.assertEqual(L.deprecation_tick(self.db), 0)
        self.db.query(models.TaskChangelogEntry).delete()
        self.db.commit()
        self._dep(3, hidden=True)
        self.assertEqual(L.deprecation_tick(self.db), 0)

    def test_the_screen_card_counts_down(self):
        self._dep(12)
        hint = X.changelog_hints("tickets", BOB, self.db)[0]
        self.assertEqual((hint["kind"], hint["daysLeft"], hint["replacement"]), ("deprecation", 12, "Smart Queue"))


class Tours(_Case):
    def test_read_finish_and_count(self):
        self._entry("plain")
        with self.assertRaises(HTTPException):
            L.get_tour("plain", AMY, self.db)
        self._entry("t", screen="tickets", tour=[{"title": "Find it", "body": "Top right", "image": "", "selector": "#btn"}])
        tour = L.get_tour("t", AMY, self.db)
        self.assertEqual((tour["screen"], len(tour["steps"]), tour["doneAt"]), ("tickets", 1, ""))
        L.tour_done("t", AMY, self.db)
        self.assertTrue(L.get_tour("t", AMY, self.db)["doneAt"])
        self.assertEqual(X.insights(ADMIN, self.db)["entries"]["t"]["toursDone"], 1)
        self.assertTrue(X.changelog_hints("tickets", AMY, self.db)[0]["tour"])


class _Client:
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def get(self, path):
        self.calls.append(path)
        return self.answers(path)


class Production(_Case):
    def _run(self, branch, answers):
        client = _Client(answers)

        @contextmanager
        def fake_client():
            yield client

        def fake_get(_c, path, **_kw):
            return client.get(path)

        with mock.patch.object(T, "deployment_branch", return_value=branch), \
                mock.patch("changelog_prs._token", return_value="t"), \
                mock.patch("changelog_prs._client", fake_client), \
                mock.patch("changelog_prs._get", fake_get):
            return L.sync_production(self.db), client

    def test_a_merge_on_main_goes_live(self):
        self._entry("in", origin="pr", prNumber=12, mergedAt=ago(days=2))
        self._entry("out", origin="pr", mergeSha="bbb", mergedAt=ago(days=1))
        self._entry("hand", origin="manual")

        def answers(path):
            if path == "/pulls/12":
                return {"merge_commit_sha": "aaa"}
            return {"status": "behind" if path.endswith("aaa") else "ahead"}

        result, client = self._run("dev", answers)
        self.assertEqual((result["checked"], result["live"]), (2, 1))
        self.assertTrue(self._payload("in")["prodAt"])
        self.assertEqual(self._payload("in")["mergeSha"], "aaa")
        self.assertNotIn("prodAt", self._payload("out"))
        self.assertNotIn("/compare/main...hand", client.calls)
        # Already live: not asked again.
        _, client = self._run("dev", answers)
        self.assertEqual(client.calls, ["/compare/main...bbb"])

    def test_production_needs_no_check(self):
        self._entry("in", origin="pr", prNumber=12)
        result, client = self._run("main", lambda p: {})
        self.assertTrue(result["production"])
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
