"""Knowledge Base policies signed through Nexus Sign (Release 3, Oct 29 2026).

A page with "People must sign this page" and signing = nexus_sign is signed in
Nexus Sign instead of on the page: each person in its audience gets ONE
envelope per version, a PDF of the page with the acknowledgement, the person
its only signer (the company never signs: HR signing order, Neil, Oct 22).

  * No table of its own: an envelope is an HrSignRequest with link_kind
    "kb_policy" and link_id "<page id>:<version>:<email>", so "one envelope
    per person per version" is a lookup on Nexus Sign's own rows.
  * Sent by the daily scan in batches (BATCH a run), never a burst on publish.
  * A new MAJOR version voids every open envelope of the older one; the next
    run sends the new one. A minor version does not ask again.
  * Completed -> a KbSignature (method nexus_sign) with the version and the
    exact text of that version. Declined -> shown in Compliance and on the
    page's signature list until an editor resends.
  * Nothing here may cost a signature: Nexus Sign calls these through safe().
"""
from __future__ import annotations

import io
import uuid
from typing import Optional

from sqlalchemy.orm import Session

import kb_blocks
import kb_core
import models

LINK_KIND = "kb_policy"
BATCH = 200          # envelopes one daily run sends at most
OPEN = ("pending",)
ACK_STATEMENT = ("By signing, I confirm I have read and understood this {kind}, version {version}, "
                 "and I agree to follow it.")


# ── Which envelope belongs to whom ───────────────────────────────────────────

def link_id(d: models.KbDocument, email: str) -> str:
    return f"{d.id}:{d.version or ''}:{(email or '').lower()}"


def _parse(lid: str) -> tuple[str, str, str]:
    doc_id, _, rest = (lid or "").partition(":")
    version, _, email = rest.partition(":")
    return doc_id, version, email


def _major(version: str) -> int:
    return kb_core.parse_version(version)[0]


def envelopes(db: Session, d: models.KbDocument, email: str = "") -> list:
    """This page's envelopes (one person's when `email`), newest first."""
    q = db.query(models.HrSignRequest).filter(models.HrSignRequest.link_kind == LINK_KIND,
                                              models.HrSignRequest.link_id.like(f"{d.id}:%"))
    rows = q.order_by(models.HrSignRequest.created_at.desc()).all()
    if email:
        email = email.lower()
        rows = [r for r in rows if _parse(r.link_id)[2] == email]
    return rows


def current(db: Session, d: models.KbDocument, email: str):
    """The person's newest envelope for the page's CURRENT major version, or None."""
    for r in envelopes(db, d, email):
        if _major(_parse(r.link_id)[1]) == (d.major or 0):
            return r
    return None


def state_for(db: Session, d: models.KbDocument, email: str) -> dict:
    """{status: pending|declined|expired|voided|'', sign_url, reason} for the page view and Compliance."""
    r = current(db, d, email)
    if r is None:
        return {"status": "", "sign_url": "", "reason": ""}
    out = {"status": r.status or "", "sign_url": "", "reason": ""}
    party = db.query(models.HrSignParty).filter(models.HrSignParty.request_id == r.id).first()
    if r.status == "pending" and party is not None:
        from routers import esign
        out["sign_url"] = esign._sign_link(party, r)
    if r.status == "declined" and party is not None:
        out["reason"] = (getattr(party, "decline_reason", "") or "")[:300]
    return out


# ── The document ─────────────────────────────────────────────────────────────

def _us(iso: str) -> str:
    from kb_daily import _us as us
    return us(iso or "")


def _text(d: models.KbDocument) -> str:
    return d.content_text or kb_blocks.plain_text(kb_blocks.loads(d.blocks))


def build_pdf(d: models.KbDocument, text: str, kind: str) -> tuple[bytes, dict]:
    """The page as signed: title, code, version, the text, the acknowledgement
    and one signature row. Returns (pdf, where the sign / date boxes go)."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfgen import canvas as rl_canvas
    W, H = letter
    m = 0.08 * W
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.setTitle(f"{d.title} v{d.version}")
    state = {"y": H - m, "page": 0}

    def need(h: float) -> None:
        if state["y"] - h < m:
            c.showPage()
            state["y"], state["page"] = H - m, state["page"] + 1

    def line(s: str, font: str = "Helvetica", size: float = 10, gap: float = 13) -> None:
        for part in simpleSplit(s, font, size, W - 2 * m) or [""]:
            need(gap)
            c.setFont(font, size)
            c.drawString(m, state["y"], part)
            state["y"] -= gap

    line(d.title or "Policy", "Helvetica-Bold", 16, 20)
    meta = " · ".join(x for x in (d.doc_code or "", f"Version {d.version}", f"Effective {_us(d.effective_date)}" if d.effective_date else "") if x)
    line(meta, "Helvetica", 9, 14)
    state["y"] -= 8
    for para in (text or "").split("\n"):
        line(para.strip())
    state["y"] -= 12
    need(120)
    line("Acknowledgement", "Helvetica-Bold", 11, 15)
    line(ACK_STATEMENT.format(kind=kind, version=d.version), size=9.5, gap=12)
    state["y"] -= 34
    base = state["y"]
    c.setFont("Helvetica-Bold", 9)
    c.drawString(m, base + 12, "Employee")
    c.line(0.20 * W, base, 0.62 * W, base)
    c.line(0.70 * W, base, 0.88 * W, base)
    c.setFont("Helvetica", 7)
    c.drawString(0.20 * W, base - 9, "Signature")
    c.drawString(0.70 * W, base - 9, "Date")
    c.save()
    top = (H - (base + 0.05 * H)) / H
    spot = {"page": state["page"], "sign": (0.20, top, 0.42, 0.05), "date": (0.70, (H - (base + 0.03 * H)) / H, 0.18, 0.03)}
    return buf.getvalue(), spot


# ── Sending ──────────────────────────────────────────────────────────────────

def send(db: Session, d: models.KbDocument, email: str, *, actor: str = "") -> Optional[str]:
    """One envelope to one person for the page's current version. None when
    they signed this major already or one is still open."""
    import auth
    from routers import esign
    email = (email or "").lower()
    if not email or kb_core.signature_for(db, d, email):
        return None
    cur = current(db, d, email)
    if cur is not None and cur.status in OPEN:
        return None
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    name = ((emp.display_name or f"{emp.first_name or ''} {emp.last_name or ''}").strip() if emp else "") or email
    kind = kb_core.PAGE_TYPE_LABEL.get(d.page_type or "policy", "Policy").lower()
    pdf, spot = build_pdf(d, _text(d), kind)
    path = f"esign/{uuid.uuid4()}/{esign._safe_filename(f'{d.title} v{d.version}')}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise RuntimeError("the policy could not be stored for signing")
    fields = [{"id": f"employee_{k}", "role": "employee", "type": k, "page": spot["page"],
               **dict(zip(("x", "y", "w", "h"), spot[k])), "required": True} for k in ("sign", "date")]
    sender = (actor or d.owner_email or "").lower() or "nexus"
    out = esign._create_request(
        db, {"email": sender}, title=f"{d.title} v{d.version}", source="pdf", template_id="",
        employee_id="", candidate_id="", entity_id=auth.company_of(d.owner_email or "", db),
        body_snapshot=[], pdf_storage_path=path, fields=esign._clean_fields(fields),
        message=f"Please read {d.title} (version {d.version}) and sign to confirm you will follow it.",
        expires_on="", parties=[esign.PartyIn(role_key="employee", name=name, email=email, kind="internal",
                                              ordinal=1, party_role="signer")],
        ip="", user_agent="", routing="sequential", excluded_ack=True, document_class="employment",
        link_kind=LINK_KIND, link_id=link_id(d, email))
    kb_core.event(db, kind="sign_sent", actor=sender, doc_id=d.id, version=d.version, note=email)
    return out["id"]


def void_older(db: Session, d: models.KbDocument, *, actor: str = "nexus") -> int:
    """A new major version: every open envelope of an older one is voided."""
    from routers.esign import _log
    n = 0
    for r in envelopes(db, d):
        if r.status in OPEN and _major(_parse(r.link_id)[1]) < (d.major or 0):
            r.status = "voided"
            _log(db, r.id, "voided", f"by {actor}: {d.title} has a new version ({d.version})")
            n += 1
    return n


def signs_in_nexus_sign(d: models.KbDocument) -> bool:
    return kb_core.NEXUS_SIGN_FOR_POLICIES and d.signing == "nexus_sign" and d.status == "approved" and bool(d.require_ack)


def run(db: Session, limit: int = BATCH) -> int:
    """The daily pass: void what a new major replaced, then send what is owed,
    at most `limit` envelopes. A declined envelope waits for an editor's
    Resend; an expired or voided one is sent again."""
    sent = 0
    for d in db.query(models.KbDocument).filter(models.KbDocument.status == "approved", models.KbDocument.require_ack.is_(True),
                                                 models.KbDocument.signing == "nexus_sign").all():
        if not signs_in_nexus_sign(d):
            continue
        void_older(db, d)
        db.commit()
        for email in sorted(kb_core.policy_audience_emails(db, d)):
            if sent >= limit:
                return sent
            cur = current(db, d, email)
            if cur is not None and cur.status == "declined":
                continue
            try:
                if send(db, d, email):
                    sent += 1
                db.commit()
            except Exception as e:  # noqa: BLE001 - one person's envelope never stops the rest
                db.rollback()
                print(f"[kb-policy-sign] {d.id} {email}: {type(e).__name__}: {e}")
    return sent


def resend(db: Session, d: models.KbDocument, emails: set[str], *, actor: str) -> int:
    """An editor's Resend: a new envelope for each person who has not signed
    and has none open (declined, expired or voided ones included)."""
    n = 0
    for email in sorted(emails):
        if send(db, d, email, actor=actor):
            n += 1
    db.commit()
    return n


# ── Nexus Sign callbacks (esign._link_hook, link_kind "kb_policy") ───────────

def _page_for(db: Session, req):
    if (getattr(req, "link_kind", "") or "") != LINK_KIND:
        return None, "", ""
    doc_id, version, email = _parse(req.link_id)
    return db.query(models.KbDocument).filter(models.KbDocument.id == doc_id).first(), version, email


def on_completed(db: Session, req) -> None:
    d, version, email = _page_for(db, req)
    if d is None or not email:
        return
    major, _minor = kb_core.parse_version(version)
    if db.query(models.KbSignature).filter(models.KbSignature.doc_id == d.id, models.KbSignature.user_email == email,
                                           models.KbSignature.major == major).first():
        return
    ver = db.query(models.KbPageVersion).filter(models.KbPageVersion.doc_id == d.id, models.KbPageVersion.version == version).first()
    text = kb_blocks.plain_text(kb_blocks.loads(ver.blocks)) if ver and ver.blocks else _text(d)
    party = db.query(models.HrSignParty).filter(models.HrSignParty.request_id == req.id).first()
    name = (party.name if party else "") or email
    typed = (party.signature_data if party and party.signature_kind == "typed" else "") or name
    db.add(models.KbSignature(id=kb_core.new_id("sig"), doc_id=d.id, version=version, major=major, user_email=email,
                              user_name=name, typed_name=typed[:200], signed_at=kb_core.now(), content_text=text,
                              content_hash=kb_core.content_hash(text), method="nexus_sign"))
    kb_core.event(db, kind="signed", actor=email, doc_id=d.id, version=version, actor_name=name, note="Nexus Sign")


def on_declined(db: Session, req, party=None, reason: str = "") -> None:
    d, version, email = _page_for(db, req)
    if d is None:
        return
    who = getattr(party, "name", "") or email
    kb_core.event(db, kind="sign_declined", actor=email, doc_id=d.id, version=version, actor_name=who, note=(reason or "")[:500])
    if d.owner_email:
        kb_core.notify(db, recipient=d.owner_email, ntype="kb_sign_declined", title="Policy Signature Declined",
                       body=f"{who} declined to sign {d.title} v{version}" + (f": {reason.strip()[:200]}" if (reason or "").strip() else ""),
                       ref_id=d.id, item_name=d.title, sub=f"signatures:{d.id}", dedupe_today=True)


def on_voided(db: Session, req, actor: str = "") -> None:
    d, version, email = _page_for(db, req)
    if d is not None:
        kb_core.event(db, kind="sign_voided", actor=actor or "nexus", doc_id=d.id, version=version, note=email)


def on_expired(db: Session, req) -> None:
    d, version, email = _page_for(db, req)
    if d is not None:
        kb_core.event(db, kind="sign_expired", actor="nexus", doc_id=d.id, version=version, note=email)


def safe(fn, *a, **kw) -> None:
    """A problem here must never cost anyone their signature."""
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - logged, never raised
        print(f"[kb-policy-sign] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")
