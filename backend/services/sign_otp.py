"""Nexus Sign one-time codes - mandatory second factor on every signature.

Why this is its own module rather than more columns on HrSignParty: the code
is evidence, and evidence needs a row with its own lifetime. A party that
re-opens a link a week later gets a NEW challenge; the old one stays, spent,
with the channel and the moment it was accepted. The certificate reads those
rows, so "verified by a one-time code sent to j•••@example.com at 09:22" is a
statement backed by a record rather than by a boolean nobody can audit.

Scope is (party, envelope), never the person. An external signer has no Nexus
account to key on, and a code minted for one envelope must never open another
- so party_id IS the scope, unlike CredVault's email-keyed vault_otp_challenges
(routers/credvault.py), which this deliberately does not share a table with.

The plaintext code is never stored. `code_hash` is sha256("challenge_id:code"),
salted with an id the requester never learns, so the table alone is not
brute-forceable against a six-digit space.

Delivery reuses the two clients this codebase already has - graph_mail for
email, sentdm for SMS - so there is exactly one place each is configured.
"""
import hashlib
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

import graph_mail
import sentdm
from models import HrSignOtpChallenge

CODE_TTL_SEC = 600            # 10 minutes to type it in
MAX_ATTEMPTS = 5              # wrong tries per challenge before it is burned
RESEND_COOLDOWN_SEC = 30
# How long a verified code authorizes the signature it was minted for. Long
# enough to read a six-page packet and fill eight fields; short enough that a
# machine left open in a lobby does not stay able to sign all afternoon.
VERIFY_TTL_SEC = 1800

_ON_AZURE = bool(os.getenv("WEBSITE_SITE_NAME"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def _gen_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"


def _hash_code(challenge_id: str, code: str) -> str:
    return hashlib.sha256(f"{challenge_id}:{code}".encode()).hexdigest()


def mask_email(email: str) -> str:
    if "@" not in (email or ""):
        return "••••"
    user, dom = email.split("@", 1)
    return (user[:1] + "•" * max(2, len(user) - 1)) + "@" + dom


def mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return "•••• " + digits[-4:] if len(digits) >= 4 else "••••"


def channels_for(party) -> list[dict]:
    """What this signer may choose between. Email is always present - it is the
    address the envelope was sent to. SMS appears only when the SENDER supplied
    a number: Nexus never looks one up, because a guessed number would deliver
    a signing credential to a stranger."""
    out = []
    if (party.email or "").strip():
        out.append({"channel": "email", "masked": mask_email(party.email)})
    if sentdm.normalize_phone(party.phone or ""):
        out.append({"channel": "sms", "masked": mask_phone(party.phone)})
    return out


# ── delivery ─────────────────────────────────────────────────────────────────
# Both senders return the code when they ran the DEV STUB instead of really
# sending (no Graph creds / no sent.dm key on a laptop), so local testing works
# without a live mail or SMS account. On a DEPLOYED api they fail closed - a
# signature must never be authorized by a code that was only ever printed to a
# log.

def _otp_email_html(code: str, title: str, sender_name: str) -> str:
    from html import escape
    return f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f3f4f6;padding:28px 12px">
  <table style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-collapse:collapse;width:100%">
    <tr><td style="background:#14532d;padding:24px 34px">
      <div style="color:#ffffff;font-size:19px;font-weight:800">Nexus Sign</div>
      <div style="color:#bbf7d0;font-size:12.5px;margin-top:4px">Verification Code</div>
    </td></tr>
    <tr><td style="padding:26px 34px">
      <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.6">
        Use this code to verify your identity and sign
        <strong>{escape(title)}</strong>{(' from ' + escape(sender_name)) if sender_name else ''}.</p>
      <p style="margin:0 0 18px;font-size:32px;font-weight:800;letter-spacing:8px;color:#111827">{escape(code)}</p>
      <p style="margin:0;font-size:12.5px;color:#6b7280;line-height:1.6">
        This code expires in 10 minutes and can be used once.
        If you were not expecting it, you can ignore this email - nothing is signed without it.</p>
    </td></tr>
    <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 34px;font-size:11.5px;color:#6b7280;line-height:1.5">
      This is an automated message. Please do not reply.
    </td></tr>
  </table>
</div>"""


def _send_email(to_email: str, code: str, title: str, sender_name: str) -> str:
    if graph_mail.graph_configured():
        try:
            graph_mail.send_mail(
                from_email=graph_mail.DEFAULT_FROM_EMAIL, to=[to_email], cc=None,
                subject=f"Your Nexus Sign verification code: {code}",
                html=_otp_email_html(code, title, sender_name))
        except graph_mail.GraphMailError as e:
            print(f"[nexus-sign] OTP email failed: {e}")
            raise HTTPException(502, "Could not send the verification code by email. "
                                     "Please try again in a moment.")
        return ""
    if _ON_AZURE:
        print("[nexus-sign] Graph mail not configured on a DEPLOYED API - OTP NOT sent (fail-closed)")
        raise HTTPException(503, "Verification codes are not configured on this deployment yet.")
    print(f"[nexus-sign] EMAIL STUB (Graph not configured) - code for {to_email}: {code}")
    return code


def _send_sms(phone: str, code: str) -> str:
    if sentdm.configured():
        ok, err = sentdm.send_otp(
            phone, code,
            f"{code} is your Nexus Sign verification code. It expires in 10 minutes. Never share it.")
        if not ok:
            print(f"[nexus-sign] sent.dm SMS failed: {err}")
            raise HTTPException(502, "Could not send the code by text. Please choose email instead.")
        return ""
    if _ON_AZURE:
        print("[nexus-sign] NEXUS_SENTDM_KEY not set on a DEPLOYED API - OTP SMS NOT sent (fail-closed)")
        raise HTTPException(503, "Text-message codes are not configured on this deployment yet - "
                                 "please choose email.")
    print(f"[nexus-sign] SMS STUB (NEXUS_SENTDM_KEY not set) - code for {phone}: {code}")
    return code


# ── challenge lifecycle ──────────────────────────────────────────────────────

def request_code(db: Session, req, party, channel: str) -> dict:
    """Mint and send a code. Raises rather than persisting anything when the
    send fails - a challenge nobody could receive is a lockout waiting to
    happen. Returns {channel, masked, expiresIn, devCode?}."""
    channel = (channel or "email").strip().lower()
    allowed = {c["channel"]: c for c in channels_for(party)}
    if channel not in allowed:
        raise HTTPException(400, "That verification method isn't available for this signer.")

    now = _now()
    recent = (db.query(HrSignOtpChallenge)
              .filter(HrSignOtpChallenge.party_id == party.id,
                      HrSignOtpChallenge.consumed_at == "")
              .order_by(HrSignOtpChallenge.created_at.desc()).first())
    if recent:
        created = _parse(recent.created_at or "")
        if created and (now - created).total_seconds() < RESEND_COOLDOWN_SEC:
            wait = int(RESEND_COOLDOWN_SEC - (now - created).total_seconds()) + 1
            raise HTTPException(429, f"Please wait {wait} seconds before requesting another code.")

    cid = str(uuid.uuid4())
    code = _gen_code()
    target = (party.email or "") if channel == "email" else sentdm.normalize_phone(party.phone or "")
    sender_name = (req.created_by or "").split("@")[0].replace(".", " ").title()
    dev = (_send_email(target, code, req.title or "your document", sender_name)
           if channel == "email" else _send_sms(target, code))

    # Any earlier unspent challenge for this party is void the moment a new one
    # is sent - otherwise a signer who requested three codes could sign with
    # whichever one they liked, and "the code we sent" stops being singular.
    (db.query(HrSignOtpChallenge)
     .filter(HrSignOtpChallenge.party_id == party.id, HrSignOtpChallenge.consumed_at == "")
     .update({HrSignOtpChallenge.expires_at: _iso(now)}, synchronize_session=False))
    db.add(HrSignOtpChallenge(
        id=cid, request_id=req.id, party_id=party.id, channel=channel, target=target,
        code_hash=_hash_code(cid, code), attempts=0, consumed_at="",
        expires_at=_iso(now + timedelta(seconds=CODE_TTL_SEC)), created_at=_iso(now)))
    db.flush()   # autoflush=False: verify_code in the same request must see it
    out = {"channel": channel, "masked": allowed[channel]["masked"], "expiresIn": CODE_TTL_SEC}
    if dev:
        out["devCode"] = dev          # local stub only - never set on a deployed API
    return out


def verify_code(db: Session, req, party, code: str) -> HrSignOtpChallenge:
    """Consume the party's outstanding code. Raises HTTPException on every
    failure path; returns the consumed row so the caller can log what happened."""
    code = re.sub(r"\D", "", (code or ""))[:6]
    now = _now()
    row = (db.query(HrSignOtpChallenge)
           .filter(HrSignOtpChallenge.party_id == party.id,
                   HrSignOtpChallenge.consumed_at == "")
           .order_by(HrSignOtpChallenge.created_at.desc()).first())
    if row is None:
        raise HTTPException(400, "Request a verification code first.")
    expires = _parse(row.expires_at or "")
    if expires and now >= expires:
        raise HTTPException(400, "That code has expired - request a new one.")
    if (row.attempts or 0) >= MAX_ATTEMPTS:
        raise HTTPException(429, "Too many incorrect codes - request a new one.")
    if not secrets.compare_digest(_hash_code(row.id, code), row.code_hash or ""):
        row.attempts = (row.attempts or 0) + 1
        db.commit()
        left = MAX_ATTEMPTS - row.attempts
        raise HTTPException(400, "That code wasn't right - try again."
                            if left > 0 else "Too many incorrect codes - request a new one.")
    row.consumed_at = _iso(now)
    db.flush()
    return row


def verified_challenge(db: Session, party) -> HrSignOtpChallenge | None:
    """The consumed code currently authorizing this party, or None.

    A signature is refused unless this returns a row, so the check is one
    query against a persisted fact - not a flag the client sends us."""
    row = (db.query(HrSignOtpChallenge)
           .filter(HrSignOtpChallenge.party_id == party.id,
                   HrSignOtpChallenge.consumed_at != "")
           .order_by(HrSignOtpChallenge.consumed_at.desc()).first())
    if row is None:
        return None
    at = _parse(row.consumed_at or "")
    if at is None or (_now() - at).total_seconds() > VERIFY_TTL_SEC:
        return None
    return row


def summary_for_certificate(db: Session, party) -> dict:
    """What the certificate says about this party's OTP, read from the row that
    actually authorized the signature. Empty dict when none did - the
    certificate then says so rather than implying a factor that never ran."""
    row = (db.query(HrSignOtpChallenge)
           .filter(HrSignOtpChallenge.party_id == party.id,
                   HrSignOtpChallenge.consumed_at != "")
           .order_by(HrSignOtpChallenge.consumed_at.desc()).first())
    if row is None:
        return {}
    return {
        "channel": row.channel or "",
        "target": mask_email(row.target) if row.channel == "email" else mask_phone(row.target),
        "verified_at": row.consumed_at or "",
        "attempts": int(row.attempts or 0),
    }
