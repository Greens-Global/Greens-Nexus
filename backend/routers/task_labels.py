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
    return {
        "companyId": company,
        "companies": L.company_choices(db, user),
        "labels": L.get_map(db, company),
        "inUse": L.company_labels(db, company) if all_tasks else L.visible_labels(db, user, company),
        "tones": list(L.TONES),
        "canManage": is_manager(user),
    }


@router.get("")
def get_labels(company: str = "", all_tasks: bool = Query(False, alias="all"),
               user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """`inUse` lists only labels on tasks the caller can open - a restricted
    task's labels never reach anyone else. `all` (Manage) counts every task
    in the company and is a manager's view."""
    if all_tasks and not is_manager(user):
        raise HTTPException(401, "Insufficient permissions")
    cid = L.company_for(db, user, company)
    return _payload(db, user, cid, all_tasks=all_tasks)


@router.put("/color", dependencies=[Depends(require_manager)])
def set_color(body: ColorBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    cid = L.company_for(db, user, body.company or "")
    L.require_company(db, cid)
    name = L.check_name(body.name)
    color = (body.color or "").strip()
    if color and color not in L.TONES:
        raise HTTPException(422, "That color is not one of the label colors.")
    key = L.label_key(name)
    current = L.get_map(db, cid).get(key) or {}
    L.write_map(db, cid, {key: {"name": current.get("name") or name, "color": color}}, user["email"])
    db.commit()
    return _payload(db, user, cid, all_tasks=True)


@router.post("/rename", dependencies=[Depends(require_manager)])
def rename_label(body: RenameBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Rename a label on every task in the company. When the new name is a
    label already in use there (any spelling), the two MERGE: tasks carry the
    target once and keep its color; the target's own spelling wins. A pure
    rename keeps the color the label showed - its override, else the default
    the old name hashed to - so a rename never repaints a label."""
    cid = L.company_for(db, user, body.company or "")
    L.require_company(db, cid)
    old = L.check_name(body.name)
    new = L.check_name(body.to)
    old_key, new_key = L.label_key(old), L.label_key(new)
    labels = L.get_map(db, cid)
    in_use = {r["key"]: r for r in L.company_labels(db, cid)}
    if old_key not in in_use and old_key not in labels:
        raise HTTPException(404, "No label by that name.")
    entry_old = labels.get(old_key) or {}
    merged = new_key != old_key and (new_key in in_use or new_key in labels)
    if merged:
        target = labels.get(new_key) or {}
        new = target.get("name") or in_use[new_key]["name"]
        change = {old_key: None, new_key: {"name": new, "color": target.get("color") or ""}}
        if not target:
            change.pop(new_key)   # the target has no override: it keeps its default color
    elif new_key == old_key:
        # Only the spelling changes; the key, and so the default color, stay.
        change = {old_key: {"name": new, "color": entry_old.get("color") or ""}}
    else:
        change = {old_key: None,
                  new_key: {"name": new, "color": entry_old.get("color") or L.default_tone(old_key)}}
    changed = L.rewrite(db, cid, old_key, new, user["email"])
    L.write_map(db, cid, change, user["email"])
    db.commit()
    if changed:
        fire_task_event("", "bulk")
    return {**_payload(db, user, cid, all_tasks=True), "changed": changed, "merged": merged, "name": new}


@router.post("/delete", dependencies=[Depends(require_manager)])
def delete_label(body: DeleteBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take the label off every task in the company (restricted and trashed
    ones too) and forget its color."""
    cid = L.company_for(db, user, body.company or "")
    L.require_company(db, cid)
    key = L.label_key(L.check_name(body.name))
    changed = L.rewrite(db, cid, key, None, user["email"])
    L.write_map(db, cid, {key: None}, user["email"])
    db.commit()
    if changed:
        fire_task_event("", "bulk")
    return {**_payload(db, user, cid, all_tasks=True), "changed": changed}
