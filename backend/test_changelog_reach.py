"""What's New reach and response (Oct 16 2026) - changelog_reach.py,
routers/changelog_extras.py and the endpoints in routers/task_config.py
that use them.

  - Who sees what: admins everything; others what is Released, not hidden,
    aimed at their modules / company - plus their own submissions.
  - Scheduled updates release themselves once their time passes.
  - Every edit is in the history with the fields that changed.
  - Followers hear about a matching release in ONE bell row; replies,
    @mentions and comments on your update ring yours.
  - Helpful votes (one per person), feature requests, bulk actions, the
    private feed link, screen hints, "since your last visit", insights and
    the Monday digest.

Throwaway sqlite, no network. Run with: python -m unittest test_changelog_reach -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import HTTPException          # noqa: E402

import cache                               # noqa: E402
import changelog_reach as reach            # noqa: E402
import database                            # noqa: E402
import models                              # noqa: E402
from routers import changelog_extras as X  # noqa: E402
from routers import task_config as T       # noqa: E402

ADMIN = {"email": "admin@greensglobal.com", "level": 3}
AMY = {"email": "amy@greensglobal.com", "level": 1}       # Tickets grant, company c1
BOB = {"email": "bob@greensglobal.com", "level": 1}       # no grants, company c2
NOW = datetime.now(timezone.utc)


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
        for m in (models.TaskChangelogEntry, models.TaskChangelogComment, models.ChangelogReaction,
                  models.ChangelogEntryView, models.ChangelogSeen, models.ChangelogEntryHistory,
                  models.ChangelogFeedback, models.ChangelogSubscription, models.NexusNotification,
                  models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusSetting,
                  models.HrEntity):
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

    def _ids(self, user):
        return sorted(e["id"] for e in T.list_changelog(user, self.db))

    def _bells(self, email, ref=None):
        q = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == email)
        if ref:
            q = q.filter(models.NexusNotification.ref_id == ref)
        return q.all()


class VisibilityTests(_Case):
    def test_audience_hidden_and_status(self):
        self._entry("all")
        self._entry("tickets-only", audience={"modules": ["tickets"]})
        self._entry("c2-only", audience={"companies": ["c2"]})
        self._entry("hidden", hidden=True)
        self._entry("draft", status="Draft")
        self._entry("amys-draft", status="Pending Review", authorId=AMY["email"])
        self.assertEqual(self._ids(AMY), ["all", "amys-draft", "tickets-only"])
        self.assertEqual(self._ids(BOB), ["all", "c2-only"])
        self.assertEqual(len(self._ids(ADMIN)), 6)

    def test_the_weekly_bar_counts_only_what_you_can_see(self):
        self._entry("feature-for-c2", type="New Feature", audience={"companies": ["c2"]})
        self.assertEqual(T.get_feature_banner(AMY, self.db), {"show": False})
        self.assertTrue(T.get_feature_banner(BOB, self.db)["show"])


class ScheduleAndHistoryTests(_Case):
    def test_a_scheduled_update_releases_itself(self):
        self._entry("later", status="Scheduled", scheduledFor=(NOW + timedelta(hours=2)).isoformat())
        self._entry("due", status="Scheduled", scheduledFor=ago(minutes=5))
        self.assertEqual(self._ids(AMY), ["due"])
        p = self.db.query(models.TaskChangelogEntry).filter_by(id="due").one().payload
        self.assertEqual((p["status"], p["publishedBy"]), ("Released", "schedule"))

    def test_edits_are_recorded_field_by_field(self):
        self._entry("e1", title="Old")
        T.update_changelog("e1", T.ChangelogEntryBody(payload={"title": "New", "type": "Bug Fix", "module": "Tickets",
                                                              "status": "Released", "releasedAt": ago(hours=1)}), ADMIN, self.db)
        T.publish_changelog("e1", ADMIN, self.db)
        rows = X.entry_history("e1", ADMIN, self.db)
        self.assertEqual([r["action"] for r in rows][-1], "edit")
        self.assertIn("republished", [r["action"] for r in rows])
        edit = next(r for r in rows if r["action"] == "edit")
        self.assertEqual(edit["changes"]["title"], ["Old", "New"])
        self.assertEqual(edit["by"], ADMIN["email"])


class NoticeTests(_Case):
    def test_followers_get_one_bell_row_updated_in_place(self):
        X.save_subscription(X.SubscriptionBody(modules=["Tickets"], categories=[]), AMY, self.db)
        X.save_subscription(X.SubscriptionBody(modules=["Tickets"]), BOB, self.db)
        self._entry("d1", status="Pending Review")
        self._entry("d2", status="Pending Review", audience={"modules": ["tickets"]})
        T.publish_pending_changelog(T.ChangelogPublishBody(), ADMIN, self.db)
        (row,) = self._bells(AMY["email"], reach.FOLLOW_REF)
        self.assertIn("2 new", row.body)
        (bob,) = self._bells(BOB["email"], reach.FOLLOW_REF)
        self.assertNotIn("d2", bob.body)                         # not aimed at Bob
        self._entry("d3", status="Pending Review")
        T.publish_changelog("d3", ADMIN, self.db)
        self.assertEqual(len(self._bells(AMY["email"], reach.FOLLOW_REF)), 1)

    def test_mentions_replies_and_your_own_update_ring_the_bell(self):
        self._entry("e1", authorId=ADMIN["email"])
        top = T.add_changelog_comment("e1", T.ChangelogCommentBody(body="Question @Bob", mentions=[BOB["email"]]), AMY, self.db)
        self.assertEqual(len(self._bells(BOB["email"], reach.COMMENT_REF + "e1")), 1)
        self.assertEqual(len(self._bells(ADMIN["email"], reach.COMMENT_REF + "e1")), 1)   # their update
        self.assertEqual(self._bells(AMY["email"]), [])                                   # never yourself
        reply = T.add_changelog_comment("e1", T.ChangelogCommentBody(body="Answer", parentId=top["id"]), BOB, self.db)
        self.assertEqual(reply["parentId"], top["id"])
        (amy,) = self._bells(AMY["email"], reach.COMMENT_REF + "e1")
        self.assertIn("replied", amy.title)
        deeper = T.add_changelog_comment("e1", T.ChangelogCommentBody(body="More", parentId=reply["id"]), AMY, self.db)
        self.assertEqual(deeper["parentId"], top["id"])                                    # one level of threads

    def test_an_empty_comment_or_a_foreign_parent_is_refused(self):
        self._entry("e1")
        self._entry("e2")
        other = T.add_changelog_comment("e2", T.ChangelogCommentBody(body="Hi"), AMY, self.db)
        for body in (T.ChangelogCommentBody(body="  "), T.ChangelogCommentBody(body="x", parentId=other["id"])):
            with self.assertRaises(HTTPException) as cm:
                T.add_changelog_comment("e1", body, AMY, self.db)
            self.assertEqual(cm.exception.status_code, 400)


class FeedbackBulkFeedTests(_Case):
    def test_helpful_is_one_vote_and_requests_are_listed(self):
        self._entry("e1")
        X.give_feedback("e1", X.FeedbackBody(helpful=True), AMY, self.db)
        out = X.give_feedback("e1", X.FeedbackBody(helpful=False), AMY, self.db)
        self.assertEqual(out, {"yes": 0, "no": 1, "mine": False})
        out = X.give_feedback("e1", X.FeedbackBody(helpful=False), AMY, self.db)       # same again = take back
        self.assertEqual(out["mine"], None)
        X.give_feedback("e1", X.FeedbackBody(kind="request", note="Export to Excel please"), BOB, self.db)
        (req,) = X.list_feedback(ADMIN, self.db)
        self.assertEqual((req["kind"], req["note"], req["entryTitle"]), ("request", "Export to Excel please", "e1"))
        with self.assertRaises(HTTPException):
            X.give_feedback("e1", X.FeedbackBody(kind="request", note=" "), BOB, self.db)

    def test_bulk_hide_pin_category_and_delete(self):
        for i in ("a", "b", "c"):
            self._entry(i)
        X.bulk_action(X.BulkBody(ids=["a", "b"], action="hide"), ADMIN, self.db)
        self.assertEqual(self._ids(AMY), ["c"])
        X.bulk_action(X.BulkBody(ids=["c"], action="pin"), ADMIN, self.db)
        X.bulk_action(X.BulkBody(ids=["c"], action="category", value="Improvement"), ADMIN, self.db)
        p = self.db.query(models.TaskChangelogEntry).filter_by(id="c").one().payload
        self.assertEqual((p["pinned"], p["type"]), (True, "Improvement"))
        self.assertIn("pinned", [r["action"] for r in X.entry_history("c", ADMIN, self.db)])
        X.bulk_action(X.BulkBody(ids=["a", "b"], action="delete"), ADMIN, self.db)
        self.assertEqual(self._ids(ADMIN), ["c"])
        with self.assertRaises(HTTPException):
            X.bulk_action(X.BulkBody(ids=["c"], action="category"), ADMIN, self.db)

    def test_the_feed_is_private_and_a_rotated_link_dies(self):
        self._entry("e1", title="Public & <Fun>")
        self._entry("secret", hidden=True)
        url = X.feed_link(AMY, self.db)["url"]
        token = url.rsplit("/", 1)[1][:-4]
        r = X.changelog_feed(token, self.db)
        body = r.body.decode()
        self.assertEqual(r.status_code, 200)
        self.assertIn("Public &amp; &lt;Fun&gt;", body)
        self.assertNotIn("secret", body)
        X.rotate_feed_link(AMY, self.db)
        self.assertEqual(X.changelog_feed(token, self.db).status_code, 404)
        self.assertEqual(X.changelog_feed("garbage", self.db).status_code, 404)

    def test_hints_name_the_screen_and_respect_the_audience(self):
        self._entry("h1", screen="tickets")
        self._entry("h2", screen="tickets", audience={"companies": ["c2"]})
        self._entry("old", screen="tickets", releasedAt=ago(days=20))
        self.assertEqual([h["id"] for h in X.changelog_hints("tickets", AMY, self.db)], ["h1"])
        self.assertEqual(X.changelog_hints("", AMY, self.db), [])


class SinceInsightsDigestTests(_Case):
    def test_since_your_last_visit_reads_the_visit_before(self):
        before = ago(days=2)
        self.db.add(models.ChangelogSeen(email=AMY["email"], last_seen_at=before, banner_seen_at=""))
        self.db.commit()
        self.assertEqual(X.changelog_me(AMY, self.db)["sinceAt"], before)
        T.mark_changelog_seen(AMY, self.db)                      # this visit starts
        self.assertEqual(X.changelog_me(AMY, self.db)["sinceAt"], before)   # still the visit before
        T.mark_changelog_seen(AMY, self.db)                      # same visit, a minute later
        self.assertEqual(X.changelog_me(AMY, self.db)["sinceAt"], before)

    def test_insights_read_rate_and_trends(self):
        self._entry("e1", audience={"modules": ["tickets"]})     # for Amy only
        self._entry("e2")                                        # for all three
        T.record_changelog_views(T.ChangelogViewsBody(ids=["e1", "e2"]), AMY, self.db)
        T.toggle_changelog_reaction("e2", T.ChangelogReactionBody(reaction="like"), BOB, self.db)
        X.give_feedback("e2", X.FeedbackBody(helpful=True), BOB, self.db)
        out = X.insights(ADMIN, self.db)
        self.assertEqual(out["entries"]["e1"]["readRate"], 100)
        self.assertEqual(out["entries"]["e2"]["readRate"], 33)
        self.assertEqual(out["topReacted"][0]["id"], "e2")
        self.assertEqual(len(out["trends"]), X.TREND_WEEKS)
        self.assertEqual(out["trends"][-1]["published"], 2)
        self.assertEqual(out["helpful"], {"yes": 1, "no": 0, "rate": 100})

    def test_the_monday_digest_goes_once_to_people_who_asked(self):
        self._entry("e1", title="Seen By All")
        self._entry("e2", title="For C2", audience={"companies": ["c2"]})
        X.save_subscription(X.SubscriptionBody(digest=True), AMY, self.db)
        X.save_subscription(X.SubscriptionBody(digest=False), BOB, self.db)
        monday = datetime(2026, 10, 19, 17, 0, tzinfo=timezone.utc)          # 10 AM Pacific
        with mock.patch("graph_mail.send_mail") as send:
            # the entries were released "an hour ago" relative to real now: put them in that week
            for e in self.db.query(models.TaskChangelogEntry).all():
                e.payload = {**e.payload, "releasedAt": (monday - timedelta(days=1)).isoformat()}
            self.db.commit()
            self.assertEqual(reach.send_digests_if_due(self.db, now=monday), 1)
            self.assertEqual(reach.send_digests_if_due(self.db, now=monday + timedelta(hours=1)), 0)   # once a week
            self.assertEqual(reach.send_digests_if_due(self.db, now=monday - timedelta(days=1)), 0)    # Sunday
        (call,) = send.call_args_list
        self.assertEqual(call.kwargs["to"], [AMY["email"]])
        self.assertIn("Seen By All", call.kwargs["html"])
        self.assertNotIn("For C2", call.kwargs["html"])


if __name__ == "__main__":
    unittest.main()
