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
  echo loops - a change that came *from* a sync won't be pushed back.

Synced fields (both directions unless noted): title/name, description/notes,
start_on, due_on, completed, assignee, status (via a "Task Progress" custom
field, if the project has one), priority (via Asana's own "Priority" custom
field), tags (find-or-create workspace tags by name), milestone flag
(resource_subtype - outbound only settable at creation, Asana treats it as
immutable after), followers (outbound additive via addFollowers, matching the
dependencies pattern - never removes an Asana-side follower removed on the
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
import re
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from html import escape, unescape

from sqlalchemy import text

from database import SessionLocal
import models
from routers.task_util import now_iso, gen_id, log_activity
from asana_import import Asana, _request, ImportError_
# Per-user Asana grants, so a pushed comment is attributed to its real author.
# Safe at module level: asana_oauth imports asana_sync lazily (inside
# redirect_uri) precisely to keep this from becoming a cycle.
import asana_oauth

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

    Manual Pull / Push-all remain available everywhere - those are explicit
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
    """The Asana user gid for a Nexus work email - exact match first, then the
    local part (see _user_map)."""
    e = (email or "").strip().lower()
    if not e:
        return None
    users = _user_map(cfg)
    return users.get(e) or users.get(e.split("@", 1)[0])


# {(token, project_gid): (ts, {name_lower: gid})} - used to link to an existing
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


# {(token, workspace_gid): (ts, {name_lower: gid})} - workspace tags, find-or-
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
    _push_dependencies: an addFollowers action, never removeFollowers - a
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
    """Additive outbound tag push - CONFIRMED live that `tags` is not a
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


def sync_is_on(cfg) -> bool:
    """True if EITHER the Setup card's blanket toggle (`enabled`) or the
    Two-Way Sync card's own toggle (`manual_sync_enabled`) is on. The two are
    independent knobs (Manage → Asana Sync) gating the SAME pull/push/webhook
    machinery against the SAME AsanaProjectMap table - there's no per-project
    origin tracking, so either toggle being on is enough to sync whatever is
    currently mapped. Every cfg.enabled read in this module goes through this
    function instead, so a project mapped via "Import All Projects" and one
    mapped by hand both sync as long as at least one toggle is on.

    getattr with a default: TokenConfig (the Import stub) and any test fixture
    that predates these columns has no `manual_sync_enabled` attribute, and
    should behave exactly as it did before this existed (Import never reaches
    this function anyway, but the stub's shape shouldn't matter if it did)."""
    return bool(cfg.enabled or getattr(cfg, "manual_sync_enabled", False))


def delete_sync_is_on(cfg) -> bool:
    """Same OR-of-two-toggles as sync_is_on(), for deletion propagation."""
    return bool(cfg.delete_sync or getattr(cfg, "manual_delete_sync", False))


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
def _fields_digest(values):
    """Stable text for a {fieldId: value} map. Sorted, so dict ordering can never
    make an unchanged task look changed and trigger a pointless push."""
    def _one(v):
        # multiselect/people hold lists. Sorted here too: the two sides order
        # them differently (Asana by its own option order, Nexus by the field's),
        # and without this an untouched task digests differently on every pull
        # and ping-pongs between the two systems forever.
        if isinstance(v, (list, tuple)):
            return "|".join(sorted(str(x) for x in v))
        return str(v)
    return ",".join(f"{k}={_one(v)}" for k, v in sorted((values or {}).items())
                    if v not in ("", None) and v != [])


def _digest(title, description, due_on, completed, assignee="", progress="", priority="",
           start_on="", tags=None, milestone=False, section="", fields=None):
    raw = "\x1f".join([title or "", description or "", (due_on or "")[:10],
                       "1" if completed else "0", (assignee or "").lower(), (progress or "").lower(),
                       (priority or "").lower(), (start_on or "")[:10],
                       ",".join(sorted((t or "").strip().lower() for t in (tags or []))),
                       "1" if milestone else "0", (section or "").strip().lower(),
                       _fields_digest(fields)])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _nexus_section_name(db, t):
    if not t.section_id:
        return ""
    s = db.query(models.TaskSection).filter(models.TaskSection.id == t.section_id).first()
    return (s.name or "").strip() if s else ""


def _task_digest(db, t, assignee=None):
    """`assignee` overrides the task's own value. The outbound push passes the
    assignee it was actually ABLE to send, because last_hash is a record of what
    Asana holds - not of what Nexus wishes it held. Storing the intended value
    after failing to send it marks the task synced forever (see push_task).

    Every other caller applies an Asana-sourced value and so leaves it None,
    which keeps the task's own assignee."""
    return _digest(t.title, t.description, t.due_on, bool(t.completed),
                   t.assignee_email if assignee is None else assignee,
                   _status_progress_label(db, t), _BUILTIN_PRIORITY_LABELS.get(t.priority, ""),
                   t.start_on, t.tags, bool(t.is_milestone), _nexus_section_name(db, t),
                   fields=t.custom_field_values)


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
# boolean - teams that want that finer state visible in Asana add their own
# enum custom field, conventionally named "Task Progress". This maps Nexus's
# status onto it by matching option NAMES, so it works for any project that
# happens to have such a field without hardcoding its gid.
_PROGRESS_FIELD_CACHE = {}
_PROGRESS_FIELD_TTL = 600
_BUILTIN_STATUS_LABELS = {"not_started": "not started", "in_progress": "in progress",
                          "completed": "done", "recurring": "in progress"}


def _status_progress_label(db, task):
    """Lowercase human label for a task's status - a built-in or a project's own
    custom status (TaskCustomStatus.label) - for matching against Asana enum
    option names."""
    if task.status in _BUILTIN_STATUS_LABELS:
        return _BUILTIN_STATUS_LABELS[task.status]
    cs = db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id == task.status).first()
    return (cs.label or "").strip().lower() if cs else ""


# Both "Task Progress" and "Priority" (below) live on the same project custom
# field settings response - one cached fetch serves both lookups instead of
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
                                    "custom_field_settings.custom_field.resource_subtype,"
                                    "custom_field_settings.custom_field.is_formula_field,"
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
# Progress) - Nexus has 4 levels (low/medium/high/urgent), this project's Asana
# field only has 3 (High/Medium/Low): urgent has no distinct Asana equivalent,
# so it maps onto "High" outbound. Inbound is necessarily lossy the same way -
# Asana can never tell Nexus "urgent", only "high".
_BUILTIN_PRIORITY_LABELS = {"low": "low", "medium": "medium", "high": "high", "urgent": "high"}
_PRIORITY_LABEL_TO_VALUE = {"low": "low", "medium": "medium", "high": "high"}


def _priority_field(cfg, project_gid):
    return _find_enum_field(cfg, project_gid, "Priority")


# ── Generic custom fields <-> Asana custom_fields ────────────────────────────
# Nexus custom fields (TaskCustomField) map onto Asana's per-project fields BY
# NAME, case-insensitively, like tags/teams/sections elsewhere here.
#
# These two Asana names are excluded: they already drive Nexus's native status
# and priority, and storing them twice would make the two fight over edits.
_RESERVED_ASANA_FIELDS = {"task progress", "priority"}

# Asana resource_subtype -> the Nexus storage kind. Every subtype Asana has is
# carried: the two list-shaped ones get list-shaped Nexus types (see
# TaskCustomField.type) rather than being flattened to text, which is what made
# them unpushable before. `formula` is computed by Asana and rejects writes, so
# it lands as read-only text - the one type that cannot be two-way.
_ASANA_TYPE_TO_NEXUS = {"enum": "select", "multi_enum": "multiselect", "text": "text",
                        "number": "number", "date": "date", "people": "people",
                        "formula": "text"}


def _asana_field_kind(cf):
    """The Nexus storage kind for one Asana field definition, or None if Asana
    has given us a subtype we have no shape for at all."""
    if cf.get("is_formula_field"):
        return "text"   # regardless of what the formula resolves to
    return _ASANA_TYPE_TO_NEXUS.get((cf.get("resource_subtype") or "").lower())


def _asana_field_value(cf, db=None, email_map=None):
    """The value carried by one Asana custom_fields entry, as Nexus stores it."""
    if cf.get("is_formula_field"):
        return (cf.get("display_value") or "").strip()
    kind = (cf.get("resource_subtype") or "").lower()
    if kind == "enum":
        return ((cf.get("enum_value") or {}).get("name") or "").strip()
    if kind == "multi_enum":
        return [(o.get("name") or "").strip() for o in (cf.get("multi_enum_values") or [])
                if (o.get("name") or "").strip()]
    if kind == "people":
        # Through _map_email, same as assignee/followers - so a person stored in
        # Asana under a guest relay address lands as their real Nexus identity
        # and the avatar resolves.
        return [e for e in (_map_email(u.get("email"), email_map, db)
                            for u in (cf.get("people_value") or []) if u.get("email")) if e]
    if kind == "text":
        return (cf.get("text_value") or "").strip()
    if kind == "number":
        n = cf.get("number_value")
        return None if n is None else (int(n) if float(n).is_integer() else float(n))
    if kind == "date":
        d = (cf.get("date_value") or {}).get("date") or ""
        return d[:10]
    if kind == "formula":
        return (cf.get("display_value") or "").strip()
    return None


def _sync_nexus_field(db, cf, nexus_project_id, value_options=None):
    """Find-or-create the Nexus column mirroring one Asana custom field, scoped
    to this project.

    Identity is the Asana gid, never the name. Matching by name merged two
    unrelated same-named fields from different projects into one column shared
    by both (and merged their options), and lost the field entirely when someone
    renamed it in Asana. Scope is maintained from Asana's own project settings -
    the field is added to THIS project's scope and no other, which is what keeps
    a column added to one board off every other board.

    Returns None for a subtype we have no shape for, so the caller skips it."""
    from routers.task_config import normalize_field_options
    gid = (cf.get("gid") or "").strip()
    name = (cf.get("name") or "").strip()
    kind = _asana_field_kind(cf)
    if not name or not kind or name.lower() in _RESERVED_ASANA_FIELDS:
        return None
    read_only = bool(cf.get("is_formula_field")) or (cf.get("resource_subtype") or "").lower() == "formula"
    options = [(o.get("name") or "").strip() for o in (cf.get("enum_options") or [])
               if (o.get("name") or "").strip()]
    # A TASK payload carries no enum_options - only the project-settings call
    # does - so a field first seen on a task seeds its options from the value
    # itself and gets the full list from the next seed_project_fields. Without
    # this the value matches no option and coerce_custom_field_values drops it,
    # which is exactly how enum columns ended up importing empty.
    if not options and value_options:
        options = [str(v).strip() for v in value_options if str(v or "").strip()]

    f = None
    if gid:
        f = db.query(models.TaskCustomField).filter(models.TaskCustomField.asana_gid == gid).first()
    if f is None:
        # Adopt an existing field by name when it is one this project can
        # already see: a field a previous build created before gids were stored,
        # or one an admin made by hand to line up with Asana. A field scoped to
        # OTHER projects is deliberately not adopted - merging those was what
        # put one project's column on another project's board.
        f = next((x for x in db.query(models.TaskCustomField).all()
                  if (x.name or "").strip().lower() == name.lower()
                  and not (x.asana_gid or "")
                  and (not [p for p in (x.project_ids or []) if p]
                       or nexus_project_id in (x.project_ids or []))), None)
    if f is None:
        f = models.TaskCustomField(id=gen_id(), name=name, type=kind, asana_gid=gid,
                                   options=normalize_field_options(options),
                                   project_ids=[nexus_project_id] if nexus_project_id else [],
                                   required=False, read_only=read_only)
        db.add(f)
        db.flush()   # autoflush=False - must be visible to the rest of this pull
        return f

    f.asana_gid = gid or f.asana_gid
    f.name = name              # Asana is the source of truth for the label
    f.read_only = read_only
    if f.type != kind:
        # A field whose Asana subtype changed (enum -> multi_enum is the common
        # one). Retype it; coerce_custom_field_values reshapes the stored values
        # on the next write, and anything that can't reshape is dropped there
        # rather than stored wrong.
        f.type = kind
    if nexus_project_id:
        scope = [p for p in (f.project_ids or []) if p]
        # An empty scope means "every project" - narrowing that here would hide
        # a deliberately global field, so only ever extend a scope that exists.
        if scope and nexus_project_id not in scope:
            f.project_ids = scope + [nexus_project_id]
    if options:
        # Additive: Asana's current options win, but an option only Nexus has
        # (added by hand, or retired in Asana while tasks still carry it) stays,
        # otherwise those tasks' values would fail to coerce and blank out.
        have = {o["label"].strip().lower() for o in normalize_field_options(f.options or [])}
        extra = [o for o in options if o.strip().lower() not in have]
        if extra:
            f.options = normalize_field_options([*(f.options or []), *extra])
    return f


def seed_project_fields(db, cfg, project_gid, nexus_project_id):
    """Mirror EVERY custom field on an Asana project into Nexus before its tasks
    are applied, scoped to this project.

    Driven by the project's field settings rather than by the values that happen
    to appear on tasks, which is what makes new Asana columns show up on their
    own: a field nobody has filled in yet still becomes a Nexus column, and an
    enum arrives with its COMPLETE option list instead of just the one option
    the first task happened to carry. That partial option list was why values
    silently vanished - coerce_custom_field_values drops a value matching no
    option, so every enum whose real options hadn't been seen yet blanked out."""
    if not project_gid or not nexus_project_id:
        return 0
    n = 0
    for cfs in _custom_field_settings(cfg, project_gid):
        if _sync_nexus_field(db, cfs.get("custom_field") or {}, nexus_project_id) is not None:
            n += 1
    return n


def _inbound_custom_fields(db, at, nexus_project_id, email_map=None):
    """Asana task -> {nexusFieldId: value} for Task.custom_field_values."""
    from routers.task_config import coerce_custom_field_values
    raw = {}
    for cf in at.get("custom_fields") or []:
        value = _asana_field_value(cf, db, email_map)
        # The definition is created even when the value is empty - a column that
        # exists in Asana is a column in Nexus, whether or not this particular
        # task fills it in. That is what makes a new Asana column appear on its
        # own rather than only once someone happens to set a value.
        opts = value if isinstance(value, list) else ([value] if value else [])
        f = _sync_nexus_field(db, cf, nexus_project_id, value_options=opts)
        if f is None or value in ("", None) or value == []:
            continue
        raw[f.id] = value
    # Same coercion the API applies, so a value that arrived from Asana is
    # stored identically to one typed in Nexus - otherwise the two sides would
    # differ by type alone and every pull would look like a change.
    return coerce_custom_field_values(db, raw)


def _outbound_custom_fields(db, cfg, task, project_gid):
    """{asanaFieldGid: value} for the fields the Asana project ALREADY has.

    Deliberately never creates a field in Asana: that needs workspace-level
    calls plus a project-settings write, and a sync that invents fields in a
    shared workspace is a much bigger blast radius than one that skips them.
    A Nexus-only field simply doesn't travel."""
    values = task.custom_field_values if isinstance(task.custom_field_values, dict) else {}
    if not values or not project_gid:
        return {}
    from routers.task_config import normalize_field_options
    defs = {f.id: f for f in db.query(models.TaskCustomField).all()}
    # Keyed by gid, with the name as a fallback for a Nexus-only field an admin
    # created to line up with an Asana one by hand (no gid on the Nexus row).
    by_gid, by_name = {}, {}
    for cfs in _custom_field_settings(cfg, project_gid):
        cf = cfs.get("custom_field") or {}
        nm = (cf.get("name") or "").strip().lower()
        if nm in _RESERVED_ASANA_FIELDS:
            continue
        if cf.get("gid"):
            by_gid[cf["gid"]] = cf
        if nm:
            by_name[nm] = cf

    def _option_gid(cf, f, option_id):
        label = next((o["label"] for o in normalize_field_options(f.options or [])
                      if o["id"] == option_id), str(option_id))
        return next((o.get("gid") for o in (cf.get("enum_options") or [])
                     if (o.get("name") or "").strip().lower() == label.strip().lower()), None)

    out = {}
    for fid, value in values.items():
        f = defs.get(fid)
        if f is None or value in ("", None) or value == []:
            continue
        if f.read_only:
            continue   # Asana computes this one and rejects any write to it
        cf = by_gid.get(f.asana_gid or "") or by_name.get((f.name or "").strip().lower())
        if not cf or not cf.get("gid"):
            continue   # Asana has no such field on this project - skip, don't create
        kind = (f.type or "text").lower()
        if kind == "select":
            gid = _option_gid(cf, f, value)
            if gid:
                out[cf["gid"]] = gid
        elif kind == "multiselect":
            gids = [g for g in (_option_gid(cf, f, v) for v in (value or [])) if g]
            # Sent even when empty: that is how a multi_enum is CLEARED in Asana,
            # and the values dict only reaches here with a non-empty list anyway.
            out[cf["gid"]] = gids
        elif kind == "people":
            users = _user_map(cfg)
            gids = []
            for em in (value or []):
                e = str(em).strip().lower()
                # Same two-step as the assignee push: the Asana account address,
                # else the bare local part for a guest-relay mailbox.
                gid = users.get(e) or users.get(e.split("@", 1)[0])
                if gid and gid not in gids:
                    gids.append(gid)
            out[cf["gid"]] = gids
        elif kind == "number":
            out[cf["gid"]] = value
        elif kind == "date":
            out[cf["gid"]] = {"date": str(value)[:10]}
        elif kind == "checkbox":
            continue   # Asana has no checkbox custom field - nothing to map onto
        else:
            out[cf["gid"]] = str(value)
    return out


def _priority_from_custom_fields(at):
    for cf in at.get("custom_fields") or []:
        if (cf.get("name") or "").strip().lower() == "priority":
            return ((cf.get("enum_value") or {}).get("name") or "").strip().lower()
    return ""


def _ancestor_project_gid(db, task, cfg):
    """A subtask has no project_id of its own (Nexus convention - see
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
    addDependencies action - never removes an Asana-side dependency that was
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


# {(token, project_gid): (ts, {name_lower: gid})} - Asana sections, find-or-
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
    expresses this as an addProject action carrying a section gid - there is no
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
    """Push Nexus attachments to Asana as EXTERNAL attachments - Asana stores
    the link, we never re-upload bytes.

    Only http(s) URLs qualify. A `data:` URL is skipped by design, not by
    omission: those exist only because _pull_attachments inlined a small file
    that came FROM Asana, so the file is already there and pushing it back
    would duplicate it. Recorded in AsanaAttachmentLink - the same table the
    inbound side dedups on - so neither direction re-adds the other's work."""
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
    - see _ancestor_project_gid). Returns the gid or None. Skips when disabled,
    unmapped, or unchanged since the last sync."""
    cfg = get_config(db)
    if not sync_is_on(cfg) or not cfg.token:
        return None
    parent_link = None
    if task.parent_task_id:
        # A subtask can only be created once its parent already has an Asana
        # counterpart - Asana attaches it via the parent's gid, not a project.
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
    # Resolved BEFORE the digest, because the digest has to describe what Asana
    # will actually hold. An assignee Nexus can't map to an Asana user is not
    # sent at all (see below), so recording it as synced would be a lie that
    # never corrects itself - last_hash would match on every future push and the
    # assignee would be skipped forever, silently. Cheap: _user_map is cached.
    ae = (task.assignee_email or "").lower()
    assignee_gid = _asana_user_gid(cfg, ae) if ae else None
    assignee_sent = (not ae) or bool(assignee_gid)
    digest = _task_digest(db, task, assignee=(ae if assignee_sent else ""))
    push_digest = _push_digest(db, task)
    if link and link.last_hash == digest:
        # The task's own fields are unchanged, but tags/followers/dependencies/
        # section/attachments aren't in that digest - they reach Asana through
        # separate additive actions, not a task PUT (tags: CONFIRMED live that
        # Asana's PUT rejects a `tags` field outright, "Cannot write this
        # property") - so a change to only one of them would otherwise never
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
        # html_notes carries the rich text, reduced to the tag subset Asana accepts.
        # Empty description -> plain notes, so clearing it clears on the Asana side.
        # cfg lets @mentions resolve to real Asana mentions rather than mailto links.
        **({"html_notes": _to_asana_html(task.description, cfg)}
           if _to_asana_html(task.description, cfg) else {"notes": ""}),
        "start_on": (task.start_on or "")[:10] or None,
        "due_on": (task.due_on or "")[:10] or None,
        "completed": bool(task.completed),
    }
    # Asana rejects start_on >= due_on on some plans; drop it rather than 400
    # the whole update over a field that's secondary to due_on.
    if fields["start_on"] and fields["due_on"] and fields["start_on"] > fields["due_on"]:
        fields["start_on"] = None
    # CONFIRMED live: Asana rejects any start_on at all on a milestone
    # ("You cannot set a start date on a milestone") - milestones only have
    # due_on. Drop it for milestones instead of 400ing the whole push.
    if task.is_milestone:
        fields["start_on"] = None
    # Assignee: map the Nexus work email to an Asana user. Unassigned in Nexus →
    # unassign in Asana; assigned to someone not in Asana → leave Asana as-is.
    # Resolved above, before the digest.
    if not ae:
        fields["assignee"] = None
    elif assignee_gid:
        fields["assignee"] = assignee_gid
    else:
        # Was silent. The commonest cause is a blank Workspace GID in Manage →
        # Asana Sync: _user_map returns {} without one, so NO assignee can ever
        # resolve while every other field syncs normally - which reads as
        # "assignee sync is broken" with nothing anywhere saying why.
        print(f"[asana] {task.code or task.id}: assignee {ae!r} has no Asana user "
              f"({'set the Workspace GID in Manage - Asana Sync' if not cfg.workspace_gid else 'no matching Asana account in this workspace'})"
              f" - pushing every other field and leaving Asana's assignee as-is")
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
    # Generic Nexus custom fields ride alongside the two built-in ones. Built-ins
    # win a gid collision: Task Progress / Priority are excluded from the generic
    # map, so this can only ever add distinct gids.
    custom_fields.update(_outbound_custom_fields(db, cfg, task, apid or progress_apid))
    if custom_fields:
        fields["custom_fields"] = custom_fields
    is_new = not (link and link.asana_gid) and not parent_link
    is_new_subtask = not (link and link.asana_gid) and bool(parent_link)
    if (is_new or is_new_subtask) and task.is_milestone:
        # resource_subtype is only settable at creation - Asana treats it as
        # immutable afterward, so this never appears on the PUT path below.
        fields["resource_subtype"] = "milestone"
    if link and link.asana_gid:
        _task_write(cfg.token, "PUT", f"/tasks/{link.asana_gid}", fields)
    else:
        # CREATE PATH - the only place outbound can mint a duplicate, and the
        # one that bit us on dev but never on localhost: gunicorn runs 8 worker
        # PROCESSES there (startup.sh), all of which qualify as sync workers, so
        # two of them handling near-simultaneous edits to the same task each saw
        # "no link yet" and each created an Asana task plus a link row. A
        # threading.Lock can't see across processes; the same Postgres advisory
        # lock pull() uses can. Held only around create - updates can't
        # duplicate anything, so the common path stays unserialised.
        _acquire_pull_lock(db)
        link = _link_by_nexus(db, task.id)   # a worker that beat us to the lock may have made it
        if link and link.asana_gid:
            _task_write(cfg.token, "PUT", f"/tasks/{link.asana_gid}", fields)
        elif parent_link:
            created = _task_write(cfg.token, "POST", f"/tasks/{parent_link.asana_gid}/subtasks", fields)
            gid = (created or {}).get("gid")
            if not gid:
                return None
            link = models.AsanaTaskLink(id=gen_id(), nexus_task_id=task.id, asana_gid=gid)
            db.add(link)
        else:
            # Dedup: if an Asana task with the same name already exists in the target
            # project (e.g. the two projects were previously imported), LINK to it and
            # update it - never blindly create a duplicate.
            name_key = (task.title or "").strip().lower()
            existing_gid = _asana_tasks_by_name(cfg, apid).get(name_key)
            if existing_gid:
                _task_write(cfg.token, "PUT", f"/tasks/{existing_gid}", fields)
                gid = existing_gid
            else:
                created = _task_write(cfg.token, "POST", "/tasks", {**fields, "projects": [apid]})
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
            if not sync_is_on(cfg):
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

    Returns (done, error). `done` means the Asana task is not there any more -
    which includes a 404, since a task someone already deleted by hand is the
    outcome we wanted and must not be retried forever."""
    cfg = get_config(db)
    if not (sync_is_on(cfg) and cfg.token and delete_sync_is_on(cfg) and asana_gid):
        return False, "sync disabled"
    try:
        _request("DELETE", f"{_ASANA_BASE}/tasks/{asana_gid}", _headers(cfg.token))
        return True, ""
    except ImportError_ as e:
        msg = str(e)
        if msg.startswith("HTTP 404"):
            return True, ""            # already gone - the desired end state
        return False, msg[:200]
    except Exception as e:
        return False, str(e)[:200]


def queue_task_delete(db, asana_gids, title="", code="", actor=""):
    """Record deletions owed to Asana. Called from delete_task INSIDE its
    transaction, so the tombstone commits together with the deletion - there is
    no window where the Nexus task is gone but the intent to delete its Asana
    counterpart isn't recorded. Does not commit."""
    for gid in {g for g in (asana_gids or []) if g}:
        db.add(models.AsanaPendingDelete(id=gen_id(), asana_gid=gid, task_title=title or "",
                                          task_code=code or "", requested_by=actor or "",
                                          attempts=0, last_error="", created_at=now_iso()))


def drain_pending_deletes(db):
    """Send every queued deletion to Asana. Safe to call from the automatic
    sweep and from a manual Push all - a row is removed once Asana confirms the
    task is gone, and a row that keeps failing is dropped after
    _MAX_DELETE_ATTEMPTS so the queue can't grow without bound.

    This is the manual path a laptop needs: on localhost the fire-and-forget
    push never runs (is_sync_worker is false), so without draining here a
    deletion made locally could never reach Asana by any means."""
    cfg = get_config(db)
    rows = db.query(models.AsanaPendingDelete).all()
    if not rows:
        return {"deleted": 0, "pending": 0}
    if not (sync_is_on(cfg) and cfg.token):
        return {"deleted": 0, "pending": len(rows)}
    if not delete_sync_is_on(cfg):
        # Deletion propagation is switched off - drop the queue rather than
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
    the queue rather than taking gids directly - delete_task has already
    recorded them (queue_task_delete), so an immediate failure here just leaves
    the tombstone for the next sweep instead of losing the deletion. Never
    raises."""
    if not is_sync_worker():
        return
    def _run():
        db = SessionLocal()
        try:
            if sync_is_on(get_config(db)):
                drain_pending_deletes(db)
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


def linked_gids(db, task_ids):
    """Asana gids for the given Nexus tasks - read before a delete, since
    deleting the rows takes their AsanaTaskLink rows with them."""
    if not task_ids:
        return []
    return [l.asana_gid for l in db.query(models.AsanaTaskLink).filter(
        models.AsanaTaskLink.nexus_task_id.in_(list(task_ids))).all() if l.asana_gid]


def push_all(db):
    """Seed/refresh: push every task (subtasks included) in a mapped Nexus
    project to Asana, plus any of their comments that haven't synced out yet.
    Pushed level by level - top-level tasks first, then their direct children,
    then grandchildren - so a subtask's parent always already has an Asana
    counterpart by the time push_task needs its gid (see _ancestor_project_gid
    / the parent_link check in push_task).

    Comments are included here because on_comment_added - the normal path -
    is gated by is_sync_worker() same as on_task_changed, but unlike tasks
    (which had this push_all as an explicit manual bypass already), comments
    had NO bypass at all: locally, or on any instance that loses the
    sync-worker race, a comment could never reach Asana by any means. This
    closes that gap the same way push_task already covers task edits made
    while sync was off - a comment just sits unsynced (no AsanaCommentLink)
    until the next push_all catches it up."""
    cfg = get_config(db)
    if not sync_is_on(cfg) or not cfg.token:
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
    # This is what makes "Push all" a complete outbound sync - on a laptop it's
    # the ONLY way a locally deleted task ever reaches Asana.
    drained = drain_pending_deletes(db)
    return {"pushed": n, "deleted": drained["deleted"], "pendingDeletes": drained["pending"]}


# ── INBOUND: Asana -> Nexus (poll) ───────────────────────────────────────────
# Reverse of _BUILTIN_STATUS_LABELS for the unambiguous built-in states only.
# Every OTHER option on Asana's "Task Progress" field ("Waiting", "Deferred",
# anything a project invents) becomes a TaskCustomStatus scoped to the projects
# that use it - see seed_project_statuses. These used to be dropped, which left
# the task sitting in whatever status Nexus already had.
_PROGRESS_LABEL_TO_STATUS = {"not started": "not_started", "in progress": "in_progress", "done": "completed"}

# Colors for auto-created statuses, by position - the board needs a usable chip
# and Asana's enum option colors don't come back on this call.
_STATUS_PALETTE = ["#6366f1", "#0891b2", "#d97706", "#7c3aed", "#db2777", "#059669", "#475569"]


def seed_project_statuses(db, cfg, project_gid, nexus_project_id):
    """Mirror Asana's "Task Progress" options that have no built-in Nexus
    equivalent into TaskCustomStatus rows scoped to this project.

    Same principle as seed_project_fields: driven by the project's field
    settings, so a stage added in Asana becomes a Nexus board column on its own,
    on that project only. Identity is the enum option gid, so renaming a stage
    in Asana renames the Nexus status instead of orphaning it and creating a
    second one."""
    if not project_gid or not nexus_project_id:
        return 0
    field = _find_enum_field(cfg, project_gid, "Task Progress")
    if not field:
        return 0
    n = 0
    existing = {s.asana_option_gid: s for s in db.query(models.TaskCustomStatus)
                .filter(models.TaskCustomStatus.asana_option_gid != "").all()}
    position = db.query(models.TaskCustomStatus).count()
    for label_lower, option_gid in (field.get("options") or {}).items():
        if not option_gid or label_lower in _PROGRESS_LABEL_TO_STATUS:
            continue   # a built-in state - Task.status already carries it
        s = existing.get(option_gid)
        if s is None:
            s = models.TaskCustomStatus(
                id=gen_id(), label=label_lower.title(), color=_STATUS_PALETTE[position % len(_STATUS_PALETTE)],
                position=position, project_ids=[nexus_project_id], asana_option_gid=option_gid)
            db.add(s)
            db.flush()   # autoflush=False - must be visible to the rest of this pull
            position += 1
            n += 1
            continue
        scope = [p for p in (s.project_ids or []) if p]
        if scope and nexus_project_id not in scope:
            s.project_ids = scope + [nexus_project_id]
    return n


def _status_for_progress(db, progress_label, nexus_project_id):
    """The Nexus status id for one Asana "Task Progress" label: a built-in where
    one exists, else the custom status seeded for it. None means Asana told us
    nothing usable, and the caller leaves Nexus's status alone."""
    label = (progress_label or "").strip().lower()
    if not label:
        return None
    if label in _PROGRESS_LABEL_TO_STATUS:
        return _PROGRESS_LABEL_TO_STATUS[label]
    for s in db.query(models.TaskCustomStatus).all():
        if (s.label or "").strip().lower() != label:
            continue
        scope = [p for p in (s.project_ids or []) if p]
        if not scope or not nexus_project_id or nexus_project_id in scope:
            return s.id
    return None


def _progress_from_custom_fields(at):
    for cf in at.get("custom_fields") or []:
        if (cf.get("name") or "").strip().lower() == "task progress":
            return ((cf.get("enum_value") or {}).get("name") or "").strip().lower()
    return ""


def _adopt_candidate(db, name, nexus_project_id, parent_task_id):
    """An existing, not-yet-linked Nexus task that this Asana task should adopt
    instead of being created again - same title, same place in the hierarchy.

    Two things this gets right that the old inline query didn't, each of which
    was minting duplicates:

    - SCOPE. A subtask is stored with project_id="" (its project is reached
      through the parent - asana_import.py's convention, kept by _apply_inbound
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


# {"all": (ts, {lookup key -> canonical work email})} - the Nexus people
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

    The local-part key is what turns an Asana guest address -
    sagar.shoundik@greensg.onmicrosoft.com, the M365 relay Asana shows for
    guest accounts - into the real person, without hardcoding that domain:
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
    then the Nexus directory, then the address is kept as-is - an outside
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


# ── Rich-text descriptions <-> Asana html_notes ──────────────────────────────
# Nexus descriptions are HTML (tasks/RichDescription.jsx). Asana holds the same
# on html_notes but accepts only a fixed tag subset inside a <body> root -
# anything else 400s the whole update. So outbound is sanitized to that subset,
# inbound reads html_notes when present and falls back to plain `notes`.
#
# Asana's supported set (per its API docs). <p> is NOT in it: paragraphs become
# newlines, which is why _to_asana_html unwraps them.
_ASANA_HTML_TAGS = {"a", "b", "strong", "i", "em", "u", "s", "code", "pre",
                    "blockquote", "ol", "ul", "li", "h1", "h2", "hr", "br"}
_TAG_RE = re.compile(r"<\s*(/?)\s*([a-zA-Z0-9]+)([^>]*)>")
_HREF_RE = re.compile(r'href\s*=\s*["\']([^"\']*)["\']', re.I)
# A Nexus @mention is stored as a mailto link (tasks/RichDescription.jsx).
_MAILTO_MENTION_RE = re.compile(r'<a\s+[^>]*href\s*=\s*["\']mailto:([^"\'>\s]+)["\'][^>]*>(.*?)</a>', re.I | re.S)
# Asana mention: <a href=".../profile/<n>" data-asana-gid="<user gid>"
# data-asana-type="user">@Name</a>. Two traps: the profile-URL number is NOT
# the user gid (data-asana-gid is), and attachments use the identical anchor
# with data-asana-type="attachment" - matching on the gid alone makes every
# inline image a bogus mention. The self-closing form is what we write out.
_ASANA_MENTION_RE = re.compile(
    r'<a\s+(?=[^>]*data-asana-gid)(?![^>]*data-asana-type\s*=\s*["\'](?!user))'
    r'([^>]*?)(?:/>|>(.*?)</a>)', re.I | re.S)
_PROFILE_GID_RE = re.compile(r'/profile/(\d+)', re.I)
_DATA_GID_RE = re.compile(r'data-asana-gid\s*=\s*["\'](\d+)["\']', re.I)


def _task_write(token, method, path, fields):
    """Create/update an Asana task, degrading rich text rather than losing the
    whole write. Asana validates html_notes strictly and rejects the entire
    request when it dislikes the markup - a task whose description contains
    something _to_asana_html didn't anticipate would otherwise never sync at
    all, taking its title, dates, and assignee down with it. On that one error
    we retry with the plain-text equivalent on `notes`.

    Sending both notes and html_notes is itself an error, hence the swap rather
    than including both up front."""
    send = _asana_put if method == "PUT" else _asana_post
    try:
        return send(token, path, {"data": fields})
    except ImportError_ as e:
        if "html_notes" not in str(e) or "html_notes" not in fields:
            raise
        plain = dict(fields)
        plain.pop("html_notes", None)
        plain["notes"] = _html_to_text(fields.get("html_notes") or "")
        print(f"[asana] html_notes rejected for {path}; retrying as plain notes ({e})")
        return send(token, path, {"data": plain})


def _html_to_text(html):
    """Visible text of an HTML fragment, with block boundaries as newlines."""
    s = re.sub(r"(?i)<\s*/?\s*(p|div|li|br|h1|h2|h3|blockquote|pre)[^>]*>", "\n", html or "")
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\n{3,}", "\n\n", unescape(s)).strip()


def _mentions_to_asana(html, cfg):
    """Rewrite Nexus @mentions into real Asana mentions.

    Nexus stores a mention as `<a href="mailto:person@greensglobal.com">@Name</a>`;
    Asana wants `<a data-asana-gid="123"/>` and renders its own @Name from the
    gid, which is what makes the person actually get notified in Asana rather
    than just seeing a mailto link.

    Resolution goes through _asana_user_gid, so the guest-relay case is already
    handled: someone stored in Nexus as person@greensglobal.com whose Asana
    account is person@greensg.onmicrosoft.com matches on the bare local part.
    A mention that can't be resolved is LEFT as a mailto link - better a
    working link than a dropped name."""
    if not cfg or not html:
        return html

    def swap(m):
        gid = _asana_user_gid(cfg, m.group(1))
        return f'<a data-asana-gid="{gid}"/>' if gid else m.group(0)

    return _MAILTO_MENTION_RE.sub(swap, html)


def _to_asana_html(html, cfg=None):
    """Nexus description HTML -> the <body>…</body> string Asana's html_notes
    accepts. Unsupported tags are dropped (their text survives); <p> becomes a
    blank-line break; <mark> has no Asana equivalent so a highlight degrades to
    plain text, and images can't be inlined at all so they are dropped - the
    file itself still reaches Asana through the attachment push.

    `cfg` enables real Asana mentions (see _mentions_to_asana); without it a
    mention stays a mailto link, which still reads correctly."""
    s = _mentions_to_asana(html or "", cfg)
    if not s.strip():
        return ""
    s = re.sub(r"(?is)<\s*(script|style)[^>]*>.*?<\s*/\s*\1\s*>", "", s)
    # Both ends of a paragraph become newlines: closing alone would glue a
    # paragraph that follows a list straight onto the </ul>.
    s = re.sub(r"(?i)</?\s*p[^>]*>", "\n", s)
    s = re.sub(r"(?i)<\s*br\s*/?>", "\n", s)
    s = re.sub(r"(?i)<\s*img[^>]*>", "", s)

    def keep(m):
        closing, tag, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if tag not in _ASANA_HTML_TAGS:
            return ""
        if tag == "a" and not closing:
            gid = _DATA_GID_RE.search(attrs)
            # Only OUR mention form (bare data-asana-gid) becomes a mention anchor. Anchors
            # still carrying Asana's data-asana-type are inbound markup - an attachment there
            # would be re-emitted as a mention of a gid that isn't a user.
            if gid and "data-asana-type" not in attrs.lower():
                # The gid is the whole payload: Asana rejects an anchor that
                # carries both this and an href.
                return f'<a data-asana-gid="{gid.group(1)}"/>'
            href = (_HREF_RE.search(attrs) or [None, ""])[1] if _HREF_RE.search(attrs) else ""
            return f'<a href="{escape(href, quote=True)}">' if href else ""
        return f"<{'/' if closing else ''}{tag}>"

    s = _TAG_RE.sub(keep, s)
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return f"<body>{s}</body>" if s else ""


def _asana_user_email(cfg, gid):
    """Asana user gid -> the NEXUS email for that person (guest relay resolved
    through the directory by _map_email). Cached with the same user map the
    outbound direction uses."""
    if not gid:
        return ""
    key = (cfg.token, cfg.workspace_gid)
    ent = _USER_GID_CACHE.get(key)
    if not ent or time.time() - ent[0] >= _USER_TTL:
        table = {}
        try:
            for u in Asana(cfg.token).get(f"/workspaces/{cfg.workspace_gid}/users",
                                          opt_fields="email,name"):
                if u.get("gid"):
                    table[str(u["gid"])] = {"email": (u.get("email") or "").lower(),
                                            "name": u.get("name") or ""}
        except Exception:
            pass
        ent = (time.time(), table)
        _USER_GID_CACHE[key] = ent
    return ent[1].get(str(gid)) or {}


_USER_GID_CACHE = {}


def _mentions_from_asana(html, cfg, db):
    """Asana mention anchors -> the mailto form the Nexus editor understands, so
    the mention stays clickable and keeps naming the right person."""
    if not cfg or not html or not getattr(cfg, "workspace_gid", ""):
        return html

    def swap(m):
        attrs, label = m.group(1) or "", (m.group(2) or "").strip()
        # data-asana-gid is the user gid; the profile URL carries a different
        # number, kept only as a fallback for markup that lacks the attribute.
        hit = _DATA_GID_RE.search(attrs) or _PROFILE_GID_RE.search(attrs)
        who = _asana_user_email(cfg, hit.group(1)) if hit else {}
        email = _map_email(who.get("email", ""), None, db)
        if not email:
            # Nobody we know - keep the visible name rather than a bare profile
            # URL, which is what Asana's plain-text fallback would have given.
            return label or (f"@{who['name']}" if who.get("name") else "")
        if not label:
            label = f"@{who.get('name') or email}"
        if not label.startswith("@"):
            label = f"@{label}"
        return f'<a href="mailto:{escape(email, quote=True)}">{escape(label)}</a>'

    return _ASANA_MENTION_RE.sub(swap, html)


def _from_asana_html(at):
    """Asana task -> Nexus description HTML. Prefers html_notes (unwrapping the
    <body> root Asana always adds); falls back to escaping plain `notes` so a
    task written in Asana's plain editor doesn't render as literal markup."""
    raw = (at.get("html_notes") or "").strip()
    if raw:
        m = re.search(r"(?is)^<body>(.*)</body>$", raw)
        return (m.group(1) if m else raw).strip()
    notes = at.get("notes") or ""
    if not notes.strip():
        return ""
    return "".join(f"<p>{escape(line)}</p>" for line in notes.split("\n") if line.strip())


def _apply_inbound(db, at, nexus_project_id, counts, parent_task_id="", email_map=None):
    """Apply one Asana task into Nexus (create or update). `parent_task_id` set
    means this is a subtask - matches asana_import.py's convention of an empty
    project_id on subtasks (their project is reached via the parent). Returns
    the Nexus task id."""
    from routers.tasks import _next_code
    gid = at["gid"]
    assignee = _map_email((at.get("assignee") or {}).get("email"), email_map, db)
    progress_label = _progress_from_custom_fields(at)
    mapped_status = _status_for_progress(db, progress_label, nexus_project_id)
    priority_label = _priority_from_custom_fields(at)
    mapped_priority = _PRIORITY_LABEL_TO_VALUE.get(priority_label)
    tag_names = [(tg.get("name") or "").strip() for tg in (at.get("tags") or []) if (tg.get("name") or "").strip()]
    is_milestone = at.get("resource_subtype") == "milestone"
    follower_emails = sorted({_map_email(f.get("email"), email_map, db)
                              for f in (at.get("followers") or []) if f.get("email")})
    section_name = _asana_section_name(at)
    link = _link_by_asana(db, gid)
    inbound_html = _mentions_from_asana(_from_asana_html(at), get_config(db), db)
    inbound_fields = _inbound_custom_fields(db, at, nexus_project_id, email_map)
    inbound_digest = _digest(at.get("name"), inbound_html, at.get("due_on"), bool(at.get("completed")),
                             assignee, progress_label, priority_label,
                             at.get("start_on"), tag_names, is_milestone, section_name,
                             fields=inbound_fields)
    if link:
        t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
        if not t:
            return None
        # Compare Asana-now against Asana-at-last-apply. Comparing it against
        # last_hash (the NEXUS-side digest) meant every pull re-applied every
        # task whenever the Asana project had no Task Progress/Priority custom
        # fields, because those two digests can never converge in that case.
        # An empty last_inbound_hash is a link written before this column
        # existed - treat it as "unknown", apply once, and it settles.
        if link.last_inbound_hash != inbound_digest:
            t.title = at.get("name") or t.title
            t.description = inbound_html
            # Additive: a field Asana doesn't carry keeps whatever Nexus has, so
            # a Nexus-only field isn't wiped by every pull.
            if inbound_fields:
                t.custom_field_values = {**(t.custom_field_values or {}), **inbound_fields}
            t.start_on = (at.get("start_on") or "")[:10]
            t.due_on = (at.get("due_on") or "")[:10]
            t.assignee_email = assignee
            t.tags = tag_names
            t.is_milestone = is_milestone
            # Additive only, like the outbound side - a follower removed in
            # Asana keeps following in Nexus, matching this module's one-way-
            # additive stance elsewhere (dependencies, project access).
            t.follower_emails = sorted(set(t.follower_emails or []) | set(follower_emails))
            # Asana's native `completed` checkbox and the "Task Progress"
            # custom field are independent - someone can set the field to
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
    # No link yet - before creating, try to adopt a matching Nexus task (same
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
        # "no link yet" and created a whole second Nexus task - the duplicate
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
        description=inbound_html, type="milestone" if is_milestone else "task",
        status="completed" if completed else (mapped_status or "not_started"),
        priority=mapped_priority or "medium",
        assignee_email=assignee, project_id="" if parent_task_id else (nexus_project_id or ""),
        section_id="" if parent_task_id else _nexus_section_id(db, nexus_project_id, section_name),
        parent_task_id=parent_task_id or "", start_on=(at.get("start_on") or "")[:10],
        due_on=(at.get("due_on") or "")[:10],
        completed=completed, completed_at=now if completed else "", is_milestone=is_milestone,
        follower_emails=follower_emails, liked_by_emails=[], subtask_ids=[], blocked_by_ids=[],
        blocking_ids=[], dependency_types={}, tags=tag_names, custom_field_values=inbound_fields,
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
    db.flush()   # visible to the rest of this pull - see the note above
    counts["created"] += 1
    aid = log_activity(db, type="synced_from_asana", actor_email="asana-sync", entity_id=t.id,
                       entity_code=t.code, entity_title=t.title, detail="Created from Asana")
    t.activity_ids = list(t.activity_ids or []) + [aid]
    return t.id


def delete_nexus_task(db, task, actor="asana-sync", detail="Deleted in Asana"):
    """Delete a Nexus task and everything hanging off it, mirroring
    routers.tasks.delete_task (which can't be reused here - it's a route
    handler wired to Depends and a live user). Subtasks go with the parent,
    same as deleting in the UI, and their Asana links go too so a later pull
    can't resurrect half a tree. Does not commit.

    NOTE: this NEVER calls queue_task_delete - it removes the Nexus side only
    and deliberately leaves Asana untouched. That is what makes it safe to
    reuse for purge_project_sync, where the whole point is to throw the Nexus
    copy away and re-import it from an Asana project that must survive.
    `detail` names the reason in the activity log, since the caller is no
    longer always an inbound Asana deletion."""
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
    # back - the dedup check would keep matching a story gid whose Nexus row no
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
                 entity_title=task.title, detail=detail)
    db.query(models.Task).filter(models.Task.id.in_(ids)).delete(synchronize_session="fetch")
    return ids


def unlink_deleted_task(db, gid):
    """Handle an Asana task that no longer exists. A deleted Asana task never
    shows up in pull() again - its project's task list just omits it, there's
    no tombstone to poll for - so the webhook's 'deleted' event and _reap_deleted
    below are the only two signals we get.

    With delete_sync on (the default) the Nexus task is deleted to match.
    With it off we fall back to the old behaviour: drop the link and flag the
    task unsynced, leaving the Nexus row alone."""
    link = _link_by_asana(db, gid)
    if not link:
        return False
    t = db.query(models.Task).filter(models.Task.id == link.nexus_task_id).first()
    if t and delete_sync_is_on(get_config(db)):
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
# fails (and is swallowed) - this is the moment it can finally be built.
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
    # longer exists - which then defeats delete_nexus_task's cleanup (it clears
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

    Rows written before that resolution existed still carry the raw address -
    …@greensg.onmicrosoft.com for a guest account - which matches nobody in the
    People directory, so the task shows an empty avatar and the person can't be
    filtered on. A linked task self-heals on the next pull (the mapped address
    is part of the inbound digest), but an unlinked one never would, and the
    member/follower lists are additive so a pull only ADDS the corrected
    address while the stale one lingers beside it. This fixes both.

    Addresses that resolve to nobody - a genuine outside collaborator - are
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
    left over from an earlier era - a top-level row with no project_id and no
    parent, invisible in every project view - is older than the correctly filed
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
    above), but rows already written stay until they're merged - dev had 120
    Asana gids carrying 2-5 AsanaTaskLink rows each, which is exactly what a
    project looking like it imported every task three times is made of.

    The survivor is chosen by _survivor_rank - properly filed first, then
    oldest. Every duplicate hands its comments, attachments, activity and
    subtasks over before it is deleted, so nothing written on a duplicate is
    lost. Links whose task no longer exists are dropped too, and same-named
    sections within a project are collapsed the same way.

    `apply=False` (the default) counts and reports without writing anything -
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
            # The survivor's own digest changed (merged followers/tags) - refresh
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
            db.rollback()   # something still duplicated - the code-level guards still hold
    elif out["sections"] or out["people"]:
        db.rollback()       # dry run: the scans above leave nothing behind
    return out


_STORY_OPT_FIELDS = "type,resource_subtype,text,html_text,created_at,created_by.name,created_by.email"


# How far back to look for a Nexus comment that matches an incoming story.
# Generous because the failure it repairs (a link that never committed) can sit
# unnoticed until the next full sweep, but bounded so an unrelated comment with
# identical text months later is never adopted.
_ADOPT_WINDOW_SECONDS = 24 * 60 * 60


def _adopt_pushed_comment(db, nexus_task_id, story_text, story_at):
    """The Nexus comment this Asana story was created FROM, if it looks like one
    of ours that lost its link - else None.

    Matched on (same task, same visible text, no existing link, created near the
    story). Comments that already carry a link are excluded, so a genuine Asana
    comment can never be mistaken for one: the only candidates are Nexus-side
    comments that were never successfully linked.

    A false positive needs somebody to write a Nexus comment that fails to link
    AND somebody to independently write character-identical text in Asana inside
    the window - and even then the outcome is one comment rather than two, which
    is what was wanted anyway."""
    wanted = _html_to_text(story_text or "").strip()
    if not wanted:
        return None
    try:
        story_dt = datetime.fromisoformat((story_at or "").replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        story_dt = datetime.now(timezone.utc)
    linked = {r[0] for r in db.query(models.AsanaCommentLink.nexus_comment_id).all()}
    rows = (db.query(models.TaskComment)
            .filter(models.TaskComment.task_id == nexus_task_id).all())
    for c in rows:
        if c.id in linked:
            continue
        if _html_to_text(c.body or "").strip() != wanted:
            continue
        try:
            made = datetime.fromisoformat((c.created_at or "").replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            continue
        if made.tzinfo is None:
            made = made.replace(tzinfo=timezone.utc)
        if abs((story_dt - made).total_seconds()) <= _ADOPT_WINDOW_SECONDS:
            return c
    return None


def _pull_stories(db, asana, asana_gid, nexus_task_id, counts):
    """Bring an Asana task's whole story feed into Nexus, deduped by story gid.

    Asana's /stories endpoint carries two kinds of entry and Nexus has a home
    for both:
      - COMMENTS      -> TaskComment      (AsanaCommentLink)
      - SYSTEM stories -> TaskActivity    (AsanaActivityLink)
    System stories are things like "changed the due date to Aug 8" or "marked
    this complete" - Asana's activity log. Dropping them (which is what this
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
            # Is this story one WE pushed, whose link never landed? push_comment
            # POSTs the story and only then commits the AsanaCommentLink, so a
            # pull that arrives in between - the webhook fires the instant the
            # story exists - finds no link and used to create a SECOND Nexus
            # comment. Same outcome if the commit failed outright, except that
            # one repeats on every future pull.
            #
            # Adopting the existing comment instead of duplicating it also
            # repairs the missing link, so the next pull short-circuits above.
            adopted = _adopt_pushed_comment(db, nexus_task_id, text, at_ts)
            if adopted:
                db.add(models.AsanaCommentLink(id=gen_id(), nexus_comment_id=adopted.id,
                                               asana_story_gid=sgid, created_at=now_iso()))
                db.flush()
                continue
            cid = gen_id()
            # Keep Asana's formatting where it sent any - html_text is the rich version,
            # `text` the flattened fallback, which is escaped so a comment containing < or
            # & can't render as markup in the Nexus editor.
            rich = _mentions_from_asana(_from_asana_html({"html_notes": s.get("html_text") or ""}), get_config(db), db)
            plain = "".join(f"<p>{escape(line)}</p>" for line in text.split("\n") if line.strip())
            # Attribute the comment to the real person. author_email is already
            # resolved through the directory above and was already used for
            # activity rows - comments just hardcoded "asana-sync", which is why
            # they showed up authored by a placeholder. The "[Asana - Name]"
            # stamp is only needed when the author CAN'T be resolved (an Asana
            # account with no Nexus counterpart, or no email on the story); with
            # a real author_email the name would be shown twice.
            stamp = "" if author_email else f'<p><em>[Asana · {escape(author_name)}]</em></p>'
            body = f"{stamp}{rich or plain}"
            db.add(models.TaskComment(id=cid, task_id=nexus_task_id,
                                      author_email=author_email or "asana-sync",
                                      body=body, created_at=at_ts,
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
# (Google Drive/Dropbox etc - host != "asana"), just keeps its Asana view URL
# rather than pulling the bytes through this API.
_ATTACHMENT_MAX_BYTES = int(5 * 1024 * 1024)


def _pull_attachments(db, asana, asana_gid, nexus_task_id, counts, email_map=None):
    """Bring Asana attachments into the Nexus task, deduped by attachment gid
    (AsanaAttachmentLink) - inbound only, Nexus attachments aren't pushed back
    to Asana (would need fetching a possibly-private Supabase URL and
    re-uploading; out of scope here)."""
    counts.setdefault("attachments", 0)
    try:
        rows = asana.get(f"/tasks/{asana_gid}/attachments",
                         opt_fields="name,download_url,permanent_url,view_url,size,host,created_by.email")
    except Exception:
        return
    for a in rows:
        agid = a.get("gid")
        if not agid or db.query(models.AsanaAttachmentLink).filter(
                models.AsanaAttachmentLink.asana_attachment_gid == agid).first():
            continue
        # Same resolution as assignee/followers (_map_email) - falls back to the
        # Asana address as-is if it maps to no Nexus employee (nameOf still
        # prettifies that into something readable), and only to the literal
        # "asana-sync" placeholder if Asana gave no creator at all.
        uploader = _map_email((a.get("created_by") or {}).get("email"), email_map, db) or "asana-sync"
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
                                     added_at=now_iso(), added_by=uploader))
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
    "FS" (Finish-to-Start) - Asana's dependency model has no FS/SS/FF/SF
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
# the same Asana task at once and each create their own duplicate Nexus task -
# the same class of dedupe race that bit us with batched notifications
# (see CLAUDE.md). This threading.Lock only serializes threads within ONE
# process, though - gunicorn runs 8 worker processes per instance (startup.sh)
# and is_sync_worker() qualifies all of them, so webhook events landing on
# different workers still raced each other (Jul 2026: one Asana task showed up
# 4x in Nexus dev). Kept as a cheap first line of defense for same-process bursts;
# _acquire_pull_lock below is what actually closes the cross-process race.
_PULL_LOCK = threading.Lock()

# Arbitrary fixed key for Postgres's advisory-lock keyspace - any int works, it
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


# Asana access_level -> Nexus Share-panel role (task_util.PROJECT_ROLE_RANK).
# Asana's "admin" is our "owner"; the rest share names. Anything unrecognized
# leaves the team's existing role alone rather than guessing.
_ACCESS_LEVEL_TO_ROLE = {"admin": "owner", "editor": "editor",
                         "commenter": "commenter", "viewer": "viewer"}


# {(token, workspace_gid): (ts, {name_lower: gid})} - workspace teams, for
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
    """Find-or-create the TaskTeam named `name` and make sure it covers this
    project.

    ONE Nexus team per Asana team, no matter how many projects it works on. This
    used to create a separate team row per project, because TaskTeam could only
    hold one project_id - so a single real team (IT, Development) that Asana
    shares across three projects became three identical Nexus cards, told apart
    only by their project chips. Now a team carries a LIST of projects and the
    existing row is simply extended.

    Matching is by name, case- and whitespace-insensitive, the same key Asana
    teams are resolved by everywhere else in this module."""
    from routers.task_util import team_project_ids
    name_key = name.strip().lower()
    match = next((t for t in db.query(models.TaskTeam).all()
                  if (t.name or "").strip().lower() == name_key), None)
    if match:
        ids = team_project_ids(match)
        if nexus_project_id and nexus_project_id not in ids:
            match.project_ids = ids + [nexus_project_id]
            if not (match.project_id or ""):
                match.project_id = nexus_project_id   # legacy mirror: first project wins
            db.flush()
        return match
    match = models.TaskTeam(id=gen_id(), project_id=nexus_project_id,
                            project_ids=[nexus_project_id] if nexus_project_id else [],
                            name=name, color="", icon="", member_emails=[], created_at=now_iso())
    db.add(match)
    db.flush()
    return match


def _sync_project_access(db, asana, cfg, project_gid, nexus_project_id, extra_team_names=None,
                         report=None):
    """Pull Asana's project-level access into real Nexus visibility, not just a
    display list: task_util.visible_project_ids() grants a restricted project's
    visibility via TaskProject.member_emails or via membership in a TaskTeam
    assigned to that project, so this is additive on top of both.

    Access sources, in order of what they can see:

    - **GET /memberships?parent={project_gid}** - the one that actually answers
      the question. It returns EVERY membership as a `member` union, tagged with
      `resource_type` of "user" or "team", each with its `access_level`. An
      ad-hoc team share shows up here as a plain row:
          {"access_level": "editor",
           "member": {"gid": "…", "resource_type": "team", "name": "IT"}}

      This supersedes a long-standing note in this function claiming it was
      CONFIRMED that Asana's API had no route exposing an ad-hoc team share.
      That conclusion came from testing the full unfiltered /projects/{gid},
      /projects/{gid}/project_memberships, and two guessed endpoints - the
      generic /memberships collection was never tried. It was wrong: verified
      live (Jul 2026) against a private project with team=null whose IT share
      came back correctly. /projects/{gid}/project_memberships still returns
      users only and silently drops a `member.*` opt_fields request, with or
      without the new_memberships beta header, which is what made the old
      conclusion look solid.

    - /projects/{gid}'s own `team` field - the project's OWNING team, if any.
      Still read, because a project can have an owning team that holds no
      membership row.

    - `extra_team_names` (AsanaProjectMap.extra_team_names) - the manual
      override that existed only because detection was believed impossible. No
      longer needed and no longer offered in the UI; still honored for any value
      already saved, so an existing config keeps working.

    One-way and additive only, same as the rest of this module - someone
    removed from the Asana side keeps whatever Nexus access they already have
    (mirrors unlink_deleted_task's "Asana deletion doesn't delete the Nexus
    side"). Asana guest accounts are frequently a relay address (e.g.
    ...@xyz.onmicrosoft.com) that doesn't match the person's real Nexus email;
    _map_email resolves those through the Nexus directory, so such an account
    now grants access to the actual person instead of adding a dead address
    that matches nobody.

    `report` collects a one-line outcome per team so the caller can show it.
    Every step here fails silently by design (a bad token or a renamed team must
    not abort a pull), which is fine for the machine and useless for the human:
    "the team didn't come across" had at least four indistinguishable causes -
    no workspace GID configured, the name not matching anything in the
    workspace, Asana returning no members, or the whole block throwing. Each one
    now says which."""
    def _say(msg):
        if report is not None:
            report.append(msg)

    if not nexus_project_id:
        return
    project = db.query(models.TaskProject).filter(models.TaskProject.id == nexus_project_id).first()
    if not project:
        return
    wanted = set()
    granted_gids = set()   # Asana team gids already handled from the membership list
    try:
        # One call, both kinds of member. `member` is a union - resource_type
        # says which - so users and shared teams arrive together with the
        # access_level Asana grants each.
        for row in asana.get("/memberships", parent=project_gid,
                             opt_fields="member.name,member.email,member.resource_type,access_level"):
            m = row.get("member") or {}
            kind = m.get("resource_type")
            if kind == "user":
                em = _map_email(m.get("email"), None, db)
                if em:
                    wanted.add(em)
            elif kind == "team" and m.get("gid"):
                tname = (m.get("name") or "").strip()
                if not tname:
                    continue
                roster = [e for e in (_map_email(e, None, db) for e in _team_users(asana, m["gid"])) if e]
                if not roster:
                    _say(f"{tname}: shared with this project, but Asana returned no members for it")
                    continue
                nt = _ensure_team(db, nexus_project_id, tname)
                nt.member_emails = sorted(set(nt.member_emails or []) | set(roster))
                role = _ACCESS_LEVEL_TO_ROLE.get((row.get("access_level") or "").lower())
                if role:
                    nt.access_role = role
                granted_gids.add(m["gid"])
                _say(f"{tname}: granted from Asana's sharing list, {len(roster)} member(s)"
                     + (f", as {role}" if role else ""))
    except Exception as e:
        _say(f"could not read this project's sharing list from Asana: {str(e)[:120]}")
    try:
        proj = asana.get(f"/projects/{project_gid}", opt_fields="team.gid,team.name,name,notes")
        # Kept refreshed on every pull - previously only ever set once at
        # creation (one-shot import / first Pull), so a rename in Asana never
        # reached Nexus after that.
        if proj.get("name"):
            project.name = proj["name"]
        project.description = proj.get("notes") or ""
        team = (proj or {}).get("team") or {}
        team_gid, team_name = team.get("gid"), (team.get("name") or "").strip()
        # Skipped when the membership list already covered it - the owning team
        # is usually in there too, and re-fetching its roster costs a call for
        # an answer we have.
        if team_gid and team_name and team_gid not in granted_gids:
            roster = [e for e in (_map_email(e, None, db) for e in _team_users(asana, team_gid)) if e]
            if roster:
                nt = _ensure_team(db, nexus_project_id, team_name)
                nt.member_emails = sorted(set(nt.member_emails or []) | set(roster))
                _say(f"{team_name}: owning team, {len(roster)} member(s)")
            else:
                _say(f"{team_name}: owning team, but Asana returned no members for it")
    except Exception as e:
        _say(f"could not read the project's own team from Asana: {str(e)[:120]}")
    # Legacy escape hatch: nothing writes these any more (the field is gone from
    # the UI now that /memberships detects shares on its own), but a config saved
    # before that keeps being honored rather than silently going dead.
    for name in extra_team_names or []:
        name = (name or "").strip()
        if not name:
            continue
        if not cfg.workspace_gid:
            # _workspace_team_gid can only look teams up inside a workspace, so
            # with none configured this could never have worked - and used to
            # just `continue` forever without saying so.
            _say(f"{name}: no Workspace GID configured, so named teams can't be looked up")
            continue
        team_gid = _workspace_team_gid(asana, cfg, name)
        if not team_gid:
            _say(f"{name}: no team by that name in the Asana workspace (check spelling)")
            continue   # try again next pull - the team may be created later
        roster = [e for e in (_map_email(e, None, db) for e in _team_users(asana, team_gid)) if e]
        if not roster:
            _say(f"{name}: found in Asana, but it returned no members "
                 "(the sync token may not be allowed to see that team's roster)")
            continue
        nt = _ensure_team(db, nexus_project_id, name)
        nt.member_emails = sorted(set(nt.member_emails or []) | set(roster))
        _say(f"{name}: granted, {len(roster)} member(s)")
    if wanted - set(project.member_emails or []):
        project.member_emails = sorted(set(project.member_emails or []) | wanted)


# Shared field list for the top-level task list AND the recursive subtask
# fetch, so both carry everything _apply_inbound/_pull_attachments/
# _sync_task_dependencies need. One list, used by every inbound path (Pull,
# webhook, one-shot Import) - a field added here reaches all three at once,
# which is the only way "no detail gets missed" stays true as this grows.
_TASK_OPT_FIELDS = ("name,notes,html_notes,start_on,due_on,completed,assignee.email,modified_at,"
                   "custom_fields.gid,custom_fields.name,custom_fields.resource_subtype,"
                   "custom_fields.is_formula_field,custom_fields.display_value,"
                   "custom_fields.enum_value.name,custom_fields.multi_enum_values.name,"
                   "custom_fields.people_value.email,"
                   "custom_fields.text_value,custom_fields.number_value,custom_fields.date_value,"
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
    existed), every task resolves to the same one - the oldest - instead of
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
    legitimately reaches us more than once - a subtask that has also been added
    to the project shows up in /projects/{gid}/tasks AND in its parent's
    /tasks/{gid}/subtasks, and a task shared into two mapped projects shows up
    in both - and re-applying it is at best wasted API calls (comments,
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
    _pull_attachments(db, asana, gid, nexus_task_id, counts, email_map)
    _sync_task_dependencies(db, at, nexus_task_id)
    if deferred is not None:
        # Re-resolved at the end of the run by resolve_dependencies, when every
        # task in this walk is linked - the inline call above can only see
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
    board isn't the same as deleting it), and so is any inconclusive answer -
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

    Asana leaves no tombstone - a deleted task is simply absent from the
    project's task list - so this is the pull-side complement to the webhook's
    'deleted' event (unlink_deleted_task), and the only thing that catches
    deletions that happened while webhooks were off or unregistered. A linked
    task in this project whose gid never came back in the walk is a candidate;
    _asana_task_gone then has to confirm it with Asana before anything is
    removed. Candidates are normally zero, so this costs no API calls at all in
    the steady state."""
    if not delete_sync_is_on(cfg) or not nexus_project_id:
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


# How often a project gets a FULL listing instead of an incremental one. Only a
# full run can see deletions (a deleted task just stops being returned, which
# reads identically to "not modified") or catch a subtask edited on its own,
# which does not always bump its parent's modified_at.
_FULL_SWEEP_MIN = 30
# Rewind on the modified_since cursor. Covers clock skew between us and Asana
# and any edit landing while a pull is mid-flight; re-applying a task we already
# have is free (the digests short-circuit it), missing one is not.
_PULL_OVERLAP_SEC = 120


def _pull_window(pm, now):
    """(modified_since | "", is_full) for one mapped project.

    Full when we have never pulled it, when the last full listing has aged out,
    or when the cursor is unreadable - anything uncertain resolves to the safe,
    complete option."""
    if not pm.last_pull_at or not pm.last_full_pull_at:
        return "", True
    try:
        last_full = datetime.fromisoformat(pm.last_full_pull_at)
        cursor = datetime.fromisoformat(pm.last_pull_at)
    except ValueError:
        return "", True
    if last_full.tzinfo is None:
        last_full = last_full.replace(tzinfo=timezone.utc)
    if cursor.tzinfo is None:
        cursor = cursor.replace(tzinfo=timezone.utc)
    if (now - last_full).total_seconds() >= _FULL_SWEEP_MIN * 60:
        return "", True
    return (cursor - timedelta(seconds=_PULL_OVERLAP_SEC)).isoformat(), False


def pull(db, force_full=False):
    """Poll every mapped Asana project and apply changes into Nexus: tasks
    (subtasks included), comments, attachments, dependencies, status/priority
    custom fields, and project access.

    Incremental by default: each project carries a modified_since cursor, so a
    routine poll asks Asana only for what changed rather than re-listing every
    task every couple of minutes. A full listing still runs per project every
    _FULL_SWEEP_MIN, because an incremental fetch cannot see a deletion and
    only a complete list may be reaped against.

    `force_full` is for the manual Pull button, where the operator is asking for
    a reconcile and expects deletions and drift to be picked up now."""
    cfg = get_config(db)
    if not sync_is_on(cfg) or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    with _PULL_LOCK:
        refresh_directory_cache()   # people added since the last run resolve too
        asana = Asana(cfg.token)
        counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                  "attachments": 0, "deleted": 0, "teams": []}
        seen = set()   # gids applied this run - one per run, across all mapped projects
        deferred = []  # (asana task, nexus id) for the dependency pass below
        for pm in db.query(models.AsanaProjectMap).all():
            if not pm.asana_project_gid:
                continue
            # Re-acquired every iteration, not once for the whole run: the lock
            # is transaction-scoped (pg_advisory_xact_lock) and this loop now
            # commits per project below, same granularity _import_asana_projects
            # already uses (routers/task_config.py) and for the same reason -
            # holding one open transaction (and one pooled DB connection) for
            # every mapped project's worth of Asana HTTP calls starved the
            # connection pool for the whole run's duration, taking unrelated
            # requests down with it. Committing per project frees the
            # connection during the network waits instead of pinning it.
            _acquire_pull_lock(db)
            team_report = []
            started = datetime.now(timezone.utc)
            # Columns and stages first: a field/status added in Asana becomes a
            # Nexus one BEFORE any task referencing it is applied, so the value
            # lands on the first pull instead of being dropped for want of a
            # definition and only appearing a run later.
            counts["fields"] = counts.get("fields", 0) + seed_project_fields(
                db, cfg, pm.asana_project_gid, pm.nexus_project_id)
            counts["statuses"] = counts.get("statuses", 0) + seed_project_statuses(
                db, cfg, pm.asana_project_gid, pm.nexus_project_id)
            since, is_full = ("", True) if force_full else _pull_window(pm, started)
            # Raises on an Asana failure, which aborts the whole pull - so
            # _reap_deleted below only ever runs against a task list we know
            # came back complete. A half-fetched project must never be read as
            # "everything missing was deleted".
            if is_full:
                rows = asana.get(f"/projects/{pm.asana_project_gid}/tasks", opt_fields=_TASK_OPT_FIELDS)
            else:
                rows = asana.get("/tasks", project=pm.asana_project_gid, modified_since=since,
                                 opt_fields=_TASK_OPT_FIELDS)
                counts["scanned"] = counts.get("scanned", 0) + len(rows)
            for at in rows:
                _pull_task_tree(db, asana, at, pm.nexus_project_id, "", counts, seen, None, deferred)
            # Reaping needs the COMPLETE list: on an incremental run `seen` holds
            # only what changed, so everything else would look deleted.
            if is_full:
                _reap_deleted(db, cfg, pm.nexus_project_id, seen, counts)
                _sync_project_access(db, asana, cfg, pm.asana_project_gid, pm.nexus_project_id,
                                     pm.extra_team_names, report=team_report)
                pm.last_full_pull_at = started.isoformat()
            # Stamped from when the fetch STARTED, not when it finished - an edit
            # made mid-pull must fall inside the next window, not be skipped.
            pm.last_pull_at = started.isoformat()
            if team_report:
                proj_row = db.query(models.TaskProject).filter(
                    models.TaskProject.id == pm.nexus_project_id).first()
                pname = proj_row.name if proj_row else pm.nexus_project_id
                counts["teams"] += [f"{pname} - {line}" for line in team_report]
            # Checkpoint: everything through this project is durable, and the
            # lock releases here until the next iteration re-acquires it. A
            # process killed partway through a run (or Azure's own request
            # kill) now loses only whatever hadn't finished, not the whole run.
            db.commit()
        # resolve_dependencies only READS existing AsanaTaskLink rows and
        # writes blocked_by_ids/blocking_ids onto Task rows that already exist
        # (see its own docstring) - it never creates a link, so it isn't part
        # of the race the lock exists to prevent. Re-acquired anyway, cheaply,
        # to keep the whole run nominally serialized end to end.
        _acquire_pull_lock(db)
        resolve_dependencies(db, deferred)   # every link exists by now
        cfg.last_pull_at = now_iso()
        db.commit()
        return counts


class TokenConfig:
    """A stand-in for the AsanaSyncConfig row when the caller brings its own
    token - the one-shot Import UI asks for a PAT instead of using the stored
    service token. Same attribute surface the engine reads, with delete_sync
    forced OFF: an Import is an additive operation and must never remove
    anything, whatever the saved config says."""

    def __init__(self, token, workspace_gid=""):
        self.token = token
        self.workspace_gid = workspace_gid or ""
        self.enabled = True
        self.delete_sync = False
        self.manual_sync_enabled = False
        self.manual_delete_sync = False
        self.default_project_gid = ""


def import_project(db, cfg, nexus_project_id, asana_project_gid, counts=None,
                   seen=None, email_map=None, deferred=None):
    """Import one Asana project's contents into an existing Nexus project using
    the SAME engine Pull uses.

    The one-shot Import used to have its own parallel implementation, which is
    why it quietly carried less than Pull did: no dependencies, no status, no
    start date, no milestone flag, no followers, no sections on subtasks - and
    no AsanaTaskLink rows at all, so the first Pull afterwards had to re-adopt
    every task by title and duplicated whatever it couldn't match. Routing both
    through _pull_task_tree means a field added to the engine reaches Import
    and Pull at the same moment, and Import leaves a properly linked project
    that Pull can take over without guessing.

    The caller owns the Nexus project row (it needs the requesting user to
    create one); this fills it."""
    counts = counts if counts is not None else {"created": 0, "updated": 0, "comments": 0,
                                                "activities": 0, "attachments": 0, "deleted": 0}
    counts.setdefault("teams", [])
    seen = seen if seen is not None else set()
    # Own the dependency pass unless the caller is batching several projects and
    # will run it once at the end (dependencies can cross projects).
    own_pass = deferred is None
    deferred = deferred if deferred is not None else []
    refresh_directory_cache()   # people added since the last run resolve too
    asana = Asana(cfg.token)
    # Same order as Pull: every column and stage this project has exists in Nexus
    # before the first task that references one is applied.
    counts["fields"] = counts.get("fields", 0) + seed_project_fields(
        db, cfg, asana_project_gid, nexus_project_id)
    counts["statuses"] = counts.get("statuses", 0) + seed_project_statuses(
        db, cfg, asana_project_gid, nexus_project_id)
    for at in asana.get(f"/projects/{asana_project_gid}/tasks", opt_fields=_TASK_OPT_FIELDS):
        _pull_task_tree(db, asana, at, nexus_project_id, "", counts, seen, email_map, deferred)
    # An import has no saved extra_team_names yet (the mapping row is created
    # alongside it), so only the project's own owning team can resolve here -
    # the report says so rather than leaving the operator wondering.
    team_report = []
    _sync_project_access(db, asana, cfg, asana_project_gid, nexus_project_id, report=team_report)
    counts["teams"] += team_report
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


def project_gid_for(db, nexus_project_id):
    """The Asana project gid this Nexus project is mapped to, or "" if unmapped."""
    if not nexus_project_id:
        return ""
    pm = (db.query(models.AsanaProjectMap)
          .filter(models.AsanaProjectMap.nexus_project_id == nexus_project_id).first())
    return (pm.asana_project_gid or "") if pm else ""


def delete_asana_project(db, asana_project_gid):
    """Delete the Asana PROJECT itself. Like Asana's task delete this is a soft
    delete - it lands in the token user's trash for 30 days - so it is
    recoverable there, but it is still the most destructive thing this module
    can do and is reachable from exactly one place: an operator ticking "also
    delete it in Asana" in the delete dialog. Never from a pull, a sweep, or
    delete_sync, which govern TASK deletions only and must not be widened to
    projects.

    Deliberately does not check cfg.enabled/cfg.delete_sync: this is a direct
    instruction about one named project, not background reconciliation.

    Returns (done, error). A 404 counts as done - a project someone already
    deleted by hand is the outcome we wanted."""
    cfg = get_config(db)
    if not (cfg.token and asana_project_gid):
        return False, "sync has no token"
    try:
        _request("DELETE", f"{_ASANA_BASE}/projects/{asana_project_gid}", _headers(cfg.token))
        return True, ""
    except ImportError_ as e:
        msg = str(e)
        if msg.startswith("HTTP 404"):
            return True, ""            # already gone - the desired end state
        return False, msg[:200]
    except Exception as e:
        return False, str(e)[:200]


def purge_project_sync(db, nexus_project_id, actor="", drop_tasks=True):
    """Erase every trace of the two-way sync for ONE Nexus project, so the same
    Asana project can be imported again from scratch.

    This exists because "delete the Nexus project, then import it again" did not
    actually work before. delete_project only ORPHANED the tasks (project_id="")
    and left their AsanaTaskLink rows intact, and _apply_inbound matches on the
    Asana gid first - so the re-import found every gid already linked, quietly
    updated those now-invisible orphans (the update branch never re-parents a
    task into nexus_project_id), and left the freshly created project empty. The
    AsanaProjectMap row was left dangling as well, which is the same failure the
    import route's own comment describes hitting three times in one session.

    Removes, for this project: its tasks (subtasks included) with their task /
    comment / attachment / activity links, and its AsanaProjectMap row(s).

    Does NOT touch Asana - delete_nexus_task never queues a tombstone, which is
    the whole point here: the Asana project has to survive for the re-import to
    have anything to read. Deleting it there is a separate, explicit call to
    delete_asana_project. Does NOT touch AsanaWebhook rows either - their
    x_hook_secret still has to verify events from a webhook that is still
    registered on the Asana side.

    Does not commit; returns counts."""
    out = {"tasks": 0, "maps": 0}
    if not nexus_project_id:
        return out
    if drop_tasks:
        # Top-level first: delete_nexus_task takes each one's whole subtree, so
        # walking children separately would re-delete rows that are already gone.
        for t in db.query(models.Task).filter(
                models.Task.project_id == nexus_project_id,
                models.Task.parent_task_id == "").all():
            out["tasks"] += len(delete_nexus_task(db, t, actor=actor or "nexus",
                                                  detail="Deleted with its project"))
        # Anything still carrying this project_id is a subtask whose parent sits
        # in another project - no subtree of its own left to protect.
        for t in db.query(models.Task).filter(
                models.Task.project_id == nexus_project_id).all():
            out["tasks"] += len(delete_nexus_task(db, t, actor=actor or "nexus",
                                                  detail="Deleted with its project"))
    out["maps"] = db.query(models.AsanaProjectMap).filter(
        models.AsanaProjectMap.nexus_project_id == nexus_project_id).delete(
            synchronize_session=False)
    db.flush()
    return out


def sweep_orphans(db, apply=False):
    """Clean up the sync rows left behind by project deletes that predate
    purge_project_sync. Dry run by default, same shape as dedupe_tasks.

    All three kinds of garbage BLOCK a fresh import rather than merely waste
    space, which is why this is worth a button:

    - dead links - an AsanaTaskLink whose Nexus task no longer exists.
      _apply_inbound finds the link by gid, looks up the task behind it, and
      returns None when it is gone (see the `if not t: return None` branch), so
      that Asana task can never be imported again by ANY path until the link is
      removed.
    - orphan tasks - a top-level task with no project that still carries a link:
      exactly what the old delete_project produced. A re-import updates this
      invisible row instead of creating a visible one in the new project. The
      link is what makes this safe to identify: a project-less top-level task
      with an Asana link can only have come from an import whose project was
      deleted, so a hand-made personal task is never a candidate.
    - dangling maps - an AsanaProjectMap whose Nexus project is gone. pull()
      walks it every 2 minutes and applies its tasks against a project id that
      resolves to nothing.

    Asana is untouched throughout."""
    counts = {"deadLinks": 0, "orphanTasks": 0, "danglingMaps": 0}
    links = db.query(models.AsanaTaskLink).all()
    live_task_ids = {row.id for row in db.query(models.Task.id).all()}
    dead = [l for l in links if l.nexus_task_id not in live_task_ids]
    counts["deadLinks"] = len(dead)

    linked_ids = {l.nexus_task_id for l in links}
    orphans = [t for t in db.query(models.Task).filter(
        models.Task.project_id == "", models.Task.parent_task_id == "").all()
        if t.id in linked_ids]
    counts["orphanTasks"] = len(orphans)

    live_project_ids = {row.id for row in db.query(models.TaskProject.id).all()}
    dangling = [m for m in db.query(models.AsanaProjectMap).all()
                if m.nexus_project_id not in live_project_ids]
    counts["danglingMaps"] = len(dangling)

    if apply:
        for l in dead:
            db.delete(l)
        for t in orphans:
            delete_nexus_task(db, t, actor="nexus",
                              detail="Removed as an orphan of a deleted project")
        for m in dangling:
            db.delete(m)
        db.commit()
    return counts


# ── OUTBOUND: Nexus comment -> Asana story ───────────────────────────────────
def push_comment(db, comment):
    """Post a Nexus comment to its linked Asana task as a story.

    Asana attributes a story to whoever owns the token that posted it, and has
    no impersonation parameter - so the comment goes out under the AUTHOR's own
    Asana grant when they've connected one (Account Settings -> Asana account,
    see asana_oauth), and under the shared service token otherwise.

    The body is now sent verbatim. It used to carry a "[Nexus - <email>] "
    prefix stamped into the text, which was the only way to record authorship
    while everything posted as the service account; with a real per-user grant
    that stamp is both redundant and visible clutter in Asana."""
    cfg = get_config(db)
    if not sync_is_on(cfg) or not cfg.token:
        return
    if db.query(models.AsanaCommentLink).filter(models.AsanaCommentLink.nexus_comment_id == comment.id).first():
        return   # already synced (came from Asana)
    link = _link_by_nexus(db, comment.task_id)
    if not link or not link.asana_gid:
        return
    author = comment.author_email or ""
    # asana-sync is the stamp on comments that came FROM Asana; there's no
    # person behind it to attribute to.
    user_token = asana_oauth.token_for(db, author) if author and author != "asana-sync" else None
    token = user_token or cfg.token
    # Comment bodies are HTML now. Asana stories accept html_text with the same tag
    # subset html_notes takes, so one sanitizer serves both and a formatted comment
    # arrives formatted instead of showing its markup.
    body_html = _to_asana_html(comment.body or "", cfg)
    if body_html:
        payload = {"html_text": body_html}
    else:
        payload = {"text": _html_to_text(comment.body or "")}

    def _post(tok, data):
        return _asana_post(tok, f"/tasks/{link.asana_gid}/stories", {"data": data})

    try:
        st = _post(token, payload)
    except ImportError_ as e:
        msg = str(e)
        # A user's own grant can be revoked, or simply not have access to this
        # project. Falling back keeps the comment from being lost - it just
        # posts as the service account, exactly as it did before this feature.
        if user_token and ("401" in msg or "403" in msg or "404" in msg):
            print(f"[asana] {author}'s Asana grant was rejected ({msg[:120]}); posting as the service account")
            user_token, token = None, cfg.token
            st = _post(token, payload)
        # Same degrade-rather-than-lose rule as _task_write: Asana validates
        # html_text strictly and rejects the whole story, which would drop the
        # comment entirely rather than merely losing its bold.
        elif "html_text" in msg and "html_text" in payload:
            print(f"[asana] html_text rejected for a comment; retrying as plain text ({e})")
            st = _post(token, {"text": _html_to_text(comment.body or "")})
        else:
            raise
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
            if not sync_is_on(cfg):
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
# (on_task_changed per edit) - and a per-edit hook is exactly the thing that
# loses a change when sync was off, the token had expired, Asana 500'd, or the
# process died mid-push. The push sweep is the outbound equivalent of the pull
# poll: it re-derives what Asana should have from the Nexus rows themselves, so
# an edit that missed its push is picked up on the next sweep instead of
# sitting unsynced forever. Cheap because push_task short-circuits on both
# digests - an untouched task costs zero HTTP calls.
_AUTO_PULL_STARTED = False
# Inbound is the one people watch: an Asana edit should show up in Nexus quickly,
# and the pull is cheap because last_inbound_hash skips unchanged tasks. Outbound
# runs less often because it is only a safety net - a Nexus edit already pushes
# immediately (fire-and-forget), and this sweep exists to catch the ones that
# missed, which no one is waiting on.
_AUTO_PULL_INTERVAL_MIN = 2      # Asana -> Nexus
_AUTO_PUSH_INTERVAL_MIN = 10     # Nexus -> Asana (sweep)


def start_auto_pull():
    """Start the background reconcilers - inbound pull every 2 minutes, outbound
    push sweep every 10 - when sync is enabled. Idempotent, safe to call once at
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
                        if sync_is_on(cfg) and cfg.token:
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
                if sync_is_on(cfg) and cfg.token:
                    pull(db)
            finally:
                db.close()
        except Exception:
            pass
    threading.Thread(target=_run, daemon=True).start()


# ── Webhooks (real-time inbound) - receiver helpers + registration ───────────
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
    `target_base` is the PUBLIC https base of this API (Asana must reach it) - the
    receiver path /asana-sync/webhook is appended. Defaults to this deployment's
    own public host, so registering from dev/prod needs no URL at all."""
    cfg = get_config(db)
    if not sync_is_on(cfg) or not cfg.token:
        raise ImportError_("Sync is not enabled or has no token.")
    base = (target_base or "").strip() or public_base()
    if not base:
        raise ImportError_(
            "No public URL for this API - Asana can't reach a local backend. "
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
