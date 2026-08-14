"""Link Layout - per-user personalization overlay for the External Links
module (app ordering, custom folders, favorites) - for BOTH the shared
Company Links directory and the user's own Personal Links. Separate from
external_links.py on purpose: that file owns the shared company directory
and private Personal Links; this one owns how ONE user chooses to arrange
all of it, a different concern with a much higher-frequency write pattern.
Self-service only, no admin gate - every read/write is scoped to
owner_email, mirroring PersonalLink's posture (models.py's LinkLayoutView
docstring has the full data-shape rationale).

Nothing here grants access to a link a user couldn't already see - External
Links is a baseline module every employee reads in full, and Personal Links
are already scoped to owner_email at the source (external_links.py's own
docstring) - so this only reorders/groups/favorites what's already visible;
it never widens what's visible.

Company and Personal folders/items live in the SAME layout document (one
`LinkLayoutView` row per saved arrangement) but are kept from ever mixing
in the UI by `item_type` on every item and folder: a Company folder only
ever holds `item_type: "external"` items, a Personal folder only ever holds
`item_type: "personal"` items (Aug 14 - "add folders to personal links
too"). The frontend enforces this at construction time (a folder is only
ever created from within one tab or the other); this file enforces it
defensively on every write so a stale/malformed client payload can't cross
the two.

Multi-view (Aug 14, "same option as we have in dashboard section...
default view and add customize views... save it per our convenient name")
mirrors routers/dashboards.py's personal-view CRUD (`/dashboards/views`)
almost exactly - same shape, same is_default single-winner semantics -
minus the department/scope/target machinery that module needed and this
doesn't. `/link-layout` (no id) keeps operating on "the" DEFAULT view for
backward compatibility with every existing call site, auto-creating one on
first write exactly like the old single-row model did; `/link-layout/views`
is the new multi-view management surface the frontend's view switcher
talks to."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import models
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/link-layout", tags=["Link Layout"], dependencies=[Depends(get_current_user)])

MAX_FOLDER_NAME_LEN = 60
MAX_VIEW_NAME_LEN = 80
ITEM_TYPES = ("external", "personal")
EMPTY_FILTERS = {"department": "", "company": "", "category": ""}
EMPTY_DOC = {"folders": [], "items": [], "favorites": [], "filters": dict(EMPTY_FILTERS)}


class LayoutFolder(BaseModel):
    id: str
    name: str
    position: int = 0
    item_type: str = "external"  # "external" | "personal" - which tab this folder belongs to


class LayoutItem(BaseModel):
    item_type: str  # "external" | "personal"
    item_id: int
    folder_id: Optional[str] = None
    position: int = 0
    dashboard: bool = False


class LayoutFavorite(BaseModel):
    item_type: str
    item_id: int


class LayoutFilters(BaseModel):
    """Department/Company/Category filter selections captured into a saved
    view (Aug 14 - "when i am making a customize view, i should also be
    able to include department, company and category in that view").
    Free text, same as the fields they mirror on ExternalLink - not
    validated against the taxonomy table, so a since-renamed/removed
    department or category just quietly matches nothing instead of erroring."""
    department: str = ""
    company: str = ""
    category: str = ""


class LayoutIn(BaseModel):
    folders: list[LayoutFolder] = Field(default_factory=list)
    items: list[LayoutItem] = Field(default_factory=list)
    favorites: list[LayoutFavorite] = Field(default_factory=list)
    filters: LayoutFilters = Field(default_factory=LayoutFilters)


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

    Personal Links get no equivalent auto-merge - there's no admin-set
    default order to append them in (Company Links have sort_order/
    is_pinned; Personal Links don't need one since the owner already put
    them there themselves), so the frontend synthesizes a pristine Personal
    default (sort_order, then name) purely client-side for Home, and only
    writes a real Personal item here once the user actually customizes.

    A folder's own `item_type` also gates which items can end up inside it -
    an item is only kept in its folder if the folder's type still matches
    the item's own type (a defensive check; the frontend never produces a
    mismatch, but a stale/malformed client shouldn't be able to cross Company
    and Personal folders by resubmitting an old payload)."""
    folders = layout.get("folders", [])
    folder_type = {f["id"]: f.get("item_type", "external") for f in folders}

    def _alive_item(entry: dict) -> bool:
        item_type = entry.get("item_type")
        if item_type not in ITEM_TYPES:
            return False
        ids = external_ids if item_type == "external" else personal_ids
        if entry["item_id"] not in ids:
            return False
        folder_id = entry.get("folder_id")
        if folder_id is not None and folder_type.get(folder_id, item_type) != item_type:
            return False
        return True

    def _alive_fav(entry: dict) -> bool:
        ids = external_ids if entry["item_type"] == "external" else personal_ids
        return entry["item_id"] in ids

    orig_items = layout.get("items", [])
    orig_favorites = layout.get("favorites", [])
    items = [
        i for i in orig_items
        if _alive_item(i) and (i.get("folder_id") is None or i.get("folder_id") in folder_type)
    ]
    favorites = [f for f in orig_favorites if _alive_fav(f)]
    changed = len(items) != len(orig_items) or len(favorites) != len(orig_favorites)

    top_level_positions = [i["position"] for i in items if i.get("folder_id") is None and i["item_type"] == "external"]
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

    filters = {**EMPTY_FILTERS, **(layout.get("filters") or {})}
    return {"folders": folders, "items": items, "favorites": favorites, "filters": filters}, changed


def _validate_and_clean(body: LayoutIn, external_ids: set, personal_ids: set) -> dict:
    """Shared write-side validation for both the legacy bare endpoint and
    the new /views endpoints - strips rather than 500s on a stale/dead
    reference (another tab, another device, an admin deleting a Company
    Link mid-session is a normal occurrence, not a client error)."""
    for f in body.folders:
        name = f.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Folder name can't be empty.")
        if len(name) > MAX_FOLDER_NAME_LEN:
            raise HTTPException(status_code=422, detail=f"Folder name must be {MAX_FOLDER_NAME_LEN} characters or fewer.")
        f.name = name
        if f.item_type not in ITEM_TYPES:
            f.item_type = "external"

    folder_type = {f.id: f.item_type for f in body.folders}

    def _alive(item_type: str, item_id: int) -> bool:
        return item_type in ITEM_TYPES and item_id in (external_ids if item_type == "external" else personal_ids)

    items = [
        i.model_dump() for i in body.items
        if _alive(i.item_type, i.item_id)
        and (i.folder_id is None or folder_type.get(i.folder_id) == i.item_type)
    ]
    favorites = [f.model_dump() for f in body.favorites if _alive(f.item_type, f.item_id)]
    folders = [f.model_dump() for f in body.folders]
    return {"folders": folders, "items": items, "favorites": favorites, "filters": body.filters.model_dump()}


# ── Legacy migration ─────────────────────────────────────────────────────────

def _migrate_legacy_row(user: dict, db: Session) -> None:
    """One-time, lazy copy of the old single-row UserLinkLayout into a new
    LinkLayoutView named "My view" and marked default - runs the first time
    a user with pre-multi-view data hits any view-aware endpoint after this
    shipped. The old row is left in place untouched (never deleted, never
    written back to) rather than migrated destructively - see
    LinkLayoutView's docstring in models.py for why altering the old
    table's schema/constraints was avoided instead."""
    already = db.query(models.LinkLayoutView.id).filter(models.LinkLayoutView.owner_email == user["email"]).first()
    if already:
        return
    legacy = db.query(models.UserLinkLayout).filter(models.UserLinkLayout.owner_email == user["email"]).first()
    if not legacy:
        return
    legacy_layout = legacy.layout or {}
    if not legacy_layout.get("items") and not legacy_layout.get("folders") and not legacy_layout.get("favorites"):
        return
    now = _now()
    db.add(models.LinkLayoutView(
        id=str(uuid.uuid4()), owner_email=user["email"], name="My view",
        layout=legacy.layout or dict(EMPTY_DOC), is_default=True,
        created_at=legacy.created_at or now, updated_at=now,
    ))
    db.commit()


# ── Views (multi-view management) ───────────────────────────────────────────

def _view_dict(v: models.LinkLayoutView) -> dict:
    return {
        "id": v.id, "name": v.name, "layout": v.layout or dict(EMPTY_DOC),
        "isDefault": bool(v.is_default), "updatedAt": v.updated_at or "",
    }


@router.get("/views")
def list_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _migrate_legacy_row(user, db)
    external_ids, personal_ids = _live_ids(user, db)
    rows = db.query(models.LinkLayoutView).filter(models.LinkLayoutView.owner_email == user["email"]) \
        .order_by(models.LinkLayoutView.created_at).all()
    out = []
    for v in rows:
        healed, changed = _clean_and_merge(v.layout or dict(EMPTY_DOC), external_ids, personal_ids, db)
        if changed:
            v.layout = healed
            v.updated_at = _now()
        out.append(_view_dict(v))
    db.commit()
    return {"views": out}


class ViewIn(BaseModel):
    name: str = "My view"
    layout: LayoutIn = Field(default_factory=LayoutIn)
    is_default: Optional[bool] = False


def _clear_defaults(db: Session, owner_email: str):
    for row in db.query(models.LinkLayoutView).filter(
            models.LinkLayoutView.owner_email == owner_email,
            models.LinkLayoutView.is_default.is_(True)).all():
        row.is_default = False


@router.post("/views")
def create_view(body: ViewIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    external_ids, personal_ids = _live_ids(user, db)
    doc = _validate_and_clean(body.layout, external_ids, personal_ids)
    now = _now()
    v = models.LinkLayoutView(
        id=str(uuid.uuid4()), owner_email=user["email"], name=(body.name or "My view")[:MAX_VIEW_NAME_LEN],
        layout=doc, is_default=bool(body.is_default), created_at=now, updated_at=now,
    )
    if v.is_default:
        _clear_defaults(db, user["email"])
    db.add(v)
    db.commit()
    return _view_dict(v)


class ViewUpdate(BaseModel):
    name: Optional[str] = None
    layout: Optional[LayoutIn] = None
    is_default: Optional[bool] = None


def _own_view(view_id: str, user: dict, db: Session) -> models.LinkLayoutView:
    v = db.query(models.LinkLayoutView).filter(
        models.LinkLayoutView.id == view_id, models.LinkLayoutView.owner_email == user["email"]).first()
    if not v:
        raise HTTPException(status_code=404, detail="View not found")
    return v


@router.put("/views/{view_id}")
def update_view(view_id: str, body: ViewUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = _own_view(view_id, user, db)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="View name can't be empty.")
        v.name = name[:MAX_VIEW_NAME_LEN]
    if body.layout is not None:
        external_ids, personal_ids = _live_ids(user, db)
        v.layout = _validate_and_clean(body.layout, external_ids, personal_ids)
    if body.is_default is not None:
        if body.is_default:
            _clear_defaults(db, user["email"])
        v.is_default = bool(body.is_default)
    v.updated_at = _now()
    db.commit()
    return _view_dict(v)


@router.put("/views/{view_id}/default")
def set_default_view(view_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = _own_view(view_id, user, db)
    _clear_defaults(db, user["email"])
    v.is_default = True
    v.updated_at = _now()
    db.commit()
    return {"ok": True}


@router.delete("/views/{view_id}")
def delete_view(view_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    v = _own_view(view_id, user, db)
    db.delete(v)
    db.commit()
    return {"ok": True}


# ── Legacy bare endpoints - "the" default view, for backward compatibility ──
# Every existing call site (useLinkLayout.js) still talks to these; they now
# resolve to whichever LinkLayoutView is_default, auto-creating one (named
# "My view") on the first write exactly like the old single-row model did.
# ?view=<id> lets a caller target a SPECIFIC view instead - the frontend's
# edit-mode Save uses this to write into whatever view is currently active,
# not necessarily the default one.

def _resolve_view(user: dict, db: Session, view_id: Optional[str]) -> Optional[models.LinkLayoutView]:
    if view_id:
        return _own_view(view_id, user, db)
    return db.query(models.LinkLayoutView).filter(
        models.LinkLayoutView.owner_email == user["email"], models.LinkLayoutView.is_default.is_(True)).first()


@router.get("")
def get_link_layout(view: Optional[str] = Query(None), user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _migrate_legacy_row(user, db)
    external_ids, personal_ids = _live_ids(user, db)
    row = _resolve_view(user, db, view)
    if not row:
        return {**EMPTY_DOC, "is_customized": False}

    healed, changed = _clean_and_merge(row.layout or dict(EMPTY_DOC), external_ids, personal_ids, db)
    if changed:
        row.layout = healed
        row.updated_at = _now()
        db.commit()
    return {**healed, "is_customized": True}


@router.put("")
def save_link_layout(body: LayoutIn, view: Optional[str] = Query(None), user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    external_ids, personal_ids = _live_ids(user, db)
    doc = _validate_and_clean(body, external_ids, personal_ids)

    row = _resolve_view(user, db, view)
    now = _now()
    if row:
        row.layout = doc
        row.updated_at = now
    else:
        row = models.LinkLayoutView(
            id=str(uuid.uuid4()), owner_email=user["email"], name="My view",
            layout=doc, is_default=(view is None), created_at=now, updated_at=now,
        )
        db.add(row)
    db.commit()
    return {**doc, "is_customized": True}


@router.delete("")
def reset_link_layout(
    view: Optional[str] = Query(None),
    scope: Optional[str] = Query(None, description="'external' or 'personal' - resets only that tab's folders/items/favorites. Omit to reset everything."),
    user: dict = Depends(get_current_user), db: Session = Depends(get_db),
):
    """Restore Default Layout - unscoped, removes the resolved view's row
    entirely so the next GET falls back to the synthesized default, exactly
    like a brand-new user who's never customized. Idempotent: 200s whether
    or not a row existed, since "no customization" is the desired end state
    either way, not an error.

    Scoped ("add folders to personal links too") - resetting Company Links
    shouldn't blow away a Personal Links arrangement sitting in the same
    view, or vice versa, so `scope` strips only that item_type's folders/
    items/favorites and keeps the row (deleting it only if nothing of
    either type is left)."""
    row = _resolve_view(user, db, view)
    if not row:
        return {**EMPTY_DOC, "is_customized": False}

    if scope not in (None, *ITEM_TYPES):
        raise HTTPException(status_code=422, detail="scope must be 'external' or 'personal'.")

    if scope is None:
        db.delete(row)
        db.commit()
        return {**EMPTY_DOC, "is_customized": False}

    layout = row.layout or dict(EMPTY_DOC)
    folders = [f for f in layout.get("folders", []) if f.get("item_type", "external") != scope]
    items = [i for i in layout.get("items", []) if i.get("item_type") != scope]
    favorites = [f for f in layout.get("favorites", []) if f.get("item_type") != scope]

    if not folders and not items and not favorites:
        db.delete(row)
        db.commit()
        return {**EMPTY_DOC, "is_customized": False}

    row.layout = {"folders": folders, "items": items, "favorites": favorites, "filters": {**EMPTY_FILTERS, **(layout.get("filters") or {})}}
    row.updated_at = _now()
    db.commit()
    return {**row.layout, "is_customized": True}
