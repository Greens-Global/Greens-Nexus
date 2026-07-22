"""Task Module — config & misc router: saved views, automation rules, templates,
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
import httpx
import models
from database import get_db
from auth import get_current_user, require_level, require_manager
from routers.task_util import now_iso, gen_id

router = APIRouter(tags=["Tasks"], dependencies=[Depends(get_current_user)])


def _nz(v):
    return v if v not in ("", None) else None


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


@router.post("/task-asana-projects", dependencies=[Depends(require_manager)])
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
    subtasks: bool = True
    comments: bool = True
    attachments: bool = True
    silent_comments: bool = True
    attach_max_mb: float = 5.0
    email_map: Optional[dict] = None


@router.post("/task-asana-import", dependencies=[Depends(require_manager)])
def asana_import(body: AsanaImportBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import base64
    import mimetypes
    import urllib.request
    # Reuse the tested Asana client + field mapping from the CLI tool, and the
    # existing create handlers (called directly — Depends defaults are bypassed).
    from asana_import import Asana, resolve_assignee, priority_from_custom, section_name, TASK_OPT_FIELDS, ImportError_
    from routers.tasks import (create_task, create_section, add_comment, add_attachment, update_task,
                               TaskCreate, SectionBody, CommentCreate, AttachmentCreate, TaskUpdate)
    from routers.task_projects import create_project, ProjectBody

    if not (body.project_gids or body.workspace):
        raise HTTPException(400, "Provide at least one project GID or a workspace GID.")

    asana = Asana(body.token)
    email_map = {k.lower(): v for k, v in (body.email_map or {}).items()}
    counts = {"projects": 0, "tasks": 0, "subtasks": 0, "comments": 0, "attachments": 0, "errors": []}
    cap = body.attach_max_mb * 1024 * 1024

    def import_comments(gid, tid):
        for s in asana.get(f"/tasks/{gid}/stories",
                           opt_fields="type,resource_subtype,text,created_at,created_by.name,created_by.email"):
            if s.get("type") != "comment" and s.get("resource_subtype") != "comment_added":
                continue
            text = (s.get("text") or "").strip()
            if not text:
                continue
            cb = s.get("created_by") or {}
            author = (cb.get("email") or "").lower()
            author = email_map.get(author) or email_map.get((cb.get("name") or "").lower()) or author
            prov = " · ".join([x for x in (cb.get("name"), (s.get("created_at") or "")[:10]) if x])
            cbody = f"[Asana · {prov}]\n{text}" if prov else text
            add_comment(tid, CommentCreate(body=cbody, author_email=author or None),
                        notify=(not body.silent_comments), user=user, db=db)
            counts["comments"] += 1

    def import_attachments(gid, tid):
        for a in asana.get(f"/tasks/{gid}/attachments",
                           opt_fields="name,download_url,permanent_url,view_url,size,host"):
            name = a.get("name") or "attachment"
            size = a.get("size") or 0
            kind = "image" if (mimetypes.guess_type(name)[0] or "").startswith("image/") else "doc"
            host = a.get("host") or ""
            url = ""
            if host and host != "asana":
                url = a.get("permanent_url") or a.get("view_url") or a.get("download_url") or ""
            else:
                dl = a.get("download_url")
                if dl and 0 < size <= cap:
                    try:
                        with urllib.request.urlopen(dl, timeout=90) as r:
                            raw = r.read()
                        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                        url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
                    except Exception:
                        url = a.get("view_url") or dl or ""
                else:
                    url = a.get("view_url") or dl or ""
            add_attachment(tid, AttachmentCreate(name=name, size=f"{max(1, round(size / 1024))} KB", kind=kind, url=url),
                           user=user, db=db)
            counts["attachments"] += 1

    def import_task(t, project_id, section_cache, parent_id=""):
        sid = ""
        if not parent_id:
            sname = section_name(t)
            if sname:
                if sname not in section_cache:
                    sec = create_section(SectionBody(project_id=project_id, name=sname), db=db)
                    section_cache[sname] = sec["id"]
                sid = section_cache[sname]
        created = create_task(TaskCreate(
            title=t.get("name") or "(untitled)", description=t.get("notes") or "",
            priority=priority_from_custom(t), assignee_email=resolve_assignee(t, email_map),
            project_id=project_id if not parent_id else "", section_id=sid, parent_task_id=parent_id,
            tags=[tg.get("name") for tg in (t.get("tags") or []) if tg.get("name")],
            due_on=t.get("due_on") or (t.get("due_at") or "")[:10], status="not_started",
        ), user=user, db=db)
        tid = created["id"]
        if t.get("completed"):
            update_task(tid, TaskUpdate(completed=True), user=user, db=db)
        counts["subtasks" if parent_id else "tasks"] += 1
        if body.comments:
            import_comments(t["gid"], tid)
        if body.attachments:
            import_attachments(t["gid"], tid)
        if body.subtasks:
            for sub in asana.get(f"/tasks/{t['gid']}/subtasks", opt_fields=TASK_OPT_FIELDS):
                import_task(sub, project_id, section_cache, tid)

    try:
        gids = list(body.project_gids or [])
        if body.workspace:
            gids += [p["gid"] for p in asana.get("/projects", workspace=body.workspace, opt_fields="name")]
    except ImportError_ as e:
        # first Asana call failed — almost always a bad token or GID.
        raise HTTPException(400, f"Asana request failed: {e}")

    for gid in gids:
        try:
            proj = asana.get(f"/projects/{gid}", opt_fields="name,notes")
            p = create_project(ProjectBody(name=proj.get("name") or f"Asana {gid}",
                                           description=proj.get("notes") or ""), user=user, db=db)
            counts["projects"] += 1
            section_cache = {}
            for t in asana.get(f"/projects/{gid}/tasks", opt_fields=TASK_OPT_FIELDS):
                import_task(t, p["id"], section_cache, "")
        except HTTPException:
            raise
        except Exception as e:
            counts["errors"].append(f"project {gid}: {e}")

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
def custom_field_to_dict(f: models.TaskCustomField) -> dict:
    return {"id": f.id, "name": f.name, "description": _nz(f.description), "type": f.type or "text",
            "options": f.options if isinstance(f.options, list) else []}


class CustomFieldBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    type: Optional[str] = "text"
    options: Optional[list] = None


@router.get("/task-custom-fields")
def list_custom_fields(db: Session = Depends(get_db)):
    return [custom_field_to_dict(f) for f in db.query(models.TaskCustomField).all()]


@router.post("/task-custom-fields", status_code=201)
def create_custom_field(body: CustomFieldBody, db: Session = Depends(get_db)):
    f = models.TaskCustomField(id=body.id or gen_id(), name=body.name, description=body.description or "",
                               type=body.type or "text", options=body.options or [])
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


class AsanaProjectMapBody(BaseModel):
    maps: list                                  # [{nexusProjectId, asanaProjectGid}]


def _sync_config_dict(cfg) -> dict:
    return {"enabled": bool(cfg.enabled), "workspaceGid": _nz(cfg.workspace_gid),
            "defaultProjectGid": _nz(cfg.default_project_gid), "hasToken": bool(cfg.token),
            "lastPullAt": _nz(cfg.last_pull_at)}


@router.get("/asana-sync/config", dependencies=[Depends(require_manager)])
def get_asana_sync_config(db: Session = Depends(get_db)):
    import asana_sync
    cfg = asana_sync.get_config(db)
    maps = [{"nexusProjectId": m.nexus_project_id, "asanaProjectGid": m.asana_project_gid}
            for m in db.query(models.AsanaProjectMap).all()]
    return {**_sync_config_dict(cfg), "projectMap": maps}


@router.put("/asana-sync/config", dependencies=[Depends(require_manager)])
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
    if body.workspace_gid is not None:
        cfg.workspace_gid = body.workspace_gid
    if body.default_project_gid is not None:
        cfg.default_project_gid = body.default_project_gid
    from routers.task_util import now_iso
    cfg.updated_at = now_iso()
    db.commit()
    db.refresh(cfg)
    return _sync_config_dict(cfg)


@router.put("/asana-sync/projects", dependencies=[Depends(require_manager)])
def set_asana_project_map(body: AsanaProjectMapBody, db: Session = Depends(get_db)):
    from routers.task_util import now_iso
    db.query(models.AsanaProjectMap).delete()
    for m in body.maps or []:
        npid = (m.get("nexusProjectId") or "").strip()
        agid = (m.get("asanaProjectGid") or "").strip()
        if npid and agid:
            db.add(models.AsanaProjectMap(id=gen_id(), nexus_project_id=npid,
                                          asana_project_gid=agid, created_at=now_iso()))
    db.commit()
    return {"count": db.query(models.AsanaProjectMap).count()}


@router.post("/asana-sync/pull", dependencies=[Depends(require_manager)])
def asana_sync_pull(db: Session = Depends(get_db)):
    import asana_sync
    from asana_import import ImportError_
    try:
        return asana_sync.pull(db)
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Asana pull failed — check the token. ({e})")


@router.post("/asana-sync/push-all", dependencies=[Depends(require_manager)])
def asana_sync_push_all(db: Session = Depends(get_db)):
    import asana_sync
    from asana_import import ImportError_
    try:
        return asana_sync.push_all(db)
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Asana push failed — check the token. ({e})")


@router.get("/asana-sync/asana-projects", dependencies=[Depends(require_manager)])
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
        raise HTTPException(400, f"Asana request failed — check the token. ({e})")


class AsanaWebhookBody(BaseModel):
    # PUBLIC https base of this API. Optional — defaults to this deployment's own
    # host, so dev/prod need no URL; only local tunnels have to supply one.
    target_base: Optional[str] = None


@router.get("/asana-sync/webhooks", dependencies=[Depends(require_manager)])
def list_asana_webhooks(db: Session = Depends(get_db)):
    import asana_sync
    rows = (db.query(models.AsanaWebhook)
            .filter(models.AsanaWebhook.asana_webhook_gid != "").all())
    return {"webhooks": [{"resourceGid": w.resource_gid, "webhookGid": w.asana_webhook_gid,
                          "target": w.target} for w in rows],
            "publicBase": asana_sync.public_base(),
            "isSyncWorker": asana_sync.is_sync_worker()}


@router.post("/asana-sync/webhooks", dependencies=[Depends(require_manager)])
def register_asana_webhooks(body: AsanaWebhookBody, db: Session = Depends(get_db)):
    import asana_sync
    from asana_import import ImportError_
    try:
        return asana_sync.register_webhooks(db, (body.target_base or "").strip())
    except (ImportError_, ValueError, UnicodeError) as e:
        raise HTTPException(400, f"Webhook registration failed. ({e})")


@router.delete("/asana-sync/webhooks", dependencies=[Depends(require_manager)])
def delete_asana_webhooks(db: Session = Depends(get_db)):
    import asana_sync
    return asana_sync.delete_webhooks(db)



# ── OCR (mobile "scan text" — quick-add ABC scanner) ─────────────────────────
# Extracts text from an uploaded photo via Tesseract. The engine (pytesseract +
# the `tesseract` binary) must be present on the host; if it isn't we return 501
# so the client can degrade gracefully instead of 500-ing.
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
            line += f" — {c['body'][:240].replace(chr(10), ' ')}"
        lines.append(line)
    commit_block = "\n".join(lines)
    prompt = (
        "You turn a list of git commits from Greens Global's internal staff portal "
        "(\"Nexus\") into a short changelog for NON-TECHNICAL business users.\n\n"
        "Group related commits into a small number of user-facing updates (usually 1-6). "
        "SKIP commits that are pure chores, refactors, tests, docs, build/CI, dependency "
        "bumps, or internal plumbing with no visible effect — if nothing is user-facing, "
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
