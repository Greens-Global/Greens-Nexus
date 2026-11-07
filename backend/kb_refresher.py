"""Refresher (Neil, 11/07/2026): what world-class training programs do that
a one-time quiz does not - ask again, later, so the knowledge stays.

After a person PASSES a course, every question in its bank becomes a
refresher item for them, due a few days out and spread over the first
week. Each day they may see up to THREE due questions (My Learning, or the
Dashboard's Refresher widget). A right answer doubles the item's interval
(1, 2, 4, 8 ... up to 60 days); a wrong one drops it back to one day and
shows the explanation. Nothing here changes a score, a certificate or a
status, and nobody is reminded or chased about it: it is the person's own
few minutes, with a streak to keep.
"""
from __future__ import annotations

import random

import kb_core
import models

DAILY = 3
MAX_INTERVAL = 60
_FIRST_SPREAD = 7   # new items land across the first week, not all at once


def _settings(c: models.KbCourse) -> list[dict]:
    return [q for q in kb_core.course_settings(c)["questions"] if q.get("type") in ("single", "multi", "tf", "order", "short")]


def _seed(db, email: str, today: str) -> None:
    """Items for every question of every course the person has passed that
    has none yet."""
    have = {(r.course_id, r.question_id) for r in db.query(models.KbRefresherItem).filter(models.KbRefresherItem.user_email == email).all()}
    passed = db.query(models.KbCourseProgress).filter(models.KbCourseProgress.user_email == email, models.KbCourseProgress.passed == True).all()  # noqa: E712
    for p in passed:
        c = db.get(models.KbCourse, p.course_id)
        if c is None or c.status != "published":
            continue
        for i, q in enumerate(_settings(c)):
            if (c.id, q["_id"]) in have:
                continue
            db.add(models.KbRefresherItem(id=kb_core.new_id("rf"), user_email=email, course_id=c.id, question_id=q["_id"],
                                          due_on=kb_core.add_days(today, 1 + (i % _FIRST_SPREAD)), interval_days=1,
                                          right_count=0, wrong_count=0, last_answered_at="", created_at=kb_core.now()))
            have.add((c.id, q["_id"]))
    db.flush()


def _public(q: dict) -> dict:
    """The question as the learner sees it: no answer, no keywords."""
    return {"id": q["_id"], "type": q.get("type") or "single", "q": q.get("q") or "", "options": list(q.get("options") or [])}


def _streak(db, email: str, today: str) -> int:
    days = sorted({(r.last_answered_at or "")[:10] for r in db.query(models.KbRefresherItem).filter(models.KbRefresherItem.user_email == email).all()
                   if r.last_answered_at}, reverse=True)
    if not days:
        return 0
    start = today if days[0] == today else kb_core.add_days(today, -1)
    if days[0] != start:
        return 0
    n, d = 0, start
    for day in days:
        if day != d:
            break
        n += 1
        d = kb_core.add_days(d, -1)
    return n


def today(db, email: str) -> dict:
    day = kb_core.today_for(db, email)
    _seed(db, email, day)
    due = (db.query(models.KbRefresherItem).filter(models.KbRefresherItem.user_email == email, models.KbRefresherItem.due_on <= day)
           .order_by(models.KbRefresherItem.due_on, models.KbRefresherItem.created_at).all())
    answered_today = sum(1 for r in db.query(models.KbRefresherItem).filter(models.KbRefresherItem.user_email == email).all()
                        if (r.last_answered_at or "")[:10] == day)
    items, courses = [], {}
    for r in due:
        if len(items) >= max(0, DAILY - answered_today):
            break
        c = courses.get(r.course_id) or db.get(models.KbCourse, r.course_id)
        if c is None:
            continue
        courses[r.course_id] = c
        q = next((x for x in _settings(c) if x["_id"] == r.question_id), None)
        if q is None:
            continue
        opts = list(range(len(q.get("options") or [])))
        if q.get("type") in ("single", "multi", "order"):
            random.shuffle(opts)
        pub = _public(q)
        pub["options"] = [q["options"][i] for i in opts] if opts else []
        items.append({"item_id": r.id, "course_id": c.id, "course_title": c.title, "question": pub, "order": opts, "interval_days": r.interval_days})
    total = db.query(models.KbRefresherItem).filter(models.KbRefresherItem.user_email == email).count()
    db.commit()
    return {"items": items, "due": len(due), "answered_today": answered_today, "daily": DAILY, "streak": _streak(db, email, day),
            "total": total, "day": day}


def answer(db, email: str, item_id: str, given) -> dict:
    from fastapi import HTTPException
    from routers.kb_training import _is_correct
    r = db.query(models.KbRefresherItem).filter(models.KbRefresherItem.id == item_id, models.KbRefresherItem.user_email == email).first()
    if r is None:
        raise HTTPException(404, "Not one of your refresher questions")
    c = db.get(models.KbCourse, r.course_id)
    q = next((x for x in _settings(c) if x["_id"] == r.question_id), None) if c is not None else None
    if q is None:
        raise HTTPException(404, "This question is no longer in the course")
    order = None
    if isinstance(given, dict):
        order = given.get("order") if isinstance(given.get("order"), list) else None
        given = given.get("answer")
    ok, answered = _is_correct(q, given, order)
    if not answered:
        raise HTTPException(400, "Answer the question first")
    day = kb_core.today_for(db, email)
    if ok:
        r.interval_days = min(MAX_INTERVAL, max(1, int(r.interval_days or 1)) * 2)
        r.right_count = int(r.right_count or 0) + 1
    else:
        r.interval_days = 1
        r.wrong_count = int(r.wrong_count or 0) + 1
    r.due_on = kb_core.add_days(day, r.interval_days)
    r.last_answered_at = kb_core.now()
    db.commit()
    correct = None
    if q.get("type") in ("single", "multi", "tf"):
        correct = [q["options"][i] for i in q.get("answer") or [] if 0 <= i < len(q["options"])]
    elif q.get("type") == "order":
        correct = list(q.get("options") or [])
    return {"correct": ok, "explanation": q.get("explanation") or "", "answer": correct, "next_in_days": r.interval_days,
            "streak": _streak(db, email, day)}
