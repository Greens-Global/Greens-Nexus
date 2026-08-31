"""Turning stored task/ticket text into something an email can show.

Both mail template modules escaped every row value, which is right for a name
or a date and wrong for a description: task descriptions are rich text (TipTap
HTML, see frontend RichDescription.jsx), so escaping them printed the markup at
the reader - "<p>Two separate escrow</p><p>..." in the body of the email
(reported Sept 1 2026).

The fix is NOT to drop the escaping and inject the stored HTML into the mail.
That is untrusted, author-supplied markup going into a document we send to other
people, and it would also let a stray unclosed tag swallow the rest of the
message. Instead the markup is reduced to text here - block ends become line
breaks, list items become bullets, every tag is removed - and the result is
escaped exactly once. Formatting is lost; a notification is a summary with a
"View Task" button for the real thing.

Plain text goes through unharmed and gains its line breaks, which is why ticket
descriptions (a plain textarea) route through it too - they used to collapse
into one run because HTML ignores newlines.
"""
import re
from html import escape, unescape


class Rich(str):
    """Email HTML that is already safe - the row renderer must not escape it
    again. A plain str stays plain and is still escaped, so a caller that
    forgets to convert gets the old, safe behavior rather than an injection."""


# Whole blocks whose CONTENT is not prose - dropping only the tags would leave
# the script body sitting in the email as visible text.
_SCRIPTISH = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.I | re.S)
_BR = re.compile(r"<br\s*/?>", re.I)
_LI_OPEN = re.compile(r"<li[^>]*>", re.I)
_BLOCK_END = re.compile(r"</(?:p|div|h[1-6]|tr|blockquote|ul|ol)\s*>", re.I)
_TAG = re.compile(r"<[^>]*>")


def rich_to_email_html(raw, limit: int = 400) -> Rich:
    """Stored description/comment text -> safe email HTML.

    `limit` counts VISIBLE characters. The old code truncated the raw string,
    which on rich text could cut in the middle of a tag and, once escaped, put
    a half-written tag in front of the reader.
    """
    s = raw or ""
    # Before anything else: these carry no prose, and stripping only their tags
    # would leave the script body in the email as visible text.
    s = _SCRIPTISH.sub("", s)
    s = _BR.sub("\n", s)
    s = _LI_OPEN.sub("\n• ", s)
    s = _BLOCK_END.sub("\n", s)
    # Every remaining tag, opening or closing, known or not - so a <script> or a
    # malformed <img onerror=...> leaves as nothing rather than as markup.
    s = _TAG.sub("", s)
    # Entities the editor stored (&amp;, &nbsp;) become real characters, then the
    # single escape() below re-encodes them. Without this the reader sees
    # "&amp;" spelled out; with it applied twice they would see "&amp;amp;".
    s = unescape(s).replace(" ", " ")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n[ \t]+", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    if len(s) > limit:
        s = s[:limit].rstrip() + "…"
    return Rich(escape(s).replace("\n", "<br>"))
