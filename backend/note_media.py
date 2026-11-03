"""Delete Forever means the files too (11/02/2026, the legal compliance pass:
"uploads you promised to delete still in storage").

A note's voice notes, videos, pictures, board images and board thumbnails
live in the private task-files bucket under `notes/` (voice and video at
`notes/<ts>-<name>`, board files and thumbnails under
`notes/boards/<noteId>/`). Before this, Delete Forever removed the note's rows
and left every one of those objects in storage.

`purge(db, note_id, texts)` runs AFTER the note's rows are deleted and
committed - from a background task (`purge_later`), so Delete Forever answers
at once. It deletes an object only when:
  * it is under `notes/` in task-files (nothing else is ever touched), and
  * no other row still points at it - one UNION ALL query over every column
    that can hold a stored file's link (_REFS): another note or version (a
    copied note, a pasted picture, a board's source), a task or ticket
    attachment (Mark Up's "Attach to <source>" files the PNG under the board's
    folder), task and ticket descriptions and pictures, comments, Knowledge
    Base pages and comments, announcements, What's New entries and comments,
    assistant messages and form answers. On any query error the file stays.
A file still in use elsewhere stays. A failed delete is left as it is (an
orphan, never a broken record).

Only on the deployed API (leader.is_deployed_worker): a laptop's database
does not know what the shared bucket's other rows point at, so a laptop
never deletes live storage - the same rule as every other storage delete.
The background task runs in FastAPI's threadpool, never on the event loop.
"""
import re
from urllib.parse import quote, unquote

import httpx
from sqlalchemy import text

import task_files

BUCKET = task_files.TASK_FILES_BUCKET
PREFIX = "notes/"
_CANON = re.compile(r"/storage/v1/object/public/" + re.escape(BUCKET) + r"/(notes/[^\"'\s<>)\\]+)")
_VIEW = re.compile(r"/files/view\?u=([^\"'\s<>&)\\]+)")


def paths_in(*texts) -> set:
    """Every task-files object path under notes/ named in these texts, in the
    canonical form or wrapped in the /files/view viewer link."""
    out = set()
    for t in texts:
        s = str(t or "")
        for m in _VIEW.finditer(s):
            s += " " + unquote(m.group(1))
        for m in _CANON.finditer(s):
            p = unquote(m.group(1))
            if p.startswith(PREFIX) and ".." not in p:
                out.add(p)
    return out


# (table, column) pairs that can hold a stored file's URL - anywhere a link
# to a note's picture or recording can be pasted, attached or kept. JSON
# columns are read as text (CAST), so one LIKE works on SQLite and Postgres.
_REFS = (
    ("nexus_notes", "body"), ("nexus_notes", "scene"), ("nexus_notes", "thumb_url"), ("nexus_notes", "source"),
    ("nexus_note_versions", "body"), ("nexus_note_versions", "scene"),
    ("task_attachments", "url"), ("tasks", "description"), ("task_comments", "body"),
    ("task_tickets", "description"), ("task_tickets", "images"),
    ("kb_documents", "body"), ("kb_documents", "blocks"), ("kb_comments", "text"),
    ("nexus_announcements", "body"), ("nexus_announcements", "image_url"), ("nexus_announcements", "file_url"),
    ("task_changelog_entries", "payload"), ("task_changelog_comments", "body"),
    ("ai_messages", "content"), ("doc_form_entries", "answers"),
)


def _refs_sql() -> str:
    return " UNION ALL ".join(
        f"SELECT 1 AS hit FROM {t} WHERE CAST({c} AS TEXT) LIKE :p" for t, c in _REFS) + " LIMIT 1"


def still_used(db, path: str) -> bool:
    """Does any row still point at this object? One query over every _REFS
    column. The note being deleted is already gone, so any hit is someone
    else's. On any error the answer is yes - the file stays."""
    try:
        return db.execute(text(_refs_sql()), {"p": f"%{path}%"}).first() is not None
    except Exception:
        db.rollback()
        return True


def _list_folder(url: str, headers: dict, folder: str) -> set:
    """The objects in one board folder (old thumbnails no row names any more)."""
    try:
        r = httpx.post(f"{url}/storage/v1/object/list/{BUCKET}", headers=headers, timeout=30,
                       json={"prefix": folder, "limit": 1000, "offset": 0})
    except Exception:
        return set()
    if not r.is_success:
        return set()
    return {f"{folder}/{o['name']}" for o in (r.json() or []) if o.get("name") and o.get("id")}


def _deployed() -> bool:
    try:
        import leader
        return leader.is_deployed_worker()
    except Exception:
        return False


def purge(db, note_id: str, texts) -> int:
    """Delete the files of a note that was just deleted forever. `texts` are
    the note's body, scene and thumbnail and its versions' bodies and scenes,
    read before the rows went. Returns the number of objects deleted."""
    if not _deployed():
        return 0
    url, key = task_files._creds()
    if not (url and key):
        return 0
    headers = {"Authorization": f"Bearer {key}", "apikey": key}
    candidates = paths_in(*texts)
    if note_id and re.fullmatch(r"[A-Za-z0-9_-]+", note_id):
        candidates |= _list_folder(url, headers, f"notes/boards/{note_id}")
    gone = 0
    for path in sorted(candidates):
        if still_used(db, path):
            continue
        try:
            r = httpx.delete(f"{url}/storage/v1/object/{BUCKET}/{quote(path)}", headers=headers, timeout=30)
        except Exception:
            continue
        if r.is_success or r.status_code == 404:
            gone += 1
    return gone


def purge_later(note_id: str, texts) -> None:
    """The background task Delete Forever schedules: its own session, never
    raises (a file left behind is only an orphan)."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        purge(db, note_id, texts)
    except Exception as e:  # noqa: BLE001
        print(f"[notes] file cleanup after delete failed: {type(e).__name__}")
    finally:
        db.close()
