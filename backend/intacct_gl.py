"""Intacct General Ledger import file - the one column layout (Oct 2026).

The accounting app's bank import (src/lib/finance/intacct-gl-export.ts in the
Greens Accounting repo) emits Charmi's 28-column GL import sheet; the payroll
export (routers/timeclock.py) and the monthly allocation entry
(routers/accounting_allocations.py) write the SAME file so one Intacct import
definition reads all three. Header row and field order are copied from that
module, not invented here: the first line of an entry carries the header
fields (journal, date, description, reference), continuation lines leave
them blank and Intacct groups by the preceding line. Dates are MM-DD-YYYY,
money has two decimals, the empty side of a line is blank.

An entry is {journal, date (ISO), description, reference_no, lines: [...]};
a line is {line_no, acct_no, location_id, dept_id, memo, debit, credit,
source_entity, employee_id?}. employee_id fills GLENTRY_EMPLOYEEID, a column
the layout already has - the payroll export keys it so Intacct's employee
dimension is set on every wage line.
"""
import csv
import io

INTACCT_GL_COLUMNS = (
    "DONOTIMPORT", "JOURNAL", "DATE", "REVERSEDATE", "DESCRIPTION", "REFERENCE_NO", "LINE_NO", "ACCT_NO", "LOCATION_ID", "DEPT_ID", "DOCUMENT", "MEMO",
    "DEBIT", "CREDIT", "SOURCEENTITY", "CURRENCY", "EXCH_RATE_DATE", "EXCH_RATE_TYPE_ID", "EXCHANGE_RATE", "STATE", "ALLOCATION_ID", "BILLABLE",
    "RPESENTRY", "GLENTRY_CUSTOMERID", "GLENTRY_VENDORID", "GLENTRY_ITEMID", "GLENTRY_CLASSID", "GLENTRY_EMPLOYEEID",
)

DESC_MAX = 80
MEMO_MAX = 1000


def intacct_date(iso: str) -> str:
    """Intacct's date column in Charmi's files: MM-DD-YYYY."""
    s = (iso or "")[:10]
    return f"{s[5:7]}-{s[8:10]}-{s[0:4]}" if len(s) == 10 else ""


def _money(v) -> str:
    return "" if v is None else f"{float(v):.2f}"


def to_rows(entries: list[dict]) -> list[list[str]]:
    """Header plus one row per line, the header fields on an entry's first line only."""
    rows = [list(INTACCT_GL_COLUMNS)]
    for e in entries:
        for i, line in enumerate(e.get("lines") or []):
            first = i == 0
            row = [""] * len(INTACCT_GL_COLUMNS)
            row[1] = (e.get("journal") or "") if first else ""
            row[2] = intacct_date(e.get("date") or "") if first else ""
            row[4] = (e.get("description") or "")[:DESC_MAX] if first else ""
            row[5] = (e.get("reference_no") or "")[:20] if first else ""
            row[6] = str(line.get("line_no") or i + 1)
            row[7] = line.get("acct_no") or ""
            row[8] = line.get("location_id") or ""
            row[9] = line.get("dept_id") or ""
            row[11] = (line.get("memo") or "")[:MEMO_MAX]
            row[12] = _money(line.get("debit"))
            row[13] = _money(line.get("credit"))
            row[14] = line.get("source_entity") or ""
            row[27] = line.get("employee_id") or ""
            rows.append(row)
    return rows


def to_csv(entries: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    for row in to_rows(entries):
        w.writerow(row)
    return buf.getvalue()


def balanced(entries: list[dict]) -> bool:
    """Every entry's debits equal its credits to the cent."""
    for e in entries:
        d = sum(float(line.get("debit") or 0) for line in e.get("lines") or [])
        c = sum(float(line.get("credit") or 0) for line in e.get("lines") or [])
        if abs(d - c) >= 0.005:
            return False
    return True
