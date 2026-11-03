"""Extra work signed on site -> change orders (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 3).

FIELD TICKET (ConstructionFieldTicket). A time and material ticket the crew
writes on the phone: what was done, labor hours (prefilled, if chosen, from
the day's Time Clock punches at the jobsite - hours only, never pay), the
materials used, photos, and the customer's or owner's signature drawn on the
phone with Nexus Sign's own signature pad (components/ESign.jsx SignaturePad -
the one the Forms "live signature" opens; never a second signature engine).
Quantities only: nobody prices anything in the field. It can be written and
signed with no signal - the phone's outbox sends it later (docs/Offline.md).

CHANGE ORDER (ConstructionChangeOrder). A job manager prices a signed field
ticket (or writes one from scratch): amount, reason, schedule impact in days.
It goes for approval through Nexus Sign - ONE envelope to the owner or client
(HrSignRequest link_kind "change_order", link_id = the change order's id; a
PDF built here, document class "purchase_order"). When a person inside the
company must approve it first (`approver_email`), it waits in their Approvals
inbox ("Change Orders", approvals_inbox) and is sent only once they approve.

SIGNING MOVES THE JOB. on_completed (esign._link_hook) marks it Signed and,
once (`applied_at`), adds `amount` to the job's contract value and moves its
target finish by `schedule_impact_days` - the before / after kept on the row
and in the job's activity. A signed change order is never undone by code: the
reversal of one is another change order (a negative amount). Declined / voided
envelopes move nothing.

Statuses: Draft, Awaiting Approval, Sent, Signed, Declined, Void. Bells are
server-side, one per change order per person, updated in place
(construction_notify.bell, family "change_order").
"""
from __future__ import annotations

import io
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

import models

LINK_KIND = "change_order"
STATUSES = ("draft", "awaiting_approval", "sent", "signed", "declined", "void")
OPEN = ("draft", "awaiting_approval", "sent")
REASONS = ("owner_request", "unforeseen", "design", "code", "other")
REASON_LABEL = {"owner_request": "Owner Request", "unforeseen": "Unforeseen Condition",
                "design": "Design Change", "code": "Code Requirement", "other": "Other"}
CO_FAMILY = ("change_order",)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _us(iso: str) -> str:
    try:
        return date.fromisoformat(str(iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return str(iso or "")


def money(v) -> str:
    v = float(v or 0)
    return f"{'-' if v < 0 else ''}${abs(v):,.2f}"


def next_number(db: Session, model, project_id: str, prefix: str) -> str:
    """FT-001 / CO-001, per job: one past the highest number the job has used
    (void and removed rows included - a number is never reused)."""
    top = 0
    for (n,) in db.query(model.number).filter(model.project_id == project_id).all():
        try:
            top = max(top, int(str(n or "").split("-")[-1]))
        except ValueError:
            continue
    return f"{prefix}-{top + 1:03d}"


def ticket_to_dict(t, names: dict | None = None) -> dict:
    names = names or {}
    return {
        "id": t.id, "projectId": t.project_id, "number": t.number or "", "workDate": t.work_date or "",
        "description": t.description or "", "labor": list(t.labor or []), "laborHours": t.labor_hours or 0,
        "laborFromPunches": bool(t.labor_from_punches), "materials": list(t.materials or []),
        "photoUrls": list(t.photo_urls or []), "customerName": t.customer_name or "",
        "customerEmail": t.customer_email or "", "signatureUrl": t.signature_url or "",
        "signedName": t.signed_name or "", "signedAt": t.signed_at or "", "status": t.status or "open",
        "changeOrderId": t.change_order_id or "", "createdBy": t.created_by or "",
        "createdByName": names.get((t.created_by or "").lower(), ""), "createdAt": t.created_at or "",
    }


def co_to_dict(c, names: dict | None = None) -> dict:
    names = names or {}
    return {
        "id": c.id, "projectId": c.project_id, "number": c.number or "", "title": c.title or "",
        "reason": c.reason or "", "reasonLabel": REASON_LABEL.get(c.reason or "", ""),
        "description": c.description or "", "amount": c.amount or 0.0,
        "scheduleImpactDays": c.schedule_impact_days or 0, "fieldTicketId": c.field_ticket_id or "",
        "status": c.status or "draft", "approverEmail": c.approver_email or "",
        "approverName": names.get((c.approver_email or "").lower(), ""),
        "approvedBy": c.approved_by or "", "approvedAt": c.approved_at or "",
        "signerName": c.signer_name or "", "signerEmail": c.signer_email or "",
        "esignRequestId": c.esign_request_id or "", "sentAt": c.sent_at or "", "signedAt": c.signed_at or "",
        "declinedAt": c.declined_at or "", "declineReason": c.decline_reason or "",
        "appliedAt": c.applied_at or "", "contractBefore": c.contract_before or 0.0,
        "contractAfter": c.contract_after or 0.0, "finishBefore": c.finish_before or "",
        "finishAfter": c.finish_after or "", "createdBy": c.created_by or "",
        "createdByName": names.get((c.created_by or "").lower(), ""), "createdAt": c.created_at or "",
    }


def totals(cos) -> dict:
    """Approved (signed) and pending (draft / awaiting / sent) change totals
    and days - what the job's forecast reads."""
    signed = [c for c in cos if c.status == "signed"]
    pending = [c for c in cos if c.status in OPEN]
    return {"signed": round(sum(c.amount or 0 for c in signed), 2),
            "pending": round(sum(c.amount or 0 for c in pending), 2),
            "signedDays": sum(c.schedule_impact_days or 0 for c in signed),
            "pendingDays": sum(c.schedule_impact_days or 0 for c in pending),
            "count": len([c for c in cos if c.status != "void"])}


# ── The envelope ─────────────────────────────────────────────────────────────

def build_pdf(job, co, ticket=None) -> tuple[bytes, dict]:
    """The change order as signed: the job, the change, its price and days,
    the field ticket's quantities when it came from one, and one signature
    row for the owner or client. Returns (pdf, where the boxes go)."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfgen import canvas as rl_canvas
    W, H = letter
    m = 0.08 * W
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.setTitle(f"{co.number} {co.title}")
    st = {"y": H - m, "page": 0}

    def need(h):
        if st["y"] - h < m:
            c.showPage()
            st["y"], st["page"] = H - m, st["page"] + 1

    def line(s, font="Helvetica", size=10, gap=13):
        for part in simpleSplit(str(s or ""), font, size, W - 2 * m) or [""]:
            need(gap)
            c.setFont(font, size)
            c.drawString(m, st["y"], part)
            st["y"] -= gap

    line(f"Change Order {co.number}", "Helvetica-Bold", 16, 21)
    line(" · ".join(x for x in (job.name or "", job.code or "", job.address or "") if x), size=9, gap=13)
    st["y"] -= 8
    line(co.title or "Change Order", "Helvetica-Bold", 12, 16)
    line(f"Reason: {REASON_LABEL.get(co.reason or '', 'Other')}", size=10)
    line(f"Amount: {money(co.amount)}", "Helvetica-Bold", 11, 15)
    days = co.schedule_impact_days or 0
    line(f"Schedule impact: {days:+d} day{'s' if abs(days) != 1 else ''}" if days else "Schedule impact: none")
    if job.contract_value:
        line(f"Contract before this change: {money(job.contract_value)}; after: {money((job.contract_value or 0) + (co.amount or 0))}",
             size=9.5, gap=12)
    st["y"] -= 6
    for para in (co.description or "").split("\n"):
        line(para.strip())
    if ticket is not None:
        st["y"] -= 8
        line(f"From field ticket {ticket.number} ({_us(ticket.work_date)})", "Helvetica-Bold", 10.5, 14)
        if ticket.labor_hours:
            line(f"Labor: {ticket.labor_hours:g} hours", size=9.5, gap=12)
        for mt in ticket.materials or []:
            q = f"{mt.get('quantity', '')} {mt.get('unit', '')}".strip()
            line(f"Material: {mt.get('description', '')}" + (f" - {q}" if q else ""), size=9.5, gap=12)
        if ticket.signed_name:
            line(f"Work acknowledged on site by {ticket.signed_name} on {_us(ticket.signed_at)}", size=9, gap=12)
    st["y"] -= 14
    need(120)
    line("Approval", "Helvetica-Bold", 11, 15)
    line("By signing, the owner or client approves this change to the contract, its price and its "
         "schedule impact.", size=9.5, gap=12)
    st["y"] -= 34
    base = st["y"]
    c.setFont("Helvetica-Bold", 9)
    c.drawString(m, base + 12, "Owner or Client")
    c.line(0.20 * W, base, 0.62 * W, base)
    c.line(0.70 * W, base, 0.88 * W, base)
    c.setFont("Helvetica", 7)
    c.drawString(0.20 * W, base - 9, "Signature")
    c.drawString(0.70 * W, base - 9, "Date")
    c.save()
    top = (H - (base + 0.05 * H)) / H
    spot = {"page": st["page"], "sign": (0.20, top, 0.42, 0.05), "date": (0.70, (H - (base + 0.03 * H)) / H, 0.18, 0.03)}
    return buf.getvalue(), spot


def send_envelope(db: Session, user: dict, job, co, *, title: str, pdf: bytes, spot: dict, link_kind: str,
                  link_id: str, signer_name: str, signer_email: str, message: str,
                  internal_emails: set | None = None) -> str:
    """One Nexus Sign envelope to one signer (the owner or client) through
    esign._create_request (the one send path). Returns the request id.
    Raises RuntimeError when the PDF cannot be stored."""
    from routers import esign
    path = f"esign/{uuid.uuid4()}/{esign._safe_filename(title)}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise RuntimeError("the document could not be stored for signing")
    fields = [{"id": f"owner_{k}", "role": "owner", "type": k, "page": spot["page"],
               **dict(zip(("x", "y", "w", "h"), spot[k])), "required": True} for k in ("sign", "date")]
    em = (signer_email or "").strip().lower()
    kind = "internal" if em in (internal_emails or set()) else "external"
    out = esign._create_request(
        db, {"email": (user.get("email") or "").lower()}, title=title, source="pdf", template_id="",
        employee_id="", candidate_id="", entity_id=getattr(job, "company_id", "") or "",
        body_snapshot=[], pdf_storage_path=path, fields=esign._clean_fields(fields), message=message,
        expires_on="", parties=[esign.PartyIn(role_key="owner", name=signer_name, email=em, kind=kind,
                                              ordinal=1, party_role="signer")],
        ip="", user_agent="", routing="sequential", excluded_ack=True, document_class="purchase_order",
        link_kind=link_kind, link_id=link_id)
    return out["id"]


def _internal(db: Session, emails) -> set:
    from sqlalchemy import func
    ems = [e.lower() for e in emails if e]
    if not ems:
        return set()
    E = models.NexusEmployee
    return {(r[0] or "").lower() for r in db.query(E.work_email).filter(func.lower(E.work_email).in_(ems)).all()}


def send_for_signature(db: Session, user: dict, job, co) -> None:
    """Draft (or approved) -> Sent: build the PDF, send ONE envelope to the
    owner or client. Commits (the send path does)."""
    ticket = db.get(models.ConstructionFieldTicket, co.field_ticket_id) if co.field_ticket_id else None
    pdf, spot = build_pdf(job, co, ticket)
    rid = send_envelope(
        db, user, job, co, title=f"Change Order {co.number} - {job.name}", pdf=pdf, spot=spot,
        link_kind=LINK_KIND, link_id=co.id, signer_name=co.signer_name, signer_email=co.signer_email,
        message=f"Please review and sign change order {co.number} ({co.title}) for {job.name}: {money(co.amount)}.",
        internal_emails=_internal(db, [co.signer_email]))
    co = db.get(models.ConstructionChangeOrder, co.id)
    co.esign_request_id, co.status, co.sent_at, co.modified_at = rid, "sent", now(), now()
    _activity(db, job, co, "sent", (user.get("email") or "").lower(),
              f"sent {co.number} to {co.signer_name} for signature")
    db.commit()


def _activity(db: Session, job, co, kind: str, actor: str, detail: str) -> None:
    db.add(models.ConstructionActivity(id=str(uuid.uuid4()), project_id=job.id, entity_kind="change_order",
                                       entity_id=co.id, type=kind, actor_email=actor or "", at=now(),
                                       detail=detail[:500]))


def _bell(db: Session, job, co, recipient: str, title: str, body: str, done: bool = False) -> None:
    import construction_notify
    construction_notify.bell(db, kind="change_order", family=CO_FAMILY, recipient=recipient, ref_id=f"co:{co.id}",
                             title=title, body=body, label="Open Changes", sub=f"project:{job.id}:changes",
                             done=done, company=getattr(job, "company_id", "") or "")


def ask_approval(db: Session, job, co) -> None:
    _bell(db, job, co, co.approver_email, "Change Order to Approve",
          f"{co.number} {co.title} on {job.name}: {money(co.amount)}. Approve it to send it to "
          f"{co.signer_name or 'the owner'} for signature.")


def apply(db: Session, job, co) -> bool:
    """Signed: move the job's contract value and target finish, once."""
    if co.applied_at:
        return False
    co.contract_before = job.contract_value or 0.0
    job.contract_value = round((job.contract_value or 0.0) + (co.amount or 0.0), 2)
    co.contract_after = job.contract_value
    co.finish_before = job.target_finish_on or ""
    days = int(co.schedule_impact_days or 0)
    if days and job.target_finish_on:
        try:
            job.target_finish_on = (date.fromisoformat(job.target_finish_on[:10]) + timedelta(days=days)).isoformat()
        except ValueError:
            pass
    co.finish_after = job.target_finish_on or ""
    co.applied_at = now()
    job.modified_at = now()
    _activity(db, job, co, "applied", "",
              f"{co.number} signed: contract {money(co.contract_before)} -> {money(co.contract_after)}"
              + (f"; target finish {_us(co.finish_before)} -> {_us(co.finish_after)}" if days and co.finish_before else ""))
    return True


# ── Nexus Sign callbacks (esign._link_hook, link_kind "change_order") ────────

def _co_for(db: Session, req):
    if (getattr(req, "link_kind", "") or "") != LINK_KIND:
        return None, None
    co = db.get(models.ConstructionChangeOrder, req.link_id or "")
    if co is None or (co.esign_request_id and co.esign_request_id != req.id):
        return None, None
    job = db.get(models.ConstructionProject, co.project_id)
    return co, job


def _tell_owners(db: Session, job, co, title: str, body: str) -> None:
    for em in sorted({(co.created_by or "").lower(), *[(e or "").lower() for e in (job.manager_emails or [])]} - {""}):
        _bell(db, job, co, em, title, body, done=True)


def on_completed(db: Session, req) -> None:
    co, job = _co_for(db, req)
    if co is None or job is None or co.status == "signed":
        return
    co.status, co.signed_at, co.modified_at = "signed", now(), now()
    apply(db, job, co)
    _activity(db, job, co, "signed", "", f"{co.number} signed by {co.signer_name or 'the owner'}")
    _tell_owners(db, job, co, "Change Order Signed",
                 f"{co.signer_name or 'The owner'} signed {co.number} {co.title} on {job.name}: {money(co.amount)}. "
                 f"The contract is now {money(job.contract_value)}.")
    try:
        import workflows
        workflows.emit(db, "change_order.signed", subject=co, actor="",
                       extra={"job_id": job.id, "schedule_impact_days": co.schedule_impact_days})
    except Exception as e:   # noqa: BLE001 - an automation never costs a signature
        print(f"[construction-changes] emit: {e}")


def on_declined(db: Session, req, party=None, reason: str = "") -> None:
    co, job = _co_for(db, req)
    if co is None or job is None or co.status not in ("sent", "awaiting_approval"):
        return
    co.status, co.declined_at, co.modified_at = "declined", now(), now()
    co.decline_reason = (reason or "").strip()[:500]
    _activity(db, job, co, "declined", "", f"{co.number} declined" + (f": {co.decline_reason}" if co.decline_reason else ""))
    _tell_owners(db, job, co, "Change Order Declined",
                 f"{getattr(party, 'name', '') or co.signer_name or 'The owner'} declined {co.number} {co.title} on {job.name}"
                 + (f": {co.decline_reason[:200]}" if co.decline_reason else "."))


def on_voided(db: Session, req, actor: str = "") -> None:
    co, job = _co_for(db, req)
    if co is None or job is None or co.status in ("signed", "void", "declined"):
        return
    co.status, co.modified_at = "void", now()
    _activity(db, job, co, "voided", actor or "", f"{co.number} voided")


def on_expired(db: Session, req) -> None:
    on_declined(db, req, None, "The signing link expired.")


def safe(fn, *a, **kw) -> None:
    """A problem here must never cost anyone their signature."""
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - logged, never raised
        print(f"[construction-changes] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")


def void_envelope(db: Session, co, actor: str, reason: str) -> None:
    """Void the change order's open envelope (Nexus Sign's own row and log)."""
    from routers.esign import _log
    req = db.get(models.HrSignRequest, co.esign_request_id) if co.esign_request_id else None
    if req is not None and req.status == "pending":
        req.status = "voided"
        _log(db, req.id, "voided", f"by {actor}: change order {co.number} voided - {reason}"[:500])


def ticket_labor(db: Session, user: dict, job, day: str, *, full: bool) -> dict:
    """The labor lines a field ticket can start from: the day's punches at
    the jobsite. A job reviewer gets each person's hours; anyone else one
    line with the crew's total (the hours-only rule - crews see their own)."""
    import construction_company
    import construction_labor
    worked = construction_labor.hours(db, job, date_from=day, date_to=day)
    by = dict(worked.get("byPerson") or {})
    if full:
        names = construction_company.people_names(db, list(by))
        lines = [{"email": e, "name": names.get(e, ""), "hours": h} for e, h in sorted(by.items())]
    else:
        lines = [{"email": "", "name": f"Crew ({len(by)} {'person' if len(by) == 1 else 'people'})",
                  "hours": round(sum(by.values()), 2)}] if by else []
    return {"date": day, "lines": lines, "total": round(sum(by.values()), 2), "people": len(by)}


def clean_labor(value) -> list:
    if value in (None, ""):
        return []
    if not isinstance(value, list) or len(value) > 60:
        raise ValueError("Labor is a list of people and hours.")
    out = []
    for x in value:
        if not isinstance(x, dict):
            raise ValueError("Each labor line needs hours.")
        try:
            h = round(float(x.get("hours") or 0), 2)
        except (TypeError, ValueError):
            raise ValueError("Hours must be a number.")
        if h < 0 or h > 24 * 7:
            raise ValueError("Hours must be between 0 and 168.")
        out.append({"email": str(x.get("email") or "").strip().lower()[:200],
                    "name": str(x.get("name") or "").strip()[:120], "hours": h})
    return out


def clean_materials(value) -> list:
    if value in (None, ""):
        return []
    if not isinstance(value, list) or len(value) > 80:
        raise ValueError("Materials is a list of lines.")
    out = []
    for x in value:
        if not isinstance(x, dict):
            raise ValueError("Each material line needs a description.")
        d = str(x.get("description") or "").strip()[:200]
        if not d:
            continue
        q = x.get("quantity")
        try:
            q = round(float(q), 3) if q not in (None, "") else None
        except (TypeError, ValueError):
            raise ValueError("A quantity must be a number.")
        out.append({"description": d, "quantity": q, "unit": str(x.get("unit") or "").strip()[:20]})
    return out


def find_ticket(db: Session, ticket_id: str) -> Optional[models.ConstructionFieldTicket]:
    t = db.get(models.ConstructionFieldTicket, ticket_id)
    return None if t is None or t.deleted_at else t
