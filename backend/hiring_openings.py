"""Job openings and the public careers page (Neil, Oct 27 2026).

Hiring used to start at the candidate. Now it can start a step earlier:

  headcount request (routers/hiring.py) -> approved -> job opening (Draft)
  -> HR writes the description and opens it -> the company's careers page
  lists it (routers/careers.py) -> people apply -> candidates at Applied,
  linked to the opening, source "Careers Page".

This module is what both routers (and hr.py's hire path) share: the company
slug for the careers URL, the public face of an opening (never a person, a
salary the toggle does not show, or a count), its schema.org JobPosting,
the plain-text description rendered as HTML, the grouped new-applicant bell,
the seat count that marks an opening Filled, and the job-board seam.

Job boards: LinkedIn's Job Posting API is closed to new partners and Indeed
takes direct posts only from approved ATS partners, so Nexus does not post
to either. What it does: a formatted posting to paste into LinkedIn's own
job form, a link to Indeed's employer site, and JobPosting structured data
on the careers page that Google for Jobs (and job sites that crawl it) can
read. `BOARDS` / `publish()` are the seam for a real API later.
"""
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from html import escape
from typing import Optional

from sqlalchemy.orm import Session

import models

EMPLOYMENT_TYPES = ("full_time", "part_time", "contractor", "intern", "temporary")
EMPLOYMENT_LABELS = {"full_time": "Full-Time", "part_time": "Part-Time", "contractor": "Contractor",
                     "intern": "Intern", "temporary": "Temporary"}
# schema.org JobPosting.employmentType values Google reads.
_SCHEMA_EMPLOYMENT = {"full_time": "FULL_TIME", "part_time": "PART_TIME", "contractor": "CONTRACTOR",
                      "intern": "INTERN", "temporary": "TEMPORARY"}
PAY_PERIODS = ("year", "month", "hour")
_PERIOD_UNIT = {"year": "YEAR", "month": "MONTH", "hour": "HOUR"}
_PERIOD_WORD = {"year": "per year", "month": "per month", "hour": "per hour"}
OPENING_STATUSES = ("draft", "open", "paused", "filled", "closed")
STATUS_LABELS = {"draft": "Draft", "open": "Open", "paused": "Paused", "filled": "Filled", "closed": "Closed"}
CAREERS_SOURCE = "Careers Page"
DEFAULT_VALID_DAYS = 60          # an opening opened with no end date runs this long


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def history_add(row, by: str, action: str, note: str = "") -> None:
    """Append one line to a row's history (never edited)."""
    row.history = list(row.history or []) + [{"at": now_iso(), "by": (by or "").lower(), "action": action,
                                              "note": (note or "")[:2000]}]


# ── the company's careers address ────────────────────────────────────────────

def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:60].strip("-") or "company"


def slug_map(db: Session) -> dict:
    """{slug: HrEntity} - one careers address per company, from its name.
    Two companies whose names make the same slug: the older keeps it, the
    next gets "-2" (ordered by created_at then id, so it never flips)."""
    out = {}
    rows = db.query(models.HrEntity).all()
    rows.sort(key=lambda e: ((e.created_at or ""), e.id))
    for e in rows:
        base = _slugify(e.name)
        slug, n = base, 2
        while slug in out:
            slug, n = f"{base}-{n}", n + 1
        out[slug] = e
    return out


def slug_for(db: Session, company_id: str) -> str:
    for slug, e in slug_map(db).items():
        if e.id == company_id:
            return slug
    return ""


def careers_url(db: Session, company_id: str, opening_id: str = "") -> str:
    from app_url import app_url
    slug = slug_for(db, company_id)
    if not slug:
        return ""
    return f"{app_url()}/careers/{slug}" + (f"/{opening_id}" if opening_id else "")


# ── what the public may see ──────────────────────────────────────────────────

def is_listed(op: models.HrJobOpening, today: Optional[str] = None) -> bool:
    """On the careers page: Open, and not past its end date."""
    if (op.status or "") != "open":
        return False
    vt = (op.valid_through or "")[:10]
    return not vt or vt >= (today or date.today().isoformat())


def location_line(op: models.HrJobOpening) -> str:
    if (op.location or "").strip():
        line = op.location.strip()
    else:
        line = ", ".join(x for x in ((op.city or "").strip(), " ".join(
            y for y in ((op.region or "").strip(), (op.postal_code or "").strip()) if y)) if x)
    if op.remote:
        return f"Remote{f' - {line}' if line else ''}"
    return line


def pay_text(op_or_dict) -> str:
    """"$70,000 - $90,000 per year" - '' when no range is set."""
    get = (op_or_dict.get if isinstance(op_or_dict, dict) else lambda k, d=None: getattr(op_or_dict, k, d))
    lo, hi = get("pay_min"), get("pay_max")
    if lo is None and hi is None:
        return ""
    from currency import money_prefix
    sym = money_prefix(get("pay_currency") or "USD")
    cents = (get("pay_period") or "year") == "hour"

    def fmt(v):
        return f"{sym}{v:,.2f}" if cents else f"{sym}{v:,.0f}"
    word = _PERIOD_WORD.get(get("pay_period") or "year", "per year")
    if lo is not None and hi is not None and lo != hi:
        return f"{fmt(lo)} - {fmt(hi)} {word}"
    return f"{fmt(lo if lo is not None else hi)} {word}"


def public_company(db: Session, ent: models.HrEntity, slug: str) -> dict:
    return {"name": ent.name or "", "legalName": ent.legal_name or "", "slug": slug,
            "logoUrl": (ent.logo_url or "").strip(), "website": (ent.website or "").strip()}


def public_opening(op: models.HrJobOpening, full: bool = False) -> dict:
    """The careers page's copy of an opening - nothing about who owns it, who
    asked for it, who applied or a salary the toggle keeps private."""
    out = {"id": op.id, "title": op.title or "", "department": op.department or "",
           "employmentType": op.employment_type or "", "employmentLabel": EMPLOYMENT_LABELS.get(op.employment_type or "", ""),
           "location": location_line(op), "remote": bool(op.remote),
           "postedAt": (op.opened_at or "")[:10], "validThrough": (op.valid_through or "")[:10],
           "pay": pay_text(op) if op.show_pay else ""}
    if full:
        out["description"] = op.description or ""
    return out


# ── the description: plain text in, safe HTML out ────────────────────────────

_BULLET = re.compile(r"^\s*[-*•]\s+")


def description_html(text: str) -> str:
    """Blank lines split paragraphs; a block whose every line starts with
    "- " (or * or a bullet) is a list. Everything is escaped - no markup from
    the editor ever reaches the page."""
    out = []
    for block in re.split(r"\n\s*\n", (text or "").strip()):
        lines = [ln.rstrip() for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        if all(_BULLET.match(ln) for ln in lines):
            out.append("<ul>" + "".join(f"<li>{escape(_BULLET.sub('', ln).strip())}</li>" for ln in lines) + "</ul>")
        else:
            out.append("<p>" + "<br>".join(escape(ln.strip()) for ln in lines) + "</p>")
    return "".join(out)


def description_plain(text: str) -> str:
    return "\n".join(ln.rstrip() for ln in (text or "").strip().split("\n"))


# ── schema.org JobPosting (Google for Jobs reads it from the page) ───────────

def job_posting(db: Session, op: models.HrJobOpening, ent: models.HrEntity) -> dict:
    org = {"@type": "Organization", "name": ent.legal_name or ent.name or ""}
    if (ent.website or "").strip():
        org["sameAs"] = ent.website.strip()
    if (ent.logo_url or "").strip():
        org["logo"] = ent.logo_url.strip()
    country = (op.country or ent.country or "").strip().upper()
    ld = {
        "@context": "https://schema.org/",
        "@type": "JobPosting",
        "title": op.title or "",
        "description": description_html(op.description) or escape(op.title or ""),
        "datePosted": (op.opened_at or op.created_at or "")[:10],
        "employmentType": _SCHEMA_EMPLOYMENT.get(op.employment_type or "", "OTHER"),
        "hiringOrganization": org,
        "identifier": {"@type": "PropertyValue", "name": ent.name or "", "value": op.id},
        "directApply": True,
        "url": careers_url(db, op.company, op.id),
    }
    vt = (op.valid_through or "")[:10]
    if vt:
        ld["validThrough"] = f"{vt}T23:59:59"
    addr = {"@type": "PostalAddress"}
    for key, val in (("streetAddress", op.street), ("addressLocality", op.city), ("addressRegion", op.region),
                     ("postalCode", op.postal_code), ("addressCountry", country)):
        if (val or "").strip():
            addr[key] = val.strip()
    if op.remote:
        ld["jobLocationType"] = "TELECOMMUTE"
        if country:
            ld["applicantLocationRequirements"] = {"@type": "Country", "name": country}
    if len(addr) > 1:
        ld["jobLocation"] = {"@type": "Place", "address": addr}
    if op.show_pay and (op.pay_min is not None or op.pay_max is not None):
        value = {"@type": "QuantitativeValue", "unitText": _PERIOD_UNIT.get(op.pay_period or "year", "YEAR")}
        if op.pay_min is not None and op.pay_max is not None and op.pay_min != op.pay_max:
            value["minValue"], value["maxValue"] = op.pay_min, op.pay_max
        else:
            value["value"] = op.pay_min if op.pay_min is not None else op.pay_max
        ld["baseSalary"] = {"@type": "MonetaryAmount", "currency": (op.pay_currency or "USD").upper(), "value": value}
    return ld


def ld_script(ld: dict) -> str:
    """A <script type="application/ld+json"> that no value can break out of."""
    raw = json.dumps(ld, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return f'<script type="application/ld+json">{raw}</script>'


# ── candidates and seats ─────────────────────────────────────────────────────

def candidate_counts(db: Session, opening_ids: list) -> dict:
    """{opening_id: {"total": n, "hired": n, "<stage>": n}} - candidates still
    on the board (removed rejected ones are not counted)."""
    out = {i: {"total": 0, "hired": 0} for i in opening_ids}
    if not opening_ids:
        return out
    from routers.hr import _is_inactive
    for c in db.query(models.HrCandidate).filter(models.HrCandidate.opening_id.in_(opening_ids)).all():
        if _is_inactive(c):
            continue
        d = out.setdefault(c.opening_id, {"total": 0, "hired": 0})
        d["total"] += 1
        d[c.stage] = d.get(c.stage, 0) + 1
    return out


def seat_filled(db: Session, cand: models.HrCandidate, by: str) -> Optional[models.HrJobOpening]:
    """A candidate linked to an opening is being hired (hr.create_employee_
    from_candidate - their stage is not set yet, and autoflush is off, so
    they are counted here by hand). The last seat taken marks it Filled and
    tells the hiring owner. The caller commits."""
    oid = (cand.opening_id or "").strip()
    if not oid:
        return None
    op = db.query(models.HrJobOpening).filter(models.HrJobOpening.id == oid).with_for_update().first()
    if op is None or op.status in ("filled", "closed"):
        return None
    hired = (db.query(models.HrCandidate)
             .filter(models.HrCandidate.opening_id == oid, models.HrCandidate.stage == "hired",
                     models.HrCandidate.id != cand.id).count()) + 1
    if hired < max(1, op.seats or 1):
        return None
    op.status, op.filled_at, op.updated_at = "filled", now_iso(), now_iso()
    history_add(op, by, "filled", f"{hired} of {op.seats or 1} hired")
    owner = (op.hiring_owner_email or "").strip().lower()
    if owner:
        from routers.hr import _hr_notify
        _hr_notify(db, owner, f"Opening Filled - {op.title}",
                   f"Every seat on {op.title} is filled ({hired} hired). It is off the careers page.",
                   ref_id=op.id, requested_by=by, action={"view": "hr", "sub": "hr-hiring"})
    return op


# ── one bell per thing, updated in place ─────────────────────────────────────

def notify_once(db: Session, recipient: str, ref_id: str, title: str, body: str, by: str = "",
                action: Optional[dict] = None) -> None:
    """ONE bell per (person, thing): while the last one is still unread it is
    rewritten in place, not stacked (CLAUDE.md: one notification per workflow,
    updated in place; locked so two requests at once do not both add one)."""
    to = (recipient or "").strip().lower()
    if not to:
        return
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == to, models.NexusNotification.ref_id == ref_id,
                   models.NexusNotification.type == "custom_alert")
           .order_by(models.NexusNotification.created_at.desc()).with_for_update().first())
    read = row is not None and to in {x.strip().lower() for x in (row.read_by or "").split(",") if x.strip()}
    closed = row is not None and to in {x.strip().lower() for x in (getattr(row, "closed_by", "") or "").split(",") if x.strip()}
    if row is not None and not read and not closed and not row.actioned:
        row.title, row.body, row.created_at = title, body, now_iso()
        if action:
            row.action = json.dumps(action)
        return
    from routers.hr import _hr_notify
    _hr_notify(db, to, title, body, ref_id=ref_id, requested_by=by, action=action)


def applicant_owner(db: Session, op: models.HrJobOpening) -> str:
    """Who hears about new applicants: the hiring owner, else the company's
    HR contact, else nobody (the board still shows them)."""
    from hiring_screening import _person
    for email in ((op.hiring_owner_email or ""),):
        if _person(db, email):
            return email.strip().lower()
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == op.company).first()
    hr = (ent.hr_contact_email or "").strip().lower() if ent else ""
    return hr if hr and _person(db, hr) else ""


def notify_new_applicant(db: Session, op: models.HrJobOpening) -> None:
    """The grouped bell for the opening's owner: how many applicants wait in
    Applied, and who. One bell, rewritten while unread. The caller commits."""
    owner = applicant_owner(db, op)
    if not owner:
        return
    rows = (db.query(models.HrCandidate)
            .filter(models.HrCandidate.opening_id == op.id, models.HrCandidate.stage == "applied")
            .order_by(models.HrCandidate.created_at.desc()).all())
    rows = [c for c in rows if not (c.inactive_at or "").strip()]
    n = len(rows)
    if not n:
        return
    names = [f"{c.first_name} {(c.last_name or '')[:1]}.".strip() for c in rows[:5]]
    more = f" and {n - 5} more" if n > 5 else ""
    from auth import _module_level, level_for
    hr_reader = level_for(owner, db) >= 4 or _module_level(owner, "hr", db) >= 1
    notify_once(db, owner, f"opening:{op.id}",
                f"New Applicant{'s' if n != 1 else ''} - {op.title}",
                f"{n} applicant{'s' if n != 1 else ''} waiting in Applied from the careers page: "
                f"{', '.join(names)}{more}.",
                action={"view": "hr", "sub": "hr-hiring"} if hr_reader else {"view": "tasks", "sub": "mine"})


# ── job boards: the seam ─────────────────────────────────────────────────────

# mode "copy": Nexus formats the posting and opens the board's own form;
# mode "link": Nexus opens the board's employer site. A board with a real API
# later gets mode "api" and an entry in publish() - nothing else changes.
BOARDS = (
    {"id": "linkedin", "name": "LinkedIn", "label": "Post On LinkedIn", "mode": "copy",
     "url": "https://www.linkedin.com/talent/post-a-job",
     "hint": "Copies the posting - paste it into LinkedIn's job form. The apply link goes to your careers page."},
    {"id": "indeed", "name": "Indeed", "label": "Sponsor On Indeed", "mode": "link",
     "url": "https://employers.indeed.com/",
     "hint": "Indeed reads open jobs from your careers page by itself; sponsoring is done on Indeed's employer site."},
)


def publish(board_id: str, op: models.HrJobOpening) -> dict:
    """A direct post to a job board. None is connected today (see the module
    docstring) - a future integration implements its board here."""
    raise NotImplementedError(f"No direct integration for {board_id} - use the copy / link flow.")


def posting_text(db: Session, op: models.HrJobOpening, ent: Optional[models.HrEntity]) -> str:
    """The posting as plain text, for pasting into a job board's form."""
    company = (ent.name if ent else "") or ""
    head = " - ".join(x for x in (company, location_line(op), EMPLOYMENT_LABELS.get(op.employment_type or "", "")) if x)
    parts = [op.title or "", head, "", description_plain(op.description)]
    if op.show_pay and pay_text(op):
        parts += ["", f"Pay: {pay_text(op)}"]
    url = careers_url(db, op.company, op.id)
    if url:
        parts += ["", f"Apply: {url}"]
    return "\n".join(parts).strip() + "\n"


# ── the opening an approved headcount request becomes ────────────────────────

def opening_from_request(db: Session, req: models.HrHeadcountRequest, by: str) -> models.HrJobOpening:
    """A Draft opening carrying the request's role, place, seats and (still
    private) pay range. HR writes the description and opens it. The caller
    commits."""
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == req.company).first()
    role = (db.query(models.NexusGroup).filter(models.NexusGroup.id == req.role_id).first()
            if req.role_id else None)
    site = (db.query(models.HrWorkSite).filter(models.HrWorkSite.id == req.work_site_id).first()
            if req.work_site_id else None)
    now = now_iso()
    op = models.HrJobOpening(
        id=str(uuid.uuid4()), headcount_id=req.id, company=req.company, department=req.department,
        role_id=req.role_id, title=req.role_title,
        description=(getattr(role, "job_description", "") or "") if role else "",
        employment_type=req.employment_type or "full_time", seats=max(1, req.openings or 1),
        work_site_id=req.work_site_id or "", location=req.location or (site.name if site else ""),
        street=(site.address if site else "") or "", country=(ent.country if ent else "") or "",
        status="draft", show_pay=False, pay_min=req.salary_min, pay_max=req.salary_max,
        pay_currency=req.salary_currency or "USD", pay_period=req.salary_period or "year",
        hiring_owner_email=(req.requested_by or "").lower(), created_by=(by or "").lower(),
        created_at=now, updated_at=now, history=[])
    history_add(op, by, "created", f"From headcount request {req.code}")
    db.add(op)
    return op


def default_valid_through(opened: str) -> str:
    try:
        d = datetime.fromisoformat((opened or now_iso())[:10]).date()
    except ValueError:
        d = date.today()
    return (d + timedelta(days=DEFAULT_VALID_DAYS)).isoformat()
