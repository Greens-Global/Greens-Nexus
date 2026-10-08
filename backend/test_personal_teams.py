"""Personal teams: created from the Teams screen, approved from Manage.

The feature is an access-control one, so these are mostly about what a team
does NOT let you do. The property that has to hold: an unapproved team cannot
widen anybody's access by existing. It hands out individual project grants -
exactly what its creator could already have granted by hand - and only approval
turns it into a team that confers access of its own.

The interesting failure is the quiet one: if approval left the individual
grants behind, removing somebody from the team would stop removing their
access, and nothing on screen would say so.

Run with: python -m unittest test_personal_teams -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers.task_util import gen_id, now_iso, project_role_for, visible_project_ids
from routers.task_projects import (
    TeamApprovalBody, TeamBody, create_team, decide_team_approval, delete_team,
    list_teams, request_team_approval, update_team,
)


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

MAKER = {"email": "dean@greensglobal.com", "level": 1}
MATE = {"email": "miranda@greensglobal.com", "level": 1}
OUTSIDER = {"email": "charmi@greensglobal.com", "level": 1}
BOSS = {"email": "neil@greensglobal.com", "level": 3}


class PersonalTeamTests(unittest.TestCase):
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
        for m in (models.TaskTeam, models.TaskProject, models.TaskNotification):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        # A RESTRICTED project: an org-visible one is visible to everybody
        # anyway, which would hide whether the team granted anything.
        self.proj = models.TaskProject(id=gen_id(), name="Roof replacement",
                                       access_level="restricted", member_emails=[],
                                       created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.proj)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _make(self, user=MAKER, personal=True, members=None, projects=None):
        return create_team(TeamBody(
            name="Roof crew", personal=personal,
            member_emails=members if members is not None else [MAKER["email"], MATE["email"]],
            project_ids=projects if projects is not None else [self.proj.id],
        ), user=user, db=self.db)

    def _team(self, tid):
        return self.db.query(models.TaskTeam).filter(models.TaskTeam.id == tid).first()

    def _roster(self):
        self.db.refresh(self.proj)
        return {e.lower() for e in (self.proj.member_emails or [])}

    # -- creation ----------------------------------------------------------
    def test_a_team_made_outside_manage_is_personal(self):
        self.assertEqual(self._make()["approvalStatus"], "personal")

    def test_a_non_manager_cannot_mint_a_workspace_team(self):
        # Otherwise approval gates nothing: make a team, add yourself and a
        # project, read the project.
        self.assertEqual(self._make(personal=False)["approvalStatus"], "personal")

    def test_a_manager_creating_from_manage_gets_a_real_team(self):
        self.assertEqual(self._make(user=BOSS, personal=False)["approvalStatus"], "approved")

    # -- visibility --------------------------------------------------------
    def test_a_personal_team_is_visible_only_to_its_creator(self):
        self._make()
        self.assertEqual(len(list_teams(user=MAKER, db=self.db)), 1)
        self.assertEqual(list_teams(user=MATE, db=self.db), [])      # even a MEMBER
        self.assertEqual(list_teams(user=OUTSIDER, db=self.db), [])

    def test_a_manager_can_see_one_waiting_to_be_approved(self):
        self._make()
        self.assertEqual(len(list_teams(user=BOSS, db=self.db)), 1)

    def test_an_approved_team_is_visible_to_everyone(self):
        t = self._make()
        decide_team_approval(t["id"], TeamApprovalBody(decision="approved"), user=BOSS, db=self.db)
        self.assertEqual(len(list_teams(user=OUTSIDER, db=self.db)), 1)

    # -- access: individual while personal ---------------------------------
    def test_a_personal_team_grants_INDIVIDUAL_project_access(self):
        self._make()
        self.assertEqual(self._roster(), {MAKER["email"], MATE["email"]})
        self.assertEqual(project_role_for(self.db, MATE["email"], self.proj), "editor")

    def test_a_personal_team_confers_no_TEAM_access(self):
        # The safety property. Somebody who is in the team's member list but
        # NOT granted individually must get nothing from the team itself.
        t = self._make(members=[MAKER["email"]])
        team = self._team(t["id"])
        team.member_emails = [MAKER["email"], OUTSIDER["email"]]   # straight to the row
        self.db.commit()
        self.assertIsNone(project_role_for(self.db, OUTSIDER["email"], self.proj))
        self.assertNotIn(self.proj.id, visible_project_ids(self.db, OUTSIDER["email"]))

    def test_removing_a_member_withdraws_their_individual_grant(self):
        t = self._make()
        update_team(t["id"], TeamBody(member_emails=[MAKER["email"]]), user=MAKER, db=self.db)
        self.assertEqual(self._roster(), {MAKER["email"]})

    def test_removing_the_project_withdraws_the_grants_it_carried(self):
        t = self._make()
        update_team(t["id"], TeamBody(project_ids=[]), user=MAKER, db=self.db)
        self.assertEqual(self._roster(), set())

    def test_binning_a_personal_team_takes_its_grants_with_it(self):
        t = self._make()
        delete_team(t["id"], user=MAKER, db=self.db)
        self.assertEqual(self._roster(), set())

    # -- approval swaps individual for team access -------------------------
    def test_approval_withdraws_the_individual_grants(self):
        t = self._make()
        self.assertEqual(self._roster(), {MAKER["email"], MATE["email"]})
        decide_team_approval(t["id"], TeamApprovalBody(decision="approved"), user=BOSS, db=self.db)
        # Gone from the project roster...
        self.assertEqual(self._roster(), set())
        # ...but access is unchanged, because it now comes from the team.
        self.assertEqual(project_role_for(self.db, MATE["email"], self.proj), "editor")

    def test_after_approval_leaving_the_team_actually_removes_access(self):
        # The bug that would hide behind leftover grants.
        t = self._make()
        decide_team_approval(t["id"], TeamApprovalBody(decision="approved"), user=BOSS, db=self.db)
        update_team(t["id"], TeamBody(member_emails=[MAKER["email"]]), user=BOSS, db=self.db)
        self.assertIsNone(project_role_for(self.db, MATE["email"], self.proj))

    def test_rejection_leaves_it_personal_and_its_grants_standing(self):
        t = self._make()
        decide_team_approval(t["id"], TeamApprovalBody(decision="rejected"), user=BOSS, db=self.db)
        self.assertEqual(self._team(t["id"]).approval_status, "personal")
        self.assertEqual(self._roster(), {MAKER["email"], MATE["email"]})

    # -- the request -------------------------------------------------------
    def test_asking_for_approval_marks_it_pending_and_tells_the_admins(self):
        t = self._make()
        self.assertEqual(request_team_approval(t["id"], user=MAKER, db=self.db)["approvalStatus"], "pending")
        kinds = {n.kind for n in self.db.query(models.TaskNotification).all()}
        self.assertIn("team_approval_requested", kinds)

    def test_somebody_elses_team_cannot_be_submitted_for_approval(self):
        t = self._make()
        with self.assertRaises(HTTPException) as e:
            request_team_approval(t["id"], user=OUTSIDER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_an_already_approved_team_cannot_be_resubmitted(self):
        t = self._make(user=BOSS, personal=False)
        with self.assertRaises(HTTPException) as e:
            request_team_approval(t["id"], user=BOSS, db=self.db)
        self.assertEqual(e.exception.status_code, 409)

    def test_a_patch_cannot_approve_a_team(self):
        t = self._make()
        update_team(t["id"], TeamBody(approval_status="approved"), user=MAKER, db=self.db)
        self.assertEqual(self._team(t["id"]).approval_status, "personal")

    # -- who may PATCH a team (Sep 30 review) --------------------------------
    def _own_project(self, owner):
        p = models.TaskProject(id=gen_id(), name="Lobby refit", access_level="restricted",
                               owner_email=owner["email"], member_emails=[],
                               created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        return p

    def _approved(self):
        return self._make(user=BOSS, personal=False, members=[MATE["email"]], projects=[])

    def _forbidden(self, team_id, body, user):
        with self.assertRaises(HTTPException) as e:
            update_team(team_id, body, user=user, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_somebody_elses_personal_team_cannot_be_edited(self):
        t = self._make()
        self._forbidden(t["id"], TeamBody(member_emails=[OUTSIDER["email"]]), OUTSIDER)
        self.assertNotIn(OUTSIDER["email"], self._team(t["id"]).member_emails)

    def test_an_employee_cannot_add_themselves_to_an_approved_team(self):
        t = self._approved()
        self._forbidden(t["id"], TeamBody(member_emails=[MATE["email"], OUTSIDER["email"]]), OUTSIDER)
        # Not even its creator, once a manager has approved it.
        self._forbidden(t["id"], TeamBody(name="Mine now"), MAKER)

    def test_an_employee_cannot_raise_an_approved_teams_role(self):
        t = self._approved()
        self._forbidden(t["id"], TeamBody(access_role="owner"), OUTSIDER)
        self.assertEqual(self._team(t["id"]).access_role or "editor", "editor")

    def test_an_approved_team_cannot_be_pointed_at_a_project_you_do_not_own(self):
        t = self._approved()
        self._forbidden(t["id"], TeamBody(project_ids=[self.proj.id]), OUTSIDER)
        self.assertEqual(self._team(t["id"]).project_ids, [])

    def test_a_project_owner_can_share_their_project_with_a_team(self):
        # The project Share panel: attach (resending the current role) and detach.
        t = self._approved()
        mine = self._own_project(OUTSIDER)
        update_team(t["id"], TeamBody(project_ids=[mine.id], access_role="editor"),
                    user=OUTSIDER, db=self.db)
        self.assertEqual(self._team(t["id"]).project_ids, [mine.id])
        update_team(t["id"], TeamBody(project_ids=[]), user=OUTSIDER, db=self.db)
        self.assertEqual(self._team(t["id"]).project_ids, [])

    def test_a_project_owner_cannot_detach_somebody_elses_project(self):
        t = self._make(user=BOSS, personal=False, members=[MATE["email"]], projects=[self.proj.id])
        self._forbidden(t["id"], TeamBody(project_ids=[]), OUTSIDER)
        self.assertEqual(self._team(t["id"]).project_ids, [self.proj.id])

    def test_a_creator_cannot_add_a_project_they_do_not_own(self):
        t = self._make(projects=[])
        self._forbidden(t["id"], TeamBody(project_ids=[self.proj.id]), MAKER)
        self.assertEqual(self._roster(), set())

    def test_a_manager_can_edit_any_team(self):
        t = self._make()
        update_team(t["id"], TeamBody(name="Renamed", project_ids=[]), user=BOSS, db=self.db)
        self.assertEqual(self._team(t["id"]).name, "Renamed")

    # -- teams that already existed ----------------------------------------
    def test_a_team_predating_this_reads_as_approved(self):
        old = models.TaskTeam(id=gen_id(), name="Accounting", member_emails=[MATE["email"]],
                              project_ids=[self.proj.id], approval_status=None,
                              created_at=now_iso())
        self.db.add(old)
        self.db.commit()
        # Blank must mean approved, or deploying this would have cut off access
        # across the workspace at once.
        self.assertEqual(project_role_for(self.db, MATE["email"], self.proj), "editor")
        self.assertEqual(len(list_teams(user=OUTSIDER, db=self.db)), 1)


if __name__ == "__main__":
    unittest.main()
