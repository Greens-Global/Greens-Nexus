"""Egnyte client - the ONE path in and out of Egnyte.

Owner goal (Neil, Jul 2026): "they can upload and pull directly and at the right
folder level." Egnyte stays the source of truth; Nexus never re-uploads content
into Supabase and never keeps a second copy. So this module is deliberately a
thin, complete verb set over Egnyte's public API rather than a sync engine:
list / read / write / mkdir / search / link.

WHY THIS FILE EXISTS AT ALL. The browse+fetch pair used to live inline in
routers/documents.py, scoped to one job (importing a doc into the DMS). The Asana
lesson in CLAUDE.md is explicit - a second inbound path silently carries less
than the first and the two drift. Rather than add a parallel client for the Asset
module, the Documents endpoints now call THIS module, so every caller shares one
implementation of auth, path normalisation and error handling. Add capability
here; do not add a second client.

CONFIG. EGNYTE_DOMAIN + EGNYTE_TOKEN. Unconfigured is a first-class state:
`configured()` is False and callers return 503 rather than raising - the module
must render (empty, explained) before the key exists.
"""
from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx

# Egnyte's public API. fs = metadata, fs-content = bytes.
_FS = "/pubapi/v1/fs"
_FS_CONTENT = "/pubapi/v1/fs-content"
_SEARCH = "/pubapi/v1/search"

TIMEOUT_META = 20
TIMEOUT_BYTES = 120          # as-builts and scans are large; 60 was tight


class EgnyteError(RuntimeError):
    """Egnyte answered, but not with success. Carries the upstream status so the
    router can map 404 -> 404 instead of flattening everything to 502."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(os.getenv("EGNYTE_DOMAIN", "").strip() and os.getenv("EGNYTE_TOKEN", "").strip())


def _auth() -> tuple[str, dict[str, str]]:
    """Returns (base_url, headers). EGNYTE_DOMAIN normally holds a bare domain
    (e.g. cloud.greensglobal.com, or `greensglobal` which gets .egnyte.com
    appended) and always resolves to https://. An explicit http:// or https://
    prefix is honored as-is - that only matters for pointing at a local mock
    during testing; no real deployment sets it that way."""
    dom = os.getenv("EGNYTE_DOMAIN", "").strip().rstrip("/")
    if dom.startswith(("http://", "https://")):
        base_url = dom
    else:
        if "." not in dom:
            dom = f"{dom}.egnyte.com"
        base_url = f"https://{dom}"
    return base_url, {"Authorization": f"Bearer {os.getenv('EGNYTE_TOKEN', '').strip()}"}


def norm(path: str) -> str:
    """Egnyte paths are absolute and slash-prefixed. Normalising in ONE place
    keeps '', 'Shared/x', '/Shared/x' and 'Shared/x/' all meaning the same
    folder - callers pass whatever the UI gave them."""
    p = (path or "").strip().replace("\\", "/")
    while "//" in p:
        p = p.replace("//", "/")
    p = "/" + p.strip("/")
    return p


def _url_path(path: str) -> str:
    """Percent-encode a normalised path for use in a URL.

    REQUIRED, not cosmetic: folder names here contain '#' (#Entities, #Reports,
    #Unsorted, #Needs Classification, #Inactive). Concatenating those into a URL
    string makes httpx read the '#' as a FRAGMENT delimiter and silently drop the
    rest - so /Shared/#Entities was requested as /Shared and Egnyte cheerfully
    returned the parent, which looked like "the folder won't open". safe="/"
    keeps separators intact while encoding '#', '?', spaces and the rest."""
    return quote(norm(path), safe="/")


def _raise(resp: httpx.Response, what: str) -> None:
    if resp.is_success:
        return
    # Preserve 404/403 so the caller can distinguish "no such folder" (expected
    # for a property with no Egnyte folder yet) from "Egnyte is broken".
    status = resp.status_code if resp.status_code in (401, 403, 404, 409) else 502
    raise EgnyteError(f"{what}: {resp.text[:200]}", status)


# ── read ─────────────────────────────────────────────────────────────────────

def list_folder(path: str = "") -> dict[str, Any]:
    """Folder listing. Returns folders + files with the fields the UI needs."""
    base, headers = _auth()
    target = norm(path)
    resp = httpx.get(f"{base}{_FS}{_url_path(target)}", headers=headers, timeout=TIMEOUT_META)
    _raise(resp, "Could not browse Egnyte")
    data = resp.json()
    return {
        "path": data.get("path", target),
        "folders": [
            {"name": f.get("name", ""), "path": f.get("path", "")}
            for f in (data.get("folders") or [])
        ],
        "files": [
            {
                "name": f.get("name", ""),
                "path": f.get("path", ""),
                "size": f.get("size", 0),
                "entryId": f.get("entry_id", ""),
                "modified": f.get("last_modified", ""),
                "uploadedBy": f.get("uploaded_by", ""),
            }
            for f in (data.get("files") or [])
        ],
    }


def read_file(path: str) -> bytes:
    """Raw bytes. Deliberately NOT extension-filtered - that is a per-caller
    policy (the DMS importer only accepts docx/pdf/txt; a property Documents tab
    must show and download whatever is actually in the folder)."""
    base, headers = _auth()
    resp = httpx.get(f"{base}{_FS_CONTENT}{_url_path(path)}", headers=headers, timeout=TIMEOUT_BYTES)
    _raise(resp, "Could not fetch file from Egnyte")
    return resp.content


def search(query: str, folder: str = "", limit: int = 20) -> list[dict[str, Any]]:
    """Full-text search, optionally scoped to a folder. Backs the Ctrl+K
    federation ("Temecula HVAC warranty") without Nexus indexing anything."""
    base, headers = _auth()
    payload: dict[str, Any] = {"query": query, "limit": max(1, min(limit, 100))}
    if folder:
        payload["folder"] = norm(folder)
    resp = httpx.post(f"{base}{_SEARCH}", headers=headers, json=payload, timeout=TIMEOUT_META)
    _raise(resp, "Could not search Egnyte")
    out = []
    for r in (resp.json().get("results") or []):
        out.append({
            "name": r.get("name", ""),
            "path": r.get("path", ""),
            "snippet": r.get("snippet", ""),
            "size": r.get("size", 0),
            "modified": r.get("last_modified", ""),
        })
    return out


# ── write ────────────────────────────────────────────────────────────────────

def upload_file(path: str, content: bytes) -> dict[str, Any]:
    """Write bytes to an EXACT Egnyte path (folder + filename).

    This is the half that did not exist before, and it is the whole point of the
    owner's ask: uploading at the right folder level rather than dropping files
    into a generic bucket and re-filing them by hand. The caller resolves the
    folder (see folder_for_property) and passes a full destination path."""
    base, headers = _auth()
    target = norm(path)
    resp = httpx.post(
        f"{base}{_FS_CONTENT}{_url_path(target)}",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=content,
        timeout=TIMEOUT_BYTES,
    )
    _raise(resp, "Could not upload to Egnyte")
    return {
        "path": target,
        "entryId": resp.headers.get("X-Sha512-Checksum", "") and resp.headers.get("ETag", ""),
        "name": target.rsplit("/", 1)[-1],
    }


def create_folder(path: str) -> dict[str, Any]:
    """Idempotent: Egnyte answers 403/405 when the folder already exists, which
    is success for our purposes - the caller wanted it to exist."""
    base, headers = _auth()
    target = norm(path)
    resp = httpx.post(f"{base}{_FS}{_url_path(target)}", headers=headers,
                      json={"action": "add_folder"}, timeout=TIMEOUT_META)
    if resp.status_code in (403, 405, 409):
        return {"path": target, "created": False, "existed": True}
    _raise(resp, "Could not create Egnyte folder")
    return {"path": target, "created": True, "existed": False}


# ── linking ──────────────────────────────────────────────────────────────────

def web_url(path: str) -> str:
    """Deep link into Egnyte's own UI. Every surface that lists a file should
    offer this - Nexus shows the folder, Egnyte remains where people manage
    permissions, versions and sharing."""
    base, _ = _auth()
    return f"{base}/app/index.do#storage/files/1{norm(path)}"


# ── folder resolution ────────────────────────────────────────────────────────
# The owner's phrase "at the right folder level" is a naming contract, not a
# guess. Resolution LISTS and MATCHES rather than building a path from a prefix,
# because the real folder names are not uniform. Roots and subfolders are
# overridable by env so a re-org does not need a deploy.

# Priority order. Per Visesh (Jul 30): a property resolves to its ENTITY folder
# under /Shared/#Entities - that is where the documents people actually want
# live (Financials, Insurance, Lease, Legal, Operations, Properties, Sale).
# /Shared/--Asset Management stays as a fallback and is NOT dead weight: sites
# like Temecula exist only there, with the per-system folders (HVAC, Electrical,
# Plumbing, ...) under "Property Plans and Maps". Dropping it would have traded
# one wrong folder for eight missing ones.
_DEFAULT_ROOTS = ("/Shared/#Entities", "/Shared/--Asset Management")

# Checked in order against a resolved property folder's ACTUAL children; the
# first that exists wins. Two entries because the two roots differ: entity
# folders keep property documents under "Properties", asset-management folders
# under "Property Plans and Maps".
_DEFAULT_PLANS_SUBFOLDERS = ("Property Plans and Maps", "Properties")

# Stripped before comparing a folder name to a site name, so one rule covers
# every naming style instead of one special case per style.
_LEGAL_SUFFIXES = (", llc", " llc", ", inc", " inc", ", l.p.", ", lp", " lp",
                   ", pvt. ltd", ", pvt ltd", " pvt ltd")
_SITE_PREFIXES = ("greens ", "gs ")


def property_roots() -> list[str]:
    """Roots to search, highest priority first. The wiring registry (Egnyte
    module - Wiring tab, slot property.roots) wins over the env vars, which win
    over the defaults - see egnyte_wiring.effective for the full order.
    EGNYTE_PROPERTIES_ROOTS takes a comma-separated list; the older singular
    EGNYTE_PROPERTIES_ROOT still works and pins resolution to exactly one root."""
    from egnyte_wiring import effective
    raw, _src = effective("property.roots")
    if raw:
        return [norm(p) for p in raw.split(",") if p.strip()]
    return [norm(p) for p in _DEFAULT_ROOTS]


def plans_subfolders() -> list[str]:
    from egnyte_wiring import effective
    raw, _src = effective("property.plans-subfolders")
    if raw:
        return [s.strip() for s in raw.split(",") if s.strip()]
    return list(_DEFAULT_PLANS_SUBFOLDERS)


def _site_key(name: str) -> str:
    """Reduce a folder name to the bare site it refers to.

    Verified against the live tenant (Jul 30). Folder names carry a company
    prefix, a legal suffix, or both, and the two roots disagree about which:
        "Greens Escondido, LLC"  -> escondido      (#Entities)
        "GS Temecula"            -> temecula       (--Asset Management)
        "Greens Valley Center, LLC" -> valley center
    Comparing on this key is what lets "Escondido" find its folder under either
    convention. It also keeps neighbours distinct: "Valley Center Inv 1, LLC"
    reduces to "valley center inv 1", so an exact-key match on "valley center"
    still prefers the entity folder over the investment vehicle."""
    n = (name or "").strip().lower()
    for suf in _LEGAL_SUFFIXES:
        if n.endswith(suf):
            n = n[: -len(suf)]
            break
    for pre in _SITE_PREFIXES:
        if n.startswith(pre):
            n = n[len(pre):]
            break
    return n.strip(" ,.-")


def create_root() -> str:
    """Where a NEW property folder gets made - deliberately NOT the root we read
    from first. /Shared/#Entities is a legal-entity register: creating a company
    in it from a property screen would be a finance and legal act wearing the
    costume of a documents one, and a mis-named entity there is not something
    Nexus should be able to do. New properties get a working folder under asset
    management, which is what that root is for."""
    from egnyte_wiring import raw_value
    wired = raw_value("property.create-root") or ""
    explicit = wired.strip() or os.getenv("EGNYTE_CREATE_ROOT", "").strip()
    return norm(explicit) if explicit else property_roots()[-1]


def folder_for_property(site: str) -> str:
    """PROPOSED path for a site that has no folder yet. Only for the create-it
    flow; use resolve_property_folder() to find something that already exists."""
    return norm(f"{create_root()}/{site}")


def resolve_property_folder(site: str) -> str | None:
    """Find a property's real folder by listing each root and matching.

    Matching is exact-name, then site-key, then substring - all within one root
    before moving to the next, so the higher-priority root wins even on a weaker
    match. Substring is last because it is the loose one ("918 el camino").

    Returns None when nothing matches anywhere - the caller reports `missing`
    and offers to create, which is correct for a genuinely new property.
    """
    want = (site or "").strip().lower()
    if not want:
        return None
    for root in property_roots():
        try:
            names = [f["name"] for f in list_folder(root)["folders"]]
        except EgnyteError:
            continue        # a missing/forbidden root must not hide the others
        for matches in (
            lambda n: n.lower() == want,
            lambda n: _site_key(n) == want,
            lambda n: want in n.lower(),
        ):
            for n in names:
                if matches(n):
                    return norm(f"{root}/{n}")
    return None


def plans_folder(site_folder: str, child_names: list[str] | None = None) -> str:
    """The documents subfolder inside a resolved property folder.

    Pass the folder's actual child names and the first candidate that EXISTS
    wins - the two roots use different names for the same idea, and picking from
    reality avoids pointing the UI at a folder that was never there.

    When the folder exists but uses neither name, this returns the property
    folder ITSELF rather than an invented subfolder: showing what is really
    there beats an empty state for a path that never existed. Only with no
    children at all (the property is not in Egnyte yet) does it fall back to the
    first candidate, as the path the create-it flow would make."""
    subs = plans_subfolders()
    if child_names is not None:
        by_lower = {n.lower(): n for n in child_names}
        for cand in subs:
            hit = by_lower.get(cand.lower())
            if hit:
                return norm(f"{site_folder}/{hit}")
        return norm(site_folder)
    return norm(f"{site_folder}/{subs[0]}")
