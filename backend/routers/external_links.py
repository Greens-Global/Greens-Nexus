"""External Links - the company-wide app/link directory (rebuilt Aug 2026 from
the old start.greensglobal.com launchpad, which is company-wide, unstyled, and
department-scoped only by a raw dropdown). This owns models.ExternalLink end
to end.

NOTE for whoever touches backend/routers/assets.py next: that file still has a
leftover stub /external-links GET/POST/click trio from before this module was
built out. This router is the real implementation (full CRUD, department
scoping, ordering, audit trail) and registers its own routes - do not restore
the assets.py stub, and remove it there next time that file is touched (it is
Ankush's file, not this module's, so it's left alone here rather than edited
in place).

Read is baseline for every employee (App.jsx treats external-links as a
baseline module like sop). Managing entries (create/edit/delete/reorder)
requires manager+ globally OR an Access Group grant of "external-links" at
editor+ (full+ to delete), mirroring items.py's require_items_admin pattern.
"""
import asyncio
import html as html_lib
import ipaddress
import json
import os
import re
import socket
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

import models
from database import get_db
from auth import get_current_user, require_level_or_module

router = APIRouter(prefix="/external-links", tags=["External Links"], dependencies=[Depends(get_current_user)])

_ROLE_LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}
require_links_admin  = require_level_or_module(_ROLE_LEVEL["manager"],       "external-links", "editor")
require_links_delete = require_level_or_module(_ROLE_LEVEL["administrator"], "external-links", "full")


class ExternalLinkCreate(BaseModel):
    name: str
    url: str
    categories: list[str] = []  # at least one required - validated below, not by Pydantic, so the 422 detail can be specific
    description: str = ""
    departments: list[str] = []  # [] = shown to every department (company-wide)
    company: str = ""         # "" = shown to every company; else an HrEntity.id
    icon: str = "Link2"       # lucide-react icon key, resolved client-side
    is_pinned: bool = False


class ExternalLinkUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    categories: Optional[list[str]] = None
    description: Optional[str] = None
    departments: Optional[list[str]] = None
    company: Optional[str] = None
    icon: Optional[str] = None
    is_pinned: Optional[bool] = None


def _clean_list(values: list[str]) -> list[str]:
    """Trim, drop blanks, de-dupe while preserving order - shared by create
    and update so "  Banking , Banking" doesn't become two entries."""
    seen, out = set(), []
    for v in values:
        v = (v or "").strip()
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


class ReorderEntry(BaseModel):
    id: int
    sort_order: int


class ImportRow(BaseModel):
    name: str = ""
    url: str = ""
    categories: list[str] = []
    departments: list[str] = []
    company: str = ""
    description: str = ""
    icon: str = "Link2"
    is_pinned: bool = False


class ImportRequest(BaseModel):
    rows: list[ImportRow]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _audit(db: Session, user: dict, action: str, link: "models.ExternalLink", extra: dict | None = None):
    details = {"name": link.name, "url": link.url, "categories": link.categories, "departments": link.departments}
    if extra:
        details.update(extra)
    db.add(models.AuditLog(
        timestamp=_now(), user_email=user["email"], user_role=user.get("role", ""),
        action=action, resource_type="external_links", resource_id=str(link.id),
        details=json.dumps(details), ip_address="",
    ))


@router.get("")
def list_external_links(db: Session = Depends(get_db)):
    """Every employee can read the full directory - the department/category
    filtering is a client-side UX affordance, not an access boundary (these
    are just launch links, same as the old company-wide start page)."""
    return (
        db.query(models.ExternalLink)
        .order_by(models.ExternalLink.is_pinned.desc(), models.ExternalLink.sort_order.asc(), models.ExternalLink.name.asc())
        .all()
    )


@router.get("/meta")
def external_links_meta(db: Session = Depends(get_db)):
    """Distinct departments/categories currently in use, for the filter
    dropdowns - avoids a second hardcoded list drifting from real data. Each
    link can carry several of each now (Aug 14, "add multiple checkbox
    option in departments and category"), so this flattens every row's
    array client-side rather than a plain SQL DISTINCT (no portable way to
    dedupe across JSON array elements in one query across both engines)."""
    departments, categories = set(), set()
    for (d,) in db.query(models.ExternalLink.departments).all():
        departments.update(d or [])
    for (c,) in db.query(models.ExternalLink.categories).all():
        categories.update(c or [])
    return {"departments": sorted(departments), "categories": sorted(categories)}


# ── Taxonomy (admin-managed Department/Category picker options) ────────────

_TAXONOMY_KINDS = ("department", "category")


def _taxonomy_dict(row: "models.ExternalLinkTaxonomy") -> dict:
    return {"id": row.id, "kind": row.kind, "name": row.name}


@router.get("/taxonomy")
def list_taxonomy(db: Session = Depends(get_db)):
    """Every employee can read this (it only feeds picker/filter dropdowns,
    same posture as list_external_links above) - only add/rename/remove is
    admin-gated below."""
    rows = db.query(models.ExternalLinkTaxonomy).order_by(
        models.ExternalLinkTaxonomy.kind, models.ExternalLinkTaxonomy.sort_order, models.ExternalLinkTaxonomy.name
    ).all()
    return {
        "departments": [_taxonomy_dict(r) for r in rows if r.kind == "department"],
        "categories": [_taxonomy_dict(r) for r in rows if r.kind == "category"],
    }


class TaxonomyCreate(BaseModel):
    kind: str
    name: str


@router.post("/taxonomy")
def create_taxonomy(body: TaxonomyCreate, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    if body.kind not in _TAXONOMY_KINDS:
        raise HTTPException(status_code=422, detail="kind must be 'department' or 'category'.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name can't be empty.")
    if len(name) > 80:
        raise HTTPException(status_code=422, detail="Name must be 80 characters or fewer.")
    exists = db.query(models.ExternalLinkTaxonomy).filter(
        models.ExternalLinkTaxonomy.kind == body.kind, models.ExternalLinkTaxonomy.name == name).first()
    if exists:
        raise HTTPException(status_code=409, detail=f'"{name}" already exists.')
    max_pos = db.query(models.ExternalLinkTaxonomy).filter(models.ExternalLinkTaxonomy.kind == body.kind).count()
    row = models.ExternalLinkTaxonomy(
        id=str(uuid.uuid4()), kind=body.kind, name=name, sort_order=max_pos, created_at=_now())
    db.add(row)
    db.commit()
    return _taxonomy_dict(row)


class TaxonomyRename(BaseModel):
    name: str


@router.patch("/taxonomy/{taxonomy_id}")
def rename_taxonomy(taxonomy_id: str, body: TaxonomyRename, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Renaming bulk-updates every ExternalLink row currently tagged with
    the old string, in the same transaction - see ExternalLinkTaxonomy's
    docstring for why that matters (department/category aren't a FK)."""
    row = db.query(models.ExternalLinkTaxonomy).filter(models.ExternalLinkTaxonomy.id == taxonomy_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name can't be empty.")
    if len(name) > 80:
        raise HTTPException(status_code=422, detail="Name must be 80 characters or fewer.")
    dupe = db.query(models.ExternalLinkTaxonomy).filter(
        models.ExternalLinkTaxonomy.kind == row.kind, models.ExternalLinkTaxonomy.name == name,
        models.ExternalLinkTaxonomy.id != taxonomy_id).first()
    if dupe:
        raise HTTPException(status_code=409, detail=f'"{name}" already exists.')

    old_name = row.name
    row.name = name
    if old_name != name:
        # A link can hold several departments/categories now, so this can't
        # be a single portable SQL UPDATE (no cross-engine way to replace
        # one element inside a JSON array column) - fetch every row that has
        # the old name anywhere in its list and rewrite that one element in
        # Python instead.
        field_name = "departments" if row.kind == "department" else "categories"
        field = getattr(models.ExternalLink, field_name)
        candidates = db.query(models.ExternalLink).filter(field.isnot(None)).all()
        for link in candidates:
            values = getattr(link, field_name) or []
            if old_name in values:
                setattr(link, field_name, _clean_list([name if v == old_name else v for v in values]))
    db.commit()
    return _taxonomy_dict(row)


@router.delete("/taxonomy/{taxonomy_id}")
def delete_taxonomy(taxonomy_id: str, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Removes the option from the curated picker only - links already
    tagged with this name keep it (free text, same as Category always
    was), they just won't see it as a suggested/fixed choice going forward."""
    row = db.query(models.ExternalLinkTaxonomy).filter(models.ExternalLinkTaxonomy.id == taxonomy_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")
    db.delete(row)
    db.commit()
    return {"ok": True}


def _normalize_url(url: str) -> str:
    """Duplicate-link detection (Add Link / Add Personal Link, Aug 13) -
    collapses the differences that would otherwise let the same site get
    added twice (http vs https, www. vs not, a trailing slash, mixed case)
    without masking genuinely different pages on the same host. Mirrors
    normalizeUrl in ExternalLinks.jsx - keep both in sync. This is a
    server-side backstop behind the client-side check (which is what a user
    actually sees); it exists for the API path directly, not for UX."""
    try:
        parsed = urlparse(url if re.match(r"^https?://", url, re.I) else f"https://{url}")
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        path = parsed.path.rstrip("/")
        return f"{host}{path}"
    except ValueError:
        return url.strip().lower()


_META_DESC_RE = re.compile(
    r'<meta[^>]+(?:name|property)=["\'](?:description|og:description)["\'][^>]+content=["\']([^"\']*)["\']', re.I
)
_META_DESC_RE_REV = re.compile(
    r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:name|property)=["\'](?:description|og:description)["\']', re.I
)
_TITLE_RE = re.compile(r"<title[^>]*>([^<]*)</title>", re.I)


def _resolves_to_public_ip(hostname: str) -> bool:
    """SSRF guard for /preview below - an admin-supplied URL must not be able
    to make the backend fetch internal/private infrastructure (RFC1918,
    loopback, link-local incl. the 169.254.169.254 cloud metadata endpoint).
    ip.is_global is False for all of those."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return True


_CATEGORY_MODEL = "claude-haiku-4-5-20251001"  # cheap: one tiny classification call per Add Link
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
_MAX_CATEGORY_WORDS = 3
_MAX_CATEGORY_LEN = 30


def _classify_category(hostname: str, title: str, meta_description: str) -> str:
    """Neil, Aug 14: the auto-filled description was reading as a full
    marketing sentence pulled verbatim off the site ("F&M Bank is a local
    Southern California community bank with more than 100 years...") -
    wanted instead as a one-to-three-word category tag (Banking, AI Tool,
    Shopping Platform). No amount of truncating the meta description gets
    there - it needs an actual classification, not a substring - so this
    asks Claude Haiku for the short label instead of scraping one. Same
    call pattern as every other AI feature in this backend (raw httpx to
    the Anthropic Messages API, no SDK dependency - see construction_ai.py's
    docstring for why). Best-effort: returns "" on a missing key or any
    failure, same as the rest of this endpoint - this is a convenience
    prefill, never something that should block Add Link."""
    if not _ANTHROPIC_API_KEY:
        return ""
    context = f"Website: {hostname}"
    if title:
        context += f"\nPage title: {title}"
    if meta_description:
        context += f"\nMeta description: {meta_description[:400]}"
    try:
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": _ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": _CATEGORY_MODEL,
                "max_tokens": 20,
                "system": (
                    "You label a website with the single best short category for what kind of "
                    "application or tool it is. Reply with ONLY 1-3 words, no punctuation, no "
                    "explanation - just the category. Examples: Banking, AI Tool, Shopping Platform, "
                    "Video Streaming, Project Management, Team Chat, Cloud Storage, Payroll, "
                    "Expense Management, Social Media."
                ),
                "messages": [{"role": "user", "content": f"{context}\n\nShort category:"}],
            },
            timeout=8.0,
        )
        resp.raise_for_status()
        text = "".join(b.get("text", "") for b in resp.json().get("content", []) if b.get("type") == "text").strip()
    except (httpx.HTTPError, ValueError, KeyError):
        return ""
    # The model is asked for 1-3 words but is never trusted to actually stop
    # there - cap hard so a verbose reply can never regress back into a full
    # sentence, which is the exact thing this feature exists to avoid.
    words = text.strip(" .").split()
    return " ".join(words[:_MAX_CATEGORY_WORDS])[:_MAX_CATEGORY_LEN]


def _fetch_link_preview(url: str) -> dict:
    """Runs in a worker thread (see asyncio.to_thread in the route below) -
    this does blocking DNS + network I/O, which must never sit on the async
    event loop. Best-effort only: any failure (bad scheme, private IP, DNS
    failure, timeout, non-2xx, no meta description) returns {} rather than
    raising, since this is a convenience prefill for the Add Link modal, not
    something that should ever block or error out the save."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return {}
    if not _resolves_to_public_ip(parsed.hostname):
        return {}
    try:
        with httpx.Client(
            follow_redirects=True, timeout=6.0,
            headers={"User-Agent": "Mozilla/5.0 (compatible; NexusLinkPreview/1.0)"},
        ) as client:
            with client.stream("GET", url) as resp:
                final_host = urlparse(str(resp.url)).hostname
                if not final_host or not _resolves_to_public_ip(final_host):
                    return {}  # redirected off to a private host mid-request
                if resp.status_code >= 400:
                    return {}
                chunks, total = [], 0
                for chunk in resp.iter_text():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > 300_000:  # cap - only the <head> is needed
                        break
                page = "".join(chunks)
    except httpx.HTTPError:
        return {}
    desc_match = _META_DESC_RE.search(page) or _META_DESC_RE_REV.search(page)
    title_match = _TITLE_RE.search(page)
    meta_description = html_lib.unescape(desc_match.group(1)).strip() if desc_match else ""
    title = html_lib.unescape(title_match.group(1)).strip() if title_match else ""
    # No fallback to the raw meta description - a multi-sentence marketing
    # blurb is exactly what the 1-3 word category exists to replace (Aug 13:
    # "i said i want max 3 word description"). If classification is
    # unavailable (no ANTHROPIC_API_KEY configured, or the call failed),
    # leave the field blank rather than ever showing the long sentence -
    # blank is a safe, honest default the admin can fill in by hand.
    category = _classify_category(parsed.hostname, title, meta_description)
    return {"description": category[:300], "title": title[:120]}


@router.get("/preview")
async def preview_external_link(url: str, user: dict = Depends(get_current_user)):
    """Add Link modal auto-fill (Aug 13), used by both the Company Links Add
    Link modal (manager+) and the Personal Links Add modal (every employee -
    self-service, no admin gate). Any signed-in user is enough here: fetches
    the given URL server-side (a client-side fetch would be blocked by both
    CORS and CSP's connect-src, which has no reason to allowlist arbitrary
    third-party sites) and pulls its <meta name="description">/og:description
    to prefill the description field - see _resolves_to_public_ip for the
    SSRF guard, which is what actually needs to hold here since the URL is
    user-supplied. Always 200s with whatever it found, possibly {}."""
    return await asyncio.to_thread(_fetch_link_preview, url)


@router.post("", status_code=201)
def create_external_link(link: ExternalLinkCreate, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    target = _normalize_url(link.url)
    existing = next(
        (l for l in db.query(models.ExternalLink.name, models.ExternalLink.url).all() if _normalize_url(l.url) == target),
        None,
    )
    if existing:
        raise HTTPException(status_code=409, detail=f'This link is already added as "{existing.name}".')
    categories = _clean_list(link.categories)
    if not categories:
        raise HTTPException(status_code=422, detail="Pick at least one category.")
    departments = _clean_list(link.departments)
    now = _now()
    data = link.model_dump(exclude={"categories", "departments"})
    db_link = models.ExternalLink(
        **data, categories=categories, departments=departments,
        # Legacy singular columns kept in sync on write, best-effort, purely
        # so nothing that still reads them (there's nothing left in this
        # codebase that does, but the columns are NOT NULL on `category`)
        # sees a stale/empty value - first pick wins, same as any "primary"
        # tag would.
        category=categories[0], department=departments[0] if departments else "",
        created_by=user["email"], created_at=now, updated_at=now,
    )
    db.add(db_link)
    db.flush()
    _audit(db, user, "Created external link", db_link)
    db.commit()
    db.refresh(db_link)
    return db_link


@router.patch("/reorder")
def reorder_external_links(entries: list[ReorderEntry], user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Bulk drag-reorder within a category - one round trip instead of N PATCHes.
    MUST stay registered before PATCH /{link_id} below: Starlette matches
    routes in registration order, and /external-links/{link_id} would
    otherwise greedily match /external-links/reorder (link_id="reorder") and
    422 on the int parse before this route is ever tried."""
    by_id = {e.id: e.sort_order for e in entries}
    rows = db.query(models.ExternalLink).filter(models.ExternalLink.id.in_(by_id.keys())).all()
    for row in rows:
        row.sort_order = by_id[row.id]
    db.commit()
    return {"ok": True, "updated": len(rows)}


@router.patch("/{link_id}")
def update_external_link(link_id: int, patch: ExternalLinkUpdate, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    db_link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not db_link:
        raise HTTPException(status_code=404, detail="Link not found")
    changes = patch.model_dump(exclude_unset=True)
    if "categories" in changes:
        changes["categories"] = _clean_list(changes["categories"])
        if not changes["categories"]:
            raise HTTPException(status_code=422, detail="Pick at least one category.")
    if "departments" in changes:
        changes["departments"] = _clean_list(changes["departments"])
    for field, value in changes.items():
        setattr(db_link, field, value)
    # Legacy singular columns kept in sync - see create_external_link's
    # comment for why.
    if "categories" in changes:
        db_link.category = changes["categories"][0]
    if "departments" in changes:
        db_link.department = changes["departments"][0] if changes["departments"] else ""
    db_link.updated_at = _now()
    _audit(db, user, "Updated external link", db_link, {"changed_fields": list(changes.keys())})
    db.commit()
    db.refresh(db_link)
    return db_link


@router.post("/{link_id}/refresh-description")
async def refresh_link_description(link_id: int, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Re-runs the same auto-fill /preview uses against an EXISTING link's
    URL and persists the result to the row (Aug 14). The short-category
    autofill only ever applied going forward, to new Add Link submissions -
    a link added before that shipped, or via CSV import (which never set a
    description at all), keeps whatever it was originally saved with until
    someone explicitly asks for a refresh, here or via the bulk version
    below. Best-effort: if the fetch/classification comes back empty, the
    existing description is left alone rather than blanked out."""
    db_link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not db_link:
        raise HTTPException(status_code=404, detail="Link not found")
    preview = await asyncio.to_thread(_fetch_link_preview, db_link.url)
    if preview.get("description"):
        db_link.description = preview["description"]
        db_link.updated_at = _now()
        db.commit()
        db.refresh(db_link)
    return db_link


@router.post("/refresh-descriptions")
async def refresh_all_link_descriptions(user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Bulk version of the single-link refresh above - one pass over every
    Company Link, best-effort per row (a site that fails to fetch/classify
    just keeps its current description). Sequential, not parallel - this is
    an occasional admin action over a small directory, not a hot path worth
    the complexity of fanning the requests out concurrently."""
    links = db.query(models.ExternalLink).all()
    updated = 0
    for link in links:
        preview = await asyncio.to_thread(_fetch_link_preview, link.url)
        if preview.get("description") and preview["description"] != link.description:
            link.description = preview["description"]
            link.updated_at = _now()
            updated += 1
    db.commit()
    return {"updated": updated, "total": len(links)}


@router.delete("/{link_id}")
def delete_external_link(link_id: int, user: dict = Depends(require_links_delete), db: Session = Depends(get_db)):
    db_link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not db_link:
        raise HTTPException(status_code=404, detail="Link not found")
    _audit(db, user, "Deleted external link", db_link)
    db.delete(db_link)
    db.commit()
    return {"ok": True}


@router.patch("/{link_id}/click")
def increment_click(link_id: int, db: Session = Depends(get_db)):
    """Every employee can fire this (it's how "Most Used" ordering works) - no
    admin gate, just needs to be signed in."""
    link = db.query(models.ExternalLink).filter(models.ExternalLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    link.clicks += 1
    db.commit()
    db.refresh(link)
    return link


@router.post("/import")
def import_external_links(payload: ImportRequest, user: dict = Depends(require_links_admin), db: Session = Depends(get_db)):
    """Batch CSV import (Manage > Import) for standing up a department's
    directory in one paste instead of one Add Link modal at a time. Best-
    effort: valid rows are created, invalid ones are reported back by 1-based
    row number and skipped - a typo in row 12 shouldn't lose rows 1-11.

    Department/category arrive as arrays now (Aug 14, "select multiple
    department or category by selecting" - the import preview table picks
    these per row with the same checkbox dropdown as Add/Edit, not typed
    CSV text), same shape `update_external_link` takes. A row with no
    category defaults to "Imported" so it still groups with its siblings
    instead of failing import - icon is still left off the sheet on purpose
    (Neil, Aug 12): it has to match an internal key, not something to fill
    in by hand. `company` is typed as a company NAME (e.g. "Greens India"),
    not the HrEntity.id a human has no reason to know - resolved to the id
    here, case-insensitively; an unmatched name is left blank (company-wide)
    rather than failing the whole row."""
    now = _now()
    company_by_name = {e.name.strip().lower(): e.id for e in db.query(models.HrEntity).all()}
    created, errors = [], []
    for i, row in enumerate(payload.rows, start=1):
        name, url = row.name.strip(), row.url.strip()
        if not name or not url:
            errors.append({"row": i, "name": name or f"Row {i}", "reason": "Name and URL are required"})
            continue
        if not re.match(r"^https?://", url, re.I):
            url = f"https://{url}"
        categories = _clean_list(row.categories) or ["Imported"]
        departments = _clean_list(row.departments)
        db_link = models.ExternalLink(
            name=name, url=url, category=categories[0], description=row.description.strip(),
            department=departments[0] if departments else "", categories=categories, departments=departments,
            company=company_by_name.get(row.company.strip().lower(), ""),
            icon=row.icon or "Link2", is_pinned=row.is_pinned,
            created_by=user["email"], created_at=now, updated_at=now,
        )
        db.add(db_link)
        db.flush()
        created.append(db_link)
    if created:
        db.add(models.AuditLog(
            timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
            action="Bulk-imported external links", resource_type="external_links", resource_id="",
            details=json.dumps({"count": len(created), "names": [c.name for c in created]}), ip_address="",
        ))
    db.commit()
    for c in created:
        db.refresh(c)
    return {"created": created, "errors": errors}


# ─────────────────────────────────────────────────────────────────────────────
# Personal Links (Aug 12) - an employee's own day-to-day shortcuts, separate
# from the curated directory above. Private by construction: every query
# below filters on owner_email == the signed-in user, and update/delete
# additionally re-check ownership before touching a row - there is no
# manager/admin bypass, so even an owner-level account can't see or edit
# someone else's personal links through this API. No require_links_admin
# gate anywhere here on purpose: this is self-service, not a managed module.
# ─────────────────────────────────────────────────────────────────────────────
personal_router = APIRouter(prefix="/personal-links", tags=["Personal Links"], dependencies=[Depends(get_current_user)])


class PersonalLinkCreate(BaseModel):
    name: str
    url: str
    description: str = ""
    icon: str = "Link2"
    vault_cred_id: str = ""
    department: str = ""
    category: str = ""


class PersonalLinkUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    vault_cred_id: Optional[str] = None
    department: Optional[str] = None
    category: Optional[str] = None


class PersonalReorderEntry(BaseModel):
    id: int
    sort_order: int


def _own_personal_link(link_id: int, user: dict, db: Session) -> models.PersonalLink:
    link = (
        db.query(models.PersonalLink)
        .filter(models.PersonalLink.id == link_id, models.PersonalLink.owner_email == user["email"])
        .first()
    )
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    return link


@personal_router.get("")
def list_personal_links(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(models.PersonalLink)
        .filter(models.PersonalLink.owner_email == user["email"])
        .order_by(models.PersonalLink.sort_order.asc(), models.PersonalLink.name.asc())
        .all()
    )


def _owned_vault_cred_id(vault_cred_id: str, user: dict, db: Session) -> str:
    """Guards against pointing a link at someone else's (or a deleted)
    Credential Vault personal credential - id is client-supplied, so this is
    the only thing standing between a typo/tamper and reveal() being asked
    to decrypt a row that was never this user's. Silently drops an invalid
    id rather than 400ing the whole save; the link itself is still valid
    without a credential attached."""
    if not vault_cred_id:
        return ""
    owns = (
        db.query(models.VaultPersonalCredential.id)
        .filter(models.VaultPersonalCredential.id == vault_cred_id, models.VaultPersonalCredential.owner_email == user["email"])
        .first()
    )
    return vault_cred_id if owns else ""


@personal_router.post("", status_code=201)
def create_personal_link(link: PersonalLinkCreate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    target = _normalize_url(link.url)
    existing = next(
        (
            l for l in db.query(models.PersonalLink.name, models.PersonalLink.url)
            .filter(models.PersonalLink.owner_email == user["email"]).all()
            if _normalize_url(l.url) == target
        ),
        None,
    )
    if existing:
        raise HTTPException(status_code=409, detail=f'This is already in your Personal Links as "{existing.name}".')
    now = _now()
    data = link.model_dump()
    data["vault_cred_id"] = _owned_vault_cred_id(data.get("vault_cred_id", ""), user, db)
    db_link = models.PersonalLink(**data, owner_email=user["email"], created_at=now, updated_at=now)
    db.add(db_link)
    db.commit()
    db.refresh(db_link)
    return db_link


@personal_router.patch("/reorder")
def reorder_personal_links(entries: list[PersonalReorderEntry], user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """MUST stay registered before PATCH /{link_id} below - same route-order
    gotcha as the main reorder endpoint above (see its comment)."""
    by_id = {e.id: e.sort_order for e in entries}
    rows = (
        db.query(models.PersonalLink)
        .filter(models.PersonalLink.id.in_(by_id.keys()), models.PersonalLink.owner_email == user["email"])
        .all()
    )
    for row in rows:
        row.sort_order = by_id[row.id]
    db.commit()
    return {"ok": True, "updated": len(rows)}


@personal_router.patch("/{link_id}")
def update_personal_link(link_id: int, patch: PersonalLinkUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    db_link = _own_personal_link(link_id, user, db)
    changes = patch.model_dump(exclude_unset=True)
    if "vault_cred_id" in changes:
        changes["vault_cred_id"] = _owned_vault_cred_id(changes["vault_cred_id"] or "", user, db)
    for field, value in changes.items():
        setattr(db_link, field, value)
    db_link.updated_at = _now()
    db.commit()
    db.refresh(db_link)
    return db_link


@personal_router.delete("/{link_id}")
def delete_personal_link(link_id: int, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    db_link = _own_personal_link(link_id, user, db)
    db.delete(db_link)
    db.commit()
    return {"ok": True}


@personal_router.patch("/{link_id}/click")
def click_personal_link(link_id: int, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    db_link = _own_personal_link(link_id, user, db)
    db_link.clicks += 1
    db.commit()
    db.refresh(db_link)
    return db_link
