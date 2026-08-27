"""Task Module - config & misc router: saved views, automation rules, templates,
intake forms, custom fields, tickets, the module's own notification bell, and the
changelog/"What's New" feature. Single router, absolute paths, email-keyed.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import or_
from pydantic import BaseModel
from typing import Optional, Any
import os
import json
import subprocess
import threading
import time
from datetime import datetime, timezone
import httpx
import models
from database import get_db, SessionLocal
from auth import get_current_user, require_level, require_manager, require_any_module_grant
from routers.task_util import now_iso, gen_id

router = APIRouter(tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets"))])


def _nz(v):
    return v if v not in ("", None) else None


def _require_asana_enabled():
    """Sever (Aug 27): every manual Asana endpoint - not just the background
    loops asana_sync's own gate covers - refuses to run while the integration
    is off, so a manager can no longer trigger a live pull/push/import from
    the API even though the code and Manage > Two-way Sync panel are still
    there. NEXUS_ASANA_ENABLED=true restores them exactly as before."""
    import asana_sync
    if not asana_sync.is_asana_enabled():
        raise HTTPException(403, "Asana integration is currently disabled.")


# ── Saved views (per user) ───────────────────────────────────────────────────
def saved_view_to_dict(s: models.TaskSavedView) -> dict:
    return {"id": s.id, "ownerId": _nz(s.owner_email), "name": s.name, "view": s.view or "list",
            "filters": s.filters if isinstance(s.filters, dict) else {},
            "sort": s.sort if isinstance(s.sort, dict) else {}, "group": s.group or "none",
            "scope": s.scope or "task"}


class SavedViewBody(BaseModel):
    id: Optional[str] = None
    name: str
    view: Optional[str] = "list"
    filters: Optional[dict] = None
    sort: Optional[dict] = None
    group: Optional[str] = "none"


@router.get("/task-saved-views")
def list_saved_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.TaskSavedView)
            .filter(models.TaskSavedView.owner_email == user["email"].lower(),
                    models.TaskSavedView.scope != "ticket").all())
    return [saved_view_to_dict(s) for s in rows]


@router.post("/task-saved-views", status_code=201)
def create_saved_view(body: SavedViewBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    s = models.TaskSavedView(id=body.id or gen_id(), owner_email=user["email"].lower(), name=body.name,
                             view=body.view or "list", filters=body.filters or {}, sort=body.sort or {},
                             group=body.group or "none", scope="task", created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return saved_view_to_dict(s)


@router.delete("/task-saved-views/{view_id}", status_code=204)
def delete_saved_view(view_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskSavedView).filter(models.TaskSavedView.id == view_id).delete()
    db.commit()



# ── Asana import (Manage → Import) ───────────────────────────────────────────
# Runs the same logic as the CLI tool (backend/asana_import.py) but server-side,
# in-process: reads projects/tasks/subtasks/comments/attachments from the Asana
# REST API and creates them by calling the existing task/project/section create
# functions directly (no HTTP self-calls, one request). Manager+ only.
class AsanaTokenBody(BaseModel):
    token: str


@router.post("/task-asana-projects", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_projects(body: AsanaTokenBody):
    """List the (non-archived) projects the token can see, across all workspaces,
    so the Import UI can offer a picker instead of asking for raw GIDs."""
    from asana_import import Asana, ImportError_
    asana = Asana(body.token)
    try:
        out = []
        for w in asana.get("/workspaces", opt_fields="name"):
            for p in asana.get("/projects", workspace=w["gid"], opt_fields="name,archived"):
                if p.get("archived"):
                    continue
                out.append({"gid": p["gid"], "name": p.get("name") or p["gid"], "workspace": w.get("name") or ""})
        return out
    except ImportError_ as e:
        raise HTTPException(400, f"Asana request failed: {e}")


class AsanaImportBody(BaseModel):
    token: str
    project_gids: Optional[list] = None
    workspace: Optional[str] = ""
    email_map: Optional[dict] = None
    # Accepted and ignored. Import now runs the same engine as Pull, which
    # always brings a task's full contents - partial imports were the reason
    # Import and Pull carried different amounts of a task. Kept in the schema so
    # an older client (or a saved request) posting them still gets a 200
    # instead of a 422.
    subtasks: bool = True
    comments: bool = True
    attachments: bool = True
    silent_comments: bool = True
    attach_max_mb: float = 5.0


@router.post("/task-asana-import", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_import(body: AsanaImportBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One-shot Asana -> Nexus import, running the SAME engine as the two-way
    Pull (asana_sync.import_project).

    This used to be a second, parallel implementation, and it drifted: it
    carried tasks, subtasks, comments, attachments, tags, priority, due date and
    assignee - but not dependencies, status, start date, milestone flag,
    followers or per-task section, and it never wrote AsanaTaskLink rows, so the
    first Pull afterwards had to re-adopt everything by title and duplicated
    whatever it could not match. Delegating means Import and Pull cannot carry
    different amounts of a task ever again.

    Import is additive by construction: TokenConfig forces delete_sync off, so
    nothing here can remove a Nexus task no matter what the saved config says.
    """
    from asana_import import Asana, ImportError_
    import asana_sync

    cfg = asana_sync.TokenConfig(body.token, body.workspace or "")
    asana = Asana(body.token)
    email_map = {k.lower(): v for k, v in (body.email_map or {}).items()}
    try:
        gids = list(body.project_gids or [])
        if body.workspace:
            gids += [p["gid"] for p in asana.get("/projects", workspace=body.workspace, opt_fields="name")]
        # No GIDs and no workspace = "everything this token can see". A GID is the middle
        # number of a project URL - easy to get wrong and impossible to verify before the
        # import runs, and the token already knows what it can reach.
        if not gids:
            gids = [pr["gid"]
                    for w in asana.get("/workspaces", opt_fields="name")
                    for pr in asana.get("/projects", workspace=w["gid"], opt_fields="name,archived")
                    if not pr.get("archived")]
    except ImportError_ as e:
        # first Asana call failed - almost always a bad token or GID.
        raise HTTPException(400, f"Asana request failed: {e}")
    if not gids:
        raise HTTPException(400, "That token can't see any projects.")
    return _import_asana_projects(db, cfg, asana, gids, user, email_map)


def _asana_project_owner(db, proj: dict, email_map: dict) -> str:
    """The Nexus work email for an Asana project's owner, or "" if there isn't one.

    Asana's project resource carries `owner` (a UserCompact) but NO creator
    field - `created_at` exists, `created_by` does not. Asana makes the creator
    the initial owner, so this is as close as the API gets to "who made this in
    Asana"; a project whose ownership was reassigned there reports the new owner,
    which is the more useful answer anyway.

    Resolved through the Nexus directory like every other inbound Asana address
    (_map_email handles the @…onmicrosoft.com guest relay), then required to be a
    real employee. An unmatched address must NOT be stored: owner_email feeds
    require_project_role and the project visibility checks (task_util), so a
    non-Nexus owner is a dead pointer that grants its "owner" nothing and shows
    up as an unknown face in the People picker. Callers fall back to the
    importing user, which is what the owner was before this existed.
    """
    import asana_sync
    email = asana_sync._map_email((proj.get("owner") or {}).get("email"), email_map, db)
    if not email:
        return ""
    # The directory is keyed by work email, known personal email and bare local
    # part, all lowercased, and maps every one of them onto the work email - so a
    # hit here is exactly "this resolved to a real employee". Reused rather than
    # re-queried because _map_email just built (and cached) it on the line above.
    return email if asana_sync._nexus_directory(db).get(email) else ""


def _import_asana_projects(db, cfg, asana, gids, user, email_map=None, on_progress=None,
                           should_stop=None):
    """Create-or-adopt a Nexus project per Asana project, map it, and import its
    contents through asana_sync.import_project (which is _pull_task_tree, the
    one and only inbound engine).

    Shared by the token-based one-shot Import and the stored-token "Import
    everything from Asana" button, so the two cannot drift the way Import and
    Pull once did - the reason that engine has a single entry point at all."""
    from routers.task_projects import create_project, ProjectBody, project_to_dict
    import asana_sync

    email_map = email_map or {}
    counts = {"projects": 0, "tasks": 0, "subtasks": 0, "comments": 0, "attachments": 0,
              "activities": 0, "skipped": 0, "errors": []}
    # Engine-native counters; mapped onto the UI's names at the end.
    eng = {"created": 0, "updated": 0, "linked": 0, "comments": 0, "activities": 0,
           "attachments": 0, "deleted": 0}
    seen = set()
    # Dependencies can point across projects, so the resolution pass runs once
    # after every selected project is in, not per project.
    deferred = []

    for i, gid in enumerate(gids):
        pname = ""
        # Between projects is the only safe place to stop: a project in flight
        # would be left half-imported. Checked before the work, so cancelling
        # takes effect at the next boundary rather than at the end.
        if should_stop and should_stop():
            counts["cancelled"] = True
            break
        try:
            # Serialize each project against the scheduled pull. The
            # lock is transaction-scoped and this loop commits per project, so
            # it is taken per project rather than once around the whole run -
            # which is the granularity that matters, since duplicates come from
            # two writers touching the SAME project at once.
            asana_sync._acquire_pull_lock(db)
            # owner.email rides along the same way assignee.email does on tasks -
            # the compact `owner` Asana returns by default is gid/name only.
            proj = asana.get(f"/projects/{gid}", opt_fields="name,notes,owner.name,owner.email")
            # Re-importing an Asana project that's already mapped (Two-way
            # Sync) must reuse that SAME Nexus project rather than create a
            # duplicate - this exact bug (a dangling AsanaProjectMap left
            # pointing at an orphaned project while a fresh import silently
            # took its place, so nothing the user was looking at actually kept
            # syncing) hit us three separate times in one session before this
            # fix. A map row with no live project on the other end self-heals
            # onto the freshly (re)created one instead of leaving another
            # dangling reference.
            existing_map = db.query(models.AsanaProjectMap).filter(
                models.AsanaProjectMap.asana_project_gid == gid).first()
            existing_project = (db.query(models.TaskProject)
                               .filter(models.TaskProject.id == existing_map.nexus_project_id).first()
                               if existing_map else None)
            pname = proj.get("name") or f"Asana {gid}"
            # Announce the project BEFORE importing it. Reporting only on
            # completion left the UI blank for as long as the first project
            # took, which reads as a stalled run.
            if on_progress:
                try:
                    on_progress(i, len(gids), pname, None)
                except Exception:
                    pass
            if not existing_project:
                # No mapping yet - fall back to a Nexus project of the same name.
                # Without this, every re-import of the same Asana project minted
                # another Nexus project: run it twice and you have two, and a
                # first attempt that failed PART WAY (the project row is created
                # before the tasks are walked) left an empty one that the retry
                # then duplicated instead of filling in.
                existing_project = (db.query(models.TaskProject)
                                    .filter(models.TaskProject.name == pname).first())
            # Asana's project owner, at IMPORT time only. Deliberately never
            # applied on a Pull, and never over an owner a Nexus project already
            # has: name/description are refreshed every pull, but ownership is a
            # decision someone makes on this side (handover, a leaver's projects
            # reassigned by task_projects.reassign) and a sweep that kept
            # restoring the Asana value would silently undo it every two minutes.
            asana_owner = _asana_project_owner(db, proj, email_map)
            if existing_project:
                existing_project.name = pname
                existing_project.description = proj.get("notes") or existing_project.description
                # Filling a BLANK owner isn't overwriting one - a project that
                # has no owner at all can only gain from this.
                if asana_owner and not (existing_project.owner_email or "").strip():
                    existing_project.owner_email = asana_owner
                p = project_to_dict(existing_project)
            else:
                # Falls back to the importing user (create_project's default) when
                # Asana has no owner, or has one nobody in Nexus matches.
                p = create_project(ProjectBody(name=pname,
                                               description=proj.get("notes") or "",
                                               owner_email=asana_owner or None), user=user, db=db)
            counts["projects"] += 1
            # Record the pairing. An imported project is one the operator plainly
            # wants kept current, and without a map row Pull/Push skip it
            # entirely - so the import would go stale the moment it finished.
            asana_sync.ensure_project_map(db, p["id"], gid)
            asana_sync.import_project(db, cfg, p["id"], gid, eng, seen, email_map, deferred)
            db.commit()
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            counts["errors"].append(f"project {gid}: {e}")
        # Reported even when the project failed, so a run that hits a bad
        # project still advances instead of looking stuck on it.
        if on_progress:
            try:
                on_progress(i + 1, len(gids), pname, gid)
            except Exception:
                pass

    try:
        asana_sync.resolve_dependencies(db, deferred)
        db.commit()
    except Exception as e:
        db.rollback()
        counts["errors"].append(f"dependencies: {e}")

    # The engine counts tasks and subtasks together (it walks one tree); the UI
    # shows them separately, so report the total under "tasks" and leave
    # subtasks at 0 rather than inventing a split.
    counts["tasks"] = eng["created"]
    counts["skipped"] = eng["updated"] + eng["linked"]
    counts["comments"] = eng["comments"]
    counts["activities"] = eng["activities"]
    counts["attachments"] = eng["attachments"]
    return counts


# ── Automation rules ─────────────────────────────────────────────────────────
def rule_to_dict(r: models.TaskAutomationRule) -> dict:
    return {"id": r.id, "name": r.name,
            "trigger": r.trigger if isinstance(r.trigger, dict) else {},
            "actions": r.actions if isinstance(r.actions, list) else [], "enabled": bool(r.enabled)}


class RuleBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None   # optional so PATCH (e.g. enabled toggle) can send partial bodies; required on create (guarded below)
    trigger: Optional[dict] = None
    actions: Optional[list] = None
    enabled: Optional[bool] = None


@router.get("/task-automation-rules")
def list_rules(db: Session = Depends(get_db)):
    return [rule_to_dict(r) for r in db.query(models.TaskAutomationRule).all()]


@router.post("/task-automation-rules", status_code=201, dependencies=[Depends(require_manager)])
def create_rule(body: RuleBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Rule name is required")
    r = models.TaskAutomationRule(id=body.id or gen_id(), name=body.name, trigger=body.trigger or {},
                                  actions=body.actions or [],
                                  enabled=True if body.enabled is None else bool(body.enabled),
                                  created_at=now_iso())
    db.add(r)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.patch("/task-automation-rules/{rule_id}", dependencies=[Depends(require_manager)])
def update_rule(rule_id: str, body: RuleBody, db: Session = Depends(get_db)):
    r = db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.delete("/task-automation-rules/{rule_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_rule(rule_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).delete()
    db.commit()


# ── Templates ────────────────────────────────────────────────────────────────
def template_to_dict(t: models.TaskTemplate) -> dict:
    return {"id": t.id, "name": t.name, "description": t.description or "",
            "patch": t.patch if isinstance(t.patch, dict) else {},
            "subtaskTitles": t.subtask_titles or []}


class TemplateBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    patch: Optional[dict] = None
    subtask_titles: Optional[list] = None


@router.get("/task-templates")
def list_templates(db: Session = Depends(get_db)):
    return [template_to_dict(t) for t in db.query(models.TaskTemplate).all()]


@router.post("/task-templates", status_code=201, dependencies=[Depends(require_manager)])
def create_template(body: TemplateBody, db: Session = Depends(get_db)):
    t = models.TaskTemplate(id=body.id or gen_id(), name=body.name, description=body.description or "",
                            patch=body.patch or {}, subtask_titles=body.subtask_titles or [],
                            created_at=now_iso())
    db.add(t)
    db.commit()
    db.refresh(t)
    return template_to_dict(t)


@router.delete("/task-templates/{template_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_template(template_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskTemplate).filter(models.TaskTemplate.id == template_id).delete()
    db.commit()


# ── Intake forms ─────────────────────────────────────────────────────────────
def intake_form_to_dict(f: models.TaskIntakeForm) -> dict:
    return {"id": f.id, "title": f.title, "fields": f.fields if isinstance(f.fields, list) else [],
            "targetProjectId": _nz(f.target_project_id)}


class IntakeFormBody(BaseModel):
    id: Optional[str] = None
    title: str
    fields: Optional[list] = None
    target_project_id: Optional[str] = ""


@router.get("/task-intake-forms")
def list_intake_forms(db: Session = Depends(get_db)):
    return [intake_form_to_dict(f) for f in db.query(models.TaskIntakeForm).all()]


@router.post("/task-intake-forms", status_code=201, dependencies=[Depends(require_manager)])
def create_intake_form(body: IntakeFormBody, db: Session = Depends(get_db)):
    f = models.TaskIntakeForm(id=body.id or gen_id(), title=body.title, fields=body.fields or [],
                              target_project_id=body.target_project_id or "", created_at=now_iso())
    db.add(f)
    db.commit()
    db.refresh(f)
    return intake_form_to_dict(f)


@router.delete("/task-intake-forms/{form_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_intake_form(form_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskIntakeForm).filter(models.TaskIntakeForm.id == form_id).delete()
    db.commit()


# ── Custom fields ────────────────────────────────────────────────────────────
_FIELD_PALETTE = ["#2563eb", "#0d9488", "#16a34a", "#7c3aed", "#d97706",
                  "#dc2626", "#db2777", "#0891b2", "#4f46e5", "#475569"]


def normalize_field_options(options, ) -> list:
    """Select options as [{id,label,color}].

    Rows written before options carried colors hold plain strings, and the task
    editors still send plain strings today, so both shapes have to read back the
    same or every existing select field would render blank. A missing color is
    assigned from the palette by position rather than left empty, so a field
    always has usable chips."""
    out = []
    for i, o in enumerate(options or []):
        if o is None:
            continue   # str(None) is "None", which would become a real option
        if isinstance(o, dict):
            label = str(o.get("label") or o.get("id") or "").strip()
            if not label:
                continue
            out.append({"id": str(o.get("id") or label), "label": label,
                        "color": o.get("color") or _FIELD_PALETTE[i % len(_FIELD_PALETTE)]})
        else:
            label = str(o).strip()
            if label:
                out.append({"id": label, "label": label, "color": _FIELD_PALETTE[i % len(_FIELD_PALETTE)]})
    return out


def _as_list(raw) -> list:
    """The list-typed kinds (multiselect, people) accept a bare scalar too - a
    field converted from select/text still holds one, and the Asana importer
    seeds a single value the same way."""
    if isinstance(raw, (list, tuple, set)):
        return list(raw)
    return [raw] if raw not in ("", None) else []


def _select_option_id(f: models.TaskCustomField, raw) -> str:
    """One select/multiselect value as its option id, or "" if it matches no
    option. Accepts either the id or the label - the task editors have
    historically sent plain labels, and Asana always sends the label."""
    allowed = {o["id"]: o for o in normalize_field_options(f.options or [])}
    by_label = {o["label"]: o["id"] for o in allowed.values()}
    key = str(raw)
    if key in allowed:
        return key
    if key in by_label:
        return by_label[key]
    # Case-insensitive last resort: Asana's option names and a hand-typed Nexus
    # option routinely differ only by case, and dropping the value over that
    # left the cell blank with no indication anything had arrived.
    lower = {lbl.strip().lower(): oid for lbl, oid in by_label.items()}
    return lower.get(key.strip().lower(), "")


def coerce_custom_field_values(db: Session, values) -> dict:
    """Store custom-field values in the shape their field declares.

    The column is a free JSON dict, so before this every value arrived as
    whatever the widget produced - numbers as strings, dates in whatever the
    input emitted, and selects holding labels that were no longer options after
    the field was edited. Nothing downstream could group, sort, or roll them up
    on that. Coercing here keeps the mess out of every reader.

    Unknown field ids are dropped (the field was deleted); a value that can't be
    coerced is dropped rather than stored wrong. Never raises - inbound Asana
    tasks come through the same create path and must not be rejected."""
    if not isinstance(values, dict) or not values:
        return {}
    defs = {f.id: f for f in db.query(models.TaskCustomField).all()}
    out = {}
    for fid, raw in values.items():
        f = defs.get(fid)
        if f is None or raw in ("", None):
            continue
        kind = (f.type or "text").lower()
        try:
            if kind == "number":
                n = float(raw)
                out[fid] = int(n) if n.is_integer() else n
            elif kind == "checkbox":
                out[fid] = raw if isinstance(raw, bool) else str(raw).strip().lower() in ("1", "true", "yes", "on")
            elif kind == "date":
                out[fid] = str(raw)[:10]
            elif kind == "select":
                out[fid] = _select_option_id(f, raw)
                if not out[fid]:
                    out.pop(fid)
            elif kind == "multiselect":
                # A list of option ids. Order is normalized to the field's own
                # option order so two equal sets can never digest differently
                # and make an unchanged task look changed on every Asana pull.
                order = [o["id"] for o in normalize_field_options(f.options or [])]
                ids = {oid for oid in (_select_option_id(f, v) for v in _as_list(raw)) if oid}
                out[fid] = [oid for oid in order if oid in ids]
                if not out[fid]:
                    out.pop(fid)
            elif kind == "people":
                # A list of Nexus work emails, lowercased and deduped. Sorted for
                # the same digest-stability reason as multiselect above.
                emails = sorted({str(v).strip().lower() for v in _as_list(raw)
                                 if str(v or "").strip() and "@" in str(v)})
                out[fid] = emails
                if not out[fid]:
                    out.pop(fid)
            else:
                out[fid] = str(raw)
        except (TypeError, ValueError):
            continue
    return out


def field_applies_to(f: models.TaskCustomField, project_id: str) -> bool:
    """Empty project_ids = a global field (every project), which is what every
    field was before scoping existed."""
    ids = [p for p in (f.project_ids or []) if p]
    return not ids or (project_id or "") in ids


_APPLIES_TO_KINDS = ("task", "project")


def _parse_applies_to(raw) -> list:
    """applies_to is stored as a JSON-encoded array string (e.g. '["task",
    "project"]') so a field can live on both entities at once. Rows written
    before multi-select existed (or seeded directly via SQL, like the
    built-in Location field) hold a bare 'task'/'project' string instead -
    both shapes read back the same rather than needing a backfill."""
    if not raw:
        return ["task"]
    if isinstance(raw, list):
        kinds = raw
    else:
        try:
            parsed = json.loads(raw)
            kinds = parsed if isinstance(parsed, list) else [parsed]
        except (TypeError, ValueError):
            kinds = [raw]   # legacy plain 'task' / 'project' string
    out = [k for k in _APPLIES_TO_KINDS if k in kinds]
    return out or ["task"]


def _dump_applies_to(kinds) -> str:
    out = [k for k in _APPLIES_TO_KINDS if k in (kinds or [])]
    return json.dumps(out or ["task"])


def custom_field_to_dict(f: models.TaskCustomField) -> dict:
    return {"id": f.id, "name": f.name, "description": _nz(f.description), "type": f.type or "text",
            "options": normalize_field_options(f.options if isinstance(f.options, list) else []),
            "projectIds": [p for p in (f.project_ids or []) if p],
            "required": bool(f.required), "readOnly": bool(f.read_only),
            "appliesTo": _parse_applies_to(f.applies_to)}


class CustomFieldBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    type: Optional[str] = "text"
    options: Optional[list] = None
    project_ids: Optional[list] = None
    required: Optional[bool] = None
    read_only: Optional[bool] = None
    applies_to: Optional[list] = None


@router.get("/task-custom-fields")
def list_custom_fields(db: Session = Depends(get_db)):
    return [custom_field_to_dict(f) for f in db.query(models.TaskCustomField).all()]


@router.post("/task-custom-fields", status_code=201)
def create_custom_field(body: CustomFieldBody, db: Session = Depends(get_db)):
    f = models.TaskCustomField(id=body.id or gen_id(), name=body.name, description=body.description or "",
                               type=body.type or "text",
                               options=normalize_field_options(body.options or []),
                               project_ids=[p for p in (body.project_ids or []) if p],
                               required=bool(body.required), read_only=bool(body.read_only),
                               applies_to=_dump_applies_to(body.applies_to))
    db.add(f)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.patch("/task-custom-fields/{field_id}")
def update_custom_field(field_id: str, body: CustomFieldBody, db: Session = Depends(get_db)):
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first()
    if not f:
        raise HTTPException(404, "Custom field not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    if "options" in data:
        data["options"] = normalize_field_options(data["options"] or [])
    if "project_ids" in data:
        data["project_ids"] = [p for p in (data["project_ids"] or []) if p]
    if "applies_to" in data:
        data["applies_to"] = _dump_applies_to(data["applies_to"])
    for k, v in data.items():
        setattr(f, k, v)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.delete("/task-custom-fields/{field_id}", status_code=204)
def delete_custom_field(field_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).delete()
    db.commit()



# ── Asana two-way sync (Manage → Asana Sync) ─────────────────────────────────
class AsanaSyncConfigBody(BaseModel):
    enabled: Optional[bool] = None
    token: Optional[str] = None                 # only updated when provided (write-only)
    workspace_gid: Optional[str] = None
    default_project_gid: Optional[str] = None
    delete_sync: Optional[bool] = None
    setup_token: Optional[str] = None
    # Two-Way Sync card's own toggles, independent of enabled/delete_sync above
    # (the Setup card's) - see AsanaSyncConfig and asana_sync.sync_is_on().
    manual_sync_enabled: Optional[bool] = None
    manual_delete_sync: Optional[bool] = None


class AsanaProjectMapBody(BaseModel):
    maps: list                                  # [{nexusProjectId, asanaProjectGid, extraTeamNames?}]


def _sync_config_dict(cfg) -> dict:
    return {"enabled": bool(cfg.enabled), "workspaceGid": _nz(cfg.workspace_gid),
            "defaultProjectGid": _nz(cfg.default_project_gid), "hasToken": bool(cfg.token),
            "lastPullAt": _nz(cfg.last_pull_at), "deleteSync": bool(cfg.delete_sync),
            "hasSetupToken": bool(cfg.setup_token),
            "manualSyncEnabled": bool(cfg.manual_sync_enabled),
            "manualDeleteSync": bool(cfg.manual_delete_sync)}


@router.get("/asana-sync/config", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def get_asana_sync_config(db: Session = Depends(get_db)):
    import asana_sync
    cfg = asana_sync.get_config(db)
    maps = [{"nexusProjectId": m.nexus_project_id, "asanaProjectGid": m.asana_project_gid,
            "extraTeamNames": m.extra_team_names or []}
            for m in db.query(models.AsanaProjectMap).all()]
    return {**_sync_config_dict(cfg), "projectMap": maps}


@router.put("/asana-sync/config", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def set_asana_sync_config(body: AsanaSyncConfigBody, db: Session = Depends(get_db)):
    import asana_sync
    cfg = asana_sync.get_config(db)
    if body.enabled is not None:
        cfg.enabled = body.enabled
    if body.token is not None and body.token.strip():
        tok = body.token.strip()
        try:
            tok.encode("ascii")
        except UnicodeEncodeError:
            raise HTTPException(400, "That doesn't look like an Asana token (invalid characters). Paste your Asana Personal Access Token (starts with 1/).")
        if len(tok) > 200 or " " in tok:
            raise HTTPException(400, "That doesn't look like an Asana token. Paste just the token (starts with 1/).")
        cfg.token = tok
    if body.setup_token is not None:
        tok = body.setup_token.strip()
        # Empty clears it, which falls back to the service token.
        if tok and (len(tok) > 200 or " " in tok):
            raise HTTPException(400, "That doesn't look like an Asana token. Paste just the token (starts with 1/).")
        cfg.setup_token = tok
    if body.workspace_gid is not None:
        cfg.workspace_gid = body.workspace_gid
    if body.default_project_gid is not None:
        cfg.default_project_gid = body.default_project_gid
    if body.delete_sync is not None:
        cfg.delete_sync = body.delete_sync
    if body.manual_sync_enabled is not None:
        cfg.manual_sync_enabled = body.manual_sync_enabled
    if body.manual_delete_sync is not None:
        cfg.manual_delete_sync = body.manual_delete_sync
    from routers.task_util import now_iso
    cfg.updated_at = now_iso()
    db.commit()
    db.refresh(cfg)
    return _sync_config_dict(cfg)


@router.put("/asana-sync/projects", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def set_asana_project_map(body: AsanaProjectMapBody, db: Session = Depends(get_db)):
    from routers.task_util import now_iso
    rows = []
    for m in body.maps or []:
        npid = (m.get("nexusProjectId") or "").strip()
        agid = (m.get("asanaProjectGid") or "").strip()
        extra_teams = [n.strip() for n in (m.get("extraTeamNames") or []) if (n or "").strip()]
        if npid and agid:
            rows.append((npid, agid, extra_teams))
    # Two Nexus projects on ONE Asana project is silently destructive: pull() shares
    # one `seen` set, so whichever row comes back first absorbs all the tasks and the
    # other stays empty while the pull still reports success. The import path already
    # refuses this (ensure_project_map re-points); this closes the same hole here.
    by_gid = {}
    for npid, agid, _ in rows:
        by_gid.setdefault(agid, []).append(npid)
    clashes = {g: ids for g, ids in by_gid.items() if len(ids) > 1}
    if clashes:
        names = {p.id: p.name for p in db.query(models.TaskProject).filter(
            models.TaskProject.id.in_([i for ids in clashes.values() for i in ids])).all()}
        detail = "; ".join(f"{g} ← " + ", ".join(names.get(i, i) for i in ids)
                           for g, ids in clashes.items())
        raise HTTPException(400, "Each Asana project can be mapped to only one Nexus project. "
                                 f"Duplicate mapping(s): {detail}")
    db.query(models.AsanaProjectMap).delete()
    for npid, agid, extra_teams in rows:
        db.add(models.AsanaProjectMap(id=gen_id(), nexus_project_id=npid,
                                      asana_project_gid=agid, extra_team_names=extra_teams,
                                      created_at=now_iso()))
    db.commit()
    return {"count": db.query(models.AsanaProjectMap).count()}


# A job whose worker was recycled mid-run never reaches "done", so a heartbeat
# this old counts as dead.
#
# Twenty missed beats, not six. The two errors are not symmetrical: declaring a
# LIVE import dead is the damaging one - the UI says it stopped while it is
# still writing, and a second run can start beside it - whereas being slow to
# notice a genuinely dead one now costs nothing, because Cancel retires a stuck
# row on the spot. A tight window plus a beat that can be delayed by connection
# pressure (5 connections per gunicorn worker) is what made a healthy run on dev
# report "Interrupted" while it was still importing.
_IMPORT_HEARTBEAT_SECONDS = 30
_IMPORT_JOB_STALE_SECONDS = _IMPORT_HEARTBEAT_SECONDS * 20


def import_job_to_dict(j: models.AsanaImportJob) -> dict:
    return {"id": j.id, "status": j.status, "startedBy": j.started_by,
            "startedAt": j.started_at, "finishedAt": j.finished_at,
            "total": j.total or 0, "done": j.done or 0, "current": j.current or "",
            "result": j.result if isinstance(j.result, dict) else {},
            "error": j.error or "", "cancelling": bool(j.cancel_requested)}


def _recent(iso: str, hours: int) -> bool:
    """True when `iso` is within the last `hours`. Unparseable or missing counts
    as NOT recent - the conservative answer everywhere this is used."""
    if not iso:
        return False
    try:
        when = datetime.fromisoformat(iso)
    except ValueError:
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - when).total_seconds() < hours * 3600


def _stalled_message(j) -> str:
    """Why a run was retired, without claiming to know the cause.

    The old wording asserted "the server restarted", which is only one of the
    possibilities (a recycled worker, a killed container - or the heartbeat
    simply not landing). Reporting how far it got is the part that actually
    helps: stopping at 2 of 109 and stopping at 95 of 109 are different
    problems."""
    where = f" after {j.done or 0} of {j.total or 0} project(s)" if j.total else ""
    last = f", last: {j.current}" if j.current else ""
    return (f"Import stopped responding{where}{last}. Everything imported so far was kept - "
            "run Import again to continue.")


def _job_is_alive(j: models.AsanaImportJob) -> bool:
    if j.status != "running":
        return False
    try:
        beat = datetime.fromisoformat(j.heartbeat_at or j.started_at)
    except ValueError:
        return False
    if beat.tzinfo is None:
        beat = beat.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - beat).total_seconds() < _IMPORT_JOB_STALE_SECONDS


def _beat_while_running(job_id: str, stop: threading.Event):
    """Keep the job's heartbeat current for as long as this process is alive.

    Beating only when a project finishes was wrong: one big project can take
    longer than the staleness window on its own, so a perfectly healthy run got
    declared dead mid-import. The heartbeat answers "is the worker still there",
    which is a different question from "has it made progress".

    Deliberately a one-statement UPDATE on its own connection rather than an ORM
    session: each gunicorn worker gets only 5 Postgres connections (pool_size 2
    + overflow 3) and the import thread holds one for its whole run, so the
    lightest possible touch is what keeps this from competing with real
    requests. A failed beat is RETRIED rather than skipped - silently missing a
    few in a row is exactly what makes a live import look dead."""
    from sqlalchemy import text
    from database import engine

    while not stop.wait(_IMPORT_HEARTBEAT_SECONDS):
        for attempt in range(3):
            try:
                with engine.begin() as conn:
                    res = conn.execute(
                        text("UPDATE asana_import_jobs SET heartbeat_at = :ts "
                             "WHERE id = :id AND status = 'running'"),
                        {"ts": now_iso(), "id": job_id})
                if res.rowcount == 0:      # finished, cancelled, or gone
                    return
                break
            except Exception as e:
                if attempt == 2:
                    print(f"[asana] import heartbeat failed 3x: {e}")
                else:
                    time.sleep(2)


def _run_import_all(job_id: str, token: str, workspace_gid: str, user: dict):
    """The import itself, on a background thread with its OWN session.

    The request's session belongs to the request and is closed the moment the
    endpoint returns, so this cannot borrow it."""
    from asana_import import Asana, ImportError_
    import asana_sync

    db = SessionLocal()
    stop_beat = threading.Event()
    threading.Thread(target=_beat_while_running, args=(job_id, stop_beat), daemon=True).start()
    try:
        job = db.get(models.AsanaImportJob, job_id)
        asana = Asana(token)
        try:
            workspaces = [workspace_gid] if workspace_gid else [
                w["gid"] for w in asana.get("/workspaces", opt_fields="name")]
            gids = []
            for ws in workspaces:
                for p in asana.get("/projects", workspace=ws, opt_fields="name,archived"):
                    if not p.get("archived"):
                        gids.append(p["gid"])
        except ImportError_ as e:
            job.status, job.error = "error", f"Asana request failed - check the token. ({e})"
            job.finished_at = now_iso()
            db.commit()
            return

        # Resume: skip what a previous attempt already finished. The full list
        # is still fetched, because a project added in Asana since then should
        # come in too - only the completed ones are dropped.
        already = set(job.done_gids or [])
        remaining = [g for g in gids if g not in already]
        job.total = len(gids)
        job.done = len(gids) - len(remaining)
        job.heartbeat_at = now_iso()
        db.commit()
        if not remaining:
            job.status, job.finished_at = "done", now_iso()
            job.result = {"projects": len(already), "tasks": 0,
                          "errors": [] if already else ["No projects found in the workspace."]}
            db.commit()
            return

        offset = len(already)

        def progress(done, total, name, finished_gid=None):
            # `done`/`total` are indexes into the REMAINING list, so shift them
            # back onto the whole run - a resumed job must not restart its bar
            # at zero.
            job.done, job.total, job.current = offset + done, offset + total, name
            if finished_gid:
                # Recorded per project, committed with the same transaction, so
                # whatever killed the run cannot lose the fact that this project
                # was completed.
                job.done_gids = list(job.done_gids or []) + [finished_gid]
            job.heartbeat_at = now_iso()
            db.commit()

        def cancelled():
            # Re-read rather than trusting the in-session object: the cancel
            # arrives on a different request, and on dev usually a different
            # process, so this session's copy would never show it.
            db.expire(job, ["cancel_requested"])
            return bool(job.cancel_requested)

        # The stored token, wrapped the same way Import wraps a pasted one, so
        # this can never delete anything in Nexus whatever delete_sync is set to.
        token_cfg = asana_sync.TokenConfig(token, workspace_gid or "")
        counts = _import_asana_projects(db, token_cfg, asana, remaining, user,
                                        on_progress=progress, should_stop=cancelled)
        counts["projects"] = counts.get("projects", 0) + len(already)
        counts["mapped"] = db.query(models.AsanaProjectMap).count()
        job.result = counts
        job.status = "cancelled" if counts.get("cancelled") else "done"
        job.current, job.finished_at = "", now_iso()
        db.commit()
    except Exception as e:
        # A crash must land in the row: the poller has no other way to learn the
        # run stopped, and would otherwise spin until the staleness timeout.
        db.rollback()
        job = db.get(models.AsanaImportJob, job_id)
        if job:
            job.status, job.error, job.finished_at = "error", str(e)[:500], now_iso()
            db.commit()
    finally:
        stop_beat.set()
        db.close()


@router.post("/asana-sync/import-all", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_import_all(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start importing EVERY non-archived Asana project the stored token can see
    and return immediately with a job to poll.

    It runs in the background because a full workspace takes minutes and Azure
    kills any request at ~230s - the synchronous version died there, returning a
    bodyless 499 that the browser reported as a CORS error. Same engine and same
    create/adopt/map loop as the token-based Import (_import_asana_projects), so
    the two cannot drift.

    Additive by construction (TokenConfig forces delete_sync off), so re-running
    tops projects up rather than removing anything."""
    import asana_sync

    cfg = asana_sync.get_config(db)
    # Setup runs under its own token when one is saved; otherwise the service
    # token, so an existing config keeps working untouched.
    token = (cfg.setup_token or "").strip() or cfg.token
    if not token:
        raise HTTPException(400, "Save an Asana token first.")

    running = (db.query(models.AsanaImportJob)
                 .filter(models.AsanaImportJob.status == "running")
                 .order_by(models.AsanaImportJob.started_at.desc()).first())
    if running and _job_is_alive(running):
        # Re-clicking the button joins the run in progress instead of starting a
        # second one over the same projects.
        return import_job_to_dict(running)
    if running:
        running.status, running.error = "stalled", _stalled_message(running)
        running.finished_at = now_iso()
        db.commit()

    # Carry the finished projects over from a run that stopped part way, so
    # clicking Import again continues rather than re-walking everything - which
    # is what the stopped-run message tells the operator it will do. Only from a
    # RECENT unfinished run: after a day the workspace has moved on and a full
    # pass is the safer default, and a run that finished normally never carries
    # over, so a deliberate re-import still tops up every project.
    carry = []
    last = (db.query(models.AsanaImportJob)
              .filter(models.AsanaImportJob.status.in_(("stalled", "error", "cancelled")))
              .order_by(models.AsanaImportJob.started_at.desc()).first())
    if last and last.done_gids and _recent(last.finished_at, hours=24):
        carry = list(last.done_gids)

    job = models.AsanaImportJob(id=gen_id(), status="running", started_by=user.get("email", ""),
                                started_at=now_iso(), heartbeat_at=now_iso(), result={},
                                done_gids=carry)
    db.add(job)
    db.commit()
    threading.Thread(target=_run_import_all, daemon=True,
                     args=(job.id, token, cfg.workspace_gid or "", dict(user))).start()
    return import_job_to_dict(job)


# A run that keeps dying takes the workspace no further, so it stops being
# retried rather than restarting on every deploy forever.
_IMPORT_MAX_ATTEMPTS = 5


def resume_stalled_import():
    """Pick up an import whose worker went away, and finish the rest.

    Called at startup on the sync worker. Without it an interrupted run stays
    stopped until somebody notices and clicks Import again - and until then the
    projects it never reached are not even MAPPED, so the pull ignores them and
    the gap does not quietly heal.

    A deploy is the common cause on dev: the API restarts on every merge, which
    is precisely when a long import is most likely to be in flight."""
    db = SessionLocal()
    try:
        # "stalled" as well as "running": by the time the app restarts, a status
        # poll has usually already retired the dead run - looking only for
        # "running" would find nothing and resume would never fire in the very
        # case it exists for. "error" is excluded on purpose: that is a real
        # failure (bad token, Asana refusing) and retrying it on every boot
        # would just fail on every boot.
        job = (db.query(models.AsanaImportJob)
                 .filter(models.AsanaImportJob.status.in_(("running", "stalled")))
                 .order_by(models.AsanaImportJob.started_at.desc()).first())
        if not job:
            return ""
        if job.status == "running" and _job_is_alive(job):
            # Another worker in this instance is still on it. Only a heartbeat
            # that has gone quiet means the run actually needs rescuing.
            return ""
        if job.cancel_requested:
            job.status, job.finished_at = "cancelled", now_iso()
            db.commit()
            return "cancelled"
        if (job.attempts or 1) >= _IMPORT_MAX_ATTEMPTS:
            job.status, job.finished_at = "error", now_iso()
            job.error = (f"Import stopped after {_IMPORT_MAX_ATTEMPTS} attempts at "
                         f"{job.done or 0} of {job.total or 0} project(s). "
                         "Run Import again to retry.")
            db.commit()
            return "gave up"

        import asana_sync
        cfg = asana_sync.get_config(db)
        token = (cfg.setup_token or "").strip() or cfg.token
        if not token:
            job.status, job.error = "error", "Import could not resume: no Asana token."
            job.finished_at = now_iso()
            db.commit()
            return "no token"

        job.attempts = (job.attempts or 1) + 1
        job.status = "running"
        job.error = ""
        job.finished_at = ""
        job.heartbeat_at = now_iso()      # claim it before the thread starts
        db.commit()
        threading.Thread(target=_run_import_all, daemon=True,
                         args=(job.id, token, cfg.workspace_gid or "",
                               {"email": job.started_by or ""})).start()
        return f"resumed at {job.done or 0}/{job.total or 0} (attempt {job.attempts})"
    except Exception as e:
        db.rollback()
        return f"failed: {e}"
    finally:
        db.close()


@router.post("/asana-sync/import-all/cancel", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_import_all_cancel(db: Session = Depends(get_db)):
    """Ask a running import to stop at the next project boundary.

    A request, not a kill: the worker is on another thread (another process on
    dev), and stopping it mid-project would leave that project half-imported.
    What is already in stays in - import is additive, so re-running later
    resumes rather than duplicating."""
    job = (db.query(models.AsanaImportJob)
             .filter(models.AsanaImportJob.status == "running")
             .order_by(models.AsanaImportJob.started_at.desc()).first())
    if not job:
        return {"status": "idle"}
    job.cancel_requested = True
    # A job whose worker is already gone would never notice the flag, so retire
    # it here rather than leaving the UI waiting for a stop that cannot come.
    if not _job_is_alive(job):
        job.status, job.finished_at = "cancelled", now_iso()
    db.commit()
    return import_job_to_dict(job)


@router.get("/asana-sync/import-all/status", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_import_all_status(db: Session = Depends(get_db)):
    """Latest job, for the progress bar. Read from the DB rather than process
    memory: dev runs 8 gunicorn workers, so the worker answering this poll is
    usually not the one running the import."""
    job = (db.query(models.AsanaImportJob)
             .order_by(models.AsanaImportJob.started_at.desc()).first())
    if not job:
        return {"status": "idle"}
    if job.status == "running" and not _job_is_alive(job):
        job.status = "stalled"
        job.error = _stalled_message(job)
        job.finished_at = now_iso()
        db.commit()
    return import_job_to_dict(job)


@router.post("/asana-sync/purge-orphans", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_purge_orphans(apply: bool = False, db: Session = Depends(get_db)):
    """Clear sync rows stranded by project deletes that predate the purge in
    delete_project - dead task links, orphaned linked tasks, and map rows whose
    Nexus project is gone. Each of these BLOCKS a fresh import of the Asana
    tasks behind them. Defaults to a dry run; Asana is never touched."""
    import asana_sync
    return asana_sync.sweep_orphans(db, apply=apply)


@router.post("/asana-sync/pull", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_pull(db: Session = Depends(get_db)):
    import asana_sync
    from asana_import import ImportError_
    try:
        # Manual Pull is a reconcile: the operator clicked it because they want
        # everything checked now, including deletions an incremental poll cannot
        # see. The scheduled poll stays incremental.
        return asana_sync.pull(db, force_full=True)
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Asana pull failed - check the token. ({e})")


def _start_background_pull(db, label, run):
    """Shared guard + launcher for the long additive pulls (pull-new, pull-personal).

    Runs `run(session)` in a BACKGROUND thread and returns immediately. A full-
    workspace create-only pass takes minutes, which no request can survive -
    Cloudflare cuts the response at 100s (524) and gunicorn SIGKILLs the worker
    at 120s. The synchronous version died there having created nothing. Both
    engines commit per project / per person (see their checkpoint comments), so
    the background run makes durable progress and re-running is idempotent: a
    task created on an earlier pass now has a link and is skipped. Outbound push
    stays gated by NEXUS_ASANA_PUSH_DISABLED, so neither can ever write to Asana.

    One-at-a-time guard. A second concurrent run doesn't finish faster - it just
    contends with the first on the per-project advisory lock and both crawl (this
    bit us Aug 15, when repeated clicks stacked overlapping pulls that froze at
    +3 for 12 minutes). pull_running_at is stamped here and cleared when the run
    ends; a recent value means a pull is already in flight, so we refuse rather
    than stack another. A stale value (crashed run / killed worker) self-heals
    after the window so the button never wedges. The two pulls share the one
    guard on purpose: they take the same lock and touch the same tables."""
    import asana_sync
    from routers.task_util import now_iso
    cfg = asana_sync.get_config(db)
    if not cfg.token:
        raise HTTPException(400, "Save an Asana token first.")
    if not (cfg.workspace_gid or "").strip():
        raise HTTPException(400, "Pick your Asana workspace first (Find my workspace).")
    _PULL_STALE_SECS = 20 * 60
    running = (cfg.pull_running_at or "").strip()
    if running:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(running)).total_seconds()
        except ValueError:
            age = _PULL_STALE_SECS + 1   # unparseable -> treat as a dead run
        if age < _PULL_STALE_SECS:
            return {"started": False, "alreadyRunning": True}
    cfg.pull_running_at = now_iso()
    db.commit()

    def _thread():
        s = SessionLocal()
        try:
            res = run(s)
            print(f"[{label}] done: +{res.get('created', 0)} created, "
                  f"{res.get('skipped', 0)} existing skipped"
                  + (f"; connected accounts: {res['connected']}" if res.get('connected') else "")
                  + (f"; connected skipped: {res['connectedSkipped']}" if res.get('connectedSkipped') else ""))
        except Exception as e:  # no request to return to - land it in the log
            print(f"[{label}] failed: {e}")
        finally:
            # Always release the guard, or the next click is blocked until it goes stale.
            try:
                c = asana_sync.get_config(s)
                c.pull_running_at = ""
                s.commit()
            except Exception as e2:
                print(f"[{label}] guard-clear failed: {e2}")
            s.close()

    threading.Thread(target=_thread, daemon=True).start()
    return {"started": True}


@router.post("/asana-sync/pull-new", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_pull_new(db: Session = Depends(get_db)):
    """ADDITIVE pull ("pull what's not there, only"): create Nexus tasks for Asana
    tasks that have no Nexus counterpart yet, and leave EVERY existing task 100%
    untouched (no field/comment/attachment writes, no deletions). The recovery mode
    for when Nexus holds edits Asana doesn't - it can never overwrite them.
    Walks every MAPPED project; tasks in no project at all are pull-personal's."""
    import asana_sync
    return _start_background_pull(
        db, "pull-new", lambda s: asana_sync.pull(s, force_full=True, create_only=True))


@router.post("/asana-sync/pull-personal", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_pull_personal(db: Session = Depends(get_db)):
    """ADDITIVE pull of the tasks that sit in NO Asana project - the ones that only
    exist in someone's Asana "My Tasks". Every other inbound path walks projects and
    is blind to them (asana_sync.pull_personal_tasks explains). Same background /
    one-at-a-time / create-only contract as pull-new."""
    import asana_sync
    return _start_background_pull(
        db, "pull-personal", lambda s: asana_sync.pull_personal_tasks(s, create_only=True))


@router.post("/asana-sync/rescue-attachments", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_rescue_attachments(db: Session = Depends(get_db)):
    """Rescue attachment files still hosted on Asana before the subscription
    ends (asanausercontent.com signed URLs and app.asana.com external-host
    pointers). Same shape as pull-new: starts a BACKGROUND thread and returns
    immediately - ~450 files / ~4 GB cannot survive a request timeout - with a
    one-at-a-time guard in asana_sync_config.rescue_running_at (30-minute
    stale window, so a killed worker never wedges the button). Read-only
    toward Asana (GET only); Nexus-side it only ever rewrites a row's url
    AWAY from a dying host, keeping the old value in original_asana_url.
    Idempotent: rescued rows drop out of the scan, failures are retried by
    simply running it again. See asana_rescue.py."""
    import asana_rescue
    import asana_sync
    from routers.task_util import now_iso
    cfg = asana_sync.get_config(db)
    if not (cfg.token or "").strip() and not (cfg.setup_token or "").strip():
        raise HTTPException(400, "Save an Asana token first.")

    running = (getattr(cfg, "rescue_running_at", "") or "").strip()
    if running:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(running)).total_seconds()
        except ValueError:
            age = asana_rescue.STALE_SECS + 1   # unparseable -> treat as a dead run
        if age < asana_rescue.STALE_SECS:
            return {"started": False, "alreadyRunning": True}
    cfg.rescue_running_at = now_iso()
    db.commit()

    def _run_rescue():
        # run_rescue clears rescue_running_at itself in its finally block.
        asana_rescue.run_rescue(SessionLocal)

    threading.Thread(target=_run_rescue, daemon=True).start()
    return {"started": True}


@router.get("/asana-sync/rescue-status", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_rescue_status(db: Session = Depends(get_db)):
    """Progress of the attachment rescue: the in-memory counters of the run on
    THIS worker process (a run started on another gunicorn worker shows only
    the DB-derived numbers) plus DB truth that survives restarts:
    at_risk_remaining (rows still on a dying host) and rescued_total (rows a
    rescue has rewritten). running reflects the cross-process guard column."""
    import asana_rescue
    import asana_sync
    cfg = asana_sync.get_config(db)
    running = (getattr(cfg, "rescue_running_at", "") or "").strip()
    fresh = False
    if running:
        try:
            fresh = (datetime.now(timezone.utc) - datetime.fromisoformat(running)
                     ).total_seconds() < asana_rescue.STALE_SECS
        except ValueError:
            fresh = False
    return {"running": fresh, "startedAt": running,
            "worker": asana_rescue.status_snapshot(),
            **asana_rescue.db_progress(db)}


@router.post("/asana-sync/push-all", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_push_all(db: Session = Depends(get_db)):
    import asana_sync
    from asana_import import ImportError_
    try:
        return asana_sync.push_all(db)
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Asana push failed - check the token. ({e})")


@router.get("/asana-sync/assignee-check", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_assignee_check(db: Session = Depends(get_db)):
    """Why assignees are or are not reaching Asana.

    Its own check because assignee is the one field that can fail alone: it is
    the only one that must be TRANSLATED from a Nexus email into an Asana user
    gid, and every way that translation fails looks the same from outside - the
    task updates, the assignee does not, and nothing says why."""
    import asana_sync
    return asana_sync.assignee_diagnosis(db)


@router.post("/asana-sync/dedupe", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_dedupe(apply: bool = False, db: Session = Depends(get_db)):
    """Merge Nexus tasks that all point at the same Asana task - the leftovers
    from the pre-fix Pull, which could create a second Nexus task for a gid it
    had already linked (see asana_sync.dedupe_tasks). Defaults to a dry run."""
    import asana_sync
    return asana_sync.dedupe_tasks(db, apply=apply)


@router.get("/asana-sync/workspaces", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_workspaces(db: Session = Depends(get_db)):
    """The workspaces this token can see, so the Workspace GID can be picked
    instead of typed.

    Asana does not show a workspace id anywhere in its UI, and the ids in its
    URLs (app.asana.com/0/<project>/<task>) are PROJECT ids - which is exactly
    how a project gid ends up pasted into this field. It reads as valid, nothing
    validates it, and the only symptom is that assignees quietly stop resolving
    while every other field syncs normally."""
    import asana_sync
    from asana_import import Asana, ImportError_
    cfg = asana_sync.get_config(db)
    if not cfg.token:
        raise HTTPException(400, "Save the sync token first.")
    try:
        return [{"gid": w["gid"], "name": w.get("name") or w["gid"]}
                for w in Asana(cfg.token).get("/workspaces", opt_fields="name")]
    except ImportError_ as e:
        raise HTTPException(400, f"Could not list workspaces - check the token. ({e})")


@router.get("/asana-sync/asana-projects", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def asana_sync_asana_projects(db: Session = Depends(get_db)):
    """List Asana projects using the STORED sync token (so the mapping UI can offer
    a picker instead of raw GIDs). Scoped to the configured workspace if set."""
    import asana_sync
    from asana_import import Asana, ImportError_
    cfg = asana_sync.get_config(db)
    if not cfg.token:
        raise HTTPException(400, "Save the sync token first.")
    asana = Asana(cfg.token)
    try:
        workspaces = [{"gid": cfg.workspace_gid}] if cfg.workspace_gid else asana.get("/workspaces", opt_fields="name")
        out = []
        for w in workspaces:
            for p in asana.get("/projects", workspace=w["gid"], opt_fields="name,archived"):
                if not p.get("archived"):
                    out.append({"gid": p["gid"], "name": p.get("name") or p["gid"]})
        return out
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Asana request failed - check the token. ({e})")


class AsanaWebhookBody(BaseModel):
    # PUBLIC https base of this API. Optional - defaults to this deployment's own
    # host, so dev/prod need no URL; only local tunnels have to supply one.
    target_base: Optional[str] = None


@router.get("/asana-sync/webhooks", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def list_asana_webhooks(db: Session = Depends(get_db)):
    import asana_sync
    rows = (db.query(models.AsanaWebhook)
            .filter(models.AsanaWebhook.asana_webhook_gid != "").all())
    return {"webhooks": [{"resourceGid": w.resource_gid, "webhookGid": w.asana_webhook_gid,
                          "target": w.target} for w in rows],
            "publicBase": asana_sync.public_base(),
            "isSyncWorker": asana_sync.is_sync_worker()}


@router.post("/asana-sync/webhooks", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def register_asana_webhooks(body: AsanaWebhookBody, db: Session = Depends(get_db)):
    import asana_sync
    from asana_import import ImportError_
    try:
        return asana_sync.register_webhooks(db, (body.target_base or "").strip())
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Webhook registration failed. ({e})")


@router.delete("/asana-sync/webhooks", dependencies=[Depends(require_manager), Depends(_require_asana_enabled)])
def delete_asana_webhooks(db: Session = Depends(get_db)):
    import asana_sync
    return asana_sync.delete_webhooks(db)



# ── OCR (mobile "scan text" - quick-add ABC scanner) ─────────────────────────
# Extracts text from an uploaded photo via Tesseract. The engine (pytesseract +
# the `tesseract` binary) must be present on the host; if it isn't we return 501
# so the client can degrade gracefully instead of 500-ing.
# ── AI rephrase (task description editor) ────────────────────────────────────
_REPHRASE_MODEL = "claude-opus-5"
_REPHRASE_MAX_CHARS = 8000


class RephraseBody(BaseModel):
    text: str
    tone: Optional[str] = "clear"   # clear | concise | formal | friendly


_REPHRASE_TONES = {
    "clear": "Rewrite it to be clearer and better organized.",
    "concise": "Rewrite it to be as short as possible while keeping every fact.",
    "formal": "Rewrite it in a professional, formal register.",
    "friendly": "Rewrite it in a warm, approachable register.",
}


@router.post("/task-ai/rephrase")
def task_ai_rephrase(body: RephraseBody):
    """Rephrase a task description. Returns the suggestion only - the editor shows
    it beside the original and the user accepts or rejects it, so nothing is
    overwritten server-side.

    Plain text in, plain text out: the client sends the editor's text content and
    re-inserts the result as a paragraph, which keeps the model away from the
    document's HTML structure entirely. Same httpx-to-api.anthropic.com shape as
    routers/help.py and routers/hr_interviews.py rather than a new SDK dependency.
    """
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Nothing to rephrase.")
    if len(text) > _REPHRASE_MAX_CHARS:
        raise HTTPException(400, f"That's too long to rephrase (limit {_REPHRASE_MAX_CHARS} characters).")
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI rephrasing isn't configured on this server (no ANTHROPIC_API_KEY).")

    instruction = _REPHRASE_TONES.get((body.tone or "clear"), _REPHRASE_TONES["clear"])
    prompt = (
        "The following is the description of a task in an internal company work-tracking "
        "tool. " + instruction + "\n\n"
        "Rules:\n"
        "- Keep every fact, name, date, number, and link exactly as given. Do not invent details.\n"
        "- Keep it in American English.\n"
        "- Preserve the paragraph and list structure of the original.\n"
        "- Output ONLY the rewritten description. No preamble, no quotes, no code fences, "
        "no commentary about what you changed.\n\n"
        "DESCRIPTION:\n" + text
    )
    try:
        with httpx.Client(timeout=90) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": _ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": _REPHRASE_MODEL,
                    "max_tokens": 4000,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:   # noqa: BLE001
        print(f"[task-ai] rephrase failed: {e}")
        raise HTTPException(502, "The rephrase service didn't respond. Try again.")

    # A safety decline comes back as a normal 200 with stop_reason "refusal" and
    # empty content - check it before reading blocks, or this returns "" as if it
    # had succeeded.
    if data.get("stop_reason") == "refusal":
        raise HTTPException(422, "The model declined to rewrite that text.")
    out = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    if not out:
        raise HTTPException(502, "The rephrase service returned nothing. Try again.")
    return {"text": out, "model": _REPHRASE_MODEL}


@router.post("/task-ocr")
async def task_ocr(image: UploadFile = File(...)):
    raw = await image.read()
    if not raw:
        raise HTTPException(400, "Empty image")
    try:
        import io
        from PIL import Image
        import pytesseract
    except Exception:
        raise HTTPException(501, "OCR engine is not installed on the server")
    try:
        img = Image.open(io.BytesIO(raw))
        text = pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError:
        raise HTTPException(501, "Tesseract binary is not available on the server")
    except Exception as exc:
        raise HTTPException(500, f"Could not read the image: {exc}")
    return {"text": (text or "").strip()}


# ── Notifications (module's own bell) ────────────────────────────────────────
def notification_to_dict(n: models.TaskNotification) -> dict:
    return {"id": n.id, "kind": n.kind or "", "title": n.title or "", "body": n.body or "",
            "forUserId": n.for_email or "", "requestId": _nz(n.request_id),
            "departmentId": _nz(n.department_id), "taskId": _nz(n.task_id),
            "read": bool(n.read), "createdAt": n.created_at or ""}


@router.get("/task-notifications")
def list_notifications(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    q = db.query(models.TaskNotification)
    if user["level"] >= 4:  # admins also see the "admins" fan-out
        q = q.filter(or_(models.TaskNotification.for_email == email,
                         models.TaskNotification.for_email == "admins"))
    else:
        q = q.filter(models.TaskNotification.for_email == email)
    rows = q.order_by(models.TaskNotification.created_at.desc()).limit(500).all()
    return [notification_to_dict(n) for n in rows]


@router.post("/task-notifications/{notif_id}/read")
def mark_notification_read(notif_id: str, db: Session = Depends(get_db)):
    n = db.query(models.TaskNotification).filter(models.TaskNotification.id == notif_id).first()
    if not n:
        raise HTTPException(404, "Notification not found")
    n.read = True
    db.commit()
    return {"ok": True}


@router.post("/task-notifications/read-all")
def mark_all_read(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    targets = [email] + (["admins"] if user["level"] >= 4 else [])
    db.query(models.TaskNotification).filter(
        models.TaskNotification.for_email.in_(targets),
        models.TaskNotification.read == False,  # noqa: E712
    ).update({models.TaskNotification.read: True}, synchronize_session=False)
    db.commit()
    return {"ok": True}


# ── Changelog / What's New ───────────────────────────────────────────────────
def changelog_entry_to_dict(e: models.TaskChangelogEntry) -> dict:
    payload = e.payload if isinstance(e.payload, dict) else {}
    return {**payload, "id": e.id, "createdAt": e.created_at or "", "updatedAt": e.updated_at or ""}


def changelog_comment_to_dict(c: models.TaskChangelogComment) -> dict:
    return {"id": c.id, "entryId": c.entry_id, "authorId": _nz(c.author_email),
            "body": c.body or "", "createdAt": c.created_at or ""}


class ChangelogEntryBody(BaseModel):
    id: Optional[str] = None
    payload: dict[str, Any]


class ChangelogCommentBody(BaseModel):
    id: Optional[str] = None
    body: str


@router.get("/task-changelog")
def list_changelog(db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogEntry).order_by(models.TaskChangelogEntry.created_at.desc()).all()
    return [changelog_entry_to_dict(e) for e in rows]


@router.post("/task-changelog", status_code=201)
def create_changelog(body: ChangelogEntryBody, db: Session = Depends(get_db)):
    now = now_iso()
    e = models.TaskChangelogEntry(id=body.id or gen_id(), payload=body.payload or {},
                                  created_at=now, updated_at=now)
    db.add(e)
    db.commit()
    db.refresh(e)
    return changelog_entry_to_dict(e)


@router.patch("/task-changelog/{entry_id}")
def update_changelog(entry_id: str, body: ChangelogEntryBody, db: Session = Depends(get_db)):
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    e.payload = body.payload or {}
    e.updated_at = now_iso()
    db.commit()
    db.refresh(e)
    return changelog_entry_to_dict(e)


@router.delete("/task-changelog/{entry_id}", status_code=204)
def delete_changelog(entry_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).delete()
    db.query(models.TaskChangelogComment).filter(models.TaskChangelogComment.entry_id == entry_id).delete()
    db.commit()


@router.get("/task-changelog/{entry_id}/comments")
def list_changelog_comments(entry_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogComment).filter(
        models.TaskChangelogComment.entry_id == entry_id).all()
    return [changelog_comment_to_dict(c) for c in rows]


@router.post("/task-changelog/{entry_id}/comments", status_code=201)
def add_changelog_comment(entry_id: str, body: ChangelogCommentBody,
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = models.TaskChangelogComment(id=body.id or gen_id(), entry_id=entry_id,
                                    author_email=user["email"].lower(), body=body.body or "",
                                    created_at=now_iso())
    db.add(c)
    db.commit()
    db.refresh(c)
    return changelog_comment_to_dict(c)


# ── Generate changelog drafts from git commits ───────────────────────────────
# Admin clicks "Generate from git" in Manage → we pull recent commits (GitHub API
# in prod, local `git log` in dev), ask Claude to cluster them into a few
# user-facing, plain-English "What's New" entries, and file them as origin='pr'
# / status='Pending Review'. They then flow through the normal review → publish.
_AI_MODEL = "claude-opus-4-8"
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
_GITHUB_REPO = os.getenv("GITHUB_REPO", "Greens-Global/Greens-Nexus")
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_CHANGE_TYPES = ["Bug Fix", "Performance", "New Feature", "Security Update",
                 "Hotfix", "Maintenance", "Improvement"]


def _is_noise(subject: str) -> bool:
    s = (subject or "").strip().lower()
    return not s or s.startswith("merge ")


def _recent_commits(limit: int = 80) -> tuple[list[dict], str]:
    """Return ([{sha, author, date, subject, body}], source). Prefers the GitHub
    API (works on the deployed backend, which has no working tree); falls back to
    a local `git log` when a repo is present (dev)."""
    if _GITHUB_TOKEN:
        try:
            with httpx.Client(timeout=30) as client:
                r = client.get(
                    f"https://api.github.com/repos/{_GITHUB_REPO}/commits",
                    params={"per_page": min(limit, 100)},
                    headers={"Authorization": f"Bearer {_GITHUB_TOKEN}",
                             "Accept": "application/vnd.github+json"},
                )
                r.raise_for_status()
            out = []
            for row in r.json():
                commit = row.get("commit", {}) or {}
                subject, _, cbody = (commit.get("message", "") or "").partition("\n")
                out.append({"sha": row.get("sha", ""),
                            "author": (commit.get("author") or {}).get("name", ""),
                            "date": (commit.get("author") or {}).get("date", ""),
                            "subject": subject.strip(), "body": cbody.strip()})
            return out, "github"
        except Exception as e:  # noqa: BLE001
            print(f"[changelog] GitHub fetch failed, trying local git: {e}")
    try:
        sep, rec = "\x1f", "\x1e"
        fmt = sep.join(["%H", "%an", "%aI", "%s", "%b"]) + rec
        raw = subprocess.check_output(
            ["git", "-C", _REPO_ROOT, "log", f"-n{limit}", "--no-merges", f"--pretty=format:{fmt}"],
            text=True, encoding="utf-8", errors="replace",
        )
        out = []
        for chunk in raw.split(rec):
            chunk = chunk.strip("\n")
            if not chunk.strip():
                continue
            parts = chunk.split(sep)
            if len(parts) < 4:
                continue
            out.append({"sha": parts[0], "author": parts[1], "date": parts[2],
                        "subject": parts[3], "body": parts[4] if len(parts) > 4 else ""})
        return out, "git"
    except Exception as e:  # noqa: BLE001
        print(f"[changelog] local git log failed: {e}")
        return [], "none"


def _known_shas(db: Session) -> set[str]:
    """8-char prefixes of every commit already summarised into an entry."""
    seen: set[str] = set()
    for e in db.query(models.TaskChangelogEntry).all():
        payload = e.payload if isinstance(e.payload, dict) else {}
        for s in (payload.get("commitShas") or []):
            if s:
                seen.add(s[:8])
    return seen


def _cluster_commits(commits: list[dict]) -> list[dict]:
    """Ask Claude to fold the commits into a few plain-English feature entries."""
    if not _ANTHROPIC_API_KEY or not commits:
        return []
    lines = []
    for c in commits:
        line = f"- [{c['sha'][:8]}] {c['subject']}"
        if c.get("body"):
            line += f" - {c['body'][:240].replace(chr(10), ' ')}"
        lines.append(line)
    commit_block = "\n".join(lines)
    prompt = (
        "You turn a list of git commits from the Nexus internal staff portal "
        "(\"Nexus\") into a short changelog for NON-TECHNICAL business users.\n\n"
        "Group related commits into a small number of user-facing updates (usually 1-6). "
        "SKIP commits that are pure chores, refactors, tests, docs, build/CI, dependency "
        "bumps, or internal plumbing with no visible effect - if nothing is user-facing, "
        "return an empty array. Never use commit hashes, branch names, ticket IDs, code "
        "identifiers, or engineering jargon in the text. Be concrete about the user-visible effect.\n\n"
        f"Allowed \"type\" values: {', '.join(_CHANGE_TYPES)}.\n\n"
        "Return ONLY a JSON array (no prose, no code fences). Each element:\n"
        '{ "title": string (short, plain English, no jargon),\n'
        '  "description": string (1-3 sentences a non-technical user understands),\n'
        '  "type": one of the allowed values,\n'
        '  "module": string (product area, e.g. HR, Dashboard, Tasks, Item Management),\n'
        '  "businessImpact": string (one sentence: the plain-English payoff),\n'
        '  "whatsChanged": string[] (2-5 short plain-English bullets),\n'
        '  "commitShas": string[] (the 8-char hashes from the list you grouped into this entry) }\n\n'
        f"COMMITS:\n{commit_block}"
    )
    try:
        with httpx.Client(timeout=120) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": _ANTHROPIC_API_KEY,
                         "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": _AI_MODEL, "max_tokens": 6000,
                      "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if text.startswith("```"):
            text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text[3:] else text.strip("`")
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end == -1:
            return []
        parsed = json.loads(text[start:end + 1])
        return parsed if isinstance(parsed, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"[changelog] cluster failed: {e}")
        return []


@router.post("/task-changelog/generate")
def generate_changelog(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI is not configured (ANTHROPIC_API_KEY missing).")
    commits, source = _recent_commits()
    if source == "none":
        raise HTTPException(503, "Could not read commit history (no GitHub token and no local repo).")
    known = _known_shas(db)
    fresh = [c for c in commits if not _is_noise(c["subject"]) and c["sha"][:8] not in known]
    if not fresh:
        return {"created": 0, "scanned": len(commits), "source": source,
                "message": "No new commits to summarise since the last update."}

    drafts = _cluster_commits(fresh[:40])
    created = []
    now = now_iso()
    for d in drafts:
        if not isinstance(d, dict) or not (d.get("title") and d.get("description")):
            continue
        ctype = d.get("type") if d.get("type") in _CHANGE_TYPES else "Improvement"
        shas = [s[:8] for s in (d.get("commitShas") or []) if isinstance(s, str)]
        payload = {
            "title": str(d["title"]).strip(),
            "description": str(d["description"]).strip(),
            "type": ctype,
            "module": str(d.get("module") or "").strip(),
            "version": "unreleased",
            "environment": "Production",
            "releasedAt": now[:16],
            "authorId": user["email"].lower(),
            "businessImpact": str(d.get("businessImpact") or "").strip() or None,
            "whatsChanged": [str(x).strip() for x in (d.get("whatsChanged") or []) if str(x).strip()][:5],
            "commitShas": shas,
            "origin": "pr",
            "status": "Pending Review",
        }
        e = models.TaskChangelogEntry(id=gen_id(), payload=payload, created_at=now, updated_at=now)
        db.add(e)
        created.append(e)
    db.commit()
    for e in created:
        db.refresh(e)
    return {"created": len(created), "scanned": len(fresh), "source": source,
            "entries": [changelog_entry_to_dict(e) for e in created]}
