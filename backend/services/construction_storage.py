"""Construction media storage - where a jobsite photo, video or voice note goes.

Two stores, one source of truth (see ConstructionMedia's docstring):
  Egnyte   the RECORD, inside the property's existing folder tree
  Supabase the SERVING copy the app grid and the report PDF actually load

Nothing here talks to Egnyte over HTTP. `services/egnyte.py` is the one client,
per the rule in routers/egnyte.py - a second client is the mistake CLAUDE.md
records for Asana. This module decides *paths and eligibility*; the service moves
the bytes.

Folder layout (Neil, Aug 4):
    <property folder>/Construction/Daily Logs/2026-08/2026-08-04/
        sagar.shoundik-0913-formwork.jpg

Dated folders rather than one flat directory per project: a 14-month job puts
thousands of files in that tree, and Egnyte's own UI is where people browse it.
The month level exists so a year of work is 14 folders instead of 400.
"""
import os
import re
from datetime import datetime, timezone

# ── Size ceilings ────────────────────────────────────────────────────────────
# 100 MB matches routers/egnyte.py's MAX_UPLOAD_BYTES, and that is not a
# coincidence to be tidied away later: `upload()` there reads the whole file into
# the API process (`raw = await file.read()`), so the ceiling is a memory budget
# on a gunicorn worker, not a policy preference. Two concurrent 500 MB clips
# would OOM the instance. The app compresses video before upload; anything still
# over the line is rejected at the client with a real message rather than
# accepted and silently dropped at sync time.
MAX_BYTES = {
    "photo": 25 * 1024 * 1024,    # a 25 MP phone JPEG is ~8 MB; 25 leaves room for RAW-ish
    "video": 100 * 1024 * 1024,   # hard cap - see above
    "audio": 25 * 1024 * 1024,    # ~30 min of AAC voice; far beyond a site note
}

ALLOWED_MIME = {
    "photo": {"image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"},
    "video": {"video/mp4", "video/quicktime", "video/webm"},
    "audio": {"audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm", "audio/wav"},
}

# HEIC is what an iPhone produces by default and is not renderable in most
# browsers. Accepted on the way in (rejecting it would reject half the workforce)
# and converted to JPEG for the Supabase serving copy; the HEIC original is what
# goes to Egnyte.
NEEDS_TRANSCODE_FOR_WEB = {"image/heic", "image/heif"}

_EXT_FOR_MIME = {
    "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
    "image/heif": "heif", "image/webp": "webp",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
    "audio/ogg": "ogg", "audio/webm": "weba", "audio/wav": "wav",
}


def validate(kind: str, size_bytes: int, mime_type: str) -> str:
    """"" if the upload is acceptable, else a message written for the worker.

    The message names the actual limit and the actual file size. "Upload failed"
    on a phone at a jobsite means the update does not get filed at all, so the
    error has to say what to do about it."""
    if kind not in MAX_BYTES:
        return f"Unknown media type '{kind}'."
    mime = (mime_type or "").split(";")[0].strip().lower()
    if mime and mime not in ALLOWED_MIME[kind]:
        return f"{mime} is not a supported {kind} format."
    if size_bytes <= 0:
        return "That file is empty."
    cap = MAX_BYTES[kind]
    if size_bytes > cap:
        return (f"That {kind} is {size_bytes / 1024 / 1024:.0f} MB. "
                f"The limit is {cap // 1024 // 1024} MB - "
                + ("record a shorter clip and try again."
                   if kind == "video" else "try a smaller file."))
    return ""


# ── Path construction ────────────────────────────────────────────────────────
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
# Egnyte rejects these outright in a path segment; strip rather than escape so a
# filename never depends on a client encoding it correctly.
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _slug(text: str, limit: int = 28) -> str:
    s = _SLUG_STRIP.sub("-", (text or "").strip().lower()).strip("-")
    if len(s) <= limit:
        return s
    # Cut on a word boundary so "formwork-north-wall" degrades to "formwork-north",
    # not "formwork-nort".
    return s[:limit].rsplit("-", 1)[0] or s[:limit]


def _parse_iso(value: str):
    try:
        d = datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def daily_log_folder(property_folder: str, log_date: str) -> str:
    """<property folder>/Construction/Daily Logs/YYYY-MM/YYYY-MM-DD

    `log_date` is the JOBSITE-local date the work happened, never the upload
    date. A worker who shoots at 4pm and uploads at 9pm from the truck files
    under the day they were on site."""
    base = (property_folder or "").rstrip("/")
    date = (log_date or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError(f"log_date must be YYYY-MM-DD, got {log_date!r}")
    return f"{base}/Construction/Daily Logs/{date[:7]}/{date}"


def media_filename(*, uploaded_by: str, taken_at: str, uploaded_at: str,
                   kind: str, mime_type: str, description: str = "",
                   original_name: str = "", media_id: str = "") -> str:
    """`sagar.shoundik-0913-formwork.jpg`

    Three parts, each earning its place when someone browses the folder in
    Egnyte months later with no app in front of them: who shot it, when during
    the day, and what it shows. `taken_at` wins over `uploaded_at` for the time
    - the whole point is the moment on site.

    A short id suffix is appended when the description is empty, because
    `sagar.shoundik-0913-photo.jpg` collides the instant someone takes two
    photos in the same minute, and Egnyte would either overwrite or version it.
    """
    who = (uploaded_by or "unknown").split("@")[0].lower()
    who = _UNSAFE.sub("", who) or "unknown"

    when = _parse_iso(taken_at) or _parse_iso(uploaded_at)
    hhmm = when.strftime("%H%M") if when else "0000"

    what = _slug(description)
    if not what and original_name:
        stem = original_name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        # Camera-roll names (IMG_4821, VID_20260804, DCIM1234) describe nothing;
        # using them would make every filename look meaningful and none be.
        if not re.fullmatch(r"(?i)(img|vid|dcim|photo|movie|pxl|mov)[-_ ]?\d+", stem):
            what = _slug(stem)
    if not what:
        what = kind
        if media_id:
            what = f"{what}-{media_id[:6]}"

    ext = _EXT_FOR_MIME.get((mime_type or "").split(";")[0].strip().lower())
    if not ext and original_name and "." in original_name:
        ext = _UNSAFE.sub("", original_name.rsplit(".", 1)[-1].lower())[:5]
    ext = ext or "bin"

    return f"{who}-{hhmm}-{what}.{ext}"


def egnyte_path(*, property_folder: str, log_date: str, **name_kw) -> str:
    """Full destination path for the record copy."""
    return f"{daily_log_folder(property_folder, log_date)}/{media_filename(**name_kw)}"


# ── Thumbnails ───────────────────────────────────────────────────────────────
# 480px is sized for the grid, not for viewing: the app shows photos in a
# multi-column strip and only opens the full rendition when one is tapped. A
# 25 MB photo behind every tile is what makes the module unusable on the jobsite
# LTE it was built for.
THUMBNAIL_MAX_PX = 480
THUMBNAIL_QUALITY = 78

# What Pillow can open with the dependencies this project actually has.
# HEIC/HEIF are deliberately absent: decoding them needs pillow-heif, which is
# not installed, and the client already converts them (`toWebSafe` in
# construction/lib/upload.js). When that client conversion fails the original
# HEIC lands here and simply gets no thumbnail - the grid falls back to the full
# rendition rather than showing nothing.
THUMBNAILABLE_MIME = {"image/jpeg", "image/png", "image/webp"}


def is_inline(url: str) -> bool:
    """True for a base64 `data:` URL carried in the row itself.

    Produced only when the client has no Supabase configured, which on a
    deployed instance never happens - see uploadConstructionMedia. It exists so
    the whole module is testable on a laptop with nothing but SQLite, the same
    way the Task module's inline attachments are.

    Everything that would treat `url` as something to FETCH has to check this
    first. There is no object to download, no bytes to file into Egnyte, and no
    rendition to derive - and an httpx GET of a `data:` URL raises rather than
    returning the payload, so without this the sweep burns its four attempts and
    marks a perfectly good row failed. The Asana sync already skips `data:` URLs
    for the same reason (CLAUDE.md)."""
    return (url or "").startswith("data:")


def can_thumbnail(kind: str, mime_type: str) -> bool:
    mime = (mime_type or "").split(";")[0].strip().lower()
    return kind == "photo" and mime in THUMBNAILABLE_MIME


def thumbnail_path(storage_path: str) -> str:
    """Derivative of the serving copy's own key, so the two cannot drift.

    Always .jpg regardless of the source: the thumbnail is a rendition, and JPEG
    is the smallest thing every browser renders. A PNG screenshot's thumbnail
    being a JPEG is correct - nobody reads a 480px tile for pixel fidelity."""
    base = (storage_path or "").rsplit(".", 1)[0]
    if not base:
        raise ValueError("storage_path is required to derive a thumbnail path")
    return f"{base}-thumb.jpg"


def supabase_path(*, project_id: str, media_id: str, mime_type: str,
                  original_name: str = "") -> str:
    """Serving-copy object path.

    Flat and id-keyed on purpose - the opposite of the Egnyte path. Nobody
    browses this bucket; it is addressed by URL from the app and the PDF. Keeping
    it id-keyed means a media row renamed or re-filed in Egnyte does not
    invalidate a link already printed into a published report."""
    ext = _EXT_FOR_MIME.get((mime_type or "").split(";")[0].strip().lower())
    if not ext and original_name and "." in original_name:
        ext = _UNSAFE.sub("", original_name.rsplit(".", 1)[-1].lower())[:5]
    return f"construction/{project_id}/{media_id}.{ext or 'bin'}"


# ── Egnyte availability ──────────────────────────────────────────────────────
def egnyte_ready() -> bool:
    """Whether the record copy can be filed at all.

    False is a first-class state, not an error: routers/egnyte.py already treats
    unconfigured that way. Media still uploads and the app still works; rows sit
    at egnyte_status='pending' and the sweep files them once EGNYTE_DOMAIN and
    EGNYTE_TOKEN exist. Failing the worker's upload because an integration is
    unconfigured would lose the update for an operator problem."""
    return bool(os.getenv("EGNYTE_DOMAIN", "").strip()
                and os.getenv("EGNYTE_TOKEN", "").strip())
