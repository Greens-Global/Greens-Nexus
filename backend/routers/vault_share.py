"""The page a person OUTSIDE Nexus opens from a shared-login email
(Pranshu, 11/13/2026; the rules are vault_external.py's).

No Nexus login - the link's token is half the key, the one-time code the other:

  GET  /vault-share/{token}          what is shared and with whom, never a secret
  POST /vault-share/{token}/code     sends a code to the invited email (or SMS
                                     when the sharer gave a mobile number)
  POST /vault-share/{token}/verify   the code -> username, link, password (and
                                     the 6-digit authenticator code), once

Every answer is no-store; the routes sit on the tight per-IP rate limit
(middleware_hardening SENSITIVE_PREFIXES); a code has 5 tries and 10 minutes,
and a share takes 10 codes an hour at most. Each step is in the login's
Activity log with the network address and browser.
"""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import vault_external
import vault_totp
from database import get_db

router = APIRouter(prefix="/vault-share", tags=["Credential Vault - outside share"])

PURPOSE = "external_share"
CODES_PER_HOUR = 10


def _cv():
    from routers import credvault
    return credvault


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"


def _who(share) -> dict:
    return {"email": share.email}


def _remember(request: Request) -> None:
    from middleware_hardening import _client_ip
    _cv()._REQ.set((_client_ip(request) or "", (request.headers.get("user-agent") or "")[:300]))


def _live(db: Session, token: str):
    """(share, cred) for a live share; 404 for an unknown link, 410 once it ended."""
    share = vault_external.find(db, token)
    cred = db.get(models.VaultCredential, share.cred_id) if share else None
    if not share or not cred:
        raise HTTPException(404, "This link is not valid.")
    if vault_external.state(share) != "active" or cred.deleted_at:
        raise HTTPException(410, "This share has ended. Ask the person who shared it for a new one.")
    return share, cred


@router.get("/{token}")
def peek(token: str, request: Request, response: Response, db: Session = Depends(get_db)):
    _no_store(response)
    cv = _cv()
    share = vault_external.find(db, token)
    cred = db.get(models.VaultCredential, share.cred_id) if share else None
    if not share or not cred:
        raise HTTPException(404, "This link is not valid.")
    st = "ended" if cred.deleted_at else vault_external.state(share)
    if not share.first_opened_at:
        share.first_opened_at = cv._now()
        _remember(request)
        cv._log(db, _who(share), "Outside Share Opened", cred.name, cred.dept, cred.id)
        db.commit()
    return {"state": st, "name": cred.name, "company": cv._company_name(db, cred.company_id or "") or "Greens Global",
            "sharedBy": cv._display_name(share.shared_by, db), "until": cv._ms(share.expires_at),
            "email": cv._mask_email(share.email), "sms": cv._mask_phone(share.phone) if share.phone else ""}


class CodeIn(BaseModel):
    channel: str = "email"


@router.post("/{token}/code")
def send_code(token: str, body: CodeIn, request: Request, response: Response, db: Session = Depends(get_db)):
    _no_store(response)
    cv = _cv()
    share, cred = _live(db, token)
    key = f"ext:{share.id}"
    recent = (db.query(models.VaultOtpChallenge)
              .filter(models.VaultOtpChallenge.email == key, models.VaultOtpChallenge.purpose == PURPOSE)
              .order_by(models.VaultOtpChallenge.created_at.desc()).all())
    hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    if len([r for r in recent if (r.created_at or "") >= hour_ago]) >= CODES_PER_HOUR:
        raise HTTPException(429, "Too many codes for this link - try again in an hour.")
    if recent and cv._seconds_since(recent[0].created_at) < cv.OTP_RESEND_COOLDOWN_SEC:
        wait = max(1, int(cv.OTP_RESEND_COOLDOWN_SEC - cv._seconds_since(recent[0].created_at)))
        raise HTTPException(429, f"Please wait {wait}s before asking again.")
    channel = "sms" if body.channel == "sms" and share.phone else "email"
    code, cid = cv._gen_otp_code(), str(uuid.uuid4())
    if channel == "sms":
        dev, masked = cv._send_sms_or_stub(share.phone, code), cv._mask_phone(share.phone)
    else:
        dev, masked = cv._send_email_otp(share.email, code), cv._mask_email(share.email)
    db.add(models.VaultOtpChallenge(
        id=cid, email=key, purpose=PURPOSE, channel=channel, target=share.phone if channel == "sms" else share.email,
        code_hash=cv._hash_otp_code(cid, code), attempts=0, consumed_at="",
        expires_at=(datetime.now(timezone.utc) + timedelta(seconds=cv.OTP_CODE_TTL_SEC)).isoformat(), created_at=cv._now()))
    _remember(request)
    cv._log(db, _who(share), "Outside Share Code Sent", cred.name, cred.dept, cred.id, detail=[{"field": "By", "from": "", "to": channel}])
    db.commit()
    out = {"challengeId": cid, "channel": channel, "target": masked, "expiresInSec": cv.OTP_CODE_TTL_SEC}
    if dev:
        out["devCode"] = dev
    return out


class VerifyIn(BaseModel):
    challengeId: str = ""
    code: str = ""


@router.post("/{token}/verify")
def verify(token: str, body: VerifyIn, request: Request, response: Response, db: Session = Depends(get_db)):
    _no_store(response)
    cv = _cv()
    share, cred = _live(db, token)
    cv._consume_otp_challenge(db, body.challengeId, f"ext:{share.id}", PURPOSE, body.code)
    share.views = (share.views or 0) + 1
    share.last_viewed_at = cv._now()
    _remember(request)
    cv._log(db, _who(share), "Outside Share Viewed", cred.name, cred.dept, cred.id)
    db.commit()
    out = {"name": cred.name, "username": "" if (cred.username or "") == "-" else (cred.username or ""), "url": cred.url or "",
           "secret": cv._dec(cred.secret_enc), "until": cv._ms(share.expires_at)}
    if cred.totp_enc:
        code, left = vault_totp.code_at(cv._dec(cred.totp_enc))
        out["totp"] = {"code": code, "left": left}
    return out
