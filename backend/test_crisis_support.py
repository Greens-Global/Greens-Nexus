"""Crisis support detector (crisis_support.py, 11/02/2026): true and false
positives, the resource lists by country, and the frontend copy of the phrase
list staying identical to this one.

Run on its own: `python -m pytest test_crisis_support.py` (one file per
process - see CLAUDE.md). Pure functions, no database."""
import json
import os
import unittest

import crisis_support as cs

HERE = os.path.dirname(os.path.abspath(__file__))

TRUE_POSITIVES = [
    "I want to kill myself",
    "i think about killing myself every night",
    "I've been having suicidal thoughts",
    "thinking about suicide",
    "I want to end my life",
    "I'm going to take my own life",
    "I just want to die",
    "honestly i wanna die",
    "I don't want to live anymore",
    "I do not want to wake up tomorrow",
    "There is no reason to live",
    "Everyone would be better off without me",
    "I'd be better off dead",
    "I want to end it all",
    "I have been self-harming again",
    "self harm",
    "I feel like hurting myself",
    "I'm thinking about cutting myself",
    "I cut myself on purpose last night",
    "I want to hang myself",
    "I might take an overdose",
    "KILL MYSELF",
    "I don’t want to live",            # curly apostrophe
    "main khudkushi kar lunga",
    "mar jana chahta hoon",
    "ab jeena nahi chahti",
    "Need help with payroll. Also I want to kill myself.",
    "suicide prevention training is due, and honestly I am suicidal",
]

FALSE_POSITIVES = [
    "",
    None,
    "Please kill the stuck print job",
    "This traffic is killing me",
    "I cut myself on the box cutter while opening a shipment",   # an injury report
    "I hurt myself lifting the pallet, need an incident form",
    "The battery died on the scanner",
    "Our deadline is going to kill us",
    "Dead battery in the company truck",
    "I am dying to know when payroll runs",
    "Can we schedule the suicide prevention training for Monday?",
    "Suicide awareness week poster request",
    "Please end the meeting early",
    "Shoot myself a reminder to file the expense",
    "The kill switch on the conveyor is broken",
    "Life insurance question about my policy",
    "We need to end this contract",
    "I could die of embarrassment after that presentation",
]


class DetectTests(unittest.TestCase):
    def test_true_positives(self):
        for msg in TRUE_POSITIVES:
            with self.subTest(msg=msg):
                self.assertTrue(cs.detect(msg), msg)

    def test_false_positives(self):
        for msg in FALSE_POSITIVES:
            with self.subTest(msg=msg):
                self.assertFalse(cs.detect(msg), msg)

    def test_normalize(self):
        self.assertEqual(cs.normalize("Don't  STOP-now!"), " dont stop now ")


class ResourceTests(unittest.TestCase):
    def test_us(self):
        r = cs.resources("US")
        self.assertEqual([b["country"] for b in r], ["US"])
        self.assertIn("988", r[0]["lines"][0]["name"])
        self.assertEqual(r[0]["emergency"]["number"], "911")

    def test_india(self):
        r = cs.resources("india")
        self.assertEqual([b["country"] for b in r], ["IN"])
        self.assertIn("14416", r[0]["lines"][0]["detail"])
        self.assertIn("1-800-891-4416", r[0]["lines"][0]["detail"])
        self.assertEqual(r[0]["emergency"]["number"], "112")

    def test_unknown_shows_both(self):
        for c in ("", None, "MX"):
            with self.subTest(c=c):
                self.assertEqual([b["country"] for b in cs.resources(c)], ["US", "IN"])

    def test_payload_has_no_em_dash(self):
        text = json.dumps(cs.payload(""), ensure_ascii=False)
        self.assertNotIn("—", text)
        self.assertIn("You Are Not Alone", text)


class SharedListTests(unittest.TestCase):
    def test_frontend_copy_is_identical(self):
        front = os.path.join(HERE, "..", "frontend", "src", "lib", "crisisPhrases.json")
        if not os.path.exists(front):
            self.skipTest("frontend checkout not present")
        with open(os.path.join(HERE, "crisis_phrases.json"), encoding="utf-8") as a, \
                open(front, encoding="utf-8") as b:
            self.assertEqual(json.load(a), json.load(b),
                             "frontend/src/lib/crisisPhrases.json must match backend/crisis_phrases.json")


if __name__ == "__main__":
    unittest.main()
