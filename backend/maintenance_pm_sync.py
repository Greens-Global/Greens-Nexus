"""A preventive ticket closed by ANY path (the drawer, My Work, bulk edits,
auto-close, the requester) writes its maintenance record and moves a floating
schedule on (Construction plan phase 5, 11/03/2026) - a before_flush hook on
SessionLocal, so no route has to remember (the feature_request_sync
pattern). Kept apart from maintenance_services.py so database.py can wire it
before models exist - everything heavy is imported inside the hook."""
from sqlalchemy import event, inspect

_CLOSED = ("resolved", "closed")


def wire(session_factory):
    @event.listens_for(session_factory, "before_flush")
    def _preventive_closed(session, _ctx, _instances):
        import models
        for obj in list(session.dirty):
            if not isinstance(obj, models.TaskTicket) or not (obj.service_id or ""):
                continue
            hist = inspect(obj).attrs.status.history
            if not hist.has_changes() or (obj.status or "") not in _CLOSED:
                continue
            old = hist.deleted[0] if hist.deleted else ""
            if old in _CLOSED:
                continue
            try:
                import maintenance_services
                maintenance_services.on_ticket_closed(session, obj)
            except Exception as e:  # noqa: BLE001 - never fail the ticket save
                print(f"[maintenance-services] close {obj.id}: {e}")
