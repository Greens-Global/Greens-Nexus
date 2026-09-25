"""Merge custom task statuses that share a label (Manage -> "Merge duplicate
statuses", POST /tasks/meta/custom-statuses/dedupe).

The duplicates were minted by the Asana sync, which seeded one status per
Asana project's own "Task Progress" option - so one "Waiting" and one
"Deferred" per synced project. The sync is gone (Sep 2026) but databases that
ran it can still carry the duplicates, so the repair stays. Moved here
unchanged from the removed asana_sync.py.
"""
import models


def _norm_status_label(label: str) -> str:
    return " ".join((label or "").split()).lower()


def status_option_gids(s) -> list:
    """Every Asana option gid a status fronted, newest schema first. Kept only
    so a merge carries them onto the surviving row (history, not behavior).

    asana_option_gid is the legacy single-value column and is still populated
    for the row's first option, so a database written before asana_option_gids
    existed keeps matching."""
    gids = [g for g in (getattr(s, "asana_option_gids", None) or []) if g]
    if s.asana_option_gid and s.asana_option_gid not in gids:
        gids.append(s.asana_option_gid)
    return gids


def dedupe_custom_statuses(db):
    """Collapse statuses that share a label onto one row.

    Task.status stores the status ID, so the merge MUST remap every task off the
    rows it deletes. Skipping that would leave those tasks pointing at a status
    that no longer exists, which renders as a raw uuid on the board and cannot be
    changed back from the UI. Does not commit."""
    rows = sorted(db.query(models.TaskCustomStatus).all(),
                  key=lambda s: (s.position or 0, s.id))
    groups = {}
    for s in rows:
        groups.setdefault(_norm_status_label(s.label), []).append(s)

    merged = remapped = 0
    for group in groups.values():
        if len(group) < 2:
            continue
        keep, dups = group[0], group[1:]
        scope = [p for p in (keep.project_ids or []) if p]
        gids = status_option_gids(keep)
        # A global row anywhere in the group makes the merged row global -
        # anything else would REMOVE the status from projects that had it.
        global_row = not scope
        for d in dups:
            d_scope = [p for p in (d.project_ids or []) if p]
            if not d_scope:
                global_row = True
            scope += [p for p in d_scope if p not in scope]
            gids += [g for g in status_option_gids(d) if g not in gids]
            remapped += (db.query(models.Task)
                         .filter(models.Task.status == d.id)
                         .update({"status": keep.id}, synchronize_session=False))
            db.delete(d)
            merged += 1
        keep.project_ids = [] if global_row else scope
        keep.asana_option_gids = gids
        if not keep.asana_option_gid and gids:
            keep.asana_option_gid = gids[0]
    return {"merged": merged, "tasksRemapped": remapped}
