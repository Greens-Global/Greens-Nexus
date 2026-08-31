"""Ticket intake: the application picked at step 1, and the service area
derived from it (Aug 2026).

A requester says which APPLICATION their ticket is about, picked from the
External Links directory. The service area - how the desk triages it - is
derived from that app's mapping and never asked, so nobody classifies their own
problem twice and no client can file a ticket into a category its application
does not belong to.

Throwaway sqlite. No network.

Run with: python -m unittest test_ticket_service_area -v
"""
import os, tempfile, unittest, uuid
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False); _tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar.shoundik@greensglobal.com"

from fastapi import BackgroundTasks
from fastapi.testclient import TestClient
import database, models
models.Base.metadata.create_all(bind=database.engine)
import main
from routers import tickets, external_links

ME = "sagar.shoundik@greensglobal.com"


class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)
        db = database.SessionLocal()
        for name, area, depts in (("Egnyte", "files", ["IT", "Accounting"]),
                                  ("HikCentral", "security", ["Storage"]),
                                  ("Unclassified App", "", [])):
            db.add(models.ExternalLink(name=name, url=f"https://{name.split()[0].lower()}.example",
                                       category="X", categories=["X"], departments=depts,
                                       service_area=area))
        db.add(models.HrWorkSite(id=str(uuid.uuid4()), name="Escondido (GSE)"))
        db.commit(); db.close()

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)

    def mk(self, **kw):
        body = {"subject": "t", "type": "bug"}; body.update(kw)
        r = self.c.post("/task-tickets", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def patch(self, tid, **kw):
        # Direct call with a manager actor - same pattern as test_ticket_approval;
        # the HTTP route is desk-gated and the dev user holds no grant.
        return tickets.update_ticket(tid, tickets.TicketUpdate(**kw), BackgroundTasks(),
                                     user={"email": ME, "level": 4}, db=self.db)

    def test_mapped_app_derives_its_area(self):
        t = self.mk(application="Egnyte")
        self.assertEqual((t["application"], t["serviceArea"]), ("Egnyte", "files"))

    def test_match_is_case_insensitive(self):
        self.assertEqual(self.mk(application="hikcentral")["serviceArea"], "security")

    def test_app_with_no_mapping_is_general_not_blank(self):
        self.assertEqual(self.mk(application="Unclassified App")["serviceArea"], "general")

    def test_app_not_in_the_directory_is_general(self):
        self.assertEqual(self.mk(application="Other / not listed")["serviceArea"], "general")

    def test_no_app_leaves_the_area_unset(self):
        # _nz turns "" into None for every string field on a ticket - same as
        # component. A ticket that never named an app was never categorised.
        self.assertIsNone(self.mk()["serviceArea"])

    def test_client_cannot_choose_its_own_area(self):
        self.assertEqual(self.mk(application="Egnyte", service_area="finance")["serviceArea"], "files")

    def test_repicking_the_app_rederives_the_area(self):
        t = self.mk(application="Egnyte")
        self.assertEqual(self.patch(t["id"], application="HikCentral")["serviceArea"], "security")

    def test_explicit_area_in_the_same_patch_wins(self):
        t = self.mk(application="Egnyte")
        self.assertEqual(
            self.patch(t["id"], application="HikCentral", service_area="general")["serviceArea"],
            "general")

    def test_clearing_the_app_clears_the_area(self):
        t = self.mk(application="Egnyte")
        self.assertIsNone(self.patch(t["id"], application="")["serviceArea"])

    def test_service_answers_ride_on_type_fields(self):
        t = self.mk(application="HikCentral",
                    type_fields={"severity": "Major", "svc_facility": "Escondido (GSE)"})
        self.assertEqual(t["typeFields"], {"severity": "Major", "svc_facility": "Escondido (GSE)"})

    def test_sites_endpoint_is_names_only_and_needs_no_hr_grant(self):
        r = self.c.get("/ticket-sites")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([s["name"] for s in r.json()], ["Escondido (GSE)"])
        self.assertEqual(set(r.json()[0]), {"id", "name"})

    def test_link_carries_its_area_to_the_client(self):
        rows = self.c.get("/external-links").json()
        self.assertEqual({r["name"]: r["service_area"] for r in rows}["Egnyte"], "files")

    def test_unknown_area_on_a_link_is_coerced_not_rejected(self):
        made = external_links.create_external_link(
            external_links.ExternalLinkCreate(name="Zed", url="https://zed.example",
                                              categories=["Misc"], service_area="nonsense"),
            user={"email": ME, "level": 4}, db=self.db)
        self.assertEqual(made.service_area, "general")

    def test_blank_area_on_a_link_stays_blank(self):
        made = external_links.create_external_link(
            external_links.ExternalLinkCreate(name="Yan", url="https://yan.example",
                                              categories=["Misc"]),
            user={"email": ME, "level": 4}, db=self.db)
        self.assertEqual(made.service_area, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
