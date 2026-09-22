"""
Phone numbers -> E.164 for sent.dm (Sagar, Sep 22 2026).

A ten-digit number was taken as North American, full stop - so an Indian
mobile typed as 9876543210 was texted to +1 9876543210, a different person in
a different country, with no error anywhere. Ten bare digits genuinely cannot
be told apart, so the country is now a deployment setting and every field that
collects a number asks for the country code.

    python -m unittest test_sentdm_phone
"""
import os
import unittest
from unittest.mock import patch

import sentdm


class NormalizePhoneTests(unittest.TestCase):
    def test_a_number_with_its_country_code_is_taken_at_its_word(self):
        for raw, want in (
            ("+91 98765 43210", "+919876543210"),
            ("+1 949 400 3330", "+19494003330"),
            ("+44 20 7946 0958", "+442079460958"),
            ("919876543210", "+919876543210"),     # country code, no '+'
            ("19494003330", "+19494003330"),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(sentdm.normalize_phone(raw), want)

    def test_ten_bare_digits_follow_the_deployments_country(self):
        """The ambiguous case: the same ten digits are a valid mobile in both
        countries, so this is a setting, never a guess."""
        self.assertEqual(sentdm.normalize_phone("9876543210"), "+19876543210")
        with patch.dict(os.environ, {"NEXUS_SMS_DEFAULT_COUNTRY": "91"}):
            self.assertEqual(sentdm.normalize_phone("9876543210"), "+919876543210")
            self.assertEqual(sentdm.normalize_phone("(949) 400-3330"), "+919494003330")

    def test_an_indian_number_is_no_longer_silently_made_american(self):
        with patch.dict(os.environ, {"NEXUS_SMS_DEFAULT_COUNTRY": "91"}):
            self.assertEqual(sentdm.normalize_phone("98765 43210"), "+919876543210")
            self.assertNotEqual(sentdm.normalize_phone("98765 43210"), "+19876543210")

    def test_the_caller_can_state_the_country_itself(self):
        self.assertEqual(sentdm.normalize_phone("9876543210", "91"), "+919876543210")
        self.assertEqual(sentdm.normalize_phone("9876543210", "+91"), "+919876543210")

    def test_punctuation_and_spacing_are_irrelevant(self):
        for raw in ("+91-98765-43210", "+91 (98765) 43210", " +91.98765.43210 "):
            with self.subTest(raw=raw):
                self.assertEqual(sentdm.normalize_phone(raw), "+919876543210")

    def test_nothing_usable_returns_blank_so_callers_fall_back(self):
        for raw in ("", "   ", "not a phone", "12345", None):
            with self.subTest(raw=raw):
                self.assertEqual(sentdm.normalize_phone(raw), "")

    def test_the_default_country_setting_is_read_defensively(self):
        for value in ("+91", "91 ", "", "abc"):
            with self.subTest(value=value):
                with patch.dict(os.environ, {"NEXUS_SMS_DEFAULT_COUNTRY": value}):
                    got = sentdm.normalize_phone("9876543210")
                self.assertIn(got, ("+919876543210", "+19876543210"))
                self.assertTrue(got.startswith("+"))


if __name__ == "__main__":
    unittest.main()
