"""Construction Round Three item 3 - labor by cost code (Neil, 11/11/2026,
plan https://claude.ai/artifact/VqZSQRz41ffF1VGouJUKLJ).

Pins:
  * a job's labor codes (Intacct items) are set by its managers who may see
    its money; cleaned, no repeats, at most 40; every reader sees them;
  * the Time Clock asks /my-cost-codes for the caller's day: the job they
    are placed at and its codes, nothing when the shift is on no such job;
  * a code sent with an IN punch is KEPT only when the punch is stamped to
    that job and the code is on its list - otherwise dropped, and the punch
    always lands; an OUT punch never carries one;
  * the job's hours split by cost code, '' = Not Coded; hours only.

Run: python -m pytest test_construction_labor_codes.py -q
"""
import os
import tempfile
from datetime import datetime, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.pop("ANTHROPIC_API_KEY", None)

import cache                # noqa: E402
import construction_labor   # noqa: E402
import models               # noqa: E402
from construction_jobs_testkit import CREW, CREW2, MGR_A, MGR_B, JobsBase, iso  # noqa: E402

DAY = "2026-11-02"   # a Monday; PST is UTC-8 in November
CODES = [{"code": "CC-100", "name": "Sitework"}, {"code": "CC-200", "name": "Concrete"}]
GROUP = "grp-labor-codes"


class LaborCodes(JobsBase):
    tmp_db = _tmp.name

    def setUp(self):
        super().setUp()
        for m in (models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete(synchronize_session=False)
        self.db.add(models.NexusGroup(id=GROUP, name="Labor Codes Accounting", allowed_modules="accounting:viewer"))
        self.db.add(models.NexusGroupMember(group_id=GROUP, email=MGR_A))
        self.db.get(models.ConstructionProject, "pa").labor_codes = CODES
        self.db.commit()
        cache.module_grants.invalidate()

    def _shift(self, sid, email, jobsite, day=DAY):
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm="07:00",
                                          end_hhmm="15:30", published=1, pending_delete=0, jobsite=jobsite,
                                          weather_status="", break_min=30, created_at=iso()))

    def _punch(self, pid, email, kind, at, code="", job=""):
        p = models.TimePunch(id=pid, employee_email=email, kind=kind, at=at, local_date=DAY, tz_offset_min=480,
                             voided=0, created_at=iso())
        if code:
            construction_labor.offer_cost_code(p, code, job)
        self.db.add(p)
        return p

    def test_managers_with_money_set_the_codes_and_everyone_reads_them(self):
        put = lambda body: self.client.put("/construction/projects/pa/labor-codes", json=body)  # noqa: E731
        self.as_(CREW)
        self.assertEqual(put({"codes": CODES}).status_code, 403)
        self.as_(MGR_B)
        self.assertEqual(put({"codes": CODES}).status_code, 404)
        self.as_(MGR_A)
        self.assertEqual(put({"codes": [{"code": "bad code!!"}]}).status_code, 422)
        r = put({"codes": [{"code": "CC-300", "name": "  Framing  "}, {"code": "CC-300", "name": "again"}, {"code": ""}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["laborCodes"], [{"code": "CC-300", "name": "Framing"}])
        self.as_(CREW)
        self.assertEqual(self.client.get("/construction/projects/pa").json()["laborCodes"], [{"code": "CC-300", "name": "Framing"}])

    def test_the_time_clock_offers_the_days_job_codes(self):
        self._shift("s1", CREW, "project-pa")
        self._shift("s2", CREW2, "project-pb")
        self.db.commit()
        self.as_(CREW)
        got = self.client.get(f"/construction/my-cost-codes?date={DAY}").json()
        self.assertEqual((got["jobId"], got["codes"]), ("pa", CODES))
        self.assertEqual(self.client.get("/construction/my-cost-codes?date=2026-11-03").json(), {"codes": []})
        self.assertEqual(self.client.get("/construction/my-cost-codes?date=nope").json(), {"codes": []})
        self.as_(CREW2)   # job B has no labor codes
        self.assertEqual(self.client.get(f"/construction/my-cost-codes?date={DAY}").json(), {"codes": []})

    def test_two_jobs_in_a_day_offer_the_one_holding_now(self):
        # Review (11/11/2026): the offer follows the same placement the punch stamp picks.
        self.db.get(models.ConstructionProject, "pb").labor_codes = [{"code": "CC-900", "name": "Landscaping"}]
        for sid, js, a, b in (("am", "project-pa", "07:00", "11:00"), ("pm", "project-pb", "12:00", "16:00")):
            self.db.add(models.ScheduledShift(id=sid, employee_email=CREW, work_date=DAY, start_hhmm=a, end_hhmm=b,
                                              published=1, pending_delete=0, jobsite=js, weather_status="",
                                              break_min=0, created_at=iso()))
        self.db.commit()
        self.as_(CREW)
        self.assertEqual(self.client.get(f"/construction/my-cost-codes?date={DAY}&minute=480").json()["jobId"], "pa")
        self.assertEqual(self.client.get(f"/construction/my-cost-codes?date={DAY}&minute=725").json(), {"codes": []})

    def test_a_code_is_kept_only_for_the_stamped_job_and_never_blocks_the_punch(self):
        self._shift("s1", CREW, "project-pa")
        self.db.commit()
        self._punch("ok", CREW, "in", "2026-11-02T15:00:00+00:00", "CC-100", "pa")
        self._punch("unlisted", CREW, "in", "2026-11-02T16:00:00+00:00", "CC-999", "pa")
        self._punch("wrong-job", CREW, "in", "2026-11-02T17:00:00+00:00", "CC-100", "pb")
        self._punch("no-shift", CREW2, "in", "2026-11-02T15:00:00+00:00", "CC-100", "pa")
        self.db.commit()
        got = {pid: (self.fresh(models.TimePunch, pid).jobsite, self.fresh(models.TimePunch, pid).cost_code)
               for pid in ("ok", "unlisted", "wrong-job", "no-shift")}
        self.assertEqual(got, {"ok": ("project-pa", "CC-100"), "unlisted": ("project-pa", ""),
                               "wrong-job": ("project-pa", ""), "no-shift": ("", "")})

    def test_the_punch_route_passes_the_code_through(self):
        today = datetime.now(timezone.utc).date().isoformat()   # tz_offset_min 0 below: the UTC day
        self._shift("s1", CREW, "project-pa", day=today)
        self.db.add(models.TimeBod(id="bod1", employee_email=CREW, kind="bod", local_date=today, message="Morning",
                                   created_at=iso()))
        self.db.commit()
        self.as_(CREW)
        r = self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0,
                                                       "cost_code": "CC-200", "cost_code_job": "pa"})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.db.query(models.TimePunch).filter_by(employee_email=CREW, kind="in").one()
        self.assertEqual(row.cost_code, "CC-200")

    def test_hours_split_by_code_and_never_pay(self):
        self._shift("s1", CREW, "project-pa")
        self._shift("s2", CREW2, "project-pa")
        self.db.commit()
        self._punch("a-in", CREW, "in", "2026-11-02T15:00:00+00:00", "CC-100", "pa")
        self._punch("a-out", CREW, "out", "2026-11-02T19:00:00+00:00")
        self._punch("a-in2", CREW, "in", "2026-11-02T20:00:00+00:00", "CC-200", "pa")
        self._punch("a-out2", CREW, "out", "2026-11-02T22:00:00+00:00")
        self._punch("b-in", CREW2, "in", "2026-11-02T15:00:00+00:00")
        self._punch("b-out", CREW2, "out", "2026-11-02T16:30:00+00:00")
        self.db.commit()
        self.as_(MGR_A)
        out = self.client.get("/construction/projects/pa/labor").json()
        self.assertEqual(out["byCode"], [{"code": "CC-100", "name": "Sitework", "hours": 4.0},
                                         {"code": "CC-200", "name": "Concrete", "hours": 2.0},
                                         {"code": "", "name": "Not Coded", "hours": 1.5}])
        self.assertEqual(out["total"], 7.5)
        for word in ("rate", "pay", "wage"):
            self.assertNotIn(word, str(out["byCode"]).lower())
