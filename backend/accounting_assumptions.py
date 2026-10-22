"""Defaults chosen for the 22 Oct 2026 Accounting change requests where the
call left a question open (E:/Calls/2026-10-22-GreensGlobal/changes.md).
Visesh approved building each with a recommended default; every one lives
HERE, named, so changing it once Charmi / Neil answer is a one-line edit.
Code imports these - never repeat the values inline. Where an environment
variable is named, it overrides the default without a deploy of code.
Read at call time through this module (`assumptions.NAME`), so a test or a
hot fix can swap one without touching the code that uses it.
"""
import os


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# ── CR-02 Compensation report ────────────────────────────────────────────────

# CR-02 (Charmi to confirm): chosen 100 seconds because the screen waits 180s
# for one attempt and Azure's front end cuts a request at 230s - stopping
# here leaves time to send a clear "pick fewer months" answer instead of a
# dead connection. Measured runs are a few seconds; this is only a backstop.
COMP_TIME_BUDGET_SEC = _env_int("NEXUS_COMP_TIME_BUDGET_SEC", 100)

# CR-02 (Charmi to confirm): chosen 6,000 person-months (500 people x 12
# months) because that is several times today's roster over the longest
# range the screen allows, while still refusing a run that could not finish
# inside the time budget. Checked BEFORE any card is priced.
COMP_MAX_PERSON_MONTHS = _env_int("NEXUS_COMP_MAX_PERSON_MONTHS", 6000)

# CR-02 (Charmi to confirm): chosen "refuse" because the report lists wages
# for EVERY company's people and the HR roster has no link to an Intacct
# entity, so a Full-level person limited to some entities (Accounting >
# Access rows) cannot be shown "their part" - widening that to everyone's
# payroll would be a quiet privilege grant. The screen says exactly why and
# what to change. "all" lets a Full-level person read the whole roster even
# with entity rows (the ledger half stays limited to their entities).
# A Controller with Full level and NO entity rows sees exactly what a Global
# Admin sees either way (test_accounting_compensation covers it).
COMP_ENTITY_SCOPED_POLICY = (os.environ.get("NEXUS_COMP_ENTITY_SCOPED", "") or "refuse").strip().lower()

# CR-02 (Charmi to confirm): "RDI" / "direct or indirect expenses" (Neil's
# definition was given to Visesh separately) - chosen: split the ledger's
# payroll expense by where it is booked, DIRECT = cost of sales (the "cogs"
# section: labor charged to properties / jobs), INDIRECT = operating and
# other expense (overhead), because that is the standard accounting meaning
# of direct vs. indirect labor and needs no new data. "RDI" is read as this
# same Direct / Indirect split until Neil says otherwise.
COMP_DIRECT_SECTIONS = ("cogs",)
COMP_INDIRECT_SECTIONS = ("expense", "other_expense")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


# ── CR-03 Management Fees ────────────────────────────────────────────────────
# Every value below is only a DEFAULT: an agreement keeps its own percent,
# threshold, flat amount and threshold basis (accounting_ama_agreements).

# CR-03 (Charmi to confirm): chosen $100,000 because it is the first figure
# Charmi gave ("$100,000 or $30,000 or $50,000") and 3% of $100,000 is exactly
# the $3,000 flat fee - the usual "3% of gross, at least $3,000" shape, where
# the two fees meet at the threshold. Pre-filled in Add Agreement only.
MGMT_FEE_DEFAULT_THRESHOLD = _env_float("NEXUS_MGMT_FEE_THRESHOLD", 100000.0)

# CR-03 (Charmi to confirm): chosen 3% / $3,000 because those are the figures
# in the operating agreement as Charmi quoted it on the call.
MGMT_FEE_DEFAULT_RATE = _env_float("NEXUS_MGMT_FEE_RATE", 3.0)
MGMT_FEE_DEFAULT_FLAT = _env_float("NEXUS_MGMT_FEE_FLAT", 3000.0)

# CR-03 (Charmi to confirm): chosen "annual" because an operating agreement's
# income threshold is a yearly figure: the test is the managed entity's gross
# for the calendar year, Jan 1 through the end of the period being looked at
# (the whole year once it has closed). "period" tests the gross of the period
# itself instead. An agreement can pick either; '' takes this one.
MGMT_FEE_THRESHOLD_BASES = ("annual", "period")
MGMT_FEE_DEFAULT_THRESHOLD_BASIS = (os.environ.get("NEXUS_MGMT_FEE_THRESHOLD_BASIS", "") or "annual").strip().lower()

# CR-03 (Charmi to confirm): chosen "the flat fee is per YEAR" (spread evenly
# over the year's billing dates: $3,000 a year = $250 a month when billed
# monthly) because a $3,000 floor paired with a 3% / $100,000 threshold only
# adds up as a yearly amount. False = the flat fee is per billing period, the
# way a plain Flat Amount agreement reads it.
MGMT_FEE_TIER_FLAT_IS_ANNUAL = (os.environ.get("NEXUS_MGMT_FEE_FLAT_ANNUAL", "") or "true").strip().lower() not in ("0", "false", "no")

# CR-03 (Charmi to confirm): chosen "above" (strictly more than) because
# Charmi said "if the income is MORE than ... then 3%", so gross exactly at
# the threshold takes the flat fee.
MGMT_FEE_STRICTLY_ABOVE = True

# CR-03 (Charmi to confirm): "gross income" = the P&L's Revenue and Other
# Income sections, because that is what Percent of Revenue agreements already
# read (so no existing figure moves) and it is everything the entity earned
# before expenses.
MGMT_FEE_GROSS_SECTIONS = ("revenue", "other_income")

# CR-03 (Charmi to confirm): no account narrowing by default (empty = every
# account in the sections above) because the chart of accounts is Intacct's
# and has no fixed number ranges across entities. To count only some, list
# codes and inclusive ranges, e.g. NEXUS_MGMT_FEE_GROSS_ACCOUNTS="40000-49999,70100".
MGMT_FEE_GROSS_ACCOUNTS = os.environ.get("NEXUS_MGMT_FEE_GROSS_ACCOUNTS", "")


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
