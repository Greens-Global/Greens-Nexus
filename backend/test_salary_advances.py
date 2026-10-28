"""Salary advances (Neil, Oct 27 2026; who and where, Oct 29 2026) -
salary_advance.py + routers/salary_advances.py.

  * nobody asks for their own advance - not an employee, a manager, HR or a
    Global Admin (Neil, 10/29/2026: "Workday is not the right place for this")
  * from the person's Time Sheet: their DIRECT manager sends a request to
    HR, HR with the pay grant grants it, HR without the pay grant sends a
    request; a skip-level manager or anyone else is refused
  * only HR with the pay grant approves, declines, pays out and changes the
    schedule - never the manager, never on your own advance
  * what each viewer sees: the person all of it, HR with the pay grant all
    of it, HR without it that it exists, the asking manager the amount and
    the decision but not the schedule, anyone else nothing
  * every bell and inbox row opens the person's Time Sheet; the counts are
    on People > Time
  * advances asked before Oct 29 2026 (a manager's own) keep working
  * paid out, the first installment comes out of the NEXT pay period; a
    finalized period is skipped; HR moves an installment later with a reason
  * the pay card carries a "Salary Advance Repayment" line and netPay on the
    hourly and the monthly card, the CSV and the Intacct entry carry it, the
    Time Sheet PDF prints it; a period never pays out below zero and the
    rest moves forward when it is finalized; unlocking puts it back
  * the advance is in the pay currency

    python -m unittest test_salary_advances
"""
import asyncio
import csv
import io
import json
import unittest
from datetime import date, timedelta

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import models  # noqa: E402
import salary_advance as sa  # noqa: E402
import timesheet_pdf  # noqa: E402
from routers import contractor_invoices, salary_advances as api, timeclock  # noqa: E402

EMPLOYEE = {"email": EMP, "level": 1}
EMP_AS_MANAGER = {"email": EMP, "level": 3}
MANAGER = {"email": MGR, "level": 3}           # Erin's DIRECT manager - not HR
SKIP = "skip.ts@greensglobal.com"              # Max's manager: Erin's skip-level
SKIP_MANAGER = {"email": SKIP, "level": 3}
# The company's HR contact, an administrator with the pay grant (hr_comp
# Editor, setUp): an advance is pay, and the manager tier never sees pay.
HR_USER = {"email": HR, "level": 4}
HR_AS_MANAGER = {"email": HR, "level": 3}      # the HR contact at the manager tier
GLOBAL_ADMIN = {"email": "ga.sa@greensglobal.com", "level": 5}
STRANGER = {"email": "someone.sa@greensglobal.com", "level": 3}
OWN = "An advance is requested by your manager or HR, from your Time Sheet."


def _day_before(iso: str) -> str:
    return (date.fromisoformat(iso) - timedelta(days=1)).isoformat()


def _day_after(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


class AdvanceCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.SalaryAdvance, models.SalaryAdvanceInstallment, models.NexusNotification, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20.0, overtime_rule="ca", pay_type="hourly",
                                       currency="USD"))
        # An advance is pay (release review, Oct 27 2026): the HR contact
        # decides with the pay grant (hr_comp Editor).
        self.db.add(models.NexusGroup(id="g-sa-pay", name="Payroll", allowed_modules="hr_comp:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-sa-pay", email=HR))
        self.db.add(models.NexusRole(email=HR, role="administrator", assigned_by="test"))
        # Max reports to Skye: Skye is Erin's skip-level manager.
        self.db.add(models.NexusEmployee(id="id-Skye", work_email=SKIP, first_name="Skye", last_name="Test",
                                         company=ENTITY, manager_email="", status="active"))
        self.db.query(models.NexusEmployee).filter_by(work_email=MGR).update({"manager_email": SKIP})
        self.db.commit()
        self.db.info.pop("_advance_emails", None)
        auth.invalidate_role_cache()
        # The period after Erin's worked one, and the one after that.
        self.next_start, self.next_end = timeclock._pay_period(_day_after(self.end))
        self.third_start, _e = timeclock._pay_period(_day_after(self.next_end))

    def _ask(self, email=EMP, who=MANAGER, amount=50.0, n=1, currency=""):
        return api.ask_for(email, api.RequestIn(amount=amount, currency=currency, reason="Car repair", installments=n),
                           user=who, db=self.db)

    # A request for Erin, by her direct manager, from her Time Sheet.
    _request = _ask

    def _grant(self, amount=50.0, n=1, who=HR_USER, currency=""):
        return api.grant(api.GrantIn(email=EMP, amount=amount, currency=currency, reason="Moving costs", installments=n),
                         user=who, db=self.db)

    def _paid(self, aid, paid_on=None, who=HR_USER):
        # Paid out the day before Erin's worked period: it comes out of THAT period.
        return api.mark_paid(aid, api.PaidIn(paid_on=paid_on or _day_before(self.start), payment_method="ach"),
                             user=who, db=self.db)

    def _card(self):
        self.db.expire_all()
        self.db.info.pop("_advance_emails", None)
        return timeclock._compute_timecard(self.db, EMP, self.start, self.end)

    def _status(self, code, fn, *a, **k):
        with self.assertRaises(HTTPException) as e:
            fn(*a, **k)
        self.assertEqual(e.exception.status_code, code, e.exception.detail)
        return e.exception.detail

    def _drop_pay_grant(self):
        import cache
        for m in self.db.query(models.NexusGroupMember).filter_by(group_id="g-sa-pay").all():
            self.db.delete(m)
        self.db.add(models.NexusRole(email="owner.sa@greensglobal.com", role="owner", assigned_by="test"))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _action(self, recipient, key):
        n = self.db.query(models.NexusNotification).filter_by(recipient=recipient, ref_id=key).one()
        return json.loads(n.action)

    def _legacy(self, aid, status, email=EMP, **kw):
        """An advance asked for before Oct 29 2026: the person's own, from
        the Workday card (requested_by = the person)."""
        now = "2026-10-27T08:00:00+00:00"
        row = models.SalaryAdvance(id=aid, employee_email=email, employee_name="Erin Test", company=ENTITY,
                                   amount=80.0, currency="USD", reason="Rent help", installments=1, status=status,
                                   source="request", requested_by=email, requested_at=now, history=[],
                                   created_at=now, updated_at=now, **kw)
        self.db.add(row)
        self.db.commit()
        return row


class WhoTests(AdvanceCase):
    def test_nobody_asks_for_their_own(self):
        for who in (EMPLOYEE, EMP_AS_MANAGER, MANAGER, HR_USER, GLOBAL_ADMIN):
            body = api.AskIn(amount=10.0, reason="Mine", installments=1)
            self.assertEqual(self._status(403, api.request_advance, body, user=who, db=self.db), OWN)
            body = api.AskIn(email=who["email"].upper(), amount=10.0, reason="Mine", installments=1)
            self.assertEqual(self._status(403, api.request_advance, body, user=who, db=self.db), OWN)
            self.assertEqual(self._status(403, self._ask, email=who["email"], who=who), OWN)
        self._status(403, api.grant, api.GrantIn(email=HR, amount=10, reason="Mine", installments=1),
                     user=HR_USER, db=self.db)
        self.assertEqual(self.db.query(models.SalaryAdvance).count(), 0)
        # Nobody's own Time Sheet offers it.
        for who in (EMPLOYEE, MANAGER, HR_USER):
            self.assertEqual(api.for_person(who["email"], user=who, db=self.db)["canAsk"], "")

    def test_the_direct_manager_asks_for_a_report(self):
        out = self._ask()
        self.assertEqual((out["status"], out["source"], out["requestedBy"], out["currency"]),
                         ("requested", "request", MGR, "USD"))
        self.assertEqual(out["email"], EMP)
        # HR hears once, on one notice for the advance - opening Erin's Time Sheet.
        bells = self.db.query(models.NexusNotification).filter_by(recipient=HR).all()
        self.assertEqual([b.ref_id for b in bells], [f"salary-advance:{out['id']}"])
        self.assertIn("$50.00", bells[0].body)
        self.assertIn("Max Test asked", bells[0].body)
        self.assertEqual(json.loads(bells[0].action), {"view": "hr", "sub": "hr-time", "timecard": EMP})
        # One open request per person.
        self.assertEqual(self._status(409, self._ask), "Erin Test already has a request waiting for HR.")
        # POST /salary-advances with someone else's email is the same ask.
        self.db.query(models.SalaryAdvance).delete()
        self.db.commit()
        row = api.request_advance(api.AskIn(email=EMP, amount=25.0, reason="Bus pass", installments=1),
                                  user=MANAGER, db=self.db)
        self.assertEqual((row["status"], row["requestedBy"]), ("requested", MGR))

    def test_a_skip_level_or_a_stranger_cannot_ask(self):
        self.assertEqual(sa.can_request_for(self.db, SKIP_MANAGER, EMP), "")
        self.assertIn("direct manager", self._status(403, self._ask, who=SKIP_MANAGER))
        self._status(403, self._ask, who=STRANGER)
        # The manager tier is needed: a direct manager at the employee tier is not enough.
        self._status(403, self._ask, who={"email": MGR, "level": 1})
        # Skye may ask for Max, her own direct report.
        self.assertEqual(self._ask(email=MGR, who=SKIP_MANAGER)["status"], "requested")
        # Never for someone who has left.
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"status": "terminated"})
        self.db.commit()
        self.assertIn("has left", self._status(400, self._ask))
        self.assertEqual(sa.can_request_for(self.db, MANAGER, EMP), "")
        self._status(403, self._ask, who=STRANGER)   # a stranger learns nothing

    def test_can_ask_values(self):
        self.assertEqual(api.for_person(EMP, user=MANAGER, db=self.db)["canAsk"], "request")
        self.assertEqual(api.for_person(EMP, user=HR_USER, db=self.db)["canAsk"], "grant")
        self.assertEqual(api.for_person(EMP, user=HR_AS_MANAGER, db=self.db)["canAsk"], "request")
        self.assertEqual(api.for_person(EMP, user=EMPLOYEE, db=self.db)["canAsk"], "")
        self.assertEqual(sa.can_request_for(self.db, STRANGER, EMP), "")
        got = api.for_person(EMP, user=MANAGER, db=self.db)
        self.assertEqual((got["email"], got["name"], got["payCurrency"], got["maxInstallments"]),
                         (EMP, "Erin Test", "USD", sa.MAX_INSTALLMENTS))
        self.assertIn("ach", got["payMethods"])

    def test_hr_with_the_pay_grant_grants_from_the_time_sheet(self):
        out = self._ask(who=HR_USER)
        self.assertEqual((out["status"], out["source"], out["amount"]), ("approved", "grant", 50.0))
        self.assertEqual(self._action(EMP, f"salary-advance:{out['id']}:person"),
                         {"view": "timeclock", "sub": "timesheet"})

    def test_hr_without_the_pay_grant_asks_and_never_sees_the_amount(self):
        self._drop_pay_grant()
        self.assertEqual(sa.can_request_for(self.db, HR_USER, EMP), "request")
        out = self._ask(who=HR_USER)
        self.assertEqual((out["status"], out["requestedBy"], out["payVisible"]), ("requested", HR, False))
        self.assertNotIn("amount", out)
        # The bell goes to who can decide (the owner), never back to HR.
        self.assertEqual({b.recipient for b in self.db.query(models.NexusNotification).all()},
                         {"owner.sa@greensglobal.com"})
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual((row["id"], row["status"], row["payVisible"]), (out["id"], "requested", False))
        self.assertNotIn("amount", row)
        # The owner decides; HR still sees no amount and no schedule.
        owner = {"email": "owner.sa@greensglobal.com", "level": 5}
        api.decide(out["id"], api.DecideIn(action="approve"), user=owner, db=self.db)
        self._paid(out["id"], who=owner)
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual(row["status"], "paid_out")
        for k in ("amount", "balance", "repaid", "scheduled"):
            self.assertNotIn(k, row)
        self.assertEqual(row["schedule"], [])
        # HR's "approved" bell names the person, never the amount.
        body = self.db.query(models.NexusNotification).filter_by(
            recipient=HR, ref_id=f"salary-advance:{out['id']}:requester").one().body
        self.assertNotIn("$", body)

    def test_the_asking_manager_sees_amount_and_decision_not_the_schedule(self):
        aid = self._ask(amount=90.0, n=3)["id"]
        api.decide(aid, api.DecideIn(action="approve", note="Fine"), user=HR_USER, db=self.db)
        # The manager hears the answer, on the report's Time Sheet.
        self.assertEqual(self._action(MGR, f"salary-advance:{aid}:requester"),
                         {"view": "hr", "sub": "hr-time", "timecard": EMP})
        self._paid(aid)
        got = api.for_person(EMP, user=MANAGER, db=self.db)
        row = got["advances"][0]
        self.assertEqual((row["amount"], row["status"], row["decidedByName"], row["decisionNote"], row["paidOn"]),
                         (90.0, "paid_out", "Hana Test", "Fine", _day_before(self.start)))
        self.assertEqual(row["schedule"], [])
        for k in ("balance", "repaid", "scheduled", "paymentRef"):
            self.assertNotIn(k, row)
        self.assertTrue(all("detail" not in h and "note" not in h for h in row["history"]))
        # Erin sees it all, the schedule included; her bells open her own Time Sheet.
        mine = api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"][0]
        self.assertEqual(len(mine["schedule"]), 3)
        self.assertEqual(self._action(EMP, f"salary-advance:{aid}:person"), {"view": "timeclock", "sub": "timesheet"})
        # The manager never decides it.
        self.assertIn("HR decides", self._status(403, self._paid, self._ask(email=EMP, who=MANAGER, amount=5.0)["id"],
                                                 who=MANAGER))

    def test_hr_without_the_pay_grant_never_sees_the_reason(self):
        # Oct 29 2026 review: a manager's reason can quote the amount - the
        # "exists" view blanks it like the decision note.
        self._drop_pay_grant()
        aid = self._ask(amount=75.0)["id"]                       # Erin's manager: "Car repair"
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual((row["id"], row["reason"], row["decisionNote"], row["payVisible"]), (aid, "", "", False))
        self.assertNotIn("amount", row)

    def test_a_direct_manager_who_is_hr_without_the_pay_grant_sees_what_they_asked(self):
        # Oct 29 2026 review: the requester rule comes before the exists rule
        # for the person's direct manager who is also HR without the pay grant.
        self._drop_pay_grant()
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"manager_email": HR})
        self.db.commit()
        out = self._ask(who=HR_USER, amount=60.0)
        self.assertEqual((out["status"], out["amount"], out["payVisible"], out["reason"]),
                         ("requested", 60.0, True, "Car repair"))
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual((row["id"], row["amount"], row["canDecide"]), (out["id"], 60.0, False))
        self.assertEqual(row["schedule"], [])
        # An advance someone ELSE asked for stays "exists" to them.
        self.db.query(models.SalaryAdvance).filter_by(id=out["id"]).update({"requested_by": MGR})
        self.db.commit()
        self.db.expire_all()
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertNotIn("amount", row)

    def test_the_asking_manager_reads_paid_out_while_it_is_repaid(self):
        # Oct 29 2026 review: Repaying / Repaid hint at the schedule - to the
        # one who asked it stays Paid Out; Erin sees the real status.
        aid = self._ask(amount=90.0, n=2)["id"]
        api.decide(aid, api.DecideIn(action="approve"), user=HR_USER, db=self.db)
        self._paid(aid)

        def deduct(n):
            for r in sa.installments(self.db, aid)[:n]:
                r.status, r.deducted_amount = "deducted", r.amount
            self.db.commit()
            self.db.expire_all()
        for n, real in ((1, ("repaying", "Repaying")), (2, ("repaid", "Repaid"))):
            deduct(n)
            mine = api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"][0]
            self.assertEqual((mine["status"], mine["statusLabel"]), real)
            row = api.for_person(EMP, user=MANAGER, db=self.db)["advances"][0]
            self.assertEqual((row["status"], row["statusLabel"]), ("paid_out", "Paid Out"))

    def test_the_person_endpoint_is_the_person_hr_and_the_direct_manager(self):
        self._grant()
        self._status(404, api.for_person, EMP, user=STRANGER, db=self.db)
        self._status(404, api.for_person, EMP, user=SKIP_MANAGER, db=self.db)
        # The manager sees only what they asked for - an HR grant is not theirs.
        self.assertEqual(api.for_person(EMP, user=MANAGER, db=self.db)["advances"], [])
        self.assertEqual(len(api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"]), 1)
        self.assertEqual(len(api.for_person(EMP, user=HR_USER, db=self.db)["advances"]), 1)
        # The manager tier sees no pay on the card - the repayment lines go too.
        self._paid(self._grant()["id"])
        stripped = timeclock.strip_pay(self._card())
        self.assertNotIn("advanceRepayments", stripped)
        self.assertNotIn("netPay", stripped["totals"])

    def test_only_hr_decides(self):
        aid = self._request()["id"]
        self.assertIn("HR decides", self._status(403, api.decide, aid, api.DecideIn(action="approve"),
                                                 user=MANAGER, db=self.db))
        self._status(404, api.decide, aid, api.DecideIn(action="approve"), user=STRANGER, db=self.db)
        # The person never decides their own, even at the administrator tier.
        self._status(403, api.decide, aid, api.DecideIn(action="approve"), user={"email": EMP, "level": 4}, db=self.db)
        self._status(400, api.decide, aid, api.DecideIn(action="decline"), user=HR_USER, db=self.db)   # needs a why
        out = api.decide(aid, api.DecideIn(action="approve", installments=2), user=HR_USER, db=self.db)
        self.assertEqual((out["status"], out["installments"]), ("approved", 2))
        self._status(409, api.decide, aid, api.DecideIn(action="approve"), user=HR_USER, db=self.db)

    def test_the_asker_cancels_a_waiting_request_the_person_does_not(self):
        aid = self._ask()["id"]
        self._status(403, api.cancel, aid, api.CancelIn(), user=EMPLOYEE, db=self.db)
        self._status(404, api.cancel, aid, api.CancelIn(), user=STRANGER, db=self.db)
        self.assertEqual(api.cancel(aid, api.CancelIn(), user=MANAGER, db=self.db)["status"], "canceled")

    def test_hr_never_approves_their_own(self):
        own = self._legacy("legacy-hr", "requested", email=HR)
        self._status(403, api.decide, own.id, api.DecideIn(action="approve"), user=HR_USER, db=self.db)

    def test_amounts_are_pay_and_deciding_needs_the_pay_grant(self):
        # Release review, Oct 27 2026: HR without the pay grant sees a request
        # exists - no amount - and cannot decide; the bell goes to who can.
        self._drop_pay_grant()
        aid = self._request()["id"]
        self.assertEqual({b.recipient for b in self.db.query(models.NexusNotification).all()},
                         {"owner.sa@greensglobal.com"})
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual((row["id"], row["payVisible"], row["canDecide"]), (aid, False, False))
        for k in ("amount", "balance", "repaid", "scheduled"):
            self.assertNotIn(k, row)
        self.assertTrue(all("note" not in h and "detail" not in h for h in row["history"]))
        self.assertIn("pay grant", self._status(403, api.decide, aid, api.DecideIn(action="approve"),
                                                user=HR_USER, db=self.db))
        self.assertIn("pay grant", self._status(403, self._grant))
        self.assertIn("pay grant", self._status(403, api.cancel, aid, api.CancelIn(note="No"), user=HR_USER,
                                                db=self.db))
        self.assertEqual(sa.pending_for_hr(self.db, HR_USER), [])
        # The person always sees their own amount.
        mine = api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"][0]
        self.assertEqual((mine["amount"], mine["payVisible"]), (50.0, True))
        # The pay grant at Viewer shows the amount; deciding needs Editor.
        import cache
        self.db.add(models.NexusGroup(id="g-sa-view", name="Pay View", allowed_modules="hr_comp:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-sa-view", email=HR))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual((row["amount"], row["payVisible"], row["canDecide"]), (50.0, True, False))
        self._status(403, api.decide, aid, api.DecideIn(action="approve"), user=HR_USER, db=self.db)
        # The manager tier never sees pay (Oct 6), whatever its grant.
        self.db.add(models.NexusGroupMember(group_id="g-sa-pay", email=HR))
        self.db.commit()
        cache.module_grants.invalidate()
        row = api.for_person(EMP, user=HR_AS_MANAGER, db=self.db)["advances"][0]
        self.assertEqual((row["payVisible"], row["canDecide"]), (False, False))
        self.assertTrue(api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]["canDecide"])

    def test_hr_outside_the_persons_company_is_not_hr(self):
        # The ONE scoped HR rule: a Full People grant scoped to another company.
        other = "hr.other@greensglobal.com"
        self.db.add(models.HrEntity(id="ent-sa-other", name="Other Co"))
        self.db.add(models.NexusEmployee(id="id-sa-other", work_email=other, first_name="Ola", last_name="Test",
                                         company="ent-sa-other", status="active"))
        self.db.add(models.NexusGroup(id="g-sa-full", name="HR", allowed_modules="hr:full,hr_comp:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-sa-full", email=other))
        self.db.add(models.NexusAccessScope(id="s-sa-other", email=other, module_id="hr", scope_type="entity",
                                            scope_id="ent-sa-other"))
        self.db.commit()
        auth.invalidate_role_cache()
        aid = self._request()["id"]
        who = {"email": other, "level": 3}
        self.assertFalse(sa.is_hr_for(self.db, who, EMP))
        self._status(404, api.decide, aid, api.DecideIn(action="approve"), user=who, db=self.db)
        self._status(404, api.for_person, EMP, user=who, db=self.db)
        self.assertEqual(sa.can_request_for(self.db, who, EMP), "")

    def test_paid_on_is_judged_by_the_local_today(self):
        # An India company is on IST: its "today" may already be tomorrow in UTC.
        from datetime import datetime, timezone
        ent = self.db.query(models.HrEntity).filter_by(id=ENTITY).one()
        ent.country = "IN"
        self.db.commit()
        adv = self.db.query(models.SalaryAdvance).get(self._grant()["id"])
        ist = (datetime.now(timezone.utc) + timedelta(minutes=330)).date().isoformat()
        self.assertEqual(sa.local_today(self.db, HR, adv), max(ist, datetime.now(timezone.utc).date().isoformat()))
        out = self._paid(adv.id, paid_on=ist)
        self.assertEqual((out["status"], out["paidOn"]), ("paid_out", ist))
        later = (date.fromisoformat(ist) + timedelta(days=2)).isoformat()
        self.assertIn("future", self._status(400, self._paid, self._grant()["id"], paid_on=later))

    def test_currency_is_the_pay_currency(self):
        self.assertEqual(self._grant()["currency"], "USD")
        self.assertIn("Paid in USD", self._status(400, self._grant, currency="INR"))
        rate = self.db.query(models.PayrollRate).filter_by(employee_email=EMP).one()
        rate.currency = "INR"
        self.db.commit()
        self.assertEqual(self._grant()["currency"], "INR")
        self._status(400, self._grant, currency="US")


class ExemptTests(AdvanceCase):
    def test_hr_opens_an_exempt_persons_card_by_its_link(self):
        # Oct 29 2026 review: People > Time's roster leaves a time-tracking-
        # exempt person out (_in_roster), but the link every advance bell and
        # inbox row carries opens their card by email - the card route has no
        # exempt check - and its Salary Advances section is how HR pays out.
        self.db.add(models.NexusGroup(id="g-sa-exempt", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-sa-exempt", email=EMP))
        self.db.commit()
        self.assertTrue(timeclock.is_time_tracking_exempt(self.db, EMP))
        aid = self._ask()["id"]
        self.assertEqual(sa.timesheet_link(EMP, HR), {"view": "hr", "sub": "hr-time", "timecard": EMP})
        card = timeclock.payroll_timecard(EMP, self.start, self.end, user=HR_USER, _su={}, db=self.db)
        self.assertEqual(card["email"], EMP)
        api.decide(aid, api.DecideIn(action="approve"), user=HR_USER, db=self.db)
        self.assertEqual(self._paid(aid)["status"], "paid_out")
        # Erin sees it as her own.
        self.assertEqual(api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"][0]["status"], "paid_out")


class LegacyTests(AdvanceCase):
    """Advances are live on prod since #829: rows asked for before Oct 29
    2026 (a manager's own, from the Workday card) keep working."""

    def test_an_old_self_request_is_still_approved_by_hr(self):
        old = self._legacy("legacy-1", "requested")
        # The person sees it on their own Time Sheet; HR on Erin's.
        self.assertEqual([a["id"] for a in api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"]], [old.id])
        hr_row = api.for_person(EMP, user=HR_USER, db=self.db)["advances"][0]
        self.assertEqual((hr_row["status"], hr_row["amount"], hr_row["canDecide"]), ("requested", 80.0, True))
        self.assertEqual([a.id for a in sa.pending_for_hr(self.db, HR_USER)], [old.id])
        out = api.decide(old.id, api.DecideIn(action="approve"), user=HR_USER, db=self.db)
        self.assertEqual(out["status"], "approved")
        paid = self._paid(old.id)
        self.assertEqual(paid["status"], "paid_out")
        self.assertEqual(self._card()["totals"]["advanceRepayment"], 80.0)
        # No "you asked" bell to the person: they get their own.
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(
            ref_id=f"salary-advance:{old.id}:requester").count(), 0)

    def test_an_old_self_request_can_still_be_canceled_by_the_person_who_asked(self):
        old = self._legacy("legacy-2", "requested")
        self.assertEqual(api.cancel(old.id, api.CancelIn(), user=EMP_AS_MANAGER, db=self.db)["status"], "canceled")

    def test_an_old_paid_out_advance_shows_on_the_own_time_sheet(self):
        old = self._legacy("legacy-3", "approved", decided_by=HR, decided_at="2026-10-27T09:00:00+00:00")
        self._paid(old.id)
        got = api.for_person(EMP, user=EMPLOYEE, db=self.db)
        self.assertEqual(got["canAsk"], "")
        row = got["advances"][0]
        self.assertEqual((row["id"], row["status"], row["amount"], row["paidOn"]),
                         (old.id, "paid_out", 80.0, _day_before(self.start)))
        self.assertEqual([(s["periodStart"], s["status"]) for s in row["schedule"]], [(self.start, "scheduled")])
        # HR still moves and reschedules it.
        moved = api.move(old.id, row["schedule"][0]["id"], api.MoveIn(date=self.next_start, reason="Short month"),
                         user=HR_USER, db=self.db)
        self.assertEqual(moved["schedule"][0]["date"], self.next_start)


class CountTests(AdvanceCase):
    def test_the_count_is_on_people_time(self):
        from routers import action_counts
        self._request()
        counts = action_counts.action_counts(user=HR_USER, db=self.db)["counts"]
        self.assertEqual(counts["hr"]["hr-time"], 1)
        self.assertNotIn("overview", counts.get("myhr", {}))

    def test_the_workflow_link_is_the_time_sheet(self):
        import workflows.catalog as catalog
        catalog.load_packs()
        adv = self.db.get(models.SalaryAdvance, self._request()["id"])
        self.assertEqual(catalog.ENTITIES["salary_advance"].link_for(adv),
                         {"view": "hr", "sub": "hr-time", "timecard": EMP})


class ScheduleTests(AdvanceCase):
    def test_first_installment_is_the_next_pay_period(self):
        aid = self._grant(amount=100.0, n=3)["id"]
        out = self._paid(aid)
        self.assertEqual(out["status"], "paid_out")
        sched = out["schedule"]
        self.assertEqual([s["date"] for s in sched], [self.start, self.next_start, self.third_start])
        self.assertEqual([s["amount"] for s in sched], [33.33, 33.33, 33.34])
        self.assertEqual(out["balance"], 100.0)
        self.assertIn("Salary Advance Paid Out", [n.title for n in self.db.query(models.NexusNotification)
                                                  .filter_by(recipient=EMP).all()])

    def test_a_finalized_period_is_skipped(self):
        self.db.add(models.TimeApproval(id="fin-a", employee_email=EMP, period_start=self.start, period_end=self.end,
                                        kind="final", revoked=0))
        self.db.commit()
        out = self._paid(self._grant()["id"])
        self.assertEqual([s["date"] for s in out["schedule"]], [self.next_start])
        self.assertTrue(out["history"][-1]["detail"]["skippedFinalized"])

    def test_hr_defers_an_installment_with_a_reason(self):
        out = self._paid(self._grant()["id"])
        aid, iid = out["id"], out["schedule"][0]["id"]
        self._status(400, api.move, aid, iid, api.MoveIn(date=self.next_start, reason=""), user=HR_USER, db=self.db)
        self._status(404, api.move, aid, iid, api.MoveIn(date=self.next_start, reason="Short month"),
                     user=MANAGER, db=self.db)
        # Never into the payout's own period or before it.
        self._status(409, api.move, aid, iid, api.MoveIn(date=_day_before(self.start), reason="Back"),
                     user=HR_USER, db=self.db)
        # A day inside a later period lands on that period's first day.
        moved = api.move(aid, iid, api.MoveIn(date=_day_after(self.next_start), reason="Short month"),
                         user=HR_USER, db=self.db)
        self.assertEqual(moved["schedule"][0]["date"], self.next_start)
        h = moved["history"][-1]
        self.assertEqual((h["action"], h["note"], h["detail"]["from"], h["detail"]["to"]),
                         ("moved", "Short month", self.start, self.next_start))
        self.assertNotIn("advanceRepayments", self._card())          # nothing taken from the first period now

    def test_moving_into_a_finalized_period_rolls_forward(self):
        out = self._paid(self._grant()["id"])
        self.db.add(models.TimeApproval(id="fin-b", employee_email=EMP, period_start=self.next_start,
                                        period_end=self.next_end, kind="final", revoked=0))
        self.db.commit()
        moved = api.move(out["id"], out["schedule"][0]["id"], api.MoveIn(date=self.next_start, reason="Later"),
                         user=HR_USER, db=self.db)
        self.assertEqual(moved["schedule"][0]["date"], self.third_start)
        self.assertTrue(moved["skippedFinalized"])

    def test_replacing_the_schedule_must_add_up(self):
        out = self._paid(self._grant(amount=90.0)["id"])
        bad = [api.ScheduleItem(date=self.next_start, amount=40.0)]
        self.assertIn("must add up", self._status(400, api.set_schedule, out["id"],
                                                  api.ScheduleIn(installments=bad, reason="Spread it"),
                                                  user=HR_USER, db=self.db))
        good = [api.ScheduleItem(date=self.next_start, amount=40.0), api.ScheduleItem(date=self.third_start, amount=50.0)]
        new = api.set_schedule(out["id"], api.ScheduleIn(installments=good, reason="Spread it"), user=HR_USER, db=self.db)
        self.assertEqual([(s["date"], s["amount"]) for s in new["schedule"]],
                         [(self.next_start, 40.0), (self.third_start, 50.0)])
        self.assertEqual(new["history"][-1]["action"], "rescheduled")
        # The replaced row stays as the record, canceled.
        self.assertEqual(self.db.query(models.SalaryAdvanceInstallment).filter_by(advance_id=out["id"],
                                                                                  status="canceled").count(), 1)


class FinalizeRaceTests(AdvanceCase):
    def test_a_reschedule_committed_before_finalize_is_never_deducted(self):
        # Release review, Oct 27 2026: finalize read the installments, a
        # reschedule committed meanwhile (canceled the row, made a new one
        # later), then finalize recorded the stale row as repaid.
        import database
        out = self._paid(self._grant(amount=50.0)["id"])
        iid = out["schedule"][0]["id"]
        self.assertEqual(out["schedule"][0]["date"], self.start)
        fin = database.SessionLocal()
        try:
            stale = sa.installments(fin, out["id"])          # held: finalize's session keeps this copy
            self.assertEqual([r.status for r in stale], ["scheduled"])
            api.set_schedule(out["id"], api.ScheduleIn(installments=[api.ScheduleItem(date=self.next_start,
                                                                                      amount=50.0)],
                                                       reason="Next month"), user=HR_USER, db=self.db)
            took = sa.on_finalize(fin, EMP, self.start, self.end, "fin-race", HR)
            fin.commit()
        finally:
            fin.close()
        self.assertEqual(took, 0)
        self.db.expire_all()
        rows = {r.id: r for r in self.db.query(models.SalaryAdvanceInstallment).all()}
        self.assertEqual((rows[iid].status, rows[iid].final_approval_id), ("canceled", ""))
        self.assertEqual([(r.status, r.date) for r in rows.values() if r.id != iid], [("scheduled", self.next_start)])

    def test_a_move_committed_before_finalize_is_never_deducted(self):
        import database
        out = self._paid(self._grant(amount=50.0)["id"])
        iid = out["schedule"][0]["id"]
        fin = database.SessionLocal()
        try:
            stale = sa.installments(fin, out["id"])          # held: finalize's session keeps this copy
            self.assertEqual(len(stale), 1)
            api.move(out["id"], iid, api.MoveIn(date=self.next_start, reason="Short month"), user=HR_USER, db=self.db)
            self.assertEqual(sa.on_finalize(fin, EMP, self.start, self.end, "fin-race2", HR), 0)
            fin.commit()
        finally:
            fin.close()
        self.db.expire_all()
        r = self.db.query(models.SalaryAdvanceInstallment).filter_by(id=iid).one()
        self.assertEqual((r.status, r.date, r.deducted_amount), ("scheduled", self.next_start, 0.0))


class CardTests(AdvanceCase):
    def test_the_card_shows_the_repayment_and_net_pay(self):
        gross = self._card()["totals"]["totalPay"]
        self.assertEqual(gross, 140.0)                                   # 7 h at $20
        self._paid(self._grant(amount=50.0)["id"])
        card = self._card()
        t = card["totals"]
        self.assertEqual((t["totalPay"], t["advanceRepayment"], t["netPay"]), (140.0, 50.0, 90.0))
        self.assertEqual([x["label"] for x in card["advanceRepayments"]], ["Salary Advance Repayment"])
        rows = timesheet_pdf.hourly_summary(card)
        self.assertIn(("Salary Advance Repayment", "-", "-$50.00"), rows)
        self.assertIn(("NET PAY", "", "$90.00"), rows)
        # Intacct: wages stay gross, the repayment credits the advances account,
        # the clearing account gets the net.
        card.update({"name": "Erin Test", "department": "", "employeeId": "E1", "payType": "hourly", "payCodes": {}})
        lines = timeclock.payroll_intacct_entries([card], start=self.start, end=self.end, journal="PYRJ",
                                                  expense="6000", clearing="2100", location="", advances="1250")[0]["lines"]
        by_acct = {ln["acct_no"]: ln for ln in lines if ln["acct_no"] in ("1250", "2100")}
        self.assertEqual((by_acct["1250"]["credit"], by_acct["1250"]["memo"]), (50.0, "Erin Test - Salary Advance Repayment"))
        self.assertEqual(by_acct["2100"]["credit"], 90.0)
        self.assertEqual(sum(ln["debit"] or 0 for ln in lines), 140.0)

    def test_the_csv_carries_it_at_the_end(self):
        self._paid(self._grant(amount=50.0)["id"])
        self.db.info.pop("_advance_emails", None)
        resp = timeclock.export_csv(start=self.start, end=self.end, mode="summary",
                                    user={"email": HR, "level": 4}, _su={}, db=self.db)
        async def _read():
            return "".join([c if isinstance(c, str) else c.decode() async for c in resp.body_iterator])
        body = asyncio.run(_read())
        rows = list(csv.reader(io.StringIO(body)))
        head = rows[0]
        self.assertEqual(head[-2:], ["Salary Advance Repayment", "Net Pay"])
        total = next(r for r in rows if r[2] == "TOTAL")
        self.assertEqual(total[-2:], ["50.00", "90.00"])
        self.assertEqual(total[head.index("Total Pay")], "140.00")

    def test_never_below_zero_and_the_rest_carries_when_finalized(self):
        self._paid(self._grant(amount=200.0)["id"])
        t = self._card()["totals"]
        self.assertEqual((t["advanceRepayment"], t["netPay"]), (140.0, 0.0))
        self._to_signing()
        self._sign_now()                                                 # finalizes the period
        self.db.expire_all()
        rows = self.db.query(models.SalaryAdvanceInstallment).order_by(models.SalaryAdvanceInstallment.seq).all()
        self.assertEqual([(r.status, r.amount, r.deducted_amount, r.date) for r in rows],
                         [("deducted", 200.0, 140.0, self.start), ("scheduled", 60.0, 0.0, self.next_start)])
        adv = self.db.query(models.SalaryAdvance).one()
        self.assertEqual(sa.figures(adv, sa.installments(self.db, adv.id))["status"], "repaying")
        self.assertEqual(sa.outstanding(self.db, EMP)[0]["balance"], 60.0)
        # The finalized card keeps what it took.
        self.assertEqual(self._card()["totals"]["advanceRepayment"], 140.0)
        # HR unlocks it: the carry is taken back, the installment is whole again.
        timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end,
                                                           reason="Wrong punch"),
                                      user={"email": HR, "level": 4}, db=self.db)
        self.db.expire_all()
        rows = self.db.query(models.SalaryAdvanceInstallment).order_by(models.SalaryAdvanceInstallment.seq).all()
        self.assertEqual([(r.status, r.amount) for r in rows], [("scheduled", 200.0), ("canceled", 60.0)])

    def _sign_now(self):
        r = self._r()
        self._sign(self._parties(r.sign_request_id)["employee"])
        return self._r()

    def test_a_period_with_no_pay_moves_the_installment_on(self):
        out = self._paid(self._grant(amount=50.0)["id"], paid_on=self.start)    # first: the next period
        self.assertEqual(out["schedule"][0]["date"], self.next_start)
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.next_start, end=self.next_end),
                                    user={"email": HR, "level": 4}, db=self.db)
        self.db.expire_all()
        rows = self.db.query(models.SalaryAdvanceInstallment).all()
        self.assertEqual([(r.status, r.amount, r.date) for r in rows], [("scheduled", 50.0, self.third_start)])
        adv = self.db.query(models.SalaryAdvance).one()
        self.assertEqual(adv.history[-1]["action"], "carried")

    def test_pending_for_hr(self):
        self._request()
        self.assertEqual(len(sa.pending_for_hr(self.db, HR_USER)), 1)
        self.assertEqual(sa.pending_for_hr(self.db, MANAGER), [])
        self.assertEqual(len(api.pending(user=HR_USER, db=self.db)), 1)

    def test_fully_repaid(self):
        out = self._paid(self._grant(amount=50.0)["id"])
        self._to_signing()
        self.assertEqual(self._sign_now().status, "completed")
        self.db.expire_all()
        got = api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"][0]
        self.assertEqual((got["id"], got["status"], got["statusLabel"], got["balance"], got["repaid"]),
                         (out["id"], "repaid", "Repaid", 0.0, 50.0))
        self.assertEqual(sa.outstanding(self.db, EMP), [])

    def test_monthly_card(self):
        rate = self.db.query(models.PayrollRate).filter_by(employee_email=EMP).one()
        rate.pay_type, rate.monthly_salary, rate.currency = "fixed", 30000.0, "INR"
        self.db.commit()
        before = timeclock._fixed_card(self.db, EMP, self.start)
        m_start = before["periodStart"]
        adv = self._grant(amount=2500.0)
        self._paid(adv["id"], paid_on=_day_before(m_start))
        self.db.expire_all()
        self.db.info.pop("_advance_emails", None)
        after = timeclock._fixed_card(self.db, EMP, self.start)
        t = after["totals"]
        self.assertEqual(t["totalPay"], before["totals"]["totalPay"])       # wages unchanged
        self.assertEqual(t["advanceRepayment"], min(2500.0, t["totalPay"]))
        self.assertAlmostEqual(t["netPay"], t["totalPay"] - t["advanceRepayment"])
        rows = timesheet_pdf.fixed_summary(after)
        self.assertIn(("NET PAY THIS MONTH", "", timesheet_pdf.money(t["netPay"], "INR")), rows)

    def test_contractor_invoice_is_net_of_the_repayment(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
        emp.employment_type = "contractor"
        self.db.commit()
        self._paid(self._grant(amount=50.0)["id"])
        self._to_signing()
        self._sign_now()
        self.db.expire_all()
        inv = self.db.query(models.ContractorInvoice).filter_by(employee_email=EMP).one()
        self.assertEqual(inv.amount, 90.0)
        self.assertEqual(inv.snapshot["deductions"], [{"description": "Salary Advance Repayment", "amount": 50.0}])
        pdf = contractor_invoices.render_pdf({**inv.snapshot, "number": 1, "currency": "USD", "amount": 90.0})
        self.assertTrue(pdf.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
