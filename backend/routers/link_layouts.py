"""Link Layout - per-user personalization overlay for the External Links
module (app ordering, custom folders, favorites). Separate from
external_links.py on purpose: that file owns the shared company directory
and private Personal Links; this one owns how ONE user chooses to arrange
all of it, a different concern with a much higher-frequency, auto-saved
write pattern. Self-service only, no admin gate - every read/write is scoped
to owner_email, mirroring PersonalLink's posture (models.py's
UserLinkLayout docstring has the full data-shape rationale).

Nothing here grants access to a link a user couldn't already see - External
Links is a baseline module every employee reads in full (see
external_links.py's own docstring), so this only reorders/groups/favorites
what's already visible; it never widens what's visible.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import models
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/link-layout", tags=["Link Layout"], dependencies=[Depends(get_current_user)])

MAX_FOLDER_NAME_LEN = 60


class LayoutFolder(BaseModel):
    id: str
    name: str
    position: int = 0


class LayoutItem(BaseModel):
    item_type: str  # "external" | "personal"
    item_id: int
    folder_id: Optional[str] = None
    position: int = 0
    dashboard: bool = False


class LayoutFavorite(BaseModel):
    item_type: str
    item_id: int


class LayoutIn(BaseModel):
    folders: list[LayoutFolder] = Field(default_factory=list)
    items: list[LayoutItem] = Field(default_factory=list)
    favorites: list[LayoutFavorite] = Field(default_factory=list)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _live_ids(user: dict, db: Session) -> tuple[set, set]:
    """(live ExternalLink ids, this user's live PersonalLink ids) - the
    source of truth both the GET self-heal and the PUT validation check
    against, fetched fresh every call (never trusted from the client, never
    cached) since it stands in for "does this still exist, and is this user
    still allowed to reference it."""
    external_ids = {i for (i,) in db.query(models.ExternalLink.id).all()}
    personal_ids = {
        i for (i,) in db.query(models.PersonalLink.id)
        .filter(models.PersonalLink.owner_email == user["email"]).all()
    }
    return external_ids, personal_ids


def _clean_and_merge(layout: dict, external_ids: set, personal_ids: set, db: Session) -> tuple[dict, bool]:
    """Drops any items/favorites entry that no longer exists (a deleted
    Company Link, or a Personal Link the user removed elsewhere) and appends
    any live Company Link not yet present as a new top-level (ungrouped)
    item, in the same order the default company view already uses - a newly
    added mandatory link must surface without the system guessing which
    folder (if any) it belongs in; the user drags it in themselves. Returns
    (possibly-changed layout, changed) so the caller only writes back to the
    DB when something actually moved - a GET on an already-clean layout is a
    pure read.

    Personal Links never go into `items` (ordering/folders) - only Company
    Links do (Neil, Aug 13: Personal Links must stay visible only in their
    own tab, never mixed into the shared launcher). They CAN still appear in
    `favorites` - that's the one place Personal Links were already meant to
    surface outside their own tab (the My Favorites strip), untouched here.
    `_alive_item` intentionally excludes item_type == "personal" so an
    existing row from before this rule (the brief window where Personal
    Links did get merged into items) self-heals back out on the next read."""
    folder_ids = {f["id"] for f in layout.get("folders", [])}

    def _alive_item(entry: dict) -> bool:
        return entry["item_type"] == "external" and entry["item_id"] in external_ids

    def _alive_fav(entry: dict) -> bool:
        ids = external_ids if entry["item_type"] == "external" else personal_ids
        return entry["item_id"] in ids

    orig_items = layout.get("items", [])
    orig_favorites = layout.get("favorites", [])
    items = [
        i for i in orig_items
        if _alive_item(i) and (i.get("folder_id") is None or i.get("folder_id") in folder_ids)
    ]
    favorites = [f for f in orig_favorites if _alive_fav(f)]
    changed = len(items) != len(orig_items) or len(favorites) != len(orig_favorites)

    top_level_positions = [i["position"] for i in items if i.get("folder_id") is None]
    next_pos = (max(top_level_positions) + 1) if top_level_positions else 0

    known_external = {i["item_id"] for i in items if i["item_type"] == "external"}
    new_external_ids = external_ids - known_external
    if new_external_ids:
        new_rows = (
            db.query(models.ExternalLink)
            .filter(models.ExternalLink.id.in_(new_external_ids))
            .order_by(models.ExternalLink.is_pinned.desc(), models.ExternalLink.sort_order.asc(), models.ExternalLink.name.asc())
            .all()
        )
        for row in new_rows:
            items.append({"item_type": "external", "item_id": row.id, "folder_id": None, "position": next_pos, "dashboard": False})
            next_pos += 1
        changed = True

    return {"folders": layout.get("folders", []), "items": items, "favorites": favorites}, changed


def _get_row(user: dict, db: Session) -> Optional[models.UserLinkLayout]:
    return db.query(models.UserLinkLayout).filter(models.UserLinkLayout.owner_email == user["email"]).first()


@router.get("")
def get_link_layout(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    external_ids, personal_ids = _live_ids(user, db)
    row = _get_row(user, db)
    if not row:
        return {"folders": [], "items": [], "favorites": [], "is_customized": False}

    healed, changed = _clean_and_merge(row.layout or {}, external_ids, personal_ids, db)
    if changed:
        row.layout = healed
        row.updated_at = _now()
        db.commit()
    return {**healed, "is_customized": True}


@router.put("")
def save_link_layout(body: LayoutIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    external_ids, personal_ids = _live_ids(user, db)
    folder_ids = {f.id for f in body.folders}

    for f in body.folders:
        name = f.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Folder name can't be empty.")
        if len(name) > MAX_FOLDER_NAME_LEN:
            raise HTTPException(status_code=422, detail=f"Folder name must be {MAX_FOLDER_NAME_LEN} characters or fewer.")
        f.name = name

    def _alive(item_type: str, item_id: int) -> bool:
        return item_id in (external_ids if item_type == "external" else personal_ids)

    # Strip rather than 500 - a stale tab submitting a since-deleted link or
    # folder id is a normal occurrence (another tab, another device, an
    # admin deleting a Company Link mid-session), not a client error.
    # item_type == "personal" is also stripped from `items` specifically -
    # Personal Links must stay visible only in their own tab, never ordered/
    # foldered into the shared launcher (Neil, Aug 13) - favorites are the
    # one exception, unaffected below.
    items = [
        i.model_dump() for i in body.items
        if i.item_type == "external" and _alive(i.item_type, i.item_id) and (i.folder_id is None or i.folder_id in folder_ids)
    ]
    favorites = [f.model_dump() for f in body.favorites if _alive(f.item_type, f.item_id)]
    folders = [f.model_dump() for f in body.folders]

    now = _now()
    row = _get_row(user, db)
    if row:
        row.layout = {"folders": folders, "items": items, "favorites": favorites}
        row.updated_at = now
    else:
        row = models.UserLinkLayout(
            id=str(uuid.uuid4()), owner_email=user["email"],
            layout={"folders": folders, "items": items, "favorites": favorites},
            created_at=now, updated_at=now,
        )
        db.add(row)
    db.commit()
    return {"folders": folders, "items": items, "favorites": favorites, "is_customized": True}
