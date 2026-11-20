"""Who is OUR STAFF for pay, leave and attendance - one rule (11/20/2026).

How a person signs in is not whether we pay them. Hourly staff without a
company mailbox (a gmail address) sign in as Microsoft Entra GUESTS, so
`identity_type` is 'guest' - yet they punch, carry a pay rate and are paid
through the Time Sheet. Every "our staff" list used to read
`identity_type == 'internal'` and silently dropped them: Charmi, 11/20/2026,
"I do not see Nayeli, Alana and Sophia in Leave balances" - three paid
employees missing from Leave Balances, the leave year end, the Workforce
Scorecard and the time-off calendar.

The rule: an internal identity (or a pre-column row with none), OR a guest
who is on payroll - a `payroll_rates` row. An `external` identity (a vendor,
an investor, a contractor's own login) is never staff here, and a guest with
no pay rate (a family member, an advisor with a gmail login) stays out.

A new pay / leave / attendance roster filters with `staff_clause()` or asks
`is_staff()` - never `identity_type == 'internal'` by itself.
"""
from __future__ import annotations

from sqlalchemy import exists, func, or_
from sqlalchemy.orm import Session

import models

INTERNAL = ("internal", "")


def staff_clause():
    """A filter for `db.query(models.NexusEmployee)`: internal, or a guest
    with a pay rate."""
    E, R = models.NexusEmployee, models.PayrollRate
    on_payroll = exists().where(func.lower(R.employee_email) == func.lower(E.work_email))
    return or_(E.identity_type.is_(None), E.identity_type.in_(INTERNAL),
               (E.identity_type == "guest") & on_payroll)


def is_staff(db: Session, emp) -> bool:
    """The same rule for one person."""
    if emp is None:
        return False
    kind = (getattr(emp, "identity_type", "") or "").strip()
    if kind in INTERNAL:
        return True
    if kind != "guest":
        return False
    email = (getattr(emp, "work_email", "") or "").strip().lower()
    return bool(email) and db.query(models.PayrollRate.employee_email).filter(
        func.lower(models.PayrollRate.employee_email) == email).first() is not None
