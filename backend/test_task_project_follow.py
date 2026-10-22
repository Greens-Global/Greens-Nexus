"""Follow a project (Neil, Oct 22 2026) - task_project_follow.py.

Pinned here: following / unfollowing (idempotent, row-locked so two people
following at once both land), that a project you cannot see cannot be
followed (sharing, company walls), that owners and editors add and remove
other people (directory people who can see it; logged) and viewers cannot,
and what a follower hears: new task, completed, comment - batched, once per
person per event, never their own action, never twice when they are already on
the task, never about a task or project they cannot see, and nothing once they
lose access, the project is archived or binned, or they switch it off.

Throwaway SQLite, no network:
    python -m pytest test_task_project_follow.py -q
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
import task_notify_prefs  # noqa: E402
import task_project_follow as PF  # noqa: E402
from routers import task_projects as P  # noqa: E402
from routers import tasks as T  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

COA, COB = "co-a", "co-b"
OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
FAN = {"email": "fan@greensglobal.com", "level": 1}         # the follower
FAN2 = {"email": "fan2@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
BEMP = {"email": "bemp@greensglobal.com", "level": 1}       # company B
AMGR = {"email": "amgr@greensglobal.com", "level": 3}       # company A manager
LATER = (date.today() + timedelta(days=10)).isoformat()

_PEOPLE = ((OWNER, COA), (EDITOR, COA), (VIEWER, COA), (FAN, COA), (FAN2, COA), (OUTSIDER, COA),
           (BEMP, COB), (AMGR, COA))
_CLEAR = (models.Task, models.TaskProject, models.TaskTeam, models.TaskActivity, models.TaskNotification,
          models.NexusNotification, models.NexusEmployee, models.NexusSetting, models.NexusRole,
          models.TaskEmailLog, models.TaskEmailQueue, models.TaskNotifyPref, models.TaskComment)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in _PEOPLE:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"],
                                             first_name=u["email"].split("@")[0].title(),
                                             status="active", company=co))
        self.db.add(models.NexusRole(email=AMGR["email"], role="manager", assigned_by="test"))
        self.db.commit()
        cache.settings_config.invalidate()
        auth.invalidate_role_cache()
        self.sent = []
        self._real_send = task_notify._send_one
        task_notify._send_one = lambda db, **kw: self.sent.append(kw)

    def tearDown(self):
        task_notify._send_one = self._real_send
        self.db.close()
        cache.settings_config.invalidate()
        auth.invalidate_role_cache()

    # -- helpers -------------------------------------------------------------
    def arm_walls(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def project(self, access="restricted", company=COA, followers=(), **kw):
        kw.setdefault("member_emails", [EDITOR["email"], VIEWER["email"], FAN["email"], FAN2["email"]])
        kw.setdefault("member_roles", {EDITOR["email"]: "editor", VIEWER["email"]: "viewer"})
        p = models.TaskProject(id=gen_id(), name="Pump Station", owner_email=OWNER["email"],
                               created_by=OWNER["email"], access_level=access, company_id=company,
                               follower_emails=list(followers), created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def task(self, p, title="Replace pump seal", **kw):
        kw.setdefault("assignee_email", OWNER["email"])
        kw.setdefault("assignee_emails", [kw["assignee_email"]] if kw["assignee_email"] else [])
        kw.setdefault("follower_emails", [])
        kw.setdefault("created_by", OWNER["email"])
        kw.setdefault("due_on", LATER)
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:5]}", title=title, project_id=p.id if p else "",
                        company_id=COA, status="not_started", priority=kw.pop("priority", "medium"),
                        completed=False, created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def event(self, t, ev, actor=OWNER, **kw):
        task_notify.notify_task_event(t.id, ev, actor["email"], **kw)
        self.db.expire_all()

    def queued(self, who=FAN):
        return (self.db.query(models.TaskEmailQueue)
                .filter_by(recipient=who["email"], status="pending").all())

    def bells(self, who=FAN):
        return (self.db.query(models.TaskNotification)
                .filter_by(for_email=who["email"], kind=PF.BELL_KIND).all())

    def flush(self):
        n = task_notify.flush_batches(self.db, now=datetime.now(timezone.utc) + timedelta(minutes=61))
        self.db.expire_all()
        return n

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        return e.exception.status_code

    def followers(self, p):
        self.db.expire_all()
        return PF.followers(self.db.query(models.TaskProject).filter_by(id=p.id).one())


class FollowTests(Base):
    def test_follow_and_unfollow_self(self):
        p = self.project()
        out = P.follow_project(p.id, user=FAN, db=self.db)
        self.assertEqual(out["followerIds"], [FAN["email"]])
        P.follow_project(p.id, user=FAN, db=self.db)              # twice is a no-op
        self.assertEqual(self.followers(p), [FAN["email"]])
        P.unfollow_project(p.id, user=FAN, db=self.db)
        self.assertEqual(self.followers(p), [])
        # Following yourself is not logged - it is noise.
        self.assertEqual(self.db.query(models.TaskActivity).count(), 0)

    def test_project_list_carries_followers(self):
        p = self.project(followers=[FAN["email"]])
        row = next(r for r in P.list_projects(user=FAN, db=self.db) if r["id"] == p.id)
        self.assertEqual(row["followerIds"], [FAN["email"]])

    def test_cannot_follow_a_project_you_cannot_see(self):
        p = self.project()                                        # restricted, OUTSIDER not on it
        self.assertEqual(self.code(lambda: P.follow_project(p.id, user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.followers(p), [])
        # An org-wide project is open to everyone.
        q = self.project(access="org")
        P.follow_project(q.id, user=OUTSIDER, db=self.db)
        self.assertEqual(self.followers(q), [OUTSIDER["email"]])

    def test_walls_stop_following_across_companies(self):
        p = self.project(access="org", company=COB)
        self.arm_walls()
        self.assertEqual(self.code(lambda: P.follow_project(p.id, user=FAN, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.follow_project(p.id, user=AMGR, db=self.db)), 404)
        P.follow_project(p.id, user=BEMP, db=self.db)             # their own company
        self.assertEqual(self.followers(p), [BEMP["email"]])

    def test_archived_project_cannot_be_followed(self):
        p = self.project(archived=True)
        self.assertEqual(self.code(lambda: P.follow_project(p.id, user=FAN, db=self.db)), 422)

    def test_two_people_following_at_once_both_land(self):
        """A stale copy of the row must not overwrite a follow made since:
        the write re-reads the locked row (with_for_update + populate_existing)."""
        p = self.project()
        stale = database.SessionLocal()
        try:
            stale.query(models.TaskProject).filter_by(id=p.id).one().follower_emails   # loaded, now stale
            other = database.SessionLocal()
            try:
                P.follow_project(p.id, user=FAN2, db=other)
            finally:
                other.close()
            P.follow_project(p.id, user=FAN, db=stale)
        finally:
            stale.close()
        self.assertEqual(sorted(self.followers(p)), sorted([FAN["email"], FAN2["email"]]))

    def test_unfollow_works_after_losing_access(self):
        p = self.project(followers=[OUTSIDER["email"]])          # restricted, OUTSIDER cannot see it
        P.unfollow_project(p.id, user=OUTSIDER, db=self.db)
        self.assertEqual(self.followers(p), [])


class OwnerManagesFollowersTests(Base):
    def test_editor_adds_and_removes_someone_else_and_it_is_logged(self):
        p = self.project()
        P.add_project_follower(p.id, P.FollowerBody(email=FAN["email"]), user=EDITOR, db=self.db)
        self.assertEqual(self.followers(p), [FAN["email"]])
        acts = [a.type for a in self.db.query(models.TaskActivity).filter_by(entity_id=p.id).all()]
        self.assertEqual(acts, ["follower_added"])
        bell = self.db.query(models.TaskNotification).filter_by(for_email=FAN["email"]).one()
        self.assertEqual(bell.kind, "project_follow_added")
        P.remove_project_follower(p.id, FAN["email"], user=OWNER, db=self.db)
        self.assertEqual(self.followers(p), [])
        acts = sorted(a.type for a in self.db.query(models.TaskActivity).filter_by(entity_id=p.id).all())
        self.assertEqual(acts, ["follower_added", "follower_removed"])

    def test_viewer_and_outsider_cannot_manage_followers(self):
        p = self.project(followers=[FAN["email"]])
        self.assertEqual(self.code(lambda: P.add_project_follower(
            p.id, P.FollowerBody(email=FAN2["email"]), user=VIEWER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: P.remove_project_follower(
            p.id, FAN["email"], user=VIEWER, db=self.db)), 403)
        self.assertEqual(self.followers(p), [FAN["email"]])

    def test_added_person_must_be_a_current_directory_person_who_can_see_it(self):
        p = self.project()
        for email in ("stranger@example.com", OUTSIDER["email"]):   # not in directory / cannot see
            self.assertEqual(self.code(lambda: P.add_project_follower(
                p.id, P.FollowerBody(email=email), user=OWNER, db=self.db)), 422)
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=FAN["email"]).one()
        emp.status = "offboarded"
        self.db.commit()
        self.assertEqual(self.code(lambda: P.add_project_follower(
            p.id, P.FollowerBody(email=FAN["email"]), user=OWNER, db=self.db)), 422)
        self.assertEqual(self.followers(p), [])

    def test_an_inactive_person_cannot_be_added(self):
        p = self.project()
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=FAN["email"]).one()
        emp.status = "inactive"
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            P.add_project_follower(p.id, P.FollowerBody(email=FAN["email"]), user=OWNER, db=self.db)
        self.assertEqual(e.exception.status_code, 422)
        self.assertIn("is inactive", e.exception.detail)
        self.assertEqual(self.followers(p), [])

    def test_walls_refuse_adding_another_companys_person(self):
        p = self.project(access="org")
        self.arm_walls()
        self.assertEqual(self.code(lambda: P.add_project_follower(
            p.id, P.FollowerBody(email=BEMP["email"]), user=OWNER, db=self.db)), 422)


class WhatFollowersHearTests(Base):
    def test_new_task_is_batched_once_with_a_grouped_bell(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p)
        self.event(t, "created")
        q = self.queued()
        self.assertEqual([(r.event_type, r.role) for r in q], [("created", "project_follower")])
        self.assertEqual(self.sent, [])                            # waits for the batch
        bells = self.bells()
        self.assertEqual(len(bells), 1)
        self.assertIn("Replace pump seal", bells[0].body)
        self.assertEqual(bells[0].title, "Activity in Pump Station")
        # A second event grows the same notice instead of adding one.
        t2 = self.task(p, title="Order spare impeller")
        self.event(t2, "created")
        bells = self.bells()
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].body.split("\n")[0], 'Owner added "Order spare impeller"')
        self.assertEqual(len(bells[0].body.split("\n")), 2)
        self.assertEqual(self.flush(), 1)
        self.assertEqual([s["recipient"] for s in self.sent], [FAN["email"]])
        self.assertEqual(self.sent[0]["event_type"], "batch")

    def test_completed_and_commented_reach_followers(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p)
        self.event(t, "completed", actor=EDITOR)
        self.event(t, "commented", actor=EDITOR, comment_body="<p>Done and tested</p>")
        self.assertEqual(sorted(r.event_type for r in self.queued()), ["commented", "completed"])

    def test_urgent_task_still_waits_for_a_follower(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p, priority="urgent")
        self.event(t, "created")
        self.assertEqual(len(self.queued()), 1)
        self.assertNotIn(FAN["email"], [s["recipient"] for s in self.sent])

    def test_other_events_do_not_reach_followers(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p)
        self.event(t, "modified", update_kind="Priority changed")
        self.event(t, "assigned")
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])

    def test_actor_is_never_told_of_their_own_action(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p, assignee_email="")
        self.event(t, "created", actor=FAN)
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])

    def test_no_double_notice_when_already_on_the_task(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p, assignee_email=FAN["email"])
        self.event(t, "created")
        self.assertEqual([r.role for r in self.queued()], ["assignee"])
        self.assertEqual(self.bells(), [])
        t2 = self.task(p, follower_emails=[FAN["email"]])
        self.event(t2, "commented", comment_body="<p>hi</p>")
        self.assertEqual(sorted(r.role for r in self.queued()), ["assignee", "follower"])

    def test_a_mentioned_follower_gets_only_the_mention(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p)
        body = f'<p><a href="mailto:{FAN["email"]}">@Fan</a> look</p>'
        self.event(t, "commented", comment_body=body)
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])

    def test_two_followed_projects_still_one_notice(self):
        p = self.project(followers=[FAN["email"]])
        p2 = self.project(followers=[FAN["email"]])
        t = self.task(p, project_ids=[p2.id])
        self.event(t, "created")
        self.assertEqual(len(self.queued()), 1)
        self.assertEqual(len(self.bells()), 1)

    def test_switched_off_means_no_email_but_the_bell_stays(self):
        p = self.project(followers=[FAN["email"]])
        task_notify_prefs.save(self.db, FAN["email"], {"followedProjects": False})
        self.event(self.task(p), "created")
        self.assertEqual(self.queued(), [])
        self.assertEqual(len(self.bells()), 1)
        self.assertFalse(task_notify_prefs.load(self.db, FAN["email"])["followedProjects"])

    def test_muted_project_is_respected(self):
        p = self.project(followers=[FAN["email"]])
        task_notify_prefs.save(self.db, FAN["email"], {"mutedProjectIds": [p.id]})
        self.event(self.task(p), "created")
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])

    def test_muting_the_followed_extra_project_silences_it(self):
        """The task's PRIMARY project is not followed or muted; the extra
        project it reaches FAN through is muted - nothing at all."""
        home = self.project()
        followed = self.project(followers=[FAN["email"]])
        task_notify_prefs.save(self.db, FAN["email"], {"mutedProjectIds": [followed.id]})
        self.event(self.task(home, project_ids=[followed.id]), "created")
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])

    def test_muting_after_queueing_drops_the_email(self):
        p = self.project(followers=[FAN["email"]])
        home = self.project()
        self.event(self.task(home, project_ids=[p.id]), "created")
        self.assertEqual(len(self.queued()), 1)
        task_notify_prefs.save(self.db, FAN["email"], {"mutedProjectIds": [p.id]})
        self.assertEqual(self.flush(), 0)

    def test_the_email_says_why_it_came(self):
        p = self.project(followers=[FAN["email"]])
        self.event(self.task(p), "created")
        self.flush()
        html = self.sent[0]["html"]
        self.assertIn("You follow Pump Station", html)
        self.assertIn(f"/tasks/projects?project={p.id}", html)
        # A batch keeps its format and says it per task.
        self.sent.clear()
        self.event(self.task(p, title="One"), "created")
        self.event(self.task(p, title="Two"), "created")
        self.flush()
        self.assertEqual(self.sent[0]["event_type"], "batch")
        self.assertEqual(self.sent[0]["html"].count("You follow Pump Station"), 2)
        self.assertIn("Open Project", self.sent[0]["html"])

    def test_bell_day_is_the_followers_own_day_and_one_row(self):
        task_notify_prefs.save(self.db, FAN["email"], {"timezone": "Asia/Kolkata"})
        p = self.project(followers=[FAN["email"]])
        self.event(self.task(p), "created")
        self.event(self.task(p, title="Second"), "created")
        day = task_notify_prefs.local_now(task_notify_prefs.load(self.db, FAN["email"])).date().isoformat()
        bells = self.bells()
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].id, PF.bell_id(p.id, day, FAN["email"]))
        self.assertEqual(bells[0].request_id, f"project-follow:{p.id}:{day}")

    def test_a_failed_bell_still_sends_the_emails(self):
        p = self.project(followers=[FAN["email"]])
        real = PF.ring_bells

        def boom(*a, **kw):
            raise RuntimeError("bell store down")
        PF.ring_bells = boom
        try:
            t = self.task(p)
            self.event(t, "created")
        finally:
            PF.ring_bells = real
        self.assertEqual([r.role for r in self.queued()], ["project_follower"])
        errs = self.db.query(models.TaskActivity).filter_by(entity_id=t.id, type="notify_error").all()
        self.assertEqual(len(errs), 1)
        self.assertIn("bell", errs[0].detail)

    def test_visibility_is_worked_out_once_per_follower(self):
        """Followers who reach a restricted project only through a team need
        the whole-table walk - once each per event, once each per flush."""
        p = self.project(member_emails=[], member_roles={}, followers=[FAN["email"], FAN2["email"]])
        self.db.add(models.TaskTeam(id=gen_id(), name="Pumps", project_ids=[p.id], project_id=p.id,
                                    member_emails=[FAN["email"], FAN2["email"]], access_role="viewer",
                                    created_at=now_iso()))
        self.db.commit()
        import routers.task_util as TU
        calls = {"pf": 0, "tu": 0}
        real_pf, real_tu = PF.visible_project_ids, TU.visible_project_ids

        def counting_pf(db, user):
            calls["pf"] += 1
            return real_pf(db, user)

        def counting_tu(db, user):
            calls["tu"] += 1
            return real_tu(db, user)
        PF.visible_project_ids, TU.visible_project_ids = counting_pf, counting_tu
        try:
            self.event(self.task(p, access_level="restricted"), "created")
            self.assertEqual(calls, {"pf": 2, "tu": 0})            # one per follower
            self.event(self.task(p, title="Again", access_level="restricted"), "created")
            self.assertEqual(calls["pf"], 4)
            calls["pf"] = 0
            self.assertEqual(self.flush(), 2)                       # two people, two rows each
            self.assertEqual(calls, {"pf": 2, "tu": 0})            # one per recipient
        finally:
            PF.visible_project_ids, TU.visible_project_ids = real_pf, real_tu

    def test_end_to_end_through_create_task(self):
        p = self.project(followers=[FAN["email"]])
        bt = BackgroundTasks()
        T.create_task(T.TaskCreate(title="Inspect valves", project_id=p.id), bt, user=OWNER, db=self.db)
        for job in bt.tasks:
            job.func(*job.args, **job.kwargs)
        self.db.expire_all()
        self.assertEqual([(r.event_type, r.role) for r in self.queued()], [("created", "project_follower")])


class AccessAtSendTimeTests(Base):
    def test_restricted_task_in_an_unfollowed_project_is_not_leaked(self):
        followed = self.project(followers=[FAN["email"]])
        secret = self.project(member_emails=[], member_roles={})   # FAN cannot see this one
        t = self.task(secret, access_level="restricted")
        self.event(t, "created")
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])
        self.assertTrue(followed)

    def test_follower_who_lost_access_hears_nothing(self):
        p = self.project(followers=[OUTSIDER["email"]])            # restricted, OUTSIDER not a member
        t = self.task(p, access_level="restricted")
        self.event(t, "created")
        self.assertEqual(self.queued(OUTSIDER), [])
        self.assertEqual(self.bells(OUTSIDER), [])

    def test_losing_access_before_the_batch_drops_the_email(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p, access_level="restricted")
        self.event(t, "created")
        self.assertEqual(len(self.queued()), 1)
        p = self.db.query(models.TaskProject).filter_by(id=p.id).one()
        p.member_emails = [EDITOR["email"]]
        self.db.commit()
        self.assertEqual(self.flush(), 0)
        self.assertEqual(self.sent, [])
        row = self.db.query(models.TaskEmailQueue).filter_by(recipient=FAN["email"]).one()
        self.assertEqual((row.status, row.drop_reason), ("dropped", "no longer following the project"))

    def test_unfollowing_before_the_batch_drops_the_email(self):
        p = self.project(followers=[FAN["email"]])
        self.event(self.task(p), "created")
        P.unfollow_project(p.id, user=FAN, db=self.db)
        self.assertEqual(self.flush(), 0)

    def test_leaving_the_company_stops_mail(self):
        p = self.project(followers=[FAN["email"]])
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=FAN["email"]).one()
        emp.status = "offboarded"
        self.db.commit()
        self.event(self.task(p), "created")
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.bells(), [])

    def _external(self, email, expires_at=""):
        self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name="Ext", status="active",
                                         company=COA, identity_type="external", expires_at=expires_at))
        self.db.commit()
        auth.invalidate_external_cache()

    def test_an_expired_external_follower_hears_nothing(self):
        live, gone = "partner@vendor.com", "lapsed@vendor.com"
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        self._external(live, (date.today() + timedelta(days=30)).isoformat())
        self._external(gone, yesterday)
        p = self.project(member_emails=[live, gone], followers=[live, gone])
        self.event(self.task(p), "created")
        self.assertEqual(len(self.queued({"email": live})), 1)
        self.assertEqual(self.queued({"email": gone}), [])
        self.assertEqual(self.bells({"email": gone}), [])
        # Expiring after the event drops the queued email too.
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=live).one()
        emp.expires_at = yesterday
        self.db.commit()
        auth.invalidate_external_cache()
        self.assertEqual(self.flush(), 0)

    def test_an_expired_external_task_collaborator_gets_no_email(self):
        """The same gap closed for plain task collaborators (_is_sendable)."""
        gone = "lapsed2@vendor.com"
        self._external(gone, (date.today() - timedelta(days=1)).isoformat())
        t = self.task(None, follower_emails=[gone])
        self.event(t, "commented", comment_body="<p>update</p>")
        self.assertEqual(self.queued({"email": gone}), [])
        self.assertFalse(task_notify._is_sendable(self.db, gone))
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=gone).one()
        emp.expires_at = ""
        self.db.commit()
        self.assertTrue(task_notify._is_sendable(self.db, gone))

    def test_walls_stop_a_follower_in_another_company(self):
        p = self.project(access="org", followers=[BEMP["email"]])
        self.event(self.task(p), "created")
        self.assertEqual(len(self.queued(BEMP)), 1)                # walls off: they hear it
        self.arm_walls()
        self.event(self.task(p, title="Second"), "created")
        self.assertEqual(len(self.queued(BEMP)), 1)                # walls on: nothing new
        self.assertEqual(self.flush(), 0)                          # and the first is dropped

    def test_archived_project_is_silent_and_restoring_keeps_followers(self):
        p = self.project(followers=[FAN["email"]], archived=True)
        self.event(self.task(p), "created")
        self.assertEqual(self.queued(), [])
        p = self.db.query(models.TaskProject).filter_by(id=p.id).one()
        p.archived = False
        self.db.commit()
        self.assertEqual(self.followers(p), [FAN["email"]])
        self.event(self.task(p, title="After restore"), "created")
        self.assertEqual(len(self.queued()), 1)

    def test_binned_project_is_silent(self):
        p = self.project(followers=[FAN["email"]])
        t = self.task(p)
        P.delete_project(p.id, user=OWNER, db=self.db)
        self.db.expire_all()
        # The task went to the bin with it; a straggling event finds nothing.
        task_notify.notify_task_event(t.id, "commented", OWNER["email"], comment_body="<p>x</p>")
        self.assertEqual(self.queued(), [])

    def test_company_turning_the_email_off_still_rings_the_bell(self):
        task_notify.save_settings(self.db, {"enabledEvents": {"created": False}}, "test")
        p = self.project(followers=[FAN["email"]])
        self.event(self.task(p), "created")
        self.assertEqual(self.queued(), [])
        self.assertEqual(len(self.bells()), 1)


if __name__ == "__main__":
    unittest.main()
