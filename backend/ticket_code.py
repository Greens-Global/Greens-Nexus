"""Ticket numbers: how they are stored and how they are shown.

Its own module because both ends of the app need it and neither may import the
other - routers/tickets.py issues the numbers, ticket_mail_templates.py renders
them into email, and tickets.py -> ticket_notify.py -> ticket_mail_templates.py
is already an import chain. Putting the helper at either end would close it into
a cycle.

STORED  "000001"     - a plain zero-padded sequence, nothing else.
SHOWN   "Ticket #1"  - everywhere a person reads one (Oct 1: "#00027" read as
                       noise - it is just ticket 27, counting upwards). The
                       padding stays in storage only, where it keeps codes
                       sorting in order as text.

The "TKT-" prefix is gone. It was stored inside the value, so every consumer
carried it whether or not it wanted to, and the number could not be widened
without changing what the stored string looked like.

Six digits is a storage choice, not a display one: the stored sequence has to
be wide enough never to change width, because a code that grows a digit stops
sorting correctly as text.
"""

TICKET_CODE_DIGITS = 6


def digits_of(code: str) -> int:
    """The numeric part of any ticket code, new or legacy. "000012" -> 12,
    "TKT-012" -> 12. 0 when there is nothing to read."""
    found = "".join(ch for ch in (code or "") if ch.isdigit())
    return int(found) if found else 0


def normalize(code: str) -> str:
    """Any ticket code in its stored form. Legacy "TKT-012" becomes "000012",
    so a value read from an old row formats identically to a new one.

    Stripped first: a whitespace-only code is no code, and left unstripped it
    survives the "is there anything here" check and renders as "Ticket #   ".
    A non-numeric code is passed through rather than blanked - it is not a
    number we recognise, but it is still what identifies that row."""
    text = (code or "").strip()
    n = digits_of(text)
    return f"{n:0{TICKET_CODE_DIGITS}d}" if n else text


def display_number(code: str) -> str:
    """The number as a person reads it, without the storage padding:
    "000012" -> "12", "TKT-012" -> "12". A non-numeric code passes through."""
    text = (code or "").strip()
    n = digits_of(text)
    return str(n) if n else text


def ticket_no(code: str) -> str:
    """What a person reads: "Ticket #12".

    Blank stays blank rather than becoming "Ticket #" - a ticket with no number
    should look like it has none, not like it has an empty one."""
    shown = display_number(code)
    return f"Ticket #{shown}" if shown else ""
