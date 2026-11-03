"""A preventive ticket closed by ANY path (the drawer, My Work, bulk edits,
auto-close, the requester) writes its maintenance record and moves a floating
schedule on; one deleted while a floating schedule waits on it restarts that
schedule (Construction plan phase 5, 11/03/2026) - a before_flush hook on
SessionLocal, so no route has to remember (the feature_request_sync
pattern). Kept apart from maintenance_services.py so database.py can wire it
before models exist - everything heavy is imported inside the hook."""
from sqlalchemy import event, inspect

_CLOSED = ("resolved", "closed")


def _moved(obj, attr):
    hist = getattr(inspect(obj).attrs, attr).history
    if not hist.has_changes():
        return None
    return hist.deleted[0] if hist.deleted else ""


def wire(session_factory):
    @event.listens_for(session_factory, "before_flush")
    def _preventive_closed(session, _ctx, _instances):
        import models
        for obj in list(session.dirty):
            if not isinstance(obj, models.TaskTicket) or not (obj.service_id or ""):
                continue
            try:
                import maintenance_services
                old = _moved(obj, "status")
                if old is not None and (obj.status or "") in _CLOSED and old not in _CLOSED:
                    maintenance_services.on_ticket_closed(session, obj)
                gone = _moved(obj, "deleted_at")
                if gone is not None and not gone and (obj.deleted_at or ""):
                    maintenance_services.on_ticket_deleted(session, obj)
            except Exception as e:  # noqa: BLE001 - never fail the ticket save
                print(f"[maintenance-services] ticket {obj.id}: {e}")
