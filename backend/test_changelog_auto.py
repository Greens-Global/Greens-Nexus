"""Automatic "What's New" drafting - the schedule that has to survive restarts.

The generation itself is the button's code path, already exercised by hand. What
is worth testing is the part that is new and invisible: the due time is PERSISTED,
because merging to dev restarts the dev API several times a day and a loop that
slept 24 hours from boot would be killed at hour 3 every time and never fire once.
So: a fresh install generates, a restart inside the interval does not, a failure
backs off instead of re-firing every poll, and the interval elapsing fires again.

Run with: python -m unittest test_changelog_auto -v
"""
import os
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import httpx

import database
import models
import changelog_auto
import changelog_prs
from routers import task_config

# A test that DELETES rows must prove its own isolation before it deletes any.
#
# unittest runs every module named on one command line in ONE process, so
# `import database` happens once: whichever module is imported FIRST fixes
# DATABASE_URL for all of them, and the assignment above is a dead letter for
# the rest. Run after a module that does not set it (test_app_boot does not),
# and these setUp() deletes land in the developer's real local greens_nexus.db.
# That is not hypothetical - it happened on 2026-09-07 and took the local task,
# project and portfolio rows with it. So the binding is checked, not assumed.
def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()


class ScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        db = database.SessionLocal()
        db.query(models.NexusSetting).filter(
            models.NexusSetting.key == changelog_auto._STATE_KEY).delete()
        db.commit()
        db.close()
        self.calls = []
        self._real = task_config.generate_changelog_from_commits

    def tearDown(self):
        task_config.generate_changelog_from_commits = self._real

    def _stub(self, created=2, boom=None, error=None):
        def fake(db, author_email=""):
            self.calls.append(author_email)
            if boom:
                raise boom
            if error:
                return {"error": error}     # how the shared core reports a
                                            # missing key - it does not raise
            return {"created": created, "scanned": 7, "source": "github"}
        task_config.generate_changelog_from_commits = fake

    def _state(self) -> dict:
        db = database.SessionLocal()
        try:
            return changelog_auto._read_state(db)
        finally:
            db.close()

    def _set_next_run(self, when: datetime):
        db = database.SessionLocal()
        try:
            changelog_auto._write_state(db, {"next_run_at": when.isoformat()})
        finally:
            db.close()

    def test_first_sweep_generates_and_schedules_the_next(self):
        self._stub(created=2)
        result = changelog_auto._sweep()
        self.assertEqual(result["created"], 2)
        self.assertEqual(len(self.calls), 1)
        nxt = datetime.fromisoformat(self._state()["next_run_at"])
        # Default interval is 24h; allow slack for the clock between the two reads.
        self.assertGreater(nxt, datetime.now(timezone.utc) + timedelta(hours=23))
        self.assertLess(nxt, datetime.now(timezone.utc) + timedelta(hours=25))

    def test_restart_inside_the_interval_does_not_regenerate(self):
        self._stub()
        changelog_auto._sweep()
        self.assertEqual(len(self.calls), 1)
        # Every later poll (and every process restart - the state is in the DB,
        # not in memory) is a no-op until the due time passes.
        self.assertIsNone(changelog_auto._sweep())
        self.assertIsNone(changelog_auto._sweep())
        self.assertEqual(len(self.calls), 1)

    def test_due_time_elapsed_fires_again(self):
        self._stub()
        changelog_auto._sweep()
        self._set_next_run(datetime.now(timezone.utc) - timedelta(minutes=1))
        changelog_auto._sweep()
        self.assertEqual(len(self.calls), 2)

    def test_failure_backs_off_instead_of_retrying_every_poll(self):
        self._stub(error="AI is not configured (ANTHROPIC_API_KEY missing).")
        self.assertIn("error", changelog_auto._sweep())
        state = self._state()
        self.assertIn("ANTHROPIC_API_KEY", state["last_error"])
        nxt = datetime.fromisoformat(state["next_run_at"])
        self.assertGreater(nxt, datetime.now(timezone.utc) + timedelta(minutes=30))
        # The next poll must not re-spend the Anthropic call.
        self.assertIsNone(changelog_auto._sweep())
        self.assertEqual(len(self.calls), 1)

    def test_an_unexpected_exception_backs_off_rather_than_killing_the_loop(self):
        self._stub(boom=ValueError("kaboom"))
        result = changelog_auto._sweep()
        self.assertIn("kaboom", result["error"])
        nxt = datetime.fromisoformat(self._state()["next_run_at"])
        self.assertGreater(nxt, datetime.now(timezone.utc) + timedelta(minutes=30))

    def test_generated_drafts_are_stamped_with_the_configured_author(self):
        os.environ["NEXUS_CHANGELOG_AUTHOR"] = "Nexus@Greensglobal.com"
        try:
            self._stub()
            changelog_auto._sweep()
            self.assertEqual(self.calls, ["nexus@greensglobal.com"])
        finally:
            os.environ.pop("NEXUS_CHANGELOG_AUTHOR", None)


def _pr(number, title="Workday: exempt people never see the clock", branch="fix/workday-exempt",
        body="## What\n\nSalaried people no longer see the time clock card while it loads.\n\n"
             "- The clock card never appears for exempt people\n- Docs updated\n\n## Test plan\n\n- [x] vitest",
        files=("frontend/src/tasks/TimeClock.jsx",)):
    return {"key": f"pr:{number}", "kind": "pr", "sha": f"sha{number}", "number": number, "title": title, "branch": branch, "body": body, "files": list(files),
            "commits": ["Workday: hide the clock"], "url": f"https://github.com/x/y/pull/{number}",
            "developers": [{"login": "pranshuup", "name": "Pranshu Pandey", "url": "https://github.com/pranshuup"}]}


class PublishTests(unittest.TestCase):
    """Every merged feature PR is PUBLISHED, with or without Claude. Claude only
    rewrites the wording - an Anthropic account out of credit (Jul-Oct 2026)
    used to stop What's New entirely."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        db = database.SessionLocal()
        db.query(models.NexusSetting).filter(models.NexusSetting.key == changelog_auto._STATE_KEY).delete()
        db.query(models.TaskChangelogEntry).delete()
        db.commit()
        db.close()
        self.prs = [_pr(480)]
        self.fetched = []

        def fake_fetch(branch, cursor, known):
            self.fetched.append((branch, cursor, set(known)))
            return [p for p in self.prs if p["key"] not in known], "headsha1"
        self.polish = mock.Mock(side_effect=changelog_prs.PolishError("HTTP 400: Your credit balance is too low"))
        for name, v in (("fetch_merged_prs", fake_fetch), ("polish", self.polish)):
            p = mock.patch.object(changelog_prs, name, v)
            p.start()
            self.addCleanup(p.stop)

    def _entries(self):
        db = database.SessionLocal()
        try:
            return [e.payload for e in db.query(models.TaskChangelogEntry).all()]
        finally:
            db.close()

    def _generate(self):
        db = database.SessionLocal()
        try:
            return task_config.generate_changelog_from_commits(db, "admin@greensglobal.com")
        finally:
            db.close()

    def _status(self):
        db = database.SessionLocal()
        try:
            return changelog_auto.status(db)
        finally:
            db.close()

    def test_without_claude_the_pr_is_published_in_its_own_words(self):
        out = self._generate()
        self.assertNotIn("error", out)
        self.assertEqual(out["created"], 1)
        self.assertIn("credit balance", out["polishNote"])
        (p,) = self._entries()
        self.assertEqual(p["status"], "Released")                  # no review queue
        self.assertEqual((p["prNumber"], p["prRef"], p["module"], p["type"]), (480, "#480", "Workday", "Bug Fix"))
        self.assertEqual(p["title"], "Exempt people never see the clock")
        self.assertIn("Salaried people", p["description"])
        self.assertEqual(p["whatsChanged"], ["The clock card never appears for exempt people"])
        self.assertIn("credit balance", self._status()["polishNote"])
        # The developer is GitHub's, not the admin who ran the check.
        self.assertEqual(p["authorId"], "")
        self.assertEqual([d["login"] for d in p["developers"]], ["pranshuup"])

    def test_claude_rewords_and_can_hold_back_an_internal_pr(self):
        self.prs = [_pr(480), _pr(481, title="Deploy: faster health probe")]
        self.polish.side_effect = None
        self.polish.return_value = [
            {"userFacing": True, "title": "Time Clock Hidden for Salaried Staff", "description": "Plain words.",
             "type": "Improvement", "module": "Workday", "businessImpact": "Less confusion.", "whatsChanged": ["One"]},
            {"userFacing": False, "title": "", "description": "", "type": "", "module": "",
             "businessImpact": "", "whatsChanged": []},
        ]
        out = self._generate()
        self.assertEqual((out["created"], out["skipped"], out["polishNote"]), (1, 1, ""))
        (p,) = self._entries()
        self.assertEqual((p["title"], p["type"], p["businessImpact"]),
                         ("Time Clock Hidden for Salaried Staff", "Improvement", "Less confusion."))

    def test_a_pr_is_published_once_and_the_cursor_moves(self):
        self._generate()
        out = self._generate()
        self.assertEqual(out["created"], 0)
        self.assertEqual(out["message"], "No new changes since the last update.")
        self.assertEqual(len(self._entries()), 1)
        self.assertEqual(self.fetched[1][1], "headsha1")           # read from where the last run stopped
        self.assertIn("pr:480", self.fetched[1][2])

    def test_ci_only_prs_are_skipped_and_remembered(self):
        self.prs = [_pr(457, title="Prod deploy: vault key", files=(".github/workflows/x.yml",))]
        out = self._generate()
        self.assertEqual((out["created"], out["skipped"]), (0, 1))
        self.assertEqual(self._entries(), [])
        self._generate()
        self.assertIn("pr:457", self.fetched[1][2])                # not reconsidered next run

    def test_github_unreadable_is_the_only_error(self):
        with mock.patch.object(changelog_prs, "fetch_merged_prs",
                               side_effect=changelog_prs.GitHubError("GITHUB_TOKEN is not set on this server.")):
            out = self._generate()
        self.assertIn("GITHUB_TOKEN", out["error"])
        self.assertEqual(self._entries(), [])

    def test_the_sweep_records_a_github_failure_and_retries_within_the_hour(self):
        with mock.patch.object(changelog_prs, "fetch_merged_prs",
                               side_effect=changelog_prs.GitHubError("HTTP 502")):
            result = changelog_auto._sweep()
        self.assertIn("HTTP 502", result["error"])
        st = self._status()
        self.assertIn("HTTP 502", st["lastError"])
        self.assertEqual(st["lastRunAt"], "")
        nxt = datetime.fromisoformat(st["nextRunAt"])
        self.assertLess(nxt, datetime.now(timezone.utc) + timedelta(hours=1, minutes=5))

    def _click(self):
        db = database.SessionLocal()
        try:
            return task_config.generate_changelog(user={"email": "admin@greensglobal.com"}, db=db)
        finally:
            db.close()

    def test_a_failed_click_shows_on_the_status_line_and_leaves_the_schedule(self):
        db = database.SessionLocal()
        changelog_auto._write_state(db, {"next_run_at": "2026-10-08T02:05:00+00:00"})
        db.close()
        with mock.patch.object(changelog_prs, "fetch_merged_prs",
                               side_effect=changelog_prs.GitHubError("HTTP 401")):
            with self.assertRaises(task_config.HTTPException) as cm:
                self._click()
        self.assertEqual(cm.exception.status_code, 503)
        st = self._status()
        self.assertIn("HTTP 401", st["lastError"])
        self.assertEqual(st["nextRunAt"], "2026-10-08T02:05:00+00:00")

    def test_a_good_click_clears_the_error(self):
        db = database.SessionLocal()
        changelog_auto._write_state(db, {"last_error": "old trouble"})
        db.close()
        self._click()
        st = self._status()
        self.assertEqual((st["lastError"], st["lastReason"], st["lastCreated"]), ("", "manual", 1))


class PrReadingTests(unittest.TestCase):
    """changelog_prs on its own: which commits are PRs, what is skipped, and
    what an entry looks like before any AI."""

    def _commit(self, sha, message, parents=2):
        return {"sha": sha, "commit": {"message": message},
                "parents": [{"sha": f"{sha}p{i}"} for i in range(parents)]}

    def test_every_way_work_lands_on_dev_is_a_change_releases_are_not(self):
        refs = changelog_prs._change_refs([
            self._commit("a", "Merge pull request #480 from Greens-Global/fix/workday\n\nWorkday: x"),
            self._commit("b", "Merge pull request #470 from Greens-Global/dev\n\nRelease 10/07"),
            self._commit("c", "Merge remote-tracking branch 'origin/dev' into feature/nexus-sagar"),
            self._commit("d", "Ledger: operators (#467)", parents=1),
            self._commit("e1234567x", "Shifts: full names for shift types", parents=1),
            self._commit("f1234567x", "Merge branch 'feat/hr-checklists' into dev - onboarding checklists per person"),
            self._commit("g1234567x", "Merge branch 'main' into dev"),
        ])
        self.assertEqual([(r["key"], r.get("title", "")) for r in refs], [
            ("pr:480", ""), ("pr:467", ""), ("commit:e1234567", "Shifts: full names for shift types"),
            ("merge:f1234567", "onboarding checklists per person")])

    def test_mainline_skips_feature_branch_commits_and_walks_into_a_release(self):
        def c(sha, subject, parents, when):
            return {"sha": sha, "commit": {"message": subject, "committer": {"date": when}},
                    "parents": [{"sha": p} for p in parents]}
        # main: m2 (release of dev) <- m1 ; dev line: d3 (PR merge) <- d2 (direct) <- d1.
        # f1 lives inside the feature branch that d3 merged.
        commits = [
            c("m2", "Merge pull request #470 from Greens-Global/dev", ["m1", "d3"], "2026-10-09T05"),
            c("d3", "Merge pull request #480 from Greens-Global/fix/x", ["d2", "f1"], "2026-10-09T04"),
            c("f1", "Hide the clock", ["d1"], "2026-10-09T02"),
            c("d2", "Shifts: names", ["d1"], "2026-10-09T03"),
        ]
        line = changelog_prs._mainline(commits, "m2")
        self.assertEqual([x["sha"] for x in line], ["d2", "d3", "m2"])
        # Each change carries when it landed, which orders a run's entries.
        self.assertEqual([r["date"] for r in changelog_prs._change_refs(line)], ["2026-10-09T03", "2026-10-09T04"])
        self.assertEqual([r["key"] for r in changelog_prs._change_refs(line)], ["commit:d2", "pr:480"])

    def test_a_run_of_direct_commits_by_one_developer_is_one_update(self):
        def c(sha, subject, who):
            return {"sha": sha, "commit": {"message": subject}, "parents": [{"sha": "x"}], "author": {"login": who}}
        refs = changelog_prs._change_refs([
            c("a1111111", "Shifts: full names", "Vlow2k"),
            c("b2222222", "Shifts: month view faces", "Vlow2k"),
            c("c3333333", "Shifts: full names", "Vlow2k"),            # the same commit pushed again
            c("d4444444", "Checklists: overview board", "pranshuup"),
        ])
        self.assertEqual([(r["kind"], r["key"]) for r in refs], [("push", "commit:a1111111"), ("commit", "commit:d4444444")])
        self.assertEqual(refs[0]["subjects"], ["Shifts: full names", "Shifts: month view faces"])
        d = changelog_prs.draft({"kind": "push", "title": refs[0]["title"], "commits": refs[0]["subjects"], "files": []})
        self.assertEqual((d["title"], d["module"]), ("Shifts Updates", "Shifts"))
        self.assertEqual(d["whatsChanged"], ["Full names", "Month view faces"])

    def test_a_direct_commit_is_published_in_its_own_words(self):
        d = changelog_prs.draft({"key": "commit:ab", "kind": "commit", "number": None, "branch": "",
                                 "title": "Shifts: shift types show their full names",
                                 "body": "", "files": ["frontend/src/a.jsx"], "commits": []})
        self.assertEqual((d["module"], d["title"]), ("Shifts", "Shift types show their full names"))

    def test_skip_rules(self):
        self.assertEqual(changelog_prs.skip_reason(_pr(1, files=(".github/workflows/a.yml", "docs/x.md"))),
                         "only CI, docs or tests")
        self.assertEqual(changelog_prs.skip_reason(_pr(1, files=("backend/test_x.py", "frontend/src/a.test.jsx"))),
                         "only CI, docs or tests")
        self.assertEqual(changelog_prs.skip_reason(_pr(1, body="tidy [skip changelog]")), "marked [skip changelog]")
        self.assertEqual(changelog_prs.skip_reason(_pr(1, title="chore: bump deps")), "chore")
        self.assertEqual(changelog_prs.skip_reason(_pr(1)), "")
        self.assertEqual(changelog_prs.skip_reason(_pr(1, files=())), "")     # files unknown: publish

    def test_types(self):
        t = changelog_prs._change_type
        self.assertEqual(t("Anything", "hotfix/x"), "Hotfix")
        self.assertEqual(t("Rows per Page works", "fix/x"), "Bug Fix")
        self.assertEqual(t("Security: tighter cookies", "feature/x"), "Security Update")
        self.assertEqual(t("Reports load faster", "chore/x"), "Performance")
        self.assertEqual(t("Big clock", "feat/x"), "New Feature")
        self.assertEqual(t("Tidier wording", "feature-x"), "Improvement")

    def test_draft_drops_reviewer_notes(self):
        d = changelog_prs.draft(_pr(9, title="Loans: Browse Egnyte in the open loan", body=(
            "Charmi 10/07 (Priyanka: not done): the open loan row read `No documents folder` with nothing "
            "to click. It now has a Browse button next to each missing folder.\n\n"
            "- Browse for a missing `statements_folder` right in the loan (Charmi, 10/07)\n"
            "- Tests: test_loans 12 pass\n"), files=("backend/routers/loans.py",)))
        self.assertEqual((d["module"], d["title"]), ("Loans", "Browse Egnyte in the open loan"))
        self.assertTrue(d["description"].startswith("The open loan row read No documents folder"))
        self.assertEqual(d["whatsChanged"], ["Browse for a missing statements_folder right in the loan"])

    def test_no_description_falls_back_to_the_title_and_commits(self):
        d = changelog_prs.draft({"number": 3, "title": "Role editor: near full-screen", "branch": "feat/x",
                                 "body": "", "files": [], "commits": ["Wider role editor", "Merge branch dev"]})
        self.assertEqual(d["description"], "Near full-screen.")
        self.assertEqual(d["whatsChanged"], ["Wider role editor"])

    def test_developers_are_the_pr_author_then_other_commit_authors(self):
        class Client:
            calls = []

            def get(self, url, params=None):
                Client.calls.append(url)
                req = httpx.Request("GET", url)
                if url.endswith("/pulls/480"):
                    body = {"title": "Workday: x", "body": "", "head": {"ref": "fix/x"},
                            "user": {"login": "neilkadakia"}}
                elif "/compare/" in url:
                    body = {"files": [{"filename": "frontend/src/a.jsx"}], "commits": [
                        {"commit": {"message": "a"}, "author": {"login": "pranshuup"}},
                        {"commit": {"message": "b"}, "author": {"login": "neilkadakia"}},
                        {"commit": {"message": "c"}, "author": {"login": "dependabot[bot]"}},
                        {"commit": {"message": "d"}, "author": None}]}
                elif url.endswith("/users/neilkadakia"):
                    body = {"name": "Neil Kadakia"}
                else:
                    return httpx.Response(404, json={}, request=req)
                return httpx.Response(200, json=body, request=req)

        names = {}
        pr = changelog_prs._details(Client(), {"kind": "pr", "key": "pr:480", "number": 480, "branch": "fix/x",
                                               "sha": "m", "parents": ["p0", "p1"], "message": "Merge"}, names)
        self.assertEqual([(d["login"], d["name"]) for d in pr["developers"]],
                         [("neilkadakia", "Neil Kadakia"), ("pranshuup", "pranshuup")])
        changelog_prs._developers(Client(), ["neilkadakia"], names)     # cached: no second lookup
        self.assertEqual(sum(u.endswith("/users/neilkadakia") for u in Client.calls), 1)

    def test_default_polish_model(self):
        self.assertEqual(changelog_prs.polish_model(), os.getenv("NEXUS_CHANGELOG_MODEL") or "claude-sonnet-5-5")


if __name__ == "__main__":
    unittest.main()
