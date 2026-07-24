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

Synced fields (both directions unless noted): title/name, description/notes,
start_on, due_on, completed, assignee, status (via a "Task Progress" custom
field, if the project has one), priority (via Asana's own "Priority" custom
field), tags (find-or-create workspace tags by name), milestone flag
(resource_subtype — outbound only settable at creation, Asana treats it as
immutable after), followers (outbound additive via addFollowers, matching the
dependencies pattern — never removes an Asana-side follower removed on the
Nexus side), comments, attachments (inbound only), subtasks, dependencies
(best-effort), project-level access (member_emails / TaskTeam), and project
name/description (kept refreshed from Asana on every pull).

Outbound is fire-and-forget from create_task/update_task via on_task_changed():
it runs in a daemon thread on its own DB session and swallows all errors, so a
slow or failing Asana call can never block or break a Nexus task operation.
"""
import base64
import hashlib
import hmac
import mimetypes
import os
import threading
import time
import urllib.request

from sqlalchemy import text

from database import SessionLocal
import models
from routers.task_util import now_iso, gen_id, log_activity
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


# {(token, workspace_gid): (ts, {name_lower: gid})} — workspace tags, find-or-
# create by name (same pattern as _workspace_team_gid below).
_TAG_CACHE = {}
_TAG_TTL = 600


def _tag_gid(asana, cfg, name):
    key = (cfg.token, cfg.workspace_gid)
    ent = _TAG_CACHE.get(key)
    if not ent or time.time() - ent[0] >= _TAG_TTL:
        by_name = {}
        if cfg.workspace_gid:
            try:
                for t in asana.get(f"/workspaces/{cfg.workspace_gid}/tags", opt_fields="name"):
                    nm = (t.get("name") or "").strip().lower()
                    if nm:
                        by_name[nm] = t.get("gid")
            except Exception:
                pass
        ent = (time.time(), by_name)
        _TAG_CACHE[key] = ent
    key_name = name.strip().lower()
    gid = ent[1].get(key_name)
    if gid or not cfg.workspace_gid:
        return gid
    try:
        created = _asana_post(cfg.token, "/tags", {"data": {"name": name.strip(), "workspace": cfg.workspace_gid}})
        gid = (created or {}).get("gid")
        if gid:
            ent[1][key_name] = gid
    except Exception:
        return None
    return gid


def _push_followers(cfg, task, asana_gid):
    """Best-effort outbound follower push, same additive-only shape as
    _push_dependencies: an addFollowers action, never removeFollowers — a
    follower removed on the Nexus side keeps following in Asana."""
    emails = [e for e in (task.follower_emails or []) if e]
    if not emails:
        return
    gids = [_user_map(cfg).get(e.lower()) for e in emails]
    gids = [g for g in gids if g]
    if gids:
        try:
            _asana_post(cfg.token, f"/tasks/{asana_gid}/addFollowers", {"data": {"followers": gids}})
        except Exception:
            pass


def _push_tags(asana, cfg, task, asana_gid):
    """Additive outbound tag push — CONFIRMED live that `tags` is not a
    writable field on PUT /tasks/{gid} ("Cannot write this property"); Asana
    requires one addTag action per tag instead. Additive only, matching
    dependencies/followers: a tag removed on the Nexus side stays on the
    Asana task."""
    for name in (task.tags or []):
        name = (name or "").strip()
        if not name:
            continue
        tag_gid = _tag_gid(asana, cfg, name)
        if tag_gid:
            try:
                _asana_post(cfg.token, f"/tasks/{asana_gid}/addTag", {"data": {"tag": tag_gid}})
            except Exception:
                pass


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
def _digest(title, description, due_on, completed, assignee="", progress="", priority="",
           start_on="", tags=None, milestone=False):
    raw = "\x1f".join([title or "", description or "", (due_on or "")[:10],
                       "1" if completed else "0", (assignee or "").lower(), (progress or "").lower(),
                       (priority or "").lower(), (start_on or "")[:10],
                       ",".join(sorted((t or "").strip().lower() for t in (tags or []))),
                       "1" if milestone else "0"])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _task_digest(db, t):
    return _digest(t.title, t.description, t.due_on, bool(t.completed), t.assignee_email,
                   _status_progress_label(db, t), _BUILTIN_PRIORITY_LABELS.get(t.priority, ""),
                   t.start_on, t.tags, bool(t.is_milestone))


# ── "Task Progress" custom field (richer than Asana's built-in completed bool) ─
# Nexus's own status is 3+ states (not_started/in_progress/completed, plus
# per-project custom statuses) where Asana's native `completed` is only a
# boolean — teams that want that finer state visible in Asana add their own
# enum custom field, conventionally named "Task Progress". This maps Nexus's
# status onto it by matching option NAMES, so it works for any project that
# happens to have such a field without hardcoding its gid.
_PROGRESS_FIELD_CACHE = {}
_PROGRESS_FIELD_TTL = 600
_BUILTIN_STATUS_LABELS = {"not_started": "not started", "in_progress": "in progress",
                          "completed": "done", "recurring": "in progress"}


def _status_progress_label(db, task):
    """Lowercase human label for a task's status — a built-in or a project's own
    custom status (TaskCustomStatus.label) — for matching against Asana enum
    option names."""
    if task.status in _BUILTIN_STATUS_LABELS:
        return _BUILTIN_STATUS_LABELS[task.status]
    cs = db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id == task.status).first()
    return (cs.label or "").strip().lower() if cs else ""


# Both "Task Progress" and "Priority" (below) live on the same project custom
# field settings response — one cached fetch serves both lookups instead of
# hitting the API twice per project per push/pull.
def _custom_field_settings(cfg, project_gid):
    key = (cfg.token, project_gid)
    ent = _PROGRESS_FIELD_CACHE.get(key)
    if ent and time.time() - ent[0] < _PROGRESS_FIELD_TTL:
        return ent[1]
    result = []
    try:
        proj = Asana(cfg.token).get(f"/projects/{project_gid}", opt_fields=
                                    "custom_field_settings.custom_field.name,"
                                    "custom_field_settings.custom_field.gid,"
                                    "custom_field_settings.custom_field.enum_options.name,"
                                    "custom_field_settings.custom_field.enum_options.gid")
        result = (proj or {}).get("custom_field_settings") or []
    except Exception:
        pass
    _PROGRESS_FIELD_CACHE[key] = (time.time(), result)
    return result


def _find_enum_field(cfg, project_gid, field_name):
    """A project's custom enum field literally named `field_name` (case-
    insensitive), with option gids keyed by lowercase name. None if absent."""
    for cfs in _custom_field_settings(cfg, project_gid):
        cf = cfs.get("custom_field") or {}
        if (cf.get("name") or "").strip().lower() == field_name.lower():
            return {"gid": cf.get("gid"),
                   "options": {(o.get("name") or "").strip().lower(): o.get("gid")
                               for o in (cf.get("enum_options") or [])}}
    return None


def _task_progress_field(cfg, project_gid):
    return _find_enum_field(cfg, project_gid, "Task Progress")


# ── Priority (Asana's own "Priority" custom field, matched by name like Task
# Progress) — Nexus has 4 levels (low/medium/high/urgent), this project's Asana
# field only has 3 (High/Medium/Low): urgent has no distinct Asana equivalent,
# so it maps onto "High" outbound. Inbound is necessarily lossy the same way —
# Asana can never tell Nexus "urgent", only "high".
_BUILTIN_PRIORITY_LABELS = {"low": "low", "medium": "medium", "high": "high", "urgent": "high"}
_PRIORITY_LABEL_TO_VALUE = {"low": "low", "medium": "medium", "high": "high"}


def _priority_field(cfg, project_gid):
    return _find_enum_field(cfg, project_gid, "Priority")


def _priority_from_custom_fields(at):
    for cf in at.get("custom_fields") or []:
        if (cf.get("name") or "").strip().lower() == "priority":
            return ((cf.get("enum_value") or {}).get("name") or "").strip().lower()
    return ""


def _ancestor_project_gid(db, task, cfg):
    """A subtask has no project_id of its own (Nexus convention — see
    _apply_inbound/asana_import.py); custom-field lookups (Task Progress,
    Priority) live on the project, so walk up parent_task_id to the top-level
    ancestor and resolve ITS project instead."""
    t = task
    seen = set()
    while t.parent_task_id and t.parent_task_id not in seen:
        seen.add(t.parent_task_id)
        parent = db.query(models.Task).filter(models.Task.id == t.parent_task_id).first()
        if not parent:
            break
        t = parent
    return _asana_project_for(db, t, cfg)


def _push_dependencies(db, cfg, task, asana_gid):
    """Best-effort outbound dependency push: only blockers already linked to an
    Asana task can be expressed there; others are silently skipped and pick up
    on a later push once that task is synced too. Uses Asana's additive
    addDependencies action — never removes an Asana-side dependency that was
    removed on the Nexus side, matching this module's one-way-additive stance
    elsewhere (see _sync_project_access)."""
    if not task.blocked_by_ids:
        return
    dep_gids = [l.asana_gid for l in
               db.query(models.AsanaTaskLink)
               .filter(models.AsanaTaskLink.nexus_task_id.in_(task.blocked_by_ids)).all()
               if l.asana_gid]
    if dep_gids:
        try:
            _asana_post(cfg.token, f"/tasks/{asana_gid}/addDependencies", {"data": {"dependencies": dep_gids}})
        except Exception:
            pass


# ── OUTBOUND: Nexus task -> Asana ────────────────────────────────────────────
def push_task(db, task):
    """Create or update the Asana counterpart of a Nexus task (subtasks included
    — see _ancestor_project_gid). Returns the gid or None. Skips when disabled,
    unmapped, or unchanged since the last sync."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        return None
    parent_link = None
    if task.parent_task_id:
        # A subtask can only be created once its parent already has an Asana
        # counterpart — Asana attaches it via the parent's gid, not a project.
        parent_link = _link_by_nexus(db, task.parent_task_id)
        if not parent_link or not parent_link.asana_gid:
            return None
        apid = ""
    else:
        apid = _asana_project_for(db, task, cfg)
        if not apid:
            return None
    progress_apid = _ancestor_project_gid(db, task, cfg)
    link = _link_by_nexus(db, task.id)
    digest = _task_digest(db, task)
    if link and link.last_hash == digest:
        # blocked_by_ids/follower_emails/tags aren't part of the digest — all
        # three are pushed via separate additive Asana actions, not task field
        # PUTs (tags: CONFIRMED live that Asana's PUT rejects a `tags` field
        # outright — "Cannot write this property") — so a change to only one
        # of them would otherwise never reach these at all. Always attempt
        # them here even when nothing else changed.
        _push_dependencies(db, cfg, task, link.asana_gid)
        _push_followers(cfg, task, link.asana_gid)
        _push_tags(Asana(cfg.token), cfg, task, link.asana_gid)
        return link.asana_gid   # no other change (or the change came from a sync)

    fields = {
        "name": task.title or "(untitled)",
        "notes": task.description or "",
        "start_on": (task.start_on or "")[:10] or None,
        "due_on": (task.due_on or "")[:10] or None,
        "completed": bool(task.completed),
    }
    # Asana rejects start_on >= due_on on some plans; drop it rather than 400
    # the whole update over a field that's secondary to due_on.
    if fields["start_on"] and fields["due_on"] and fields["start_on"] > fields["due_on"]:
        fields["start_on"] = None
    # CONFIRMED live: Asana rejects any start_on at all on a milestone
    # ("You cannot set a start date on a milestone") — milestones only have
    # due_on. Drop it for milestones instead of 400ing the whole push.
    if task.is_milestone:
        fields["start_on"] = None
    # Assignee: map the Nexus work email to an Asana user. Unassigned in Nexus →
    # unassign in Asana; assigned to someone not in Asana → leave Asana as-is.
    ae = (task.assignee_email or "").lower()
    if not ae:
        fields["assignee"] = None
    else:
        gid = _user_map(cfg).get(ae)
        if gid:
            fields["assignee"] = gid
    custom_fields = {}
    progress_field = _task_progress_field(cfg, progress_apid)
    if progress_field:
        option_gid = progress_field["options"].get(_status_progress_label(db, task))
        if option_gid:
            custom_fields[progress_field["gid"]] = option_gid
    priority_field = _priority_field(cfg, progress_apid)
    if priority_field:
        option_gid = priority_field["options"].get(_BUILTIN_PRIORITY_LABELS.get(task.priority, "medium"))
        if option_gid:
            custom_fields[priority_field["gid"]] = option_gid
    if custom_fields:
        fields["custom_fields"] = custom_fields
    is_new = not (link and link.asana_gid) and not parent_link
    is_new_subtask = not (link and link.asana_gid) and bool(parent_link)
    if (is_new or is_new_subtask) and task.is_milestone:
        # resource_subtype is only settable at creation — Asana treats it as
        # immutable afterward, so this never appears on the PUT path below.
        fields["resource_subtype"] = "milestone"
    if link and link.asana_gid:
        _asana_put(cfg.token, f"/tasks/{link.asana_gid}", {"data": fields})
    elif parent_link:
        created = _asana_post(cfg.token, f"/tasks/{parent_link.asana_gid}/subtasks", {"data": fields})
        gid = (created or {}).get("gid")
        if not gid:
            return None
        link = models.AsanaTaskLink(id=gen_id(), nexus_task_id=task.id, asana_gid=gid)
        db.add(link)
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
    _push_dependencies(db, cfg, task, link.asana_gid)
    _push_followers(cfg, task, link.asana_gid)
    _push_tags(Asana(cfg.token), cfg, task, link.asana_gid)
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
            if t:
                push_task(db, t)   # push_task itself no-ops a subtask until its parent is linked
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


def push_all(db):
    """Seed/refresh: push every task (subtasks included) in a mapped Nexus
    project to Asana, plus any of their comments that haven't synced out yet.
    Pushed level by level — top-level tasks first, then their direct children,
    then grandchildren — so a subtask's parent always already has an Asana
    counterpart by the time push_task needs its gid (see _ancestor_project_gid
    / the parent_link check in push_task).

    Comments are included here because on_comment_added — the normal path —
    is gated by is_sync_worker() same as on_task_changed, but unlike tasks
    (which had this push_all as an explicit manual bypass already), comments
    had NO bypass at all: locally, or on any instance that loses the
    sync-worker race, a comment could never reach Asana by any means. This
    closes that gap the same way push_task already covers task edits made
    while sync was off — a comment just sits unsynced (no AsanaCommentLink)
    until the next push_all catches it up."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    mapped = {pm.nexus_project_id for pm in db.query(models.AsanaProjectMap).all()}
    n = 0
    level = [t for t in db.query(models.Task).filter(models.Task.parent_task_id == "").all()
            if (t.project_id in mapped) or cfg.default_project_gid]
    while level:
        for t in level:
            try:
                if push_task(db, t):
                    n += 1
                for c in db.query(models.TaskComment).filter(models.TaskComment.task_id == t.id).all():
                    if not db.query(models.AsanaCommentLink).filter(
                            models.AsanaCommentLink.nexus_comment_id == c.id).first():
                        try:
                            push_comment(db, c)
                        except Exception:
                            pass
            except ImportError_:
                raise
            except Exception:
                pass
        parent_ids = [t.id for t in level]
        level = db.query(models.Task).filter(models.Task.parent_task_id.in_(parent_ids)).all()
    return {"pushed": n}


# ── INBOUND: Asana -> Nexus (poll) ───────────────────────────────────────────
# Reverse of _BUILTIN_STATUS_LABELS for the unambiguous built-in states only —
# "Waiting"/"Deferred" (or any other custom option) have no fixed Nexus
# equivalent, so an unrecognized value just leaves Nexus's status untouched
# rather than guessing.
_PROGRESS_LABEL_TO_STATUS = {"not started": "not_started", "in progress": "in_progress", "done": "completed"}


def _progress_from_custom_fields(at):
    for cf in at.get("custom_fields") or []:
        if (cf.get("name") or "").strip().lower() == "task progress":
            return ((cf.get("enum_value") or {}).get("name") or "").strip().lower()
    return ""


def _apply_inbound(db, at, nexus_project_id, counts, parent_task_id=""):
    """Apply one Asana task into Nexus (create or update). `parent_task_id` set
    means this is a subtask — matches asana_import.py's convention of an empty
    project_id on subtasks (their project is reached via the parent). Returns
    the Nexus task id."""
    from routers.tasks import _next_code
    gid = at["gid"]
    assignee = ((at.get("assignee") or {}).get("email") or "").lower()
    progress_label = _progress_from_custom_fields(at)
    mapped_status = _PROGRESS_LABEL_TO_STATUS.get(progress_label)
    priority_label = _priority_from_custom_fields(at)
    mapped_priority = _PRIORITY_LABEL_TO_VALUE.get(priority_label)
    tag_names = [(tg.get("name") or "").strip() for tg in (at.get("tags") or []) if (tg.get("name") or "").strip()]
    is_milestone = at.get("resource_subtype") == "milestone"
    follower_emails = sorted({(f.get("email") or "").lower()
                              for f in (at.get("followers") or []) if f.get("email")})
    link = _link_by_asana(db, gid)
    inbound_digest = _digest(at.get("name"), at.get("notes"), at.get("due_on"), bool(at.get("completed")),
                             assignee, progress_label, priority_label,
                             at.get("start_on"), tag_names, is_milestone)
    if link:
        t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
        if not t:
            return None
        if link.last_hash != inbound_digest:
            t.title = at.get("name") or t.title
            t.description = at.get("notes") or ""
            t.start_on = (at.get("start_on") or "")[:10]
            t.due_on = (at.get("due_on") or "")[:10]
            t.assignee_email = assignee
            t.tags = tag_names
            t.is_milestone = is_milestone
            # Additive only, like the outbound side — a follower removed in
            # Asana keeps following in Nexus, matching this module's one-way-
            # additive stance elsewhere (dependencies, project access).
            t.follower_emails = sorted(set(t.follower_emails or []) | set(follower_emails))
            # Asana's native `completed` checkbox and the "Task Progress"
            # custom field are independent — someone can set the field to
            # "Done" without also ticking completed. Nexus has no such split
            # (status=='completed' and the completed bool must always agree,
            # per update_task's own convention), so a "Done" Task Progress
            # forces completed=True here too rather than leaving them to
            # disagree.
            t.completed = bool(at.get("completed")) or mapped_status == "completed"
            if t.completed:
                t.status = "completed"
                t.completed_at = t.completed_at or now_iso()
            elif t.status == "completed":
                t.status = "not_started"
                t.completed_at = ""
            if mapped_status and mapped_status != "completed" and not t.completed:
                t.status = mapped_status
            if mapped_priority:
                t.priority = mapped_priority
            t.modified_at = now_iso()
            link.last_hash = _task_digest(db, t)
            link.last_synced_at = now_iso()
            counts["updated"] += 1
            aid = log_activity(db, type="synced_from_asana", actor_email="asana-sync", entity_id=t.id,
                               entity_code=t.code, entity_title=t.title, detail="Updated from Asana")
            t.activity_ids = list(t.activity_ids or []) + [aid]
        return t.id
    # No link yet — before creating, try to adopt a matching Nexus task (same
    # title, same project, not already linked) so Pull doesn't duplicate work
    # that already exists in Nexus.
    name = at.get("name") or "(untitled)"
    match = (db.query(models.Task)
             .filter(models.Task.project_id == (nexus_project_id or ""),
                     models.Task.title == name,
                     models.Task.parent_task_id == (parent_task_id or "")).first())
    if match and not _link_by_nexus(db, match.id):
        db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=match.id, asana_gid=gid,
                                    last_hash=_task_digest(db, match), last_synced_at=now_iso()))
        counts.setdefault("linked", 0)
        counts["linked"] += 1
        return match.id
    now = now_iso()
    # See the same note in the update branch above: a "Done" Task Progress
    # implies completed even if Asana's own checkbox wasn't also ticked.
    completed = bool(at.get("completed")) or mapped_status == "completed"
    t = models.Task(
        id=gen_id(), code=_next_code(db), title=at.get("name") or "(untitled)",
        description=at.get("notes") or "", type="milestone" if is_milestone else "task",
        status="completed" if completed else (mapped_status or "not_started"),
        priority=mapped_priority or "medium",
        assignee_email=assignee, project_id="" if parent_task_id else (nexus_project_id or ""),
        parent_task_id=parent_task_id or "", start_on=(at.get("start_on") or "")[:10],
        due_on=(at.get("due_on") or "")[:10],
        completed=completed, completed_at=now if completed else "", is_milestone=is_milestone,
        follower_emails=follower_emails, liked_by_emails=[], subtask_ids=[], blocked_by_ids=[],
        blocking_ids=[], dependency_types={}, tags=tag_names, custom_field_values={},
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by="asana-sync",
    )
    db.add(t)
    db.flush()
    if parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == parent_task_id).first()
        if parent:
            parent.subtask_ids = list(parent.subtask_ids or []) + [t.id]
    db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=t.id, asana_gid=gid,
                                last_hash=_task_digest(db, t), last_synced_at=now))
    counts["created"] += 1
    aid = log_activity(db, type="synced_from_asana", actor_email="asana-sync", entity_id=t.id,
                       entity_code=t.code, entity_title=t.title, detail="Created from Asana")
    t.activity_ids = list(t.activity_ids or []) + [aid]
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


# Small files are downloaded and stored inline as a data: URI (same as the
# task_config.py one-shot importer); anything larger, or hosted externally
# (Google Drive/Dropbox etc — host != "asana"), just keeps its Asana view URL
# rather than pulling the bytes through this API.
_ATTACHMENT_MAX_BYTES = int(5 * 1024 * 1024)


def _pull_attachments(db, asana, asana_gid, nexus_task_id, counts):
    """Bring Asana attachments into the Nexus task, deduped by attachment gid
    (AsanaAttachmentLink) — inbound only, Nexus attachments aren't pushed back
    to Asana (would need fetching a possibly-private Supabase URL and
    re-uploading; out of scope here)."""
    counts.setdefault("attachments", 0)
    try:
        rows = asana.get(f"/tasks/{asana_gid}/attachments",
                         opt_fields="name,download_url,permanent_url,view_url,size,host")
    except Exception:
        return
    for a in rows:
        agid = a.get("gid")
        if not agid or db.query(models.AsanaAttachmentLink).filter(
                models.AsanaAttachmentLink.asana_attachment_gid == agid).first():
            continue
        name = a.get("name") or "attachment"
        size = a.get("size") or 0
        kind = "image" if (mimetypes.guess_type(name)[0] or "").startswith("image/") else "doc"
        host = a.get("host") or ""
        url = ""
        if host and host != "asana":
            url = a.get("permanent_url") or a.get("view_url") or a.get("download_url") or ""
        else:
            dl = a.get("download_url")
            if dl and 0 < size <= _ATTACHMENT_MAX_BYTES:
                try:
                    with urllib.request.urlopen(dl, timeout=90) as r:
                        raw = r.read()
                    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                    url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
                except Exception:
                    url = a.get("view_url") or dl or ""
            else:
                url = a.get("view_url") or dl or ""
        if not url:
            continue
        aid = gen_id()
        db.add(models.TaskAttachment(id=aid, task_id=nexus_task_id, name=name,
                                     size=f"{max(1, round(size / 1024))} KB", kind=kind, url=url,
                                     added_at=now_iso(), added_by="asana-sync"))
        t = db.query(models.Task).filter(models.Task.id == nexus_task_id).first()
        if t:
            t.attachment_ids = list(t.attachment_ids or []) + [aid]
        db.add(models.AsanaAttachmentLink(id=gen_id(), nexus_attachment_id=aid,
                                          asana_attachment_gid=agid, created_at=now_iso()))
        counts["attachments"] += 1


def _sync_task_dependencies(db, at, nexus_task_id):
    """Mirror Asana's dependencies/dependents onto Nexus's blocked_by_ids/
    blocking_ids, resolved via AsanaTaskLink. Best-effort and self-healing: a
    dependency on an Asana task not yet synced into Nexus is simply dropped
    this round (nothing to link to yet) and picked up automatically once that
    task exists, since this always re-resolves fresh from Asana's current list
    rather than accumulating stale entries. New dependency_types default to
    "FS" (Finish-to-Start) — Asana's dependency model has no FS/SS/FF/SF
    distinction, so that's the closest sensible default; existing types for
    blockers that persist are left alone."""
    t = db.query(models.Task).filter(models.Task.id == nexus_task_id).first()
    if not t:
        return

    def _resolve(refs):
        ids = []
        for r in refs or []:
            link = _link_by_asana(db, r.get("gid"))
            if link and link.nexus_task_id and link.nexus_task_id not in ids:
                ids.append(link.nexus_task_id)
        return ids

    blocked_by = _resolve(at.get("dependencies"))
    blocking = _resolve(at.get("dependents"))
    if blocked_by != (t.blocked_by_ids or []):
        t.blocked_by_ids = blocked_by
        existing_types = t.dependency_types or {}
        t.dependency_types = {bid: existing_types.get(bid, "FS") for bid in blocked_by}
    if blocking != (t.blocking_ids or []):
        t.blocking_ids = blocking


# Asana fires several webhook events in a burst for one new/changed task (create,
# then separate events per field set), each spawning its own trigger_pull_async()
# thread. Without serializing, concurrent pull() runs all see "no link yet" for
# the same Asana task at once and each create their own duplicate Nexus task —
# the same class of dedupe race that bit us with batched notifications
# (see CLAUDE.md). This threading.Lock only serializes threads within ONE
# process, though — gunicorn runs 8 worker processes per instance (startup.sh)
# and is_sync_worker() qualifies all of them, so webhook events landing on
# different workers still raced each other (Jul 2026: one Asana task showed up
# 4x in Nexus dev). Kept as a cheap first line of defense for same-process bursts;
# _acquire_pull_lock below is what actually closes the cross-process race.
_PULL_LOCK = threading.Lock()

# Arbitrary fixed key for Postgres's advisory-lock keyspace — any int works, it
# just has to be the same constant every time so all workers contend for the
# same lock.
_ASANA_PULL_LOCK_KEY = 728100177


def _acquire_pull_lock(db):
    """Cross-process serialization for pull(): a transaction-scoped Postgres
    advisory lock, held by whichever gunicorn worker gets it first and
    auto-released on that transaction's commit/rollback (so a killed worker
    can never leave it stuck locked). No-op on local SQLite, where there's only
    ever one process and the threading.Lock above already covers it."""
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ASANA_PULL_LOCK_KEY})


def _team_users(asana, team_gid):
    out = []
    try:
        for u in asana.get(f"/teams/{team_gid}/users", opt_fields="email"):
            em = (u.get("email") or "").lower()
            if em:
                out.append(em)
    except Exception:
        pass
    return out


# {(token, workspace_gid): (ts, {name_lower: gid})} — workspace teams, for
# resolving AsanaProjectMap.extra_team_names (see that column's docstring).
_WORKSPACE_TEAMS_CACHE = {}
_WORKSPACE_TEAMS_TTL = 600


def _workspace_team_gid(asana, cfg, name):
    key = (cfg.token, cfg.workspace_gid)
    ent = _WORKSPACE_TEAMS_CACHE.get(key)
    if not ent or time.time() - ent[0] >= _WORKSPACE_TEAMS_TTL:
        by_name = {}
        if cfg.workspace_gid:
            try:
                for t in asana.get(f"/organizations/{cfg.workspace_gid}/teams", opt_fields="name"):
                    nm = (t.get("name") or "").strip().lower()
                    if nm:
                        by_name[nm] = t.get("gid")
            except Exception:
                pass
        ent = (time.time(), by_name)
        _WORKSPACE_TEAMS_CACHE[key] = ent
    return ent[1].get(name.strip().lower())


def _ensure_team(db, nexus_project_id, name):
    """Find-or-create the TaskTeam named `name` for this project. Prefers a team
    already scoped to this exact project; failing that, adopts an unassigned
    team (project_id="") of the same name — e.g. one someone created locally
    ahead of running sync — by assigning it here, rather than creating a
    duplicate. A team already scoped to a DIFFERENT project is left alone
    (TaskTeam belongs to at most one project; stealing it would break that
    project's access) and a fresh one is created instead."""
    name_key = name.strip().lower()
    candidates = db.query(models.TaskTeam).filter(
        (models.TaskTeam.project_id == nexus_project_id) | (models.TaskTeam.project_id == "")
    ).all()
    scoped = next((t for t in candidates
                  if t.project_id == nexus_project_id and (t.name or "").strip().lower() == name_key), None)
    if scoped:
        return scoped
    unassigned = next((t for t in candidates
                       if t.project_id == "" and (t.name or "").strip().lower() == name_key), None)
    if unassigned:
        unassigned.project_id = nexus_project_id
        return unassigned
    match = models.TaskTeam(id=gen_id(), project_id=nexus_project_id, name=name,
                            color="", icon="", member_emails=[], created_at=now_iso())
    db.add(match)
    db.flush()
    return match


def _sync_project_access(db, asana, cfg, project_gid, nexus_project_id, extra_team_names=None):
    """Pull Asana's project-level access into real Nexus visibility, not just a
    display list: task_util.visible_project_ids() grants a restricted project's
    visibility via TaskProject.member_emails or via membership in a TaskTeam
    assigned to that project, so this is additive on top of both.

    Three access sources:
    - /projects/{gid}/project_memberships — individual users; the person is
      under the `user` key (NOT `member` — an earlier version of this function
      read the wrong key and silently synced nothing). Goes straight onto
      TaskProject.member_emails.
    - /projects/{gid}'s own `team` field — the project's OWNING team, if any.
      Matched/created by name via _ensure_team.
    - `extra_team_names` (AsanaProjectMap.extra_team_names) — a manual
      operator override for ad-hoc-shared teams. CONFIRMED live (Jul 2026,
      full unfiltered /projects/{gid}, project_memberships, and two guessed
      endpoints) that Asana's REST API has NO field or route exposing "team X
      was ad-hoc-invited to project Y via the Share dialog" when the project's
      own `team` is null — every project this bit us on had team=null and only
      individual users in members/followers/project_memberships. Since the API
      genuinely cannot tell us, the operator names the team once (the Two-way
      Sync panel); each pull re-resolves it in the Asana workspace by name and
      refreshes its roster via the same find-or-create-by-name mechanism as
      the owning-team case, so it stays current without needing to be
      re-entered.

    One-way and additive only, same as the rest of this module — someone
    removed from the Asana side keeps whatever Nexus access they already have
    (mirrors unlink_deleted_task's "Asana deletion doesn't delete the Nexus
    side"). Asana guest accounts are frequently a relay address (e.g.
    ...@xyz.onmicrosoft.com) that doesn't match the person's real Nexus email —
    those simply won't grant anything, same limitation push_task's assignee
    mapping already has."""
    if not nexus_project_id:
        return
    project = db.query(models.TaskProject).filter(models.TaskProject.id == nexus_project_id).first()
    if not project:
        return
    wanted = set()
    try:
        memberships = asana.get(f"/projects/{project_gid}/project_memberships",
                                opt_fields="user.email")
        for row in memberships:
            em = ((row.get("user") or {}).get("email") or "").lower()
            if em:
                wanted.add(em)
    except Exception:
        pass
    try:
        proj = asana.get(f"/projects/{project_gid}", opt_fields="team.gid,team.name,name,notes")
        # Kept refreshed on every pull — previously only ever set once at
        # creation (one-shot import / first Pull), so a rename in Asana never
        # reached Nexus after that.
        if proj.get("name"):
            project.name = proj["name"]
        project.description = proj.get("notes") or ""
        team = (proj or {}).get("team") or {}
        team_gid, team_name = team.get("gid"), (team.get("name") or "").strip()
        if team_gid and team_name:
            roster = _team_users(asana, team_gid)
            if roster:
                nt = _ensure_team(db, nexus_project_id, team_name)
                nt.member_emails = sorted(set(nt.member_emails or []) | set(roster))
    except Exception:
        pass
    for name in extra_team_names or []:
        name = (name or "").strip()
        if not name:
            continue
        team_gid = _workspace_team_gid(asana, cfg, name)
        if not team_gid:
            continue   # named team not found in the workspace this round — try again next pull
        roster = _team_users(asana, team_gid)
        if roster:
            nt = _ensure_team(db, nexus_project_id, name)
            nt.member_emails = sorted(set(nt.member_emails or []) | set(roster))
    if wanted - set(project.member_emails or []):
        project.member_emails = sorted(set(project.member_emails or []) | wanted)


# Shared field list for the top-level task list AND the recursive subtask
# fetch, so both carry everything _apply_inbound/_pull_attachments/
# _sync_task_dependencies need.
_TASK_OPT_FIELDS = ("name,notes,start_on,due_on,completed,assignee.email,modified_at,"
                   "custom_fields.name,custom_fields.enum_value.name,"
                   "dependencies,dependents,tags.name,resource_subtype,followers.email")


def _pull_task_tree(db, asana, at, nexus_project_id, parent_task_id, counts):
    """Apply one Asana task (and recursively its subtasks) into Nexus: fields,
    comments, attachments, dependencies. Depth-first so a child's parent link
    always exists before the child needs it (dependency/subtask resolution)."""
    nexus_task_id = _apply_inbound(db, at, nexus_project_id, counts, parent_task_id=parent_task_id)
    if not nexus_task_id:
        return
    gid = at["gid"]
    _pull_comments(db, asana, gid, nexus_task_id, counts)
    _pull_attachments(db, asana, gid, nexus_task_id, counts)
    _sync_task_dependencies(db, at, nexus_task_id)
    try:
        subtasks = asana.get(f"/tasks/{gid}/subtasks", opt_fields=_TASK_OPT_FIELDS)
    except Exception:
        subtasks = []
    for sub in subtasks:
        _pull_task_tree(db, asana, sub, nexus_project_id, nexus_task_id, counts)


def pull(db):
    """Poll every mapped Asana project and apply changes into Nexus: tasks
    (subtasks included), comments, attachments, dependencies, status/priority
    custom fields, and project access. Relies on the digest / comment- and
    attachment-link tables to skip unchanged ones (no premium modified_since
    filter yet)."""
    cfg = get_config(db)
    if not cfg.enabled or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    with _PULL_LOCK:
        _acquire_pull_lock(db)
        asana = Asana(cfg.token)
        counts = {"created": 0, "updated": 0, "comments": 0}
        for pm in db.query(models.AsanaProjectMap).all():
            if not pm.asana_project_gid:
                continue
            rows = asana.get(f"/projects/{pm.asana_project_gid}/tasks", opt_fields=_TASK_OPT_FIELDS)
            for at in rows:
                _pull_task_tree(db, asana, at, pm.nexus_project_id, "", counts)
            _sync_project_access(db, asana, cfg, pm.asana_project_gid, pm.nexus_project_id, pm.extra_team_names)
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
