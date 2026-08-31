"""
My Agenda's Today/Tomorrow window, and the UTC-offset bug that leaked
yesterday's events into it (Aug 2026).

The widget sends its LOCAL day window (e.g. "local midnight" as a naive ISO
string, no offset) to /dashboards/agenda, which forwards it to Microsoft
Graph's calendarView as the startDateTime/endDateTime query params. Graph
parses a naive string there as UTC, not as the caller's zone - the
Prefer: outlook.timezone header only affects how returned EVENT times are
formatted, not how the query window itself is interpreted. Sending the naive
local string straight through silently shifted the window by the caller's UTC
offset (up to a full day for zones like Pacific/India), so an event from
LAST NIGHT could still fall inside "today's" window and get rendered under
the wrong Today/Tomorrow header - a Wednesday-evening event still reading
"Tomorrow" days later (Neil, Aug 31).

agenda_window_to_utc converts the wall-clock window to real UTC before it
goes out. No network, no DB.

Run with: python -m unittest test_agenda_window -v
"""
import unittest

from routers.dashboards import agenda_window_to_utc


class AgendaWindowToUtcTests(unittest.TestCase):
    def test_naive_local_midnight_shifts_by_the_zone_offset(self):
        # Midnight Pacific (UTC-7 in August, DST) is 7am UTC the same day -
        # the pre-fix code sent "2026-08-28T00:00:00" straight to Graph, which
        # read it AS 7 hours earlier than the real Pacific midnight.
        self.assertEqual(
            agenda_window_to_utc("2026-08-28T00:00:00", "America/Los_Angeles"),
            "2026-08-28T07:00:00Z",
        )

    def test_naive_local_end_of_day_shifts_forward_into_the_next_utc_day(self):
        # 11:59pm Pacific on the 28th is nearly 7am UTC on the 29th - a window
        # that stayed naive-UTC would have clipped the last hour of the local
        # day, or (as reported) admitted an extra hour from the wrong side.
        self.assertEqual(
            agenda_window_to_utc("2026-08-28T23:59:59", "America/Los_Angeles"),
            "2026-08-29T06:59:59Z",
        )

    def test_india_is_ahead_of_utc(self):
        # IST is UTC+5:30 - local midnight is the PREVIOUS UTC day's evening,
        # the opposite direction from Pacific, so a fix that only worked for
        # negative offsets would still fail India-based staff.
        self.assertEqual(
            agenda_window_to_utc("2026-08-28T00:00:00", "Asia/Kolkata"),
            "2026-08-27T18:30:00Z",
        )

    def test_already_absolute_string_passes_through_unchanged(self):
        # A string that already carries an offset/Z (the backend's own
        # no-window-supplied default) must NOT be re-interpreted as local
        # time in `tz` on top - it's already the real instant.
        self.assertEqual(
            agenda_window_to_utc("2026-08-28T00:00:00Z", "America/Los_Angeles"),
            "2026-08-28T00:00:00Z",
        )

    def test_unknown_zone_name_falls_back_to_utc_instead_of_raising(self):
        # _TZ_OK only checks character shape, not that it's a real IANA name -
        # a garbage value must degrade gracefully, not 500 the whole card.
        self.assertEqual(
            agenda_window_to_utc("2026-08-28T00:00:00", "Not/AZone"),
            "2026-08-28T00:00:00Z",
        )

    def test_unparseable_input_is_returned_unchanged(self):
        self.assertEqual(agenda_window_to_utc("garbage", "UTC"), "garbage")


if __name__ == "__main__":
    unittest.main()
