"""The weather call's API (Weather Call, Phase 2 - Oct 2026). See
weather_call.py for what a call does; this file is the routes.

  GET  /weather-call/{group}/{date}           the screen (outlook, roster, decision, canDecide)
  POST /weather-call/{group}/{date}           make the call
  POST /weather-call/{decision}/reinstate     undo it
  POST /weather-call/{decision}/remind        a second text to the silent, by hand
  POST /weather-call/{decision}/ack           acknowledge from inside Nexus (My Shifts)
  GET  /weather-call/ack?t=                   the call, with an Acknowledge button (signed link, no sign-in)
  POST /weather-call/ack  (form: t)           the button: acknowledges. GET never changes anything.
  GET/PUT /weather-call/my-prefs              a person's own texts switch
  GET  /weather-call/mine                     the open calls on the caller's shifts (My Shifts)
"""
import asyncio
import json
from datetime import date, timedelta
from html import escape
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import weather_call
from auth import get_current_user
from database import SessionLocal, get_db
from routers.timeclock import require_shift_manage, _parse_day

router = APIRouter(prefix="/weather-call", tags=["weather-call"])


def _group_or_404(db: Session, group_id: str):
    g = db.query(models.ShiftGroup).filter(models.ShiftGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Group not found")
    return g


def _decision_or_404(db: Session, decision_id: str):
    d = db.query(models.WeatherDecision).filter(models.WeatherDecision.id == decision_id).first()
    if not d:
        raise HTTPException(404, "Weather call not found")
    return d


def _require_decider(db: Session, user: dict, g, company_id: str) -> None:
    if not weather_call.may_decide(db, user, g, company_id):
        raise HTTPException(403, "Only this group's weather deciders, its schedulers, the company's managers or an administrator can make the weather call.")


# ── Public: the acknowledgment link ──────────────────────────────────────

_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} - Nexus</title>
<style>body{{margin:0;background:#f3f4f6;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#111827}}
.card{{max-width:480px;margin:48px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px}}
h1{{font-size:20px;margin:0 0 10px}} p{{font-size:15px;line-height:1.55;color:#374151;margin:0}}
.ok{{display:inline-block;width:40px;height:40px;border-radius:50%;background:#dcfce7;color:#15803d;text-align:center;line-height:40px;font-size:22px;margin-bottom:12px}}
button{{margin-top:18px;border:none;border-radius:8px;background:#248f4b;color:#fff;font:600 15px 'Segoe UI',Arial,sans-serif;padding:12px 26px;cursor:pointer}}</style></head>
<body><div class="card">{mark}<h1>{title}</h1><p>{text}</p>{form}</div></body></html>"""


def _render(status: int, title: str, text: str, show_button: bool, token: str) -> HTMLResponse:
    mark = '<div class="ok">&#10003;</div>' if status == 200 and not show_button else ""
    form = (f'<form method="post" action="/weather-call/ack"><input type="hidden" name="t" value="{escape(token)}">'
            '<button type="submit">Acknowledge</button></form>') if show_button else ""
    return HTMLResponse(_PAGE.format(title=escape(title), text=escape(text), mark=mark, form=form), status_code=status)


@router.get("/ack", response_class=HTMLResponse)
def ack_by_link(t: str = "", db: Session = Depends(get_db)):
    """The tap from a text or an email: the call and an Acknowledge button.
    The signed token is the credential - no sign-in - same as the task
    email buttons (routers/mail_actions.py). GET only shows: a mail scanner
    that prefetches the link must not acknowledge for the person."""
    return _render(*weather_call.ack_page(db, t, do=False), t)


def _ack_submit_sync(token: str) -> HTMLResponse:
    db = SessionLocal()
    try:
        return _render(*weather_call.ack_page(db, token, do=True), token)
    finally:
        db.close()


@router.post("/ack", response_class=HTMLResponse)
async def ack_submit(request: Request):
    """The button on the page above (a form POST; CSRF-exempt in main.py like
    /mail-actions/page - the token is the credential). DB work in a thread."""
    form = await request.form()
    return await asyncio.to_thread(_ack_submit_sync, str(form.get("t") or ""))


# ── Mine ──────────────────────────────────────────────────────────────────

@router.get("/mine")
def my_calls(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The weather calls on the caller's upcoming days that still want an
    acknowledgment, newest first - My Shifts shows them with the button."""
    me = (user.get("email") or "").lower()
    out = []
    # Yesterday onward (a day that has passed needs no acknowledgment), and
    # only calls that name this person - matched in SQL before the limit,
    # so a busy company's other calls never push theirs out.
    since = (date.today() - timedelta(days=1)).isoformat()
    for d in (db.query(models.WeatherDecision)
              .filter(models.WeatherDecision.status.in_(["active", "reinstated"]),
                      models.WeatherDecision.work_date >= since,
                      models.WeatherDecision.people_json.like(f'%"{me}"%'))
              .order_by(models.WeatherDecision.decided_at.desc()).limit(60).all()):
        try:
            ppl = json.loads(d.people_json or "[]")
        except (TypeError, ValueError):
            continue
        p = next((x for x in ppl if x["email"] == me and x.get("selected")), None)
        if not p:
            continue
        g = db.query(models.ShiftGroup).filter(models.ShiftGroup.id == d.group_id).first()
        out.append({"id": d.id, "groupName": g.name if g else "", "date": d.work_date, "kind": d.kind, "status": d.status,
                    "outcome": p.get("outcome"), "reason": d.reason or "", "newStart": d.new_start or "", "newEnd": d.new_end or "",
                    "moveTo": d.move_to or "", "decidedAt": d.decided_at, "ackAt": p.get("ackAt") or "",
                    "headline": weather_call.headline(d.kind, d.new_start, d.new_end, d.move_to) if d.status == "active"
                    else "Weather call reversed: your shift is back on"})
    return {"calls": out}


@router.post("/{decision_id}/ack")
def ack_in_app(decision_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    hit = weather_call.acknowledge(db, decision_id, user["email"], "app")
    if not hit:
        raise HTTPException(404, "This weather call is not on your schedule.")
    return {"ok": True, "ackAt": hit.get("ackAt", "")}


class PrefsIn(BaseModel):
    weatherSms: Optional[bool] = None


@router.get("/my-prefs")
def my_prefs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(models.NexusPersonPref).filter(models.NexusPersonPref.email == user["email"].lower()).first()
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == user["email"].lower()).first()
    return {"weatherSms": bool(int(row.weather_sms if row is not None and row.weather_sms is not None else 1)),
            "phone": bool(emp is not None and (emp.phone or "").strip())}


@router.put("/my-prefs")
def save_my_prefs(body: PrefsIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    em = user["email"].lower()
    row = db.query(models.NexusPersonPref).filter(models.NexusPersonPref.email == em).first()
    if not row:
        row = models.NexusPersonPref(email=em)
        db.add(row)
    if body.weatherSms is not None:
        row.weather_sms = 1 if body.weatherSms else 0
    row.updated_at = weather_call._iso()
    db.commit()
    return my_prefs(user, db)


# ── The call ──────────────────────────────────────────────────────────────

@router.get("/{group_id}/{day}")
def read_screen(group_id: str, day: str, user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    g = _group_or_404(db, group_id)
    day = _parse_day(day, "date").isoformat()
    return weather_call.screen(db, user, g, day)


@router.post("/{decision_id}/reinstate")
def reinstate_call(decision_id: str, user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    d = _decision_or_404(db, decision_id)
    g = _group_or_404(db, d.group_id)
    _require_decider(db, user, g, d.company)
    try:
        return weather_call.reinstate(db, user, d)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/{decision_id}/remind")
def remind_call(decision_id: str, user: dict = Depends(require_shift_manage), db: Session = Depends(get_db)):
    d = _decision_or_404(db, decision_id)
    g = _group_or_404(db, d.group_id)
    _require_decider(db, user, g, d.company)
    if d.status != "active":
        raise HTTPException(409, "This weather call is no longer active.")
    n = weather_call.remind_silent(db, d, user["email"])
    return {"reminded": n, "decision": weather_call.decision_dict(db, d)}


# Declared LAST: a two-segment POST would otherwise swallow /{decision_id}/reinstate and /remind.
class DecideIn(BaseModel):
    kind: str
    emails: List[str] = []
    new_start: Optional[str] = None
    new_end: Optional[str] = None
    move_to: Optional[str] = None
    reason: str = ""
    sms: Optional[bool] = None


@router.post("/{group_id}/{day}")
def make_call(group_id: str, day: str, body: DecideIn, user: dict = Depends(require_shift_manage),
              db: Session = Depends(get_db)):
    g = _group_or_404(db, group_id)
    day = _parse_day(day, "date").isoformat()
    import weather_watch
    cid = weather_watch.group_company(db, g, weather_call._members(db, g.id))
    _require_decider(db, user, g, cid)
    try:
        return weather_call.decide(db, user, g, day, body.model_dump())
    except ValueError as e:
        db.rollback()
        raise HTTPException(400, str(e))
