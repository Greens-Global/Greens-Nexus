"""What's New publishing, reactions and analytics (Pranshu, Oct 16 2026) -
routers/task_config.py.

  - Merged work is drafted as Pending Review; publishing it stamps the release
    time, the publisher and (for a merge) the day's version.
  - Re-publishing an update that is already out moves it to now and counts it.
  - Publish All publishes only what waits in Pending Review.
  - One reaction per person: another kind replaces it, the same one takes it
    back; unknown kinds are refused.
  - Views count one row per person and update; analytics add them up.
  - Reactions and comment counts are read out, never saved into a payload.

Run with: python -m unittest test_changelog_publish_reactions -v
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import HTTPException     # noqa: E402

import database                       # noqa: E402
import models                         # noqa: E402
from routers import task_config as T  # noqa: E402

ADMIN = {"email": "Admin@greensglobal.com", "level": 3}
AMY = {"email": "amy@greensglobal.com", "level": 1}
BOB = {"email": "bob@greensglobal.com", "level": 1}


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
                  models.ChangelogEntryView, models.ChangelogSeen):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _entry(self, id_, **payload):
        base = {"title": id_, "type": "Bug Fix", "module": "Tasks"}
        self.db.add(models.TaskChangelogEntry(id=id_, payload={**base, **payload},
                                              created_at="2026-10-15T10:00:00+00:00", updated_at=""))
        self.db.commit()

    def _payload(self, id_):
        self.db.expire_all()
        return self.db.query(models.TaskChangelogEntry).filter_by(id=id_).one().payload


class PublishTests(_Case):
    def test_publishing_a_draft_stamps_the_release(self):
        self._entry("d1", origin="pr", status="Pending Review", version="10/01/2026")
        out = T.publish_changelog("d1", ADMIN, self.db)
        self.assertEqual(out["status"], "Released")
        p = self._payload("d1")
        self.assertTrue(p["releasedAt"])
        self.assertEqual(p["publishedBy"], "admin@greensglobal.com")
        self.assertEqual(p["version"], T._release_label())         # the day it went out
        self.assertNotIn("republishedAt", p)
        seen = self.db.query(models.ChangelogSeen).filter_by(email="admin@greensglobal.com").one()
        self.assertTrue(seen.last_seen_at)                          # no bar for their own publish

    def test_republishing_moves_it_to_now_and_counts(self):
        self._entry("r1", status="Released", releasedAt="2026-09-01T10:00:00+00:00", version="v2.0")
        T.publish_changelog("r1", ADMIN, self.db)
        p = self._payload("r1")
        self.assertGreater(p["releasedAt"], "2026-09-01T10:00:00+00:00")
        self.assertEqual((p["republishCount"], p["version"]), (1, "v2.0"))   # a typed version stays
        self.assertTrue(p["republishedAt"])

    def test_publish_all_takes_only_the_review_queue(self):
        self._entry("a", status="Pending Review")
        self._entry("b", origin="pr")                               # no status: a PR draft
        self._entry("c", status="Draft")
        self._entry("d", status="Released", releasedAt="2026-09-01T10:00:00+00:00")
        out = T.publish_pending_changelog(T.ChangelogPublishBody(), ADMIN, self.db)
        self.assertEqual(sorted(e["id"] for e in out["entries"]), ["a", "b"])
        self.assertEqual(self._payload("c")["status"], "Draft")
        self.assertEqual(self._payload("d")["releasedAt"], "2026-09-01T10:00:00+00:00")

    def test_publish_all_can_be_limited_to_some(self):
        self._entry("a", status="Pending Review")
        self._entry("b", status="Pending Review")
        T.publish_pending_changelog(T.ChangelogPublishBody(ids=["b"]), ADMIN, self.db)
        self.assertEqual((self._payload("a")["status"], self._payload("b")["status"]), ("Pending Review", "Released"))

    def test_an_unknown_update_is_404(self):
        with self.assertRaises(HTTPException) as cm:
            T.publish_changelog("nope", ADMIN, self.db)
        self.assertEqual(cm.exception.status_code, 404)


class ReactionTests(_Case):
    def test_a_reaction_toggles(self):
        self._entry("e1", status="Released")
        body = T.ChangelogReactionBody(reaction="like")
        self.assertEqual(T.toggle_changelog_reaction("e1", body, AMY, self.db),
                         {"reactions": {"like": 1}, "myReactions": ["like"]})
        T.toggle_changelog_reaction("e1", body, BOB, self.db)
        out = T.toggle_changelog_reaction("e1", body, AMY, self.db)          # Amy takes hers back
        self.assertEqual(out, {"reactions": {"like": 1}, "myReactions": []})

    def test_one_reaction_per_person_another_kind_replaces_it(self):
        self._entry("e1", status="Released")
        T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="like"), AMY, self.db)
        out = T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="love"), AMY, self.db)
        self.assertEqual(out, {"reactions": {"love": 1}, "myReactions": ["love"]})
        self.assertEqual(self.db.query(models.ChangelogReaction).count(), 1)

    def test_unknown_kinds_and_updates_are_refused(self):
        self._entry("e1", status="Released")
        with self.assertRaises(HTTPException) as cm:
            T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="angry"), AMY, self.db)
        self.assertEqual(cm.exception.status_code, 400)
        with self.assertRaises(HTTPException) as cm:
            T.toggle_changelog_reaction("gone", T.ChangelogReactionBody(reaction="like"), AMY, self.db)
        self.assertEqual(cm.exception.status_code, 404)

    def test_the_list_carries_reactions_and_comment_counts(self):
        self._entry("e1", status="Released")
        T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="celebrate"), AMY, self.db)
        T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="celebrate"), BOB, self.db)
        self.db.add(models.TaskChangelogComment(id="c1", entry_id="e1", author_email=BOB["email"], body="Nice"))
        self.db.commit()
        (e,) = T.list_changelog(AMY, self.db)
        self.assertEqual((e["reactions"], e["myReactions"], e["commentCount"]), ({"celebrate": 2}, ["celebrate"], 1))

    def test_a_save_never_stores_the_read_out_counts(self):
        self._entry("e1", status="Released")
        body = T.ChangelogEntryBody(payload={"title": "New words", "status": "Released",
                                             "reactions": {"like": 9}, "myReactions": ["like"], "commentCount": 4})
        T.update_changelog("e1", body, ADMIN, self.db)
        p = self._payload("e1")
        self.assertEqual(p["title"], "New words")
        for k in ("reactions", "myReactions", "commentCount"):
            self.assertNotIn(k, p)


class AnalyticsTests(_Case):
    def test_views_are_one_row_per_person_and_add_up(self):
        self._entry("e1", status="Released")
        self._entry("e2", status="Released")
        T.record_changelog_views(T.ChangelogViewsBody(ids=["e1", "e2", "e1", "missing"]), AMY, self.db)
        T.record_changelog_views(T.ChangelogViewsBody(ids=["e1"]), AMY, self.db)    # a reload: same visit
        self.assertEqual(self.db.query(models.ChangelogEntryView).filter_by(entry_id="e1").one().views, 1)
        # Back an hour later: a new view.
        row = self.db.query(models.ChangelogEntryView).filter_by(entry_id="e1").one()
        row.last_at = "2026-01-01T00:00:00+00:00"
        self.db.commit()
        T.record_changelog_views(T.ChangelogViewsBody(ids=["e1"]), AMY, self.db)
        T.record_changelog_views(T.ChangelogViewsBody(ids=["e1"]), BOB, self.db)
        T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="helpful"), BOB, self.db)
        out = T.changelog_analytics(ADMIN, self.db)
        self.assertEqual(out["entries"]["e1"]["viewers"], 2)
        self.assertEqual(out["entries"]["e1"]["views"], 3)
        self.assertEqual(out["entries"]["e2"]["views"], 1)
        self.assertNotIn("missing", out["entries"])
        self.assertEqual(out["totals"], {"peopleReached": 2, "views": 4, "reactions": 1, "reactors": 1, "comments": 0})
        one = T.changelog_entry_analytics("e1", ADMIN, self.db)
        self.assertEqual(sorted(v["email"] for v in one["viewers"]), [AMY["email"], BOB["email"]])
        self.assertEqual(one["reactions"][0]["reaction"], "helpful")

    def test_deleting_an_update_clears_its_reactions_and_views(self):
        self._entry("e1", status="Released")
        T.record_changelog_views(T.ChangelogViewsBody(ids=["e1"]), AMY, self.db)
        T.toggle_changelog_reaction("e1", T.ChangelogReactionBody(reaction="love"), BOB, self.db)
        T.delete_changelog("e1", self.db)
        self.assertEqual(self.db.query(models.ChangelogReaction).count(), 0)
        self.assertEqual(self.db.query(models.ChangelogEntryView).count(), 0)


if __name__ == "__main__":
    unittest.main()
