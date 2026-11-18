"""Meeting Notes highlights (meeting_highlights.py, Neil 11/12/2026, Phase 2):
the rules that pick action items, decisions and open questions out of a
transcript - strict on purpose, no AI.

    python -m unittest test_meeting_highlights -v
"""
import unittest

import meeting_highlights as mh


def cue(text, speaker="Neil", at=100):
    return {"at": at, "speaker": speaker, "text": text}


class HighlightRules(unittest.TestCase):
    def test_actions_need_work_a_request_or_the_words_action_item(self):
        for s in ("Visesh will send the gate codes by Friday.", "I'll update the rent roll tonight.",
                  "Can you share the deck with the team?", "Action item for me: call the insurer.",
                  "We need to schedule the roof inspection.", "Please email the vendor the new codes.",
                  "Next steps are on me.", "Let me look into the Denver leak."):
            self.assertTrue(mh.is_action(s), s)
        for s in ("I'll be honest, it was rough.", "We'll see how it goes.", "I can't hear you.",
                  "I will say the numbers looked good.", "You know what I mean."):
            self.assertFalse(mh.is_action(s), s)

    def test_decisions(self):
        for s in ("Let's go with the Austin vendor.", "We decided to keep the old gate.",
                  "Okay, we agreed on the 3% increase.", "So we're going with option B."):
            self.assertTrue(mh.is_decision(s), s)
        self.assertFalse(mh.is_decision("Did we decide anything about Plano?"))

    def test_questions_are_real_ones(self):
        self.assertTrue(mh.is_question("What do we do about the Denver roof leak?"))
        for s in ("Right?", "Does that make sense?", "Okay?", "Sounds good?", "Who else?"):
            self.assertFalse(mh.is_question(s), s)

    def test_due_words_are_kept(self):
        got = mh.extract([cue("Sam will call the insurer by end of the week. Bob will send the quote by 11/20.")])
        self.assertEqual([a["due"] for a in got["actions"]], ["by end of the week", "by 11/20"])

    def test_each_kind_once_per_sentence_in_order_with_the_cue(self):
        cues = [cue("Okay, rent roll first. Can you send the deck?", "Neil", 10),
                cue("Can you send the deck? Let's go with the Austin vendor.", "Bob", 20),
                cue("What happens with the Plano permit next month?", "Sam", 30)]
        got = mh.extract(cues)
        self.assertEqual([(a["i"], a["speaker"], a["at"]) for a in got["actions"]], [(0, "Neil", 10)])   # the repeat is dropped
        self.assertEqual([d["text"] for d in got["decisions"]], ["Let's go with the Austin vendor."])
        self.assertEqual([q["i"] for q in got["questions"]], [2])

    def test_long_lines_are_trimmed_and_lists_capped(self):
        long = "Please send " + "the very long report " * 30 + "today."
        got = mh.extract([cue(long)])
        self.assertLessEqual(len(got["actions"][0]["text"]), mh.TEXT_MAX)
        many = mh.extract([cue(f"Please send report number {k}.") for k in range(60)])
        self.assertEqual(len(many["actions"]), mh.MAX_PER_KIND)

    def test_nothing_in_nothing_out(self):
        self.assertEqual(mh.extract([]), {"actions": [], "decisions": [], "questions": []})
        self.assertEqual(mh.extract([cue("")]), {"actions": [], "decisions": [], "questions": []})


if __name__ == "__main__":
    unittest.main()
