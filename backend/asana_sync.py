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
    """{Asana account email -> gid}, additionally keyed by the bare local part.

    The local-part key is the outbound half of _map_email: a person stored in
    Nexus as sagar.shoundik@greensglobal.com whose Asana account is the guest
    relay sagar.shoundik@greensg.onmicrosoft.com would otherwise never resolve,
    so pushing an assignee or a follower silently did nothing. Ambiguous local
    parts are dropped rather than guessed at, same rule as the inbound side."""
    if not cfg.workspace_gid or not cfg.token:
        return {}
    key = (cfg.token, cfg.workspace_gid)
    ent = _USER_CACHE.get(key)
    if ent and time.time() - ent[0] < _USER_TTL:
        return ent[1]
    out, by_local = {}, {}
    try:
        for u in Asana(cfg.token).get(f"/workspaces/{cfg.workspace_gid}/users", opt_fields="email"):
            em = (u.get("email") or "").lower()
            if em:
                out[em] = u["gid"]
                by_local.setdefault(em.split("@", 1)[0], set()).add(u["gid"])
    except Exception:
        pass
    for local, gids in by_local.items():
        if len(gids) == 1 and local:
            out.setdefault(local, next(iter(gids)))
    _USER_CACHE[key] = (time.time(), out)
    return out


def _asana_user_gid(cfg, email):
    """The Asana user gid for a Nexus work email — exact match first, then the
    local part (see _user_map)."""
    e = (email or "").strip().lower()
    if not e:
        return None
    users = _user_map(cfg)
    return users.get(e) or users.get(e.split("@", 1)[0])


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
    gids = [g for g in (_asana_user_gid(cfg, e) for e in emails) if g]
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
           start_on="", tags=None, milestone=False, section=""):
    raw = "\x1f".join([title or "", description or "", (due_on or "")[:10],
                       "1" if completed else "0", (assignee or "").lower(), (progress or "").lower(),
                       (priority or "").lower(), (start_on or "")[:10],
                       ",".join(sorted((t or "").strip().lower() for t in (tags or []))),
                       "1" if milestone else "0", (section or "").strip().lower()])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _nexus_section_name(db, t):
    if not t.section_id:
        return ""
    s = db.query(models.TaskSection).filter(models.TaskSection.id == t.section_id).first()
    return (s.name or "").strip() if s else ""


def _task_digest(db, t):
    return _digest(t.title, t.description, t.due_on, bool(t.completed), t.assignee_email,
                   _status_progress_label(db, t), _BUILTIN_PRIORITY_LABELS.get(t.priority, ""),
                   t.start_on, t.tags, bool(t.is_milestone), _nexus_section_name(db, t))


def _push_digest(db, t):
    """Digest of everything Asana takes only through a separate additive call
    (see AsanaTaskLink.last_push_hash). Deliberately NOT part of _digest: that
    one has to be reproducible from an Asana payload for loop prevention, and
    these have no comparable inbound form."""
    dep_gids = sorted(_link_by_nexus(db, bid).asana_gid
                      for bid in (t.blocked_by_ids or [])
                      if _link_by_nexus(db, bid) and _link_by_nexus(db, bid).asana_gid)
    att_ids = sorted(a.id for a in db.query(models.TaskAttachment).filter(
        models.TaskAttachment.task_id == t.id).all())
    raw = "\x1f".join([
        ",".join(sorted((x or "").strip().lower() for x in (t.tags or []))),
        ",".join(sorted((e or "").lower() for e in (t.follower_emails or []))),
        ",".join(dep_gids), ",".join(att_ids), _nexus_section_name(db, t).lower(),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


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


# {(token, project_gid): (ts, {name_lower: gid})} — Asana sections, find-or-
# create by name, same shape as _TAG_CACHE / _WORKSPACE_TEAMS_CACHE.
_SECTION_CACHE = {}
_SECTION_TTL = 300


def _asana_section_gid(cfg, project_gid, name):
    key = (cfg.token, project_gid)
    ent = _SECTION_CACHE.get(key)
    if not ent or time.time() - ent[0] >= _SECTION_TTL:
        by_name = {}
        try:
            for s in Asana(cfg.token).get(f"/projects/{project_gid}/sections", opt_fields="name"):
                nm = (s.get("name") or "").strip().lower()
                if nm:
                    by_name[nm] = s.get("gid")
        except Exception:
            pass
        ent = (time.time(), by_name)
        _SECTION_CACHE[key] = ent
    key_name = name.strip().lower()
    gid = ent[1].get(key_name)
    if gid:
        return gid
    try:
        created = _asana_post(cfg.token, f"/projects/{project_gid}/sections",
                              {"data": {"name": name.strip()}})
        gid = (created or {}).get("gid")
        if gid:
            ent[1][key_name] = gid
    except Exception:
        return None
    return gid


def _push_section(db, cfg, task, asana_gid, project_gid):
    """Move the Asana task into the section matching its Nexus one. Asana
    expresses this as an addProject action carrying a section gid — there is no
    writable `section` field on the task itself. Subtasks have no section in
    either system, so they're skipped by the caller."""
    name = _nexus_section_name(db, task)
    if not name or not project_gid:
        return
    sec_gid = _asana_section_gid(cfg, project_gid, name)
    if not sec_gid:
        return
    try:
        _asana_post(cfg.token, f"/tasks/{asana_gid}/addProject",
                    {"data": {"project": project_gid, "section": sec_gid}})
    except Exception:
        pass


def _push_attachments(db, cfg, task, asana_gid):
    """Push Nexus attachments to Asana as EXTERNAL attachments — Asana stores
    the link, we never re-upload bytes.

    Only http(s) URLs qualify. A `data:` URL is skipped by design, not by
    omission: those exist only because _pull_attachments inlined a small file
    that came FROM Asana, so the file is already there and pushing it back
    would duplicate it. Recorded in AsanaAttachmentLink — the same table the
    inbound side dedups on — so neither direction re-adds the other's work."""
    rows = db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == task.id).all()
    for a in rows:
        url = (a.url or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            continue
        if db.query(models.AsanaAttachmentLink).filter(
                models.AsanaAttachmentLink.nexus_attachment_id == a.id).first():
            continue
        try:
            created = _asana_post(cfg.token, "/attachments", {"data": {
                "resource_subtype": "external", "parent": asana_gid,
                "url": url, "name": a.name or "attachment"}})
        except Exception:
            continue
        db.add(models.AsanaAttachmentLink(id=gen_id(), nexus_attachment_id=a.id,
                                          asana_attachment_gid=(created or {}).get("gid") or "",
                                          created_at=now_iso()))


def _push_extras(db, cfg, task, asana_gid, project_gid):
    """Everything Asana only accepts as its own action rather than a task PUT.
    Grouped so the two call sites in push_task can't drift apart."""
    _push_dependencies(db, cfg, task, asana_gid)
    _push_followers(cfg, task, asana_gid)
    _push_tags(Asana(cfg.token), cfg, task, asana_gid)
    _push_attachments(db, cfg, task, asana_gid)
    if not task.parent_task_id:
        _push_section(db, cfg, task, asana_gid, project_gid)


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
    push_digest = _push_digest(db, task)
    if link and link.last_hash == digest:
        # The task's own fields are unchanged, but tags/followers/dependencies/
        # section/attachments aren't in that digest — they reach Asana through
        # separate additive actions, not a task PUT (tags: CONFIRMED live that
        # Asana's PUT rejects a `tags` field outright, "Cannot write this
        # property") — so a change to only one of them would otherwise never
        # be noticed. last_push_hash covers exactly those, which is what lets
        # the reconcile sweep skip an untouched task without firing a handful
        # of HTTP calls per task per sweep.
        if link.last_push_hash != push_digest:
            _push_extras(db, cfg, task, link.asana_gid, apid or progress_apid)
            link.last_push_hash = push_digest
            link.last_synced_at = now_iso()
            db.commit()
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
        gid = _asana_user_gid(cfg, ae)
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
    else:
        # CREATE PATH — the only place outbound can mint a duplicate, and the
        # one that bit us on dev but never on localhost: gunicorn runs 8 worker
        # PROCESSES there (startup.sh), all of which qualify as sync workers, so
        # two of them handling near-simultaneous edits to the same task each saw
        # "no link yet" and each created an Asana task plus a link row. A
        # threading.Lock can't see across processes; the same Postgres advisory
        # lock pull() uses can. Held only around create — updates can't
        # duplicate anything, so the common path stays unserialised.
        _acquire_pull_lock(db)
        link = _link_by_nexus(db, task.id)   # a worker that beat us to the lock may have made it
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
        db.flush()   # visible to _link_by_nexus for the rest of this transaction
    link.last_hash = digest
    link.last_synced_at = now_iso()
    db.commit()          # releases the advisory lock if the create path took it
    _push_extras(db, cfg, task, link.asana_gid, apid or progress_apid)
    link.last_push_hash = push_digest
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
            if t:
                push_task(db, t)   # push_task itself no-ops a subtask until its parent is linked
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


_MAX_DELETE_ATTEMPTS = 5


def push_task_deleted(db, asana_gid):
    """Delete a Nexus task's Asana counterpart. Asana's DELETE is a soft delete
    (it lands in the deleting user's trash for 30 days), so this is recoverable
    on the Asana side even though the Nexus row is already gone.

    Returns (done, error). `done` means the Asana task is not there any more —
    which includes a 404, since a task someone already deleted by hand is the
    outcome we wanted and must not be retried forever."""
    cfg = get_config(db)
    if not (cfg.enabled and cfg.token and cfg.delete_sync and asana_gid):
        return False, "sync disabled"
    try:
        _request("DELETE", f"{_ASANA_BASE}/tasks/{asana_gid}", _headers(cfg.token))
        return True, ""
    except ImportError_ as e:
        msg = str(e)
        if msg.startswith("HTTP 404"):
            return True, ""            # already gone — the desired end state
        return False, msg[:200]
    except Exception as e:
        return False, str(e)[:200]


def queue_task_delete(db, asana_gids, title="", code="", actor=""):
    """Record deletions owed to Asana. Called from delete_task INSIDE its
    transaction, so the tombstone commits together with the deletion — there is
    no window where the Nexus task is gone but the intent to delete its Asana
    counterpart isn't recorded. Does not commit."""
    for gid in {g for g in (asana_gids or []) if g}:
        db.add(models.AsanaPendingDelete(id=gen_id(), asana_gid=gid, task_title=title or "",
                                          task_code=code or "", requested_by=actor or "",
                                          attempts=0, last_error="", created_at=now_iso()))


def drain_pending_deletes(db):
    """Send every queued deletion to Asana. Safe to call from the automatic
    sweep and from a manual Push all — a row is removed once Asana confirms the
    task is gone, and a row that keeps failing is dropped after
    _MAX_DELETE_ATTEMPTS so the queue can't grow without bound.

    This is the manual path a laptop needs: on localhost the fire-and-forget
    push never runs (is_sync_worker is false), so without draining here a
    deletion made locally could never reach Asana by any means."""
    cfg = get_config(db)
    rows = db.query(models.AsanaPendingDelete).all()
    if not rows:
        return {"deleted": 0, "pending": 0}
    if not (cfg.enabled and cfg.token):
        return {"deleted": 0, "pending": len(rows)}
    if not cfg.delete_sync:
        # Deletion propagation is switched off — drop the queue rather than
        # hold tombstones that would fire if someone flips the toggle later.
        for r in rows:
            db.delete(r)
        db.commit()
        return {"deleted": 0, "pending": 0}
    done = 0
    for r in rows:
        ok, err = push_task_deleted(db, r.asana_gid)
        if ok:
            db.delete(r)
            done += 1
        else:
            r.attempts = (r.attempts or 0) + 1
            r.last_error = err
            if r.attempts >= _MAX_DELETE_ATTEMPTS:
                db.delete(r)
    db.commit()
    return {"deleted": done, "pending": db.query(models.AsanaPendingDelete).count()}


def on_task_deleted(asana_gids=None):
    """Fire-and-forget outbound delete, the mirror of on_task_changed. Drains
    the queue rather than taking gids directly — delete_task has already
    recorded them (queue_task_delete), so an immediate failure here just leaves
    the tombstone for the next sweep instead of losing the deletion. Never
    raises."""
    if not is_sync_worker():
        return
    def _run():
        db = SessionLocal()
        try:
            if get_config(db).enabled:
                drain_pending_deletes(db)
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


def linked_gids(db, task_ids):
    """Asana gids for the given Nexus tasks — read before a delete, since
    deleting the rows takes their AsanaTaskLink rows with them."""
    if not task_ids:
        return []
    return [l.asana_gid for l in db.query(models.AsanaTaskLink).filter(
        models.AsanaTaskLink.nexus_task_id.in_(list(task_ids))).all() if l.asana_gid]


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
    # Deletions last: they're queued tombstones, not rows this walk can reach.
    # This is what makes "Push all" a complete outbound sync — on a laptop it's
    # the ONLY way a locally deleted task ever reaches Asana.
    drained = drain_pending_deletes(db)
    return {"pushed": n, "deleted": drained["deleted"], "pendingDeletes": drained["pending"]}


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


def _adopt_candidate(db, name, nexus_project_id, parent_task_id):
    """An existing, not-yet-linked Nexus task that this Asana task should adopt
    instead of being created again — same title, same place in the hierarchy.

    Two things this gets right that the old inline query didn't, each of which
    was minting duplicates:

    - SCOPE. A subtask is stored with project_id="" (its project is reached
      through the parent — asana_import.py's convention, kept by _apply_inbound
      below). Scoping the lookup by nexus_project_id therefore never matched a
      subtask, so every subtask the one-shot Import had already created got a
      second, Pull-created copy.
    - CANDIDATES. It scanned only .first(). If that one row happened to be
      linked already (to this gid's twin, or to a different Asana task of the
      same name) adoption gave up and created a duplicate, even when another
      perfectly adoptable row was sitting right behind it. Walk them all,
      oldest first, and take the first unlinked one.
    """
    rows = (db.query(models.Task)
            .filter(models.Task.title == name,
                    models.Task.project_id == ("" if parent_task_id else (nexus_project_id or "")),
                    models.Task.parent_task_id == (parent_task_id or ""))
            .order_by(models.Task.created_at).all())
    for cand in rows:
        if not _link_by_nexus(db, cand.id):
            return cand
    return None


# {"all": (ts, {lookup key -> canonical work email})} — the Nexus people
# directory, for resolving Asana account addresses onto real people.
_DIRECTORY_CACHE = {}
_DIRECTORY_TTL = 300


def _nexus_directory(db):
    """Lookup table from anything Asana might call a person to their canonical
    Nexus work email.

    Keyed three ways, in the order _map_email tries them:
      - the work email itself       (sagar.shoundik@greensglobal.com)
      - a known personal email      (an Asana account opened with a private address)
      - the bare local part         ("sagar.shoundik")

    The local-part key is what turns an Asana guest address —
    sagar.shoundik@greensg.onmicrosoft.com, the M365 relay Asana shows for
    guest accounts — into the real person, without hardcoding that domain:
    anything whose local part uniquely identifies one employee resolves to
    them. Ambiguous local parts (two people, different domains, same name
    before the @) are deliberately left out rather than guessed at."""
    ent = _DIRECTORY_CACHE.get("all")
    if ent and time.time() - ent[0] < _DIRECTORY_TTL:
        return ent[1]
    table, by_local = {}, {}
    for e in db.query(models.NexusEmployee).all():
        work = (e.work_email or "").strip().lower()
        if not work:
            continue
        table[work] = work
        personal = (e.personal_email or "").strip().lower()
        if personal:
            table.setdefault(personal, work)
        by_local.setdefault(work.split("@", 1)[0], set()).add(work)
    for local, emails in by_local.items():
        if len(emails) == 1 and local:
            table.setdefault(local, next(iter(emails)))
    _DIRECTORY_CACHE["all"] = (time.time(), table)
    return table


def refresh_directory_cache():
    """Drop the cached directory so a run picks up people added since."""
    _DIRECTORY_CACHE.pop("all", None)


def _map_email(email, email_map=None, db=None):
    """Resolve an Asana account address to the Nexus work email that identifies
    the same person, so imported tasks show real people instead of an unmatched
    address with a blank avatar.

    Precedence: the operator's explicit map (the Import UI's email_map) wins,
    then the Nexus directory, then the address is kept as-is — an outside
    collaborator with no Nexus record still keeps their Asana address rather
    than being silently dropped."""
    e = (email or "").strip().lower()
    if not e:
        return ""
    override = (email_map or {}).get(e)
    if override:
        return override.strip().lower()
    if db is not None:
        table = _nexus_directory(db)
        if e in table:
            return table[e]
        local = e.split("@", 1)[0]
        if local in table:
            return table[local]
    return e


def _apply_inbound(db, at, nexus_project_id, counts, parent_task_id="", email_map=None):
    """Apply one Asana task into Nexus (create or update). `parent_task_id` set
    means this is a subtask — matches asana_import.py's convention of an empty
    project_id on subtasks (their project is reached via the parent). Returns
    the Nexus task id."""
    from routers.tasks import _next_code
    gid = at["gid"]
    assignee = _map_email((at.get("assignee") or {}).get("email"), email_map, db)
    progress_label = _progress_from_custom_fields(at)
    mapped_status = _PROGRESS_LABEL_TO_STATUS.get(progress_label)
    priority_label = _priority_from_custom_fields(at)
    mapped_priority = _PRIORITY_LABEL_TO_VALUE.get(priority_label)
    tag_names = [(tg.get("name") or "").strip() for tg in (at.get("tags") or []) if (tg.get("name") or "").strip()]
    is_milestone = at.get("resource_subtype") == "milestone"
    follower_emails = sorted({_map_email(f.get("email"), email_map, db)
                              for f in (at.get("followers") or []) if f.get("email")})
    section_name = _asana_section_name(at)
    link = _link_by_asana(db, gid)
    inbound_digest = _digest(at.get("name"), at.get("notes"), at.get("due_on"), bool(at.get("completed")),
                             assignee, progress_label, priority_label,
                             at.get("start_on"), tag_names, is_milestone, section_name)
    if link:
        t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
        if not t:
            return None
        # Compare Asana-now against Asana-at-last-apply. Comparing it against
        # last_hash (the NEXUS-side digest) meant every pull re-applied every
        # task whenever the Asana project had no Task Progress/Priority custom
        # fields, because those two digests can never converge in that case.
        # An empty last_inbound_hash is a link written before this column
        # existed — treat it as "unknown", apply once, and it settles.
        if link.last_inbound_hash != inbound_digest:
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
            # Sections are a top-level-task concept in both systems; a subtask
            # has none. Find-or-create by name so a section added in Asana shows
            # up as the same group in the Nexus list/board view.
            if not parent_task_id and section_name:
                t.section_id = _nexus_section_id(db, nexus_project_id, section_name)
            t.modified_at = now_iso()
            link.last_hash = _task_digest(db, t)
            link.last_inbound_hash = inbound_digest
            link.last_synced_at = now_iso()
            counts["updated"] += 1
            aid = log_activity(db, type="synced_from_asana", actor_email="asana-sync", entity_id=t.id,
                               entity_code=t.code, entity_title=t.title, detail="Updated from Asana")
            t.activity_ids = list(t.activity_ids or []) + [aid]
        return t.id
    # No link yet — before creating, try to adopt a matching Nexus task (same
    # title, same place in the hierarchy, not already linked) so Pull doesn't
    # duplicate work that already exists in Nexus.
    name = at.get("name") or "(untitled)"
    match = _adopt_candidate(db, name, nexus_project_id, parent_task_id)
    if match:
        db.add(models.AsanaTaskLink(id=gen_id(), nexus_task_id=match.id, asana_gid=gid,
                                    last_hash=_task_digest(db, match),
                                    last_inbound_hash=inbound_digest, last_synced_at=now_iso()))
        # Sessions run with autoflush=False (see CLAUDE.md), so an unflushed
        # link is INVISIBLE to _link_by_asana/_link_by_nexus for the rest of
        # this pull. Asana hands the same task to us twice whenever it is both
        # a project member and someone's subtask, and the second visit then saw
        # "no link yet" and created a whole second Nexus task — the duplicate
        # rows in the screenshot, and 120 gids carrying 2-5 links each in dev.
        db.flush()
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
        section_id="" if parent_task_id else _nexus_section_id(db, nexus_project_id, section_name),
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
                                last_hash=_task_digest(db, t), last_inbound_hash=inbound_digest,
                                last_synced_at=now))
    db.flush()   # visible to the rest of this pull — see the note above
    counts["created"] += 1
    aid = log_activity(db, type="synced_from_asana", actor_email="asana-sync", entity_id=t.id,
                       entity_code=t.code, entity_title=t.title, detail="Created from Asana")
    t.activity_ids = list(t.activity_ids or []) + [aid]
    return t.id


def delete_nexus_task(db, task, actor="asana-sync"):
    """Delete a Nexus task and everything hanging off it, mirroring
    routers.tasks.delete_task (which can't be reused here — it's a route
    handler wired to Depends and a live user). Subtasks go with the parent,
    same as deleting in the UI, and their Asana links go too so a later pull
    can't resurrect half a tree. Does not commit."""
    ids, frontier = {task.id}, [task.id]
    while frontier:
        children = db.query(models.Task).filter(models.Task.parent_task_id.in_(frontier)).all()
        frontier = [c.id for c in children if c.id not in ids]
        ids.update(frontier)
    if task.parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == task.parent_task_id).first()
        if parent:
            parent.subtask_ids = [x for x in (parent.subtask_ids or []) if x != task.id]
    # Clear every dangling pointer at the rows about to disappear.
    for other in db.query(models.Task).filter(models.Task.id.notin_(ids)).all():
        for field in ("blocked_by_ids", "blocking_ids", "subtask_ids"):
            cur = getattr(other, field) or []
            keep = [x for x in cur if x not in ids]
            if keep != cur:
                setattr(other, field, keep)
    # The story/attachment link rows key off comment and attachment ids, so
    # they have to be collected before those rows go. Left behind they would
    # permanently suppress re-importing that history if the task ever comes
    # back — the dedup check would keep matching a story gid whose Nexus row no
    # longer exists.
    comment_ids = [c.id for c in db.query(models.TaskComment).filter(
        models.TaskComment.task_id.in_(ids)).all()]
    attachment_ids = [a.id for a in db.query(models.TaskAttachment).filter(
        models.TaskAttachment.task_id.in_(ids)).all()]
    if comment_ids:
        db.query(models.AsanaCommentLink).filter(
            models.AsanaCommentLink.nexus_comment_id.in_(comment_ids)).delete(synchronize_session=False)
    if attachment_ids:
        db.query(models.AsanaAttachmentLink).filter(
            models.AsanaAttachmentLink.nexus_attachment_id.in_(attachment_ids)).delete(synchronize_session=False)
    db.query(models.AsanaActivityLink).filter(
        models.AsanaActivityLink.nexus_task_id.in_(ids)).delete(synchronize_session=False)
    for tid in ids:
        db.query(models.TaskComment).filter(models.TaskComment.task_id == tid).delete(synchronize_session=False)
        db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == tid).delete(synchronize_session=False)
        db.query(models.AsanaTaskLink).filter(
            models.AsanaTaskLink.nexus_task_id == tid).delete(synchronize_session=False)
    log_activity(db, type="deleted", actor_email=actor, entity_id=task.id, entity_code=task.code,
                 entity_title=task.title, detail="Deleted in Asana")
    db.query(models.Task).filter(models.Task.id.in_(ids)).delete(synchronize_session="fetch")
    return ids


def unlink_deleted_task(db, gid):
    """Handle an Asana task that no longer exists. A deleted Asana task never
    shows up in pull() again — its project's task list just omits it, there's
    no tombstone to poll for — so the webhook's 'deleted' event and _reap_deleted
    below are the only two signals we get.

    With delete_sync on (the default) the Nexus task is deleted to match.
    With it off we fall back to the old behaviour: drop the link and flag the
    task unsynced, leaving the Nexus row alone."""
    link = _link_by_asana(db, gid)
    if not link:
        return False
    t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
    if t and get_config(db).delete_sync:
        delete_nexus_task(db, t)          # takes the link with it
        db.commit()
        return True
    if t:
        t.synced_with_asana = False
        t.modified_at = now_iso()
    db.delete(link)
    db.commit()
    return True


# One Nexus task per Asana task, enforced by the database rather than only by
# the code above. Blank gids are excluded so a partially-written row can't trip
# it. Also listed in main.py's migration lists for fresh databases; repeated
# here because on a database that ALREADY has duplicates the migration silently
# fails (and is swallowed) — this is the moment it can finally be built.
_UNIQUE_LINK_INDEX = ("CREATE UNIQUE INDEX IF NOT EXISTS ux_asana_task_link_gid "
                      "ON asana_task_links (asana_gid) WHERE asana_gid <> ''")


def _merge_task(db, dup, keep):
    """Move everything worth keeping off `dup` onto `keep`, then delete `dup`."""
    db.query(models.TaskComment).filter(models.TaskComment.task_id == dup.id).update(
        {"task_id": keep.id}, synchronize_session=False)
    db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == dup.id).update(
        {"task_id": keep.id}, synchronize_session=False)
    db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == dup.id).update(
        {"entity_id": keep.id}, synchronize_session=False)
    # The activity ROWS move above; their Asana links carry their own copy of
    # the task id and have to follow, or they end up pointing at a task that no
    # longer exists — which then defeats delete_nexus_task's cleanup (it clears
    # these by nexus_task_id) and leaves permanent orphans behind.
    db.query(models.AsanaActivityLink).filter(
        models.AsanaActivityLink.nexus_task_id == dup.id).update(
        {"nexus_task_id": keep.id}, synchronize_session=False)
    for field in ("comment_ids", "attachment_ids", "activity_ids", "follower_emails",
                  "liked_by_emails", "tags"):
        merged = list(getattr(keep, field) or [])
        merged += [v for v in (getattr(dup, field) or []) if v not in merged]
        setattr(keep, field, merged)
    # Subtasks move across rather than being deleted with their parent.
    subs = db.query(models.Task).filter(models.Task.parent_task_id == dup.id).all()
    for sub in subs:
        sub.parent_task_id = keep.id
    if subs:
        keep.subtask_ids = list(keep.subtask_ids or []) + [s.id for s in subs
                                                          if s.id not in (keep.subtask_ids or [])]
    # Drop every remaining pointer at the row about to disappear.
    if dup.parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == dup.parent_task_id).first()
        if parent:
            parent.subtask_ids = [x for x in (parent.subtask_ids or []) if x != dup.id]
    for other in db.query(models.Task).filter(models.Task.id != dup.id).all():
        if dup.id in (other.blocked_by_ids or []):
            other.blocked_by_ids = [x for x in other.blocked_by_ids if x != dup.id]
        if dup.id in (other.blocking_ids or []):
            other.blocking_ids = [x for x in other.blocking_ids if x != dup.id]
        if dup.id in (other.subtask_ids or []):
            other.subtask_ids = [x for x in other.subtask_ids if x != dup.id]
    keep.modified_at = now_iso()
    db.delete(dup)


def _dedupe_sections(db, apply=False):
    """Collapse same-named sections within a project onto the oldest, moving
    their tasks across. These come from imports that ran before the section
    find-or-create existed and created one per run; the result is two identical
    groups side by side in the list/board view. Returns how many were removed."""
    by_project = {}
    for s in db.query(models.TaskSection).order_by(
            models.TaskSection.created_at, models.TaskSection.id).all():
        by_project.setdefault((s.project_id or "", (s.name or "").strip().lower()), []).append(s)
    removed = 0
    for (_pid, _name), rows in by_project.items():
        if len(rows) < 2 or not _pid:
            continue
        keep = rows[0]
        for dup in rows[1:]:
            removed += 1
            if apply:
                db.query(models.Task).filter(models.Task.section_id == dup.id).update(
                    {"section_id": keep.id}, synchronize_session=False)
                db.delete(dup)
    return removed


def normalize_people(db, apply=False):
    """Rewrite already-stored Asana account addresses to the Nexus work email
    of the same person (see _map_email).

    Rows written before that resolution existed still carry the raw address —
    …@greensg.onmicrosoft.com for a guest account — which matches nobody in the
    People directory, so the task shows an empty avatar and the person can't be
    filtered on. A linked task self-heals on the next pull (the mapped address
    is part of the inbound digest), but an unlinked one never would, and the
    member/follower lists are additive so a pull only ADDS the corrected
    address while the stale one lingers beside it. This fixes both.

    Addresses that resolve to nobody — a genuine outside collaborator — are
    left exactly as they are."""
    refresh_directory_cache()
    n = 0

    def fixed(email):
        e = (email or "").strip().lower()
        return _map_email(e, None, db) if e else e

    def fix_list(values):
        out = sorted({fixed(v) for v in (values or []) if v})
        return out if out != sorted(v.lower() for v in (values or []) if v) else None

    for t in db.query(models.Task).all():
        new_assignee = fixed(t.assignee_email)
        if new_assignee != (t.assignee_email or "").lower():
            n += 1
            if apply:
                t.assignee_email = new_assignee
        merged = fix_list(t.follower_emails)
        if merged is not None:
            n += 1
            if apply:
                t.follower_emails = merged
    for p in db.query(models.TaskProject).all():
        merged = fix_list(p.member_emails)
        if merged is not None:
            n += 1
            if apply:
                p.member_emails = merged
    for tm in db.query(models.TaskTeam).all():
        merged = fix_list(tm.member_emails)
        if merged is not None:
            n += 1
            if apply:
                tm.member_emails = merged
    for a in db.query(models.TaskActivity).filter(
            models.TaskActivity.actor_email != "").all():
        new_actor = fixed(a.actor_email)
        if new_actor != (a.actor_email or "").lower():
            n += 1
            if apply:
                a.actor_email = new_actor
    return n


def _survivor_rank(link_task):
    """Sort key picking which of several tasks sharing one Asana gid survives.

    PLACEMENT BEATS AGE. Oldest-wins alone is wrong and destructive: an orphan
    left over from an earlier era — a top-level row with no project_id and no
    parent, invisible in every project view — is older than the correctly filed
    row a fresh import just created, so plain age hands it the win and deletes
    the good one. (Observed exactly that: a re-imported project lost half its
    tasks to July orphans.) Rank a task that is actually placed ahead of one
    that isn't, and only then prefer the older row, which is the one people
    have been commenting on and linking to."""
    _link, t = link_task
    orphan = not (t.project_id or "").strip() and not (t.parent_task_id or "").strip()
    return (1 if orphan else 0, t.created_at or "", t.id)


def dedupe_tasks(db, apply=False):
    """Collapse Nexus tasks that all point at the SAME Asana task.

    Pull can no longer produce these (see the flush + _adopt_candidate notes
    above), but rows already written stay until they're merged — dev had 120
    Asana gids carrying 2-5 AsanaTaskLink rows each, which is exactly what a
    project looking like it imported every task three times is made of.

    The survivor is chosen by _survivor_rank — properly filed first, then
    oldest. Every duplicate hands its comments, attachments, activity and
    subtasks over before it is deleted, so nothing written on a duplicate is
    lost. Links whose task no longer exists are dropped too, and same-named
    sections within a project are collapsed the same way.

    `apply=False` (the default) counts and reports without writing anything —
    always worth running first."""
    by_gid = {}
    for l in db.query(models.AsanaTaskLink).all():
        if l.asana_gid:
            by_gid.setdefault(l.asana_gid, []).append(l)
    out = {"gids": 0, "merged": 0, "stale_links": 0, "sections": 0, "people": 0,
           "applied": bool(apply)}
    out["sections"] = _dedupe_sections(db, apply)
    out["people"] = normalize_people(db, apply)
    for gid, links in by_gid.items():
        live = []
        for l in links:
            t = db.query(models.Task).filter(models.Task.id == l.nexus_task_id).first()
            if t:
                live.append((l, t))
            else:
                out["stale_links"] += 1
                if apply:
                    db.delete(l)
        if len(live) < 2:
            continue
        out["gids"] += 1
        live.sort(key=_survivor_rank)
        keep_link, keep = live[0]
        for l, t in live[1:]:
            out["merged"] += 1
            if apply:
                _merge_task(db, t, keep)
                db.delete(l)
        if apply:
            # The survivor's own digest changed (merged followers/tags) — refresh
            # it so the next push doesn't treat the merge as an Asana-bound edit.
            db.flush()
            keep_link.last_hash = _task_digest(db, keep)
            keep_link.last_synced_at = now_iso()
    if apply:
        db.commit()
        try:
            db.execute(text(_UNIQUE_LINK_INDEX))
            db.commit()
        except Exception:
            db.rollback()   # something still duplicated — the code-level guards still hold
    elif out["sections"] or out["people"]:
        db.rollback()       # dry run: the scans above leave nothing behind
    return out


_STORY_OPT_FIELDS = "type,resource_subtype,text,created_at,created_by.name,created_by.email"


def _pull_stories(db, asana, asana_gid, nexus_task_id, counts):
    """Bring an Asana task's whole story feed into Nexus, deduped by story gid.

    Asana's /stories endpoint carries two kinds of entry and Nexus has a home
    for both:
      - COMMENTS      -> TaskComment      (AsanaCommentLink)
      - SYSTEM stories -> TaskActivity    (AsanaActivityLink)
    System stories are things like "changed the due date to Aug 8" or "marked
    this complete" — Asana's activity log. Dropping them (which is what this
    did before) meant the Nexus activity feed silently lost every change that
    happened on the Asana side, so a task's history read as if nobody had
    touched it. Both are keyed by story gid, so replays are free.

    Asana's own timestamp is preserved rather than stamping now(), so a
    backfilled history sorts correctly against Nexus-side entries instead of
    all landing at import time."""
    for s in asana.get(f"/tasks/{asana_gid}/stories", opt_fields=_STORY_OPT_FIELDS):
        sgid = s.get("gid") or ""
        if not sgid:
            continue
        cb = s.get("created_by") or {}
        author_name = cb.get("name") or "Asana"
        # Resolved through the directory so an activity entry is attributed to
        # the real Nexus person, not their Asana relay address.
        author_email = _map_email(cb.get("email"), None, db)
        at_ts = s.get("created_at") or now_iso()
        text = (s.get("text") or "").strip()
        is_comment = s.get("type") == "comment" or s.get("resource_subtype") == "comment_added"
        if is_comment:
            if db.query(models.AsanaCommentLink).filter(
                    models.AsanaCommentLink.asana_story_gid == sgid).first():
                continue
            if not text:
                continue
            cid = gen_id()
            db.add(models.TaskComment(id=cid, task_id=nexus_task_id, author_email="asana-sync",
                                      body=f"[Asana · {author_name}]\n{text}", created_at=at_ts,
                                      edited_at="", pinned=False))
            t = db.query(models.Task).filter(models.Task.id == nexus_task_id).first()
            if t:
                t.comment_ids = list(t.comment_ids or []) + [cid]
            db.add(models.AsanaCommentLink(id=gen_id(), nexus_comment_id=cid,
                                           asana_story_gid=sgid, created_at=now_iso()))
            db.flush()
            counts["comments"] += 1
            continue
        # System story -> activity entry.
        if db.query(models.AsanaActivityLink).filter(
                models.AsanaActivityLink.asana_story_gid == sgid).first():
            continue
        if not text:
            continue
        t = db.query(models.Task).filter(models.Task.id == nexus_task_id).first()
        if not t:
            continue
        aid = gen_id()
        db.add(models.TaskActivity(
            id=aid, entity_kind="task", entity_id=nexus_task_id, entity_code=t.code or "",
            entity_title=t.title or "", type=f"asana_{s.get('resource_subtype') or 'story'}",
            actor_email=author_email or "asana-sync", at=at_ts,
            detail=f"[Asana · {author_name}] {text}"))
        t.activity_ids = list(t.activity_ids or []) + [aid]
        db.add(models.AsanaActivityLink(id=gen_id(), nexus_activity_id=aid, nexus_task_id=nexus_task_id,
                                        asana_story_gid=sgid, created_at=now_iso()))
        db.flush()
        counts["activities"] = counts.get("activities", 0) + 1


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
    ...@xyz.onmicrosoft.com) that doesn't match the person's real Nexus email;
    _map_email resolves those through the Nexus directory, so such an account
    now grants access to the actual person instead of adding a dead address
    that matches nobody."""
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
            em = _map_email((row.get("user") or {}).get("email"), None, db)
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
            roster = [_map_email(e, None, db) for e in _team_users(asana, team_gid)]
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
        roster = [_map_email(e, None, db) for e in _team_users(asana, team_gid)]
        if roster:
            nt = _ensure_team(db, nexus_project_id, name)
            nt.member_emails = sorted(set(nt.member_emails or []) | set(roster))
    if wanted - set(project.member_emails or []):
        project.member_emails = sorted(set(project.member_emails or []) | wanted)


# Shared field list for the top-level task list AND the recursive subtask
# fetch, so both carry everything _apply_inbound/_pull_attachments/
# _sync_task_dependencies need. One list, used by every inbound path (Pull,
# webhook, one-shot Import) — a field added here reaches all three at once,
# which is the only way "no detail gets missed" stays true as this grows.
_TASK_OPT_FIELDS = ("name,notes,start_on,due_on,completed,assignee.email,modified_at,"
                   "custom_fields.name,custom_fields.enum_value.name,"
                   "dependencies,dependents,tags.name,resource_subtype,followers.email,"
                   "memberships.section.name,num_subtasks")


def _asana_section_name(at):
    """The Asana section a task sits in, from its project memberships. Asana
    always reports one ("Untitled section" for an unsectioned task, which is
    noise, not a section)."""
    for m in at.get("memberships") or []:
        name = ((m.get("section") or {}).get("name") or "").strip()
        if name and name.lower() != "untitled section":
            return name
    return ""


def _nexus_section_id(db, nexus_project_id, name):
    """Find-or-create the Nexus section named `name` in a project. Matching is
    case-insensitive by name because that is the only handle Asana gives us.

    Ordered by created_at so that when a project DOES already carry two
    same-named sections (an earlier import wrote one before this find-or-create
    existed), every task resolves to the same one — the oldest — instead of
    whichever row the database happened to return first. dedupe_tasks collapses
    the leftovers."""
    if not name or not nexus_project_id:
        return ""
    key = name.strip().lower()
    for s in (db.query(models.TaskSection)
              .filter(models.TaskSection.project_id == nexus_project_id)
              .order_by(models.TaskSection.created_at, models.TaskSection.id).all()):
        if (s.name or "").strip().lower() == key:
            return s.id
    s = models.TaskSection(id=gen_id(), project_id=nexus_project_id, name=name.strip(),
                           position=0, created_at=now_iso())
    db.add(s)
    db.flush()
    return s.id


def resolve_dependencies(db, deferred):
    """Second pass over every task a run touched, once ALL of them are linked.

    _sync_task_dependencies can only express a blocker that already has an
    AsanaTaskLink, and within a single walk that is order-dependent: task A
    blocked by task B, with A visited first, silently dropped the dependency
    and left it to "some later pull" to notice. On a one-shot Import there IS
    no later pull, so dependencies just never arrived. Running the resolution
    again at the end, when every link exists, makes it order-independent."""
    for at, nexus_task_id in deferred:
        try:
            _sync_task_dependencies(db, at, nexus_task_id)
        except Exception:
            pass


def _pull_task_tree(db, asana, at, nexus_project_id, parent_task_id, counts, seen=None,
                    email_map=None, deferred=None):
    """Apply one Asana task (and recursively its subtasks) into Nexus: fields,
    comments, attachments, dependencies. Depth-first so a child's parent link
    always exists before the child needs it (dependency/subtask resolution).

    `seen` collects the gids already applied in THIS pull run. One Asana task
    legitimately reaches us more than once — a subtask that has also been added
    to the project shows up in /projects/{gid}/tasks AND in its parent's
    /tasks/{gid}/subtasks, and a task shared into two mapped projects shows up
    in both — and re-applying it is at best wasted API calls (comments,
    attachments and subtasks refetched) and was at worst the second half of the
    duplicate bug. Skipping the repeat visit keeps the first placement, which
    is the one Asana's own list view shows."""
    if seen is None:
        seen = set()
    gid = at["gid"]
    if gid in seen:
        return
    seen.add(gid)
    nexus_task_id = _apply_inbound(db, at, nexus_project_id, counts,
                                   parent_task_id=parent_task_id, email_map=email_map)
    if not nexus_task_id:
        return
    _pull_stories(db, asana, gid, nexus_task_id, counts)
    _pull_attachments(db, asana, gid, nexus_task_id, counts)
    _sync_task_dependencies(db, at, nexus_task_id)
    if deferred is not None:
        # Re-resolved at the end of the run by resolve_dependencies, when every
        # task in this walk is linked — the inline call above can only see
        # blockers visited before this task.
        deferred.append((at, nexus_task_id))
    try:
        subtasks = asana.get(f"/tasks/{gid}/subtasks", opt_fields=_TASK_OPT_FIELDS)
    except Exception:
        subtasks = []
    for sub in subtasks:
        _pull_task_tree(db, asana, sub, nexus_project_id, nexus_task_id, counts, seen,
                        email_map, deferred)


def _asana_task_gone(cfg, gid):
    """True only when Asana positively says this task no longer exists.

    Deleting is the one irreversible thing this module does, so the bar is a
    definite 404 from Asana itself. A task that still exists but has been moved
    out of the mapped project answers 200 and is left alone (removing it from a
    board isn't the same as deleting it), and so is any inconclusive answer —
    network error, rate limit, permissions. False negatives just mean the row
    survives until the next pull; a false positive would destroy real work."""
    try:
        Asana(cfg.token).get(f"/tasks/{gid}", opt_fields="gid")
        return False
    except ImportError_ as e:
        return str(e).startswith("HTTP 404")
    except Exception:
        return False


def _project_task_ids(db, nexus_project_id):
    """Every Nexus task in a project, subtasks included (a subtask carries
    project_id="" and is reached through its parent)."""
    ids = {t.id for t in db.query(models.Task).filter(
        models.Task.project_id == nexus_project_id).all()}
    frontier = list(ids)
    while frontier:
        kids = db.query(models.Task).filter(models.Task.parent_task_id.in_(frontier)).all()
        frontier = [k.id for k in kids if k.id not in ids]
        ids.update(frontier)
    return ids


def _reap_deleted(db, cfg, nexus_project_id, seen, counts):
    """Delete Nexus tasks whose Asana counterpart has been deleted.

    Asana leaves no tombstone — a deleted task is simply absent from the
    project's task list — so this is the pull-side complement to the webhook's
    'deleted' event (unlink_deleted_task), and the only thing that catches
    deletions that happened while webhooks were off or unregistered. A linked
    task in this project whose gid never came back in the walk is a candidate;
    _asana_task_gone then has to confirm it with Asana before anything is
    removed. Candidates are normally zero, so this costs no API calls at all in
    the steady state."""
    if not cfg.delete_sync or not nexus_project_id:
        return
    scope = _project_task_ids(db, nexus_project_id)
    if not scope:
        return
    candidates = [l for l in db.query(models.AsanaTaskLink).filter(
        models.AsanaTaskLink.nexus_task_id.in_(scope)).all()
        if l.asana_gid and l.asana_gid not in seen]
    done = set()
    for link in candidates:
        if link.nexus_task_id in done or not _asana_task_gone(cfg, link.asana_gid):
            continue
        t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
        if not t:
            continue
        removed = delete_nexus_task(db, t)   # takes its subtasks + their links along
        done |= removed
        counts["deleted"] += len(removed)
        db.flush()


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
        refresh_directory_cache()   # people added since the last run resolve too
        asana = Asana(cfg.token)
        counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                  "attachments": 0, "deleted": 0}
        seen = set()   # gids applied this run — one per run, across all mapped projects
        deferred = []  # (asana task, nexus id) for the dependency pass below
        for pm in db.query(models.AsanaProjectMap).all():
            if not pm.asana_project_gid:
                continue
            # Raises on an Asana failure, which aborts the whole pull — so
            # _reap_deleted below only ever runs against a task list we know
            # came back complete. A half-fetched project must never be read as
            # "everything missing was deleted".
            rows = asana.get(f"/projects/{pm.asana_project_gid}/tasks", opt_fields=_TASK_OPT_FIELDS)
            for at in rows:
                _pull_task_tree(db, asana, at, pm.nexus_project_id, "", counts, seen, None, deferred)
            _reap_deleted(db, cfg, pm.nexus_project_id, seen, counts)
            _sync_project_access(db, asana, cfg, pm.asana_project_gid, pm.nexus_project_id, pm.extra_team_names)
        resolve_dependencies(db, deferred)   # every link exists by now
        cfg.last_pull_at = now_iso()
        db.commit()
        return counts


class TokenConfig:
    """A stand-in for the AsanaSyncConfig row when the caller brings its own
    token — the one-shot Import UI asks for a PAT instead of using the stored
    service token. Same attribute surface the engine reads, with delete_sync
    forced OFF: an Import is an additive operation and must never remove
    anything, whatever the saved config says."""

    def __init__(self, token, workspace_gid=""):
        self.token = token
        self.workspace_gid = workspace_gid or ""
        self.enabled = True
        self.delete_sync = False
        self.default_project_gid = ""


def import_project(db, cfg, nexus_project_id, asana_project_gid, counts=None,
                   seen=None, email_map=None, deferred=None):
    """Import one Asana project's contents into an existing Nexus project using
    the SAME engine Pull uses.

    The one-shot Import used to have its own parallel implementation, which is
    why it quietly carried less than Pull did: no dependencies, no status, no
    start date, no milestone flag, no followers, no sections on subtasks — and
    no AsanaTaskLink rows at all, so the first Pull afterwards had to re-adopt
    every task by title and duplicated whatever it couldn't match. Routing both
    through _pull_task_tree means a field added to the engine reaches Import
    and Pull at the same moment, and Import leaves a properly linked project
    that Pull can take over without guessing.

    The caller owns the Nexus project row (it needs the requesting user to
    create one); this fills it."""
    counts = counts if counts is not None else {"created": 0, "updated": 0, "comments": 0,
                                                "activities": 0, "attachments": 0, "deleted": 0}
    seen = seen if seen is not None else set()
    # Own the dependency pass unless the caller is batching several projects and
    # will run it once at the end (dependencies can cross projects).
    own_pass = deferred is None
    deferred = deferred if deferred is not None else []
    refresh_directory_cache()   # people added since the last run resolve too
    asana = Asana(cfg.token)
    for at in asana.get(f"/projects/{asana_project_gid}/tasks", opt_fields=_TASK_OPT_FIELDS):
        _pull_task_tree(db, asana, at, nexus_project_id, "", counts, seen, email_map, deferred)
    _sync_project_access(db, asana, cfg, asana_project_gid, nexus_project_id)
    if own_pass:
        resolve_dependencies(db, deferred)
    return counts


def ensure_project_map(db, nexus_project_id, asana_project_gid):
    """Record the Nexus<->Asana project mapping, so a project that was imported
    is thereafter kept in sync automatically rather than needing the operator to
    re-enter the pairing by hand. Re-points an existing row for the same Asana
    project instead of adding a second one."""
    if not (nexus_project_id and asana_project_gid):
        return None
    pm = (db.query(models.AsanaProjectMap)
          .filter(models.AsanaProjectMap.asana_project_gid == asana_project_gid).first())
    if pm:
        pm.nexus_project_id = nexus_project_id
        return pm
    pm = models.AsanaProjectMap(id=gen_id(), nexus_project_id=nexus_project_id,
                                asana_project_gid=asana_project_gid, extra_team_names=[],
                                created_at=now_iso())
    db.add(pm)
    db.flush()
    return pm


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


# ── Scheduled reconciliation (fallback poll; webhooks handle real-time) ──────
# Inbound has two live paths (webhooks, plus this poll). Outbound has one
# (on_task_changed per edit) — and a per-edit hook is exactly the thing that
# loses a change when sync was off, the token had expired, Asana 500'd, or the
# process died mid-push. The push sweep is the outbound equivalent of the pull
# poll: it re-derives what Asana should have from the Nexus rows themselves, so
# an edit that missed its push is picked up on the next sweep instead of
# sitting unsynced forever. Cheap because push_task short-circuits on both
# digests — an untouched task costs zero HTTP calls.
_AUTO_PULL_STARTED = False
_AUTO_PULL_INTERVAL_MIN = 5
_AUTO_PUSH_INTERVAL_MIN = 15


def start_auto_pull():
    """Start the background reconcilers — inbound pull every 5 minutes, outbound
    push sweep every 15 — when sync is enabled. Idempotent, safe to call once at
    startup. A no-op until a token is set, and a no-op entirely outside the
    designated sync worker (see is_sync_worker), which is what keeps this
    automatic on dev/prod and manual-only on a developer's laptop."""
    global _AUTO_PULL_STARTED
    if _AUTO_PULL_STARTED or not is_sync_worker():
        return
    _AUTO_PULL_STARTED = True

    def _every(minutes, work):
        def _loop():
            while True:
                time.sleep(minutes * 60)
                try:
                    db = SessionLocal()
                    try:
                        cfg = get_config(db)
                        if cfg.enabled and cfg.token:
                            work(db)
                    finally:
                        db.close()
                except Exception:
                    pass
        threading.Thread(target=_loop, daemon=True).start()

    _every(_AUTO_PULL_INTERVAL_MIN, pull)
    _every(_AUTO_PUSH_INTERVAL_MIN, push_all)


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
