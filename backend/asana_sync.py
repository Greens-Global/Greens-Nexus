"""
Nexus <-> Asana two-way task sync (engine).

Increment 1: config, a Nexus<->Asana task link map, OUTBOUND push (create/update)
and INBOUND poll, with hash-based loop prevention. Real-time inbound (Asana
webhooks) and assignee/comment sync are follow-ups.

Design
------
- One config row (AsanaSyncConfig): a service token + workspace, on/off.
- AsanaProjectMap: Nexus project <-> Asana project (so tasks land on the right board).
- AsanaTaskLink: Nexus task <-> Asana gid + `last_hash` (digest of the synced
  fields at the last sync). Comparing the current digest to last_hash prevents
  echo loops — a change that came *from* a sync won't be pushed back.

Synced fields (both directions): title/name, description/notes, dueOn/due_on,
completed. (Assignee, comments, attachments, custom fields: later increments.)

Outbound is fire-and-forget from create_task/update_task via on_task_changed():
it runs in a daemon thread on its own DB session and swallows all errors, so a
slow or failing Asana call can never block or break a Nexus task operation.
"""
import hashlib
import hmac
import os
import threading
import time

from database import SessionLocal
import models
from routers.task_util import now_iso, gen_id
from asana_import import Asana, _request, ImportError_

_ASANA_BASE = "https://app.asana.com/api/1.0"


def public_base():
    """The PUBLIC https base of this API, for the webhook target Asana calls back.
    Derived from the Azure host; empty when running locally (Asana can't reach a
    laptop). NEXUS_API_BASE overrides it (e.g. an ngrok tunnel while testing)."""
    override = os.getenv("NEXUS_API_BASE", "").strip().rstrip("/")
    if override:
        return override
    host = os.getenv("WEBSITE_HOSTNAME", "").strip()
    return f"https://{host}" if host else ""


def is_sync_worker():
    """Whether THIS process may run background sync (auto-pull + the outbound
    fire-and-forget pushes).

    The config row is a singleton in a shared database: on dev, every developer's
    local backend pointed at DATABASE_URL sees the same `enabled` flag. Without
    this gate they would each run the 5-min pull loop and push every local task
    edit to the real Asana workspace, racing the deployed instance into duplicate
    tasks and comments. Only the deployed API qualifies; set
    NEXUS_ASANA_SYNC_WORKER=true locally to opt in deliberately.

    Manual Pull / Push-all remain available everywhere — those are explicit
    operator actions, not background traffic."""
    if os.getenv("NEXUS_ASANA_SYNC_WORKER", "").lower() in ("1", "true", "yes"):
        return True
    return bool(os.getenv("WEBSITE_SITE_NAME"))   # set by Azure App Service

# email -> Asana user gid, cached per (token, workspace) for a few minutes so
# assignee resolution doesn't refetch the workspace roster on every push.
_USER_CACHE = {}
_USER_TTL = 600


def _user_map(cfg):
    if not cfg.workspace_gid or not cfg.token:
        return {}
    key = (cfg.token, cfg.workspace_gid)
    ent = _USER_CACHE.get(key)
    if ent and time.time() - ent[0] < _USER_TTL:
        return ent[1]
    out = {}
    try:
        for u in Asana(cfg.token).get(f"/workspaces/{cfg.workspace_gid}/users", opt_fields="email"):
            em = (u.get("email") or "").lower()
            if em:
                out[em] = u["gid"]
    except Exception:
        pass
    _USER_CACHE[key] = (time.time(), out)
    return out


# {(token, project_gid): (ts, {name_lower: gid})} — used to link to an existing
# Asana task by name instead of creating a duplicate. Short TTL; the cache is
# also updated in-place as new tasks are created within one push run.
_PROJ_TASK_CACHE = {}
_PROJ_TASK_TTL = 180


def _asana_tasks_by_name(cfg, project_gid):
    key = (cfg.token, project_gid)
    ent = _PROJ_TASK_CACHE.get(key)
    if ent and time.time() - ent[0] < _PROJ_TASK_TTL:
        return ent[1]
    out = {}
    try:
        for a in Asana(cfg.token).get(f"/projects/{project_gid}/tasks", opt_fields="name"):
            nm = (a.get("name") or "").strip().lower()
            if nm and nm not in out:
                out[nm] = a["gid"]
    except Exception:
        pass
    _PROJ_TASK_CACHE[key] = (time.time(), out)
    return out


# ── low-level Asana writes (GET comes from asana_import.Asana) ────────────────
def _headers(token):
    return {"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}


def _unwrap(resp):
    # Asana wraps single-object responses as {"data": {...}}; return the inner object.
    return resp.get("data", resp) if isinstance(resp, dict) else resp


def _asana_post(token, path, body):
    return _unwrap(_request("POST", f"{_ASANA_BASE}{path}", _headers(token), body))


def _asana_put(token, path, body):
    return _unwrap(_request("PUT", f"{_ASANA_BASE}{path}", _headers(token), body))


# ── config + link helpers ────────────────────────────────────────────────────
def get_config(db):
    cfg = db.query(models.AsanaSyncConfig).filter(models.AsanaSyncConfig.id == "singleton").first()
    if not cfg:
        cfg = models.AsanaSyncConfig(id="singleton", enabled=False, updated_at=now_iso())
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def _link_by_nexus(db, task_id):
    return db.query(models.AsanaTaskLink).filter(models.AsanaTaskLink.nexus_task_id == task_id).first()


def _link_by_asana(db, gid):
    return db.query(models.AsanaTaskLink).filter(models.AsanaTaskLink.asana_gid == gid).first()


def _asana_project_for(db, task, cfg):
    """The Asana project a Nexus task should live in: its mapped project, else the
    configured default (empty => don't sync this task)."""
    if task.project_id:
        pm = (db.query(models.AsanaProjectMap)
              .filter(models.AsanaProjectMap.nexus_project_id == task.project_id).first())
        if pm and pm.asana_project_gid:
            return pm.asana_project_gid
    return cfg.default_project_gid or ""


def _nexus_project_for(db, asana_project_gid):
    pm = (db.query(models.AsanaProjectMap)
          .filter(models.AsanaProjectMap.asana_project_gid == asana_project_gid).first())
    return pm.nexus_project_id if pm else ""


# ── the synced-field digest (loop prevention) ────────────────────────────────
def _digest(title, description, due_on, completed, assignee=""):
    raw = "\x1f".join([title or "", description or "", (due_on or "")[:10],
                       "1" if completed else "0", (assignee or "").lower()])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _task_digest(t):
    return _digest(t.title, t.description, t.due_on, bool(t.completed), t.assignee_email)


# ── OUTBOUND: Nexus task -> Asana ────────────────────────────────────────────
def push_task(db, task):
    """Create or update the Asana counterpart of a Nexus task. Returns the gid or
    None. Skips when disabled, unmapped, or unchanged since the last sync."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        return None
    apid = _asana_project_for(db, task, cfg)
    if not apid:
        return None
    link = _link_by_nexus(db, task.id)
    digest = _task_digest(task)
    if link and link.last_hash == digest:
        return link.asana_gid   # no change (or the change came from a sync)

    fields = {
        "name": task.title or "(untitled)",
        "notes": task.description or "",
        "due_on": (task.due_on or "")[:10] or None,
        "completed": bool(task.completed),
    }
    # Assignee: map the Nexus work email to an Asana user. Unassigned in Nexus →
    # unassign in Asana; assigned to someone not in Asana → leave Asana as-is.
    ae = (task.assignee_email or "").lower()
    if not ae:
        fields["assignee"] = None
    else:
        gid = _user_map(cfg).get(ae)
        if gid:
            fields["assignee"] = gid
    if link and link.asana_gid:
        _asana_put(cfg.token, f"/tasks/{link.asana_gid}", {"data": fields})
    else:
        # Dedup: if an Asana task with the same name already exists in the target
        # project (e.g. the two projects were previously imported), LINK to it and
        # update it — never blindly create a duplicate.
        name_key = (task.title or "").strip().lower()
        existing_gid = _asana_tasks_by_name(cfg, apid).get(name_key)
        if existing_gid:
            _asana_put(cfg.token, f"/tasks/{existing_gid}", {"data": fields})
            gid = existing_gid
        else:
            created = _asana_post(cfg.token, "/tasks", {"data": {**fields, "projects": [apid]}})
            gid = (created or {}).get("gid")
            if not gid:
                return None
            _asana_tasks_by_name(cfg, apid)[name_key] = gid   # so siblings in the same run don't duplicate
        link = models.AsanaTaskLink(id=gen_id(), nexus_task_id=task.id, asana_gid=gid)
        db.add(link)
    link.last_hash = digest
    link.last_synced_at = now_iso()
    db.commit()
    return link.asana_gid


def on_task_changed(task_id):
    """Fire-and-forget outbound push from create_task/update_task. Never raises."""
    if not is_sync_worker():
        return
    def _run():
        db = SessionLocal()
        try:
            cfg = get_config(db)
            if not cfg.enabled:
                return
            t = db.query(models.Task).filter(models.Task.id == task_id).first()
            if t and not t.parent_task_id:      # top-level tasks only (increment 1)
                push_task(db, t)
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


def push_all(db):
    """Seed/refresh: push every top-level task in a mapped Nexus project to Asana."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    mapped = {pm.nexus_project_id for pm in db.query(models.AsanaProjectMap).all()}
    n = 0
    tasks = db.query(models.Task).filter(models.Task.parent_task_id == "").all()
    for t in tasks:
        if (t.project_id in mapped) or cfg.default_project_gid:
            try:
                if push_task(db, t):
                    n += 1
            except ImportError_:
                raise
            except Exception:
                pass
    return {"pushed": n}


# ── INBOUND: Asana -> Nexus (poll) ───────────────────────────────────────────
def _apply_inbound(db, at, nexus_project_id, counts):
    """Apply one Asana task into Nexus (create or update). Returns the Nexus task id."""
    from routers.tasks import _next_code
    gid = at["gid"]
    assignee = ((at.get("assignee") or {}).get("email") or "").lower()
    link = _link_by_asana(db, gid)
    inbound_digest = _digest(at.get("name"), at.get("notes"), at.get("due_on"), bool(at.get("completed")), assignee)
    if link:
        t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
        if not t:
            return None
        if link.last_hash != inbound_digest:
            t.title = at.get("name") or t.title
            t.description = at.get("notes") or ""
            t.due_on = (at.get("due_on") or "")[:10]
            t.assignee_email = assignee
            t.completed = bool(at.get("completed"))
            if t.completed:
                t.status = "completed"
                t.completed_at = t.completed_at or now_iso()
            elif t.status == "completed":
                t.status = "not_started"
                t.completed_at = ""
            t.modified_at = now_iso()
            link.last_hash = _task_digest(t)
            link.last_synced_at = now_iso()
            counts["updated"] += 1
        return t.id
    # No link yet — before creating, try to adopt a matching Nexus task (same
    # title, same project, not already linked) so Pull doesn't duplicate work
    # that already exists in Nexus.
    name = at.get("name") or "(untitled)"
    match = (db.query(models.Task)
             .filter(models.Task.project_id == (nexus_project_id or ""),
                     models.Task.title == name,
                     models.Task.parent_task_id == "").first())
    if match and not _link_by_nexus(db, match.id):
        db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=match.id, asana_gid=gid,
                                    last_hash=_task_digest(match), last_synced_at=now_iso()))
        counts.setdefault("linked", 0)
        counts["linked"] += 1
        return match.id
    now = now_iso()
    completed = bool(at.get("completed"))
    t = models.Task(
        id=gen_id(), code=_next_code(db), title=at.get("name") or "(untitled)",
        description=at.get("notes") or "", type="task",
        status="completed" if completed else "not_started", priority="medium",
        assignee_email=assignee, project_id=nexus_project_id or "", due_on=(at.get("due_on") or "")[:10],
        completed=completed, completed_at=now if completed else "",
        follower_emails=[], liked_by_emails=[], subtask_ids=[], blocked_by_ids=[],
        blocking_ids=[], dependency_types={}, tags=[], custom_field_values={},
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by="asana-sync",
    )
    db.add(t)
    db.flush()
    db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid=gid,
                                last_hash=_task_digest(t), last_synced_at=now))
    counts["created"] += 1
    return t.id


def unlink_deleted_task(db, gid):
    """A deleted Asana task never shows up in pull() again — its project's task
    list just omits it, there's no tombstone to poll for. The webhook's
    'deleted' event is the only signal we get, and by the time it arrives the
    task is already gone from Asana, so there's nothing left to pull. Clear the
    link and flag the Nexus task unsynced; the Nexus task itself is untouched
    (Asana deletion doesn't delete the Nexus side)."""
    link = _link_by_asana(db, gid)
    if not link:
        return False
    t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
    if t:
        t.synced_with_asana = False
        t.modified_at = now_iso()
    db.delete(link)
    db.commit()
    return True


def _pull_comments(db, asana, asana_gid, nexus_task_id, counts):
    """Bring Asana comment stories into the Nexus task, deduped by story gid."""
    for s in asana.get(f"/tasks/{asana_gid}/stories",
                       opt_fields="type,resource_subtype,text,created_by.name"):
        if s.get("type") != "comment" and s.get("resource_subtype") != "comment_added":
            continue
        sgid = s["gid"]
        if db.query(models.AsanaCommentLink).filter(models.AsanaCommentLink.asana_story_gid == sgid).first():
            continue
        text = (s.get("text") or "").strip()
        if not text:
            continue
        author = (s.get("created_by") or {}).get("name") or "Asana"
        cid = gen_id()
        db.add(models.TaskComment(id=cid, task_id=nexus_task_id, author_email="asana-sync",
                                  body=f"[Asana · {author}]\n{text}", created_at=now_iso(), edited_at="", pinned=False))
        t = db.query(models.Task).filter(models.Task.id == nexus_task_id).first()
        if t:
            t.comment_ids = list(t.comment_ids or []) + [cid]
        db.add(models.AsanaCommentLink(id=gen_id(), nexus_comment_id=cid, asana_story_gid=sgid, created_at=now_iso()))
        counts["comments"] += 1


# Asana fires several webhook events in a burst for one new/changed task (create,
# then separate events per field set), each spawning its own trigger_pull_async()
# thread. Without serializing, concurrent pull() runs all see "no link yet" for
# the same Asana task at once and each create their own duplicate Nexus task —
# the same class of dedupe race that bit us with batched notifications
# (see CLAUDE.md). One lock is enough because sync only ever runs on one
# deployed instance (is_sync_worker()).
_PULL_LOCK = threading.Lock()


def pull(db):
    """Poll every mapped Asana project and apply changes into Nexus (tasks +
    comments). Walks all tasks and relies on the digest / comment-link to skip
    unchanged ones (no premium modified_since filter yet)."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    with _PULL_LOCK:
        asana = Asana(cfg.token)
        counts = {"created": 0, "updated": 0, "comments": 0}
        for pm in db.query(models.AsanaProjectMap).all():
            if not pm.asana_project_gid:
                continue
            rows = asana.get(f"/projects/{pm.asana_project_gid}/tasks",
                             opt_fields="name,notes,due_on,completed,assignee.email,modified_at")
            for at in rows:
                nexus_task_id = _apply_inbound(db, at, pm.nexus_project_id, counts)
                if nexus_task_id:
                    _pull_comments(db, asana, at["gid"], nexus_task_id, counts)
        cfg.last_pull_at = now_iso()
        db.commit()
        return counts


# ── OUTBOUND: Nexus comment -> Asana story ───────────────────────────────────
def push_comment(db, comment):
    """Post a Nexus comment to its linked Asana task as a story. Asana stories are
    authored by the token's user, so the Nexus author is prefixed into the text."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        return
    if db.query(models.AsanaCommentLink).filter(models.AsanaCommentLink.nexus_comment_id == comment.id).first():
        return   # already synced (came from Asana)
    link = _link_by_nexus(db, comment.task_id)
    if not link or not link.asana_gid:
        return
    author = comment.author_email or ""
    text = f"[Nexus · {author}] {comment.body or ''}" if author and author != "asana-sync" else (comment.body or "")
    st = _asana_post(cfg.token, f"/tasks/{link.asana_gid}/stories", {"data": {"text": text}})
    db.add(models.AsanaCommentLink(id=gen_id(), nexus_comment_id=comment.id,
                                   asana_story_gid=(st or {}).get("gid") or "", created_at=now_iso()))
    db.commit()


def on_comment_added(comment_id):
    """Fire-and-forget outbound comment push. Never raises."""
    if not is_sync_worker():
        return
    def _run():
        db = SessionLocal()
        try:
            cfg = get_config(db)
            if not cfg.enabled:
                return
            c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).first()
            if c:
                push_comment(db, c)
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


# ── Scheduled auto-pull (fallback poll; webhooks handle real-time) ───────────
_AUTO_PULL_STARTED = False
_AUTO_PULL_INTERVAL_MIN = 5


def start_auto_pull():
    """Start a daemon that pulls from Asana every few minutes when sync is enabled.
    Idempotent — safe to call once at startup. A no-op until a token is set, and a
    no-op entirely outside the designated sync worker (see is_sync_worker)."""
    global _AUTO_PULL_STARTED
    if _AUTO_PULL_STARTED or not is_sync_worker():
        return
    _AUTO_PULL_STARTED = True

    def _loop():
        while True:
            time.sleep(_AUTO_PULL_INTERVAL_MIN * 60)
            try:
                db = SessionLocal()
                try:
                    cfg = get_config(db)
                    if cfg.enabled and cfg.token:
                        pull(db)
                finally:
                    db.close()
            except Exception:
                pass
    threading.Thread(target=_loop, daemon=True).start()


def trigger_pull_async():
    """Run a pull in the background (used by the webhook receiver). Never raises."""
    def _run():
        try:
            db = SessionLocal()
            try:
                cfg = get_config(db)
                if cfg.enabled and cfg.token:
                    pull(db)
            finally:
                db.close()
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()


# ── Webhooks (real-time inbound) — receiver helpers + registration ───────────
def store_handshake_secret(db, secret):
    """Asana's handshake POSTs X-Hook-Secret to our target; store it as a pending
    row (linked to its project when the register call returns) and echo it back."""
    db.add(models.AsanaWebhook(id=gen_id(), resource_gid="", asana_webhook_gid="",
                               x_hook_secret=secret, created_at=now_iso()))
    db.commit()


def verify_signature(db, body_bytes, signature):
    """Verify an inbound event's X-Hook-Signature (HMAC-SHA256 of the raw body)
    against any stored webhook secret."""
    if not signature:
        return False
    for wh in db.query(models.AsanaWebhook).all():
        if not wh.x_hook_secret:
            continue
        mac = hmac.new(wh.x_hook_secret.encode(), body_bytes, hashlib.sha256).hexdigest()
        if hmac.compare_digest(mac, signature):
            return True
    return False


def register_webhooks(db, target_base=""):
    """Register an Asana webhook per mapped project so task changes stream in live.
    `target_base` is the PUBLIC https base of this API (Asana must reach it) — the
    receiver path /asana-sync/webhook is appended. Defaults to this deployment's
    own public host, so registering from dev/prod needs no URL at all."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    base = (target_base or "").strip() or public_base()
    if not base:
        raise ImportError_(
            "No public URL for this API — Asana can't reach a local backend. "
            "Register webhooks from the deployed dev/prod site, or set NEXUS_API_BASE "
            "to a public tunnel while testing locally.")
    if not base.startswith("https://"):
        raise ImportError_("The webhook target must be an https:// URL Asana can reach.")
    target = base.rstrip("/") + "/asana-sync/webhook"
    made = 0
    for pm in db.query(models.AsanaProjectMap).all():
        if not pm.asana_project_gid:
            continue
        # already have a live webhook for this project?
        existing = (db.query(models.AsanaWebhook)
                    .filter(models.AsanaWebhook.resource_gid == pm.asana_project_gid,
                            models.AsanaWebhook.asana_webhook_gid != "").first())
        if existing:
            continue
        # POST /webhooks blocks while Asana handshakes our target (store_handshake_secret
        # inserts a pending row); once it returns we attach the gid + project to it.
        created = _asana_post(cfg.token, "/webhooks",
                              {"data": {"resource": pm.asana_project_gid, "target": target}})
        gid = (created or {}).get("gid")
        pending = (db.query(models.AsanaWebhook)
                   .filter(models.AsanaWebhook.asana_webhook_gid == "")
                   .order_by(models.AsanaWebhook.created_at.desc()).first())
        if pending and gid:
            pending.resource_gid = pm.asana_project_gid
            pending.asana_webhook_gid = gid
            pending.target = target
            db.commit()
            made += 1
    return {"registered": made}


def delete_webhooks(db):
    cfg = get_config(db)
    removed = 0
    for wh in db.query(models.AsanaWebhook).all():
        if wh.asana_webhook_gid and cfg.token:
            try:
                _request("DELETE", f"{_ASANA_BASE}/webhooks/{wh.asana_webhook_gid}", _headers(cfg.token))
            except Exception:
                pass
        db.delete(wh)
        removed += 1
    db.commit()
    return {"removed": removed}
