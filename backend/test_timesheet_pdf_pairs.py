"""The signed Time Sheet PDF reads like the screen (Charmi / Visesh, Oct 20):
a shift with a lunch prints as two punch pairs with the break between them,
each row with its own hours that add up to the shift's paid time.

Runs on test_timesheet_review's throwaway database, one file per process:
    python -m pytest test_timesheet_pdf_pairs.py -q
"""
import io
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, ANCHOR  # noqa: F401  (sets DATABASE_URL first)

import timesheet_review as tsr  # noqa: E402


class PunchPairs(unittest.TestCase):
    def seg(self, breaks, worked, **kw):
        d = "2026-10-05"
        return {"in": f"{d}T15:48:00", "out": f"{d}T23:45:00", "inId": "i", "outId": "o",
                "workedMin": worked, "breaks": breaks, **kw}

    def test_rows_add_up_to_the_paid_shift(self):
        d = "2026-10-05"
        one = [{"start": f"{d}T20:08:00", "end": f"{d}T20:23:00", "min": 15, "startId": "bs", "endId": "be"}]
        two = one + [{"start": f"{d}T22:00:00", "end": f"{d}T22:15:00", "min": 15, "startId": "b2", "endId": "e2"}]
        implicit = [{"start": f"{d}T20:08:00", "end": f"{d}T23:45:00", "min": 217, "implicit": True, "startId": "bs", "endId": ""}]
        for breaks, worked, mins in ((one, 462, [260, 202]), (two, 447, [260, 97, 90]),
                                     (implicit, 260, [260, 0]), ([{**one[0], "paidMin": 10}], 472, [260, 212])):
            items = tsr.punch_pairs(self.seg(breaks, worked))
            work = [x for x in items if x["kind"] == "work"]
            self.assertEqual([w["min"] for w in work], mins)
            self.assertEqual(sum(w["min"] for w in work), worked)
            self.assertEqual(len([x for x in items if x["kind"] == "break"]), len(breaks))
        # No break punched, a lunch auto-deducted: one row and an Auto-Deducted line.
        items = tsr.punch_pairs(self.seg([], 447, deductedMin=30))
        self.assertEqual([x["kind"] for x in items], ["work", "auto"])


class PdfPairs(ReviewCase):
    def test_the_pdf_prints_two_rows_and_the_break(self):
        self._punch(self.start, "break_start", "19:00:00")
        self._punch(self.start, "break_end", "19:30:00")
        self.db.commit()
        r = tsr.submit(self.db, EMP, ANCHOR)
        pdf, _last = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
        self.assertIn("Hrs/Day", text)
        # Two punch-pair rows (Out at the break start, In at the break end), each
        # with its own hours, and the day's 6:30 on the last row.
        flat = " ".join(text.split())
        self.assertIn("4:00 PM 7:00 PM - - 3:00", flat)
        self.assertIn("7:30 PM 11:00 PM 3:30 6:30", flat)


if __name__ == "__main__":
    unittest.main()
