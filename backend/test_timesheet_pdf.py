"""The time sheet pages of the signed Time Sheet PDF (timesheet_pdf.py)."""
import io
import os
import unittest

from pypdf import PdfReader

import timesheet_pdf as tp


def seg(i, o, mins, *, ot=0, dt=0, cat="", breaks=(), note="", in_id="", amount=0.0):
    return {"in": i, "out": o, "inR": i, "outR": o, "inId": in_id or f"p-{i}", "outId": f"p-{o}",
            "workedMin": mins, "regMin": 0 if cat else mins - ot - dt, "otMin": ot, "dtMin": dt,
            "category": cat, "payClass": "sick" if cat == "Sick Day" else "", "breaks": list(breaks),
            "note": note, "workSite": "SCMC", "amount": amount, "flags": [], "deductedMin": 0}


HOURLY = {
    "currency": "USD", "rate": 22.0, "dept": "Operations - SCMC", "overtimeRule": "ca",
    "days": [
        {"date": "2026-10-05", "weekStart": "2026-10-04", "workedMin": 465, "rate": 22.0,
         "segments": [seg("2026-10-05T15:45:00", "2026-10-05T20:10:00", 265, amount=97.17),
                      seg("2026-10-05T20:25:00", "2026-10-05T23:45:00", 200, amount=73.33,
                          breaks=[{"start": "2026-10-05T21:00:00", "end": "2026-10-05T21:10:00", "min": 10,
                                   "startId": "b1", "endId": "b2"}])]},
        {"date": "2026-10-12", "weekStart": "2026-10-11", "workedMin": 490, "rate": 22.0,
         "segments": [seg("2026-10-12T15:50:00", "2026-10-12T19:50:00", 240, amount=88.0),
                      seg("2026-10-12T20:00:00", "2026-10-13T00:10:00", 250, ot=10, amount=93.5, in_id="edited",
                          note="Forgot to clock back in; Clock in time should be around 1 PM · payroll edit")]},
        {"date": "2026-10-14", "weekStart": "2026-10-11", "workedMin": 480, "rate": 22.0,
         "segments": [seg("2026-10-14T15:00:00", "2026-10-14T23:00:00", 480, cat="Sick Day", amount=176.0)]},
    ],
    "punchMeta": {"edited": {"manual": True}},
    "totals": {"regMin": 695, "otMin": 10, "dtMin": 0, "sickMin": 480, "regPay": 254.83, "otPay": 5.5,
               "sickPay": 176.0, "totalPay": 436.33, "workedMin": 1185, "editedPunches": 1, "missingPunches": 0},
}

FIXED = {
    "currency": "INR", "monthlySalary": 60000, "weekendMultiplier": 1.35,
    "days": [{"date": "2026-10-01", "segments": [seg("2026-10-01T03:30:00", "2026-10-01T12:30:00", 540)]}],
    "fixedDays": [{"date": "2026-10-01", "status": "present", "deduct": 0, "bonus": 0},
                  {"date": "2026-10-02", "status": "absent", "timeOff": "Personal", "deduct": 2000, "bonus": 0},
                  {"date": "2026-10-03", "status": "weekend", "deduct": 0, "bonus": 0}],
    "totals": {"salaryForPeriod": 60000, "missedFullDays": 1, "missedHalfDays": 0, "deduction": 2000,
               "missedReasons": [{"label": "Personal", "full": 1, "half": 0}], "weekendDaysWorked": 0,
               "weekendBonus": 0, "totalPay": 58000, "workedMin": 540, "missingPunches": 0},
}


def ctx(**kw):
    base = {"start": "2026-10-04", "end": "2026-10-17", "pay_type": "hourly", "entity": "Oversite Management, Inc",
            "name": "Nimi Patel", "code": "GG-014", "dept": "Operations - SCMC",
            "period": "10/04/2026 - 10/17/2026", "kind": "Hourly (bi-weekly)", "generated": "10/19/2026 at 2:19 PM",
            "notes": {"2026-10-12": {"employeeNote": "Doctor visit at noon", "note": "HR ONLY"}},
            "punch_meta": {}, "time": lambda iso, _pid: iso[11:16] if iso else "-", "us_date": lambda s: s,
            "names_in": lambda s: s,
            "attestation": ["By execution and signature of this time sheet, I agree the hours are correct."],
            "approval_history": [
                {"step": "Submitted by employee", "by": "Nimi Patel", "when": "10/18/2026 at 9:02 AM", "note": ""},
                {"step": "Approved by manager", "by": "Charmi Desai", "when": "10/19/2026 at 2:19 PM",
                 "note": "Looks right"}]}
    base.update(kw)
    return base


def page_with(pdf: bytes, needle: str) -> int:
    return next(i for i, p in enumerate(PdfReader(io.BytesIO(pdf)).pages) if needle in (p.extract_text() or ""))


def text_of(pdf: bytes) -> str:
    return " ".join(" ".join((p.extract_text() or "").split()) for p in PdfReader(io.BytesIO(pdf)).pages)


class Helpers(unittest.TestCase):
    def test_formats(self):
        self.assertEqual((tp.hm(0), tp.hm(65), tp.hd(2645)), ("0:00", "1:05", "44:05 (44.08)"))
        self.assertEqual((tp.money(1000.08), tp.money(5, "INR")), ("$1,000.08", "INR 5.00"))
        self.assertEqual(tp.day_label("2026-10-04"), "Sun 10/04")

    def test_punch_reasons_read_once_without_internal_markers(self):
        self.assertEqual(tp._reasons({"note": "payroll edit · Forgot · Forgot", "inAdjustNote": "Forgot"}), ["Forgot"])


class Hourly(unittest.TestCase):
    def setUp(self):
        self.pdf, self.spot = tp.render(HOURLY, ctx(punch_meta=HOURLY["punchMeta"]))
        self.text = text_of(self.pdf)

    def test_landscape_pages(self):
        page = PdfReader(io.BytesIO(self.pdf)).pages[0]
        self.assertGreater(float(page.mediabox.width), float(page.mediabox.height))

    def test_the_screen_columns_and_pay(self):
        for h in ("Date", "In", "Out", "Deducted Time", "Category", "Hours", "Hrs/Day", "OT", "Loc",
                  "Pay Rate", "Wage", "$22.00/hr", "$97.17", "Total Regular hours at $22.00/hr",
                  "Total Overtime hours at $33.00/hr", "Total Sick hours at $22.00/hr", "TOTAL EDITED PUNCHES"):
            self.assertIn(h, self.text)
        self.assertNotIn("Non-OT", self.text)      # Pranshu, Oct 20: not on the PDF

    def test_every_day_and_week_totals(self):
        self.assertIn("Sun 10/04", self.text)
        self.assertIn("Sat 10/17", self.text)
        self.assertIn("Total hours clocked for week of 10/4 to 10/10: 7:45", self.text)
        self.assertIn("Total hours clocked for week of 10/11 to 10/17: 16:10", self.text)

    def test_break_row_under_its_shift(self):
        self.assertIn("Break 21:00 21:10", self.text)

    def test_notes_the_employee_may_read_only(self):
        self.assertIn("Note by employee: Doctor visit at noon", self.text)
        self.assertIn("Forgot to clock back in", self.text)
        self.assertNotIn("payroll edit", self.text)
        self.assertNotIn("HR ONLY", self.text)      # the manager / HR note never travels

    def test_the_card_on_page_one_the_signature_and_history_on_page_two(self):
        self.assertEqual(len(PdfReader(io.BytesIO(self.pdf)).pages), 2)
        self.assertEqual(page_with(self.pdf, "MISSING PUNCHES"), 0)            # the whole card ends on page 1
        self.assertEqual(self.spot["page"], 1)                                  # Charmi, Oct 20: page 2 signs
        self.assertEqual(page_with(self.pdf, "Approval History"), 1)
        x, y, w, h = self.spot["sign"]
        self.assertTrue(0 < x < x + w < 1 and 0 < y < y + h < 1)
        self.assertLess(x + w, self.spot["date"][0])          # the date sits right of the signature
        # The signing date also lands in the history's last row, below the signature.
        self.assertEqual(self.spot["history"]["page"], 1)
        self.assertGreater(self.spot["history"]["box"][1], y)
        for s in ("Submitted by employee Nimi Patel 10/18/2026 at 9:02 AM",
                  "Approved by manager Charmi Desai 10/19/2026 at 2:19 PM Looks right",
                  "Signed by employee - finalizes the time sheet Nimi Patel"):
            self.assertIn(s, self.text)
        self.assertLess(self.text.index("By execution and signature"), self.text.index("Approval History"))
        self.assertNotIn("Only the employee signs", self.text)
        self.assertNotIn("Approval log", self.text)

    def test_header(self):
        for s in ("Time Sheet", "Employee: Nimi Patel", "Company: Oversite Management, Inc",
                  "Employee Code: GG-014", "Department: Operations - SCMC", "Pay Rate: $22.00/hr"):
            self.assertIn(s, self.text)
        # Charmi, Oct 20: not "... for Greens Global", no email, no OT rule or
        # version, no approvals up top.
        for s in ("Time Sheet Report", "nimi@x.com", "OT rule", "Version", "Dept:", "Code: GG"):
            self.assertNotIn(s, self.text.replace("Employee Code: GG", ""))
        self.assertLess(self.text.index("Wage"), self.text.index("Approved by manager"))

    def test_a_busy_card_still_ends_on_page_one(self):
        day = HOURLY["days"][0]
        many = dict(HOURLY, days=[dict(day, date=f"2026-10-{n:02d}",
                                       segments=day["segments"] * 6) for n in range(4, 18)])
        pdf, spot = tp.render(many, ctx())
        self.assertEqual(len(PdfReader(io.BytesIO(pdf)).pages), 2)
        self.assertEqual(page_with(pdf, "MISSING PUNCHES"), 0)
        self.assertEqual(spot["page"], 1)

    def test_a_light_card_keeps_its_signature_on_page_two(self):
        light = dict(HOURLY, days=HOURLY["days"][:1])
        pdf, spot = tp.render(light, ctx(notes={}))
        self.assertEqual(spot["page"], 1)

    def test_the_banding_follows_the_day_and_money_is_centered(self):
        t = tp.hourly_rows(HOURLY, ctx(notes={"2026-10-05": {"employeeNote": "Long day"}}))
        rows = t._cellvalues
        note = next(i for i, r in enumerate(rows) if "Long day" in getattr(r[0], "text", ""))
        day = next(i for i, r in enumerate(rows) if "10/05" in getattr(r[0], "text", ""))
        banded = {c[1][1] for c in t._bkgrndcmds if c[3] == tp.BAND}
        self.assertIn(day, banded)                            # Mon 10/05 is a banded day...
        self.assertIn(note, banded)                           # ...and its note line is banded with it
        self.assertEqual(rows[day][9].style.alignment, 1)     # Pay Rate and Wage centered
        self.assertEqual(rows[day][10].style.alignment, 1)


class Fixed(unittest.TestCase):
    def test_salaried_columns_and_summary(self):
        text = text_of(tp.render(FIXED, ctx(pay_type="fixed", start="2026-10-01", end="2026-10-31",
                                            kind="Salaried (monthly)"))[0])
        for s in ("Day", "Effect on Pay", "Present", "Personal", "Weekend", "-INR 2,000.00", "no change",
                  "Monthly salary", "Missed days (1 full): Personal x1", "NET PAY THIS MONTH", "INR 58,000.00",
                  "TOTAL HOURS WORKED 9:00 (9.00)"):
            self.assertIn(s, text)
        self.assertNotIn("OT rule", text)


if __name__ == "__main__":
    out = os.environ.get("TIMESHEET_PDF_OUT")
    if out:
        with open(out, "wb") as f:
            f.write(tp.render(HOURLY, ctx(punch_meta=HOURLY["punchMeta"]))[0])
    unittest.main()
