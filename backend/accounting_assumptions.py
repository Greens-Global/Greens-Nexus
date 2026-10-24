"""Defaults chosen for the 22 Oct 2026 Accounting change requests where the
call left a question open (E:/Calls/2026-10-22-GreensGlobal/changes.md).
Visesh approved building each with a recommended default; every one lives
HERE, named, so changing it once Charmi / Neil answer is a one-line edit.
Code imports these - never repeat the values inline. Where an environment
variable is named, it overrides the default without a deploy of code.
Read at call time through this module (`assumptions.NAME`), so a test or a
hot fix can swap one without touching the code that uses it.

Neil Kadakia and Charmi Desai answered the open questions in Teams on
23 Oct 2026 (~02:22 IST). Each constant's comment says "confirmed by team,
23 Oct" when it follows their answer, else "assumption, Charmi to confirm".
"""
import os


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ── CR-02 Compensation report ────────────────────────────────────────────────

# CR-02 (assumption, Charmi to confirm): chosen 100 seconds because the screen waits 180s
# for one attempt and Azure's front end cuts a request at 230s - stopping
# here leaves time to send a clear "pick fewer months" answer instead of a
# dead connection. Measured runs are a few seconds; this is only a backstop.
COMP_TIME_BUDGET_SEC = _env_int("NEXUS_COMP_TIME_BUDGET_SEC", 100)

# CR-02 (assumption, Charmi to confirm): chosen 6,000 person-months (500 people x 12
# months) because that is several times today's roster over the longest
# range the screen allows, while still refusing a run that could not finish
# inside the time budget. Checked BEFORE any card is priced.
COMP_MAX_PERSON_MONTHS = _env_int("NEXUS_COMP_MAX_PERSON_MONTHS", 6000)

# CR-02 (assumption, Charmi to confirm): chosen "refuse" because the report lists wages
# for EVERY company's people and the HR roster has no link to an Intacct
# entity, so a Full-level person limited to some entities (Accounting >
# Access rows) cannot be shown "their part" - widening that to everyone's
# payroll would be a quiet privilege grant. The screen says exactly why and
# what to change. "all" lets a Full-level person read the whole roster even
# with entity rows (the ledger half stays limited to their entities).
# A Controller with Full level and NO entity rows sees exactly what a Global
# Admin sees either way (test_accounting_compensation covers it).
COMP_ENTITY_SCOPED_POLICY = (os.environ.get("NEXUS_COMP_ENTITY_SCOPED", "") or "refuse").strip().lower()

# CR-02 (assumption, Charmi to confirm): "RDI" / "direct or indirect expenses" (Neil's
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
# monthly minimum, threshold, flat amount and threshold basis
# (accounting_ama_agreements). The threshold values further down only serve
# the older Percent or Flat basis.

# Team answer, Teams 23 Oct 2026 (Neil): "Management Fees are by contract,
# so they could be anything. Usually it's 3% of gross revenue or $3,000/month,
# whichever is higher. but these thresholds get built in property by
# property." -> the GREATER OF basis ('greater_of'): each agreement keeps its
# own rate and monthly minimum; new agreements start from the values below.
# The older "Percent or Flat (Threshold)" basis stays for agreements saved
# with it (nothing saved changes meaning).

# CR-03 (confirmed by team, 23 Oct): new agreements start on Greater Of.
MGMT_FEE_DEFAULT_BASIS = "greater_of"

# CR-03 (confirmed by team, 23 Oct): "$3,000/month" - the monthly minimum a
# new Greater Of agreement is filled with (each agreement keeps its own).
MGMT_FEE_DEFAULT_MONTHLY_MINIMUM = _env_float("NEXUS_MGMT_FEE_MONTHLY_MINIMUM", 3000.0)

# CR-03 (assumption, Charmi to confirm): "whichever is higher" is decided
# MONTH BY MONTH - each calendar month in force takes the higher of rate x
# that month's gross and the monthly minimum, and a period adds its months -
# because the minimum is stated per month. 'window' compares once over the
# whole period (rate x period gross vs. minimum x months) instead.
MGMT_FEE_GREATER_OF_COMPARES = ("month", "window")
MGMT_FEE_GREATER_OF_COMPARE = (os.environ.get("NEXUS_MGMT_FEE_GREATER_OF_COMPARE", "") or "month").strip().lower()

# CR-03 (assumption, Charmi to confirm): a month the agreement covers only
# part of (it starts or ends mid-month, or the month is still running) takes
# the WHOLE minimum - no proration - because contracts bill whole months and
# the month's gross is read whole too. True = the minimum times the share of
# the month's days inside the window.
MGMT_FEE_PRORATE_PARTIAL_MONTH = _flag("NEXUS_MGMT_FEE_PRORATE", False)
# CR-03 (assumption, Charmi to confirm): chosen $100,000 because it is the first figure
# Charmi gave ("$100,000 or $30,000 or $50,000") and 3% of $100,000 is exactly
# the $3,000 flat fee - the usual "3% of gross, at least $3,000" shape, where
# the two fees meet at the threshold. Pre-filled in Add Agreement only.
MGMT_FEE_DEFAULT_THRESHOLD = _env_float("NEXUS_MGMT_FEE_THRESHOLD", 100000.0)

# CR-03 (assumption, Charmi to confirm): chosen 3% / $3,000 because those are the figures
# in the operating agreement as Charmi quoted it on the call.
MGMT_FEE_DEFAULT_RATE = _env_float("NEXUS_MGMT_FEE_RATE", 3.0)
MGMT_FEE_DEFAULT_FLAT = _env_float("NEXUS_MGMT_FEE_FLAT", 3000.0)

# CR-03 (assumption, Charmi to confirm): chosen "annual" because an operating agreement's
# income threshold is a yearly figure: the test is the managed entity's gross
# for the calendar year, Jan 1 through the end of the period being looked at
# (the whole year once it has closed). "period" tests the gross of the period
# itself instead. An agreement can pick either; '' takes this one.
MGMT_FEE_THRESHOLD_BASES = ("annual", "period")
MGMT_FEE_DEFAULT_THRESHOLD_BASIS = (os.environ.get("NEXUS_MGMT_FEE_THRESHOLD_BASIS", "") or "annual").strip().lower()

# CR-03 (assumption, Charmi to confirm): chosen "the flat fee is per YEAR" (spread evenly
# over the year's billing dates: $3,000 a year = $250 a month when billed
# monthly) because a $3,000 floor paired with a 3% / $100,000 threshold only
# adds up as a yearly amount. False = the flat fee is per billing period, the
# way a plain Flat Amount agreement reads it.
MGMT_FEE_TIER_FLAT_IS_ANNUAL = (os.environ.get("NEXUS_MGMT_FEE_FLAT_ANNUAL", "") or "true").strip().lower() not in ("0", "false", "no")

# CR-03 (assumption, Charmi to confirm): chosen "above" (strictly more than) because
# Charmi said "if the income is MORE than ... then 3%", so gross exactly at
# the threshold takes the flat fee.
MGMT_FEE_STRICTLY_ABOVE = True

# CR-03 (assumption, Charmi to confirm): "gross income" = the P&L's Revenue and Other
# Income sections, because that is what Percent of Revenue agreements already
# read (so no existing figure moves) and it is everything the entity earned
# before expenses.
MGMT_FEE_GROSS_SECTIONS = ("revenue", "other_income")

# CR-03 (assumption, Charmi to confirm): no account narrowing by default (empty = every
# account in the sections above) because the chart of accounts is Intacct's
# and has no fixed number ranges across entities. To count only some, list
# codes and inclusive ranges, e.g. NEXUS_MGMT_FEE_GROSS_ACCOUNTS="40000-49999,70100".
MGMT_FEE_GROSS_ACCOUNTS = os.environ.get("NEXUS_MGMT_FEE_GROSS_ACCOUNTS", "")


def _emails(name: str) -> list[str]:
    return [e.strip().lower() for e in (os.getenv(name) or "").split(",") if e.strip()]


# ── CR-05: Report Builder ────────────────────────────────────────────────────
# Team answer, Teams 23 Oct 2026 (Neil): "Yes it needs comparison columns.
# Anyone can publish if they have access to accounting, and published reports
# can be shared with everyone, but are not shared by default."

# CR-05 (confirmed by team, 23 Oct): the comparisons a saved builder report
# may carry - the same keys as BUILDER_COMPARE_OPTIONS in
# frontend/src/components/accounting/assumptions.js (prior period and prior
# year: assumption, Charmi to confirm). Anything else is refused on save.
BUILDER_COMPARE_KEYS = ("prior_period", "prior_year")

# CR-05 (confirmed by team, 23 Oct): who may save and publish a builder
# report - anyone the Accounting grant lets in (the router's own viewer
# level; no editor check). Publishing never shares: `shared` (everyone) is
# set only by Share With Everyone, and sharing publishes.

# ── CR-10: Manual Journal Entries ────────────────────────────────────────────
# Team answer, Teams 23 Oct (Neil), on "Should a system-created entry that a
# person later edited count as manual?": "Yes". Who keyed an entry is read
# from Intacct's journal entry header (GLBATCH CREATEDBY / MODIFIEDBY, as
# login IDs through USERINFO) - read only (intacct_client.read_entry_audit).

def _logins(name: str, default: tuple) -> tuple:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return tuple(x.strip().lower() for x in raw.split(",") if x.strip())


# CR-10 (assumption, Charmi to confirm): the users who are NOT people - an
# entry they created is not manual. "system" is what Intacct's History shows
# for a bank-feed or rule entry (change-10-b). Override with
# NEXUS_MANUAL_JE_EXCLUDED_USERS="system,other.login".
MANUAL_JE_EXCLUDED_USERS = _logins("NEXUS_MANUAL_JE_EXCLUDED_USERS", ("system",))

# CR-10 (assumption, Charmi to confirm): the Web Services user Nexus and the
# accounting app sign in as (INTACCT_USER_ID) is a system user too - what it
# writes (an approved AMA reclass) was approved in Nexus, not keyed in Intacct.
MANUAL_JE_API_USER_IS_SYSTEM = _flag("NEXUS_MANUAL_JE_API_USER_IS_SYSTEM", True)

# CR-10 (assumption, Charmi to confirm): an entry whose header names a source
# or rule (any GLBATCH field with SOURCE or RULE in its name - "Transaction
# source: Rule", a Rule ID) containing one of these words was not created by
# hand, whoever Intacct names as its creator.
MANUAL_JE_EXCLUDED_SOURCES = _logins("NEXUS_MANUAL_JE_EXCLUDED_SOURCES", ("rule", "bank feed", "bankfeed", "recurring", "allocation"))

# CR-10 (confirmed by team, 23 Oct): a system-created entry a person later
# changed (MODIFIEDBY is a person) counts as manual, marked "Changed by a
# person". Note: Intacct also stamps MODIFIEDBY when a person only POSTS a
# rule's draft - the header cannot tell the two apart; the screen says so.
MANUAL_JE_EDITED_COUNTS = _flag("NEXUS_MANUAL_JE_EDITED_COUNTS", True)

# CR-10 (assumption, Charmi to confirm): only entries the General Ledger owns
# (MODULE "2.GL"; blank when not returned) - a bill or deposit posted from
# AP, AR or Cash Management is a subledger document, not a journal entry.
MANUAL_JE_MODULES = ("2.GL", "GL", "")

# CR-10 (assumption, Charmi to confirm): the longest range one run reads
# (Intacct is read live) - a year.
MANUAL_JE_MAX_DAYS = _env_int("NEXUS_MANUAL_JE_MAX_DAYS", 366)

# CR-10: how long one range's read is kept before Intacct is asked again.
MANUAL_JE_CACHE_SECONDS = _env_int("NEXUS_MANUAL_JE_CACHE_SECONDS", 300)

# ── CR-13: AMA (Ask My Accountant) reclass flow ─────────────────────────────
# Team answers, Teams 23 Oct 2026 ~02:22 IST (Neil): "Show all offsetting
# accounts. Bookkeepers are currently Charmi, Neil, Urmi Priyanka and Vinod,
# but we don't want to hardcode or limit that as more could be added in the
# future. The push should edit the original and the change should be visible
# on the other end. CAREFUL TO GET THIS RIGHT ... needs to be validated with 1
# entry at a time, then 4 at a time, then 10 at a time".

# CR-13 (confirmed by team, 23 Oct): who counts as a "bookkeeper" - the
# Bookkeepers list in AMA Settings (people on the Nexus People list; anyone
# can be added there later). While that list is empty, the emails in
# NEXUS_AMA_BOOKKEEPERS (comma-separated); while THAT is empty too, the names
# below, each matched at run time to exactly one active person on the Nexus
# People list (full name when a last name is given, else first name) - a name
# that matches nobody or more than one person is left out and shown as
# unmatched in AMA Settings, never guessed. Names only: no email is invented
# here. Saving the Bookkeepers list in AMA Settings replaces this seed.
AMA_BOOKKEEPERS_ENV = "NEXUS_AMA_BOOKKEEPERS"
AMA_BOOKKEEPERS_FALLBACK = _emails(AMA_BOOKKEEPERS_ENV)
AMA_BOOKKEEPER_SEED_NAMES = ("Charmi Desai", "Neil Kadakia", "Urmi", "Priyanka", "Vinod")

# CR-13 (assumption, Charmi to confirm): may a bookkeeper approve and push a
# reclass they proposed themselves? Chosen: yes - the bookkeeper IS the
# verifying role ("it has to go through the bookkeeper"); only non-bookkeepers
# are held back. False = a second bookkeeper must approve.
AMA_BOOKKEEPER_MAY_APPROVE_OWN = True

# CR-13 (confirmed by team, 23 Oct): "The push should edit the original" -
# 'edit_original' changes the account (and vendor / customer) of the AMA line
# ON THE ORIGINAL Intacct entry, every other field and every amount sent back
# exactly as read. 'new_entry' is the older reclass-entry path, kept only
# behind this switch (NEXUS_AMA_RECLASS_MODE=new_entry).
AMA_RECLASS_MODES = ("edit_original", "new_entry")
AMA_RECLASS_MODE = (os.getenv("NEXUS_AMA_RECLASS_MODE") or "edit_original").strip().lower()

# CR-13 (confirmed by team, 23 Oct): the most AMA lines one push may change.
# Neil: validate "with 1 entry at a time, then 4 at a time, then 10 at a time"
# - so 1 until the team has checked single pushes in Intacct, then
# NEXUS_AMA_PUSH_BATCH_LIMIT=4, then 10. The server refuses a preview or a
# push of more lines than this, whatever the screen sends.
AMA_PUSH_BATCH_LIMIT = max(1, _env_int("NEXUS_AMA_PUSH_BATCH_LIMIT", 1))

# CR-13 (assumption, Charmi to confirm): how long a preview stays good for a
# push. Chosen 15 minutes - long enough to read it, short enough to be fresh
# (the entry is re-read and compared at push time either way).
AMA_PREVIEW_TTL_MINUTES = _env_int("NEXUS_AMA_PREVIEW_TTL_MINUTES", 15)

# CR-13 (assumption, Charmi to confirm): the books are closed through this
# date (YYYY-MM-DD) - no push touches an entry dated on or before it. The
# date kept in AMA Settings wins; this is the server default ('' = none).
# Intacct also refuses a closed period itself; this stops it before a call.
AMA_BOOKS_CLOSED_THROUGH = (os.getenv("NEXUS_AMA_BOOKS_CLOSED_THROUGH") or "").strip()[:10]

# CR-13 (assumption, Charmi to confirm): never edit an entry that has a
# reconciled (cleared) line - an update sends every line of the entry again,
# and a bank reconciliation must not be disturbed from Nexus. Such a line is
# reclassed in Intacct by hand. False lets the push try (Intacct decides).
AMA_EDIT_REFUSE_CLEARED = _flag("NEXUS_AMA_EDIT_REFUSE_CLEARED", True)

# CR-13 (assumption, Charmi to confirm): the entry states a push may edit.
# Chosen Posted and Draft - an entry waiting for approval, reversed or
# otherwise in flight is left to Intacct.
AMA_EDIT_STATES = ("Posted", "Draft")

# CR-13 (assumption, Charmi to confirm): only entries the General Ledger
# module owns (MODULE "2.GL" in Intacct) are edited; an entry AP / AR / Cash
# Management posted is changed at its source, never here. '' = not said (an
# entry read from the Nexus ledger copy while the push is off).
AMA_EDIT_MODULES = ("2.GL", "GL", "")

# CR-13 (confirmed by team, 23 Oct): whether Push really writes to Intacct.
# OFF by default (NEXUS_AMA_INTACCT_PUSH=true turns it on, with the INTACCT_*
# settings of intacct_client.py). While off, Push runs every check, records
# exactly what it WOULD send in the push log and leaves the line Awaiting
# Bookkeeper - nothing reaches Intacct.
AMA_PUSH_TO_INTACCT = _flag("NEXUS_AMA_INTACCT_PUSH", False)

# CR-13 (assumption, Charmi to confirm) - 'new_entry' mode only: the journal
# the reclass entry posts to (GJ), its date ('original' = the AMA line's own
# date, or 'today') and the state it is created in (Posted).
AMA_RECLASS_JOURNAL = (os.getenv("NEXUS_AMA_RECLASS_JOURNAL") or "GJ").strip().upper()
AMA_RECLASS_DATE = "original"
AMA_RECLASS_STATE = "Posted"

# CR-13: the words the Intacct history comment of an edited entry starts with
# (and, in 'new_entry' mode, every reclass entry's description - the AMA
# screen knows that entry's own AMA line by them and shows it Resolved).
AMA_RECLASS_TAG = "Nexus AMA reclass"

# CR-13: a push that never came back (the server restarted mid-call) may be
# tried again after this many minutes.
AMA_PUSH_STALE_MINUTES = 15

# CR-13: how many journal entries one "other side" read may ask for (the
# screen asks for the page it shows).
AMA_OFFSET_BATCH_MAX = 100
