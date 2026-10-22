"""Defaults chosen for the 22 Oct 2026 Accounting change requests where the
call left a question open (E:/Calls/2026-10-22-GreensGlobal/changes.md).
Visesh approved building each with a recommended default; every one lives
HERE, named, so changing it once Charmi / Neil answer is a one-line edit.
Code imports these - never repeat the values inline. Where an environment
variable is named, it overrides the default without a deploy of code.
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
