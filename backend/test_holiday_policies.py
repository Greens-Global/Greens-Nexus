"""Holiday policies (Neil, Oct 29 2026 - docs/superpowers/specs/
2026-10-29-holiday-policies-design.md): holiday_sources, the weekend rules,
holiday_policies.sync and the routes in routers/hr.py.

  * the US list is computed in-house with real dates and US names
    (Presidents' Day, never "Washington's Birthday"); `observed` is a hint;
  * India's feed is classified (national / gazetted / restricted),
    "(tentative)" stripped, partial years flagged;
  * a policy applies LIVE to the companies it is assigned to; a company can
    skip a holiday or change one for itself; unassigning keeps the changed
    ones as the company's own;
  * the readers (Time Sheets) still see the days, per country.

    python -m pytest -q test_holiday_policies.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import holiday_policies as hp  # noqa: E402
import holiday_sources as hs  # noqa: E402
import main  # noqa: E402,F401 - builds the app (and its migrations) like production
import models  # noqa: E402
from routers import hr  # noqa: E402
from routers import timeclock  # noqa: E402

CO_A, CO_B, CO_C = "co-hol-a", "co-hol-b", "co-hol-c"
A_US, A_IN, B_US = "ana.hol@greensglobal.com", "arjun.hol@greensglobal.com", "ben.hol@greensglobal.com"
ADMIN = {"email": "owner.hol@greensglobal.com", "level": 5, "role": "owner"}
SCOPED = {"email": "scoped.hol@greensglobal.com", "level": 2, "role": "supervisor"}


class _Resp:
    def __init__(self, status=200, text="", data=None):
        self.status_code, self.text, self._data = status, text, data

    @property
    def is_success(self):
        return 200 <= self.status_code < 300

    def json(self):
        return self._data

    def raise_for_status(self):
        if not self.is_success:
            raise RuntimeError(self.status_code)


def _no_network(*a, **k):
    raise RuntimeError("no network in tests")


INDIA_ICS = "\r\n".join([
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260126", "SUMMARY:Republic Day", "DESCRIPTION:Public holiday", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260815", "SUMMARY:Independence Day", "DESCRIPTION:Public holiday", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261002", "SUMMARY:Mahatma Gandhi Jayanti", "DESCRIPTION:Public holiday",
    "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260304", "SUMMARY:Holi", "DESCRIPTION:Public holiday", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260114", "SUMMARY:Pongal",
    "DESCRIPTION:Observance\\nTo hide observances\\, go to Google Calendar Setti",
    " ngs > Holidays in India", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260527", "SUMMARY:Bakrid / Eid al Adha (tentative)",
    "DESCRIPTION:Public holiday", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20270126", "SUMMARY:Republic Day", "DESCRIPTION:Public holiday", "END:VEVENT",
    "END:VCALENDAR",
])


def _hol(date, name, countries=("US",), type_="mandatory", **extra):
    return dict({"date": date, "name": name, "type": type_, "countries": list(countries)}, **extra)


class SourcesCase(unittest.TestCase):
    def setUp(self):
        hs.clear_cache()
        self._get = hs.httpx.get

    def tearDown(self):
        hs.httpx.get = self._get
        hs.clear_cache()

    def _by_name(self, rows):
        return {r["name"]: r for r in rows}

    def test_us_2026_federal_real_dates(self):
        rows = self._by_name(hs.us_federal(2026))
        self.assertEqual(len(rows), 11)
        self.assertEqual(rows["Presidents' Day"]["date"], "2026-02-16")
        self.assertNotIn("Washington's Birthday", rows)
        self.assertIn("Labor Day", rows)
        self.assertEqual(rows["Independence Day"]["date"], "2026-07-04")     # a Saturday - real date
        self.assertEqual(rows["Independence Day"]["weekday"], "Saturday")
        self.assertEqual(rows["Independence Day"]["observed"], "2026-07-03")
        self.assertEqual(rows["Labor Day"]["observed"], "")                 # not a fixed-date holiday
        self.assertTrue(all(r["scope"] == "federal" for r in rows.values()))

    def test_us_2027_federal_and_observed(self):
        rows = self._by_name(hs.us_federal(2027))
        self.assertEqual(rows["Presidents' Day"]["date"], "2027-02-15")
        self.assertEqual(rows["Independence Day"]["date"], "2027-07-04")
        self.assertEqual(rows["Independence Day"]["observed"], "2027-07-05")
        self.assertEqual(rows["Christmas Day"]["date"], "2027-12-25")
        self.assertEqual(rows["Christmas Day"]["observed"], "2027-12-24")
        self.assertEqual(rows["Juneteenth"]["observed"], "2027-06-18")

    def test_us_common_and_easter(self):
        self.assertEqual(hs.easter(2026).isoformat(), "2026-04-05")
        self.assertEqual(hs.easter(2027).isoformat(), "2027-03-28")
        rows = self._by_name(hs.us_common(2026))
        self.assertEqual(rows["Good Friday"]["date"], "2026-04-03")
        self.assertEqual(rows["Day After Thanksgiving"]["date"], "2026-11-27")
        self.assertEqual(rows["Christmas Eve"]["date"], "2026-12-24")
        self.assertEqual(rows["New Year's Eve"]["date"], "2026-12-31")
        self.assertTrue(all(r["scope"] == "company_common" for r in rows.values()))

    def test_observed_federal(self):
        self.assertEqual(hs.observed_federal("2027-07-04"), "2027-07-05")
        self.assertEqual(hs.observed_federal("2026-07-04"), "2026-07-03")
        self.assertEqual(hs.observed_federal("2026-07-01"), "2026-07-01")

    def test_us_state_days_from_nager(self):
        data = [
            {"date": "2026-02-16", "localName": "Washington's Birthday", "name": "Presidents Day", "global": True},
            {"date": "2026-02-12", "localName": "Lincoln's Birthday", "name": "Lincoln's Birthday", "global": False,
             "counties": ["US-CA", "US-CT"]},
            {"date": "2026-02-12", "localName": "Lincoln's Birthday", "name": "Lincoln's Birthday", "global": False,
             "counties": ["US-IL", "US-CA"]},
            {"date": "2026-04-03", "localName": "Good Friday", "name": "Good Friday", "global": False,
             "counties": ["US-CT"]},
        ]
        hs.httpx.get = lambda *a, **k: _Resp(200, data=data)
        res = hs.public_holidays("US", 2026)
        self.assertEqual(res["source"], "mixed")
        names = [h["name"] for h in res["holidays"]]
        self.assertNotIn("Washington's Birthday", names)
        self.assertEqual(names.count("Good Friday"), 1)          # the computed one, not the state copy
        lincoln = [h for h in res["holidays"] if h["name"] == "Lincoln's Birthday"]
        self.assertEqual(len(lincoln), 1)
        self.assertEqual(lincoln[0]["scope"], "state:CA,CT,IL")

    def test_us_nager_down_is_computed_only(self):
        hs.httpx.get = _no_network
        res = hs.public_holidays("US", 2026)
        self.assertEqual(res["source"], "computed")
        self.assertTrue(res["note"])
        self.assertEqual(len(res["holidays"]), 15)

    def test_india_classification(self):
        hs.httpx.get = lambda *a, **k: _Resp(200, text=INDIA_ICS)
        res = hs.public_holidays("IN", 2026)
        rows = self._by_name(res["holidays"])
        for n in ("Republic Day", "Independence Day", "Gandhi Jayanti"):
            self.assertEqual(rows[n]["scope"], "national")
            self.assertEqual(rows[n]["suggestedType"], "mandatory")
        self.assertNotIn("Mahatma Gandhi Jayanti", rows)
        self.assertEqual([h["name"] for h in res["holidays"]].count("Republic Day"), 1)
        self.assertEqual(rows["Holi"]["scope"], "gazetted")
        self.assertEqual(rows["Holi"]["suggestedType"], "mandatory")
        self.assertEqual(rows["Pongal"]["scope"], "restricted")
        self.assertEqual(rows["Pongal"]["suggestedType"], "optional")
        eid = rows["Bakrid / Eid al Adha"]
        self.assertTrue(eid["tentative"])
        self.assertFalse(rows["Holi"]["tentative"])
        self.assertTrue(res["partial"])
        self.assertEqual(res["note"], "Partial list for 2026 - confirm dates nearer the time")

    def test_other_country_and_no_data(self):
        hs.httpx.get = lambda *a, **k: _Resp(200, data=[{"date": "2026-12-25", "localName": "Christmas Day"},
                                                         {"date": "2026-12-25", "localName": "Christmas Day"}])
        res = hs.public_holidays("GB", 2026)
        self.assertEqual(res["source"], "nager")
        self.assertEqual(len(res["holidays"]), 1)
        self.assertEqual(res["holidays"][0]["scope"], "public")
        hs.httpx.get = lambda *a, **k: _Resp(204)
        self.assertIsNone(hs.public_holidays("ZZ", 2026))

    def test_route_404_for_no_data(self):
        hs.httpx.get = lambda *a, **k: _Resp(204)
        with self.assertRaises(HTTPException) as cm:
            hr.public_holidays(country="ZZ", year=2026, user=ADMIN)
        self.assertEqual(cm.exception.status_code, 404)


class WeekendRuleCase(unittest.TestCase):
    def test_every_rule(self):
        sun, sat = "2027-07-04", "2026-07-04"
        self.assertEqual(hp.apply_rule(sun, "keep"), sun)
        self.assertEqual(hp.apply_rule(sat, "keep"), sat)
        self.assertEqual(hp.apply_rule(sun, "nearest_weekday"), "2027-07-05")
        self.assertEqual(hp.apply_rule(sat, "nearest_weekday"), "2026-07-03")
        self.assertEqual(hp.apply_rule(sun, "next_monday"), "2027-07-05")
        self.assertEqual(hp.apply_rule(sat, "next_monday"), "2026-07-06")
        self.assertEqual(hp.apply_rule(sun, "prior_friday"), "2027-07-02")
        self.assertEqual(hp.apply_rule(sat, "prior_friday"), "2026-07-03")
        self.assertIsNone(hp.apply_rule(sun, "not_observed"))
        self.assertIsNone(hp.apply_rule(sat, "not_observed"))
        self.assertEqual(hp.apply_rule("2026-07-01", "not_observed"), "2026-07-01")   # a weekday never moves

    def test_normalize_old_rows(self):
        n = hp.normalize_holiday({"date": "2026-02-16", "name": "Presidents' Day", "country_code": "US",
                                  "source": "public", "type": "mandatory"})
        self.assertEqual(n["key"], "US:presidents-day:2026")
        self.assertEqual(n["countries"], ["US"])


class PolicyCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        hs.clear_cache()
        self._get, hs.httpx.get = hs.httpx.get, _no_network
        self.db = database.SessionLocal()
        for m in (models.HrCompanyHoliday, models.HrHolidayPolicy, models.HrHolidayPolicyAssignment,
                  models.HrEntity, models.NexusEmployee, models.NexusAccessScope, models.AuditLog):
            self.db.query(m).delete()
        for cid, name in ((CO_A, "Greens A"), (CO_B, "Greens B"), (CO_C, "Greens C")):
            self.db.add(models.HrEntity(id=cid, name=name, country="US"))
        for i, (em, co, country) in enumerate(((A_US, CO_A, "US"), (A_IN, CO_A, "IN"), (B_US, CO_B, "US"))):
            self.db.add(models.NexusEmployee(id=f"emp-hol-{i}", work_email=em, first_name="T", last_name=str(i),
                                             company=co, country=country, status="active"))
        self.db.add(models.NexusAccessScope(id="sc-hol-1", email=SCOPED["email"], module_id="hr",
                                            scope_type="entity", scope_id=CO_A))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        hs.httpx.get = self._get
        hs.clear_cache()

    # -- helpers --
    def _body(self, holidays, companies=None, name="US Holidays", **kw):
        return hr.HolidayPolicyIn(name=name, holidays=holidays, companies=companies, companyId=CO_A, **kw)

    def _create(self, holidays, companies=(CO_A, CO_B), **kw):
        out = hr.create_holiday_policy(self._body(holidays, list(companies), **kw), user=ADMIN, db=self.db)
        return out["policy"], out["sync"]

    def _rows(self, company):
        self.db.expire_all()
        return {r.name: r for r in self.db.query(models.HrCompanyHoliday)
                .filter(models.HrCompanyHoliday.company_id == company).all()}

    def _pay(self, em, start="2026-01-01", end="2027-12-31"):
        self.db.expire_all()
        return timeclock._company_holidays_for_employee(self.db, em, start, end)

    US_SET = [_hol("2026-07-04", "Independence Day"), _hol("2026-12-25", "Christmas Day")]

    # -- tests --
    def test_assign_to_two_companies(self):
        pol, res = self._create(self.US_SET)
        self.assertEqual(res, {"companies": 2, "added": 4, "updated": 0, "removed": 0, "detached": 0})
        for co in (CO_A, CO_B):
            rows = self._rows(co)
            self.assertEqual(set(rows), {"Independence Day", "Christmas Day"})
            self.assertTrue(all(r.policy_id == pol["id"] and r.source == "policy" and r.country_code == "US"
                                for r in rows.values()))
        self.assertEqual(pol["holidays"][0]["key"], "US:independence-day:2026")
        self.assertEqual({c["id"] for c in pol["companies"]}, {CO_A, CO_B})
        self.assertTrue(pol["canEdit"])
        self.assertTrue(self.db.query(models.AuditLog).filter(models.AuditLog.resource_type == "holiday_policy").count())

    def test_edit_moves_both_companies(self):
        pol, _ = self._create(self.US_SET)
        moved = [dict(h, key=f"US:{hp.slug(h['name'])}:2026") for h in self.US_SET]
        moved[0].update(date="2026-07-03", actualDate="2026-07-04")
        _, res = (lambda o: (o["policy"], o["sync"]))(
            hr.update_holiday_policy(pol["id"], self._body(moved), user=ADMIN, db=self.db))
        self.assertEqual(res["updated"], 2)
        for co in (CO_A, CO_B):
            r = self._rows(co)["Independence Day"]
            self.assertEqual((r.date, r.actual_date), ("2026-07-03", "2026-07-04"))

    def test_override_survives_policy_edit(self):
        pol, _ = self._create(self.US_SET)
        rid = self._rows(CO_A)["Christmas Day"].id
        hr.update_company_holiday(CO_A, rid, hr.CompanyHolidayPatchIn(type="half_day"), user=ADMIN, db=self.db)
        edited = [dict(h) for h in self.US_SET]
        edited[1]["type"] = "optional"
        hr.update_holiday_policy(pol["id"], self._body(edited), user=ADMIN, db=self.db)
        a, b = self._rows(CO_A)["Christmas Day"], self._rows(CO_B)["Christmas Day"]
        self.assertEqual((a.type, a.overridden), ("half_day", 1))
        self.assertEqual(b.type, "optional")
        # Reset To Policy brings the policy's type back
        hr.reset_company_holiday(CO_A, rid, user=ADMIN, db=self.db)
        a = self._rows(CO_A)["Christmas Day"]
        self.assertEqual((a.type, a.overridden), ("optional", 0))

    def test_date_override_keeps_actual_date(self):
        self._create(self.US_SET)
        rid = self._rows(CO_A)["Independence Day"].id
        out = hr.update_company_holiday(CO_A, rid, hr.CompanyHolidayPatchIn(date="2026-07-03"), user=ADMIN, db=self.db)
        self.assertEqual((out["date"], out["actualDate"], out["overridden"]), ("2026-07-03", "2026-07-04", True))
        self.assertEqual(self._pay(A_US, "2026-07-01", "2026-07-31"),
                         {"2026-07-03": {"name": "Independence Day", "type": "mandatory"}})

    def test_skip_and_restore(self):
        pol, _ = self._create(self.US_SET)
        key = "US:independence-day:2026"
        cal = hr.skip_policy_holiday(CO_A, pol["id"], hr.HolidaySkipIn(key=key, skip=True), user=ADMIN, db=self.db)
        self.assertNotIn("Independence Day", self._rows(CO_A))
        self.assertIn("Independence Day", self._rows(CO_B))
        self.assertEqual([s["key"] for s in cal["skipped"]], [key])
        self.assertEqual(cal["policies"][0]["skipped"], [key])
        hr.skip_policy_holiday(CO_A, pol["id"], hr.HolidaySkipIn(key=key, skip=False), user=ADMIN, db=self.db)
        self.assertIn("Independence Day", self._rows(CO_A))

    def test_unassign_keeps_overridden_as_own(self):
        pol, _ = self._create(self.US_SET)
        rid = self._rows(CO_A)["Christmas Day"].id
        hr.update_company_holiday(CO_A, rid, hr.CompanyHolidayPatchIn(type="half_day"), user=ADMIN, db=self.db)
        cal = hr.unassign_holiday_policy(CO_A, pol["id"], user=ADMIN, db=self.db)
        rows = self._rows(CO_A)
        self.assertEqual(set(rows), {"Christmas Day"})
        self.assertEqual((rows["Christmas Day"].policy_id, rows["Christmas Day"].overridden), ("", 0))
        self.assertEqual(cal["policies"], [])
        self.assertEqual([p["id"] for p in cal["available"]], [pol["id"]])
        self.assertEqual(len(self._rows(CO_B)), 2)

    def test_delete_policy(self):
        pol, _ = self._create(self.US_SET)
        rid = self._rows(CO_B)["Independence Day"].id
        hr.update_company_holiday(CO_B, rid, hr.CompanyHolidayPatchIn(name="Fourth Of July"), user=ADMIN, db=self.db)
        out = hr.delete_holiday_policy(pol["id"], user=ADMIN, db=self.db)
        self.assertEqual(out["sync"]["removed"], 3)
        self.assertEqual(out["sync"]["detached"], 1)
        self.assertEqual(self._rows(CO_A), {})
        self.assertEqual(set(self._rows(CO_B)), {"Fourth Of July"})
        self.assertEqual(self.db.query(models.HrHolidayPolicy).count(), 0)
        self.assertEqual(self.db.query(models.HrHolidayPolicyAssignment).count(), 0)

    def test_readers_per_country(self):
        holidays = [_hol("2026-07-04", "Independence Day", ("US",)),
                    _hol("2026-08-15", "Independence Day", ("IN",)),
                    _hol("2026-12-25", "Christmas Day", ("IN", "US"), type_="optional")]
        self._create(holidays, companies=(CO_A, CO_B), name="US And India")
        self.assertEqual(self._pay(A_US), {"2026-07-04": {"name": "Independence Day", "type": "mandatory"},
                                           "2026-12-25": {"name": "Christmas Day", "type": "optional"}})
        self.assertEqual(self._pay(A_IN), {"2026-08-15": {"name": "Independence Day", "type": "mandatory"},
                                           "2026-12-25": {"name": "Christmas Day", "type": "optional"}})
        self.assertEqual(set(self._pay(B_US)), {"2026-07-04", "2026-12-25"})
        self.assertEqual(self._rows(CO_A)["Christmas Day"].country_code, "IN,US")

    def test_scoped_admin_cannot_assign_outside_scope(self):
        pol, _ = self._create(self.US_SET, companies=(CO_A, CO_B))
        with self.assertRaises(HTTPException) as cm:
            hr.assign_holiday_policy(CO_C, pol["id"], user=SCOPED, db=self.db)
        self.assertEqual(cm.exception.status_code, 404)
        with self.assertRaises(HTTPException):
            hr.update_holiday_policy(pol["id"], self._body(self.US_SET, [CO_A, CO_C]), user=SCOPED, db=self.db)
        # inside scope: replacing the set with [] drops only A; B (out of sight) stays assigned
        hr.update_holiday_policy(pol["id"], self._body(self.US_SET, []), user=SCOPED, db=self.db)
        self.db.expire_all()
        left = {a.company_id for a in self.db.query(models.HrHolidayPolicyAssignment).all()}
        self.assertEqual(left, {CO_B})
        listed = hr.list_holiday_policies(user=SCOPED, db=self.db)
        self.assertEqual(listed[0]["companies"], [])          # B is not shown to someone scoped to A
        self.assertTrue(listed[0]["canEdit"])

    def test_preview_counts(self):
        pol, _ = self._create(self.US_SET, companies=(CO_A, CO_B))
        key = "US:independence-day:2026"
        hr.skip_policy_holiday(CO_B, pol["id"], hr.HolidaySkipIn(key=key, skip=True), user=ADMIN, db=self.db)
        hr.create_company_holiday(CO_C, hr.CompanyHolidayIn(date="2026-12-25", name="Christmas Day",
                                                            source="public", country_code="US"),
                                  user=ADMIN, db=self.db)
        new = [dict(self.US_SET[0], date="2026-07-03", actualDate="2026-07-04"), self.US_SET[1],
               _hol("2026-11-26", "Thanksgiving Day")]
        before = self.db.query(models.HrCompanyHoliday).count()
        out = hr.preview_holiday_policy(pol["id"], self._body(new, [CO_A, CO_B, CO_C]), user=ADMIN, db=self.db)
        by = {c["id"]: c for c in out["companies"]}
        self.assertEqual(self.db.query(models.HrCompanyHoliday).count(), before)   # nothing written
        self.assertEqual([h["name"] for h in by[CO_A]["added"]], ["Thanksgiving Day"])
        self.assertEqual([h["name"] for h in by[CO_A]["changed"]], ["Independence Day"])
        self.assertEqual(by[CO_B]["changedSkipped"], 1)
        self.assertEqual(len(by[CO_C]["added"]), 3)
        self.assertEqual(by[CO_C]["conflicts"], [{"date": "2026-12-25", "name": "Christmas Day",
                                                  "with": "Company's Own Holidays"}])
        out = hr.preview_holiday_policy(pol["id"], self._body(self.US_SET, [CO_B]), user=ADMIN, db=self.db)
        by = {c["id"]: c for c in out["companies"]}
        self.assertEqual(len(by[CO_A]["removed"]), 2)

    def test_copy_year_nearest_weekday(self):
        holidays = [_hol("2026-07-03", "Independence Day", actualDate="2026-07-04", source="public"),
                    _hol("2026-02-16", "Presidents' Day", source="public"),
                    _hol("2026-09-15", "Founders Day")]
        pol, _ = self._create(holidays, companies=(CO_A,), weekendRule="nearest_weekday")
        out = hr.copy_holiday_policy_year(pol["id"], hr.HolidayCopyYearIn(fromYear=2026, toYear=2027),
                                          user=ADMIN, db=self.db)
        by = {h["name"]: h for h in out["holidays"]}
        self.assertEqual((by["Independence Day"]["date"], by["Independence Day"]["actualDate"]),
                         ("2027-07-05", "2027-07-04"))
        self.assertEqual(by["Presidents' Day"]["date"], "2027-02-15")
        self.assertEqual(by["Independence Day"]["key"], "US:independence-day:2027")
        self.assertEqual(out["unmatched"], ["Founders Day"])

    def test_calendar_and_observed_hint(self):
        hr.create_company_holiday(CO_A, hr.CompanyHolidayIn(date="2027-07-05", name="Independence Day",
                                                            source="public", country_code="US"),
                                  user=ADMIN, db=self.db)
        pol, _ = self._create([_hol("2027-12-24", "Christmas Day", actualDate="2027-12-25")], companies=(CO_A,))
        cal = hr.company_holiday_calendar(CO_A, year=2027, user=ADMIN, db=self.db)
        by = {h["name"]: h for h in cal["holidays"]}
        self.assertEqual(by["Independence Day"]["observedHint"],
                         "Independence Day is 07/04/2027, a Sunday - this company takes 07/05/2027")
        self.assertEqual(by["Independence Day"]["weekday"], "Monday")
        self.assertEqual(by["Christmas Day"]["observedHint"], "")       # has its real date already
        self.assertEqual((by["Christmas Day"]["policyName"], by["Christmas Day"]["actualDate"]),
                         ("US Holidays", "2027-12-25"))
        self.assertEqual([p["name"] for p in cal["policies"]], ["US Holidays"])

    def test_apply_policy_is_assign_and_old_policies_get_keys(self):
        now = "2026-09-22T00:00:00+00:00"
        self.db.add(models.HrHolidayPolicy(id="old-pol", name="Old", company_id=CO_A, created_at=now,
                                           holidays=[{"date": "2026-01-01", "name": "New Year's Day",
                                                      "source": "public", "country_code": "US",
                                                      "type": "mandatory"}]))
        self.db.commit()
        out = hr.apply_holiday_policy(CO_B, "old-pol", user=ADMIN, db=self.db)
        self.assertEqual(out["applied"], 1)
        self.db.expire_all()
        pol = self.db.query(models.HrHolidayPolicy).filter_by(id="old-pol").first()
        self.assertEqual(pol.holidays[0]["key"], "US:new-year-s-day:2026")
        self.assertEqual(self.db.query(models.HrHolidayPolicyAssignment).filter_by(company_id=CO_B).count(), 1)
        self.assertEqual(self._rows(CO_B)["New Year's Day"].policy_key, "US:new-year-s-day:2026")

    def test_delete_policy_row_skips_it(self):
        pol, _ = self._create(self.US_SET, companies=(CO_A,))
        rid = self._rows(CO_A)["Christmas Day"].id
        out = hr.delete_company_holiday(CO_A, rid, user=ADMIN, db=self.db)
        self.assertTrue(out["skipped"])
        self.assertNotIn("Christmas Day", self._rows(CO_A))
        hr.update_holiday_policy(pol["id"], self._body(self.US_SET, [CO_A]), user=ADMIN, db=self.db)
        self.assertNotIn("Christmas Day", self._rows(CO_A))     # stays gone after a policy save

    def test_validation(self):
        with self.assertRaises(HTTPException):
            self._create([_hol("07/04/2026", "Independence Day")])
        with self.assertRaises(HTTPException):
            self._create(self.US_SET, weekendRule="sometimes")
        with self.assertRaises(HTTPException):
            self._create([_hol("2026-07-04", "Independence Day", type_="paid")])


if __name__ == "__main__":
    unittest.main()


class OwnHolidayRealDateCase(unittest.TestCase):
    """A company's own weekend holiday taken on another day keeps its real date
    (Oct 29 2026), so the calendar can say what was moved."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def test_own_holiday_keeps_its_real_date(self):
        db = database.SessionLocal()
        try:
            import routers.hr as hr
            row = hr._create_or_merge_holiday(
                db, "own-co-realdate", date_="2027-07-05", name_="Independence Day", source_="public",
                code="US", type_="mandatory", actor_email="hr@x.com", actual_date_="2027-07-04")
            db.commit()
            self.assertEqual(row.actual_date, "2027-07-04")
            same = hr._create_or_merge_holiday(
                db, "own-co-realdate", date_="2027-12-31", name_="Office Party", source_="manual",
                code="", type_="mandatory", actor_email="hr@x.com", actual_date_="2027-12-31")
            db.commit()
            self.assertEqual(same.actual_date, "")
        finally:
            db.close()
