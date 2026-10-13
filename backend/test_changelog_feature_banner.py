"""Update announcements (Neil, Oct 12 2026) - routers/task_config.py.

  - The weekly bar is raised by a New Feature released in the last 7 days that
    this person has not seen; bug fixes alone never raise it, but once it shows
    it counts every category since they last looked - bug fixes included.
  - Opening What's New after the release, or dismissing the bar, hides it; a
    dismissal keeps it away for 7 days even when another feature ships.
  - The new-version popup's question: what came after the running build, by
    category - a merge placed by its merge time, not its publish time.
  - Legacy hand-written times (no zone) read as Pacific; the parsed list is
    cached until the table changes; a lost insert race does not 500.

Run with: python -m unittest test_changelog_feature_banner -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import database                       # noqa: E402
import models                         # noqa: E402
from routers import task_config as T  # noqa: E402

NOW = datetime(2026, 10, 13, 0, 50, tzinfo=timezone.utc)      # 5:50 PM Oct 12 in California
ME = {"email": "amy@greensglobal.com", "level": 1}


class _FrozenDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


def ago(**kw) -> str:
    return (NOW - timedelta(**kw)).isoformat()


class _Case(unittest.TestCase):
    """Shared setup: a fresh table, the clock frozen, the parsed list reset."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.TaskChangelogEntry).delete()
        self.db.query(models.ChangelogSeen).delete()
        self.db.query(models.NexusNotification).delete()
        self.db.commit()
        T._released_cache.update(key=None, rows=[])
        for p in (mock.patch.object(T, "datetime", _FrozenDT),
                  mock.patch.object(T, "now_iso", lambda: NOW.isoformat())):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.close()

    def _entry(self, title, released_at, type_="New Feature", status="Released", merged_at=""):
        n = self.db.query(models.TaskChangelogEntry).count()
        payload = {"title": title, "type": type_, "status": status, "module": "Tasks", "releasedAt": released_at}
        if merged_at:
            payload["mergedAt"] = merged_at
        self.db.add(models.TaskChangelogEntry(id=f"e{n}", created_at=released_at, updated_at=released_at, payload=payload))
        self.db.commit()

    def _seen(self, last_seen_at="", banner_seen_at=""):
        self.db.add(models.ChangelogSeen(email=ME["email"], last_seen_at=last_seen_at, banner_seen_at=banner_seen_at))
        self.db.commit()

    def _banner(self):
        self.db.expire_all()
        return T.get_feature_banner(user=ME, db=self.db)


class AnnouncementTests(_Case):
    # ── the weekly bar ─────────────────────────────────────────────────────
    def test_a_new_feature_raises_it_and_it_counts_every_category(self):
        self._entry("Scorecard emails", ago(hours=2))
        self._entry("Older feature", ago(days=3))
        self._entry("A fix", ago(hours=1), type_="Bug Fix")
        self._entry("Another fix", ago(days=1), type_="Bug Fix")
        r = self._banner()
        self.assertTrue(r["show"])
        self.assertEqual((r["counts"], r["total"]), ({"New Feature": 2, "Bug Fix": 2}, 4))

    def test_bug_fixes_alone_unreleased_and_old_features_never_raise_it(self):
        self._entry("A fix", ago(hours=1), type_="Bug Fix")
        self._entry("Waiting", ago(hours=1), status="Pending Review")
        self._entry("Last month", ago(days=8))
        self.assertEqual(self._banner(), {"show": False})

    def test_opening_whats_new_after_the_release_hides_it(self):
        self._entry("Scorecard emails", ago(hours=2))
        self._seen(last_seen_at=ago(hours=1))
        self.assertFalse(self._banner()["show"])

    def test_it_counts_only_what_came_after_the_last_visit(self):
        self._entry("Seen already", ago(days=2))
        self._entry("A fix since", ago(hours=3), type_="Bug Fix")
        self._entry("New since", ago(hours=2))
        self._seen(last_seen_at=ago(days=1))
        r = self._banner()
        self.assertEqual((r["counts"], r["total"]), ({"Bug Fix": 1, "New Feature": 1}, 2))

    def test_a_dismissal_keeps_it_away_for_a_week_even_when_another_ships(self):
        self._entry("First", ago(days=2))
        T.dismiss_feature_banner(user=ME, db=self.db)          # stamped at NOW
        self.assertFalse(self._banner()["show"])
        self._entry("Second", ago(minutes=5))
        self.assertFalse(self._banner()["show"])               # still the same week

    def test_after_the_week_a_newer_feature_brings_it_back(self):
        self._seen(banner_seen_at=ago(days=8))
        self._entry("Before the dismissal", ago(days=9))
        self.assertFalse(self._banner()["show"])
        self._entry("New this week", ago(days=1))
        r = self._banner()
        self.assertEqual((r["show"], r["total"]), (True, 1))

    def test_a_legacy_hand_written_time_is_read_as_pacific(self):
        at = T._changelog_instant("2026-10-12T15:00")          # 3 PM in California
        self.assertEqual(at, datetime(2026, 10, 12, 22, 0, tzinfo=timezone.utc))
        self._entry("Typed by hand", "2026-10-12T15:00")
        self.assertTrue(self._banner()["show"])

    # ── the new-version popup ──────────────────────────────────────────────
    def test_released_since_counts_by_category_after_the_build(self):
        build = ago(hours=1)
        self._entry("In the running build", ago(hours=3))
        self._entry("A fix since", ago(minutes=20), type_="Bug Fix")
        self._entry("A feature since", ago(minutes=10))
        r = T.get_released_since(since=build, user=ME, db=self.db)
        self.assertEqual(r, {"counts": {"Bug Fix": 1, "New Feature": 1}, "total": 2})

    def test_a_merge_is_placed_by_its_merge_time_not_its_publish_time(self):
        build = ago(minutes=30)
        # Merged before the build was cut, published after it: already running.
        self._entry("Merged before", ago(minutes=5), merged_at=ago(minutes=40))
        # Merged after the build: new in the waiting version.
        self._entry("Merged after", ago(minutes=5), merged_at=ago(minutes=10))
        r = T.get_released_since(since=build, user=ME, db=self.db)
        self.assertEqual((r["total"], r["counts"]), (1, {"New Feature": 1}))

    # ── plumbing ───────────────────────────────────────────────────────────
    def test_the_parsed_list_is_reused_until_the_table_changes(self):
        self._entry("One", ago(hours=1))
        first = T._released_updates(self.db)
        self.assertIs(T._released_updates(self.db), first)                # unchanged: cached
        self._entry("Two", ago(minutes=30))
        self.assertEqual(len(T._released_updates(self.db)), 2)            # a new row: re-read

    def test_a_lost_insert_race_reads_the_winner_instead_of_failing(self):
        other = database.SessionLocal()
        other.add(models.ChangelogSeen(email=ME["email"], last_seen_at="x", banner_seen_at=""))
        other.commit()
        other.close()
        real_query = self.db.query
        calls = {"n": 0}

        def stale_first_lookup(*args, **kwargs):
            q = real_query(*args, **kwargs)
            if args and args[0] is models.ChangelogSeen and calls["n"] == 0:
                calls["n"] += 1
                return mock.Mock(filter=lambda *a, **k: mock.Mock(first=lambda: None))
            return q
        with mock.patch.object(self.db, "query", side_effect=stale_first_lookup):
            row = T._seen_row(self.db, ME["email"])
        self.assertEqual(row.last_seen_at, "x")


class BellTests(_Case):
    """The week's news is kept in the notification bell too (Neil, Oct 12
    2026), so a person who dismissed the bar can still find it there."""

    def _notices(self):
        self.db.expire_all()
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.ref_id == T.WHATS_NEW_NOTICE_REF).all())

    def test_while_the_bar_announces_it_the_bell_copy_is_already_read(self):
        self._entry("Scorecard", ago(hours=2))
        self._entry("A fix", ago(hours=1), type_="Bug Fix")
        self.assertTrue(self._banner()["show"])
        [n] = self._notices()
        self.assertEqual((n.recipient, n.type, n.title), (ME["email"], "whats_new", "New in Nexus"))
        self.assertEqual(n.body, "Updates this week, including 1 New Feature and 1 Bug Fix.")
        self.assertIn(ME["email"], n.read_by)                     # no toast, no badge on top of the bar
        self.assertEqual(json.loads(n.action), {"view": "whats-new"})

    def test_with_the_bar_away_for_the_week_new_releases_come_back_unread(self):
        self._entry("First", ago(days=2))
        self._banner()
        T.dismiss_feature_banner(user=ME, db=self.db)
        self._entry("Second", ago(minutes=5))
        self.assertFalse(self._banner()["show"])                  # the bar stays away...
        [n] = self._notices()                                      # ...one row, updated in place...
        self.assertEqual(n.body, "Updates this week, including 2 New Features.")
        self.assertEqual(n.read_by, "")                           # ...and the bell tells them

    def test_unchanged_news_is_left_alone_and_a_cleared_copy_comes_back_for_new_news(self):
        self._entry("First", ago(days=2))
        self._banner()
        [n] = self._notices()
        n.closed_by, stamp = ME["email"], n.created_at
        self.db.commit()
        self._banner()
        self.assertEqual((self._notices()[0].created_at, self._notices()[0].closed_by), (stamp, ME["email"]))
        self._entry("Second", ago(minutes=5))
        self._banner()
        self.assertEqual(self._notices()[0].closed_by, "")

    def test_opening_whats_new_marks_it_read(self):
        self._entry("First", ago(days=2))
        T.dismiss_feature_banner(user=ME, db=self.db)
        self._banner()
        self.assertEqual(self._notices()[0].read_by, "")
        T.mark_changelog_seen(user=ME, db=self.db)
        self.assertIn(ME["email"], self._notices()[0].read_by)

    def test_bug_fixes_alone_never_reach_the_bell(self):
        self._entry("A fix", ago(hours=1), type_="Bug Fix")
        self._banner()
        self.assertEqual(self._notices(), [])


class ReadAccessTests(unittest.TestCase):
    """Reading What's New is every Nexus user's default; changing it is the
    task family's grant (Neil, Oct 12 2026)."""

    def _routes(self, router):
        return {(next(iter(r.methods)), r.path) for r in router.routes}

    def test_the_read_routes_need_only_a_signed_in_user(self):
        reads = {("GET", "/task-changelog"), ("GET", "/task-changelog/unseen"), ("POST", "/task-changelog/seen"),
                 ("GET", "/task-changelog/feature-banner"), ("POST", "/task-changelog/feature-banner/dismiss"),
                 ("GET", "/task-changelog/released-since"), ("GET", "/task-changelog/{entry_id}/comments")}
        self.assertTrue(reads <= self._routes(T.view_router))
        self.assertFalse(reads & self._routes(T.router))
        deps = [d.dependency.__qualname__ for d in T.view_router.dependencies]
        self.assertFalse(any("_check" in d for d in deps))              # no module-grant check

    def test_every_write_stays_behind_the_grant(self):
        writes = {("POST", "/task-changelog"), ("PATCH", "/task-changelog/{entry_id}"),
                  ("DELETE", "/task-changelog/{entry_id}"), ("POST", "/task-changelog/{entry_id}/comments")}
        self.assertTrue(writes <= self._routes(T.router))
        self.assertFalse(writes & self._routes(T.view_router))

    def test_externals_reach_the_read_side(self):
        import auth
        self.assertIn("/task-changelog", auth._EXTERNAL_BASE_PREFIXES)


if __name__ == "__main__":
    unittest.main()
