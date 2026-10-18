"""Payroll export codes (Neil, Oct 17 2026): the name each pay class carries
in the payroll exports (the QuickBooks IIF's PITEM, the Intacct GL memo) is
a per-company setting that defaults to EXACTLY the names the exports always
used, so nothing changes for anyone until HR edits it.

  * with nothing saved, the IIF for a sample period is byte-identical to the
    file the export wrote before the setting existed;
  * a custom mapping for one company changes only that company's item names -
    not the durations, the dates, the jobs or the other company's rows;
  * the Intacct memos follow the same mapping;
  * the settings route: read open to the team readers, write administrator
    only, a blank name falls back to the default, Reset to Default clears it.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_payroll_export_codes.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "codes.admin@greensglobal.com"
PAT = "codes.pat@greensglobal.com"        # company A, hourly, CA rule
QUINN = "codes.quinn@greensglobal.com"    # company B, hourly, CA rule
MGR = "codes.mgr@greensglobal.com"        # manager: reads the codes, cannot change them
GROUP = "grp-codes-test"
SITE = "site-codes-test"
CO_A, CO_B = "co-codes-a", "co-codes-b"
START, END = "2026-09-13", "2026-09-26"

# What /timeclock/export.iif wrote for this fixture before the setting existed
# (captured from origin/dev at 7a5b0910). Pat: a 10 h day (8 regular + 2
# overtime) and a 13 h day (8 regular, 4 overtime, 1 double-time); Quinn: one
# 9 h day. Every punch is inside the Rental A fence, so JOB is Rental A.
GOLDEN = (
    "!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTEDBEFORE\tFROMTIMER\tCOMPANYCREATETIME\r\n"
    "TIMERHDR\t8\t0\tGreens Global\tN\tY\t0\r\n"
    "!TIMEACT\tDATE\tJOB\tEMP\tITEM\tPITEM\tDURATION\tPROJ\tNOTE\tXFERTOPAYROLL\tBILLINGSTATUS\r\n"
    "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1\r\n"
    "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tOvertime Pay\t2.00\t\t\tY\t1\r\n"
    "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tRegular Pay\t8.00\t\t\tY\t1\r\n"
    "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tOvertime Pay\t4.00\t\t\tY\t1\r\n"
    "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tDouble-time Pay\t1.00\t\t\tY\t1\r\n"
    "TIMEACT\t9/16/2026\tRental A\tQuinn Test\t\tRegular Pay\t8.00\t\t\tY\t1\r\n"
    "TIMEACT\t9/16/2026\tRental A\tQuinn Test\t\tOvertime Pay\t1.00\t\t\tY\t1\r\n"
)


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _shift(db, em, pid, day, hours):
    t0 = datetime.strptime(f"{day}T15:00:00", "%Y-%m-%dT%H:%M:%S")
    for n, kind, at in ((1, "in", t0), (2, "out", t0 + timedelta(hours=hours))):
        db.add(models.TimePunch(id=f"{pid}-{n}", employee_email=em, kind=kind, at=at.strftime("%Y-%m-%dT%H:%M:%S"),
                                local_date=day, tz_offset_min=0, lat="33.6846", lng="-117.8265",
                                work_site_id=SITE, work_site_name="Rental A",
                                geo_status="in_fence", voided=0,
                                created_at=at.strftime("%Y-%m-%dT%H:%M:%S")))


class ExportCodesTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        _as(ADMIN)
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="Codes A"))
            db.add(models.HrEntity(id=CO_B, name="Codes B"))
            for em, fn, co in ((ADMIN, "Admin", CO_A), (MGR, "Mgr", CO_A), (PAT, "Pat", CO_A), (QUINN, "Quinn", CO_B)):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test", work_email=em, company=co,
                                            employee_code="", department="Ops", status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="Codes Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
            for em in (PAT, QUINN):
                db.add(models.PayrollRate(employee_email=em, hourly_rate=20.0, pay_type="hourly", overtime_rule="ca"))
            db.add(models.HrWorkSite(id=SITE, name="Rental A", latitude="33.6846", longitude="-117.8265", radius_m=150))
            _shift(db, PAT, "cp1", "2026-09-16", 10)
            _shift(db, PAT, "cp2", "2026-09-17", 13)
            _shift(db, QUINN, "cq1", "2026-09-16", 9)
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("codes.%")).delete(synchronize_session=False))
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.in_((ADMIN, MGR))).delete(synchronize_session=False)
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email.in_((PAT, QUINN))).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email.in_((PAT, QUINN))).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id == SITE).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_((CO_A, CO_B))).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key.in_(
                ("payroll_earnings_codes", "timeclock_pay_premiums"))).delete(synchronize_session=False)
            db.query(models.TimeBreakPremium).filter(models.TimeBreakPremium.employee_email.in_((PAT, QUINN))).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _iif(self):
        r = self.client.get(f"/timeclock/export.iif?start={START}&end={END}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.text

    def _put(self, codes, company=CO_A, who=ADMIN):
        _as(who)
        r = self.client.put("/timeclock/payroll/export-codes", json={"company": company, "codes": codes})
        _as(ADMIN)
        return r

    def test_default_iif_is_byte_identical_to_before(self):
        self.assertEqual(self._iif(), GOLDEN)
        # Saving every default (or blanks) stores nothing and changes nothing.
        r = self._put({"regular": "Regular Pay", "overtime": "  ", "sick": ""})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(any(c["custom"] for c in r.json()["classes"]))
        self.assertEqual(self._iif(), GOLDEN)

    def test_custom_mapping_changes_only_that_companys_item_names(self):
        r = self._put({"regular": "REG", "overtime": "OT 1.5x", "doubleTime": "DT\t2x", "bogus": "x"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        by = {c["key"]: c for c in out["classes"]}
        self.assertEqual((by["regular"]["code"], by["regular"]["custom"]), ("REG", True))
        self.assertEqual(by["doubleTime"]["code"], "DT 2x")            # a tab never reaches the IIF
        self.assertEqual((by["sick"]["code"], by["sick"]["custom"]), ("Sick Pay", False))
        self.assertEqual(by["holiday"]["default"], "Holiday Pay")
        self.assertNotIn("bogus", by)
        expected = GOLDEN
        for old, new in (("Pat Test\t\tRegular Pay", "Pat Test\t\tREG"),
                         ("Pat Test\t\tOvertime Pay", "Pat Test\t\tOT 1.5x"),
                         ("Pat Test\t\tDouble-time Pay", "Pat Test\t\tDT 2x")):
            expected = expected.replace(old, new)
        got = self._iif()
        self.assertEqual(got, expected)
        # Quinn (company B) keeps the defaults.
        self.assertIn("Quinn Test\t\tRegular Pay\t8.00", got)
        # Reset to Default puts the file back exactly.
        r = self._put({})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._iif(), GOLDEN)

    def test_intacct_memos_follow_the_mapping(self):
        def memos():
            r = self.client.get(f"/timeclock/export-intacct.csv?start={START}&end={END}&expense=60100&clearing=21500")
            self.assertEqual(r.status_code, 200, r.text)
            return [line for line in r.text.splitlines() if "Test - " in line]
        before = memos()
        self.assertTrue(any("Pat Test - Regular Pay - 16.00 h" in m for m in before))
        self._put({"regular": "REG"})
        after = memos()
        self.assertEqual(after, [m.replace("Pat Test - Regular Pay", "Pat Test - REG") for m in before])
        self.assertTrue(any("Quinn Test - Regular Pay" in m for m in after))

    def test_two_pay_classes_under_one_name_are_refused(self):
        # QuickBooks would merge them - sick and vacation paid as one line.
        r = self._put({"sick": "Leave Pay", "vacation": "leave pay"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("QuickBooks would merge them", r.json()["detail"])
        r = self._put({"sick": "Regular Pay"})     # clashes with a default name
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self._iif(), GOLDEN)      # nothing was saved

    def test_settings_permissions(self):
        _as(MGR)
        r = self.client.get(f"/timeclock/payroll/export-codes?company={CO_A}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([c["key"] for c in r.json()["classes"]],
                         ["regular", "overtime", "doubleTime", "holiday", "sick", "vacation", "personal",
                          "shiftDifferential", "callBack", "mealPremium", "restPremium"])
        self.assertIn(self._put({"regular": "REG"}, who=MGR).status_code, (401, 403))
        _as(PAT)
        self.assertIn(self.client.get(f"/timeclock/payroll/export-codes?company={CO_A}").status_code, (401, 403))
        _as(ADMIN)
        self.assertEqual(self._put({"regular": "REG"}, company="no-such-company").status_code, 404)
        self.assertEqual(self._iif(), GOLDEN)

    def test_pay_premiums_settings_permissions(self):
        """Shift differentials + call-back (pay_premiums.py): same permissions
        as the export codes - team readers read, administrators write, inside
        the company wall."""
        body = {"company": CO_A, "enabled": True,
                "differentials": [{"name": "Night Differential", "kind": "flat", "amount": 2,
                                   "start": "22:00", "end": "06:00", "days": [], "sites": []}],
                "callBack": {"enabled": True, "minimumMin": 120, "gapMin": 60}}
        _as(MGR)
        r = self.client.get(f"/timeclock/payroll/premiums?company={CO_A}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["enabled"])                     # off by default
        self.assertIn(self.client.put("/timeclock/payroll/premiums", json=body).status_code, (401, 403))
        _as(PAT)
        self.assertIn(self.client.get(f"/timeclock/payroll/premiums?company={CO_A}").status_code, (401, 403))
        _as(ADMIN)
        r = self.client.put("/timeclock/payroll/premiums", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["differentials"][0]["name"], "Night Differential")
        self.assertEqual(self.client.put("/timeclock/payroll/premiums",
                                         json={**body, "company": "no-such-company"}).status_code, 404)
        # Company A only: Pat's 15:00-01:00 and 15:00-04:00 (UTC) shifts get
        # 3 h and 6 h of night differential; Quinn (company B) is untouched.
        iif = self._iif()
        self.assertIn("TIMEACT\t9/16/2026\tRental A\tPat Test\t\tShift Differential\t3.00\t\t\tY\t1\r\n", iif)
        self.assertIn("TIMEACT\t9/17/2026\tRental A\tPat Test\t\tShift Differential\t6.00\t\t\tY\t1\r\n", iif)
        self.assertEqual([ln for ln in iif.split("\r\n") if "Quinn" in ln],
                         [ln for ln in GOLDEN.split("\r\n") if "Quinn" in ln])
        self.assertEqual(iif.replace("TIMEACT\t9/16/2026\tRental A\tPat Test\t\tShift Differential\t3.00\t\t\tY\t1\r\n", "")
                         .replace("TIMEACT\t9/17/2026\tRental A\tPat Test\t\tShift Differential\t6.00\t\t\tY\t1\r\n", ""),
                         GOLDEN)


class BreakPremiumExportTests(ExportCodesTests):
    """CA meal / rest premiums (Oct 17 2026): with none on a card every export
    is the file it always was (GOLDEN above, and the CSV without the premium
    columns); a premium is 1.00 h at its own payroll item, at the day's rate."""

    def _premium(self, day, kind):
        db = database.SessionLocal()
        try:
            db.add(models.TimeBreakPremium(id=f"bp-{day}-{kind}", employee_email=PAT, local_date=day, kind=kind,
                                           status="active", source="manager", created_at="2026-09-27T00:00:00"))
            db.commit()
        finally:
            db.close()

    def _csv(self):
        r = self.client.get(f"/timeclock/export.csv?start={START}&end={END}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.text

    def test_no_premium_means_no_change(self):
        self.assertEqual(self._iif(), GOLDEN)
        header = self._csv().splitlines()[0]
        self.assertTrue(header.endswith("Total Pay,Approved"), header)
        r = self.client.get(f"/timeclock/export-hours?start={START}&end={END}")
        self.assertTrue(all(set(x["hours"]) == {"regular", "overtime", "doubleTime", "sick", "vacation", "personal"}
                            for x in r.json()["rows"]))

    def test_premiums_are_their_own_payroll_items(self):
        self._premium("2026-09-16", "meal")
        self._premium("2026-09-17", "rest")
        got = self._iif()
        expected = GOLDEN.replace(
            "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tOvertime Pay\t2.00\t\t\tY\t1\r\n",
            "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tOvertime Pay\t2.00\t\t\tY\t1\r\n"
            "TIMEACT\t9/16/2026\tRental A\tPat Test\t\tMeal Premium\t1.00\t\t\tY\t1\r\n").replace(
            "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tDouble-time Pay\t1.00\t\t\tY\t1\r\n",
            "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tDouble-time Pay\t1.00\t\t\tY\t1\r\n"
            "TIMEACT\t9/17/2026\tRental A\tPat Test\t\tRest Premium\t1.00\t\t\tY\t1\r\n")
        self.assertEqual(got, expected)
        # Renamed per company like every other class.
        self._put({"mealPremium": "CA Meal Prem"})
        self.assertIn("Pat Test\t\tCA Meal Prem\t1.00", self._iif())
        r = self.client.get(f"/timeclock/export-intacct.csv?start={START}&end={END}&expense=60100&clearing=21500")
        self.assertIn("Pat Test - CA Meal Prem - 1.00 h", r.text)
        self.assertIn("Pat Test - Rest Premium - 1.00 h", r.text)
        csv_text = self._csv()
        self.assertTrue(csv_text.splitlines()[0].endswith(
            "Approved,Meal Premium Hours,Meal Premium Pay,Rest Premium Hours,Rest Premium Pay"))
        pat_total = next(line for line in csv_text.splitlines() if line.startswith("Pat Test") and ",TOTAL," in line)
        self.assertTrue(pat_total.endswith(",1.00,20.00,1.00,20.00"), pat_total)
        # Quinn has no premium: empty premium hours, no new key.
        r = self.client.get(f"/timeclock/export-hours?start={START}&end={END}")
        hours = {x["email"]: x["hours"] for x in r.json()["rows"]}
        self.assertEqual((hours[PAT]["mealPremium"], hours[PAT]["restPremium"]), (1.0, 1.0))
        self.assertNotIn("mealPremium", hours[QUINN])


if __name__ == "__main__":
    unittest.main()
