"""Ask Nexus check list, retrieval half (WP 4.2, Oct 29 2026): for every
question in kb_ai_eval.CASES, the page that answers it is among the five pages
search hands to the model. No database and no API key: the sample pages live
in kb_ai_eval. The answers half runs by hand: python -m kb_ai_eval --live.
ONE FILE PER PROCESS."""
import unittest

import kb_ai_eval


class AskNexusRetrieval(unittest.TestCase):
    def test_every_question_finds_its_page(self):
        rows = kb_ai_eval.check_retrieval()
        self.assertGreaterEqual(len(rows), 18)
        broken = [f"{r['question']!r}: expected {r['expected']}, got {r['got']}" for r in rows if not r["ok"] and not r["known_gap"]]
        self.assertEqual(broken, [], "search no longer finds these pages - fix search, or add the case to KNOWN_GAPS with why")

    def test_known_gaps_are_still_gaps(self):
        fixed = [r["question"] for r in kb_ai_eval.check_retrieval() if r["known_gap"] and r["ok"]]
        self.assertEqual(fixed, [], "these now pass - take them out of KNOWN_GAPS")
        self.assertTrue(set(kb_ai_eval.KNOWN_GAPS) <= {q for q, _ in kb_ai_eval.CASES})

    def test_every_case_names_a_real_page(self):
        ids = {p.id for p in kb_ai_eval.PAGES}
        self.assertEqual([q for q, want in kb_ai_eval.CASES if want is not None and want not in ids], [])
        self.assertEqual(len(kb_ai_eval.CASES), 20)


if __name__ == "__main__":
    unittest.main()
