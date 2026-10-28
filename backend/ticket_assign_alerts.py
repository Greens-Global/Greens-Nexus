"""Tickets to Assign: a priority notice for the desk (Neil, Oct 26 2026).

A ticket nobody is assigned to is work nobody is doing. The desk heard about
it once, in the bell, when it arrived ("New Ticket to Assign",
routers/tickets._notify_triage) - and a bell that has been scrolled past is
not a queue. So while any open ticket waits for an assignee, each person who
hands that ticket out gets a PRIORITY notice (the yellow bar across the top
of their screen) listing what is waiting, and it goes away by itself once
every ticket on it has someone.

Who: the people who hear about an unassigned ticket anywhere else -
ticket_sla._desk_for (the company's service desk roster, else the flat
roster, else the Ticket Administrator, else every administrator; inactive
and offboarded people are skipped). An agent on several companies' desks
gets ONE notice covering all of them.

Which tickets: open (not resolved / closed), not deleted, no assignee, and
not waiting for approval (a gated ticket cannot be assigned until it is
approved - the desk's To Route queue covers it).

The notice: one per recipient, ref_id `ticket-unassigned:{email}`, rewritten
in place every CHECK_EVERY_SEC (notify_rollup.upsert_rollup, replace). It
comes back to the top, unread - and back onto the bar if it was clicked off -
only when a NEW ticket joins it; a shrinking list is a quiet update. Empty,
it is resolved (actioned, priority 0) with a closing line, so the bar clears
itself as tickets get assigned. The ids it lists travel in its action
(`ticketIds`), which is how "new" is told apart from "still waiting".

`waiting_for(db, email)` is the same rule for one person - the dashboard's
My Open Tickets tile reads it, so the tile and the bar never disagree.
"""
from __future__ import annotations

import asyncio
import json

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import SessionLocal
from models import NexusNotification, TaskTicket
from notify_rollup import resolve_rollup, upsert_rollup

CHECK_EVERY_SEC = 60
REF = "ticket-unassigned"
SHOWN = 8
CLOSED = ("resolved", "closed")
PRIORITY_LABEL = {"urgent": "Urgent", "high": "High", "medium": "Medium", "low": "Low"}
_PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}


def _ref(email: str) -> str:
    return f"{REF}:{email}"


def unassigned_tickets(db: Session) -> list:
    """Every ticket waiting for an assignee, most urgent first, then oldest."""
    T = TaskTicket
    rows = (db.query(T)
            .filter(or_(T.status.is_(None), T.status.notin_(CLOSED)),
                    or_(T.assignee_email.is_(None), T.assignee_email == ""),
                    or_(T.approval_status.is_(None), T.approval_status != "pending"))
            .all())
    return sorted(rows, key=lambda t: (_PRIORITY_RANK.get(t.priority or "medium", 2), t.created_at or ""))


def _desk(db: Session, t: TaskTicket, cfg: dict, cache: dict) -> list:
    """Who hands `t` out - one lookup per company (the answer depends on
    nothing else)."""
    import ticket_sla
    key = t.company_id or ""
    if key not in cache:
        cache[key] = [e.strip().lower() for e in ticket_sla._desk_for(db, t, cfg) if e]
    return cache[key]


def by_recipient(db: Session) -> dict:
    """{email: [tickets]} - what each desk member has waiting on them."""
    import ticket_notify
    cfg = ticket_notify.get_settings(db)
    cache: dict = {}
    out: dict = {}
    for t in unassigned_tickets(db):
        for email in dict.fromkeys(_desk(db, t, cfg, cache)):
            out.setdefault(email, []).append(t)
    return out


def waiting_for(db: Session, email: str) -> list:
    """The tickets waiting on `email` to assign them (the tile's count)."""
    import ticket_notify
    email = (email or "").strip().lower()
    if not email:
        return []
    cfg = ticket_notify.get_settings(db)
    cache: dict = {}
    return [t for t in unassigned_tickets(db) if email in _desk(db, t, cfg, cache)]


def _line(t: TaskTicket) -> str:
    from ticket_code import ticket_no
    label = PRIORITY_LABEL.get(t.priority or "medium", "Medium")
    return f"{ticket_no(t.code) or 'Ticket'} · {t.subject or 'Untitled ticket'} ({label})"


def _words(tickets: list) -> tuple:
    n = len(tickets)
    title = "1 Ticket to Assign" if n == 1 else f"{n} Tickets to Assign"
    # The bar shows the first sentence; the ticket lines sit under it.
    head = ("1 ticket is waiting for you to assign it." if n == 1
            else f"{n} tickets are waiting for you to assign them.")
    lines = [_line(t) for t in tickets[:SHOWN]]
    if n > SHOWN:
        lines.append(f"and {n - SHOWN} more")
    return title, "\n".join([head] + lines)


def _action(tickets: list) -> dict:
    action = {"view": "tickets", "label": "Assign Tickets" if len(tickets) != 1 else "Assign Ticket",
              "ticketFilter": "unassigned", "ticketIds": [t.id for t in tickets]}
    if len(tickets) == 1:
        action["ticketId"] = tickets[0].id   # one ticket: open it straight away
    return action


def _listed(row) -> set:
    try:
        return set((json.loads(row.action or "{}") or {}).get("ticketIds") or [])
    except (TypeError, ValueError):
        return set()


def scan(db: Session) -> dict:
    """One pass: write / refresh / resolve the notices. Commits. Returns
    counts {opened, updated, resolved}."""
    from notify_company import notification_company
    want = by_recipient(db)
    stats = {"opened": 0, "updated": 0, "resolved": 0}
    N = NexusNotification
    for email, tickets in want.items():
        title, body = _words(tickets)
        action = _action(tickets)
        old = (db.query(N)
               .filter(N.recipient == email, N.ref_id == _ref(email), N.type == "custom_alert",
                       N.actioned == False)   # noqa: E712 - SQLAlchemy expression
               .first())
        if old is not None and old.title == title and old.body == body and _listed(old) == set(action["ticketIds"]):
            continue
        # Back to the top, unread and onto the bar, only when a ticket joined.
        fresh = old is None or bool(set(action["ticketIds"]) - _listed(old))
        if upsert_rollup(db, recipient=email, key=_ref(email), title=title, line=body, action=action,
                         company=notification_company(db, email), replace=True, quiet=not fresh,
                         priority=1, open_only=True):
            stats["opened"] += 1
        else:
            stats["updated"] += 1
    for n in (db.query(N)
              .filter(N.ref_id.like(f"{REF}:%"), N.type == "custom_alert",
                      N.actioned == False).all()):   # noqa: E712
        email = (n.recipient or "").lower()
        if email in want or n.ref_id != _ref(email):
            continue
        if resolve_rollup(db, recipient=email, key=n.ref_id, title="Every Ticket Is Assigned",
                          line="Every ticket that was waiting for you to assign it now has someone on it."):
            stats["resolved"] += 1
    db.commit()
    return stats


def _tick() -> dict:
    db = SessionLocal()
    try:
        return scan(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[ticket-assign] scan failed: {e}")
        return {}
    finally:
        db.close()


async def ticket_assign_loop():
    """Started from main.py's lifespan on the elected leader. The scan is
    synchronous DB work, so it runs in a thread (CLAUDE.md: never block the
    event loop)."""
    await asyncio.sleep(90)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and any(s.values()):
            print(f"[ticket-assign] {s}")
        await asyncio.sleep(CHECK_EVERY_SEC)
