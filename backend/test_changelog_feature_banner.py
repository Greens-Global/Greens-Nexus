"""New Feature announcements (Neil, Oct 12 2026) - routers/task_config.py.

  - The weekly bar shows for a New Feature released in the last 7 days that
    this person has not seen; bug fixes and unreleased updates never raise it.
  - Opening What's New after the release, or dismissing the bar, hides it; a
    dismissal keeps it away for 7 days even when another feature ships, and
    a feature released after the week is up brings it back.
  - The new-version popup's question: New Features released since a time.

Run with: python -m unittest test_changelog_feature_banner -v
"""
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


class FeatureBannerTests(unittest.TestCase):
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
        self.db.commit()
        for p in (mock.patch.object(T, "datetime", _FrozenDT),
                  mock.patch.object(T, "now_iso", lambda: NOW.isoformat())):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.close()

    def _entry(self, title, released_at, type_="New Feature", status="Released"):
        n = self.db.query(models.TaskChangelogEntry).count()
        self.db.add(models.TaskChangelogEntry(id=f"e{n}", created_at=released_at, updated_at=released_at, payload={
            "title": title, "type": type_, "status": status, "module": "Tasks", "releasedAt": released_at}))
        self.db.commit()

    def _seen(self, last_seen_at="", banner_seen_at=""):
        self.db.add(models.ChangelogSeen(email=ME["email"], last_seen_at=last_seen_at, banner_seen_at=banner_seen_at))
        self.db.commit()

    def _banner(self):
        self.db.expire_all()
        return T.get_feature_banner(user=ME, db=self.db)

    def test_a_new_feature_this_week_shows_with_the_count_of_others(self):
        self._entry("Older feature", ago(days=3))
        self._entry("Scorecard emails", ago(hours=2))
        r = self._banner()
        self.assertTrue(r["show"])
        self.assertEqual((r["feature"]["title"], r["more"]), ("Scorecard emails", 1))

    def test_bug_fixes_unreleased_and_old_features_never_raise_it(self):
        self._entry("A fix", ago(hours=1), type_="Bug Fix")
        self._entry("Waiting", ago(hours=1), status="Pending Review")
        self._entry("Last month", ago(days=8))
        self.assertEqual(self._banner(), {"show": False})

    def test_opening_whats_new_after_the_release_hides_it(self):
        self._entry("Scorecard emails", ago(hours=2))
        self._seen(last_seen_at=ago(hours=1))
        self.assertFalse(self._banner()["show"])

    def test_a_visit_before_the_release_does_not(self):
        self._entry("Scorecard emails", ago(hours=2))
        self._seen(last_seen_at=ago(days=2))
        self.assertTrue(self._banner()["show"])

    def test_a_dismissal_keeps_it_away_for_a_week_even_when_another_ships(self):
        self._entry("First", ago(days=2))
        T.dismiss_feature_banner(user=ME, db=self.db)          # stamped at NOW
        self.assertFalse(self._banner()["show"])
        self._entry("Second", ago(minutes=5))
        self.assertFalse(self._banner()["show"])               # still the same week

    def test_after_the_week_a_newer_feature_brings_it_back(self):
        self._seen(banner_seen_at=ago(days=8))
        self._entry("Before the dismissal", ago(days=9))       # outside the week anyway
        self.assertFalse(self._banner()["show"])
        self._entry("New this week", ago(days=1))
        r = self._banner()
        self.assertTrue(r["show"])
        self.assertEqual((r["feature"]["title"], r["more"]), ("New this week", 0))

    def test_a_hand_written_local_time_still_counts(self):
        self._entry("Typed by hand", "2026-10-12T15:00")       # no zone: browser wall time
        self.assertTrue(self._banner()["show"])

    def test_new_features_since_a_time_for_the_version_popup(self):
        self._entry("Before the tab loaded", ago(hours=5))
        self._entry("A fix", ago(minutes=10), type_="Bug Fix")
        self._entry("Shipped since", ago(minutes=10))
        r = T.get_new_features(since=ago(hours=1), user=ME, db=self.db)
        self.assertEqual((r["count"], r["latest"]["title"]), (1, "Shipped since"))
        self.assertEqual(T.get_new_features(since=ago(minutes=1), user=ME, db=self.db)["count"], 0)


if __name__ == "__main__":
    unittest.main()
