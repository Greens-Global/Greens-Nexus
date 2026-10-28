"""The record observer (spec 5.3): events for free. Session listeners on
SessionLocal, like audit_capture's; for every model registered as an
entity with `observe=True` it emits `<entity>.created` for a new row and
one `<entity>.field_changed` per changed field in `observe_fields`, with the
from / to read from the attribute history. This is how Items gets events
without touching Visesh's file and how a module gets basic triggers without
writing a line. Bulk `query.update()` writes are not seen (same as the
audit stream).

Two passes, because the from value is not always in memory: an attribute
set after a commit (expired) has a history with the new value and no old
one, so `before_flush` collects the changes and reads any unknown old value
from the database while the row still holds it; `after_flush` writes the
outbox rows (through `emit`, on the same connection, inside the flushing
transaction) once the UPDATE has gone through. A failure is one log line;
the flush always succeeds. Events caused by a run are skipped past depth 2
(emit also refuses them; the check here saves the work).
"""
from __future__ import annotations

from workflows import catalog
from workflows.emit import CURRENT_RUN, MAX_DEPTH, emit

PENDING = "_wf_pending_changes"     # session.info: [(obj, entity_def, {field: (old, new)})]

_model_map: dict = {}
_model_map_size = -1


def _observed() -> dict:
    """{model class: EntityDef} for observed entities, rebuilt when the
    registry grew (packs load lazily)."""
    global _model_map, _model_map_size
    try:
        catalog.load_packs()
    except Exception as e:   # noqa: BLE001 - a pack that fails to import is reported by its own test
        print(f"[workflows] observer: packs not loaded: {type(e).__name__}: {str(e)[:160]}")
    if len(catalog.ENTITIES) != _model_map_size:
        _model_map = {ent.model: ent for ent in catalog.ENTITIES.values()
                      if ent.observe and ent.model is not None}
        _model_map_size = len(catalog.ENTITIES)
    return _model_map


def _history(obj, attr: str):
    """(changed, old, new, old_known) for one attribute from the ORM
    history. An attribute set while expired has no old value loaded
    (deleted is empty); None as the old value IS reported by SQLAlchemy."""
    from sqlalchemy import inspect as sa_inspect
    hist = sa_inspect(obj).attrs[attr].history
    if not hist.has_changes():
        return False, None, None, True
    new = hist.added[0] if hist.added else None
    if hist.deleted:
        return True, hist.deleted[0], new, True
    return True, None, new, False


def _stored_values(session, obj, attrs: list) -> dict:
    """The columns' values as the database holds them right now (before this
    flush's UPDATE), by primary key."""
    from sqlalchemy import inspect as sa_inspect, select
    state = sa_inspect(obj)
    mapper = state.mapper
    table = mapper.local_table
    pk_cols = list(mapper.primary_key)
    ident = state.identity
    if ident is None or len(ident) != len(pk_cols):
        return {}
    cols = [mapper.get_property(a).columns[0] for a in attrs]
    stmt = select(*cols)
    for col, val in zip(pk_cols, ident):
        stmt = stmt.where(col == val)
    row = session.connection().execute(stmt.select_from(table)).first()
    if row is None:
        return {}
    return {a: row[i] for i, a in enumerate(attrs)}


def collect_changes(session) -> None:
    """before_flush: note each observed object's changed fields, filling in
    old values the ORM did not have loaded."""
    run = CURRENT_RUN.get()
    if run and int(run[1] or 0) + 1 > MAX_DEPTH:
        return
    observed = _observed()
    if not observed:
        return
    pending = session.info.setdefault(PENDING, [])
    for obj in list(session.dirty):
        ent = observed.get(type(obj))
        if ent is None or not ent.observe_fields or obj in session.deleted or not session.is_modified(obj):
            continue
        if f"{ent.key}.field_changed" not in catalog.EVENTS:
            continue
        changes: dict = {}
        unknown: list = []
        for f in ent.observe_fields:
            try:
                changed, old, new, known = _history(obj, f)
            except Exception:   # noqa: BLE001 - an attribute the mapper does not know is not a change
                continue
            if not changed:
                continue
            changes[f] = (old, new)
            if not known:
                unknown.append(f)
        if unknown:
            try:
                stored = _stored_values(session, obj, unknown)
            except Exception as e:   # noqa: BLE001 - the from stays blank rather than losing the event
                print(f"[workflows] observer: old values not read: {type(e).__name__}: {str(e)[:160]}")
                stored = {}
            for f in unknown:
                changes[f] = (stored.get(f), changes[f][1])
        changes = {f: (o, n) for f, (o, n) in changes.items() if o != n}
        if changes:
            pending.append((obj, ent, changes))


def emit_changes(session) -> None:
    """after_flush: created rows for the new objects, field_changed rows for
    what before_flush collected."""
    pending = session.info.pop(PENDING, [])
    run = CURRENT_RUN.get()
    if run and int(run[1] or 0) + 1 > MAX_DEPTH:
        return
    observed = _observed()
    for obj in list(session.new):
        ent = observed.get(type(obj))
        if ent is None:
            continue
        key = f"{ent.key}.created"
        if key in catalog.EVENTS:
            emit(session, key, subject=obj)
    for obj, ent, changes in pending:
        key = f"{ent.key}.field_changed"
        for f, (old, new) in changes.items():
            emit(session, key, subject=obj, changes={f: (old, new)}, extra={"field": f})


def wire(session_factory) -> None:
    """Attach the listeners to SessionLocal (called once from database.py)."""
    from sqlalchemy import event

    @event.listens_for(session_factory, "before_flush")
    def _collect(session, _flush_ctx, _instances):
        try:
            collect_changes(session)
        except Exception as e:   # noqa: BLE001 - observing must never fail the write
            print(f"[workflows] observer skipped (before flush): {type(e).__name__}: {str(e)[:200]}")

    @event.listens_for(session_factory, "after_flush")
    def _emit(session, _flush_ctx):
        try:
            emit_changes(session)
        except Exception as e:   # noqa: BLE001
            session.info.pop(PENDING, None)
            print(f"[workflows] observer skipped (flush): {type(e).__name__}: {str(e)[:200]}")

    @event.listens_for(session_factory, "after_rollback")
    def _discard(session):
        session.info.pop(PENDING, None)
