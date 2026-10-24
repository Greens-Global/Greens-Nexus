"""Ticket -> What's New request status sync (Oct 23 2026, feature_requests.py).

A feature_request ticket's status can move from many places (the drawer,
bulk edits, the requester resolving or reopening, auto-close, approvals...).
Rather than remember each one, a before_flush hook on SessionLocal sees every
status change on such a ticket and hands it to
feature_requests.pull_status_from_ticket. Kept apart from feature_requests.py
so database.py can wire it before models exist - everything heavy is
imported inside the hook.
"""
from sqlalchemy import event, inspect


def wire(session_factory):
    @event.listens_for(session_factory, "before_flush")
    def _ticket_status_to_request(session, _ctx, _instances):
        import models
        import feature_requests
        for obj in list(session.dirty):
            if not isinstance(obj, models.TaskTicket) or (obj.type or "") != "feature_request":
                continue
            if getattr(obj, feature_requests.FROM_REQUEST, False):
                setattr(obj, feature_requests.FROM_REQUEST, False)   # What's New moved it - nothing to echo
                continue
            hist = inspect(obj).attrs.status.history
            if not hist.has_changes():
                continue
            old = hist.deleted[0] if hist.deleted else ""
            if old == obj.status:
                continue
            try:
                feature_requests.pull_status_from_ticket(session, obj, old or "")
            except Exception as e:  # noqa: BLE001 - a status sync must never fail the ticket save
                print(f"[feature-requests] status sync {obj.id}: {e}")
