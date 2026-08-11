"""Weekly report assembly - the four sections of the supplied sample.

The regression these exist for: three of those four sections used to be stored
with `sources` but an empty `text`, and construction_pdf skips a section whose
text is empty. So Critical Milestones, RFIs and Submittals, and Cost Exposures
were silently absent from every PDF the module had ever produced. Nothing
failed; the sections just were not there.

Run with: python -m unittest test_construction_report -v
"""
import types
import unittest

import construction_report as cr


def _ms(name, target="", actual=""):
    return types.SimpleNamespace(id="m", name=name, target_date=target, actual_date=actual)


def _rfi(number, subject, status="open"):
    return types.SimpleNamespace(id="r", number=number, subject=subject, status=status)


def _sub(number, title):
    return types.SimpleNamespace(id="s", number=number, title=title)


def _log(date_, notes="", done=None):
    return types.SimpleNamespace(id="l", log_date=date_, notes_raw=notes,
                                 ai_work_completed=done or [], author_email="w@x.com")


def _data(**kw):
    base = {"logs": [], "media": [], "photos": [], "videos": [],
            "milestones": [], "rfis": [], "submittals": [],
            "weekStart": "2026-08-03", "weekEnd": "2026-08-09",
            "stats": {"logs": 0, "crewDays": 0, "hours": 0}}
    base.update(kw)
    return base


class SectionSetTests(unittest.TestCase):
    def test_the_four_sections_of_the_sample(self):
        self.assertEqual([k for k, _ in cr.SECTIONS],
                         ["summary_of_progress", "rfis_and_submittals",
                          "cost_exposures", "critical_milestones"])

    def test_only_the_progress_summary_is_model_written(self):
        """A milestone date or an RFI number restated by a model is a
        transcription error waiting to be quoted in a claim."""
        self.assertEqual(cr._NARRATIVE, ("summary_of_progress",))


class AssembleTests(unittest.TestCase):
    """Every section must carry non-empty `text` - that is the whole bug."""

    def test_every_section_has_text_even_when_the_week_is_empty(self):
        s = cr.assemble(None, types.SimpleNamespace(name="P"), _data(), {"summary_of_progress": []})
        for key, _ in cr.SECTIONS:
            self.assertIn(key, s, f"{key} missing from assembled sections")
        # Three of four print "None currently." rather than vanishing: an absent
        # heading and a heading saying none are different claims, and the sample
        # makes the second one.
        for key in ("rfis_and_submittals", "cost_exposures", "critical_milestones"):
            self.assertTrue(s[key]["text"].strip(), f"{key} would be skipped by the PDF")

    def test_rfis_and_submittals_share_one_section_rfis_first(self):
        s = cr.assemble(None, types.SimpleNamespace(name="P"), _data(
            rfis=[_rfi("33-RIML", "Grease Interceptor Change")],
            submittals=[_sub("131100-1-RIML", "Pool Equipment")]), {})
        lines = s["rfis_and_submittals"]["text"].split("\n")
        self.assertEqual(lines[0], "RFI# 33-RIML- Grease Interceptor Change")
        self.assertEqual(lines[1], "Submittal-131100-1-RIML-Pool Equipment")

    def test_a_void_rfi_is_not_printed(self):
        s = cr.assemble(None, types.SimpleNamespace(name="P"), _data(
            rfis=[_rfi("1", "Withdrawn", status="void")]), {})
        self.assertEqual(s["rfis_and_submittals"]["text"], "None currently.")

    def test_bullets_are_stored_one_per_line(self):
        s = cr.assemble(None, types.SimpleNamespace(name="P"), _data(),
                        {"summary_of_progress": ["Completed waterproofing on walls.",
                                                 "Excavated footings."]})
        self.assertEqual(s["summary_of_progress"]["text"],
                         "Completed waterproofing on walls.\nExcavated footings.")

    def test_a_string_summary_is_tolerated(self):
        """The schema asks for an array, but a manager edit round-trips as text
        and a regenerate must not crash on it."""
        s = cr.assemble(None, types.SimpleNamespace(name="P"), _data(),
                        {"summary_of_progress": "One line.\nTwo lines."})
        self.assertEqual(s["summary_of_progress"]["text"], "One line.\nTwo lines.")

    def test_cost_exposure_is_never_model_written(self):
        """It cannot be derived from daily logs and lands in a pay application.
        A manager types it; generate always starts from the sample's default."""
        s = cr.assemble(None, types.SimpleNamespace(name="P"), _data(),
                        {"cost_exposures": "$40,000 exposure on rebar"})
        self.assertEqual(s["cost_exposures"]["text"], "None currently.")


class MilestoneLineTests(unittest.TestCase):
    def test_matches_the_samples_shape(self):
        """'All columns complete 6/30' - what, then when."""
        self.assertEqual(cr._milestone_line(_ms("All columns complete", "2026-06-30")),
                         "All columns complete 6/30")

    def test_actual_date_wins_over_target(self):
        """A hit milestone is reported by the day it landed, not the day it was
        aimed at."""
        self.assertEqual(
            cr._milestone_line(_ms("Slab pour", target="2026-07-14", actual="2026-07-19")),
            "Slab pour 7/19")

    def test_a_different_year_is_shown(self):
        line = cr._milestone_line(_ms("Framing", "2027-09-15"))
        self.assertTrue(line.endswith("/27"), line)

    def test_a_milestone_with_no_date_still_prints(self):
        self.assertEqual(cr._milestone_line(_ms("Topping out")), "Topping out")


class OfflineDraftTests(unittest.TestCase):
    """No API key is a first-class state - see routers/help.py's _fallback."""

    def test_returns_the_same_shape_as_draft(self):
        out = cr.draft_offline(types.SimpleNamespace(name="P"),
                               _data(logs=[_log("2026-08-04", "Poured footings")],
                                     stats={"logs": 1, "crewDays": 6, "hours": 8}))
        for k in ("title", "summary_of_progress", "executive_summary",
                  "risks", "recommendations", "sparse"):
            self.assertIn(k, out)
        self.assertEqual(out["source"], "fallback")

    def test_bullets_are_the_workers_own_words(self):
        out = cr.draft_offline(types.SimpleNamespace(name="P"),
                               _data(logs=[_log("2026-08-04", "Poured footings")]))
        self.assertEqual(out["summary_of_progress"], ["2026-08-04: Poured footings."])

    def test_falls_back_to_recorded_activities_when_no_note_was_typed(self):
        out = cr.draft_offline(types.SimpleNamespace(name="P"), _data(
            logs=[_log("2026-08-04", "", [{"activity": "Formwork strip"}])]))
        self.assertEqual(out["summary_of_progress"], ["2026-08-04: Formwork strip."])

    def test_an_empty_week_says_so_rather_than_producing_nothing(self):
        out = cr.draft_offline(types.SimpleNamespace(name="P"), _data())
        self.assertEqual(out["summary_of_progress"],
                         ["No approved daily logs were filed for this week."])


if __name__ == "__main__":
    unittest.main()
