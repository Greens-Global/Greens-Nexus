"""The public careers page and apply form (Neil, Oct 27 2026). No login.

  GET  /careers/public/{slug}              the company and its Open openings
  GET  /careers/public/{slug}/{opening}    one opening, with its JobPosting
  GET  /careers/page/{slug}[/{opening}]    the same as ready-made <head> and
                                           body HTML, for the Cloudflare Pages
                                           Function (frontend/functions/careers)
                                           that puts it into the page it serves,
                                           so a crawler that runs no JavaScript
                                           still reads the JSON-LD
  GET  /careers/sitemap.xml                every listed opening
  POST /careers/apply/{opening}            the apply form (multipart)

What leaves here is the careers copy of an opening only (hiring_openings.
public_opening): never who owns it, who asked for it, who applied, how many,
or a pay range the opening's public pay toggle keeps private.

The apply form is a credential-free write, so it is guarded several ways:
`/careers/apply/` is a SENSITIVE_PREFIX (30 a minute per IP,
middleware_hardening.RequestRateLimit; a body over 11 MB is refused there on
its Content-Length), plus APPLY_PER_IP_HOUR here (an IPv6 caller counted by
its /64 - client_ip.rate_key), a daily cap per opening (checked before the
form looks for an earlier application, so a full opening answers everyone
alike), a honeypot field (`nx_f2`, a name that means nothing; filled = a bot:
answered like a success, nothing kept, a log line and a running count),
required consent, and a resume that must BE a PDF / DOC / DOCX by its first
bytes (not its name or the browser's word), under MAX_RESUME_BYTES. The resume
goes to the private hr-docs bucket through the backend, never a browser upload.

The same email applying again to the same opening never changes the candidate
(release review, Oct 27 2026: a form with no login must not let anybody
rewrite somebody else's name, phone or resume). Still at Applied from this
page: the new resume is added to the screening task as an additional document
and the timeline notes "Applied again on MM/DD/YYYY"; anywhere else in the
pipeline, the note only. The answer is the same as a new application's.

The confirmation email goes at most once a day per application, and is capped
per address (normalized: +tags dropped, Gmail's dots ignored) a day, per
domain an hour and in all an hour, so the form cannot be used to flood
somebody's inbox. It names the job and the company, never the name typed in.
"""
import collections
import io
import re
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

import hiring_openings as ho
import models
from database import get_db

router = APIRouter(prefix="/careers", tags=["careers"])

MAX_RESUME_BYTES = 10 * 1024 * 1024
APPLY_PER_IP_HOUR = 8
APPLY_PER_OPENING_DAY = 200
EMAILS_PER_ADDRESS_DAY = 3
EMAILS_PER_DOMAIN_HOUR = 40
EMAILS_PER_HOUR = 300
_EMAIL_RE = re.compile(r"^[^@\s<>\"']+@[^@\s<>\"']+\.[^@\s<>\"']{2,}$")
_LINKEDIN_RE = re.compile(r"^https?://([a-z]{2,3}\.)?linkedin\.com/[A-Za-z0-9\-_/%.?=&#]*$", re.I)
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_OK = {"ok": True, "message": "Thank you - your application is in. We will be in touch."}

_lock = threading.Lock()
_ip_hits: "collections.OrderedDict[str, collections.deque]" = collections.OrderedDict()
_mail_hits: "collections.OrderedDict[str, collections.deque]" = collections.OrderedDict()
_honeypot = {"dropped": 0}


def _ip_allowed(ip: str, now: Optional[float] = None) -> bool:
    """APPLY_PER_IP_HOUR applications an hour from one address (in-process,
    per worker - a backstop under the request rate limit)."""
    now = now or time.time()
    with _lock:
        dq = _ip_hits.get(ip)
        if dq is None:
            dq = _ip_hits[ip] = collections.deque()
        _ip_hits.move_to_end(ip)
        while dq and now - dq[0] >= 3600:
            dq.popleft()
        if len(dq) >= APPLY_PER_IP_HOUR:
            return False
        dq.append(now)
        while len(_ip_hits) > 20000:
            _ip_hits.popitem(last=False)
        return True


_GMAIL = ("gmail.com", "googlemail.com")


def normalize_address(addr: str) -> str:
    """One inbox, one key: lower case, the +tag dropped, and for Gmail the
    dots (which Gmail ignores) dropped and googlemail.com read as gmail.com."""
    addr = (addr or "").strip().lower()
    if "@" not in addr:
        return addr
    local, domain = addr.rsplit("@", 1)
    local = local.split("+", 1)[0]
    if domain in _GMAIL:
        local, domain = local.replace(".", ""), "gmail.com"
    return f"{local}@{domain}"


def _mail_allowed(addr: str, now: Optional[float] = None) -> bool:
    """The confirmation-email budget (in-process, per worker): per normalized
    address a day, per domain an hour, in all an hour. A send is counted only
    when every bucket has room."""
    now = now or time.time()
    norm = normalize_address(addr)
    buckets = (("a:" + norm, 86400, EMAILS_PER_ADDRESS_DAY),
               ("d:" + norm.rsplit("@", 1)[-1], 3600, EMAILS_PER_DOMAIN_HOUR),
               ("all", 3600, EMAILS_PER_HOUR))
    with _lock:
        dqs = []
        for key, window, limit in buckets:
            dq = _mail_hits.get(key)
            if dq is None:
                dq = _mail_hits[key] = collections.deque()
            _mail_hits.move_to_end(key)
            while dq and now - dq[0] >= window:
                dq.popleft()
            if len(dq) >= limit:
                return False
            dqs.append(dq)
        for dq in dqs:
            dq.append(now)
        while len(_mail_hits) > 20000:
            _mail_hits.popitem(last=False)
        return True


def _text(v, limit: int) -> str:
    return _CTRL.sub(" ", str(v or "")).strip()[:limit]


# ── resume check: the bytes decide, not the name ─────────────────────────────

_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
RESUME_TYPES = {"pdf": "application/pdf", "doc": "application/msword",
                "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def resume_kind(name: str, data: bytes) -> str:
    """'pdf' | 'doc' | 'docx' when the file really is one (and its name says
    the same), else ''."""
    ext = (name or "").rsplit(".", 1)[-1].lower() if "." in (name or "") else ""
    if ext not in RESUME_TYPES or not data:
        return ""
    if ext == "pdf":
        return "pdf" if b"%PDF-" in data[:1024] else ""
    if ext == "doc":
        return "doc" if data[:8] == _OLE else ""
    if data[:4] != b"PK\x03\x04":
        return ""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:      # names only - nothing is extracted
            names = set(z.namelist())
    except (zipfile.BadZipFile, ValueError, OSError):
        return ""
    return "docx" if "[Content_Types].xml" in names and "word/document.xml" in names else ""


# ── reads ────────────────────────────────────────────────────────────────────

def _company(db: Session, slug: str):
    ent = ho.slug_map(db).get((slug or "").strip().lower())
    if ent is None:
        raise HTTPException(404, "We couldn't find that careers page.")
    return ent


def _listed(db: Session, ent: models.HrEntity) -> list:
    rows = db.query(models.HrJobOpening).filter(models.HrJobOpening.company == ent.id,
                                                models.HrJobOpening.status == "open").all()
    rows = [o for o in rows if ho.is_listed(o)]
    rows.sort(key=lambda o: (o.opened_at or o.created_at or ""), reverse=True)
    return rows


def _opening(db: Session, ent: models.HrEntity, opening_id: str) -> models.HrJobOpening:
    op = db.query(models.HrJobOpening).filter(models.HrJobOpening.id == (opening_id or "").strip()).first()
    if op is None or op.company != ent.id or not ho.is_listed(op):
        raise HTTPException(404, "This job is no longer taking applications.")
    return op


@router.get("/public/{slug}")
def public_company(slug: str, db: Session = Depends(get_db)):
    """404 unless the company has a listed opening: the page is not a way to
    find out which companies exist (release review, Oct 27 2026)."""
    ent = _company(db, slug)
    rows = _listed(db, ent)
    if not rows:
        raise HTTPException(404, "We couldn't find that careers page.")
    slug = ho.slug_for(db, ent.id)
    return {"company": ho.public_company(db, ent, slug), "openings": [ho.public_opening(o) for o in rows]}


@router.get("/public/{slug}/{opening_id}")
def public_opening(slug: str, opening_id: str, db: Session = Depends(get_db)):
    ent = _company(db, slug)
    op = _opening(db, ent, opening_id)
    return {"company": ho.public_company(db, ent, ho.slug_for(db, ent.id)),
            "opening": ho.public_opening(op, full=True), "jsonLd": ho.job_posting(db, op, ent),
            "consent": consent_text(ent)}


def consent_text(ent: models.HrEntity) -> str:
    return (f"I agree that {ent.name or 'the company'} may keep the information and resume I send and use them "
            f"to consider me for this job and others like it.")


def _head(title: str, description: str, canonical: str, image: str = "") -> str:
    tags = [f'<meta name="description" content="{escape(description, quote=True)}">',
            f'<link rel="canonical" href="{escape(canonical, quote=True)}">',
            f'<meta property="og:title" content="{escape(title, quote=True)}">',
            f'<meta property="og:description" content="{escape(description, quote=True)}">',
            f'<meta property="og:url" content="{escape(canonical, quote=True)}">',
            '<meta property="og:type" content="website">']
    if image:
        tags.append(f'<meta property="og:image" content="{escape(image, quote=True)}">')
    return "".join(tags)


def _snippet(text: str, n: int = 160) -> str:
    flat = re.sub(r"\s+", " ", re.sub(r"^\s*[-*•]\s+", "", text or "", flags=re.M)).strip()
    return flat if len(flat) <= n else flat[: n - 3].rstrip() + "..."


@router.get("/page/{slug}")
def page_company(slug: str, db: Session = Depends(get_db)):
    """The careers list as server-made HTML, for crawlers (see the docstring)."""
    from app_url import app_url
    ent = _company(db, slug)
    rows = _listed(db, ent)
    if not rows:                     # as /public/{slug}: nothing listed, no page
        raise HTTPException(404, "We couldn't find that careers page.")
    slug = ho.slug_for(db, ent.id)
    base = f"{app_url()}/careers/{slug}"
    title = f"Careers at {ent.name}"
    items = "".join(f'<li><a href="/careers/{escape(slug)}/{escape(o.id)}">{escape(o.title or "")}</a>'
                    f' - {escape(ho.location_line(o))}</li>' for o in rows)
    body = (f"<main><h1>{escape(title)}</h1>"
            + (f"<ul>{items}</ul>" if items else "<p>There are no open positions right now.</p>") + "</main>")
    desc = f"Open positions at {ent.name}." if rows else f"Careers at {ent.name}."
    return {"title": title, "headHtml": _head(title, desc, base, ent.logo_url or ""), "bodyHtml": body}


@router.get("/page/{slug}/{opening_id}")
def page_opening(slug: str, opening_id: str, db: Session = Depends(get_db)):
    """One opening as server-made HTML with its JobPosting JSON-LD."""
    ent = _company(db, slug)
    op = _opening(db, ent, opening_id)
    url = ho.careers_url(db, ent.id, op.id)
    title = f"{op.title} - {ent.name}"
    facts = " | ".join(x for x in (ent.name, ho.location_line(op), ho.EMPLOYMENT_LABELS.get(op.employment_type or "", "")) if x)
    pay = f"<p>Pay: {escape(ho.pay_text(op))}</p>" if op.show_pay and ho.pay_text(op) else ""
    body = (f"<main><h1>{escape(op.title or '')}</h1><p>{escape(facts)}</p>{ho.description_html(op.description)}"
            f'{pay}<p><a href="{escape(url, quote=True)}#apply">Apply</a></p></main>')
    head = _head(title, _snippet(op.description) or title, url, ent.logo_url or "") + ho.ld_script(ho.job_posting(db, op, ent))
    return {"title": title, "headHtml": head, "bodyHtml": body}


@router.get("/sitemap.xml")
def sitemap(db: Session = Depends(get_db)):
    """Every company page with something open, and every listed opening."""
    from app_url import app_url
    base = app_url()
    urls = []
    for slug, ent in sorted(ho.slug_map(db).items()):
        rows = _listed(db, ent)
        if not rows:
            continue
        newest = max((o.updated_at or o.opened_at or "")[:10] for o in rows)
        urls.append((f"{base}/careers/{slug}", newest))
        urls += [(f"{base}/careers/{slug}/{o.id}", (o.updated_at or o.opened_at or "")[:10]) for o in rows]
    body = "".join(f"<url><loc>{escape(u)}</loc>" + (f"<lastmod>{escape(d)}</lastmod>" if d else "") + "</url>"
                   for u, d in urls)
    xml = ('<?xml version="1.0" encoding="UTF-8"?>'
           f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>')
    return Response(content=xml, media_type="application/xml", headers={"Cache-Control": "public, max-age=900"})


# ── apply ────────────────────────────────────────────────────────────────────

def _confirmation(ent: models.HrEntity, op: models.HrJobOpening) -> tuple:
    """(subject, html): the applicant's receipt, in the HR email style with
    the company's logo. Nothing in it the applicant did not already know - and
    not the name typed into the form, so the mail cannot carry somebody
    else's words to the address (release review, Oct 27 2026)."""
    import hr_life_email as he
    accent = "#15803d"
    company = ent.legal_name or ent.name or "the company"
    logo = (ent.logo_url or "").strip()
    brand = (f'<img src="{escape(logo, quote=True)}" alt="{escape(ent.name or "")}" height="30" '
             f'style="display:block;border:0;height:30px">' if logo else
             f'<span style="font-family:{he.FONT};font-size:17px;font-weight:800;color:{he.INK}">{escape(ent.name or "")}</span>')
    top = he._band(brand, pad="22px 40px", extra=f"border-bottom:4px solid {accent}")
    body = "".join([
        he._heading("Thank you for applying", accent),
        he._p(f"We received your application for <b>{escape(op.title or 'the role')}</b> at {escape(company)}."),
        he._p("Our team reads every application. If your background is a match, someone from "
              f"{escape(ent.name or 'our team')} will contact you about next steps."),
        he._p('<span style="font-size:13px;color:#6b7280">You are receiving this because this address was used to '
              'apply on our careers page. If that was not you, you can ignore this email.</span>'),
    ])
    html = (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
            f'<body style="margin:0;padding:0;background:#ffffff;font-family:{he.FONT}">'
            f'{he._preheader("We received your application")}{top}{he._band(body, pad="40px 40px 36px")}</body></html>')
    return f"{ent.name} - we received your application for {op.title}", html


def _send_confirmation(to: str, subject: str, html: str) -> None:
    import role_change
    role_change.send_emails([(to, subject, html)])


@router.post("/apply/{opening_id}")
def apply(opening_id: str, request: Request, background: BackgroundTasks,
          first_name: str = Form(""), last_name: str = Form(""), email: str = Form(""), phone: str = Form(""),
          location: str = Form(""), linkedin_url: str = Form(""), consent: str = Form(""),
          nx_f2: str = Form(""), website: str = Form(""), resume: Optional[UploadFile] = File(None),
          db: Session = Depends(get_db)):
    """A plain `def`: FastAPI runs it in its threadpool, so the queries and the
    storage upload never sit on the event loop."""
    from client_ip import client_ip, rate_key
    if (nx_f2 or "").strip() or (website or "").strip():
        # The honeypot - a field people never see (`website` is its old name,
        # still sent by a page loaded before the rename). A bot filled it in:
        # look like a success, keep nothing, leave a line and a count.
        with _lock:
            _honeypot["dropped"] += 1
            n = _honeypot["dropped"]
        print(f"[careers] honeypot application dropped (opening {_text(opening_id, 60)}; {n} since start)")
        return _OK
    if not _ip_allowed(rate_key(client_ip(request) or "?") or "?"):
        raise HTTPException(429, "Too many applications from this connection - please try again later.")
    op = db.query(models.HrJobOpening).filter(models.HrJobOpening.id == (opening_id or "").strip()).first()
    if op is None or not ho.is_listed(op):
        raise HTTPException(404, "This job is no longer taking applications.")
    ent = db.query(models.HrEntity).filter(models.HrEntity.id == op.company).first()
    if ent is None:
        raise HTTPException(404, "This job is no longer taking applications.")

    first, last = _text(first_name, 80), _text(last_name, 80)
    addr = _text(email, 200).lower()
    tel = _text(phone, 40)
    where = _text(location, 120)
    link = _text(linkedin_url, 300)
    problems = [label for ok, label in ((first, "First name"), (last, "Last name"), (addr, "Email"),
                                        (tel, "Phone"), (where, "Location")) if not ok]
    if problems:
        raise HTTPException(400, f"Please fill in: {', '.join(problems)}.")
    if not _EMAIL_RE.match(addr):
        raise HTTPException(400, "That email address doesn't look right.")
    if not 7 <= len(re.sub(r"\D", "", tel)) <= 15 or re.search(r"[^\d\s()+.\-]", tel):
        raise HTTPException(400, "That phone number doesn't look right.")
    if link and not _LINKEDIN_RE.match(link):
        raise HTTPException(400, "The LinkedIn link should be a linkedin.com address.")
    if (consent or "").strip().lower() not in ("true", "1", "on", "yes"):
        raise HTTPException(400, "Please agree to us keeping your application.")
    if resume is None:
        raise HTTPException(400, "Please attach your resume.")
    data = resume.file.read(MAX_RESUME_BYTES + 1)
    if len(data) > MAX_RESUME_BYTES:
        raise HTTPException(400, f"Your resume is over {MAX_RESUME_BYTES // (1024 * 1024)} MB.")
    kind = resume_kind(resume.filename or "", data)
    if not kind:
        raise HTTPException(400, "Your resume needs to be a PDF or Word file (.pdf, .doc, .docx).")

    now_dt = datetime.now(timezone.utc)
    now, day_ago = now_dt.isoformat(), (now_dt - timedelta(days=1)).isoformat()
    # The opening's daily cap first, for everyone: checked after the lookup
    # below, a full opening would answer an earlier applicant differently.
    if (db.query(models.HrCandidate)
            .filter(models.HrCandidate.opening_id == op.id, models.HrCandidate.source == ho.CAREERS_SOURCE,
                    models.HrCandidate.created_at >= day_ago).count()) >= APPLY_PER_OPENING_DAY:
        raise HTTPException(429, "This job has had a lot of applications today - please try again tomorrow.")
    cand = (db.query(models.HrCandidate)
            .filter(models.HrCandidate.opening_id == op.id, func.lower(models.HrCandidate.email) == addr)
            .order_by(models.HrCandidate.created_at).with_for_update().first())
    recent = (db.query(models.HrCandidate)
              .filter(func.lower(models.HrCandidate.email) == addr, models.HrCandidate.applied_at >= day_ago).count())
    first_today = cand is None or not (cand.applied_at or "") or cand.applied_at < day_ago
    mail_ok = first_today and recent < EMAILS_PER_ADDRESS_DAY

    import hiring_screening
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", resume.filename or f"resume.{kind}")[-80:]
    if cand is not None:
        _apply_again(db, cand, safe, data, RESUME_TYPES[kind], now)
        try:
            sp = db.begin_nested()
            ho.notify_new_applicant(db, op)
            sp.commit()
        except Exception as e:   # noqa: BLE001
            sp.rollback()
            print(f"[careers] applicant bell skipped for {op.id}: {type(e).__name__}")
        db.commit()
        if mail_ok and _mail_allowed(addr):
            subject, html = _confirmation(ent, op)
            background.add_task(_send_confirmation, addr, subject, html)
        return _OK

    from routers import esign
    from routers.hr import _DOC_BUCKET
    cand = models.HrCandidate(
        id=str(uuid.uuid4()), first_name=first, last_name=last, email=addr, phone=tel,
        role_id=op.role_id or "", role_title=op.title or "", department=op.department or "",
        stage="applied", source=ho.CAREERS_SOURCE, company=op.company, opening_id=op.id,
        notes="", created_by="", created_at=now, updated_at=now)
    db.add(cand)
    db.add(models.HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage="", to_stage="applied",
                               note=f"Applied on the careers page for {op.title}", by_email="candidate",
                               created_at=now))
    cand.location, cand.linkedin_url = where, link
    cand.consent_at, cand.applied_at, cand.updated_at = now, now, now

    path = f"candidates/{cand.id}/{uuid.uuid4()}-{safe}"
    up = esign._storage_put(_DOC_BUCKET, path, data, RESUME_TYPES[kind])
    if not up.is_success:
        db.rollback()
        raise HTTPException(503, "We couldn't save your resume just now - please try again in a minute.")

    task = None
    try:
        sp = db.begin_nested()
        # Screening as for every candidate - the task only; the owner gets one
        # grouped bell. Started before resume_url is set, so start() does not
        # fetch the file back from storage: it is attached from memory below.
        task = hiring_screening.start(db, cand, "", bells=False)
        db.flush()            # autoflush is off: attach_resume looks the task up
        if (cand.screen_task_id or "").strip():
            hiring_screening.attach_resume(db, cand, safe, data, RESUME_TYPES[kind], "")
        sp.commit()
    except Exception as e:   # noqa: BLE001 - the application is kept either way
        sp.rollback()
        print(f"[careers] screening not started for {cand.id}: {type(e).__name__}")
    cand.resume_url = path
    db.flush()
    try:
        sp = db.begin_nested()
        ho.notify_new_applicant(db, op)
        sp.commit()
    except Exception as e:   # noqa: BLE001
        sp.rollback()
        print(f"[careers] applicant bell skipped for {op.id}: {type(e).__name__}")
    db.commit()
    if mail_ok and _mail_allowed(addr):
        subject, html = _confirmation(ent, op)
        background.add_task(_send_confirmation, addr, subject, html)
    if task is not None:
        from task_notify import notify_task_event
        background.add_task(notify_task_event, task.id, "assigned", "")
    return _OK


def _apply_again(db: Session, cand: models.HrCandidate, name: str, data: bytes, ctype: str, now: str) -> None:
    """The same email applying again to the same opening. Nothing on the
    candidate changes - no name, phone, email, location, link or resume_url,
    and the screening task's resume stays (anybody can type an address into a
    form with no login). Still at Applied from the careers page: the new
    resume goes on the screening task as an ADDITIONAL document. Always: a
    timeline note "Applied again on MM/DD/YYYY". The caller commits."""
    import hiring_screening
    from task_due import us_date
    note = f"Applied again on {us_date(now[:10])}"
    if cand.source == ho.CAREERS_SOURCE and (cand.stage or "") == "applied" and (cand.screen_task_id or "").strip():
        try:
            sp = db.begin_nested()
            if hiring_screening.attach_resume(db, cand, name, data, ctype, "", replace=False):
                note += " - the resume sent with it is on the screening task as an additional document"
            sp.commit()
        except Exception as e:   # noqa: BLE001 - the note is kept either way
            sp.rollback()
            print(f"[careers] additional resume not attached for {cand.id}: {type(e).__name__}")
    db.add(models.HrStageEvent(id=str(uuid.uuid4()), candidate_id=cand.id, from_stage=cand.stage or "",
                               to_stage=cand.stage or "", note=note, by_email="candidate", created_at=now,
                               kind="note"))
    cand.updated_at = now
