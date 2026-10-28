"""Workflows (Neil, Oct 28 2026) - the API under /workflows. Every route
is a plain `def` (FastAPI's thread pool; nothing on the event loop). The
grant is `workflows` (Settings > People & Access): viewer sees, editor
builds and publishes their own, full manages every workflow in their
company scope, a Global Admin everything, every company and Settings >
Workflows. The shapes are the ones the frontend was built against (the
contract notes in the plan); the engine, store, approvals, templates and
Describe It live in backend/workflows/.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

import models
from auth import get_current_user, require_module_grant
from database import get_db
from workflows import approvals, automations, catalog, describe, engine, scheduler, store, templates
from workflows import settings as wf_settings
from workflows.emit import payload_for

router = APIRouter(prefix="/workflows", tags=["Workflows"])

R = require_module_grant("workflows", "viewer")
E = require_module_grant("workflows", "editor")
F = require_module_grant("workflows", "full")
GA = require_module_grant("workflows", "owner", bypass_level="owner")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _me(user: dict) -> str:
    return (user.get("email") or "").lower()


def _is_ga(user: dict) -> bool:
    return store.is_global_admin(user)


def _companies_of(db, user: dict):
    return store.companies_of(db, user)


def _company_rows(db, user: dict) -> list[dict]:
    scope = _companies_of(db, user)
    import auth
    own = auth.company_of(user, db)
    rows = db.query(models.HrEntity).order_by(models.HrEntity.name).all()
    return [{"id": r.id, "name": r.name or r.id, "own": r.id == own} for r in rows if scope is None or r.id in scope]


def _wf_or_404(db, user: dict, wid: str) -> models.Workflow:
    wf = db.get(models.Workflow, wid)
    if wf is None or not store.can_see(db, user, wf):
        raise HTTPException(404, "Workflow not found")
    return wf


def _editable(db, user: dict, wf: models.Workflow) -> models.Workflow:
    if not store.can_edit(db, user, wf):
        raise HTTPException(403, "Only the owner or a full-level user may change this workflow")
    return wf


def _company_for_new(db, user: dict, company_id: Optional[str]) -> str:
    """Blank from a Global Admin = every company; blank from anyone else =
    their own company; a named company must be in the caller's scope."""
    import auth
    cid = (company_id or "").strip()
    if not cid:
        if _is_ga(user):
            return ""
        cid = auth.company_of(user, db)
        if not cid:
            raise HTTPException(403, "Your account is not placed in a company, so a Global Admin must create this")
        return cid
    scope = _companies_of(db, user)
    if scope is not None and cid not in scope:
        raise HTTPException(404, "Company not found")
    if db.get(models.HrEntity, cid) is None:
        raise HTTPException(404, "Company not found")
    return cid


def _run_as_for(db, user: dict, run_as: Optional[str], current: str = "owner") -> str:
    ra = (run_as or current or "owner").strip()
    if ra not in ("owner", "nexus"):
        raise HTTPException(422, "runAs is owner or nexus")
    if ra == "nexus":
        if not _is_ga(user):
            raise HTTPException(403, "Only a Global Admin may run a workflow as Nexus")
        if not wf_settings.get(db).get("nexusRunAs"):
            raise HTTPException(403, "Running as Nexus is switched off in Settings > Workflows")
    return ra


def _problem_422(e: store.ValidationError):
    raise HTTPException(422, {"problems": [p.to_dict() for p in e.problems]})


# ── bodies ───────────────────────────────────────────────────────────────────
class CreateBody(BaseModel):
    name: Optional[str] = None
    companyId: Optional[str] = None
    definition: Optional[dict] = None
    templateKey: Optional[str] = None
    description: Optional[str] = None
    runAs: Optional[str] = None


class DraftBody(BaseModel):
    definition: dict
    name: Optional[str] = None
    companyId: Optional[str] = None
    runAs: Optional[str] = None
    description: Optional[str] = None


class NoteBody(BaseModel):
    note: Optional[str] = ""


class StatusBody(BaseModel):
    status: str
    reason: Optional[str] = ""


class OwnerBody(BaseModel):
    owner: str


class DuplicateBody(BaseModel):
    name: Optional[str] = None
    companyId: Optional[str] = None


class TestBody(BaseModel):
    eventId: Optional[str] = None


class RunBody(BaseModel):
    subjectId: str


class UseTemplateBody(BaseModel):
    name: Optional[str] = None
    companyId: Optional[str] = None


class SaveTemplateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class EnabledBody(BaseModel):
    enabled: bool


class PauseBody(BaseModel):
    paused: bool


class DescribeBody(BaseModel):
    text: str
    entityHint: Optional[str] = ""
    companyId: Optional[str] = None


class DecideBody(BaseModel):
    option: str
    note: Optional[str] = ""


# ── catalog ──────────────────────────────────────────────────────────────────
def _seen_key(user: dict) -> str:
    return f"workflows.catalog_seen:{_me(user)}"


def _catalog_keys(cat: dict) -> list[str]:
    keys = [f"event:{e['key']}" for e in cat["events"]] + [f"action:{a['key']}" for a in cat["actions"]]
    keys += [f"source:{s['key']}" for s in cat["listSources"]]
    for e in cat["entities"]:
        keys += [f"field:{e['key']}.{f['key']}" for f in e["fields"]]
    return sorted(keys)


def _sync_db_catalog(db) -> None:
    """What only the database knows (the HR custom fields, checklist and
    letter template choices) is registered before the catalog is served."""
    catalog.load_packs()
    from workflows.packs import hr as hr_pack
    hr_pack.sync_catalog(db)


@router.get("/catalog")
def get_catalog(user: dict = Depends(R), db: Session = Depends(get_db)):
    _sync_db_catalog(db)
    cat = catalog.serialize(db, user)
    row = db.get(models.NexusSetting, _seen_key(user))
    seen: dict = {}
    if row is not None and row.value:
        try:
            seen = json.loads(row.value) or {}
        except ValueError:
            seen = {}
    known = set(seen.get("keys") or [])
    cat["lastSeen"] = seen.get("at") or ""
    cat["newSince"] = ([k.split(":", 1)[1] for k in _catalog_keys(cat) if k not in known and not k.startswith("field:")]
                       if known else [])
    return cat


@router.post("/catalog/seen")
def catalog_seen(user: dict = Depends(R), db: Session = Depends(get_db)):
    _sync_db_catalog(db)
    cat = catalog.serialize(db, user)
    row = db.get(models.NexusSetting, _seen_key(user))
    if row is None:
        row = models.NexusSetting(key=_seen_key(user))
        db.add(row)
    row.value = json.dumps({"at": _now(), "keys": _catalog_keys(cat)})
    row.updated_by, row.updated_at = _me(user), _now()
    db.commit()
    return {"ok": True, "lastSeen": _now()}


# ── runs (before /{id}) ──────────────────────────────────────────────────────
def _visible_ids(db, user: dict) -> Optional[set]:
    """None = every workflow; else the ids the caller may see."""
    if _is_ga(user) and _companies_of(db, user) is None:
        return None
    return {w.id for w in store.visible_workflows(db, user).all()}


def _action_row(db, s: models.WorkflowRunStep, run: models.WorkflowRun) -> dict:
    out = s.output if isinstance(s.output, dict) else {}
    affected = []
    for a in (s.affected if isinstance(s.affected, list) else []):
        if not isinstance(a, dict):
            continue
        link = {}
        ent = catalog.ENTITIES.get(str(a.get("entity") or ""))
        if ent is not None and a.get("id"):
            try:
                row = ent.load_row(db, str(a["id"]))
                link = ent.link_for(row, db) if row is not None else {}
            except Exception:   # noqa: BLE001
                link = {}
        affected.append({"entity": a.get("entity", ""), "id": a.get("id", ""), "label": a.get("label", ""),
                         "link": link})
    act = catalog.ACTIONS.get(s.action or "")
    return {"id": s.id, "runId": s.run_id, "workflowId": s.workflow_id, "workflowName": run.workflow_name or "",
            "stepId": s.step_id, "action": s.action or "", "actionLabel": act.label if act else (s.label or ""),
            "status": s.status, "startedAt": s.started_at or "", "finishedAt": s.finished_at or "",
            "line": s.detail or str(out.get("line") or ""), "affected": affected,
            "sent": list(out.get("sent") or []), "subjectLabel": run.subject_label or "",
            "subjectId": run.subject_id or "", "entity": run.entity or ""}


def _cursor(before: str) -> tuple[str, str]:
    """`before` is "<started_at>|<id>" (an older plain started_at still
    works: ties on that instant are then skipped)."""
    ts, _sep, rid = (before or "").partition("|")
    return ts, rid


def _before(q, started_col, id_col, before: str):
    ts, rid = _cursor(before)
    if not ts:
        return q
    if not rid:
        return q.filter(started_col < ts)
    return q.filter(or_(started_col < ts, and_(started_col == ts, id_col < rid)))


def _next(started_at: str, rid: str) -> str:
    return f"{started_at}|{rid}"


@router.get("/runs")
def list_runs(kind: str = "runs", workflow: str = "", status: str = "", before: str = "", limit: int = 50,
              user: dict = Depends(R), db: Session = Depends(get_db)):
    limit = max(1, min(int(limit or 50), 100))
    ids = _visible_ids(db, user)
    if workflow:
        if ids is not None and workflow not in ids:
            raise HTTPException(404, "Workflow not found")
        ids = {workflow}
    R_ = models.WorkflowRun
    if kind == "actions":
        S = models.WorkflowRunStep
        q = (db.query(S, R_).join(R_, R_.id == S.run_id)
             .filter(S.kind == "action", S.status.in_(["done", "failed"]), R_.status != "test"))
        if ids is not None:
            q = q.filter(S.workflow_id.in_(sorted(ids)))
        if status:
            # the screen offers the run words for both views; a done step is a succeeded one
            q = q.filter(S.status == ("done" if status == "succeeded" else status))
        q = _before(q, S.started_at, S.id, before)
        rows = q.order_by(S.started_at.desc(), S.id.desc()).limit(limit + 1).all()
        more = len(rows) > limit
        rows = rows[:limit]
        items = [_action_row(db, s, run) for s, run in rows]
        return {"items": items, "next": (_next(rows[-1][0].started_at, rows[-1][0].id) if more and rows else None)}
    q = db.query(R_)
    if ids is not None:
        q = q.filter(R_.workflow_id.in_(sorted(ids)))
    if status:
        q = q.filter(R_.status == status)
    else:
        q = q.filter(R_.status != "test")
    q = _before(q, R_.started_at, R_.id, before)
    rows = q.order_by(R_.started_at.desc(), R_.id.desc()).limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": [store.serialize_run(db, r) for r in rows],
            "next": (_next(rows[-1].started_at, rows[-1].id) if more and rows else None)}


def _run_or_404(db, user: dict, rid: str) -> models.WorkflowRun:
    run = db.get(models.WorkflowRun, rid)
    if run is None:
        raise HTTPException(404, "Run not found")
    wf = db.get(models.Workflow, run.workflow_id)
    if wf is None or not store.can_see(db, user, wf):
        raise HTTPException(404, "Run not found")
    return run


@router.get("/runs/{rid}")
def get_run(rid: str, user: dict = Depends(R), db: Session = Depends(get_db)):
    return store.serialize_run(db, _run_or_404(db, user, rid), steps=True)


@router.post("/runs/{rid}/replay")
def replay_run(rid: str, user: dict = Depends(E), db: Session = Depends(get_db)):
    run = _run_or_404(db, user, rid)
    _editable(db, user, db.get(models.Workflow, run.workflow_id))
    try:
        new = engine.replay(db, run, _me(user))
    except ValueError as e:
        raise HTTPException(409, str(e))
    return store.serialize_run(db, new, steps=True)


@router.post("/runs/{rid}/cancel")
def cancel_run(rid: str, user: dict = Depends(E), db: Session = Depends(get_db)):
    run = _run_or_404(db, user, rid)
    _editable(db, user, db.get(models.Workflow, run.workflow_id))
    try:
        engine.cancel(db, run, _me(user))
    except ValueError as e:
        raise HTTPException(409, str(e))
    return store.serialize_run(db, run, steps=True)


# ── overview ─────────────────────────────────────────────────────────────────
@router.get("/overview")
def overview(user: dict = Depends(R), db: Session = Depends(get_db)):
    wfs = store.visible_workflows(db, user).filter(models.Workflow.status != "archived").all()
    ids = [w.id for w in wfs]
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    R_ = models.WorkflowRun
    recent = (db.query(R_).filter(R_.workflow_id.in_(ids), R_.status != "test")
              .order_by(R_.started_at.desc()).limit(10).all()) if ids else []
    day = (db.query(R_).filter(R_.workflow_id.in_(ids), R_.started_at >= since, R_.status != "test").all()) if ids else []
    attention = []
    for w in wfs:
        if w.status == "needs_attention":
            attention.append({"id": w.id, "name": w.name, "reason": w.paused_reason or "Needs attention",
                              "since": w.paused_at or w.updated_at or ""})
    failed_ids = {r.workflow_id for r in day if r.status == "failed"}
    for w in wfs:
        if w.id in failed_ids and w.status != "needs_attention":
            n = sum(1 for r in day if r.workflow_id == w.id and r.status == "failed")
            attention.append({"id": w.id, "name": w.name, "reason": f"{n} failed run" + ("" if n == 1 else "s") + " in the last 24 hours",
                              "since": max((r.finished_at or r.started_at) for r in day if r.workflow_id == w.id and r.status == "failed")})
    cfg = wf_settings.get(db)
    return {
        "needsAttention": attention,
        "last24h": {"runs": len(day), "succeeded": sum(1 for r in day if r.status == "succeeded"),
                    "failed": sum(1 for r in day if r.status == "failed"),
                    "waiting": sum(1 for r in day if r.status == "waiting")},
        "recent": [store.serialize_run(db, r) for r in recent],
        "pausedAll": {"paused": bool(cfg.get("pausedAll")), "by": cfg.get("pausedBy") or "", "at": cfg.get("pausedAt") or ""},
        "counts": {"active": sum(1 for w in wfs if w.status == "active"),
                   "paused": sum(1 for w in wfs if w.status in ("paused", "needs_attention")),
                   "draft": sum(1 for w in wfs if w.status == "draft")},
    }


# ── templates ────────────────────────────────────────────────────────────────
@router.get("/templates")
def list_templates(user: dict = Depends(R), db: Session = Depends(get_db)):
    scope = _companies_of(db, user)
    rows = templates.visible(db, user, None if scope is None else sorted(scope))
    return [templates.serialize(t) for t in rows]


@router.post("/templates/{key}/use", status_code=201)
def use_template(key: str, body: UseTemplateBody, user: dict = Depends(E), db: Session = Depends(get_db)):
    scope = _companies_of(db, user)
    t = templates.find(db, key, user, None if scope is None else sorted(scope))
    if t is None:
        raise HTTPException(404, "Template not found")
    company = _company_for_new(db, user, body.companyId)
    wf = store.create(db, name=body.name or t["name"], owner=_me(user), company_id=company,
                      definition=t["definition"], by=_me(user), description=t.get("description") or "")
    db.commit()
    out = store.serialize(db, wf, full=True)
    out["blanks"] = list(t.get("blanks") or [])
    out["templateKey"] = key
    return out


# ── automations ──────────────────────────────────────────────────────────────
@router.get("/automations")
def list_automations(user: dict = Depends(R), db: Session = Depends(get_db)):
    return automations.register(db, user)


@router.post("/automations/task-rules/{rule_id}/enabled")
def task_rule_enabled(rule_id: str, body: EnabledBody, user: dict = Depends(R), db: Session = Depends(get_db)):
    return automations.set_task_rule_enabled(db, user, rule_id, body.enabled)


# ── settings ─────────────────────────────────────────────────────────────────
def _settings_company(db, user: dict, company: str) -> str:
    cid = (company or "").strip()
    if cid:
        scope = _companies_of(db, user)
        if scope is not None and cid not in scope:
            raise HTTPException(404, "Company not found")
        if db.get(models.HrEntity, cid) is None:
            raise HTTPException(404, "Company not found")
    return cid


@router.get("/settings")
def get_settings(company: str = "", user: dict = Depends(F), db: Session = Depends(get_db)):
    cid = _settings_company(db, user, company)
    out = wf_settings.public(db, cid)
    out["companies"] = _company_rows(db, user)
    out["company"] = cid
    return out


@router.put("/settings")
def put_settings(body: dict, company: str = "", user: dict = Depends(F), db: Session = Depends(get_db)):
    cid = _settings_company(db, user, company)
    if not cid and not _is_ga(user):
        raise HTTPException(403, "Only a Global Admin changes the organization's Workflows settings")
    body = body if isinstance(body, dict) else {}
    if cid and body.get("override") is False:
        wf_settings.reset(db, cid)
    elif cid:
        wf_settings.save(db, cid, body, _me(user))
    else:
        secrets = body.get("webhookSecrets") if isinstance(body.get("webhookSecrets"), dict) else None
        wf_settings.save(db, "", body, _me(user), secrets=secrets)
    db.add(models.AuditLog(timestamp=_now(), user_email=_me(user), action="workflows.settings",
                           resource_type="workflows", resource_id=cid or "org",
                           details=json.dumps({k: v for k, v in body.items() if k != "webhookSecrets"}, default=str),
                           module="workflows", kind="update"))
    db.commit()
    out = wf_settings.public(db, cid)
    out["companies"] = _company_rows(db, user)
    out["company"] = cid
    return out


@router.post("/settings/pause-all")
def pause_all(body: PauseBody, user: dict = Depends(GA), db: Session = Depends(get_db)):
    cfg = wf_settings.pause_all(db, body.paused, _me(user))
    db.add(models.AuditLog(timestamp=_now(), user_email=_me(user),
                           action="workflows.pause_all" if body.paused else "workflows.resume_all",
                           resource_type="workflows", resource_id="org", details="{}", module="workflows", kind="update"))
    db.commit()
    return {"pausedAll": bool(cfg.get("pausedAll")), "pausedBy": cfg.get("pausedBy") or "",
            "pausedAt": cfg.get("pausedAt") or ""}


# ── describe it ──────────────────────────────────────────────────────────────
@router.post("/describe")
def describe_it(body: DescribeBody, user: dict = Depends(E), db: Session = Depends(get_db)):
    if not describe.configured():
        raise HTTPException(503, "Describe It is off: no ANTHROPIC_API_KEY is set")
    company = _company_for_new(db, user, body.companyId)
    try:
        return describe.draft(db, user, body.text, entity_hint=body.entityHint or "", company_id=company)
    except describe.NotConfigured:
        raise HTTPException(503, "Describe It is off: no ANTHROPIC_API_KEY is set")
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:   # noqa: BLE001 - the model's failure is a readable 502, never a 500
        raise HTTPException(502, f"The draft could not be made: {str(e)[:200]}")


# ── approvals ────────────────────────────────────────────────────────────────
@router.post("/approvals/{aid}/decide")
def decide_approval(aid: str, body: DecideBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    ap = db.get(models.WorkflowApproval, aid)
    if ap is None:
        raise HTTPException(404, "Approval not found")
    try:
        return approvals.decide(db, ap, user, body.option, body.note or "")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── workflows ────────────────────────────────────────────────────────────────
@router.get("")
def list_workflows(scope: str = "company", status: str = "", q: str = "", user: dict = Depends(R),
                   db: Session = Depends(get_db)):
    import auth
    query = store.visible_workflows(db, user)
    if status:
        query = query.filter(models.Workflow.status == status)
    else:
        query = query.filter(models.Workflow.status != "archived")
    rows = query.order_by(models.Workflow.updated_at.desc()).all()
    me = _me(user)
    if scope == "mine":
        rows = [w for w in rows if (w.owner_email or "").lower() == me]
    elif scope == "company":
        own = auth.company_of(user, db)
        companies = _companies_of(db, user)
        mine = {own} if own else set()
        if companies is not None:
            mine |= set(companies)
        if mine:
            rows = [w for w in rows if not w.company_id or w.company_id in mine]
    if q:
        needle = q.strip().lower()
        rows = [w for w in rows if needle in (w.name or "").lower() or needle in (w.description or "").lower()
                or needle in (w.owner_email or "").lower()]
    return [store.serialize(db, w) for w in rows]


@router.post("", status_code=201)
def create_workflow(body: CreateBody, user: dict = Depends(E), db: Session = Depends(get_db)):
    company = _company_for_new(db, user, body.companyId)
    run_as = _run_as_for(db, user, body.runAs)
    definition = body.definition
    description = body.description or ""
    if body.templateKey:
        scope = _companies_of(db, user)
        t = templates.find(db, body.templateKey, user, None if scope is None else sorted(scope))
        if t is None:
            raise HTTPException(404, "Template not found")
        definition = t["definition"]
        description = description or t.get("description") or ""
    wf = store.create(db, name=body.name or "Untitled Workflow", owner=_me(user), company_id=company,
                      definition=definition, by=_me(user), run_as=run_as, description=description)
    db.commit()
    return store.serialize(db, wf, full=True)


@router.get("/{wid}")
def get_workflow(wid: str, user: dict = Depends(R), db: Session = Depends(get_db)):
    return store.serialize(db, _wf_or_404(db, user, wid), full=True)


@router.put("/{wid}/draft")
def save_draft(wid: str, body: DraftBody, user: dict = Depends(E), db: Session = Depends(get_db)):
    wf = _editable(db, user, _wf_or_404(db, user, wid))
    if wf.status == "archived":
        raise HTTPException(409, "An archived workflow cannot be edited")
    if body.name is not None:
        wf.name = body.name.strip()[:200] or wf.name
    if body.description is not None:
        wf.description = body.description.strip()[:1000]
    if body.companyId is not None and (body.companyId or "") != (wf.company_id or ""):
        if body.companyId == "" and not _is_ga(user):
            raise HTTPException(403, "Only a Global Admin may run a workflow for every company")
        wf.company_id = _company_for_new(db, user, body.companyId) if body.companyId else ""
    if body.runAs is not None:
        wf.run_as = _run_as_for(db, user, body.runAs, wf.run_as or "owner")
    store.save_draft(db, wf, body.definition, _me(user))
    db.commit()
    return store.serialize(db, wf, full=True)


@router.post("/{wid}/publish")
def publish_workflow(wid: str, body: Optional[NoteBody] = None, user: dict = Depends(E), db: Session = Depends(get_db)):
    wf = _editable(db, user, _wf_or_404(db, user, wid))
    try:
        store.publish(db, wf, _me(user), note=(body.note if body else "") or "")
    except store.ValidationError as e:
        db.rollback()
        _problem_422(e)
    except store.NotTested as e:
        db.rollback()
        raise HTTPException(422, str(e))
    db.commit()
    return store.serialize(db, wf, full=True)


@router.post("/{wid}/status")
def set_workflow_status(wid: str, body: StatusBody, user: dict = Depends(E), db: Session = Depends(get_db)):
    wf = _editable(db, user, _wf_or_404(db, user, wid))
    if body.status not in ("active", "paused", "archived"):
        raise HTTPException(422, "status is active, paused or archived")
    if body.status == "active" and wf.status == "needs_attention":
        reason = engine.check_health(db, wf)
        if reason:
            raise HTTPException(409, reason)
    try:
        store.set_status(db, wf, body.status, _me(user), body.reason or "")
    except ValueError as e:
        raise HTTPException(409, str(e))
    db.commit()
    return store.serialize(db, wf, full=True)


@router.post("/{wid}/reown")
def reown_workflow(wid: str, body: OwnerBody, user: dict = Depends(F), db: Session = Depends(get_db)):
    wf = _editable(db, user, _wf_or_404(db, user, wid))
    from task_automation import _person_user
    new_owner = (body.owner or "").strip().lower()
    if _person_user(db, new_owner) is None:
        raise HTTPException(422, "The new owner must be a current directory person")
    problems = store.reown(db, wf, new_owner, _me(user))
    db.commit()
    out = store.serialize(db, wf, full=True)
    out["problems"] = [p.to_dict() for p in problems]
    return out


@router.post("/{wid}/duplicate", status_code=201)
def duplicate_workflow(wid: str, body: Optional[DuplicateBody] = None, user: dict = Depends(E),
                       db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)
    body = body or DuplicateBody()
    company = _company_for_new(db, user, body.companyId if body.companyId is not None else wf.company_id)
    copy = store.duplicate(db, wf, _me(user), company_id=company, name=body.name)
    db.commit()
    return store.serialize(db, copy, full=True)


# ── versions ─────────────────────────────────────────────────────────────────
@router.get("/{wid}/versions")
def list_versions(wid: str, user: dict = Depends(R), db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)
    return [store.serialize_version(db, v) for v in store.versions(db, wf)]


@router.get("/{wid}/versions/{v}")
def get_version(wid: str, v: int, user: dict = Depends(R), db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)
    row = store.version(db, wf, v)
    if row is None:
        raise HTTPException(404, "Version not found")
    return store.serialize_version(db, row, definition=True)


@router.post("/{wid}/versions/{v}/restore")
def restore_version(wid: str, v: int, user: dict = Depends(E), db: Session = Depends(get_db)):
    wf = _editable(db, user, _wf_or_404(db, user, wid))
    try:
        store.restore(db, wf, v, _me(user))
    except store.ValidationError as e:
        db.rollback()
        _problem_422(e)
    except ValueError as e:
        db.rollback()
        raise HTTPException(404, str(e))
    db.commit()
    return store.serialize(db, wf, full=True)


@router.get("/{wid}/diff")
def diff_versions(wid: str, a: int = 0, b: int = 0, user: dict = Depends(R), db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)

    def _def(v: int) -> dict:
        if v <= 0:
            return store.draft_of(wf)
        row = store.version(db, wf, v)
        if row is None:
            raise HTTPException(404, f"Version {v} not found")
        return store.normalize_definition(row.definition)
    return {"lines": store.diff(_def(a), _def(b))}


# ── testing ──────────────────────────────────────────────────────────────────
@router.get("/{wid}/recent-events")
def recent_events(wid: str, user: dict = Depends(R), db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)
    trig = store.draft_of(wf).get("trigger") or {}
    if trig.get("kind") != "event" or not trig.get("event"):
        return []
    E_ = models.WorkflowEvent
    q = db.query(E_).filter(E_.key == str(trig["event"]))
    scope = _companies_of(db, user)
    if wf.company_id:
        q = q.filter(E_.company_id == wf.company_id)
    elif scope is not None:
        q = q.filter(E_.company_id.in_(sorted(scope)))
    rows = q.order_by(E_.at.desc()).limit(50).all()
    return [{"id": r.id, "at": r.at, "subjectLabel": str((r.payload or {}).get("subjectLabel") or r.subject_id or ""),
             "actor": r.actor or "", "key": r.key} for r in rows]


def _test_out(db, run: models.WorkflowRun, wf: models.Workflow) -> dict:
    out = store.serialize_run(db, run, steps=True)
    return {"runId": run.id, "status": run.status, "summary": run.summary or "", "subjectLabel": run.subject_label or "",
            "trace": out.get("trace", []), "conditionsPassed": out.get("conditionsPassed", True),
            "steps": [{"stepId": s["stepId"], "kind": s["kind"], "action": s["action"], "label": s["label"],
                       "status": s["status"], "detail": s["detail"]} for s in out.get("steps", [])],
            "testedAt": wf.last_tested_at or "", "testedCurrent": store.tested_current(wf)}


@router.post("/{wid}/test")
def test_workflow(wid: str, body: Optional[TestBody] = None, user: dict = Depends(E), db: Session = Depends(get_db)):
    wf = _editable(db, user, _wf_or_404(db, user, wid))
    problems = store.problems_for(db, wf)
    if problems:
        raise HTTPException(422, {"problems": [p.to_dict() for p in problems]})
    ev = None
    if body and body.eventId:
        ev = db.get(models.WorkflowEvent, body.eventId)
        trig = store.draft_of(wf).get("trigger") or {}
        if ev is None or ev.key != trig.get("event"):
            raise HTTPException(404, "Event not found")
        scope = _companies_of(db, user)
        if (wf.company_id and ev.company_id != wf.company_id) or (scope is not None and ev.company_id not in scope):
            raise HTTPException(404, "Event not found")
    try:
        run = engine.test_run(db, wf, event=ev, by=_me(user))
    except Exception as e:   # noqa: BLE001 - a test that cannot run says why, never 500s
        db.rollback()
        raise HTTPException(422, f"The test could not run: {type(e).__name__}: {str(e)[:200]}")
    return _test_out(db, run, wf)


@router.post("/{wid}/preview-schedule")
def preview_schedule(wid: str, user: dict = Depends(R), db: Session = Depends(get_db)):
    """"If this ran now": the companies a schedule would tick for, and for
    a definition whose first step loops over a list, that list's items."""
    wf = _wf_or_404(db, user, wid)
    definition = store.draft_of(wf)
    trig = definition.get("trigger") or {}
    if trig.get("kind") != "schedule":
        raise HTTPException(422, "Only a schedule can be previewed")
    companies = scheduler.companies_for(db, wf)
    items: list[dict] = []
    ent_key = str(trig.get("entity") or "")
    ent = catalog.ENTITIES.get(ent_key) if ent_key and ent_key != "company" else None
    if ent is not None and ent.model is not None:
        for row in db.query(ent.model).limit(500).all():
            if ent.company_of(row) in companies:
                items.append({"label": ent.label_for(row), "link": ent.link_for(row, db)})
    else:
        loop = next((s for s in definition.get("steps") or [] if isinstance(s, dict) and s.get("kind") == "for_each"), None)
        if loop is not None:
            src = loop.get("source") or {}
            ls = catalog.LIST_SOURCES.get(str(src.get("key") if isinstance(src, dict) else src or ""))
            if ls is not None:
                inner = catalog.ENTITIES.get(ls.entity)
                for cid in companies:
                    company = db.get(models.HrEntity, cid)
                    ctx = engine.build_context(db, wf, definition=definition, entity=catalog.ENTITIES.get("company"),
                                               subject=company, plan_only=True, company_id=cid)
                    try:
                        rows = list(ls.fn(db, ctx, dict((src.get("params") or {}) if isinstance(src, dict) else {})) or [])
                    except Exception as e:   # noqa: BLE001
                        raise HTTPException(422, f"The list could not be read: {str(e)[:160]}")
                    for row in rows[:500]:
                        if isinstance(row, dict):
                            items.append({"label": str(row.get("label") or row.get("name") or row.get("title") or row.get("id") or ""), "link": row.get("link") or {}})
                        elif inner is not None:
                            items.append({"label": inner.label_for(row), "link": inner.link_for(row, db)})
        if not items and loop is None:
            for cid in companies:
                company = db.get(models.HrEntity, cid)
                if company is not None:
                    items.append({"label": company.name or cid, "link": {"view": "admin", "sub": f"companies@{cid}"}})
    return {"count": len(items), "items": items[:200], "companies": len(companies)}


@router.post("/{wid}/run")
def run_workflow(wid: str, body: RunBody, user: dict = Depends(E), db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)
    if wf.status != "active":
        raise HTTPException(409, "Publish and switch the workflow on before running it")
    trig = store.definition_of(wf).get("trigger") or {}
    if trig.get("kind") != "manual":
        raise HTTPException(409, "Only a workflow with a manual trigger can be run by hand")
    ent = catalog.ENTITIES.get(str(trig.get("entity") or ""))
    if ent is None:
        raise HTTPException(422, "The trigger names no record kind")
    row = ent.load_row(db, body.subjectId.strip())
    if row is None or not ent.can_see(db, user, row):
        raise HTTPException(404, "Record not found")
    scope = _companies_of(db, user)
    cid = ent.company_of(row)
    if (wf.company_id and cid != wf.company_id) or (scope is not None and cid and cid not in scope):
        raise HTTPException(404, "Record not found")
    run = engine.run_for(db, wf, trigger_kind="manual", entity=ent, subject=row, started_by=_me(user),
                         payload={"subject": payload_for(ent, row), "subjectLabel": ent.label_for(row), "changes": {},
                                  "extra": {"trigger": "manual"}, "actor": _me(user)})
    if run is None:
        raise HTTPException(409, "The run did not start: the conditions did not match or the record may not enroll")
    out = store.serialize_run(db, run)
    return out


@router.post("/{wid}/save-as-template", status_code=201)
def save_as_template(wid: str, body: Optional[SaveTemplateBody] = None, user: dict = Depends(F),
                     db: Session = Depends(get_db)):
    wf = _wf_or_404(db, user, wid)
    if not wf.company_id and not _is_ga(user):
        raise HTTPException(403, "Only a Global Admin saves a template for every company")
    body = body or SaveTemplateBody()
    entry = templates.save_as_template(db, wf, user, name=body.name or "", description=body.description or "")
    db.commit()
    return templates.serialize(entry)


__all__: list[Any] = ["router"]
