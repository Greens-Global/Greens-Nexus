"""Workflows (Neil, Oct 28 2026): "when X happens, do Y" across every module.

    workflows.emit(db, "hr.time_off.decided", subject=row, actor=user["email"],
                   changes={"status": (old, new)}, extra={"note": body.note})

is the one line a module adds at its choke point; it writes the outbox row
inside the caller's transaction and never raises. `load_packs()` imports the
per-module registrations (workflows/packs/*). Nothing here imports `models`
at module level - database.py wires the record observer before `Base`
exists.

Spec: docs/superpowers/specs/2026-10-28-workflows-design.md
Plan: docs/superpowers/plans/2026-10-28-workflows.md
"""
from .catalog import load_packs
from .emit import CURRENT_RUN, emit, quiet

__all__ = ["emit", "load_packs", "CURRENT_RUN", "quiet"]
