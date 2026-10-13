"""The company to stamp on a bell notification (`NexusNotification.company`).

A broadcast (recipient '') is filtered by company once the company walls are
armed (`routers/notifications.py`), so one written without a company is seen by
Global Admins only. Every module builds its own notification row; this is the
one shared piece - which company the row belongs to.
"""
from auth import company_of


def notification_company(db, *emails) -> str:
    """Company of the first of `emails` that has one. Pass the person the event
    is about (the actor / subject) first and the recipient last, so a broadcast
    lands in the actor's company and a personal one falls back to the
    recipient's. '' when nobody resolves (blank, external or untagged) - the
    same value the column had before it was stamped.

    Never raises: a notification must not break the action that triggered it."""
    for email in emails:
        if not isinstance(email, str) or not email.strip():
            continue
        try:
            company = company_of(email.strip(), db)
        except Exception as e:   # noqa: BLE001 - the bell row still gets written, unstamped
            print(f"[notify-company] lookup failed: {e}")
            return ""
        if company:
            return company
    return ""
