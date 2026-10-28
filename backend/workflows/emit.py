"""The outbox write (Task 2 fills this in): `emit(db, key, *, subject, ...)`
writes one workflow_events row inside the caller's transaction. Stub for
the catalog task so the package imports."""
from __future__ import annotations

import contextvars

# (run_id, depth) of the run whose step is executing on this thread, so an
# event a workflow causes is tagged with it (no chaining by default).
CURRENT_RUN: contextvars.ContextVar = contextvars.ContextVar("workflow_run", default=None)


def emit(db, key: str, *, subject, actor: str = "", changes=None, extra=None, company_id=None) -> None:
    raise NotImplementedError("workflows.emit lands in Task 2")
