"""US copy backstop for notifications (Neil, Oct 17 2026)."""
import unittest

from notice_text import us_copy


class UsCopyTests(unittest.TestCase):
    def test_iso_dates_become_us(self):
        self.assertEqual(us_copy("Period 2026-10-04 - 2026-10-17 closes."), "Period 10/04/2026 - 10/17/2026 closes.")

    def test_the_retired_timecard_reminder_reads_as_a_time_sheet(self):
        self.assertEqual(us_copy("Sign your timecard"), "Sign Your Time Sheet")
        self.assertEqual(us_copy("Your timecard for 2026-10-04 to 2026-10-17 is due tomorrow. Please review your hours and sign it."),
                         "Your time sheet for 10/04/2026 - 10/17/2026 is due tomorrow. Please review your hours and sign it.")

    def test_leaves_urls_timestamps_ids_and_us_dates_alone(self):
        for s in ("https://x.test/files/2026-10-04/a.pdf", "at 2026-10-04T09:00:00", "ref-2026-10-04-a",
                  "Already 10/04/2026.", "", None, "Order 12345-10-04"):
            self.assertEqual(us_copy(s), s)


if __name__ == "__main__":
    unittest.main()
