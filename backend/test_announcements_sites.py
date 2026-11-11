"""Announcements by work site + not yet acknowledged (Neil, 11/02/2026,
the Homebase lifts).

- audience 'site' reaches ONLY the people whose allowed work sites
  (nexus_employees.work_site_ids, the single work_site_id still counting as a
  one-site list) contain the post's site. A person with an EMPTY list ("any
  company site") is NOT a member - even inside the author's company scope,
  even when the site belongs to their company (Review Focus 3).
- The author and administrators always see the post; everyone else only
  when they are a member.
- The reads route lists who has NOT yet acknowledged a requires_ack post
  (the audience minus the acknowledgers, by name); a post that needs no
  acknowledgment carries no such list.
- Validation: a site post needs a site; the site must exist and, for a
  company-walled author, be a site one of THEIR companies uses.

Throwaway sqlite, NEXUS_SKIP_AUTH identity. No network.

Run alone: python -m pytest test_announcements_sites.py
"""
import json
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"

import atexit

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


COA, COB = "co-site-a", "co-site-b"
YARD, DEPOT, FAR = "site-yard", "site-depot", "site-far"      # yard + depot are A's, far is B's
ADMIN = "site.admin@greensglobal.com"        # Alpha administrator
GA = "site.ga@greensglobal.com"              # the Global Admins group's one member
YARD1 = "site.yard1@greensglobal.com"        # sites [yard]
BOTH = "site.both@greensglobal.com"          # sites [yard, depot]
LEGACY = "site.legacy@greensglobal.com"      # the old single work_site_id = yard
ANYSITE = "site.anysite@greensglobal.com"    # Alpha, sites [] - NOT a member
DEPOT1 = "site.depot1@greensglobal.com"      # sites [depot]
BFAR = "site.bfar@greensglobal.com"          # Beta, sites [far]


class AnnouncementsSiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=COA, name="Alpha Co"))
            db.add(models.HrEntity(id=COB, name="Beta Co"))
            for sid, name in ((YARD, "North Yard"), (DEPOT, "Depot"), (FAR, "Far Plant")):
                db.add(models.HrWorkSite(id=sid, name=name))
            for co, sid in ((COA, YARD), (COA, DEPOT), (COB, FAR)):
                db.add(models.HrCompanyWorkSite(id=f"{co}:{sid}", company_id=co, site_id=sid))
            people = [
                (ADMIN, COA, "administrator", [YARD], ""),
                (GA, COA, "administrator", [], ""),
                (YARD1, COA, "employee", [YARD], ""),
                (BOTH, COA, "employee", [YARD, DEPOT], ""),
                (LEGACY, COA, "employee", [], YARD),
                (ANYSITE, COA, "employee", [], ""),
                (DEPOT1, COA, "employee", [DEPOT], ""),
                (BFAR, COB, "employee", [FAR], ""),
            ]
            for i, (email, co, role, sites, single) in enumerate(people):
                db.add(models.NexusEmployee(id=f"e-site-{i}", first_name="P", last_name=email.split("@")[0].split(".")[1],
                                            work_email=email, department="Operations", status="active", deleted_at="",
                                            company=co, work_site_ids=json.dumps(sites) if sites else "", work_site_id=single))
                db.add(models.NexusRole(email=email, role=role))
            # A populated Super Administrators group: ADMIN is a company-walled
            # Administrator, GA crosses companies (auth.is_global_admin).
            db.add(models.NexusGroup(id="g-site-ga", name="Global Admins", is_global_admin=1))
            db.add(models.NexusGroupMember(group_id="g-site-ga", email=GA))
            db.commit()
        finally:
            db.close()

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._walls("")
        db = database.SessionLocal()
        try:
            db.query(models.Announcement).delete(synchronize_session=False)
            db.query(models.AnnouncementRead).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.type == "announcement").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        self._flush()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self._flush()

    def _flush(self):
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()
        cache.people_directory.invalidate()

    def _walls(self, value: str):
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete(synchronize_session=False)
            if value:
                db.add(models.NexusSetting(key="company_walls", value=value))
            db.commit()
        finally:
            db.close()
        cache.settings_config.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _post(self, as_email=ADMIN, **body):
        self._as(as_email)
        payload = {"title": "Gate code changes Monday", "body": "New code at the yard gate.", "audience": "site", "work_site_id": YARD}
        payload.update(body)
        return self.client.post("/announcements", json=payload)

    def _list(self, as_email):
        self._as(as_email)
        r = self.client.get("/announcements")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _bells(self, aid):
        db = database.SessionLocal()
        try:
            return sorted(n.recipient for n in db.query(models.NexusNotification)
                          .filter(models.NexusNotification.type == "announcement",
                                  models.NexusNotification.ref_id == aid).all())
        finally:
            db.close()

    # ── Reach ────────────────────────────────────────────────────────────────

    def test_site_post_reaches_members_only_and_an_empty_site_list_is_not_a_member(self):
        r = self._post()
        self.assertEqual(r.status_code, 201, r.text)
        a = r.json()
        self.assertEqual(a["audience"], "site")
        self.assertEqual(a["workSiteId"], YARD)
        self.assertEqual(a["workSiteName"], "North Yard")
        # Bells: the yard's people only (the legacy single-site column counts);
        # the author, the depot-only person and Beta's person get none. ANYSITE
        # is in the author's company AND the yard is their company's site -
        # still not a member (Review Focus 3).
        self.assertEqual(self._bells(a["id"]), sorted([YARD1, BOTH, LEGACY]))

        self.assertEqual([x["id"] for x in self._list(YARD1)], [a["id"]])
        self.assertEqual([x["id"] for x in self._list(BOTH)], [a["id"]])
        self.assertEqual([x["id"] for x in self._list(LEGACY)], [a["id"]])
        self.assertEqual(self._list(ANYSITE), [])
        self.assertEqual(self._list(DEPOT1), [])
        self.assertEqual(self._list(BFAR), [])
        # The author and an administrator always see it (they manage it).
        self.assertEqual([x["id"] for x in self._list(ADMIN)], [a["id"]])
        self.assertEqual([x["id"] for x in self._list(GA)], [a["id"]])
        row = self._list(YARD1)[0]
        self.assertEqual(row["workSiteName"], "North Yard")

    def test_empty_site_list_is_not_a_member_with_walls_on_either(self):
        """Walls on, the author is a company-walled administrator of Alpha:
        ANYSITE is inside the scope and the yard is Alpha's - still no bell."""
        self._walls("on")
        r = self._post()
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self._bells(r.json()["id"]), sorted([YARD1, BOTH, LEGACY]))
        self.assertEqual(self._list(ANYSITE), [])

    def test_company_and_department_posts_are_unchanged(self):
        a = self._post(audience="company", work_site_id="").json()
        self.assertEqual(a["workSiteId"], "")
        self.assertEqual(a["workSiteName"], "")
        self.assertIn(ANYSITE, self._bells(a["id"]))
        # Walls off: Alpha's Administrator reaches Beta's people too (11/11/2026).
        self.assertIn(BFAR, self._bells(a["id"]))
        # Walls on: Alpha's Administrator is walled to Alpha; a Super Administrator's
        # company post still reaches Beta.
        self._walls("on")
        c = self._post(audience="company", work_site_id="").json()
        self.assertNotIn(BFAR, self._bells(c["id"]))
        b = self._post(as_email=GA, audience="company", work_site_id="").json()
        self.assertIn(BFAR, self._bells(b["id"]))

    # ── Not yet acknowledged ────────────────────────────────────────────────

    def test_reads_route_lists_who_has_not_yet_acknowledged(self):
        a = self._post(requires_ack=True).json()
        self._as(YARD1)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/ack").status_code, 200)
        self._as(BOTH)
        self.assertEqual(self.client.post(f"/announcements/{a['id']}/read").status_code, 200)   # read, not acknowledged
        self._as(ADMIN)
        r = self.client.get(f"/announcements/{a['id']}/reads")
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual([x["email"] for x in data["reads"]], [YARD1, BOTH])    # acknowledged first
        self.assertEqual([(x["email"], x["name"]) for x in data["notAcknowledged"]],
                         [(BOTH, "P both"), (LEGACY, "P legacy")])                # by name; never the author
        # Not asked to acknowledge: no such list.
        b = self._post().json()
        r = self.client.get(f"/announcements/{b['id']}/reads")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["reads"], [])
        self.assertNotIn("notAcknowledged", r.json())
        # Staff never see the list (the administrator gate refuses, as today).
        self._as(YARD1)
        self.assertIn(self.client.get(f"/announcements/{a['id']}/reads").status_code, (401, 403))

    # ── Validation ───────────────────────────────────────────────────────────

    def test_site_post_needs_a_real_site_the_author_may_post_to(self):
        r = self._post(work_site_id="")
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["detail"], "Work site is required for a work-site announcement.")
        r = self._post(work_site_id="site-nowhere")
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["detail"], "That work site does not exist.")
        # Walls off: an Administrator may post to any company's site (11/11/2026).
        self.assertEqual(self._post(work_site_id=FAR).status_code, 201)
        self._walls("on")
        r = self._post(work_site_id=FAR)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["detail"], "That work site is not one of your companies' sites.")
        self.assertEqual(self._post(work_site_id=DEPOT).status_code, 201)
        # A Super Administrator (the flagged group) reaches every company.
        self.assertEqual(self._post(as_email=GA, work_site_id=FAR).status_code, 201)

    def test_patch_keeps_or_changes_the_site(self):
        a = self._post().json()
        self._as(ADMIN)
        r = self.client.patch(f"/announcements/{a['id']}", json={"title": "Gate code changes Tuesday"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["workSiteId"], YARD)
        r = self.client.patch(f"/announcements/{a['id']}", json={"work_site_id": DEPOT})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["workSiteName"], "Depot")
        r = self.client.patch(f"/announcements/{a['id']}", json={"audience": "company"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["workSiteId"], "")
        r = self.client.patch(f"/announcements/{a['id']}", json={"audience": "site"})
        self.assertEqual(r.status_code, 422, r.text)


if __name__ == "__main__":
    unittest.main()
