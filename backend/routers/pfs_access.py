"""PFS file lock: a one-time code per FILE, not per module (Charmi, 10/04).

"Add a lock icon next to the different files and when we try to click it, it
should ask for OTP to the file and not to the module, and it should send a
notification to the borrowers via email that your PFS was accessed by this
person at this time, and it should maintain a log."

How it works
  - Every guarantor (a pfs_profiles row - the "file") is locked. Opening one
    asks for a six-digit code, emailed to the person opening it (the viewer,
    never the borrower) through the same Microsoft Graph sender every other
    Nexus email uses (graph_mail).
  - The code is never stored: `code_hash` is sha256("challenge_id:code"),
    salted with an id the caller never sees. It lives 10 minutes, takes 5
    wrong tries, and a new code voids the one before it. Sending is limited
    to one code per 30 seconds and 10 an hour per person.
  - A correct code opens THAT file, for THAT browser session (the
    X-Pfs-Session header, a random id the tab keeps in sessionStorage), for
    30 minutes. A code minted for one file never opens another, and a code
    used in one tab does not open the file in another person's tab.
  - The lock is enforced HERE, on the server, by `file_gate` - a dependency
    on the whole /pfs router (routers/pfs.py) and on the affiliated entities
    router: every read, write and export of a file's data answers 423 until
    the file is open. The front end only follows what the server says.
  - On every unlock the borrowers of the file (the borrower's and the
    co-borrower's email on the Borrower tab) get an email: "Your personal
    financial statement was accessed by <name> on <MM/DD/YYYY at h:mm AM/PM>".
    A borrower opening their own file is not emailed about it.
  - pfs_access_log keeps who, which file, when and what: otp_sent, unlocked,
    failed, viewed, exported, locked, notified. Never a figure, never a code.

Local development (NEXUS_SKIP_AUTH=true): no email is sent - the code is
printed to the server console, so the lock can be tried without a mailbox.
A deployed API with no Graph credentials fails closed (503): a file must never
open on a code that was only ever printed to a log.
"""
import hashlib
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import graph_mail
import models
from auth import require_module_grant
from database import SessionLocal, get_db

_read = require_module_grant("pfs", "viewer", bypass_level="owner")
_edit = require_module_grant("pfs", "editor", bypass_level="owner")

router = APIRouter(prefix="/pfs-access", tags=["Personal Financial Statements - file lock"], dependencies=[Depends(_read)])

CODE_TTL_SEC = 600            # 10 minutes to type the code in
MAX_ATTEMPTS = 5              # wrong tries per code before it is burned
RESEND_COOLDOWN_SEC = 30
MAX_CODES_PER_HOUR = 10       # per person, every file together
UNLOCK_TTL_SEC = 1800         # one code opens the file for 30 minutes
VIEW_LOG_GAP_SEC = 600        # a file re-read every few seconds logs "viewed" once per 10 minutes

# The switch the lock hangs on. On everywhere; the older PFS tests turn it off
# (the lock has its own tests in test_pfs_access.py).
LOCK_ENABLED = os.getenv("NEXUS_PFS_FILE_LOCK", "on").strip().lower() not in ("off", "0", "false", "no")
_ON_AZURE = bool(os.getenv("WEBSITE_SITE_NAME"))
SESSION_HEADER = "X-Pfs-Session"
ACTIONS = ("otp_sent", "unlocked", "failed", "viewed", "exported", "locked", "notified")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def _hash_code(challenge_id: str, code: str) -> str:
    return hashlib.sha256(f"{challenge_id}:{code}".encode()).hexdigest()


def session_hash(request: Request) -> str:
    """The browser session a grant belongs to: a hash of the tab's random
    X-Pfs-Session id (never stored as sent)."""
    raw = (request.headers.get(SESSION_HEADER) or "").strip()[:200]
    return hashlib.sha256(f"pfs-session:{raw}".encode()).hexdigest()


def _ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else ""))[:60]


def log(db: Session, profile_id: str, email: str, action: str, ip: str = "", details: Optional[dict] = None) -> None:
    """One access-log row. `details` names things (a statement id, a format, a
    masked address) - never a figure and never a code."""
    db.add(models.PfsAccessLog(id=str(uuid.uuid4()), profile_id=profile_id, email=(email or "").lower(), action=action,
                               at=_iso(_now()), ip=ip, details=details or {}))


def mask_email(email: str) -> str:
    if "@" not in (email or ""):
        return "••••"
    user, dom = email.split("@", 1)
    return (user[:1] + "•" * max(2, len(user) - 1)) + "@" + dom


def person_name(db: Session, email: str) -> str:
    """The name Nexus People has for an email; the email's own name otherwise."""
    e = (email or "").strip().lower()
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == e).first()
    if emp and (emp.first_name or "").strip():
        return f"{emp.first_name} {emp.last_name or ''}".strip()
    return e.split("@")[0].replace(".", " ").title() if e else "Someone"


def us_datetime(dt: datetime) -> str:
    """MM/DD/YYYY at h:mm AM/PM, Pacific time (the company's clock)."""
    try:
        from zoneinfo import ZoneInfo
        local, tz = dt.astimezone(ZoneInfo("America/Los_Angeles")), "PT"
    except Exception:   # no tz database on this machine
        local, tz = dt.astimezone(timezone.utc), "UTC"
    hour = local.strftime("%I").lstrip("0") or "12"
    return f"{local.strftime('%m/%d/%Y')} at {hour}:{local.strftime('%M %p')} {tz}"


def _profile(db: Session, profile_id: str) -> models.PfsProfile:
    p = db.query(models.PfsProfile).filter(models.PfsProfile.id == profile_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return p


def borrower_emails(p: models.PfsProfile) -> list[str]:
    """Where a borrower is told about an unlock: the borrower's email and the
    co-borrower's, from the Borrower tab."""
    d = p.details if isinstance(p.details, dict) else {}
    co = d.get("coBorrower") if isinstance(d.get("coBorrower"), dict) else {}
    out = []
    for e in (d.get("email"), co.get("email")):
        e = (e or "").strip().lower()
        if e and "@" in e and e not in out:
            out.append(e)
    return out


# ── The grant ────────────────────────────────────────────────────────────────
def active_grant(db: Session, email: str, profile_id: str, sess: str) -> Optional[models.PfsAccessChallenge]:
    """The used code currently opening this file for this person in this
    browser session, or None."""
    now = _iso(_now())
    return (db.query(models.PfsAccessChallenge)
            .filter(models.PfsAccessChallenge.email == (email or "").lower(),
                    models.PfsAccessChallenge.profile_id == profile_id,
                    models.PfsAccessChallenge.session_hash == sess,
                    models.PfsAccessChallenge.consumed_at != "",
                    models.PfsAccessChallenge.granted_until > now)
            .order_by(models.PfsAccessChallenge.granted_until.desc()).first())


def grant_now(db: Session, email: str, profile_id: str, request: Request, why: str = "created") -> None:
    """Open a file without a code - only for the person who just CREATED it
    (there is nothing in it yet to protect). Logged like any unlock."""
    now = _now()
    db.add(models.PfsAccessChallenge(
        id=str(uuid.uuid4()), profile_id=profile_id, email=(email or "").lower(), session_hash=session_hash(request),
        code_hash="", attempts=0, created_at=_iso(now), expires_at=_iso(now), consumed_at=_iso(now),
        granted_until=_iso(now + timedelta(seconds=UNLOCK_TTL_SEC)), target=""))
    log(db, profile_id, email, "unlocked", _ip(request), {"how": why})


def _locked(profile_id: str) -> HTTPException:
    return HTTPException(status_code=423, detail={"code": "pfs_locked", "profileId": profile_id,
                                                  "message": "This file is locked. Request a one-time code to open it."})


def file_gate(request: Request, user: dict = Depends(_read)) -> None:
    """The lock, on every route of a file: a path with {profile_id} (or a kept
    statement's {statement_id}, which belongs to one) answers 423 unless the
    caller opened that file with a code in this browser session. Routes without
    either (the list of files, the vocabulary, the ledger pickers) pass.
    Also writes the "viewed" and "exported" rows of the access log."""
    if not LOCK_ENABLED:
        return
    pid = request.path_params.get("profile_id")
    sid = request.path_params.get("statement_id")
    if not pid and not sid:
        return
    db = SessionLocal()
    try:
        if not pid:
            s = db.query(models.PfsStatement).filter(models.PfsStatement.id == sid).first()
            if not s:
                return          # the route answers 404 itself
            pid = s.profile_id
        if not db.query(models.PfsProfile.id).filter(models.PfsProfile.id == pid).first():
            return              # 404 from the route, not a lock on nothing
        if not active_grant(db, user["email"], pid, session_hash(request)):
            raise _locked(pid)
        route = getattr(request.scope.get("route"), "path", "") or ""
        method = request.method.upper()
        if method == "GET" and route == "/pfs/profiles/{profile_id}":
            gap = _iso(_now() - timedelta(seconds=VIEW_LOG_GAP_SEC))
            recent = (db.query(models.PfsAccessLog.id)
                      .filter(models.PfsAccessLog.profile_id == pid, models.PfsAccessLog.email == user["email"].lower(),
                              models.PfsAccessLog.action == "viewed", models.PfsAccessLog.at > gap).first())
            if not recent:
                log(db, pid, user["email"], "viewed", _ip(request))
                db.commit()
        elif (method == "POST" and route == "/pfs/profiles/{profile_id}/statements") or (method == "GET" and route == "/pfs/statements/{statement_id}"):
            log(db, pid, user["email"], "exported", _ip(request), {"statement": sid} if sid else {"produced": True})
            db.commit()
    finally:
        db.close()


# ── Email ────────────────────────────────────────────────────────────────────
def _shell(title: str, body: str) -> str:
    return f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:#14532d;padding:22px 32px">
      <div style="color:#ffffff;font-size:18px;font-weight:800">Greens Nexus</div>
      <div style="color:#bbf7d0;font-size:12.5px;margin-top:4px">{escape(title)}</div>
    </td></tr>
    <tr><td style="padding:24px 32px;font-size:14px;color:#374151;line-height:1.6">{body}</td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 32px;font-size:11.5px;color:#6b7280;line-height:1.5">
      This is an automated message. Please do not reply.
    </td></tr>
  </table>
</div>"""


def _code_email(code: str, file_name: str) -> str:
    return _shell("Personal Financial Statement - Access Code", f"""
      <p style="margin:0 0 14px">Use this code to open the personal financial statement of <strong>{escape(file_name)}</strong> in Nexus.</p>
      <div style="font-family:Consolas,Menlo,Courier New,monospace;font-size:30px;font-weight:800;letter-spacing:7px;color:#111827;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px 18px;margin:0 0 14px">{escape(code)}</div>
      <p style="margin:0;font-size:12.5px;color:#6b7280">The code expires in 10 minutes and opens this one file for 30 minutes. If you did not ask for it, tell your administrator - the borrower is told every time their file is opened.</p>""")


def _notice_email(viewer: str, when: str) -> str:
    return _shell("Personal Financial Statement - Access Notice", f"""
      <p style="margin:0 0 12px">Your personal financial statement was accessed by <strong>{escape(viewer)}</strong> on {escape(when)}.</p>
      <p style="margin:0;font-size:12.5px;color:#6b7280">Nexus sends this every time your file is opened. If you did not expect it, contact the accounting team.</p>""")


def _send(to: list[str], subject: str, html: str) -> None:
    graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=to, cc=None, subject=subject, html=html)


def _deliver_code(to_email: str, code: str, file_name: str) -> None:
    """Email the code to the viewer. Local dev (NEXUS_SKIP_AUTH): printed to the
    server console instead. A deployed API without mail fails closed."""
    if auth.SKIP_AUTH and not _ON_AZURE:
        print(f"[pfs-lock] DEV (NEXUS_SKIP_AUTH) - code for {to_email}, file {file_name!r}: {code}")
        return
    if not graph_mail.graph_configured():
        print("[pfs-lock] Graph mail not configured - PFS access code NOT sent (fail-closed)")
        raise HTTPException(status_code=503, detail="Access codes cannot be emailed from this deployment yet.")
    try:
        _send([to_email], "Your Nexus PFS access code", _code_email(code, file_name))
    except graph_mail.GraphMailError as e:
        print(f"[pfs-lock] code email failed: {e}")
        raise HTTPException(status_code=502, detail="Could not email the code. Please try again in a moment.")


def notify_borrowers(profile_id: str, viewer_email: str, at_iso: str) -> None:
    """Tell the file's borrowers it was opened (after the response: a mail
    outage never keeps a file shut). The outcome goes to the access log."""
    db = SessionLocal()
    try:
        p = db.query(models.PfsProfile).filter(models.PfsProfile.id == profile_id).first()
        if not p:
            return
        to = [e for e in borrower_emails(p) if e != (viewer_email or "").lower()]
        if not to:
            return
        when = us_datetime(_parse(at_iso) or _now())
        viewer = person_name(db, viewer_email)
        sent, error = False, ""
        if auth.SKIP_AUTH and not _ON_AZURE:
            print(f"[pfs-lock] DEV - would tell {', '.join(to)}: accessed by {viewer} on {when}")
            sent = True
        elif graph_mail.graph_configured():
            try:
                _send(to, "Your personal financial statement was accessed", _notice_email(viewer, when))
                sent = True
            except graph_mail.GraphMailError as e:
                error = str(e)[:200]
        else:
            error = "mail not configured"
        log(db, profile_id, viewer_email, "notified", "", {"to": [mask_email(e) for e in to], "sent": sent, **({"error": error} if error else {})})
        db.commit()
    finally:
        db.close()


# ── Routes ───────────────────────────────────────────────────────────────────
@router.get("/status")
def status(request: Request, user: dict = Depends(_read), db: Session = Depends(get_db)):
    """Which files are open for the caller in this browser session, until when."""
    now = _iso(_now())
    rows = (db.query(models.PfsAccessChallenge)
            .filter(models.PfsAccessChallenge.email == user["email"].lower(),
                    models.PfsAccessChallenge.session_hash == session_hash(request),
                    models.PfsAccessChallenge.consumed_at != "",
                    models.PfsAccessChallenge.granted_until > now).all())
    unlocked: dict[str, str] = {}
    for r in rows:
        if r.granted_until > unlocked.get(r.profile_id, ""):
            unlocked[r.profile_id] = r.granted_until
    return {"lockEnabled": LOCK_ENABLED, "unlockMinutes": UNLOCK_TTL_SEC // 60, "unlocked": unlocked if LOCK_ENABLED else {}}


@router.post("/files/{file_id}/code")
def request_code(file_id: str, request: Request, user: dict = Depends(_read), db: Session = Depends(get_db)):
    """Email the caller a code that opens this one file."""
    p = _profile(db, file_id)
    email = user["email"].lower()
    now = _now()
    mine = db.query(models.PfsAccessChallenge).filter(models.PfsAccessChallenge.email == email, models.PfsAccessChallenge.code_hash != "")
    last = mine.order_by(models.PfsAccessChallenge.created_at.desc()).first()
    if last and (created := _parse(last.created_at)) and (now - created).total_seconds() < RESEND_COOLDOWN_SEC:
        wait = int(RESEND_COOLDOWN_SEC - (now - created).total_seconds()) + 1
        raise HTTPException(status_code=429, detail=f"Please wait {wait} seconds before asking for another code.")
    if mine.filter(models.PfsAccessChallenge.created_at > _iso(now - timedelta(hours=1))).count() >= MAX_CODES_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many codes this hour. Try again later.")

    cid = str(uuid.uuid4())
    code = f"{secrets.randbelow(1_000_000):06d}"
    _deliver_code(email, code, p.name)
    # A new code voids every unused one for this file: "the code we sent" is one code.
    (db.query(models.PfsAccessChallenge)
     .filter(models.PfsAccessChallenge.email == email, models.PfsAccessChallenge.profile_id == file_id,
             models.PfsAccessChallenge.consumed_at == "")
     .update({models.PfsAccessChallenge.expires_at: _iso(now)}, synchronize_session=False))
    db.add(models.PfsAccessChallenge(
        id=cid, profile_id=file_id, email=email, session_hash=session_hash(request), code_hash=_hash_code(cid, code),
        attempts=0, created_at=_iso(now), expires_at=_iso(now + timedelta(seconds=CODE_TTL_SEC)), consumed_at="",
        granted_until="", target=email))
    log(db, file_id, email, "otp_sent", _ip(request), {"to": mask_email(email)})
    db.commit()
    return {"sentTo": mask_email(email), "expiresIn": CODE_TTL_SEC}


class VerifyBody(BaseModel):
    code: str


@router.post("/files/{file_id}/verify")
def verify(file_id: str, body: VerifyBody, request: Request, background: BackgroundTasks,
           user: dict = Depends(_read), db: Session = Depends(get_db)):
    """Check the code; a right one opens the file for 30 minutes in this
    browser session and tells the borrowers."""
    _profile(db, file_id)
    email = user["email"].lower()
    sess = session_hash(request)
    code = re.sub(r"\D", "", body.code or "")[:6]
    now = _now()
    row = (db.query(models.PfsAccessChallenge)
           .filter(models.PfsAccessChallenge.email == email, models.PfsAccessChallenge.profile_id == file_id,
                   models.PfsAccessChallenge.session_hash == sess, models.PfsAccessChallenge.consumed_at == "",
                   models.PfsAccessChallenge.code_hash != "")
           .order_by(models.PfsAccessChallenge.created_at.desc()).first())
    if row is None:
        raise HTTPException(status_code=400, detail="Ask for a code first.")
    expires = _parse(row.expires_at)
    if expires is None or now >= expires:
        raise HTTPException(status_code=400, detail="That code has expired. Ask for a new one.")
    if (row.attempts or 0) >= MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many wrong codes. Ask for a new one.")
    if len(code) != 6 or not secrets.compare_digest(_hash_code(row.id, code), row.code_hash or ""):
        row.attempts = (row.attempts or 0) + 1
        log(db, file_id, email, "failed", _ip(request), {"attempt": row.attempts})
        db.commit()
        left = MAX_ATTEMPTS - row.attempts
        raise HTTPException(status_code=400 if left > 0 else 429,
                            detail=f"That code is not right. {left} {'try' if left == 1 else 'tries'} left." if left > 0
                            else "Too many wrong codes. Ask for a new one.")
    row.consumed_at = _iso(now)
    row.granted_until = _iso(now + timedelta(seconds=UNLOCK_TTL_SEC))
    log(db, file_id, email, "unlocked", _ip(request), {"until": row.granted_until})
    db.commit()
    background.add_task(notify_borrowers, file_id, email, row.consumed_at)
    return {"profileId": file_id, "unlockedUntil": row.granted_until}


@router.post("/files/{file_id}/lock", status_code=204)
def lock(file_id: str, request: Request, user: dict = Depends(_read), db: Session = Depends(get_db)):
    """Close the file again in this browser session before the 30 minutes run out."""
    now = _iso(_now())
    n = (db.query(models.PfsAccessChallenge)
         .filter(models.PfsAccessChallenge.email == user["email"].lower(), models.PfsAccessChallenge.profile_id == file_id,
                 models.PfsAccessChallenge.session_hash == session_hash(request), models.PfsAccessChallenge.granted_until > now)
         .update({models.PfsAccessChallenge.granted_until: now}, synchronize_session=False))
    if n:
        log(db, file_id, user["email"], "locked", _ip(request))
    db.commit()


@router.get("/log")
def access_log(profile_id: Optional[str] = Query(None), limit: int = Query(200, ge=1, le=1000),
               user: dict = Depends(_edit), db: Session = Depends(get_db)):
    """The access log, newest first (owners and editors): who, which file,
    when, what. Names of files come along so the log reads on its own."""
    q = db.query(models.PfsAccessLog)
    if profile_id:
        q = q.filter(models.PfsAccessLog.profile_id == profile_id)
    rows = q.order_by(models.PfsAccessLog.at.desc()).limit(limit).all()
    names = {p.id: p.name for p in db.query(models.PfsProfile.id, models.PfsProfile.name)
             .filter(models.PfsProfile.id.in_({r.profile_id for r in rows} or {""})).all()}
    return [{"id": r.id, "profileId": r.profile_id, "fileName": names.get(r.profile_id, "(removed)"), "email": r.email,
             "action": r.action, "at": r.at, "ip": r.ip or "", "details": r.details if isinstance(r.details, dict) else {}} for r in rows]
