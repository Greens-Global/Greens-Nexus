"""Accounting defaults chosen while an open question waits on Charmi.

Each one is a named value here and nowhere else - the code imports it, so a
different answer is a one-line change (or an environment setting where one
is noted). Read at call time through this module (`assumptions.NAME`), so a
test or a hot fix can swap one without touching the code that uses it.
"""
import os


def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _emails(name: str) -> list[str]:
    return [e.strip().lower() for e in (os.getenv(name) or "").split(",") if e.strip()]


# ── CR-13: AMA (Ask My Accountant) reclass flow ─────────────────────────────

# CR-13 (Charmi to confirm): who counts as a "bookkeeper" - chosen: the
# Bookkeepers list in AMA Settings (people on the Nexus People list, kept by an
# Accounting editor with every-entity access); while that list is empty, the
# emails in NEXUS_AMA_BOOKKEEPERS (comma-separated) - because an
# administrator's or owner's role opens every Accounting screen, so a level
# or role could never keep Neil (an answerer) from pushing. Never hard-code
# the people's emails here.
AMA_BOOKKEEPERS_ENV = "NEXUS_AMA_BOOKKEEPERS"
AMA_BOOKKEEPERS_FALLBACK = _emails(AMA_BOOKKEEPERS_ENV)

# CR-13 (Charmi to confirm): may a bookkeeper approve and push a reclass they
# proposed themselves? Chosen: yes - the bookkeeper IS the verifying role
# ("it has to go through the bookkeeper"); only non-bookkeepers are held back.
# False = a second bookkeeper must approve.
AMA_BOOKKEEPER_MAY_APPROVE_OWN = True

# CR-13 (Charmi to confirm): push = a NEW reclass journal entry in Intacct
# (debit/credit the chosen GL, the opposite side on the Ask My Accountant
# account), never an edit of the original entry - because an edit rewrites
# posted history (and the bank-feed entry it came from), while a reclass
# keeps the audit trail. The only supported value.
AMA_RECLASS_MODE = "new_entry"

# CR-13 (Charmi to confirm): whether Push really writes to Intacct. Chosen:
# OFF (NEXUS_AMA_INTACCT_PUSH=true turns it on, with the INTACCT_* settings
# of intacct_client.py) - while off, Push records the approved reclass and
# the bookkeeper imports it with the Intacct GL import file (same layout as
# the payroll and allocation imports). Nothing has written to Intacct from
# Nexus before, so the first real post should be a deliberate switch.
AMA_PUSH_TO_INTACCT = _flag("NEXUS_AMA_INTACCT_PUSH", False)

# CR-13 (Charmi to confirm): the journal the reclass entry posts to. Chosen:
# GJ (General Journal), where manual reclasses go today.
AMA_RECLASS_JOURNAL = (os.getenv("NEXUS_AMA_RECLASS_JOURNAL") or "GJ").strip().upper()

# CR-13 (Charmi to confirm): the reclass entry's date - "original" (the AMA
# line's own date, so the expense lands in the month it happened) or "today".
# Chosen: original - the P&L of that month is then right; a closed period
# makes Intacct refuse it and the bookkeeper sees why.
AMA_RECLASS_DATE = "original"

# CR-13 (Charmi to confirm): the state the reclass entry is created in, in
# Intacct: "Posted" (the bookkeeper has already approved it in Nexus) or
# "Draft". Chosen: Posted - the review happened here.
AMA_RECLASS_STATE = "Posted"

# CR-13: the words every reclass entry's description starts with. The AMA
# screen knows the reclass entry's own line on the AMA account by them and
# shows it as Resolved instead of a new open line.
AMA_RECLASS_TAG = "Nexus AMA reclass"

# CR-13: a push that never came back (the server restarted mid-call) may be
# tried again after this many minutes.
AMA_PUSH_STALE_MINUTES = 15

# CR-13: how many journal entries one "other side" read may ask for (the
# screen asks for the page it shows).
AMA_OFFSET_BATCH_MAX = 100
