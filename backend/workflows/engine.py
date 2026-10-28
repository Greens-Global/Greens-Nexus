"""The engine (spec 6.2 - 6.6): which workflows an event matches, whether
a subject may enroll, the run and its steps, waits and approvals, retries,
caps and the plan-mode dry run.

A run is a WorkflowRun row plus one WorkflowRunStep per step it reached
(keyed by `(run_id, step_id)` - a step inside a For Each carries the item
index in its id, a fault step the `fault/` prefix). `execute` walks the
definition from the top every time and skips the steps whose row is
already done, so a tick that dies half-way, a wait that resumes or a
retry simply walks again and never does a finished step twice. Every step
commits on its own; an action that sends to several people records each
one in `ctx.step_output` and the engine keeps that dict on the row, so a
retry after a failure half-way (Review Focus 2) sends only to the rest.

`CURRENT_RUN` is set for the whole walk: every event a step causes carries
`caused_by_run` and the run's depth + 1, and `match` ignores those unless
the workflow allows downstream runs (depth 1 only - a chain never exceeds
depth 2).

Nothing runs blind: a miss on the conditions is a `skipped` run only when
`logSkips` is on, a refused action is a failed step with the reason, a
failed run bells its owner after its fault steps ran.
"""
from __future__ import annotations

import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.exc import OperationalError

import models
from workflows import catalog, conditions, recipients, store
from workflows import settings as wf_settings
from workflows.context import MISSING, RunContext, link_url, render, us_datetime
from workflows.emit import CURRENT_RUN, MAX_DEPTH, payload_for
from workflows.errors import StepRefused, TransientError

MAX_ATTEMPTS = 3
BACKOFF_MINUTES = (1, 5, 15)
MAX_ITEMS = 500
PLAN_ITEMS = 5
NEXUS_ACTOR = "workflows@nexus"
RUN_ACTIVE_SECONDS = 600


def _transient_types() -> tuple:
    types: list = [TransientError, OperationalError]
    try:
        import httpx
        types.append(httpx.TransportError)
    except ImportError:   # pragma: no cover
        pass
    try:
        import graph_mail
        types.append(graph_mail.GraphMailError)
    except ImportError:   # pragma: no cover
        pass
    return tuple(types)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or _now()).isoformat()


# ── company time ─────────────────────────────────────────────────────────────
def company_zone(db, company_id: str) -> str:
    """The company's clock: its Shifts timeZone (spec 6.3)."""
    try:
        from routers.shift_requests import get_settings
        return str(get_settings(db, company_id or "").get("timeZone") or "America/Los_Angeles")
    except Exception:   # noqa: BLE001 - no zone setting reads as the default
        return "America/Los_Angeles"


def now_in(zone: str, now_utc: Optional[datetime] = None) -> datetime:
    from zoneinfo import ZoneInfo
    now_utc = now_utc or _now()
    try:
        return now_utc.astimezone(ZoneInfo(zone or "America/Los_Angeles"))
    except Exception:   # noqa: BLE001 - an unknown zone reads as UTC
        return now_utc


def today_in(zone: str, now_utc: Optional[datetime] = None) -> date:
    return now_in(zone, now_utc).date()


# ── bells ────────────────────────────────────────────────────────────────────
def _bell(db, recipients_: list, key: str, title: str, line: str, *, company: str = "", action=None,
          priority: Optional[int] = None) -> None:
    import notify_rollup
    for who in dict.fromkeys(e for e in recipients_ if e):
        try:
            notify_rollup.upsert_rollup(db, recipient=who, key=key, title=title, line=line, action=action,
                                        company=company, requested_by=NEXUS_ACTOR, replace=True, priority=priority)
        except Exception as e:   # noqa: BLE001 - a bell never breaks the engine
            print(f"[workflows] bell to {who} failed: {type(e).__name__}: {str(e)[:120]}")


def owner_and_admins(db, wf: models.Workflow) -> list[str]:
    out = [(wf.owner_email or "").lower()]
    try:
        out += recipients.global_admins(db)
    except Exception:   # noqa: BLE001
        pass
    return [e for e in dict.fromkeys(out) if e]


def pause_needs_attention(db, wf: models.Workflow, reason: str) -> None:
    """The system pauses a workflow: needs_attention with the reason and a
    bell to its owner and the Global Admins (spec 6.5)."""
    if wf.status == "needs_attention" and wf.paused_reason == reason:
        return
    store.set_status(db, wf, "needs_attention", NEXUS_ACTOR, reason)
    _bell(db, owner_and_admins(db, wf), f"wf-attention:{wf.id}", f"Workflow Needs Attention: {wf.name}", reason,
          company=wf.company_id or "", action={"view": "workflows", "sub": f"wf:{wf.id}"}, priority=1)


def check_health(db, wf: models.Workflow) -> str:
    """'' when the workflow can still run, else why it must be paused: the
    owner left, lost the grant, or an action it uses is gone."""
    from workflows import validate
    if (wf.run_as or "owner") == "owner":
        owner = store.owner_user(db, wf)
        if owner is None:
            return "Paused: the owner is no longer a current person"
        if validate._owner_may_build(db, owner):
            return "Paused: the owner no longer holds the Workflows grant"
    for _path, step in _every_step(store.definition_of(wf)):
        if step.get("kind") == "action" and step.get("enabled", True) is not False:
            if str(step.get("action") or "") not in catalog.ACTIONS:
                return f"Paused: the action {step.get('action') or '(blank)'} no longer exists"
    return ""


def _every_step(definition: dict):
    def walk(steps, path):
        for i, s in enumerate(steps or []):
            if not isinstance(s, dict):
                continue
            yield f"{path}[{i}]", s
            if s.get("kind") == "if":
                yield from walk(s.get("then"), f"{path}[{i}].then")
                yield from walk(s.get("else"), f"{path}[{i}].else")
            elif s.get("kind") == "approval":
                for name, nested in (s.get("branches") or {}).items():
                    yield from walk(nested, f"{path}[{i}].{name}")
            elif s.get("kind") == "for_each":
                yield from walk(s.get("steps"), f"{path}[{i}].steps")
    yield from walk(definition.get("steps"), "steps")
    yield from walk((definition.get("settings") or {}).get("faultSteps"), "settings.faultSteps")


# ── matching and enrollment ──────────────────────────────────────────────────
def match(db, ev: models.WorkflowEvent) -> list[models.Workflow]:
    """The active workflows this event starts: trigger on its key, scope
    admitting its company (a blank company is refused unless the workflow
    is for every company AND the entity has no company at all - Review
    Focus 1), downstream rules honored."""
    ent = catalog.ENTITIES.get(ev.entity or "")
    out = []
    rows = db.query(models.Workflow).filter(models.Workflow.status == "active").all()
    for wf in rows:
        trig = wf.trigger if isinstance(wf.trigger, dict) else {}
        if trig.get("kind") != "event" or trig.get("event") != ev.key:
            continue
        if wf.company_id:
            if (ev.company_id or "") != wf.company_id:
                continue
        elif not ev.company_id and not (ent is not None and ent.company is None):
            continue
        if ev.caused_by_run:
            settings = wf.settings if isinstance(wf.settings, dict) else {}
            if not settings.get("allowDownstream"):
                continue
            if int(ev.depth or 0) >= MAX_DEPTH:
                continue
            cause = db.get(models.WorkflowRun, ev.caused_by_run)
            if cause is not None and cause.workflow_id == wf.id:
                continue   # a workflow never reacts to its own run
        out.append(wf)
    return out


def _effective_caps(db, wf: models.Workflow, company_id: str) -> tuple[int, int]:
    settings = wf.settings if isinstance(wf.settings, dict) else {}
    org = wf_settings.get(db, company_id or "")
    runs = min(int(settings.get("maxRunsPerHour") or 100), int(org.get("maxRunsPerHourCap") or 500))
    rec = min(int(settings.get("maxRecipients") or 50), int(org.get("maxRecipientsCap") or 200))
    return max(1, runs), max(1, rec)


def enroll_ok(db, wf: models.Workflow, *, entity: str = "", subject_id: str = "", company_id: str = "",
              person: str = "", now: Optional[datetime] = None) -> tuple[bool, str]:
    """Whether a run may START for this subject: the global and company
    switches, the suppress lists, once per subject, the cooldown and the
    hourly cap (which pauses the workflow when hit)."""
    now = now or _now()
    org = wf_settings.get(db)
    if org.get("pausedAll"):
        return False, "Workflows are paused for every company"
    if not wf_settings.get(db, company_id or wf.company_id or "").get("enabled", True):
        return False, "Workflows are switched off for this company"
    settings = wf.settings if isinstance(wf.settings, dict) else {}
    sup = settings.get("suppress") or {}
    if company_id and company_id in [str(c) for c in (sup.get("companies") or [])]:
        return False, "Suppressed: this company is never acted on"
    if person and person.lower() in [str(p).lower() for p in (sup.get("people") or [])]:
        return False, "Suppressed: this person is never acted on"
    if entity and subject_id:
        mark = db.get(models.WorkflowSubjectMark, (wf.id, entity, subject_id))
        if mark is not None:
            if settings.get("oncePerSubject"):
                return False, "Already ran once for this record"
            hours = float(settings.get("cooldownHours") or 0)
            if hours > 0 and mark.last_run_at:
                try:
                    last = datetime.fromisoformat(mark.last_run_at.replace("Z", "+00:00"))
                    if now - last < timedelta(hours=hours):
                        return False, f"Cooldown: ran for this record within {hours:g} hours"
                except ValueError:
                    pass
    cap, _ = _effective_caps(db, wf, company_id)
    since = (now - timedelta(hours=1)).isoformat()
    n = (db.query(models.WorkflowRun)
         .filter(models.WorkflowRun.workflow_id == wf.id, models.WorkflowRun.started_at >= since,
                 models.WorkflowRun.status != "test").count())
    if n >= cap:
        pause_needs_attention(db, wf, f"Paused: ran {n} times in an hour (the cap is {cap})")
        db.commit()
        return False, f"Hourly cap of {cap} runs reached"
    return True, ""


def mark_subject(db, wf: models.Workflow, entity: str, subject_id: str) -> None:
    if not entity or not subject_id:
        return
    mark = db.get(models.WorkflowSubjectMark, (wf.id, entity, subject_id))
    if mark is None:
        db.add(models.WorkflowSubjectMark(workflow_id=wf.id, entity=entity, subject_id=subject_id, last_run_at=_iso()))
    else:
        mark.last_run_at = _iso()


# ── context ──────────────────────────────────────────────────────────────────
def build_context(db, wf: models.Workflow, *, definition: dict, event=None, entity=None, subject=None,
                  payload=None, run=None, plan_only: bool = False, actor: str = "", company_id: str = "",
                  now: Optional[datetime] = None) -> RunContext:
    ent = entity
    if ent is None and event is not None:
        ent = catalog.ENTITIES.get(event.entity or "")
    if subject is None and event is not None and ent is not None and event.subject_id:
        try:
            subject = ent.load_row(db, event.subject_id)
        except Exception:   # noqa: BLE001 - a row that cannot be read leaves the payload to speak
            subject = None
    if payload is None:
        payload = dict(event.payload or {}) if event is not None else {"subject": {}, "changes": {}, "extra": {}, "actor": ""}
    company = company_id or (event.company_id if event is not None else "") or (ent.company_of(subject) if ent and subject is not None else "") or (wf.company_id or "")
    zone = company_zone(db, company)
    return RunContext(db=db, workflow=wf, definition=definition, run=run, entity=ent, subject=subject,
                      payload=payload, event=event, actor=actor or str(payload.get("actor") or ""),
                      run_as=store.run_as_user(db, wf), today=today_in(zone, now), zone=zone,
                      company_id=company, plan_only=plan_only)


def evaluate_entry(ctx: RunContext, definition: dict) -> tuple[bool, list]:
    """Trigger filters (one AND group) then the conditions (groups OR)."""
    trig = definition.get("trigger") or {}
    filters = trig.get("filters") or []
    passed, trace = True, []
    if filters:
        ok, t = conditions.evaluate([filters], ctx)
        trace += [{**r, "group": "filter"} for r in t]
        passed = passed and ok
    if definition.get("conditions"):
        ok, t = conditions.evaluate(definition.get("conditions"), ctx)
        trace += t
        passed = passed and ok
    return passed, trace


# ── runs ─────────────────────────────────────────────────────────────────────
def start(db, wf: models.Workflow, *, ctx: RunContext, trigger_kind: str, event=None, started_by: str = "",
          plan_only: bool = False, replay_of: str = "", dedupe_key: str = "", depth: int = 0,
          trace: Optional[list] = None, passed: bool = True, status: str = "") -> models.WorkflowRun:
    """Write the run row (status running, or `test` in plan mode) and its
    conditions row (the trace the drawer shows)."""
    run = models.WorkflowRun(
        id=str(uuid.uuid4()), workflow_id=wf.id, workflow_name=wf.name or "", version=int(wf.version or 0),
        event_id=getattr(event, "id", "") or "", trigger_kind=trigger_kind,
        entity=ctx.entity.key if ctx.entity else "", subject_id=ctx.subject_id(), subject_label=ctx.subject_label(),
        company_id=ctx.company(), status=status or ("test" if plan_only else "running"), started_at=_iso(),
        summary="", error="", dedupe_key=dedupe_key or "", replay_of=replay_of or "",
        started_by=(started_by or "").lower(), depth=int(depth or 0))
    db.add(run)
    ctx.run = run
    if trace is not None:
        db.add(models.WorkflowRunStep(id=str(uuid.uuid4()), run_id=run.id, workflow_id=wf.id, step_id="conditions",
                                      kind="conditions", label="Only If", status="done", started_at=run.started_at,
                                      finished_at=run.started_at, input={}, output={"trace": trace, "passed": passed},
                                      detail="Conditions passed" if passed else "Conditions did not match"))
    db.commit()
    return run


def _skipped_run(db, wf, ctx, *, trigger_kind, event, reason, trace=None) -> models.WorkflowRun:
    run = start(db, wf, ctx=ctx, trigger_kind=trigger_kind, event=event, trace=trace, passed=False, status="skipped")
    run.summary = reason
    run.finished_at = _iso()
    db.commit()
    return run


def handle_event(db, ev: models.WorkflowEvent) -> list[models.WorkflowRun]:
    """One outbox row -> the runs it starts (and executes)."""
    runs: list[models.WorkflowRun] = []
    for wf in match(db, ev):
        definition = store.definition_of(wf)
        settings = definition.get("settings") or {}
        ctx = build_context(db, wf, definition=definition, event=ev)
        person = ""
        if ctx.entity is not None and "self" in ctx.entity.people and ctx.subject is not None:
            try:
                person = (ctx.entity.people["self"](db, ctx.subject) or [""])[0]
            except Exception:   # noqa: BLE001
                person = ""
        ok, reason = enroll_ok(db, wf, entity=ev.entity, subject_id=ev.subject_id, company_id=ctx.company(),
                               person=person)
        if not ok:
            if settings.get("logSkips"):
                runs.append(_skipped_run(db, wf, ctx, trigger_kind="event", event=ev, reason=reason))
            continue
        passed, trace = evaluate_entry(ctx, definition)
        if not passed:
            if settings.get("logSkips"):
                runs.append(_skipped_run(db, wf, ctx, trigger_kind="event", event=ev,
                                         reason="Conditions did not match", trace=trace))
            continue
        run = start(db, wf, ctx=ctx, trigger_kind="event", event=ev, trace=trace, passed=True,
                    depth=int(ev.depth or 0))
        runs.append(execute(db, run, definition=definition, ctx=ctx))
    return runs


def run_for(db, wf: models.Workflow, *, trigger_kind: str, entity=None, subject=None, started_by: str = "",
            dedupe_key: str = "", payload=None, check_enrollment: bool = True) -> Optional[models.WorkflowRun]:
    """A schedule tick, a date trigger or a manual run on `subject`."""
    definition = store.definition_of(wf)
    settings = definition.get("settings") or {}
    ent = entity if entity is not None else (catalog.ENTITIES.get("company") if trigger_kind == "schedule" else None)
    if payload is None and ent is not None and subject is not None:
        payload = {"subject": payload_for(ent, subject), "subjectLabel": ent.label_for(subject), "changes": {},
                   "extra": {"trigger": trigger_kind}, "actor": started_by or ""}
    ctx = build_context(db, wf, definition=definition, entity=ent, subject=subject, payload=payload,
                        actor=started_by or "")
    subject_id = ctx.subject_id()
    if check_enrollment:
        ok, reason = enroll_ok(db, wf, entity=ent.key if ent else "", subject_id=subject_id, company_id=ctx.company())
        if not ok:
            if settings.get("logSkips"):
                return _skipped_run(db, wf, ctx, trigger_kind=trigger_kind, event=None, reason=reason)
            return None
    passed, trace = evaluate_entry(ctx, definition)
    if not passed:
        if settings.get("logSkips"):
            return _skipped_run(db, wf, ctx, trigger_kind=trigger_kind, event=None, reason="Conditions did not match",
                                trace=trace)
        return None
    run = start(db, wf, ctx=ctx, trigger_kind=trigger_kind, trace=trace, passed=True, started_by=started_by,
                dedupe_key=dedupe_key)
    return execute(db, run, definition=definition, ctx=ctx)


# ── the walk ─────────────────────────────────────────────────────────────────
class _Walk:
    def __init__(self, db, run: models.WorkflowRun, wf: models.Workflow, definition: dict, ctx: RunContext,
                 budget_seconds: float):
        self.db, self.run, self.wf, self.definition, self.ctx = db, run, wf, definition, ctx
        self.deadline = time.monotonic() + float(budget_seconds)
        self.rows: dict[str, models.WorkflowRunStep] = {
            r.step_id: r for r in db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == run.id).all()
            if r.kind != "conditions"}
        self.last_line = ""
        self.failed_detail = ""
        self.on_error = str((definition.get("settings") or {}).get("onError") or "stop")
        self.lines = 0

    # ── rows ──
    def row(self, sid: str, step: dict, label: str = "") -> models.WorkflowRunStep:
        r = self.rows.get(sid)
        if r is None:
            r = models.WorkflowRunStep(id=str(uuid.uuid4()), run_id=self.run.id, workflow_id=self.wf.id, step_id=sid,
                                       kind=str(step.get("kind") or ""), action=str(step.get("action") or ""),
                                       label=label or store._step_label(step), status="planned", started_at=_iso(),
                                       input={}, output={}, detail="", affected=[], attempt=0)
            self.db.add(r)
            self.rows[sid] = r
        return r

    def finish_row(self, r: models.WorkflowRunStep, status: str, detail: str = "") -> None:
        r.status = status
        r.detail = (detail or "")[:1000]
        r.finished_at = _iso()
        self.db.commit()

    def over_budget(self) -> bool:
        return time.monotonic() > self.deadline

    # ── steps ──
    def steps(self, steps, prefix: str, ctx: RunContext) -> str:
        for step in steps or []:
            if not isinstance(step, dict):
                continue
            sid = f"{prefix}{step.get('id') or uuid.uuid4()}"
            kind = str(step.get("kind") or "")
            if step.get("enabled", True) is False:
                r = self.row(sid, step)
                if r.status == "planned":
                    self.finish_row(r, "skipped", "Skipped: this step is switched off")
                continue
            r = self.rows.get(sid)
            finished = ("done", "skipped", "planned") if ctx.plan_only else ("done", "skipped")
            if r is not None and r.status in finished:
                res = self.descend(step, sid, r, ctx)
                if res != "done":
                    return res
                continue
            if r is not None and r.status == "waiting":
                return "waiting"
            if r is not None and r.status == "failed":
                if self.on_error == "continue":
                    continue
                return "failed"
            if self.over_budget():
                return "budget"
            res = self.do(step, sid, r, ctx)
            if res != "done":
                return res
        return "done"

    def descend(self, step: dict, sid: str, r: models.WorkflowRunStep, ctx: RunContext) -> str:
        """A finished step whose branches may still have work."""
        kind = step.get("kind")
        out = r.output if isinstance(r.output, dict) else {}
        if kind == "if":
            branch = out.get("branch") or "else"
            return self.steps(step.get(branch) or [], f"{sid}/", ctx)
        if kind == "approval" and r.status == "done":
            outcome = str(out.get("outcome") or "")
            return self.steps((step.get("branches") or {}).get(outcome) or [], f"{sid}/{outcome}/", ctx)
        if kind == "for_each" and r.status == "done":
            return self.each(step, sid, out.get("items") or [], ctx)
        return "done"

    def do(self, step: dict, sid: str, r: Optional[models.WorkflowRunStep], ctx: RunContext) -> str:
        kind = str(step.get("kind") or "")
        if kind == "action":
            return self.action(step, sid, ctx)
        if kind == "if":
            return self.branch(step, sid, ctx)
        if kind == "approval":
            return self.approval(step, sid, ctx)
        if kind == "wait":
            return self.wait(step, sid, ctx)
        if kind == "for_each":
            return self.for_each(step, sid, ctx)
        if kind == "stop":
            r = self.row(sid, step)
            self.finish_row(r, "planned" if ctx.plan_only else "done", "Would stop here" if ctx.plan_only else "Stopped here")
            return "stopped"
        r = self.row(sid, step)
        self.finish_row(r, "failed", f"{kind or '(blank)'} is not a step kind")
        return self.after_failure(r)

    def after_failure(self, r: models.WorkflowRunStep) -> str:
        self.failed_detail = self.failed_detail or f"{r.label}: {r.detail}"
        return "done" if self.on_error == "continue" else "failed"

    # ── action ──
    def action(self, step: dict, sid: str, ctx: RunContext) -> str:
        key = str(step.get("action") or "")
        action = catalog.ACTIONS.get(key)
        r = self.row(sid, step, label=(step.get("label") or (action.label if action else key)))
        if ctx.item:
            r.label = f"{r.label} - {ctx.item.get('label') or ctx.item.get('name') or ''}".rstrip(" -")
        params = dict(step.get("params") or {})
        r.input = {"params": params, "rendered": _rendered_params(action, params, ctx) if action else {}}
        if action is None:
            self.finish_row(r, "failed", f"The action {key or '(blank)'} no longer exists")
            pause_needs_attention(self.db, self.wf, f"Paused: the action {key or '(blank)'} no longer exists")
            self.db.commit()
            return self.after_failure(r)
        r.attempt = int(r.attempt or 0) + 1
        r.status = "running"
        r.started_at = r.started_at or _iso()
        ctx.step_output = dict(r.output) if isinstance(r.output, dict) else {}
        self.db.commit()
        try:
            if ctx.plan_only:
                line = str(action.plan(ctx, params) or "")
                r.output = {"line": line}
                self.last_line = line
                self.lines += 1
                self.finish_row(r, "planned", line)
                return "done"
            if action.needs_person and ctx.run_as is None:
                raise StepRefused(f"{action.label} needs a person's identity; this workflow runs as Nexus")
            if action.admin_only and int((ctx.run_as or {}).get("level", 0) or 0) < 5:
                raise StepRefused(f"{action.label} is for Global Admins only")
            if action.allowed is not None:
                reason = action.allowed(ctx, params) or ""
                if reason:
                    raise StepRefused(str(reason))
            out = action.run(ctx, params) or {}
            merged = {**ctx.step_output, **out}
            r.output = merged
            r.affected = list(out.get("affected") or [])
            line = str(out.get("line") or f"{action.label} done")
            self.last_line = line
            self.lines += 1
            self.finish_row(r, "done", line)
            return "done"
        except (StepRefused, PermissionError) as e:
            r.output = dict(ctx.step_output)
            self.finish_row(r, "failed", f"Refused: {e}")
            return self.after_failure(r)
        except _transient_types() as e:
            if isinstance(e, OperationalError):
                self.db.rollback()
                r = self.db.merge(r)
                self.rows[sid] = r
            r.output = dict(ctx.step_output)
            if r.attempt <= MAX_ATTEMPTS:          # 3 retries after the first attempt
                minutes = BACKOFF_MINUTES[min(r.attempt - 1, len(BACKOFF_MINUTES) - 1)]
                due = _now() + timedelta(minutes=minutes)
                self.db.add(models.WorkflowWait(id=str(uuid.uuid4()), run_id=self.run.id, workflow_id=self.wf.id,
                                                step_id=sid, due_at=_iso(due), kind="retry",
                                                state={"error": str(e)[:300], "attempt": r.attempt}))
                self.finish_row(r, "waiting", f"Retry {r.attempt} of {MAX_ATTEMPTS} at "
                                              f"{us_datetime(_iso(due), ctx.zone)}: {type(e).__name__}: {str(e)[:200]}")
                return "waiting"
            self.finish_row(r, "failed", f"Failed after {r.attempt} attempts: {type(e).__name__}: {str(e)[:300]}")
            return self.after_failure(r)
        except Exception as e:   # noqa: BLE001 - any other error fails the step with its reason
            try:
                self.db.rollback()
            except Exception:   # noqa: BLE001
                pass
            r = self.db.merge(r)
            self.rows[sid] = r
            r.output = dict(ctx.step_output)
            self.finish_row(r, "failed", f"{type(e).__name__}: {str(e)[:300]}")
            return self.after_failure(r)

    # ── if / else ──
    def branch(self, step: dict, sid: str, ctx: RunContext) -> str:
        r = self.row(sid, step)
        ok, trace = conditions.evaluate(step.get("conditions"), ctx)
        branch = "then" if ok else "else"
        r.output = {"branch": branch, "trace": trace}
        self.finish_row(r, "planned" if ctx.plan_only else "done",
                        f"Took the {'Then' if ok else 'Else'} branch")
        return self.steps(step.get(branch) or [], f"{sid}/", ctx)

    # ── approval ──
    def approval(self, step: dict, sid: str, ctx: RunContext) -> str:
        from workflows import approvals
        r = self.row(sid, step)
        params = dict(step.get("params") or {})
        question = render(params.get("question") or "", ctx)[0]
        who, _dropped = approvals.approver_emails(ctx, params)
        r.input = {"params": params, "rendered": {"question": question, "approvers": who}}
        if ctx.plan_only:
            self.finish_row(r, "planned", f"Would ask {recipients.describe(params.get('approvers'))} "
                                          f"({', '.join(who) or 'nobody resolves'}): {question}")
            return "done"
        if not who:
            self.finish_row(r, "failed", "Nobody could be asked: no approver resolved")
            return self.after_failure(r)
        try:
            ap = approvals.ask(ctx, step, params, question=question, approvers=who)
        except Exception as e:   # noqa: BLE001
            self.finish_row(r, "failed", f"The approval could not be asked: {type(e).__name__}: {str(e)[:200]}")
            return self.after_failure(r)
        due = ""
        if int(params.get("expireDays") or 0) > 0:
            due = _iso(_now() + timedelta(days=int(params["expireDays"])))
        self.db.add(models.WorkflowWait(id=str(uuid.uuid4()), run_id=self.run.id, workflow_id=self.wf.id, step_id=sid,
                                        due_at=due, kind="approval", state={"approvalId": ap.id}))
        r.output = {"approvalId": ap.id, "approvers": who}
        self.finish_row(r, "waiting", f"Waiting for {', '.join(who)}: {question}")
        return "waiting"

    # ── wait ──
    def wait(self, step: dict, sid: str, ctx: RunContext) -> str:
        r = self.row(sid, step)
        params = dict(step.get("params") or {})
        try:
            due = wait_due(ctx, params)
        except ValueError as e:
            self.finish_row(r, "failed", str(e))
            return self.after_failure(r)
        r.input = {"params": params}
        if ctx.plan_only:
            self.finish_row(r, "planned", _iso(due))
            return "done"
        if due <= _now():
            self.finish_row(r, "done", "No wait needed: the time has passed")
            return "done"
        self.db.add(models.WorkflowWait(id=str(uuid.uuid4()), run_id=self.run.id, workflow_id=self.wf.id, step_id=sid,
                                        due_at=_iso(due), kind="delay", state={}))
        r.output = {"dueAt": _iso(due)}
        self.finish_row(r, "waiting", f"Waiting until {us_datetime(_iso(due), ctx.zone)}")
        return "waiting"

    # ── for each ──
    def for_each(self, step: dict, sid: str, ctx: RunContext) -> str:
        r = self.row(sid, step)
        src = step.get("source") or {}
        key = str(src.get("key") if isinstance(src, dict) else src or "")
        ls = catalog.LIST_SOURCES.get(key)
        if ls is None:
            self.finish_row(r, "failed", f"{key or '(blank)'} is not a list")
            return self.after_failure(r)
        ent = catalog.ENTITIES.get(ls.entity)
        params = dict((src.get("params") or {}) if isinstance(src, dict) else {})
        try:
            rows = list(ls.fn(self.db, ctx, params) or [])
        except Exception as e:   # noqa: BLE001
            self.finish_row(r, "failed", f"The list could not be read: {type(e).__name__}: {str(e)[:200]}")
            return self.after_failure(r)
        total = len(rows)
        rows = rows[:MAX_ITEMS]
        items = []
        for row in rows:
            if isinstance(row, dict):
                fields = dict(row)
            elif ent is not None:
                fields = payload_for(ent, row)
            else:
                fields = {}
            fields.setdefault("id", str(getattr(row, "id", "") or fields.get("id") or ""))
            fields.setdefault("label", ent.label_for(row) if ent is not None and not isinstance(row, dict)
                              else str(fields.get("name") or fields.get("title") or fields.get("id") or ""))
            items.append(fields)
        r.input = {"source": key, "params": params}
        r.output = {"count": total, "items": items}
        note = f"{total} item" + ("" if total == 1 else "s")
        if total > MAX_ITEMS:
            note += f" (the first {MAX_ITEMS} handled)"
        self.finish_row(r, "planned" if ctx.plan_only else "done", note)
        return self.each(step, sid, items, ctx)

    def each(self, step: dict, sid: str, items: list, ctx: RunContext) -> str:
        src = step.get("source") or {}
        key = str(src.get("key") if isinstance(src, dict) else src or "")
        ls = catalog.LIST_SOURCES.get(key)
        ent = catalog.ENTITIES.get(ls.entity) if ls else None
        shown = items[:PLAN_ITEMS] if ctx.plan_only else items
        for i, item in enumerate(shown):
            subject = None
            if ent is not None and item.get("id"):
                try:
                    subject = ent.load_row(self.db, str(item["id"]))
                except Exception:   # noqa: BLE001
                    subject = None
            company = (ent.company_of(subject) if ent is not None and subject is not None else "") or ctx.company_id
            inner = RunContext(db=self.db, workflow=ctx.workflow, definition=ctx.definition, run=ctx.run,
                               entity=ent or ctx.entity, subject=subject,
                               payload={"subject": dict(item), "subjectLabel": item.get("label", ""), "changes": {},
                                        "extra": dict((ctx.payload or {}).get("extra") or {}), "actor": ctx.actor},
                               event=ctx.event, actor=ctx.actor, run_as=ctx.run_as, today=ctx.today, zone=ctx.zone,
                               item=dict(item), vars=dict(ctx.vars), company_id=company, plan_only=ctx.plan_only)
            res = self.steps(step.get("steps") or [], f"{sid}#{i}/", inner)
            if res != "done":
                return res
        if ctx.plan_only and len(items) > PLAN_ITEMS:
            self.last_line = f"... and {len(items) - PLAN_ITEMS} more items"
        return "done"


def _rendered_params(action: catalog.ActionDef, params: dict, ctx: RunContext) -> dict:
    out = {}
    for p in action.params:
        v = params.get(p.key)
        if p.type == "template" and isinstance(v, str):
            out[p.key] = render(v, ctx)[0]
        elif p.type in ("recipients", "approvers"):
            out[p.key] = recipients.describe(v)
    return out


def wait_due(ctx: RunContext, params: dict) -> datetime:
    """When a Wait step is over: a duration from now, a date field of the
    subject plus an offset at a time, or the next business morning (8:00
    AM Monday to Friday) in the subject's company zone."""
    from zoneinfo import ZoneInfo
    mode = str(params.get("mode") or "duration")
    try:
        zone = ZoneInfo(ctx.zone or "America/Los_Angeles")
    except Exception:   # noqa: BLE001
        zone = timezone.utc
    now = _now()
    if mode == "duration":
        return now + timedelta(minutes=max(1, int(params.get("minutes") or 0)))
    if mode == "until":
        fld = str(params.get("field") or "")
        value = ctx.resolve(f"subject.{fld}") if fld else MISSING
        if value is MISSING or not value:
            raise ValueError(f"The record has no {fld or 'date'} to wait for")
        try:
            day = date.fromisoformat(str(value)[:10])
        except ValueError:
            raise ValueError(f"{fld} is not a date")
        day = day + timedelta(days=int(params.get("offsetDays") or 0))
        hh, mm = _hhmm(params.get("time") or "08:00")
        return datetime(day.year, day.month, day.day, hh, mm, tzinfo=zone).astimezone(timezone.utc)
    if mode == "business_morning":
        local = now.astimezone(zone)
        day = local.date() if local.hour < 8 else local.date() + timedelta(days=1)
        while day.weekday() >= 5:
            day += timedelta(days=1)
        return datetime(day.year, day.month, day.day, 8, 0, tzinfo=zone).astimezone(timezone.utc)
    raise ValueError(f"{mode!r} is not a wait mode")


def _hhmm(s) -> tuple[int, int]:
    try:
        return int(str(s)[:2]), int(str(s)[3:5])
    except (TypeError, ValueError):
        return 8, 0


# ── execute / resume / cancel / replay ───────────────────────────────────────
def _definition_for(db, run: models.WorkflowRun, wf: models.Workflow) -> dict:
    ver = store.version(db, wf, int(run.version or 0)) if run.version else None
    return store.normalize_definition(ver.definition) if ver is not None else store.definition_of(wf)


def execute(db, run: models.WorkflowRun, *, definition: Optional[dict] = None, ctx: Optional[RunContext] = None,
            budget_seconds: float = 20) -> models.WorkflowRun:
    """Walk the run's steps from where it left off (every finished step row
    is skipped), commit per step, park on a wait, finish or fail."""
    wf = db.get(models.Workflow, run.workflow_id)
    if wf is None:
        run.status, run.error, run.finished_at = "failed", "The workflow no longer exists", _iso()
        db.commit()
        return run
    if definition is None:
        definition = _definition_for(db, run, wf)
    if ctx is None:
        ev = db.get(models.WorkflowEvent, run.event_id) if run.event_id else None
        ent = catalog.ENTITIES.get(run.entity or "")
        subject = None
        if ent is not None and run.subject_id:
            try:
                subject = ent.load_row(db, run.subject_id)
            except Exception:   # noqa: BLE001
                subject = None
        payload = None
        if ev is None and ent is not None and subject is not None:
            payload = {"subject": payload_for(ent, subject), "subjectLabel": ent.label_for(subject), "changes": {},
                       "extra": {}, "actor": run.started_by or ""}
        ctx = build_context(db, wf, definition=definition, event=ev, entity=ent, subject=subject, payload=payload,
                            run=run, plan_only=(run.status == "test"), company_id=run.company_id or "")
    ctx.run = run
    plan_only = ctx.plan_only or run.status == "test"
    ctx.plan_only = plan_only
    if run.status not in ("running", "waiting", "test"):
        return run
    if not plan_only:
        run.status = "running"
        db.commit()
    walk = _Walk(db, run, wf, definition, ctx, budget_seconds)
    token = CURRENT_RUN.set((run.id, int(run.depth or 0)))
    try:
        res = walk.steps(definition.get("steps") or [], "", ctx)
    finally:
        CURRENT_RUN.reset(token)
    run = db.merge(run)
    if plan_only:
        if res == "failed":
            run.summary = f"Would fail: {walk.failed_detail}"
        else:
            run.summary = walk.last_line or f"{walk.lines} planned step" + ("" if walk.lines == 1 else "s")
        run.finished_at = _iso()
        db.commit()
        return run
    if res in ("waiting", "budget"):
        if res == "budget":
            db.add(models.WorkflowWait(id=str(uuid.uuid4()), run_id=run.id, workflow_id=wf.id, step_id="",
                                       due_at=_iso(), kind="delay", state={"budget": True}))
        run.status = "waiting"
        run.summary = walk.last_line or "Waiting"
        db.commit()
        return run
    wf = db.merge(wf)
    if res == "failed":
        run.status = "failed"
        run.error = walk.failed_detail
        run.summary = f"Failed: {walk.failed_detail}"[:500]
        run.finished_at = _iso()
        wf.fail_count = int(wf.fail_count or 0) + 1
        wf.run_count = int(wf.run_count or 0) + 1
        wf.last_run_at = run.finished_at
        db.commit()
        _run_fault_steps(db, run, wf, definition, ctx)
        _bell(db, [wf.owner_email or ""], f"wf-failed:{wf.id}", f"Workflow Failed: {wf.name}",
              f"{run.subject_label or 'A run'}: {walk.failed_detail}"[:400], company=run.company_id or "",
              action={"view": "workflows", "sub": f"run:{run.id}"}, priority=1)
        db.commit()
        return run
    run.status = "succeeded"
    run.summary = (walk.last_line or ("Stopped" if res == "stopped" else f"Completed {walk.lines} step"
                                      + ("" if walk.lines == 1 else "s")))[:500]
    run.finished_at = _iso()
    wf.run_count = int(wf.run_count or 0) + 1
    wf.last_run_at = run.finished_at
    mark_subject(db, wf, run.entity or "", run.subject_id or "")
    db.commit()
    return run


def _run_fault_steps(db, run, wf, definition, ctx) -> None:
    fault = (definition.get("settings") or {}).get("faultSteps") or []
    if not fault:
        return
    walk = _Walk(db, run, wf, definition, ctx, 20)
    walk.on_error = "continue"
    token = CURRENT_RUN.set((run.id, int(run.depth or 0)))
    try:
        walk.steps(fault, "fault/", ctx)
    except Exception as e:   # noqa: BLE001 - fault steps never raise past the failure they handle
        print(f"[workflows] fault steps of {wf.id} failed: {type(e).__name__}: {str(e)[:160]}")
    finally:
        CURRENT_RUN.reset(token)


def resume(db, wait: models.WorkflowWait, *, outcome: Optional[str] = None,
           budget_seconds: float = 20) -> Optional[models.WorkflowRun]:
    """A due wait, a retry or an approval decision: mark the parked step and
    walk on."""
    run = db.get(models.WorkflowRun, wait.run_id)
    db.delete(wait)
    if run is None or run.status not in ("waiting", "running"):
        db.commit()
        return run
    if wait.step_id:
        r = (db.query(models.WorkflowRunStep)
             .filter(models.WorkflowRunStep.run_id == run.id, models.WorkflowRunStep.step_id == wait.step_id).first())
        if r is not None:
            if wait.kind == "retry":
                r.status = "retry"
            elif wait.kind == "approval":
                out = dict(r.output or {})
                out["outcome"] = outcome or "expired"
                r.output = out
                r.status = "done"
                r.detail = f"Outcome: {out['outcome']}"
                r.finished_at = _iso()
            else:
                r.status = "done"
                r.detail = "Waited"
                r.finished_at = _iso()
    run.status = "running"
    db.commit()
    return execute(db, run, budget_seconds=budget_seconds)


def cancel(db, run: models.WorkflowRun, by: str) -> models.WorkflowRun:
    if run.status not in ("waiting", "running"):
        raise ValueError("Only a waiting run can be cancelled")
    for w in db.query(models.WorkflowWait).filter(models.WorkflowWait.run_id == run.id).all():
        db.delete(w)
    for ap in (db.query(models.WorkflowApproval)
               .filter(models.WorkflowApproval.run_id == run.id, models.WorkflowApproval.outcome == "").all()):
        ap.outcome, ap.decided_at = "cancelled", _iso()
    for r in db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == run.id,
                                                      models.WorkflowRunStep.status == "waiting").all():
        r.status, r.detail, r.finished_at = "skipped", f"Cancelled by {by}", _iso()
    run.status, run.finished_at = "cancelled", _iso()
    run.summary = f"Cancelled by {by}"
    db.commit()
    return run


def replay(db, run: models.WorkflowRun, by: str) -> models.WorkflowRun:
    """A new run from the failed step on, with the current version."""
    if run.status != "failed":
        raise ValueError("Only a failed run can be replayed")
    wf = db.get(models.Workflow, run.workflow_id)
    if wf is None:
        raise ValueError("The workflow no longer exists")
    new = models.WorkflowRun(id=str(uuid.uuid4()), workflow_id=wf.id, workflow_name=wf.name or "",
                             version=int(wf.version or 0), event_id=run.event_id or "", trigger_kind="replay",
                             entity=run.entity or "", subject_id=run.subject_id or "",
                             subject_label=run.subject_label or "", company_id=run.company_id or "",
                             status="running", started_at=_iso(), replay_of=run.id, started_by=(by or "").lower(),
                             depth=int(run.depth or 0))
    db.add(new)
    for r in store.run_steps(db, run):
        if r.status in ("done", "skipped") or r.kind == "conditions":
            db.add(models.WorkflowRunStep(id=str(uuid.uuid4()), run_id=new.id, workflow_id=wf.id, step_id=r.step_id,
                                          kind=r.kind, action=r.action, label=r.label, status=r.status,
                                          started_at=r.started_at, finished_at=r.finished_at, input=r.input,
                                          output=r.output, detail=r.detail, affected=r.affected, attempt=r.attempt))
    db.commit()
    return execute(db, new)


# ── the dry run ──────────────────────────────────────────────────────────────
def sample_subject(db, wf: models.Workflow, definition: dict):
    """(entity, subject row, payload) for a Test without a real event: the
    trigger's entity and the catalog sample for it."""
    trig = definition.get("trigger") or {}
    kind = trig.get("kind")
    if kind == "event":
        ev = catalog.EVENTS.get(str(trig.get("event") or ""))
        if ev is None:
            return None, None, None
        return catalog.ENTITIES.get(ev.entity), None, catalog.sample_payload(ev)
    if kind == "schedule":
        ent = catalog.ENTITIES.get(str(trig.get("entity") or "") or "company")
        if ent is not None and ent.key == "company":
            row = db.get(models.HrEntity, wf.company_id) if wf.company_id else db.query(models.HrEntity).first()
            if row is not None:
                return ent, row, None
        return ent, None, {"subject": {"name": "Greens Global"}, "changes": {}, "extra": {}, "actor": ""}
    ent = catalog.ENTITIES.get(str(trig.get("entity") or ""))
    if ent is None:
        return None, None, None
    sample_ev = next((e for e in catalog.EVENTS.values() if e.entity == ent.key and e.sample), None)
    return ent, None, (catalog.sample_payload(sample_ev) if sample_ev else {"subject": {}, "changes": {}, "extra": {}, "actor": ""})


def test_run(db, wf: models.Workflow, *, event: Optional[models.WorkflowEvent] = None, by: str = "",
             definition: Optional[dict] = None) -> models.WorkflowRun:
    """Test With A Recent Event (spec 6.8): the draft in plan mode against
    a real outbox row or the sample - conditions traced, every action's
    plan line, waits as the time they would wait until. Nothing is written
    but the run row (status `test`); the draft's hash is stamped as tested."""
    from workflows import validate
    definition = store.normalize_definition(definition) if definition is not None else store.draft_of(wf)
    if event is not None:
        ctx = build_context(db, wf, definition=definition, event=event, plan_only=True)
    else:
        ent, subject, payload = sample_subject(db, wf, definition)
        if ent is not None and subject is not None and payload is None:
            payload = {"subject": payload_for(ent, subject), "subjectLabel": ent.label_for(subject), "changes": {},
                       "extra": {}, "actor": by or ""}
        ctx = build_context(db, wf, definition=definition, entity=ent, subject=subject, payload=payload,
                            plan_only=True, actor=by or "")
    passed, trace = evaluate_entry(ctx, definition)
    run = start(db, wf, ctx=ctx, trigger_kind=str((definition.get("trigger") or {}).get("kind") or "test"),
                event=event, started_by=by, plan_only=True, trace=trace, passed=passed)
    if passed:
        run = execute(db, run, definition=definition, ctx=ctx)
    else:
        run.summary = "Conditions did not match: nothing would run"
        run.finished_at = _iso()
    wf = db.merge(wf)
    wf.tested_hash = validate.definition_hash(store.draft_of(wf))
    wf.last_tested_at = _iso()
    db.commit()
    return run


def subject_link_for(run: models.WorkflowRun, db) -> str:
    ent = catalog.ENTITIES.get(run.entity or "")
    if ent is None or not run.subject_id:
        return ""
    try:
        row = ent.load_row(db, run.subject_id)
        return link_url(ent.link_for(row, db)) if row is not None else ""
    except Exception:   # noqa: BLE001
        return ""
