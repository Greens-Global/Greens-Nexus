"""The Knowledge Base daily scan (Oct 2026 rebuild) - run from
reminders_loop in a thread, never from a page open.

  1. Assignment rules: every active rule's audience gets its course (or
     plan) assigned, due `due_days` after the person's start date (or
     today, if they started earlier).
  2. Renewals: a certificate that expires within 30 days, with no newer open
     assignment, gets the next assignment and the progress starts over.
  3. Learner reminders: training due in 7 days, due today, then weekly after;
     policies to sign on the same cadence. ONE bell and ONE email per person
     per day listing everything.
  4. Monday digests: each manager hears about direct reports who are behind;
     each collection owner hears about pages past review, open flags and
     page requests. One bell, one email.
Everything is deduped through kb_reminder_log, so the boot-time run after a
deploy is harmless.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import graph_mail
import kb_access
import kb_audience
import kb_core
import kb_reminder_config
import models
from app_url import app_url
from database import SessionLocal
import job_switch

REMIND_BEFORE_DAYS = 7
RENEW_BEFORE_DAYS = 30


def _sent(db, kind: str, ref: str, recipient: str) -> bool:
    return db.query(models.KbReminderLog).filter(models.KbReminderLog.kind == kind, models.KbReminderLog.ref_id == ref,
                                                 models.KbReminderLog.recipient == recipient, models.KbReminderLog.day == kb_core.utc_day()).first() is not None


def _mark(db, kind: str, ref: str, recipient: str) -> None:
    db.add(models.KbReminderLog(id=kb_core.new_id("rl"), kind=kind, ref_id=ref, recipient=recipient, day=kb_core.utc_day(), created_at=kb_core.now()))   # a dedupe key: the UTC day


def _us(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso[:10])
        return f"{d.month:02d}/{d.day:02d}/{d.year}"
    except ValueError:
        return iso


def _mail(db, to: str, subject: str, lines: list[str], link_sub: str = "training") -> None:
    frm = (graph_mail.DEFAULT_FROM_EMAIL or "").strip()
    if not frm or not to:
        return
    # The website, not the API host: public_base() is the API's own address,
    # where /sop/... is a 404 page (Oct 28 2026).
    base = app_url()
    items = "".join(f"<li style='margin:4px 0'>{ln}</li>" for ln in lines)
    html = (f"<div style='font-family:Inter,Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a'>"
            f"<p>{subject}</p><ul>{items}</ul>"
            f"<p><a href='{base}/sop/{link_sub}' style='color:#1e7b4e;font-weight:600'>Open in Nexus</a></p>"
            f"<p style='color:#64748b;font-size:12px'>You get one of these a day at most.</p></div>")
    try:
        graph_mail.send_mail(from_email=frm, to=[to], cc=[], subject=subject, html=html)
    except graph_mail.GraphMailError as e:
        print(f"[kb] mail to {to} failed: {e}")
    except Exception as e:  # noqa: BLE001
        print(f"[kb] mail to {to} failed: {e}")


# ----------------------------------------------------------------- rules

def _assign_course(db, course: models.KbCourse, emp: models.NexusEmployee, *, due: str, source: str,
                   rule_id: str = "", plan_id: str = "", by: str = "rule") -> bool:
    email = (emp.work_email or "").lower()
    have = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == course.id,
                                                      models.KbCourseAssignment.user_email == email).first()
    if have:
        return False
    db.add(models.KbCourseAssignment(id=kb_core.new_id("asn"), course_id=course.id, user_email=email,
                                     user_name=(emp.display_name or f"{emp.first_name} {emp.last_name}").strip(),
                                     due_date=due, assigned_by=by, created_at=kb_core.now(), source=source, rule_id=rule_id, plan_id=plan_id))
    kb_core.notify(db, recipient=email, ntype="kb_course_assigned", title="Training Assigned",
                   body=f"{course.title}" + (f" - due {_us(due)}" if due else ""), ref_id=course.id, item_name=course.title,
                   sub=f"course:{course.id}", dedupe_today=True)
    return True


def _due_for(db, emp: models.NexusEmployee, due_days: int) -> str:
    start = (emp.start_date or "")[:10]
    day = kb_core.today_for(db, emp.work_email or "")
    base = start if start and start > day else day
    return kb_core.add_days(base, int(due_days or 0)) if due_days else ""


def run_rules(db) -> int:
    made = 0
    for rule in db.query(models.KbAssignmentRule).filter(models.KbAssignmentRule.active.is_(True)).all():
        # Only people the rule's maker could reach: a rule never crosses the company wall.
        members = kb_audience.members(db, kb_audience.loads(rule.audience), kb_access.scope_of_email(db, rule.created_by))
        if rule.kind == "course":
            c = db.query(models.KbCourse).filter(models.KbCourse.id == rule.target_id, models.KbCourse.status == "published").first()
            if not c:
                continue
            for emp in members:
                if _assign_course(db, c, emp, due=_due_for(db, emp, rule.due_days), source="rule", rule_id=rule.id):
                    made += 1
        elif rule.kind == "plan":
            plan = db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.id == rule.target_id, models.KbTrainingPlan.active.is_(True)).first()
            if not plan:
                continue
            for emp in members:
                if assign_plan(db, plan, emp, due_days=plan.due_days or rule.due_days, source="rule", by="rule"):
                    made += 1
        rule.last_run_at = kb_core.now()
    # plans with their own audience
    for plan in db.query(models.KbTrainingPlan).filter(models.KbTrainingPlan.active.is_(True)).all():
        if not plan.audience or kb_audience.is_everyone(kb_audience.loads(plan.audience)) and not plan.audience.strip("{} "):
            continue
        for emp in kb_audience.members(db, kb_audience.loads(plan.audience), kb_access.scope_of_email(db, plan.created_by)):
            if assign_plan(db, plan, emp, due_days=plan.due_days, source="rule", by="rule"):
                made += 1
    db.commit()
    return made


def assign_plan(db, plan: models.KbTrainingPlan, emp: models.NexusEmployee, *, due_days: int, source: str, by: str) -> bool:
    email = (emp.work_email or "").lower()
    if db.query(models.KbPlanAssignment).filter(models.KbPlanAssignment.plan_id == plan.id, models.KbPlanAssignment.user_email == email).first():
        return False
    due = _due_for(db, emp, due_days)
    db.add(models.KbPlanAssignment(id=kb_core.new_id("pa"), plan_id=plan.id, user_email=email,
                                   user_name=(emp.display_name or f"{emp.first_name} {emp.last_name}").strip(), due_date=due,
                                   source=source, assigned_by=by, created_at=kb_core.now()))
    try:
        items = json.loads(plan.items or "[]")
    except ValueError:
        items = []
    for it in items:
        if isinstance(it, dict) and it.get("kind") == "course":
            c = db.query(models.KbCourse).filter(models.KbCourse.id == it.get("id"), models.KbCourse.status == "published").first()
            if c:
                _assign_course(db, c, emp, due=due, source="plan", plan_id=plan.id, by=by)
    kb_core.notify(db, recipient=email, ntype="kb_plan_assigned", title="Training Plan Assigned",
                   body=f"{plan.name}" + (f" - due {_us(due)}" if due else ""), ref_id=plan.id, item_name=plan.name,
                   sub="training", dedupe_today=True)
    return True


# ----------------------------------------------------------------- renewals

def run_renewals(db) -> int:
    made = 0
    horizon = kb_core.add_days(kb_core.today(), RENEW_BEFORE_DAYS)
    for cert in db.query(models.KbCertificate).filter(models.KbCertificate.expires_at != "", models.KbCertificate.revoked_at == "").all():
        if cert.expires_at > horizon:
            continue
        c = db.query(models.KbCourse).filter(models.KbCourse.id == cert.course_id, models.KbCourse.status == "published").first()
        if not c:
            continue
        prog = kb_core.progress_of(db, c, cert.user_email)
        if not prog or prog.certificate_id != cert.id:
            continue   # already renewed (a newer completion / certificate exists)
        emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == cert.user_email,
                                                    models.NexusEmployee.status.in_(("onboarding", "active"))).first()
        if not emp:
            continue
        asn = db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.course_id == c.id,
                                                         models.KbCourseAssignment.user_email == cert.user_email).first()
        if asn:
            asn.due_date = cert.expires_at
            asn.source = "renewal"
            asn.created_at = kb_core.now()
        else:
            db.add(models.KbCourseAssignment(id=kb_core.new_id("asn"), course_id=c.id, user_email=cert.user_email, user_name=cert.user_name,
                                             due_date=cert.expires_at, assigned_by="renewal", created_at=kb_core.now(), source="renewal"))
        # progress starts over; the certificate row stays as the record
        prog.lessons_done, prog.quiz_score, prog.passed, prog.started_at, prog.completed_at = "[]", None, False, "", ""
        prog.certificate_id = ""
        prog.course_major = c.major or 0
        prog.unlock_rounds = 0
        kb_core.notify(db, recipient=cert.user_email, ntype="kb_course_recert", title="Training Renewal Due",
                       body=f"{c.title} expires {_us(cert.expires_at)}. Take it again to stay current.", ref_id=c.id,
                       item_name=c.title, sub=f"course:{c.id}", dedupe_today=True)
        made += 1
    db.commit()
    return made


# ----------------------------------------------------------------- reminders

def _cadence_hit(due: str, day: str) -> bool:
    """7 days before, the due day, then every 7 days after - on the person's own `day`."""
    if not due:
        return False
    delta = kb_core.days_between(day, due)   # positive = still ahead
    if delta == REMIND_BEFORE_DAYS or delta == 0:
        return True
    return delta < 0 and (-delta) % 7 == 0


def learner_items(db, email: str) -> list[dict]:
    """Everything one person owes: [{kind: course|policy, id, title, due, days_overdue, status}]."""
    out = []
    for a in db.query(models.KbCourseAssignment).filter(models.KbCourseAssignment.user_email == email).all():
        c = db.query(models.KbCourse).filter(models.KbCourse.id == a.course_id, models.KbCourse.status == "published").first()
        if not c:
            continue
        st = kb_core.training_status(db, c, kb_core.progress_of(db, c, email), a.due_date, email)
        if st["status"] in ("Completed",):
            continue
        out.append({"kind": "course", "id": c.id, "title": c.title, "due": a.due_date or "", "days_overdue": st["days_overdue"], "status": st["status"]})
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    day = kb_core.today_for(db, email)
    for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all():
        if email not in kb_core.policy_audience_emails(db, d):
            continue
        if kb_core.signature_for(db, d, email):
            continue
        due = kb_core.signature_due(db, d, emp)
        out.append({"kind": "policy", "id": d.id, "title": d.title, "due": due, "days_overdue": max(0, kb_core.days_between(due, day)), "status": "Overdue" if due < day else "To Sign"})
    return out


def run_learner_reminders(db) -> int:
    cfg = kb_reminder_config.get_config(db)["learners"]   # Settings > Emails & Reminders > Training Reminders
    if not cfg["enabled"]:
        return 0
    sent = 0
    emails = {a.user_email.lower() for a in db.query(models.KbCourseAssignment).all()}
    for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True)).all():
        emails |= kb_core.policy_audience_emails(db, d)
    active = {(e.work_email or "").lower() for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.status.in_(("onboarding", "active"))).all()}
    for email in sorted(emails & active):
        if _sent(db, "learner_digest", "", email):
            continue
        day = kb_core.today_for(db, email)
        items = [i for i in learner_items(db, email) if _cadence_hit(i["due"], day)]
        if not items:
            continue
        lines = [f"{i['title']} - " + (f"{i['days_overdue']} days overdue" if i["days_overdue"] else f"due {_us(i['due'])}") for i in items]
        overdue = [i for i in items if i["days_overdue"]]
        title = "Training Overdue" if overdue else "Training Due Soon"
        kb_core.notify(db, recipient=email, ntype="kb_training_reminder", title=title, body="; ".join(lines)[:900],
                       ref_id="training", item_name=title, sub="training", dedupe_today=True, priority=1 if overdue else 0)
        if cfg["email"]:
            _mail(db, email, f"{title}: {len(items)} item{'s' if len(items) != 1 else ''}", lines)
        _mark(db, "learner_digest", "", email)
        sent += 1
    db.commit()
    return sent


def run_manager_digests(db) -> int:
    if datetime.now(timezone.utc).weekday() != 0:   # Monday
        return 0
    cfg = kb_reminder_config.get_config(db)["managers"]
    if not cfg["enabled"]:
        return 0
    sent = 0
    managers = {(e.manager_email or "").lower() for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.manager_email != "").all()}
    for m in sorted(managers):
        if not m or _sent(db, "manager_digest", "", m):
            continue
        behind = []
        for emp in kb_access.direct_reports(db, m):
            email = (emp.work_email or "").lower()
            items = [i for i in learner_items(db, email) if i["days_overdue"] > 0]
            if items:
                behind.append(f"{(emp.display_name or (emp.first_name + ' ' + emp.last_name)).strip()}: {len(items)} overdue ({items[0]['title']}" + (f" and {len(items) - 1} more" if len(items) > 1 else "") + ")")
        if not behind:
            continue
        kb_core.notify(db, recipient=m, ntype="kb_team_training", title="Team Training Behind", body="; ".join(behind)[:900],
                       ref_id="compliance", item_name="Compliance", sub="compliance", dedupe_today=True)
        if cfg["email"]:
            _mail(db, m, f"Team training: {len(behind)} of your direct reports are behind", behind, link_sub="compliance")
        _mark(db, "manager_digest", "", m)
        sent += 1
    db.commit()
    return sent


def run_owner_digests(db) -> int:
    if datetime.now(timezone.utc).weekday() != 0:
        return 0
    cfg = kb_reminder_config.get_config(db)["owners"]
    if not cfg["enabled"]:
        return 0
    sent = 0
    owners: dict[str, list[str]] = {}
    for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved").all():
        st = kb_core.review_state(db, d)
        who = (d.owner_email or kb_access.collection_owner(db, d.collection_id) or "").lower()
        if st["stale"] and who:
            owners.setdefault(who, []).append(f"{d.title} - review was due {_us(st['next_review'])}" if st["next_review"] else f"{d.title} - never verified")
    for f in db.query(models.KbFlag).filter(models.KbFlag.status == "open").all():
        d = db.query(models.KbDocument).filter(models.KbDocument.id == f.doc_id).first()
        who = ((d.owner_email if d else "") or (kb_access.collection_owner(db, d.collection_id) if d else "") or "").lower()
        if who:
            owners.setdefault(who, []).append(f"{d.title} - a reader reported: {f.text[:80]}")
    for r in db.query(models.KbPageRequest).filter(models.KbPageRequest.status == "open").all():
        who = kb_access.collection_owner(db, r.collection_id) if r.collection_id else ""
        for m in ([who] if who else kb_access.kb_managers(db)):
            owners.setdefault(m, []).append(f"Page requested: \"{r.query}\"")
    for who, lines in owners.items():
        if _sent(db, "owner_digest", "", who):
            continue
        kb_core.notify(db, recipient=who, ntype="kb_owner_digest", title="Pages That Need You", body="; ".join(lines)[:900],
                       ref_id="health", item_name="Health", sub="health", dedupe_today=True)
        if cfg["email"]:
            _mail(db, who, f"Knowledge Base: {len(lines)} thing{'s' if len(lines) != 1 else ''} need you", lines, link_sub="health")
        _mark(db, "owner_digest", "", who)
        sent += 1
    db.commit()
    return sent


def run_daily() -> dict:
    db = SessionLocal()
    try:
        out = {"rules": run_rules(db), "renewals": run_renewals(db)}
        if not job_switch.off("kb_daily"):   # Workflows > Automations switch: the reminders and digests only
            out.update({"learners": run_learner_reminders(db), "managers": run_manager_digests(db),
                        "owners": run_owner_digests(db)})
        print(f"[kb] daily scan: {out}")
        return out
    finally:
        db.close()
