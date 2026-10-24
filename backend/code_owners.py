"""Who owns which files - the machine-readable copy of the File Ownership table
in CLAUDE.md (change both together).

Build Mode (routers/dev_notes.py) holds a pin whose source file is in another
developer's area for that developer instead of sending it to Claude Code, and
the build-notes skill (tools/build_notes/cli.py `owners --check`) refuses to
commit changes to another developer's files.

Stdlib only and no imports from the app: tools/build_notes/ loads this file by
path (importlib) on a machine that may not have the backend's packages.

A path ending in "/" means the whole folder. Paths are repo-relative.
"""

OWNERS = [
    {"name": "Visesh", "email": "visesh.lodha@greensglobal.com", "paths": [
        "frontend/src/views/InventoryManagement.jsx",
        "frontend/src/components/Assignments.jsx",
        "frontend/src/components/NotificationBell.jsx",
        "frontend/src/components/NotificationToasts.jsx",
        "backend/routers/items.py"]},
    {"name": "Neil", "email": "neil@greensglobal.com", "paths": [
        "frontend/src/views/PropertyAsset.jsx",
        "frontend/src/views/AssetModule.jsx",
        "frontend/src/asset/",            # a trailing slash = the whole folder
        "backend/routers/assets.py",
        "backend/routers/property_assets.py"]},
]

def normalize(path) -> str:
    """A repo-relative path with forward slashes. Build Mode source stamps are
    relative to frontend/ ("src/tasks/X.jsx", "./src/..."), so anything that
    starts with src/ gets the frontend/ prefix; "frontend/src/..." and backend
    paths come back unchanged. An absolute path inside a checkout is cut down
    to the part from frontend/ or backend/ on. A ":line:col" suffix is dropped."""
    p = str(path or "").strip().replace("\\", "/")
    if not p:
        return ""
    # "src/X.jsx:12:4" -> "src/X.jsx" (a stamp's line and column, never part of a file name here)
    head, sep, tail = p.rpartition(":")
    while sep and tail.isdigit() and head:
        p = head
        head, sep, tail = p.rpartition(":")
    while p.startswith("./"):
        p = p[2:]
    if p.startswith("/") or (len(p) > 2 and p[1] == ":" and p[2] == "/"):
        for marker in ("/frontend/", "/backend/"):
            idx = p.rfind(marker)
            if idx >= 0:
                p = p[idx + 1:]
                break
        else:
            idx = p.rfind("/src/")
            p = p[idx + 1:] if idx >= 0 else p.lstrip("/")
    while "//" in p:
        p = p.replace("//", "/")
    if p.startswith("src/"):
        p = "frontend/" + p
    return p


def owner_of(path):
    """{"name", "email"} of the developer who owns `path`, or None."""
    p = normalize(path)
    if not p:
        return None
    for owner in OWNERS:
        for owned in owner["paths"]:
            if (owned.endswith("/") and p.startswith(owned)) or p == owned:
                return {"name": owner["name"], "email": owner["email"]}
    return None


def foreign_files(paths, me_email) -> list:
    """[{"path", "name", "email"}] for each path owned by someone other than
    `me_email` (paths normalized, each listed once, input order kept)."""
    me = str(me_email or "").strip().lower()
    out, seen = [], set()
    for raw in paths or []:
        p = normalize(raw)
        if not p or p in seen:
            continue
        seen.add(p)
        owner = owner_of(p)
        if owner and owner["email"].lower() != me:
            out.append({"path": p, "name": owner["name"], "email": owner["email"]})
    return out
