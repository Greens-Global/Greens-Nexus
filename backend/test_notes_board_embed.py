"""A board embedded in a note (Mark Up / Insert Board, 11/02/2026) survives the
notes sanitizer with exactly its attributes - routers/notes.py _NoteSanitizer.

  <a data-type="boardEmbed" data-note="note_x" data-thumb="<our storage>" title="T">T</a>

  - data-type boardEmbed is allowed on <a>; data-note must look like a note
    id; data-thumb must be our own storage (anything else is dropped, the
    link and its words stay).
  - Other data-types on <a>, and the old attributes, behave as before.

Run with: python -m pytest test_notes_board_embed.py   (one file per process - CLAUDE.md)
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from routers import notes                     # noqa: E402
from routers.notes import sanitize_note       # noqa: E402

OWN = "https://store.supabase.co/storage/v1/object/public/task-files/notes/boards/note_1/thumb.png"
EMBED = f'<p>Plan:</p><a data-type="boardEmbed" data-note="note_abc123" data-thumb="{OWN}" title="Yard Layout">Yard Layout</a>'


class BoardEmbedSanitizerTest(unittest.TestCase):
    def setUp(self):
        # Our storage, as the boards test pins it (the real check reads SUPABASE_URL).
        self.own = mock.patch.object(notes, "_own_image", lambda src: src.startswith("https://store.supabase.co/"))
        self.own.start()
        self.addCleanup(self.own.stop)

    def test_a_board_embed_keeps_its_attributes(self):
        out = sanitize_note(EMBED)
        self.assertIn('data-type="boardEmbed"', out)
        self.assertIn('data-note="note_abc123"', out)
        self.assertIn(f'data-thumb="{OWN}"', out)
        self.assertIn('title="Yard Layout"', out)
        self.assertIn(">Yard Layout</a>", out)

    def test_a_thumbnail_outside_our_storage_is_dropped_but_the_embed_stays(self):
        out = sanitize_note(EMBED.replace(OWN, "https://evil.example/x.png"))
        self.assertIn('data-type="boardEmbed"', out)
        self.assertIn('data-note="note_abc123"', out)
        self.assertNotIn("evil.example", out)

    def test_a_bad_note_reference_is_dropped(self):
        out = sanitize_note(EMBED.replace("note_abc123", "javascript:alert(1)"))
        self.assertNotIn("javascript", out)
        self.assertNotIn("data-note", out)

    def test_an_unknown_data_type_on_a_link_is_dropped(self):
        out = sanitize_note('<a data-type="widget" href="https://nexus.example/x">x</a>')
        self.assertNotIn("data-type", out)
        self.assertIn('href="https://nexus.example/x"', out)

    def test_a_board_embed_never_carries_a_link(self):
        # A Can Edit collaborator could plant an href on a card styled as a board.
        out = sanitize_note(EMBED.replace("<a ", '<a href="https://evil.example/phish" '))
        self.assertIn('data-type="boardEmbed"', out)
        self.assertIn('data-note="note_abc123"', out)
        self.assertNotIn("href", out)
        self.assertNotIn("evil.example", out)
        # An ordinary link keeps its href.
        self.assertIn('href="https://nexus.example/x"', sanitize_note('<p><a href="https://nexus.example/x">x</a></p>'))


if __name__ == "__main__":
    unittest.main()
