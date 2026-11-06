"""Construction Round Two item 10 - Meetings and Safety, no new tables
(Neil, 11/05/2026, plan https://claude.ai/artifact/EpG2gQr8KVi1ZZRaM6zVBE).

Pins:
  * the two safety forms are seeded once, published, fillable by anyone,
    and never re-created after the mark (an archived one stays archived);
  * New Meeting makes a note with the Meeting Minutes headings, the job as
    its source, shared with the job's people; it is invisible (404) to
    anyone else, and the Overview lists it only for those who may read it;
  * the Safety facts: last toolbox talk, days since the last near miss /
    incident, open Safety tags - counts and dates only, never answers.

Run: python -m pytest test_construction_meetings_safety.py -q
"""
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import construction_safety  # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import (ADMIN, CREW, MGR_A, MGR_B, OUTSIDER, JobsBase, iso)  # noqa: E402


class MeetingsAndSafety(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for m in (models.NexusNote, models.DocTemplateVersion):
            self.db.query(m).delete(synchronize_session=False)
        self.db.commit()

    def _seed(self):
        return construction_safety.apply_once(self.db)

    def test_the_safety_forms_are_seeded_once(self):
        self.assertEqual(self._seed(), ["Toolbox Talk", "Near Miss / Incident"])
        tb = self.fresh(models.DocTemplate, construction_safety.TOOLBOX_ID)
        self.assertEqual((tb.doc_type, tb.status, tb.published_version), ("form", "active", 1))
        att = [d for d in tb.field_defs if (d.get("repeat") or {}).get("group") == "attendees"]
        self.assertEqual([d["type"] for d in att], ["text", "signature"])
        tb.status = "archived"
        self.db.commit()
        self.assertIsNone(self._seed())     # the mark: never again
        self.assertEqual(self.fresh(models.DocTemplate, construction_safety.TOOLBOX_ID).status, "archived")
        self.assertEqual(self.db.query(models.DocTemplate).count(), 2)
        self.as_(CREW)                      # shared with every company: the crew can fill it
        r = self.client.post(f"/forms/{construction_safety.INCIDENT_ID}/entries", json={
            "entryKey": str(uuid.uuid4()), "projectId": "pa", "source": "phone",
            "answers": {"incident_date": "2026-11-05", "location": "Level 2", "what_happened": "Dropped a tool",
                        "injury": False}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["linkedProjectId"], "pa")

    def test_a_meeting_is_a_note_on_the_job_shared_with_its_people(self):
        self.as_(MGR_A)
        r = self.client.post("/construction/projects/pa/meetings")
        self.assertEqual(r.status_code, 201, r.text)
        n = r.json()
        self.assertTrue(n["title"].startswith("Job A Meeting "))
        self.assertRegex(n["title"], r"\d{2}/\d{2}/\d{4}$")
        self.assertEqual((n["source"]["kind"], n["source"]["id"]), ("construction_job", "pa"))
        for h in ("Attendees", "Safety", "Schedule", "RFIs And Submittals", "Open Items", "Action Items"):
            self.assertIn(f"<h2>{h}</h2>", n["body"])
        row = self.fresh(models.NexusNote, n["id"])
        import json
        shares = {s["email"]: s["can"] for s in json.loads(row.shared_with)}
        self.assertEqual(shares.get(CREW), "read")
        self.assertNotIn(MGR_A, shares)            # the owner is not a share
        self.assertNotIn(OUTSIDER, shares)
        self.assertEqual([m["id"] for m in self.client.get("/construction/projects/pa/connected").json()["meetings"]],
                         [n["id"]])
        self.as_(CREW)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 200)
        self.assertEqual(len(self.client.get("/construction/projects/pa/connected").json()["meetings"]), 1)
        # Not shared: the note does not exist for them, and the card stays empty.
        self.as_(ADMIN)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)
        self.assertEqual(self.client.get("/construction/projects/pa/connected").json()["meetings"], [])
        self.as_(OUTSIDER)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)
        self.as_(MGR_B)                            # another company's job: 404 like every job read
        self.assertEqual(self.client.post("/construction/projects/pa/meetings").status_code, 404)

    def _entry(self, tid, at, project="pa"):
        self.db.add(models.DocFormEntry(id=str(uuid.uuid4()), template_id=tid, template_version=1, title="x",
                                        entry_key=str(uuid.uuid4()), answers={"secret": "never shown"},
                                        company="co-a", submitted_by=CREW, submitted_at=at, status="submitted",
                                        linked_project_id=project, deleted_at=""))

    def test_the_safety_facts(self):
        self._seed()
        self.as_(MGR_A)
        s = self.client.get("/construction/projects/pa/connected").json()["safety"]
        self.assertEqual((s["lastToolboxTalk"], s["daysSinceIncident"], s["openSafetyTags"]), ("", None, 0))
        now = datetime.now(timezone.utc)
        self._entry(construction_safety.TOOLBOX_ID, (now - timedelta(days=9)).isoformat())
        self._entry(construction_safety.TOOLBOX_ID, (now - timedelta(days=2)).isoformat())
        self._entry(construction_safety.INCIDENT_ID, (now - timedelta(days=12)).isoformat())
        self._entry(construction_safety.INCIDENT_ID, (now - timedelta(days=1)).isoformat(), project="pb")
        for i, (st, tags) in enumerate((("submitted", ["safety"]), ("needs_info", ["safety", "delay"]),
                                        ("approved", ["safety"]), ("submitted", ["delay"]), ("draft", ["safety"]))):
            self.db.add(models.ConstructionDailyLog(id=f"l{i}", project_id="pa", log_date="2026-11-01",
                                                    author_email=CREW, status=st, tags=tags, deleted_at="",
                                                    created_at=iso()))
        self.db.commit()
        out = self.client.get("/construction/projects/pa/connected").json()
        s = out["safety"]
        self.assertEqual(s["openSafetyTags"], 2)
        self.assertIn(s["daysSinceIncident"], (11, 12, 13))   # the jobsite's day, not UTC's
        self.assertTrue(s["lastToolboxTalk"])
        self.assertNotIn("never shown", str(out))
        import construction_report
        p = self.fresh(models.ConstructionProject, "pa")
        data = construction_report.gather(self.db, p, "2026-11-02")
        self.assertEqual(data["safety"]["openSafetyTags"], 2)
        text = construction_report.assemble(self.db, p, data, {})["job_health"]["text"]
        self.assertIn("Open Safety tags on daily logs: 2", text)
        self.assertIn("Days since the last near miss or incident: ", text)


if __name__ == "__main__":
    import unittest
    unittest.main()
