"""A board's Wrap Up (Neil, 11/12/2026, frontend/src/notes/board/wrapUp.js)
is written by the browser in the Notes editor's own markup and must come
through the notes sanitizer exactly as it was sent: the embedded board, the
headings, the nested list of replies and the links to the tasks made.

If the sanitizer ever stops keeping one of these, a Wrap Up would silently
lose that part - this pins it. The markup below is what wrapUp.js produces
(its own test, wrapUp.test.js, asserts the same strings).

Run with: python -m pytest test_notes_wrap_up.py   (one file per process - CLAUDE.md)
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ.setdefault("SUPABASE_URL", "https://store.supabase.co")

from routers.notes import sanitize_note       # noqa: E402

THUMB = "https://store.supabase.co/storage/v1/object/public/task-files/notes/boards/note_abc123/thumb.png"
EMBED = f'<a data-type="boardEmbed" data-note="note_abc123" data-thumb="{THUMB}" title="October Retro">October Retro</a>'
WRAP_UP = (
    EMBED
    + "<p>Wrapped up 11/12/2026 at 3:05 PM by Ana Ruiz: 4 stickies, 3 sections, 1 open question, 1 task.</p>"
    + "<h2>Most Votes</h2><ul><li><strong>2 Votes</strong> - Paint ran out &lt;twice&gt; (Ana, Bo)</li>"
    + "<li><strong>1 Vote</strong> - Gate repaired early (Bo)</li></ul>"
    + "<h2>What Went Well</h2><ul><li>Gate repaired early - Ana Ruiz (1 Vote - Bo)</li><li>New signs are up - Bo Chen</li></ul>"
    + "<h2>Open Questions</h2><ul><li>Who orders the paint? - Ana Ruiz<ul><li>Bo will - Bo Chen</li></ul></li></ul>"
    + '<h2>Tasks Made</h2><ul><li><a data-type="recordLink" data-ref="task:task_42" title="Paint ran out &lt;twice&gt;">'
    + "Paint ran out &lt;twice&gt;</a></li></ul>"
)


class WrapUpSanitizerTest(unittest.TestCase):
    def test_a_wrap_up_comes_through_exactly_as_sent(self):
        self.assertEqual(sanitize_note(WRAP_UP), WRAP_UP)

    def test_words_from_a_sticky_can_never_become_markup(self):
        # The browser escapes sticky words; were one to slip through raw, the
        # sanitizer still drops the script and keeps the list.
        out = sanitize_note("<h2>Other</h2><ul><li>Hello <script>alert(1)</script>there</li></ul>")
        self.assertNotIn("<script", out)
        self.assertIn("<h2>Other</h2>", out)
        self.assertIn("<li>Hello", out)

    def test_a_wrap_up_without_a_thumbnail_still_embeds_the_board(self):
        bare = '<a data-type="boardEmbed" data-note="note_abc123" title="October Retro">October Retro</a><p>x</p>'
        self.assertEqual(sanitize_note(bare), bare)


if __name__ == "__main__":
    unittest.main()
