"""What Asana left behind, now that the integration is gone (removed Sep 2026).

The Asana workspace no longer exists, so nothing can be fetched from it again.
Removing the sync code deliberately removed NO data: every asana_* table and
row (task links with their Asana gids, comment/attachment/activity links, the
project map, import jobs...) and every Asana-derived column on the Nexus rows
(synced_with_asana, original_asana_url, asana_option_gids...) is still in the
database as a permanent record of where each task came from.

What IS lost is anything a Nexus row still only points at on Asana's servers:
an attachment hosted on asanausercontent.com that the rescue (Aug 2026) never
copied into our own storage, or an image/link inside a description or comment.
Those URLs are dead. `audit` finds every one so it is a known list, not a
surprise - read-only, it changes nothing.
"""
from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

import models

# asanausercontent.com / asana-user-private-*.s3.amazonaws.com = file bytes
# hosted by Asana (gone with the workspace). asana.com = app.asana.com links:
# Asana task pages, inline assets, or Asana's pointer to a file hosted
# elsewhere (Drive, Dropbox) - the pointer is dead, the file may not be.
_FILE_HOSTS = ("asanausercontent.com", "asana-user-private")
_HOSTS = _FILE_HOSTS + ("asana.com",)

# Every table the integration wrote, kept as an archive - reported so "no data
# was dropped" can be checked rather than taken on trust.
_ARCHIVE_TABLES = (
    ("asana_task_links", "AsanaTaskLink"), ("asana_comment_links", "AsanaCommentLink"),
    ("asana_attachment_links", "AsanaAttachmentLink"), ("asana_activity_links", "AsanaActivityLink"),
    ("asana_project_map", "AsanaProjectMap"), ("asana_pending_deletes", "AsanaPendingDelete"),
    ("asana_import_jobs", "AsanaImportJob"), ("asana_webhooks", "AsanaWebhook"),
    ("asana_user_tokens", "AsanaUserToken"), ("asana_sync_config", "AsanaSyncConfig"),
)


def _mentions_asana(column):
    return or_(*[column.like(f"%{h}%") for h in _HOSTS])


def _kind(url: str) -> str:
    return "asana_file" if any(h in (url or "") for h in _FILE_HOSTS) else "asana_link"


def audit(db: Session, limit: int = 200) -> dict:
    """Every live Nexus row that still depends on Asana-hosted content, grouped
    by where it sits, with the first `limit` of each for a person to act on."""
    code_title = {t.id: (t.code or "", t.title or "") for t in
                  db.query(models.Task.id, models.Task.code, models.Task.title).all()}

    def task_ref(task_id):
        code, title = code_title.get(task_id or "", ("", ""))
        return {"taskId": task_id, "taskCode": code, "taskTitle": title}

    att_q = db.query(models.TaskAttachment).filter(_mentions_asana(models.TaskAttachment.url))
    attachments = [{**task_ref(a.task_id), "id": a.id, "name": a.name, "url": a.url, "kind": _kind(a.url)}
                   for a in att_q.limit(limit).all()]

    desc_q = db.query(models.Task).filter(_mentions_asana(models.Task.description))
    descriptions = [{**task_ref(t.id), "kind": _kind(t.description)} for t in desc_q.limit(limit).all()]

    com_q = db.query(models.TaskComment).filter(_mentions_asana(models.TaskComment.body))
    comments = [{**task_ref(c.task_id), "id": c.id, "author": c.author_email or "", "kind": _kind(c.body)}
                for c in com_q.limit(limit).all()]

    archive = {}
    for table, cls in _ARCHIVE_TABLES:
        model = getattr(models, cls, None)
        if model is not None:
            try:
                archive[table] = db.query(model).count()
            except Exception:
                db.rollback()
                archive[table] = None   # table not present in this database
    return {
        "attachments": {"total": att_q.count(), "rows": attachments},
        "descriptions": {"total": desc_q.count(), "rows": descriptions},
        "comments": {"total": com_q.count(), "rows": comments},
        "syncedTasks": db.query(models.Task).filter(models.Task.synced_with_asana == True).count(),  # noqa: E712
        "archive": archive,
    }
