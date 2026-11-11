"""The committed Word round-trip fixtures are what the exporter writes today.

frontend/src/lib/wordRoundTrip.test.js imports the four files in
frontend/src/lib/__fixtures__/word to prove a Word file Nexus writes comes
back. If the exporter changes and the files do not, that test proves
nothing - so this fails, and the fix is:

    cd backend && python docx_roundtrip_fixtures.py

Run: python -m unittest test_docx_roundtrip_fixtures
"""
import os
import unittest

from docx_roundtrip_fixtures import FIXTURES, OUT_DIR, build, document_xml


class FixturesAreCurrent(unittest.TestCase):
    def test_every_fixture_matches_the_exporter(self):
        for name in FIXTURES:
            with self.subTest(name=name):
                path = os.path.join(OUT_DIR, f"{name}.docx")
                self.assertTrue(os.path.exists(path), f"{name}.docx is missing - run python docx_roundtrip_fixtures.py")
                with open(path, "rb") as fh:
                    committed = document_xml(fh.read())
                self.assertEqual(document_xml(build(name)), committed,
                                 f"{name}.docx is out of date - run python docx_roundtrip_fixtures.py")


if __name__ == "__main__":
    unittest.main()
