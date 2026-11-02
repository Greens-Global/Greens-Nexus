"""A workflow's silhouette (Blueprint canvas, 10/30/2026).

The Workflows list and the Templates gallery draw each workflow as a small
thumbnail of its canvas shape. The list never carries whole definitions, so
a row gets this compact `shape` instead: a lane is a list; each step is
``[kind]`` or ``[kind, [lane, ...]]`` for the kinds that hold lanes - ``if``
(then, else), ``approval`` (one lane per option, in order, then the
If Nobody Answers lane) and ``for_each`` (one). Only kinds travel: no
titles, no params, no recipients, so a row leaks nothing a viewer may not
read. The frontend mirrors this grammar in
``frontend/src/workflows/canvas/shape.js`` - change both together.
"""
from __future__ import annotations

DEFAULT_OPTIONS = ["Approve", "Decline"]
KINDS = ("action", "if", "approval", "wait", "for_each", "stop")


def _lane(steps) -> list:
    out = []
    for s in steps if isinstance(steps, list) else []:
        if not isinstance(s, dict):
            continue
        kind = str(s.get("kind") or "action")
        if kind not in KINDS:
            kind = "action"
        if kind == "if":
            out.append([kind, [_lane(s.get("then")), _lane(s.get("else"))]])
        elif kind == "approval":
            params = s.get("params") if isinstance(s.get("params"), dict) else {}
            options = params.get("options") if isinstance(params.get("options"), list) and params.get("options") else DEFAULT_OPTIONS
            branches = s.get("branches") if isinstance(s.get("branches"), dict) else {}
            lanes = [_lane(branches.get(str(o))) for o in options] + [_lane(branches.get("expired"))]
            out.append([kind, lanes])
        elif kind == "for_each":
            out.append([kind, [_lane(s.get("steps"))]])
        else:
            out.append([kind])
    return out


def shape_of(definition) -> list:
    """The root lane's shape; ``[]`` for a workflow with no steps yet."""
    d = definition if isinstance(definition, dict) else {}
    return _lane(d.get("steps"))
