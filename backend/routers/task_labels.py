"""Task labels - the label map and Manage > Labels (Neil, Oct 22 2026).

  GET  /task-labels           the caller's company map + the labels in use on
                              tasks they can see (autocomplete, the Labels
                              filter); for Manage, `all=true` (managers) counts
                              every task in the company, restricted ones too
  PUT  /task-labels/color     recolor one label (manager)
  POST /task-labels/rename    rename one label; onto a name already in use, a
                              merge (manager)
  POST /task-labels/delete    take one label off every task (manager)

The checks are the custom statuses' (require_manager, with the module's
Tasks Owner lift) plus the company wall: behind it a manager reads and
changes only their own companies' maps (another company is a 404) and a
change always names one company. The logic lives in task_labels.py.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

import task_labels as L
from auth import get_current_user, module_owner_acts_as, require_any_module_grant, require_manager
from database import get_db
from routers.task_util import fire_task_event, is_manager

router = APIRouter(prefix="/task-labels", tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets")),
                                 Depends(module_owner_acts_as("tasks", 3))])


class ColorBody(BaseModel):
    name: str
    color: str = ""          # a tone key (task_labels.TONES); "" = back to the default
    company: Optional[str] = ""


class RenameBody(BaseModel):
    name: str
    to: str
    company: Optional[str] = ""


class DeleteBody(BaseModel):
    name: str
    company: Optional[str] = ""


def _payload(db: Session, user: dict, company: str, all_tasks: bool = False) -> dict:
    """The map, cut to labels the caller can see on a task (visible_map);
    Manage's `all` view has the whole map and the labels in use with their
    counts. The browser tallies what it needs for suggestions from the
    tasks it already holds."""
    out = {
        "companyId": company,
        "companies": L.company_choices(db, user),
        "labels": L.get_map(db, company) if all_tasks else L.visible_map(db, user, company),
        "tones": list(L.TONES),
        "canManage": is_manager(user),
    }
    if all_tasks:
        out["inUse"] = L.company_labels(db, company)
    return out


@router.get("")
def get_labels(company: str = "", all_tasks: bool = Query(False, alias="all"),
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """`labels` names only labels on tasks the caller can open - a restricted
    task's labels never reach anyone else. `all` (Manage) is a manager's
    view: the whole map and every label in use, with counts."""
    if all_tasks and not is_manager(user):
        raise HTTPException(401, "Insufficient permissions")
    cid = L.company_for(db, user, company)
    return _payload(db, user, cid, all_tasks=all_tasks)


@router.get("/impact", dependencies=[Depends(require_manager)])
def label_impact(name: str, company: str = "", user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """What a rename or delete of `name` would change - Manage's confirmation.
    `tasks` counts the Recycle Bin too; the rest is task_labels.carry_through
    (for a rename; `deleteRules` is what a delete would do to rules)."""
    cid = L.company_for(db, user, company)
    key = L.label_key(L.check_name(name))
    renamed = L.carry_through(db, cid, key, "-", dry_run=True)
    deleted = L.carry_through(db, cid, key, None, dry_run=True)
    return {**renamed, "tasks": L.task_count(db, cid, key), "companyId": cid,
            "deleteRules": {k: deleted[k] for k in ("automationRules", "rulesDisabled", "rulesStillNaming")}}


@router.put("/color", dependencies=[Depends(require_manager)])
def set_color(body: ColorBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    cid = L.company_for(db, user, body.company or "")
    L.require_company(db, cid)
    name = L.check_name(body.name)
    color = (body.color or "").strip()
    if color and color not in L.TONES:
        raise HTTPException(422, "That color is not one of the label colors.")
    key = L.label_key(name)
    row, current = L.lock_map(db, cid)
    entry = current.get(key) or {}
    L.apply_map(row, current, {key: {"name": entry.get("name") or name, "color": color}}, user["email"])
    db.commit()
    return _payload(db, user, cid, all_tasks=True)


@router.post("/rename", dependencies=[Depends(require_manager)])
def rename_label(body: RenameBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Rename a label on every task in the company, and everywhere the
    company names it (task_labels.carry_through). When the new name is a
    label already in use there (any spelling), the two MERGE: tasks carry the
    target once and keep its color; the target's own spelling wins. A pure
    rename keeps the color the label showed - its override, else the default
    the old name hashed to - so a rename never repaints a label.
    Locks the map row first and computes from it (task_labels lock order)."""
    cid = L.company_for(db, user, body.company or "")
    L.require_company(db, cid)
    old = L.check_name(body.name)
    new = L.check_name(body.to)
    old_key, new_key = L.label_key(old), L.label_key(new)
    row, labels = L.lock_map(db, cid)
    in_use = {r["key"]: r for r in L.company_labels(db, cid)}
    if old_key not in in_use and old_key not in labels and not L.task_count(db, cid, old_key):
        raise HTTPException(404, "No label by that name.")
    entry_old = labels.get(old_key) or {}
    merged = new_key != old_key and (new_key in in_use or new_key in labels)
    if merged:
        target = labels.get(new_key) or {}
        new = target.get("name") or in_use[new_key]["name"]
        change = {old_key: None}   # the target keeps its own color, or its default
    elif new_key == old_key:
        # Only the spelling changes; the key, and so the default color, stay.
        change = {old_key: {"name": new, "color": entry_old.get("color") or ""}}
    else:
        change = {old_key: None,
                  new_key: {"name": new, "color": entry_old.get("color") or L.default_tone(old_key)}}
    changed = L.rewrite(db, cid, old_key, new, user["email"])
    also = L.carry_through(db, cid, old_key, new)
    L.apply_map(row, labels, change, user["email"])
    db.commit()
    if changed:
        fire_task_event("", "bulk")
    return {**_payload(db, user, cid, all_tasks=True), "changed": changed, "merged": merged, "name": new,
            "also": also}


@router.post("/delete", dependencies=[Depends(require_manager)])
def delete_label(body: DeleteBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take the label off every task in the company (restricted and trashed
    ones too), out of the company's Add Tag actions and saved views'
    filters, and forget its color. Rules that only test for it are left
    and counted (`also.rulesStillNaming`)."""
    cid = L.company_for(db, user, body.company or "")
    L.require_company(db, cid)
    key = L.label_key(L.check_name(body.name))
    row, labels = L.lock_map(db, cid)
    changed = L.rewrite(db, cid, key, None, user["email"])
    also = L.carry_through(db, cid, key, None)
    L.apply_map(row, labels, {key: None}, user["email"])
    db.commit()
    if changed:
        fire_task_event("", "bulk")
    return {**_payload(db, user, cid, all_tasks=True), "changed": changed, "also": also}
