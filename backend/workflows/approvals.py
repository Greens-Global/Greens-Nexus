"""Ask For Approval (spec 6.4): the step writes a WorkflowApproval row and
bells each approver; the row shows in the Approvals inbox (the `workflow`
source below) with the step's options as buttons; the decision comes
through `POST /workflows/approvals/{id}/decide`, which checks the decider
is an approver (or a live stand-in through approval_delegation), records
the response and resumes the run into the chosen option's branch.

Modes: `any` - the first response decides; `all` - everyone must pick the
first option (the "yes") for it to stand, any other answer decides at
once; `sequence` - one approver at a time, in order, same rule. Nobody
approves a workflow ask about themselves unless the step says so
(`allowSelf`). Reminders and expiry run in the runner's tick (`sweep`).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import models
from approvals_inbox import a_open, row as inbox_row, source
from workflows import recipients
from workflows.context import RunContext


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or _now()).isoformat()


def _subject_people(ctx: RunContext) -> list[str]:
    if ctx.entity is None or "self" not in ctx.entity.people:
        return []
    try:
        if ctx.subject is not None:
            return [e.lower() for e in (ctx.entity.people["self"](ctx.db, ctx.subject) or []) if e]
        sub = (ctx.payload or {}).get("subject") or {}
        return [e for e in [str(sub.get("work_email") or sub.get("email") or "").lower()] if e]
    except Exception:   # noqa: BLE001
        return []


def approver_emails(ctx: RunContext, params: dict) -> tuple[list[str], int]:
    """The approvers a step resolves to, minus the subject unless allowed."""
    from workflows.packs.core import recipient_cap
    who, dropped = recipients.resolve(ctx, params.get("approvers"), cap=recipient_cap(ctx))
    if not params.get("allowSelf"):
        selves = set(_subject_people(ctx))
        kept = [e for e in who if e not in selves]
        dropped += len(who) - len(kept)
        who = kept
    return who, dropped


def options_of(params: dict) -> list[str]:
    opts = params.get("options") or ["Approve", "Decline"]
    return [str(o) for o in opts if str(o)]


def _bell(db, who: list[str], ap: models.WorkflowApproval) -> None:
    import notify_rollup
    for e in who:
        try:
            notify_rollup.upsert_rollup(db, recipient=e, key=f"wf-approval:{ap.id}",
                                        title=f"Approval Needed: {ap.workflow_name}", line=ap.question,
                                        action={"view": "approvals"}, company=ap.company_id or "",
                                        requested_by="workflows@nexus", replace=True, priority=1)
        except Exception as ex:   # noqa: BLE001 - a bell never stops the ask
            print(f"[workflows] approval bell to {e} failed: {type(ex).__name__}: {str(ex)[:120]}")


def ask(ctx: RunContext, step: dict, params: dict, *, question: str, approvers: list[str]) -> models.WorkflowApproval:
    """Write the ask and bell the approvers (the first one only in
    `sequence` mode). The caller commits."""
    mode = str(params.get("mode") or "any")
    if mode not in ("any", "all", "sequence"):
        mode = "any"
    ap = models.WorkflowApproval(
        id=str(uuid.uuid4()), run_id=str(getattr(ctx.run, "id", "") or ""),
        workflow_id=str(getattr(ctx.workflow, "id", "") or ""), step_id=str(step.get("id") or ""),
        workflow_name=str(getattr(ctx.workflow, "name", "") or ""), subject_label=ctx.subject_label(),
        subject_link=ctx.subject_link() or {}, company_id=ctx.company(), approvers=list(approvers), mode=mode,
        question=question[:1000], options=options_of(params), responses=[], outcome="", asked_at=_iso(),
        decided_at="", remind_days=int(params.get("remindDays") or 0), expire_days=int(params.get("expireDays") or 0),
        reminded_at="")
    ctx.db.add(ap)
    _bell(ctx.db, current_approvers(ap), ap)
    return ap


def current_approvers(ap: models.WorkflowApproval) -> list[str]:
    """Who may answer right now: everyone still silent, or in `sequence`
    mode the next one in line."""
    answered = {str(r.get("email") or "").lower() for r in (ap.responses or [])}
    waiting = [e for e in (ap.approvers or []) if e.lower() not in answered]
    if ap.mode == "sequence":
        return waiting[:1]
    return waiting


def may_decide(db, ap: models.WorkflowApproval, email: str) -> tuple[bool, str]:
    """(allowed, acting_for): a current approver, or a live stand-in for
    one (approval_delegation) - then `acting_for` names the delegator."""
    import approval_delegation
    me = (email or "").lower()
    current = [e.lower() for e in current_approvers(ap)]
    if me in current:
        return True, ""
    try:
        for d in approval_delegation.live_for_delegate(db, me):
            if (d.delegator_email or "").lower() in current:
                return True, (d.delegator_email or "").lower()
    except Exception:   # noqa: BLE001 - a delegation lookup that fails is no delegation
        pass
    return False, ""


def _outcome(ap: models.WorkflowApproval, option: str) -> str:
    """'' while still open, else the decided option."""
    opts = ap.options or ["Approve", "Decline"]
    if ap.mode == "any":
        return option
    if option != opts[0]:
        return option                       # a "no" from anyone decides at once
    answered = {str(r.get("email") or "").lower() for r in (ap.responses or [])}
    if all(e.lower() in answered for e in (ap.approvers or [])):
        return option
    return ""


def decide(db, ap: models.WorkflowApproval, user: dict, option: str, note: str = "") -> dict:
    """Record one approver's answer; resume the run when the ask is
    decided. Raises PermissionError (not an approver / the subject) and
    ValueError (already decided / not an option)."""
    from workflows import engine
    me = (user.get("email") or "").lower()
    if ap.outcome:
        raise ValueError("This approval was already decided")
    if option not in (ap.options or []):
        raise ValueError(f"{option!r} is not one of the options")
    ok, acting_for = may_decide(db, ap, me)
    if not ok:
        raise PermissionError("You are not one of the approvers")
    responses = list(ap.responses or [])
    responses.append({"email": me, "option": option, "note": (note or "")[:1000], "at": _iso(),
                      **({"for": acting_for} if acting_for else {})})
    ap.responses = responses
    outcome = _outcome(ap, option)
    result = {"id": ap.id, "outcome": outcome, "responses": responses, "decided": bool(outcome)}
    A = models.WorkflowApproval
    if not outcome:
        # still open: the answer lands only while nobody else closed the ask
        n = (db.query(A).filter(A.id == ap.id, A.outcome == "")
             .update({A.responses: responses}, synchronize_session=False))
        if n != 1:
            db.rollback()
            raise ValueError("This approval was already decided")
        db.commit()
        if ap.mode == "sequence":
            _bell(db, current_approvers(ap), ap)
            db.commit()
        return result
    # one decision closes the ask: the conditional UPDATE is the race guard
    # (two approvers at once, a decision against the expiry sweep, two API
    # workers) - whoever loses gets "already decided" and resumes nothing
    n = (db.query(A).filter(A.id == ap.id, A.outcome == "")
         .update({A.responses: responses, A.outcome: outcome, A.decided_at: _iso()}, synchronize_session=False))
    if n != 1:
        db.rollback()
        raise ValueError("This approval was already decided")
    db.commit()
    db.refresh(ap)
    wait = (db.query(models.WorkflowWait)
            .filter(models.WorkflowWait.run_id == ap.run_id, models.WorkflowWait.kind == "approval",
                    models.WorkflowWait.step_id.like(f"%{ap.step_id}")).first())
    if wait is not None and engine.claim_wait(db, wait.id):
        wait = db.get(models.WorkflowWait, wait.id)
        run = engine.resume(db, wait, outcome=outcome) if wait is not None else None
        result["runStatus"] = run.status if run is not None else ""
    return result


def sweep(db, now: Optional[datetime] = None) -> dict:
    """Reminders (remindDays after the ask, once) and expiry (expireDays:
    the run resumes into the `expired` branch)."""
    from workflows import engine
    now = now or _now()
    reminded = expired = 0
    for ap in db.query(models.WorkflowApproval).filter(models.WorkflowApproval.outcome == "").all():
        try:
            asked = datetime.fromisoformat((ap.asked_at or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if ap.expire_days and now >= asked + timedelta(days=int(ap.expire_days)):
            A = models.WorkflowApproval
            n = (db.query(A).filter(A.id == ap.id, A.outcome == "")
                 .update({A.outcome: "expired", A.decided_at: _iso(now)}, synchronize_session=False))
            db.commit()
            if n != 1:
                continue                    # a decision landed first
            wait = (db.query(models.WorkflowWait)
                    .filter(models.WorkflowWait.run_id == ap.run_id, models.WorkflowWait.kind == "approval").first())
            if wait is not None and engine.claim_wait(db, wait.id, now=now):
                wait = db.get(models.WorkflowWait, wait.id)
                if wait is not None:
                    engine.resume(db, wait, outcome="expired")
            expired += 1
            continue
        if ap.remind_days and not ap.reminded_at and now >= asked + timedelta(days=int(ap.remind_days)):
            _bell(db, current_approvers(ap), ap)
            ap.reminded_at = _iso(now)
            db.commit()
            reminded += 1
    return {"reminded": reminded, "expired": expired}


# ── the Approvals inbox source ───────────────────────────────────────────────
@source("workflow", "Workflow Approvals", "workflows")
def _workflow_asks(db, user: dict, ctx: dict) -> list:
    """Every open workflow ask waiting on the caller (a current approver,
    or a live stand-in for one): the step's options as buttons - EVERY
    key decides it through POST /workflows/approvals/{id}/decide - and Open
    lands on the SUBJECT record (the person, task, ticket or time sheet the
    ask is about). An approver is often an employee with no Workflows grant
    (App.jsx gates the view at supervisor, GET /runs/{id} needs the grant),
    so the run's own link travels separately as `runLink`."""
    import approval_delegation
    me = (user.get("email") or "").strip().lower()
    if not me or user.get("external"):
        return []
    try:
        delegators = {(d.delegator_email or "").lower() for d in approval_delegation.live_for_delegate(db, me)}
    except Exception:   # noqa: BLE001
        delegators = set()
    out = []
    for ap in (db.query(models.WorkflowApproval).filter(models.WorkflowApproval.outcome == "")
               .order_by(models.WorkflowApproval.asked_at).all()):
        current = [e.lower() for e in current_approvers(ap)]
        for_name = ""
        if me not in current:
            who = next((d for d in delegators if d in current), "")
            if not who:
                continue
            from workflows.context import person_name
            for_name = person_name(db, who)
        actions = [{"key": o, "label": o, "tone": "primary" if i == 0 else "plain", "note": "optional"}
                   for i, o in enumerate(ap.options or [])] + [a_open("Open")]
        run_link = {"view": "workflows", "sub": f"run:{ap.run_id}"}
        row = inbox_row("workflow", ap.id, person_email="", person_name=ap.subject_label or "",
                        title=f"{ap.workflow_name}: {ap.question}"[:200],
                        detail=f"About {ap.subject_label}" if ap.subject_label else "",
                        created_at=ap.asked_at, actions=actions,
                        link=subject_link(db, ap) or run_link, for_name=for_name)
        row["runLink"] = run_link
        out.append(row)
    return out


def subject_link(db, ap: models.WorkflowApproval) -> dict:
    """The subject record's own navigate detail: what the ask stored, else
    resolved again from the run's entity and subject id (an older row, a
    link the pack could not build at ask time); {} when there is none."""
    stored = ap.subject_link if isinstance(ap.subject_link, dict) else {}
    if stored.get("view"):
        return dict(stored)
    run = db.get(models.WorkflowRun, ap.run_id) if ap.run_id else None
    if run is None or not run.entity or not run.subject_id:
        return {}
    from workflows import catalog
    ent = catalog.ENTITIES.get(run.entity)
    if ent is None:
        return {}
    try:
        return ent.link_for(ent.load_row(db, run.subject_id), db)
    except Exception:   # noqa: BLE001 - a link that cannot be built is no link
        return {}
