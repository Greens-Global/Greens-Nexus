"""Contractor invoices (Pranshu + Neil, Oct 21 2026).

A contractor (NexusEmployee.employment_type == 'contractor') invoices their
own company for a finalized Time Sheet period. The amount IS the finalized
card's pay (timeclock.finalize_timecard's frozen snapshot: fixed fee minus
absences, or hours x rate) - nothing is recalculated here.

Flow: finalize_timecard -> draft_for (a DRAFT row numbered from
contractor.invoice_next_number, a bell to the company's HR contact) -> HR
clicks Approve & Send -> the PDF is emailed to the company's
invoice_recipients with the contractor in cc, stored in hr-docs and filed to
the person's Egnyte folder best-effort on a thread. The email is sent on
HR's click only, never inside finalize (that runs inside the Nexus Sign seal
transaction). unfinalize voids the draft; a sent invoice stays.

The invoice is the contractor's own document: no Greens branding. DejaVu
Sans (backend/assets) carries the rupee sign the core PDF fonts lack.
"""
from __future__ import annotations

import io
import json
import os
import re
import threading
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import ContractorInvoice, HrEntity, NexusEmployee, NexusNotification, NexusRole
from task_due import us_date

router = APIRouter(prefix="/contractor-invoices", tags=["contractor-invoices"])

_FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
_FONTS_READY = False
_UNITS = {"INR": ("Rupees", "Paise"), "USD": ("Dollars", "Cents"), "GBP": ("Pounds", "Pence"),
          "EUR": ("Euros", "Cents"), "AED": ("Dirhams", "Fils")}
_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
         "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── amount in words (Indian system) ──────────────────────────────────────────

def _below_thousand(n: int) -> str:
    out = []
    if n >= 100:
        out.append(f"{_ONES[n // 100]} Hundred")
        n %= 100
    if n >= 20:
        out.append(_TENS[n // 10] + (f" {_ONES[n % 10]}" if n % 10 else ""))
    elif n:
        out.append(_ONES[n])
    return " ".join(out)


def _words(n: int) -> str:
    """0..99,99,99,999 in the Indian system: crore, lakh, thousand, hundred."""
    if n == 0:
        return "Zero"
    parts = []
    for div, name in ((10_000_000, "Crore"), (100_000, "Lakh"), (1000, "Thousand")):
        q, n = divmod(n, div)
        if q:
            parts.append(f"{_words(q) if div == 10_000_000 else _below_thousand(q)} {name}")
    if n:
        parts.append(_below_thousand(n))
    return " ".join(parts)


def amount_in_words(amount: float, currency: str = "INR") -> str:
    """40000 -> 'Forty Thousand Rupees Only'; 123456.5 -> 'One Lakh Twenty Three
    Thousand Four Hundred Fifty Six Rupees and Fifty Paise Only'."""
    unit, sub = _UNITS.get((currency or "INR").upper(), ((currency or "INR").upper(), "Cents"))
    whole = int(round(float(amount or 0), 2))
    frac = int(round((round(float(amount or 0), 2) - whole) * 100))
    if frac >= 100:
        whole, frac = whole + 1, 0
    text = f"{_words(whole)} {unit}"
    if frac:
        text += f" and {_words(frac)} {sub}"
    return f"{text} Only"


# ── data ─────────────────────────────────────────────────────────────────────

def _employee(db: Session, email: str) -> Optional[NexusEmployee]:
    return db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == (email or "").lower()).first()


def _name(emp: Optional[NexusEmployee], email: str) -> str:
    if emp and (emp.first_name or emp.last_name):
        return f"{emp.first_name or ''} {emp.last_name or ''}".strip()
    return (email or "").split("@")[0].replace(".", " ").title()


def _period_text(start: str, end: str) -> str:
    return f"{us_date(start)} - {us_date(end)}"


def _email_span(start: str, end: str) -> str:
    """What the invoice email says it covers (Pranshu, Oct 23): a whole
    calendar month (a fee contractor) is "for October 2026"; anything else (a
    bi-weekly hourly period) is "from 10/04/2026 to 10/17/2026"."""
    import calendar
    try:
        s, e = date.fromisoformat(start[:10]), date.fromisoformat(end[:10])
    except ValueError:
        return f"for {_period_text(start, end)}"
    if s.day == 1 and (e.year, e.month) == (s.year, s.month) and e.day == calendar.monthrange(s.year, s.month)[1]:
        return f"for {s.strftime('%B %Y')}"
    return f"from {us_date(start)} to {us_date(end)}"


def invoice_email(inv: ContractorInvoice, who: str, approver_name: str, approver_email: str) -> tuple[str, str]:
    """(subject, html) of the Approve & Send email (Pranshu, Oct 23). The
    subject reads like a filing name: "<invoice date> - <contractor> (<total>)",
    the total with any bonuses; the body says which month or which dates."""
    from html import escape as esc
    total = f"{inv.currency} {inv.amount:,.2f}"
    subject = f"{us_date(inv.invoice_date)} - {who} ({total})"
    by = f"{approver_name} ({approver_email})" if approver_name and approver_name != approver_email else approver_email
    html = (f"<p>Please find attached invoice {inv.number} from {esc(who)} "
            f"{_email_span(inv.period_start, inv.period_end)}: {total}.</p>"
            f"<p>Approved in Nexus by {esc(by)}.</p>")
    return subject, html


def _snapshot(emp: NexusEmployee, ent: Optional[HrEntity], inv: ContractorInvoice) -> dict:
    """The party blocks and lines as the PDF prints them - frozen with the row."""
    bank = (emp.bank or [{}])[0] if emp.bank else {}
    comp = emp.compensation or {}
    return {
        "number": inv.number, "invoiceDate": inv.invoice_date,
        "period": {"start": inv.period_start, "end": inv.period_end, "text": _period_text(inv.period_start, inv.period_end)},
        "currency": inv.currency, "amount": inv.amount, "hours": inv.hours, "rate": inv.rate,
        "description": inv.description, "amountInWords": amount_in_words(inv.amount, inv.currency),
        "billedBy": {"name": _name(emp, inv.employee_email),
                     # Personal Details' current address, else the profile's address fields.
                     "address": (emp.personal or {}).get("currentAddress", "") or ", ".join(
                         p for p in (emp.street_address, emp.city, " ".join(q for q in (emp.state, emp.postal_code) if q)) if p),
                     "phone": emp.phone or "", "email": emp.work_email or "",
                     "pan": (emp.compliance or {}).get("pan", "") or "", "gstin": comp.get("gstin", "") or ""},
        "billedTo": {"name": (ent.legal_name or ent.name) if ent else "", "address": (ent.physical_address or ent.registered_address) if ent else "",
                     # No company email column; a payer's personal mailbox is not the company's.
                     "email": "", "phone": (ent.main_phone or "") if ent else "", "taxId": (ent.tax_id or "") if ent else ""},
        "bank": {"holder": bank.get("holder", "") or "", "number": bank.get("number", "") or "",
                 "ifsc": bank.get("routingOrIfsc", "") or "", "type": bank.get("type", "") or "",
                 "bankName": bank.get("bankName", "") or ""},
    }


def _for_final(db: Session, final_id: str) -> Optional[ContractorInvoice]:
    return (db.query(ContractorInvoice)
            .filter(ContractorInvoice.final_approval_id == final_id, ContractorInvoice.status != "void").first())


def draft_for(db: Session, email: str, final_row) -> Optional[ContractorInvoice]:
    """Called by timeclock.finalize_timecard (inside its transaction, the
    final row not yet flushed): a DRAFT invoice for a contractor, numbered
    under the person's row lock; a no-op for everyone else and when the
    final row already has a live invoice. Bells the company's HR contact
    (Global Admins when there is none)."""
    from routers import timeclock as tc
    email = (email or "").strip().lower()
    emp = _employee(db, email)
    if emp is None or (emp.employment_type or "") != "contractor" or _for_final(db, final_row.id):
        return None
    snap = json.loads(final_row.note or "{}")
    currency = snap.get("currency") or "USD"
    if snap.get("payType") == "fixed":
        amount, hours, rate = float(snap.get("totalPay") or 0), None, None
    else:
        totals = tc._compute_timecard(db, email, final_row.period_start, final_row.period_end).get("totals", {})
        amount = float(totals.get("totalPay") or 0)
        hours, rate = round(int(final_row.worked_min or 0) / 60, 2), float(snap.get("rate") or 0)
    tc._lock_person(db, email)
    contractor = dict(emp.contractor or {})
    try:
        number = int(contractor.get("invoice_next_number") or 1)
    except (TypeError, ValueError):
        number = 1
    contractor["invoice_next_number"] = number + 1
    emp.contractor = contractor
    ent = db.query(HrEntity).filter(HrEntity.id == (emp.company or "")).first()
    inv = ContractorInvoice(
        id=str(uuid.uuid4()), employee_email=email, company_id=emp.company or "",
        period_start=final_row.period_start, period_end=final_row.period_end, number=number,
        invoice_date=date.today().isoformat(), currency=currency, amount=round(amount, 2),
        hours=hours, rate=rate, description=(contractor.get("invoice_description") or "Services").strip(),
        status="draft", final_approval_id=final_row.id, created_at=_now(), sent_to=[])
    inv.snapshot = _snapshot(emp, ent, inv)
    db.add(inv)
    _bell(db, emp, ent, inv)
    return inv


def _bell(db: Session, emp: NexusEmployee, ent: Optional[HrEntity], inv: ContractorInvoice) -> None:
    from notify_rollup import upsert_rollup
    hr = ((ent.hr_contact_email if ent else "") or "").strip().lower()
    recipients = [hr] if hr else [r.email.lower() for r in db.query(NexusRole).filter(NexusRole.role == "owner").all()]
    line = f"Invoice {inv.number}, {_period_text(inv.period_start, inv.period_end)}, {inv.currency} {inv.amount:,.2f}."
    for who in recipients:
        upsert_rollup(db, recipient=who, key=f"contractor-invoice:{inv.id}",
                      title=f"Contractor Invoice to Approve - {_name(emp, inv.employee_email)}", line=line,
                      action={"view": "hr", "sub": "hr-time-invoices"}, company=inv.company_id, replace=True)


def _settle_bell(db: Session, inv: ContractorInvoice, title: str, line: str) -> None:
    """The approve bell is done with (voided or sent): resolved in place for
    everyone who got it, so the bell does not keep asking."""
    from notify_rollup import resolve_rollup
    for row in db.query(NexusNotification.recipient).filter(NexusNotification.ref_id == f"contractor-invoice:{inv.id}").all():
        resolve_rollup(db, recipient=row.recipient, key=f"contractor-invoice:{inv.id}", title=title, line=line)


def void_for_final(db: Session, final_id: str) -> None:
    """unfinalize: the draft goes; a sent invoice is history and stays."""
    inv = _for_final(db, final_id)
    if inv is not None and inv.status == "draft":
        inv.status = "void"
        _settle_bell(db, inv, f"Contractor Invoice Voided - Invoice {inv.number}",
                     "The period was reopened; a new invoice is drafted when it is finalized again.")


def invoice_for_period(db: Session, email: str, start: str, end: str) -> Optional[dict]:
    """The card payload's `invoice` key: the latest non-void invoice of the period."""
    inv = (db.query(ContractorInvoice)
           .filter(ContractorInvoice.employee_email == (email or "").lower(), ContractorInvoice.status != "void",
                   ContractorInvoice.period_start == start, ContractorInvoice.period_end == end)
           .order_by(ContractorInvoice.created_at.desc()).first())
    if inv is None:
        return None
    return {"id": inv.id, "number": inv.number, "status": inv.status, "amount": inv.amount,
            "currency": inv.currency, "sentAt": inv.sent_at or ""}


def card_keys(db: Session, email: str, start: str, end: str) -> dict:
    emp = _employee(db, email)
    contractor = bool(emp and (emp.employment_type or "") == "contractor")
    return {"contractor": contractor, "invoice": invoice_for_period(db, email, start, end) if contractor else None}


# ── PDF ──────────────────────────────────────────────────────────────────────

def _fonts() -> tuple:
    """DejaVu Sans (has the rupee sign); the core fonts if the files are missing."""
    global _FONTS_READY
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    if not _FONTS_READY:
        try:
            pdfmetrics.registerFont(TTFont("DejaVu", os.path.join(_FONT_DIR, "DejaVuSans.ttf")))
            pdfmetrics.registerFont(TTFont("DejaVu-Bold", os.path.join(_FONT_DIR, "DejaVuSans-Bold.ttf")))
            _FONTS_READY = True
        except Exception as e:  # noqa: BLE001
            print(f"[contractor-invoices] DejaVu fonts not loaded, using Helvetica: {e}")
            return "Helvetica", "Helvetica-Bold"
    return "DejaVu", "DejaVu-Bold"


def _money(amount: float, currency: str, rupee_ok: bool) -> str:
    sym = {"INR": "₹" if rupee_ok else "Rs. ", "USD": "$", "GBP": "£", "EUR": "€"}.get((currency or "").upper())
    return f"{sym}{float(amount or 0):,.2f}" if sym else f"{currency} {float(amount or 0):,.2f}"


def render_pdf(snap: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from xml.sax.saxutils import escape as esc

    reg, bold = _fonts()
    rupee_ok = reg == "DejaVu"
    ink, dim, line = colors.HexColor("#1a1a1f"), colors.HexColor("#6b6b75"), colors.HexColor("#c4c7cd")
    S = ParagraphStyle("s", fontName=reg, fontSize=9.5, leading=13, textColor=ink)
    SB = ParagraphStyle("sb", parent=S, fontName=bold)
    LBL = ParagraphStyle("lbl", parent=S, fontName=bold, fontSize=7.5, leading=10, textColor=dim)
    H1 = ParagraphStyle("h1", parent=S, fontName=bold, fontSize=26, leading=30)
    R = ParagraphStyle("r", parent=S, alignment=2)
    RB = ParagraphStyle("rb", parent=SB, alignment=2)
    FOOT = ParagraphStyle("foot", parent=S, fontSize=8, textColor=dim, alignment=1)
    W = letter[0] - 2 * 54 - 12      # the frame keeps 6pt of padding each side

    def block(label: str, rows: list) -> list:
        out = [Paragraph(label, LBL)]
        for i, r in enumerate(rows):
            if r:
                out.append(Paragraph(esc(str(r)), SB if i == 0 else S))
        return out

    by, to, bank = snap.get("billedBy") or {}, snap.get("billedTo") or {}, snap.get("bank") or {}
    cur = snap.get("currency") or "INR"
    meta = Table([[Paragraph("INVOICE NUMBER", LBL), Paragraph(esc(str(snap.get("number", ""))), SB)],
                  [Paragraph("INVOICE DATE", LBL), Paragraph(us_date(snap.get("invoiceDate", "")), S)],
                  [Paragraph("PERIOD", LBL), Paragraph(esc((snap.get("period") or {}).get("text", "")), S)]],
                 colWidths=[90, 130], hAlign="RIGHT")
    meta.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
    head = Table([[Paragraph("INVOICE", H1), meta]], colWidths=[W - 220, 220])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))

    parties = Table([[block("BILLED BY", [by.get("name"), by.get("address"), by.get("phone"), by.get("email"),
                                           f"PAN: {by['pan']}" if by.get("pan") else "",
                                           f"GSTIN: {by['gstin']}" if by.get("gstin") else ""]),
                      block("BILLED TO", [to.get("name"), to.get("address"), to.get("email"), to.get("phone"),
                                          f"GSTIN: {to['taxId']}" if to.get("taxId") else ""])]],
                    colWidths=[W / 2, W / 2])
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                 ("LINEABOVE", (0, 0), (-1, 0), 0.8, ink), ("TOPPADDING", (0, 0), (-1, -1), 8)]))

    desc = esc(snap.get("description") or "Services")
    if snap.get("hours") is not None and snap.get("rate") is not None:
        desc += (f"<br/><font color='#6b6b75' size='8'>{float(snap['hours']):,.2f} hours x "
                 f"{esc(_money(snap['rate'], cur, rupee_ok))} per hour</font>")
    total = _money(snap.get("amount", 0), cur, rupee_ok)
    items = Table([[Paragraph("DESCRIPTION", LBL), Paragraph("AMOUNT", ParagraphStyle("lr", parent=LBL, alignment=2))],
                   [Paragraph(desc, S), Paragraph(esc(total), R)],
                   [Paragraph("TOTAL", RB), Paragraph(esc(total), RB)]],
                  colWidths=[W - 140, 140])
    items.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.8, ink), ("LINEBELOW", (0, 1), (-1, 1), 0.5, line),
                               ("LINEBELOW", (0, 2), (-1, 2), 0.8, ink), ("TOPPADDING", (0, 0), (-1, -1), 7),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 7), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("VALIGN", (0, 0), (-1, -1), "TOP")]))

    bank_rows = [("Account Name", bank.get("holder")), ("Account Number", bank.get("number")),
                 ("IFSC", bank.get("ifsc")), ("Account Type", (bank.get("type") or "").title()), ("Bank", bank.get("bankName"))]
    bank_tbl = Table([[Paragraph(k, LBL), Paragraph(esc(str(v)), S)] for k, v in bank_rows if v],
                     colWidths=[110, W / 2 - 110], hAlign="LEFT") if any(v for _, v in bank_rows) else Spacer(1, 1)
    if not isinstance(bank_tbl, Spacer):
        bank_tbl.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))

    story = [head, Spacer(1, 18), parties, Spacer(1, 22), items, Spacer(1, 10),
             Paragraph(f"<b>Amount in Words:</b> {esc(snap.get('amountInWords') or amount_in_words(snap.get('amount', 0), cur))}", S),
             Spacer(1, 28)]
    if not isinstance(bank_tbl, Spacer):   # no account on file = no empty heading
        story += [Paragraph("BANK DETAILS", LBL), Spacer(1, 4), bank_tbl, Spacer(1, 40)]
    story.append(Paragraph("This is a computer generated invoice and does not require a signature.", FOOT))
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=letter, leftMargin=54, rightMargin=54, topMargin=54, bottomMargin=54,
                      title=f"Invoice {snap.get('number', '')}", author=by.get("name") or "").build(story)
    return buf.getvalue()


def _filename(inv: ContractorInvoice) -> str:
    who = re.sub(r'[\\/:*?"<>|]+', " ", (inv.snapshot or {}).get("billedBy", {}).get("name") or inv.employee_email).strip()
    return f"{inv.invoice_date} - Invoice {inv.number} - {who}.pdf"


# ── access ───────────────────────────────────────────────────────────────────

def _hr_companies(user: dict, db: Session) -> Optional[set]:
    """None = every company; else the companies this HR person may act for:
    an administrator or Full HR grant (within hr_scope) plus any company they
    are the HR contact of. 403 when that is nothing."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, TeamScope, _module_level, hr_scope
    me = (user.get("email") or "").lower()
    full = user.get("level", 0) >= _LEVELS["administrator"] or _module_level(me, "hr", db) >= _MODULE_LEVEL_RANK["full"]
    scope = hr_scope(user, db) if full else set()
    if full and scope is None:
        return None
    contact = {e.id for e in db.query(HrEntity).filter(func.lower(HrEntity.hr_contact_email) == me).all()}
    out = (set() if isinstance(scope, TeamScope) else set(scope or ())) | contact
    if not out:
        raise HTTPException(403, "HR only")
    return out


def _get(db: Session, inv_id: str) -> ContractorInvoice:
    inv = db.query(ContractorInvoice).filter(ContractorInvoice.id == inv_id).first()
    if inv is None:
        raise HTTPException(404, "Invoice not found")
    return inv


def _out(db: Session, inv: ContractorInvoice, ents: dict, with_recipients: bool) -> dict:
    ent = ents.get(inv.company_id)
    if ent is None and inv.company_id:
        ent = ents[inv.company_id] = db.query(HrEntity).filter(HrEntity.id == inv.company_id).first()
    d = {"id": inv.id, "employeeEmail": inv.employee_email,
         "employeeName": (inv.snapshot or {}).get("billedBy", {}).get("name") or inv.employee_email,
         "companyId": inv.company_id, "companyName": (ent.name if ent else "") or "",
         "periodStart": inv.period_start, "periodEnd": inv.period_end, "number": inv.number,
         "invoiceDate": inv.invoice_date, "currency": inv.currency, "amount": inv.amount, "hours": inv.hours,
         "rate": inv.rate, "description": inv.description, "status": inv.status, "createdAt": inv.created_at,
         "approvedBy": inv.approved_by or "", "sentAt": inv.sent_at or "", "sentTo": list(inv.sent_to or [])}
    if with_recipients:
        d["recipients"] = list((ent.invoice_recipients if ent else None) or [])
    return d


# ── endpoints ────────────────────────────────────────────────────────────────

@router.get("")
def list_invoices(status: str = "draft", company: str = "", user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    allowed = _hr_companies(user, db)
    q = db.query(ContractorInvoice)
    if status != "all":
        q = q.filter(ContractorInvoice.status == (status if status in ("draft", "sent", "void") else "draft"))
    if company:
        if allowed is not None and company not in allowed:
            raise HTTPException(404, "Company not found")
        q = q.filter(ContractorInvoice.company_id == company)
    elif allowed is not None:
        q = q.filter(ContractorInvoice.company_id.in_(sorted(allowed)))
    ents: dict = {}
    rows = q.order_by(ContractorInvoice.created_at.desc()).all()
    return {"invoices": [_out(db, r, ents, True) for r in rows]}


@router.get("/mine")
def my_invoices(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(ContractorInvoice)
            .filter(ContractorInvoice.employee_email == (user.get("email") or "").lower(),
                    ContractorInvoice.status != "void")
            .order_by(ContractorInvoice.created_at.desc()).all())
    ents: dict = {}
    return {"invoices": [_out(db, r, ents, False) for r in rows]}


def _may_read(user: dict, db: Session, inv: ContractorInvoice) -> None:
    if inv.employee_email == (user.get("email") or "").lower():
        return
    allowed = _hr_companies(user, db)
    if allowed is not None and inv.company_id not in allowed:
        raise HTTPException(404, "Invoice not found")


@router.get("/{inv_id}/pdf")
def invoice_pdf(inv_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    inv = _get(db, inv_id)
    _may_read(user, db, inv)
    blob = b""
    if inv.status == "sent" and inv.pdf_path:
        from routers.esign import _DOC_BUCKET, _storage_fetch
        got = _storage_fetch(_DOC_BUCKET, inv.pdf_path)
        blob = got.content if got.is_success else b""
    blob = blob or render_pdf(inv.snapshot or {})
    return Response(blob, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{_filename(inv)}"'})


def _file_to_egnyte(inv_id: str, blob: bytes, name: str) -> None:
    """Best-effort, on its own thread and session: the person's Egnyte folder."""
    from database import SessionLocal
    try:
        import egnyte_wiring
        from services import egnyte as svc
        db = SessionLocal()
        try:
            inv = db.query(ContractorInvoice).filter(ContractorInvoice.id == inv_id).first()
            emp = _employee(db, inv.employee_email) if inv else None
            folder = egnyte_wiring.provision_person_folder(emp, db) if emp else ""
            if not folder:
                return
            path = f"/{folder.strip('/')}/{name}"
            svc.upload_file(path, blob)
            inv.egnyte_path = path
            db.commit()
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 - filing never fails a sent invoice
        print(f"[contractor-invoices] Egnyte filing failed for {inv_id}: {type(e).__name__}: {e}")


@router.post("/{inv_id}/send")
def send_invoice(inv_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import graph_mail
    allowed = _hr_companies(user, db)
    inv = _get(db, inv_id)
    if allowed is not None and inv.company_id not in allowed:
        raise HTTPException(404, "Invoice not found")
    if inv.status != "draft":
        raise HTTPException(409, f"This invoice is already {inv.status}")
    ent = db.query(HrEntity).filter(HrEntity.id == inv.company_id).first()
    recipients = list((ent.invoice_recipients if ent else None) or [])
    if not recipients:
        raise HTTPException(400, "Set Contractor Invoice Recipients on the company first.")
    snap = inv.snapshot or {}
    blob = render_pdf(snap)
    name = _filename(inv)
    who = (snap.get("billedBy") or {}).get("name") or inv.employee_email
    emailed = False
    if graph_mail.graph_configured():
        me = (user.get("email") or "").lower()
        subject, html = invoice_email(inv, who, _name(_employee(db, me), me), me)
        try:
            graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=recipients, cc=[inv.employee_email],
                                 subject=subject, html=html,
                                 attachments=[(name, "application/pdf", blob)])
            emailed = True
        except graph_mail.GraphMailError as e:
            raise HTTPException(502, f"The invoice could not be emailed: {e}") from e
    from routers.esign import _DOC_BUCKET, _storage_put
    path = f"contractor-invoices/{inv.id}/{name}"
    put = _storage_put(_DOC_BUCKET, path, blob, "application/pdf", upsert=True)
    if put.is_success:
        inv.pdf_path = path
    else:
        print(f"[contractor-invoices] PDF not stored for {inv.id}: {put.text[:200]}")
    inv.status, inv.sent_at, inv.sent_to, inv.approved_by = "sent", _now(), recipients, (user.get("email") or "").lower()
    _settle_bell(db, inv, f"Contractor Invoice Sent - Invoice {inv.number}", f"Sent to {', '.join(recipients)}.")
    db.commit()
    try:
        from services import egnyte as svc
        if svc.configured():
            threading.Thread(target=_file_to_egnyte, args=(inv.id, blob, name), daemon=True).start()
    except Exception as e:  # noqa: BLE001
        print(f"[contractor-invoices] Egnyte not started for {inv.id}: {e}")
    return {"sent": True, "emailed": emailed, "invoice": _out(db, inv, {inv.company_id: ent}, True)}
