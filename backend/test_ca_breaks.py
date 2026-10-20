"""CA meal and rest premiums (Neil, Oct 17 2026) - ca_breaks.py end to end.

  * meal detection rules (pure): 5th / 10th hour, 30 minutes, short / late /
    missed, clocking out for lunch counts, the waiver's 6 h / 12 h relief;
  * the engine: a CA card carries day["meal"] only on a flagged day; a
    NON-CA card and a CA card with a compliant day are byte-identical to the
    engine with the CA code switched off;
  * premiums: 1 hour at the day's rate, own pay classes, not hours worked,
    not in the overtime split, one of each kind per day, frozen at finalize;
  * signing: CA staff must answer Yes before Nexus Sign takes the signature;
    No sends it back to the manager through reopen() with premium lines; the
    manager removes one with a reason and re-approves; the employee answers
    again and signs; non-CA staff are never asked;
  * routes: who may add / remove premiums and send / revoke the waiver; a
    signed waiver relaxes the detection.

Runs on test_timesheet_review's throwaway database (real Nexus Sign engine).
    python -m pytest test_ca_breaks.py -q
"""
import json
import os
import unittest
from unittest import mock

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, ANCHOR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import ca_breaks  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import esign, timeclock  # noqa: E402


def seg(a, b, breaks=()):
    """An engine-shaped segment on 2026-09-16 (times HH:MM, UTC)."""
    day = "2026-09-16"
    return {"in": f"{day}T{a}:00", "out": f"{day}T{b}:00", "flags": [], "payClass": "", "deductedMin": 0,
            "breaks": [{"start": f"{day}T{x}:00", "end": f"{day}T{y}:00", "min": 0, "implicit": False}
                       for x, y in breaks]}


class DetectionRules(unittest.TestCase):
    def test_short_days_need_nothing(self):
        self.assertIsNone(ca_breaks.detect_day([seg("08:00", "13:00")]))           # exactly 5 h

    def test_missed_late_short_ok(self):
        self.assertEqual(ca_breaks.detect_day([seg("08:00", "16:00")])["status"], "missed")
        self.assertEqual(ca_breaks.detect_day([seg("08:00", "16:30", [("13:10", "13:40")])])["status"], "late")
        self.assertEqual(ca_breaks.detect_day([seg("08:00", "16:30", [("12:00", "12:25")])])["status"], "short")
        self.assertIsNone(ca_breaks.detect_day([seg("08:00", "16:30", [("12:00", "12:30")])]))
        # A 10-minute rest break is not a meal.
        self.assertEqual(ca_breaks.detect_day([seg("08:00", "16:00", [("10:00", "10:10")])])["status"], "missed")

    def test_clocking_out_for_lunch_counts(self):
        self.assertIsNone(ca_breaks.detect_day([seg("08:00", "12:00"), seg("12:30", "16:30")]))
        self.assertEqual(ca_breaks.detect_day([seg("08:00", "13:30"), seg("14:00", "17:00")])["status"], "late")

    def test_second_meal(self):
        # 11 h of work, one meal: the second is missed.
        m = ca_breaks.detect_day([seg("06:00", "17:30", [("10:00", "10:30")])])
        self.assertEqual([(i["meal"], i["status"]) for i in m["issues"]], [(2, "missed")])
        self.assertIsNone(ca_breaks.detect_day([seg("06:00", "18:00", [("10:00", "10:30"), ("15:00", "15:30")])]))

    def test_waiver(self):
        five_and_half = [seg("08:00", "13:30")]
        self.assertEqual(ca_breaks.detect_day(five_and_half)["status"], "missed")
        self.assertIsNone(ca_breaks.detect_day(five_and_half, waiver=True))            # 6 h or less
        self.assertIsNotNone(ca_breaks.detect_day([seg("08:00", "14:30")], waiver=True))  # over 6 h
        eleven = [seg("06:00", "17:30", [("10:00", "10:30")])]
        self.assertIsNone(ca_breaks.detect_day(eleven, waiver=True))                    # 12 h or less, first taken
        no_first = [seg("06:00", "17:00")]
        self.assertTrue(ca_breaks.detect_day(no_first, waiver=True))                    # first not taken: both owed

    def test_unjudgeable_days_are_skipped(self):
        open_shift = [{**seg("08:00", "16:00"), "out": "", "flags": ["missing_out"]}]
        self.assertIsNone(ca_breaks.detect_day(open_shift))
        auto_lunch = [{**seg("08:00", "16:00"), "deductedMin": 30}]
        self.assertIsNone(ca_breaks.detect_day(auto_lunch))


class CaCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.TimeBreakPremium, models.CaMealWaiver, models.NexusNotification, models.PunchRequest):
            self.db.query(m).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, HR])).delete(synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=HR, role="administrator", assigned_by="test"))
        self.db.query(models.TimePunch).delete()
        # A Californian: Country or Region US is what puts the meal and rest
        # statement on their time sheet (Oct 20); the CA rate rule adds the premiums.
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one().country = "US"
        self.d1 = self.start
        self.d2 = (timeclock.datetime.strptime(self.start, "%Y-%m-%d") + timeclock.timedelta(days=1)).strftime("%Y-%m-%d")
        # Day 1: 8 h, no break (meal missed). Day 2: 8 h with a 30-minute lunch at 4 h (compliant).
        self._punch(self.d1, "in", "15:00:00")
        self._punch(self.d1, "out", "23:00:00")
        self._punch(self.d2, "in", "15:00:00")
        self._punch(self.d2, "break_start", "19:00:00")
        self._punch(self.d2, "break_end", "19:30:00")
        self._punch(self.d2, "out", "23:30:00")
        self.db.commit()
        auth.invalidate_role_cache()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.invalidate_role_cache()
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _rate(self, rule="ca", rate=20.0, pay_type="hourly", currency="USD"):
        self.db.query(models.PayrollRate).filter_by(employee_email=EMP).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type=pay_type, currency=currency, hourly_rate=rate,
                                       full_day_hours=8, overtime_rule=rule, monthly_salary=6000))
        self.db.commit()

    def _card(self):
        self.db.expire_all()
        return timeclock._compute_timecard(self.db, EMP, self.start, self.end)

    def _card_without_ca_code(self):
        with mock.patch.object(ca_breaks, "is_ca_rate", return_value=False):
            return self._card()

    def _days(self, card):
        return {d["date"]: d for d in card["days"]}


class EngineTests(CaCase):
    def test_non_ca_card_is_identical(self):
        for rule in ("federal", "none"):
            with self.subTest(rule=rule):
                self._rate(rule)
                # Even a stray premium row on a non-CA person changes nothing.
                ca_breaks.add_premium(self.db, EMP, self.d1, "meal", MGR)
                self.db.commit()
                self.assertEqual(json.dumps(self._card(), sort_keys=True),
                                 json.dumps(self._card_without_ca_code(), sort_keys=True))
                self.db.query(models.TimeBreakPremium).delete()
                self.db.commit()

    def test_no_rate_row_is_out_of_scope(self):
        self.assertNotIn("meal", self._days(self._card())[self.d1])

    def test_ca_compliant_day_is_identical_and_flagged_day_carries_meal(self):
        self._rate("ca")
        card, base = self._card(), self._card_without_ca_code()
        days, bdays = self._days(card), self._days(base)
        self.assertEqual(json.dumps(days[self.d2], sort_keys=True), json.dumps(bdays[self.d2], sort_keys=True))
        self.assertEqual(days[self.d1]["meal"]["status"], "missed")
        self.assertEqual(days[self.d1]["meal"]["chip"], "Meal Missed")
        # Detection never adds pay.
        self.assertEqual(card["totals"], base["totals"])
        d1 = dict(days[self.d1])
        d1.pop("meal")
        self.assertEqual(json.dumps(d1, sort_keys=True), json.dumps(bdays[self.d1], sort_keys=True))

    def test_premium_pay(self):
        self._rate("ca", rate=22.5)
        ca_breaks.add_premium(self.db, EMP, self.d1, "meal", MGR)
        self.assertIsNone(ca_breaks.add_premium(self.db, EMP, self.d1, "meal", MGR))   # one per day and kind
        self.db.commit()
        ca_breaks.add_premium(self.db, EMP, self.d1, "rest", MGR)
        ca_breaks.add_premium(self.db, EMP, self.d2, "meal", MGR)
        self.db.commit()
        card, base = self._card(), self._card_without_ca_code()
        t, bt = card["totals"], base["totals"]
        self.assertEqual((t["mealPremiumMin"], t["mealPremiumPay"], t["restPremiumMin"], t["restPremiumPay"]),
                         (120, 45.0, 60, 22.5))
        self.assertEqual(t["totalPay"], round(bt["totalPay"] + 67.5, 2))
        for k in ("workedMin", "regMin", "otMin", "dtMin", "regPay", "otPay"):
            self.assertEqual(t[k], bt[k], k)                  # not hours worked, not in the OT split
        d1 = self._days(card)[self.d1]
        self.assertEqual((d1["mealPremiumMin"], d1["mealPremiumPay"], d1["restPremiumPay"]), (60, 22.5, 22.5))
        self.assertEqual(len(card["breakPremiums"]), 3)

    def test_manager_tier_never_sees_premium_pay(self):
        self._rate("ca")
        ca_breaks.add_premium(self.db, EMP, self.d1, "meal", MGR)
        self.db.commit()
        stripped = json.dumps(timeclock.strip_pay(self._card()))
        self.assertNotIn("mealPremiumPay", stripped)
        self.assertIn("mealPremiumMin", stripped)            # the hour itself is not pay

    def test_finalize_freezes_premiums_and_their_rate(self):
        self._rate("ca", rate=20)
        ca_breaks.add_premium(self.db, EMP, self.d1, "meal", MGR)
        self.db.commit()
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end,
                                                         allow_exceptions=True),
                                    user={"email": HR, "level": 4}, db=self.db)
        snap = json.loads(timeclock._finalized_row(self.db, EMP, self.start, self.end).note)
        self.assertEqual(snap["breakPremiums"], [{"date": self.d1, "kind": "meal"}])
        # A raise and a stray row after finalize change nothing on the paid card.
        self._rate("ca", rate=30)
        self.db.add(models.TimeBreakPremium(id="late", employee_email=EMP, local_date=self.d2, kind="rest",
                                            status="active"))
        self.db.commit()
        t = self._card()["totals"]
        self.assertEqual((t["mealPremiumPay"], t.get("restPremiumMin", 0)), (20.0, 0))
        # The premium routes refuse a finalized period.
        self._as(MGR)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d2, "kind": "meal"})
        self.assertEqual(r.status_code, 403, r.text)

    def test_non_ca_finalize_snapshot_unchanged(self):
        self._rate("federal")
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end,
                                                         allow_exceptions=True),
                                    user={"email": HR, "level": 4}, db=self.db)
        snap = json.loads(timeclock._finalized_row(self.db, EMP, self.start, self.end).note)
        self.assertNotIn("breakPremiums", snap)


class SigningTests(CaCase):
    def _approve(self):
        r = tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        self.db.expire_all()
        return self._r()

    def _try_sign(self, party):
        c = self.client
        c.post(f"/esign/public/{party.token}/consent", json={"agreed": True})
        c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"})
        c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        return c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 2, "pages_total": 2})

    def test_non_us_signing_is_unchanged(self):
        self._rate("federal")
        # In the US on the federal rule: the statement prints (Country or Region,
        # Oct 20), but no Report a Missed Break - premiums are the CA rule's.
        probe = models.TimesheetReview(employee_email=EMP, pay_type="hourly")
        self.assertTrue(tsr.needs_break_attestation(self.db, probe))
        self.assertFalse(tsr.can_report_breaks(self.db, probe))
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one().country = "IN"
        self.db.commit()
        r = self._approve()
        st = tsr.state_for(self.db, EMP, self.start, EMP, False)
        self.assertNotIn("breakAttestation", st)
        self.assertTrue(all("breakAttestation" not in x for x in tsr.to_sign(self.db, EMP)))
        self._sign(self._parties(r.sign_request_id)["employee"])
        self.assertEqual(self._r().status, "completed")
        self.assertNotIn("break_attested", [e["action"] for e in self._r().rounds])
        self.assertFalse(tsr.statement_printed(self.db, r.sign_request_id))
        self._as(EMP)
        res = self.client.post(f"/timesheet-review/{r.id}/break-claim", json={"claims": [{"date": self.d1, "kind": "meal"}]})
        self.assertEqual(res.status_code, 409, res.text)

    def test_signing_confirms_the_statement(self):
        self._rate("ca")
        r = self._approve()
        st = tsr.state_for(self.db, EMP, self.start, EMP, False)
        ba = st["breakAttestation"]
        self.assertEqual((ba["required"], ba["answered"]), (True, False))
        self.assertEqual(ba["statement"], tsr.BREAK_STATEMENT)
        self.assertEqual([d["date"] for d in ba["flaggedDays"]], [self.d1])
        self.assertIn("breakAttestation", tsr.to_sign(self.db, EMP)[0])
        self.assertTrue(tsr.statement_printed(self.db, r.sign_request_id))
        # No separate question: the signature goes straight through.
        party = self._parties(r.sign_request_id)["employee"]
        self.assertEqual(self._try_sign(party).status_code, 200)
        r = self._r()
        self.assertEqual(r.status, "completed")
        self.assertEqual([e["action"] for e in r.rounds].count("break_attested"), 1)
        ev = self.db.query(models.HrSignEvent).filter_by(request_id=r.sign_request_id, type="attested").all()
        self.assertEqual(len(ev), 1)
        self.assertIn("signed under the statement", ev[0].detail)
        self.assertTrue(any("confirmed by" in ln and "by signing" in ln for ln in tsr.approval_log(self.db, r)))
        self._as(EMP)
        self.assertEqual(self.client.post(f"/timesheet-review/{r.id}/break-attest").status_code, 404)

    def test_no_reopens_to_manager_with_premiums_then_yes(self):
        self._rate("ca")
        r = self._approve()
        env = r.sign_request_id
        self._as(EMP)
        res = self.client.post(f"/timesheet-review/{r.id}/break-claim", json={"claims": [], "note": ""})
        self.assertEqual(res.status_code, 422)
        res = self.client.post(f"/timesheet-review/{r.id}/break-claim", json={
            "claims": [{"date": self.d1, "kind": "meal"}, {"date": self.d2, "kind": "rest"}],
            "note": "Busy day"})
        self.assertEqual(res.status_code, 200, res.text)
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("with_manager", ""))
        self.assertEqual(self.db.query(models.HrSignRequest).filter_by(id=env).first().status, "voided")
        last = r.rounds[-1]
        self.assertEqual((last["action"], last["breakClaims"][0]), ("reopened", {"date": self.d1, "kind": "meal"}))
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(recipient=MGR).count())
        prem = {p.kind: p for p in ca_breaks.premium_rows(self.db, EMP, self.start, self.end)}
        self.assertEqual(set(prem), {"meal", "rest"})
        # The manager removes one with a reason (audited), then re-approves.
        self._as(MGR)
        res = self.client.post(f"/ca-breaks/premiums/{prem['rest'].id}/remove", json={"reason": ""})
        self.assertEqual(res.status_code, 422)
        res = self.client.post(f"/ca-breaks/premiums/{prem['rest'].id}/remove", json={"reason": "Took the break - camera log"})
        self.assertEqual(res.status_code, 200, res.text)
        self.db.expire_all()
        row = self.db.query(models.TimeBreakPremium).filter_by(id=prem["rest"].id).first()
        self.assertEqual((row.status, row.removed_by, row.removed_reason), ("removed", MGR, "Took the break - camera log"))
        tsr.approve(self.db, self._r(), MGR, "Meal premium added")
        r = self._r()
        party = self._parties(r.sign_request_id)["employee"]
        self.assertFalse(tsr.break_attested(r))                          # a new envelope, not confirmed yet
        self.assertEqual(self._try_sign(party).status_code, 200)
        self.assertTrue(tsr.break_attested(self._r()))
        self.assertEqual(self._r().status, "completed")
        t = timeclock._compute_timecard(self.db, EMP, self.start, self.end)["totals"]
        self.assertEqual((t["mealPremiumPay"], t.get("restPremiumMin", 0)), (20.0, 0))

    def test_pdf_has_the_question_only_for_ca(self):
        self._rate("ca")
        r = self._approve()
        pdf, _ = tsr.build_pdf(self.db, r)
        self.assertGreater(len(pdf), 1000)
        with mock.patch.object(tsr, "needs_break_attestation", return_value=False):
            pdf2, _ = tsr.build_pdf(self.db, r)
        self.assertNotEqual(len(pdf), len(pdf2))


class RouteTests(CaCase):
    def test_premium_permissions(self):
        self._rate("ca")
        self._as(EMP)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d1, "kind": "meal"})
        self.assertIn(r.status_code, (401, 403))
        self._as(MGR)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d1, "kind": "lunch"})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d1, "kind": "meal", "note": "x"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d1, "kind": "meal"})
        self.assertEqual(r.status_code, 409)
        self._rate("federal")
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d2, "kind": "meal"})
        self.assertEqual(r.status_code, 409)

    def test_premium_after_approval_reopens(self):
        self._rate("ca")
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        self._as(MGR)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d1, "kind": "meal"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._r().status, "with_manager")

    def test_waiver_send_sign_revoke(self):
        self._rate("ca")
        self._as(MGR)
        self.assertEqual(self.client.post("/ca-breaks/waiver/send", json={"email": EMP}).status_code, 403)
        self._as(HR)
        with mock.patch.object(esign, "_storage_put", return_value=mock.Mock(is_success=True)):
            r = self.client.post("/ca-breaks/waiver/send", json={"email": EMP})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "sent")
        w = self.db.query(models.CaMealWaiver).filter_by(employee_email=EMP).first()
        req = self.db.query(models.HrSignRequest).filter_by(id=w.sign_request_id).first()
        self.assertEqual(req.link_kind, "meal_waiver")
        # Signing completes it (the Nexus Sign completion hook).
        esign._link_hook("completed", self.db, req)
        self.db.commit()
        self.db.expire_all()
        self.assertEqual(ca_breaks.waiver_state(self.db, EMP)["status"], "signed")
        # A 5.5 h day is excused by the waiver from its signing day on.
        rows = ca_breaks.waiver_rows(self.db, EMP)
        today = rows[0].signed_at[:10]
        self.assertTrue(ca_breaks.waiver_on(rows, today))
        self.assertFalse(ca_breaks.waiver_on(rows, "2000-01-01"))
        self._as(EMP)
        self.assertEqual(self.client.get("/ca-breaks/waiver/mine").json()["status"], "signed")
        self.assertIn(self.client.post("/ca-breaks/waiver/revoke", json={"email": EMP, "note": "x"}).status_code,
                      (401, 403))
        self._as(HR)
        self.assertEqual(self.client.post("/ca-breaks/waiver/revoke", json={"email": EMP, "note": ""}).status_code, 422)
        r = self.client.post("/ca-breaks/waiver/revoke", json={"email": EMP, "note": "Employee asked in writing"})
        self.assertEqual(r.json()["status"], "revoked")

    def test_waiver_only_for_ca(self):
        self._rate("none")
        self._as(HR)
        self.assertEqual(self.client.post("/ca-breaks/waiver/send", json={"email": EMP}).status_code, 409)

    def test_detection_reads_the_waiver(self):
        self._rate("ca")
        self.db.query(models.TimePunch).delete()
        self._punch(self.d1, "in", "15:00:00")
        self._punch(self.d1, "out", "20:30:00")          # 5.5 h, no meal
        self.db.add(models.CaMealWaiver(id="w1", employee_email=EMP, status="signed", signed_at="2000-01-01T00:00:00",
                                        sent_at="2000-01-01T00:00:00"))
        self.db.commit()
        self.assertNotIn("meal", self._days(self._card())[self.d1])
        self.db.query(models.CaMealWaiver).update({"status": "revoked", "revoked_at": "2000-01-02T00:00:00"})
        self.db.commit()
        self.assertEqual(self._days(self._card())[self.d1]["meal"]["status"], "missed")


class DelegationTests(CaCase):
    """Premium lines are approval decisions (#633 / #635): a live stand-in of
    the employee's manager may add one; a manager with no claim on the person
    may not; nobody adds or removes premiums on their own time sheet."""
    MGR2 = "mgr2.ts@greensglobal.com"

    def setUp(self):
        super().setUp()
        self.db.query(models.ApprovalDelegation).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email == self.MGR2).delete()
        self.db.add(models.NexusRole(email=self.MGR2, role="manager", assigned_by="test"))
        self.db.add(models.NexusEmployee(id="id-Mia", work_email=self.MGR2, first_name="Mia", last_name="Test",
                                         company=ENTITY, status="active"))
        self.db.commit()
        auth.invalidate_role_cache()
        self._rate("ca")

    def _add(self, who, email=EMP, day=None):
        self._as(who)
        return self.client.post("/ca-breaks/premiums", json={"email": email, "date": day or self.d1, "kind": "meal"})

    def test_stand_in_may_act_only_while_delegated(self):
        self.assertIn(self._add(self.MGR2).status_code, (403, 404))
        self.db.add(models.ApprovalDelegation(id="dg1", delegator_email=MGR, delegate_email=self.MGR2,
                                              start_date="2000-01-01", end_date="2999-12-31", created_by=MGR,
                                              created_at="2026-10-18T00:00:00", revoked_at=""))
        self.db.commit()
        r = self._add(self.MGR2)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Decided by", r.json()["note"])
        self.assertTrue(self.db.query(models.AuditLog).filter(models.AuditLog.resource_type == "time_break_premiums").count())

    def test_never_on_your_own_card(self):
        self.db.query(models.PayrollRate).filter_by(employee_email=MGR).delete()
        self.db.add(models.PayrollRate(employee_email=MGR, pay_type="hourly", currency="USD", hourly_rate=30,
                                       full_day_hours=8, overtime_rule="ca"))
        self.db.commit()
        self.assertEqual(self._add(MGR, email=MGR).status_code, 403)
        p = ca_breaks.add_premium(self.db, MGR, self.d1, "meal", HR)
        self.db.commit()
        self._as(MGR)
        r = self.client.post(f"/ca-breaks/premiums/{p.id}/remove", json={"reason": "Not owed"})
        self.assertEqual(r.status_code, 403, r.text)


class ScopeTests(CaCase):
    """Who the CA tools apply to (Oct 18 review): hourly, USD, rule 'ca'
    (blank counts - the column defaults to 'ca') AND working in the US (own
    People country, else the company's). India hourly staff get nothing."""

    def _nothing_new(self):
        card = self._card()
        self.assertNotIn("caBreaks", card)
        self.assertFalse(any("meal" in d for d in card["days"]))
        self.assertFalse(ca_breaks.is_ca(self.db, EMP))
        self._as(MGR)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": self.d1, "kind": "meal"})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertFalse(self.client.get(f"/ca-breaks/waiver?email={EMP}").json()["ca"])
        import ca_review
        self.assertEqual(ca_review.flags_for(self.db, EMP, self.start, self.end), [])
        r = tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        self.assertNotIn("breakAttestation", tsr.state_for(self.db, EMP, self.start, EMP, False))
        party = self._parties(self._r().sign_request_id)["employee"]
        req = self.db.query(models.HrSignRequest).filter_by(id=party.request_id).first()
        self.assertNotIn("breakAttestation", esign._render_payload(self.db, req, party))
        self.assertFalse(tsr.statement_printed(self.db, req.id))

    def test_inr_hourly_with_blank_or_ca_rule_gets_nothing(self):
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"country": "IN"})   # India staff
        for rule in ("", "ca"):
            with self.subTest(rule=rule):
                self._rate(rule, currency="INR")
                self._nothing_new()
                self.db.query(models.TimesheetReview).delete()
                self.db.commit()

    def test_usd_but_working_in_india_gets_nothing(self):
        self._rate("ca")
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"country": "IN"})
        self.db.commit()
        self._nothing_new()

    def test_company_country_counts_when_the_person_has_none(self):
        self._rate("ca")
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"country": ""})
        self.db.query(models.HrEntity).filter_by(id=ENTITY).update({"country": "IN"})
        self.db.commit()
        self.assertFalse(ca_breaks.is_ca(self.db, EMP))
        self.db.query(models.HrEntity).filter_by(id=ENTITY).update({"country": "US"})
        self.db.commit()
        self.assertTrue(ca_breaks.is_ca(self.db, EMP))

    def test_usd_us_ca_person_still_gets_them(self):
        self._rate("")
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"country": "US"})
        self.db.commit()
        card = self._card()
        self.assertTrue(card["caBreaks"])
        self.assertEqual(self._days(card)[self.d1]["meal"]["status"], "missed")
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        party = self._parties(self._r().sign_request_id)["employee"]
        req = self.db.query(models.HrSignRequest).filter_by(id=party.request_id).first()
        payload = esign._render_payload(self.db, req, party)
        self.assertEqual(payload["breakAttestation"]["reviewId"], self._r().id)
        self.assertFalse(payload["breakAttestation"]["answered"])
        party.status, party.signature_kind = "signed", "typed"
        tsr.on_progress(self.db, req)
        self.db.commit()
        self.assertTrue(tsr.break_attested(self._r()))


class ReviewNitTests(CaCase):
    def test_finalized_premiums_survive_leaving_the_ca_rule(self):
        self._rate("ca")
        ca_breaks.add_premium(self.db, EMP, self.d1, "meal", MGR)
        self.db.commit()
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end,
                                                         allow_exceptions=True),
                                    user={"email": HR, "level": 4}, db=self.db)
        before = self._card()["totals"]
        self._rate("ca", currency="INR")       # no longer in scope
        after = self._card()["totals"]
        self.assertEqual((after["mealPremiumPay"], after["totalPay"]), (before["mealPremiumPay"], before["totalPay"]))

    def test_claims_and_premiums_only_on_worked_days(self):
        self._rate("ca")
        off_day = self.end      # inside the period, nothing worked
        # A sick-only day is not a work day either.
        self.db.add(models.TimePunch(id="sick-in", employee_email=EMP, kind="in", at=f"{self.end}T15:00:00",
                                     local_date=self.end, tz_offset_min=0, category="Sick Day", created_at="x"))
        self.db.add(models.TimePunch(id="sick-out", employee_email=EMP, kind="out", at=f"{self.end}T23:00:00",
                                     local_date=self.end, tz_offset_min=0, category="Sick Day", created_at="x"))
        self.db.commit()
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        st = tsr.state_for(self.db, EMP, self.start, EMP, False)["breakAttestation"]
        self.assertEqual(st["workedDays"], [self.d1, self.d2])
        with self.assertRaises(HTTPException) as e:
            tsr.claim_breaks(self.db, self._r(), EMP, [{"date": off_day, "kind": "meal"}])
        self.assertEqual(e.exception.status_code, 422)
        self._as(MGR)
        r = self.client.post("/ca-breaks/premiums", json={"email": EMP, "date": off_day, "kind": "meal"})
        self.assertEqual(r.status_code, 422, r.text)

    def test_waiver_dates_on_the_employee_calendar(self):
        w = models.CaMealWaiver(id="w-tz", employee_email=EMP, status="signed", signed_at="2026-09-16T03:00:00")
        # 03:00 UTC on 9/16 is 8:00 PM on 9/15 in Pacific daylight time (offset 420).
        self.assertTrue(ca_breaks.waiver_on([w], "2026-09-15", 420))
        self.assertFalse(ca_breaks.waiver_on([w], "2026-09-15", 0))

    def _paper_sign(self):
        r = self._r()
        party = self._parties(r.sign_request_id)["employee"]
        party.status, party.signature_kind = "signed", "paper"
        self.db.commit()
        req = self.db.query(models.HrSignRequest).filter_by(id=r.sign_request_id).first()
        tsr.on_progress(self.db, req)
        self.db.commit()
        return [e["action"] for e in self._r().rounds]

    def test_paper_signature_confirms_the_printed_statement(self):
        self._rate("ca")
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        actions = self._paper_sign()
        self.assertIn("break_attested", actions)
        self.assertNotIn("break_not_collected", actions)

    def test_paper_copy_without_the_statement_is_not_a_yes(self):
        # An envelope sent before the statement existed: its PDF never had it.
        self._rate("ca")
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        # (the event log is append-only, so stand in for the missing event)
        with mock.patch.object(tsr, "statement_printed", return_value=False):
            actions = self._paper_sign()
        self.assertIn("break_not_collected", actions)
        self.assertNotIn("break_attested", actions)
        self.assertTrue(any("without the printed statement" in ln for ln in tsr.approval_log(self.db, self._r())))

    def test_pdf_prints_the_statement_above_the_signature(self):
        self._rate("ca")
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "ok")
        import io
        from pypdf import PdfReader
        pdf, _ = tsr.build_pdf(self.db, self._r())
        text = " ".join((pg.extract_text() or "") for pg in PdfReader(io.BytesIO(pdf)).pages)
        text = " ".join(text.split())
        self.assertIn("in this pay period that the hours stated are accurate and correct. I was provided every "
                      "meal and rest break California law requires.", text)      # one paragraph for US staff
        self.assertIn("A missed meal or rest break is reported instead of signing", text)
        self.assertNotIn("Before signing, the employee is asked", text)


class ClaimGuards(CaCase):
    def test_claim_rules(self):
        self._rate("ca")
        r = tsr.submit(self.db, EMP, ANCHOR)
        with self.assertRaises(HTTPException) as e:
            tsr.claim_breaks(self.db, r, EMP, [{"date": self.d1, "kind": "meal"}])
        self.assertEqual(e.exception.status_code, 409)               # not out for signature
        tsr.approve(self.db, self._r(), MGR)
        r = self._r()
        with self.assertRaises(HTTPException) as e:
            tsr.claim_breaks(self.db, r, EMP, [{"date": "1999-01-01", "kind": "meal"}])
        self.assertEqual(e.exception.status_code, 422)
        with self.assertRaises(HTTPException) as e:
            tsr.claim_breaks(self.db, r, MGR, [{"date": self.d1, "kind": "meal"}])
        self.assertEqual(e.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
