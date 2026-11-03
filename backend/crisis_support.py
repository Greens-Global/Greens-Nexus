"""Crisis support: one deterministic check for messages that express suicidal
intent or self-harm (11/02/2026, the legal compliance pass - California SB 243
asks any chat that answers people to meet such a message with crisis
resources).

No AI, no key, no network: a fixed phrase list (`crisis_phrases.json`, the
same file as `frontend/src/lib/crisisPhrases.json`) run over normalized text.
The browser runs the same list before a message is sent and shows the
resources card the person acknowledges; the server runs it wherever an AI
answer would be generated, and for a message that matches it returns the
resources INSTEAD of generating an answer.

Privacy (a decision left to Neil): a match is never stored, logged, counted
or sent to anyone - no HR or manager alert. The message itself goes wherever
it was going (a ticket, Ask HR), exactly as it would have.
"""
import json
import os
import re
from functools import lru_cache

_PHRASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crisis_phrases.json")

# The resources shown with the card, by the person's country. Kept here (and
# mirrored in frontend/src/lib/crisisSupport.js) so the server can return the
# same lines wherever it declines to answer.
RESOURCES = {
    "US": {
        "country": "US",
        "label": "United States",
        "lines": [
            {"name": "988 Suicide & Crisis Lifeline", "detail": "Call or text 988, any time, free",
             "links": [{"label": "Call 988", "href": "tel:988"},
                       {"label": "Text 988", "href": "sms:988"},
                       {"label": "Chat at 988lifeline.org", "href": "https://988lifeline.org/chat/"}]},
        ],
        "emergency": {"number": "911", "href": "tel:911"},
    },
    "IN": {
        "country": "IN",
        "label": "India",
        "lines": [
            {"name": "Tele-MANAS", "detail": "Call 14416 or 1-800-891-4416, any time, free",
             "links": [{"label": "Call 14416", "href": "tel:14416"},
                       {"label": "Call 1-800-891-4416", "href": "tel:18008914416"}]},
        ],
        "emergency": {"number": "112", "href": "tel:112"},
    },
}

TITLE = "You Are Not Alone"
MESSAGE = ("It sounds like you may be going through something very hard. If you are "
           "thinking about suicide or hurting yourself, please reach out to one of the "
           "free, confidential lines below now. Talking to someone can help.")


@lru_cache(maxsize=1)
def _compiled():
    with open(_PHRASES, encoding="utf-8") as f:
        data = json.load(f)
    pats = [re.compile(p) for p in data.get("patterns", [])]
    excl = [re.compile(p) for p in data.get("exclusions", [])]
    return pats, excl


def normalize(text: str) -> str:
    """Lower case, apostrophes dropped (don't -> dont), every other character
    that is not a letter or digit to one space. Mirrors normalize() in
    frontend/src/lib/crisisSupport.js."""
    s = str(text or "").lower()
    s = re.sub(r"['‘’ʼ`]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return f" {s.strip()} "


def detect(text) -> bool:
    """True when the message expresses suicidal intent or self-harm."""
    if not text:
        return False
    s = normalize(text)
    if not s.strip():
        return False
    pats, excl = _compiled()
    for e in excl:
        s = e.sub(" ", s)
    return any(p.search(s) for p in pats)


def _country(code: str) -> str:
    c = (code or "").strip().upper()
    if c in ("US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"):
        return "US"
    if c in ("IN", "IND", "INDIA"):
        return "IN"
    return ""


def resources(country: str = "") -> list:
    """The resource blocks for a country; both US and India when it is not
    known (or is neither)."""
    c = _country(country)
    if c:
        return [RESOURCES[c]]
    return [RESOURCES["US"], RESOURCES["IN"]]


def payload(country: str = "") -> dict:
    """What a server route returns in place of an answer."""
    return {"title": TITLE, "message": MESSAGE, "resources": resources(country)}


def country_of(db, email: str) -> str:
    """The person's country for the resource list, through the one holiday
    rule (`holiday_policies.person_country`: their own, else their company's).
    '' when unknown - both lists are shown then. Never raises."""
    try:
        import holiday_policies
        from models import NexusEmployee
        from sqlalchemy import func
        emp = (db.query(NexusEmployee)
               .filter(func.lower(NexusEmployee.work_email) == (email or "").strip().lower())
               .first())
        if not emp:
            return ""
        company = holiday_policies.company_countries(db, [emp.company or ""]).get(emp.company or "", "")
        return _country(holiday_policies.person_country(emp, company))
    except Exception:
        return ""
