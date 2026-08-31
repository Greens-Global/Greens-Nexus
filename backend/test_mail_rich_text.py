"""Descriptions and comments in notification emails render as text, not markup.

Task descriptions are rich text (TipTap HTML). The mail templates escaped every
row value, so a reader got "<p>Two separate escrow</p><p>..." printed in the
body of the email (reported Sept 1 2026, with the real task below).

The other half of the fix matters just as much: the stored markup is
author-supplied, so it is reduced to text rather than injected into a document
we send to other people.

Run with: python -m unittest test_mail_rich_text
"""
import unittest

from mail_text import Rich, rich_to_email_html
import task_mail_templates as tmpl
import ticket_mail_templates as ticket_tmpl


# Verbatim from the reported email.
REPORTED = ("<p>Two separate escrow</p><p>Two separate Tittles</p><p>Balance to be "
            "covered in the remainder parcel sell to clean up the loan entries</p>"
            "<p></p><p>Parcel B - $510K</p>")


class RichToEmailHtml(unittest.TestCase):
    def test_the_reported_description_reads_as_text(self):
        out = rich_to_email_html(REPORTED)
        self.assertNotIn("<p>", out)
        self.assertIn("Two separate escrow", out)
        self.assertIn("Parcel B - $510K", out)

    def test_paragraphs_become_line_breaks(self):
        self.assertEqual(rich_to_email_html("<p>One</p><p>Two</p>"), "One<br>Two")

    def test_a_run_of_empty_paragraphs_does_not_become_a_gap(self):
        # The reported text had <p></p> between paragraphs.
        self.assertEqual(rich_to_email_html("<p>One</p><p></p><p>Two</p>"), "One<br><br>Two")

    def test_br_becomes_a_line_break(self):
        self.assertEqual(rich_to_email_html("a<br>b<br/>c"), "a<br>b<br>c")

    def test_list_items_become_bullets(self):
        self.assertEqual(rich_to_email_html("<ul><li>One</li><li>Two</li></ul>"),
                         "• One<br>• Two")

    def test_plain_text_survives_and_keeps_its_line_breaks(self):
        # Ticket descriptions are a plain textarea - they used to collapse into
        # one run because HTML ignores newlines.
        self.assertEqual(rich_to_email_html("First line\nSecond line"),
                         "First line<br>Second line")

    def test_formatting_tags_are_dropped_not_shown(self):
        self.assertEqual(rich_to_email_html("<p><strong>Bold</strong> and <em>it</em></p>"),
                         "Bold and it")

    # ── the untrusted half ────────────────────────────────────────────────
    def test_a_script_tag_leaves_as_nothing(self):
        out = rich_to_email_html("<p>hi</p><script>alert(1)</script>")
        self.assertNotIn("<script", out.lower())
        self.assertNotIn("alert(1)", out)

    def test_an_event_handler_cannot_survive(self):
        out = rich_to_email_html('<img src=x onerror="steal()">done')
        self.assertNotIn("onerror", out)
        self.assertNotIn("<img", out.lower())

    def test_an_entity_encoded_tag_stays_visible_text(self):
        # Unescaping happens before the single final escape, so this reads as
        # characters rather than becoming a real tag.
        out = rich_to_email_html("&lt;script&gt;x&lt;/script&gt;")
        self.assertNotIn("<script", out.lower())
        self.assertIn("&lt;script&gt;", out)

    def test_ampersands_are_escaped_exactly_once(self):
        self.assertEqual(rich_to_email_html("<p>R&amp;D</p>"), "R&amp;D")
        self.assertEqual(rich_to_email_html("R&D"), "R&amp;D")

    # ── truncation ────────────────────────────────────────────────────────
    def test_the_limit_counts_visible_characters(self):
        # The old code sliced the RAW html at 400, which could cut mid-tag.
        long = "<p>" + ("x" * 900) + "</p>"
        out = rich_to_email_html(long)
        self.assertLessEqual(len(out.replace("…", "")), 401)
        self.assertTrue(out.endswith("…"))

    def test_truncation_never_leaves_a_half_written_tag(self):
        out = rich_to_email_html("<p>" + ("ab" * 300) + "</p><p>tail</p>")
        self.assertNotIn("<p", out)
        self.assertNotIn("</", out)

    def test_empty_input_is_empty(self):
        for v in ("", None, "<p></p>"):
            self.assertEqual(rich_to_email_html(v), "")

    def test_the_result_is_marked_rich(self):
        self.assertIsInstance(rich_to_email_html("hi"), Rich)


class RowRendering(unittest.TestCase):
    """The row renderer must not escape an already-safe value a second time."""

    def test_a_rich_value_is_not_re_escaped(self):
        self.assertEqual(tmpl._cell(Rich("One<br>Two")), "One<br>Two")

    def test_a_plain_value_is_still_escaped(self):
        self.assertEqual(tmpl._cell("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;")

    def test_blank_stays_a_dash(self):
        self.assertEqual(tmpl._cell(""), "-")
        self.assertEqual(tmpl._cell(None), "-")

    def test_the_ticket_templates_behave_identically(self):
        self.assertEqual(ticket_tmpl._cell(Rich("One<br>Two")), "One<br>Two")
        self.assertEqual(ticket_tmpl._cell("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;")


class RenderedEmails(unittest.TestCase):
    """End to end through the real template functions."""

    TASK = {"id": "t1", "code": "TASK-1", "title": "Escrow for Remainder of Parcel B",
            "description": REPORTED, "status": "not_started", "priority": "medium"}

    def test_the_created_email_shows_the_description_as_text(self):
        _subject, html = tmpl.created_email(t=self.TASK, base_url="https://x.test",
                                            logo_url="", audience="other")
        self.assertIn("Two separate escrow", html)
        self.assertNotIn("&lt;p&gt;", html)   # the reported symptom

    def test_the_ticket_created_email_does_too(self):
        ticket = {"id": "k1", "code": "000001", "subject": "S", "description": "Line one\nLine two",
                  "status": "new", "priority": "medium", "type": "bug"}
        _subject, html = ticket_tmpl.created_email_requester(
            t=ticket, base_url="https://x.test", logo_url="")
        self.assertIn("Line one<br>Line two", html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
