"""Closeout that hands over (Neil, 11/03/2026, plan
https://claude.ai/artifact/B5jm924fPPQ85AEDjBoSHr, phase 3).

A job closes out with three things: the closeout checklist (the "Closeout"
section of its task project - the job type's template puts it there), the
structured records of what is handed over (ConstructionCloseoutRecord:
warranties, permits and inspections, as-built and O&M documents), and the
owner's or client's sign-off on substantial completion through Nexus Sign
(HrSignRequest link_kind "owner_signoff", link_id = the job id).

WRITING BACK TO ASSET MANAGEMENT (Neil's module). Choice made, and why: the
records are written as ORDINARY rows of the property's own collections -
warranties, inspections, Plans & Documents - through Asset Management's
existing per-row API (routers.property_assets.post_changes, the function
behind POST /property-assets/changes), AS THE ACTING USER, with that user's
Asset Management edit grant (require_asset_write) and the module's own
reach checks (private assets, scope rows). Never PUT /workspace. The other
option - a construction-owned table Asset Management's Records views merge
in, the TicketMaintenanceRecord pattern - was not chosen: a merged row is
read-only on the property, sits outside the module's search, CSV export,
expiry reminders (scan_reminders reads PropertyRecord) and Insights'
"Warranties Expiring", and would need Records-view changes in every
collection. The per-row API exists precisely so a writer cannot overwrite
anyone: each row has a fixed id (`cx-<record id>`) and is CREATED only - a
row already there is a conflict the module reports and this skips, never
an overwrite (no `_rev` is needed for a create; one that exists is never
written without its `_rev`). An Activity Log entry is appended in the same
call. Nothing is ever deleted by code.

ITEMS. A warranty on a piece of equipment (`item_id`) is written to the item
through the Items API's own update (routers.items.update_item, as the acting
user with their Items edit grant): custom fields warranty_start /
warranty_end / warranty_vendor and, when given, the maker's serial
(manufacturer_serial) - Items and assets are ONE concept (Neil), so the
item, not a parallel table, carries its warranty.

A record that cannot be written (no property on the job, no edit access
there) keeps the reason on `written.error`; Close Out still closes the job,
and "Send to Asset Management" tries again later (idempotent).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models

KINDS = ("warranty", "permit", "inspection", "document")
RESULTS = ("passed", "failed", "partial", "pending", "")
DOC_CATEGORIES = {"as_built": "As-Built - Architectural", "om_manual": "O&M Manual",
                  "certificate": "Certificate of Occupancy", "permit": "Permit", "other": "Other"}
SIGNOFF_KIND = "owner_signoff"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _us(iso: str) -> str:
    try:
        return date.fromisoformat(str(iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return str(iso or "")


def record_to_dict(r) -> dict:
    return {"id": r.id, "projectId": r.project_id, "kind": r.kind, "title": r.title or "", "itemId": r.item_id or "",
            "serial": r.serial or "", "vendor": r.vendor or "", "startOn": r.start_on or "", "endOn": r.end_on or "",
            "ahj": r.ahj or "", "number": r.number or "", "result": r.result or "", "dateOn": r.date_on or "",
            "dueOn": getattr(r, "due_on", "") or "",
            "category": r.category or "", "docUrl": r.doc_url or "", "docName": r.doc_name or "",
            "notes": r.notes or "", "written": dict(r.written or {}), "createdBy": r.created_by or "",
            "createdAt": r.created_at or ""}


# ── Permits and inspections, live from day one (Round Two, 11/05/2026) ──────
_OPEN = ("", "pending")


def inspection_summary(db: Session, job, today: str) -> dict:
    """{next, open, failed}: the next scheduled inspection still to happen
    (the earliest with a scheduled day and no result, today or later), how
    many have no result yet, how many failed - the Overview's card."""
    R = models.ConstructionCloseoutRecord
    rows = db.query(R).filter(R.project_id == job.id, R.deleted_at == "", R.kind == "inspection").all()
    ahead = sorted((r for r in rows if (r.result or "") in _OPEN and (r.due_on or "") >= (today or "") and r.due_on),
                   key=lambda r: r.due_on)
    nxt = ahead[0] if ahead else None
    return {"next": ({"id": nxt.id, "title": nxt.title or "Inspection", "ahj": nxt.ahj or "", "dueOn": nxt.due_on}
                     if nxt else None),
            "open": len([r for r in rows if (r.result or "") in _OPEN]),
            "failed": len([r for r in rows if (r.result or "") == "failed"])}


def failed_bell(db: Session, job, r, actor: str) -> None:
    """An inspection marked Failed bells the job's managers (else the
    company's reviewers) - one per person and record, rewritten in place."""
    import construction_notify
    to = sorted({(e or "").strip().lower() for e in (job.manager_emails or []) if (e or "").strip()}) \
        or construction_notify.reviewers(db, job)
    for em in to:
        if em == (actor or "").lower():
            continue
        construction_notify.bell(
            db, kind="inspection_failed", family=("inspection_failed", "inspection_due"), recipient=em,
            ref_id=f"inspection:{r.id}", title="Inspection Failed",
            body=f"{r.title or 'Inspection'}{' with ' + r.ahj if r.ahj else ''} on {job.name} failed"
                 f"{' on ' + _us(r.date_on) if r.date_on else ''}. Schedule the re-inspection under Permits And Inspections.",
            label="Open Permits And Inspections", sub=f"project:{job.id}:permits", requested_by=actor or "",
            company=getattr(job, "company_id", "") or "")


def asset_row(job, r) -> tuple[str, dict]:
    """(collection, payload) - the Asset Management row a record becomes, in
    the field names of that collection (frontend/src/asset/lib/recordTypes.jsx)."""
    src = f"From the {job.name} closeout"
    base = {"id": f"cx-{r.id}", "propertyId": job.property_id}
    if r.kind == "warranty":
        return "warranties", {**base, "kind": "Manufacturer" if r.item_id else "Contractor",
                              "scope": r.title or "Warranty", "party": r.vendor or "", "startDate": r.start_on or "",
                              "expiration": r.end_on or "", "docFile": r.doc_url or "", "docFileName": r.doc_name or "",
                              "coverage": r.notes or r.title or "", "notes": src + (f" - serial {r.serial}" if r.serial else "")}
    if r.kind == "inspection":
        res = (r.result or "").title()
        return "inspections", {**base, "type": r.title or "Inspection", "frequency": "One-time",
                               "ahjRequired": "Yes" if r.ahj else "No", "vendor": r.ahj or "",
                               "lastCompleted": r.date_on or "", "nextDue": r.date_on or getattr(r, "due_on", "") or "",
                               "notes": " - ".join(x for x in (f"Result: {res}" if res else "", r.notes or "", src) if x)}
    if r.kind == "permit":
        title = " - ".join(x for x in (f"Permit {r.number}" if r.number else "Permit", r.title or "", r.ahj or "") if x)
        return "documents", {**base, "category": "Permit", "egnyteDest": "Permits & Approvals", "title": title,
                             "dateOf": r.date_on or "", "version": (r.result or "").title(), "location": "",
                             "docFile": r.doc_url or "", "docFileName": r.doc_name or "",
                             "notes": " - ".join(x for x in (r.notes or "", src) if x)}
    return "documents", {**base, "category": DOC_CATEGORIES.get(r.category or "other", "Other"),
                         "egnyteDest": "Closeout / O&M", "title": r.title or "Document", "dateOf": r.date_on or "",
                         "version": "", "location": "", "docFile": r.doc_url or "", "docFileName": r.doc_name or "",
                         "notes": " - ".join(x for x in (r.notes or "", src) if x)}


def _name(db: Session, email: str) -> str:
    import construction_company
    em = (email or "").lower()
    return construction_company.people_names(db, [em]).get(em, "") or em


def write_to_asset(db: Session, user: dict, job, r) -> dict:
    """One record -> one Asset Management row, through post_changes as the
    acting user. Returns the `written.asset` mark, or raises HTTPException
    with the reason (403 no access, 409 not created)."""
    from routers import property_assets as pa
    if not job.property_id:
        raise HTTPException(409, "The job is not linked to a property - link one on Edit Job first.")
    pa.require_asset_write(user=user, db=db)   # the module's own grant: editor or administrator
    coll, row = asset_row(job, r)
    prop = db.get(models.PropertyAsset, job.property_id)
    if prop is None:
        raise HTTPException(409, "The job's property is not in Asset Management.")
    if db.get(models.PropertyRecord, row["id"]) is not None:
        return {"collection": coll, "id": row["id"], "at": now(), "by": (user.get("email") or "").lower(), "already": True}
    log = {"id": f"cxlog-{uuid.uuid4().hex[:12]}", "ts": now(), "user": _name(db, user.get("email") or ""),
           "section": {"warranties": "Warranties", "inspections": "Inspections"}.get(coll, "Plans & Documents"),
           "property": prop.name or "", "propertyId": prop.id, "action": "added",
           "item": row.get("scope") or row.get("type") or row.get("title") or "Closeout record", "changes": [],
           "reason": f"Construction closeout: {job.name}"}
    ch = pa.Changes(**{coll: pa.RowOps(upsert=[row]), "logs": pa.LogOps(append=[log])})
    out = pa.post_changes(ch, db, user)
    if row["id"] in (out.get("conflicts") or []):
        raise HTTPException(409, "Asset Management already has a newer copy of this row.")
    return {"collection": coll, "id": row["id"], "at": now(), "by": (user.get("email") or "").lower()}


def write_to_item(db: Session, user: dict, r) -> dict:
    """An equipment warranty onto its item, through the Items API's update."""
    from routers import items as items_router
    items_router.require_items_admin(user=user, db=db)
    item = db.get(models.Item, r.item_id)
    if item is None or (item.deleted_at or ""):
        raise HTTPException(409, "That item is not in Items any more.")
    fields = {"warranty_start": r.start_on or None, "warranty_end": r.end_on or None,
              "warranty_vendor": r.vendor or None}
    if r.serial:
        fields["manufacturer_serial"] = r.serial
    items_router.update_item(item.id, items_router.ItemUpdate(custom_fields={k: v for k, v in fields.items() if v}),
                             user=user, db=db)
    return {"id": item.id, "at": now(), "by": (user.get("email") or "").lower()}


def write_back(db: Session, user: dict, job) -> list:
    """Write every live, not yet written record. Each row lands or carries
    its reason; one failure never stops the rest. Returns the records."""
    R = models.ConstructionCloseoutRecord
    out = []
    for r in db.query(R).filter(R.project_id == job.id, R.deleted_at == "").order_by(R.created_at).all():
        w = dict(r.written or {})
        errors = []
        if not w.get("asset"):
            try:
                w["asset"] = write_to_asset(db, user, job, r)
            except HTTPException as e:
                db.rollback()
                errors.append(e.detail if e.status_code not in (401, 403) else
                              "You do not have edit access to Asset Management - an editor there can send it.")
        if r.kind == "warranty" and r.item_id and not w.get("item"):
            try:
                w["item"] = write_to_item(db, user, r)
            except HTTPException as e:
                db.rollback()
                errors.append(e.detail if e.status_code not in (401, 403) else
                              "You do not have edit access to Items - an Items manager can send the warranty.")
        r = db.get(R, r.id)
        w["error"] = " ".join(errors)
        r.written = w
        r.modified_at = now()
        db.commit()
        out.append(r)
    return out


def checklist(db: Session, job) -> list:
    """The task project's Closeout section, as rows."""
    import construction_tasks
    tp = construction_tasks.task_project(db, job)
    if tp is None:
        return []
    S, T = models.TaskSection, models.Task
    sec = next((s for s in db.query(S).filter(S.project_id == tp.id).all()
                if (s.name or "").strip().lower() == "closeout"), None)
    if sec is None:
        return []
    from routers.tasks import task_to_dict
    return [task_to_dict(t) for t in db.query(T).filter(T.project_id == tp.id, T.section_id == sec.id).all()]


# ── The owner's sign-off on substantial completion ───────────────────────────

def build_signoff_pdf(db: Session, job) -> tuple[bytes, dict]:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfgen import canvas as rl_canvas
    W, H = letter
    m = 0.08 * W
    buf = io_bytes()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.setTitle(f"Substantial Completion - {job.name}")
    st = {"y": H - m, "page": 0}

    def line(s, font="Helvetica", size=10, gap=13):
        for part in simpleSplit(str(s or ""), font, size, W - 2 * m) or [""]:
            if st["y"] - gap < m:
                c.showPage()
                st["y"], st["page"] = H - m, st["page"] + 1
            c.setFont(font, size)
            c.drawString(m, st["y"], part)
            st["y"] -= gap

    line("Certificate of Substantial Completion", "Helvetica-Bold", 16, 21)
    line(" · ".join(x for x in (job.name or "", job.code or "", job.address or "") if x), size=9)
    st["y"] -= 8
    line(f"Date: {_us(now())}")
    if job.start_on:
        line(f"Work started: {_us(job.start_on)}")
    R = models.ConstructionCloseoutRecord
    recs = db.query(R).filter(R.project_id == job.id, R.deleted_at == "").all()
    counts = {k: len([r for r in recs if r.kind == k]) for k in KINDS}
    line(f"Handed over: {counts['warranty']} warranties, {counts['permit']} permits, "
         f"{counts['inspection']} inspections, {counts['document']} documents.")
    import construction_report
    pc = construction_report._punch(db, job)
    if pc.get("total"):
        line(f"Punch list: {pc.get('verified', 0)} verified, {pc.get('done', 0)} done, {pc.get('open', 0)} open.")
    st["y"] -= 10
    line("By signing, the owner or client accepts that the work is substantially complete and may be used for "
         "its intended purpose. Open punch items and warranty obligations continue.", size=9.5, gap=12)
    st["y"] -= 40
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
    return buf.getvalue(), {"page": st["page"], "sign": (0.20, top, 0.42, 0.05),
                            "date": (0.70, (H - (base + 0.03 * H)) / H, 0.18, 0.03)}


def io_bytes():
    import io
    return io.BytesIO()


def send_signoff(db: Session, user: dict, job, signer_name: str, signer_email: str) -> dict:
    import construction_changes as cc
    pdf, spot = build_signoff_pdf(db, job)
    rid = cc.send_envelope(db, user, job, None, title=f"Substantial Completion - {job.name}", pdf=pdf, spot=spot,
                           link_kind=SIGNOFF_KIND, link_id=job.id, signer_name=signer_name, signer_email=signer_email,
                           message=f"Please review and sign the substantial completion of {job.name}.",
                           internal_emails=cc._internal(db, [signer_email]))
    job = db.get(models.ConstructionProject, job.id)
    co = dict(job.closeout or {})
    co["signoff"] = {"requestId": rid, "status": "sent", "signerName": signer_name, "signerEmail": signer_email,
                     "sentAt": now(), "signedAt": "", "sentBy": (user.get("email") or "").lower()}
    job.closeout = co
    db.add(models.ConstructionActivity(id=str(uuid.uuid4()), project_id=job.id, entity_kind="project",
                                       entity_id=job.id, type="signoff_sent",
                                       actor_email=(user.get("email") or "").lower(), at=now(),
                                       detail=f"sent the substantial completion to {signer_name} for signature"))
    db.commit()
    return co["signoff"]


def _signoff_job(db: Session, req):
    if (getattr(req, "link_kind", "") or "") != SIGNOFF_KIND:
        return None
    job = db.get(models.ConstructionProject, req.link_id or "")
    if job is None or ((job.closeout or {}).get("signoff") or {}).get("requestId") != req.id:
        return None
    return job


def _set_signoff(db: Session, job, status: str, **extra) -> None:
    co = dict(job.closeout or {})
    so = dict(co.get("signoff") or {})
    so.update({"status": status, **extra})
    co["signoff"] = so
    job.closeout = co
    db.add(models.ConstructionActivity(id=str(uuid.uuid4()), project_id=job.id, entity_kind="project",
                                       entity_id=job.id, type=f"signoff_{status}", actor_email="", at=now(),
                                       detail=f"substantial completion {status}"))


def on_completed(db: Session, req) -> None:
    job = _signoff_job(db, req)
    if job is None:
        return
    _set_signoff(db, job, "signed", signedAt=now())
    import construction_notify
    for em in sorted({(e or "").lower() for e in (job.manager_emails or [])} - {""}):
        construction_notify.bell(db, kind="signoff", family=("signoff",), recipient=em, ref_id=f"signoff:{job.id}",
                                 title="Substantial Completion Signed",
                                 body=f"The owner signed the substantial completion of {job.name}.",
                                 label="Open Closeout", sub=f"project:{job.id}:closeout", done=True,
                                 company=job.company_id or "")


def on_declined(db: Session, req, party=None, reason: str = "") -> None:
    job = _signoff_job(db, req)
    if job is not None:
        _set_signoff(db, job, "declined", declineReason=(reason or "")[:300])


def on_voided(db: Session, req, actor: str = "") -> None:
    job = _signoff_job(db, req)
    if job is not None:
        _set_signoff(db, job, "void")


def safe(fn, *a, **kw) -> None:
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - logged, never raised
        print(f"[construction-closeout] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")
