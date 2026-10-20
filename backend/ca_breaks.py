"""California meal and rest premiums (Neil, Oct 17 2026).

Scope: ONLY hourly employees whose overtime rule is 'ca' (is_ca). Everyone
else sees no change anywhere - no prompt, no flag, no line, no key.

1. Silent meal detection. No clock-out prompt and no daily attestation
   (Neil: "The daily clock out attestation is ... bullshit and we don't want
   that"). The timecard engine (timeclock._compute_timecard) calls
   detect_day() per worked day from the break punches it already pairs:
     - work over 5 h needs a meal break of 30+ minutes that starts no later
       than the end of the 5th hour of work;
     - work over 10 h needs a second 30+ minute meal that starts no later
       than the end of the 10th hour;
     - a signed waiver (CaMealWaiver) relaxes it: no first meal needed when
       the day's work is 6 h or less; no second meal needed when the work is
       12 h or less AND the first meal was taken.
   A "break" is any unpaid gap between two stretches of work on the day: a
   Start Break / End Break pair, or clocking out and back in. Status per
   meal: missed (no break of 20+ minutes), short (the break was 20-29
   minutes), late (a 30+ minute break, but it started after the deadline).
   The result rides on the day as day["meal"] ONLY when a meal is not ok, so
   a compliant day is byte-identical to before. Detection never adds pay.
   Days the engine cannot judge are skipped: a missing punch, an auto-closed
   shift, or an auto-lunch deduction (no break punch to place).

2. The employee's signature on their period time sheet confirms the meal and
   rest break statement printed above it - no separate question (Neil, Oct
   18; timesheet_review.on_progress / claim_breaks). Report a Missed Break
   names the day(s) and break kind, creates the premium lines (source
   'claim') and reopens the time sheet to the manager through the SAME
   reopen() a punch-fix request uses.

3. Premium pay (TimeBreakPremium): one hour at the day's regular rate, at
   most one meal and one rest premium per day, its own pay classes
   ("Meal Premium" / "Rest Premium"), never hours worked, never in the
   overtime split. Priced inside _compute_timecard (premium_lines) so the
   time sheet, exports, finalize snapshot, Retro Pay and Payroll Readiness
   all read the same figure.

4. The meal waiver: a one-time Nexus Sign document (link_kind
   'meal_waiver') HR sends from the person's profile; HR may revoke it.
"""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models

MEAL_MIN = 30           # a meal period is at least 30 minutes
SHORT_FLOOR_MIN = 20    # a 20-29 minute break reads as a short meal; under 20 is a rest break
FIRST_BY_MIN = 300      # work over 5 h: first meal starts by the end of the 5th hour
SECOND_BY_MIN = 600     # work over 10 h: second meal starts by the end of the 10th hour
WAIVE_FIRST_MAX = 360   # waiver: no first meal needed at 6 h or less
WAIVE_SECOND_MAX = 720  # waiver: no second meal needed at 12 h or less (first taken)
KINDS = ("meal", "rest")
KIND_LABEL = {"meal": "Meal Premium", "rest": "Rest Premium"}

ATTEST_QUESTION = ("In this pay period I was provided every meal and rest break "
                   "California law requires.")

# Draft - pending HR/counsel review. The waiver wording below is Neil's draft
# (Oct 17 2026); it has not been reviewed by HR or counsel yet.
WAIVER_TITLE = "California Meal Period Waiver"
WAIVER_FIRST = ("I understand California law entitles me to an unpaid, duty-free meal period of at least "
                "30 minutes when I work more than 5 hours in a workday. On days when my total work time is "
                "no more than 6 hours, I voluntarily waive this meal period. I may revoke this waiver at any "
                "time by telling HR in writing.")
WAIVER_SECOND = ("I understand I am entitled to a second unpaid, duty-free meal period of at least 30 minutes "
                 "when I work more than 10 hours in a workday. On days when my total work time is no more "
                 "than 12 hours and I took my first meal period, I voluntarily waive the second meal period. "
                 "I may revoke this waiver at any time by telling HR in writing.")
WAIVER_LINK_KIND = "meal_waiver"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _tc():
    from routers import timeclock
    return timeclock


# ── Who is in scope ───────────────────────────────────────────────────────

_US = ("", "US", "USA")


def is_ca_rate(rate_row, rule: str | None = None, salaried: bool = False) -> bool:
    """The pay-rate half of the scope (no database): a pay rate on file,
    hourly, paid in USD, OT rule 'ca' (blank reads 'ca', as the engine does -
    PayrollRate.overtime_rule DEFAULTS to 'ca', so the rule alone would pull
    in India hourly staff). No rate row = not classified yet = out of scope.
    `rule` overrides the row's rule (a finalized period's snapshot rule).
    `salaried` also lets a fixed (salaried) rate in - ONLY the signed Time
    Sheet's meal and rest statement asks for it (Charmi, Oct 20); meal
    detection, premiums and California Review stay hourly.
    Callers use in_scope(), which adds the country check."""
    if rate_row is None:
        return False
    if (getattr(rate_row, "pay_type", None) or "hourly") not in (("hourly", "fixed") if salaried else ("hourly",)):
        return False
    if (getattr(rate_row, "currency", None) or "USD").strip().upper() != "USD":
        return False
    r = rule if rule is not None else (getattr(rate_row, "overtime_rule", None) or "ca")
    return (r or "ca") == "ca"


_UNSET = object()


def country_of(db: Session, email: str, emp=_UNSET) -> str:
    """Where the person works: their own People country, else their
    company's (shift_rules.overtime_rule_for's order). '' = unknown. `emp`:
    the person's NexusEmployee row when the caller has it (None = no row)."""
    if emp is _UNSET:
        emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == (email or "").lower()).first()
    if emp is None:
        return ""
    own = (getattr(emp, "country", "") or "").strip().upper()
    if own or not (getattr(emp, "company", "") or ""):
        return own
    pre = db.info.get(_PRELOAD) if hasattr(db, "info") else None
    if pre is not None and emp.company in pre.get("entityCountry", {}):
        return pre["entityCountry"][emp.company]
    ent = db.query(models.HrEntity.country).filter(models.HrEntity.id == emp.company).first()
    return ((ent[0] if ent else "") or "").strip().upper()


def in_scope(db: Session, email: str, rate_row=None, rule: str | None = None, emp=_UNSET,
             _load_rate: bool = True, salaried: bool = False) -> bool:
    """THE one rule for who the CA meal / rest features apply to (meal
    detection, the signing question, premium lines, the waiver, California
    Review and its minimum-wage check): is_ca_rate (hourly, USD, rule 'ca')
    AND working in the US - the person's People country, else their
    company's; unknown counts as US only because the pay is USD. The
    overtime engine's own rule is untouched."""
    em = (email or "").strip().lower()
    if rate_row is None and _load_rate and em:
        rate_row = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == em).first()
    if not is_ca_rate(rate_row, rule, salaried):
        return False
    return country_of(db, em, emp) in _US


def is_ca(db: Session, email: str) -> bool:
    em = (email or "").strip().lower()
    return bool(em) and in_scope(db, em)


# ── Meal detection (pure) ─────────────────────────────────────────────────

def _t(iso: str):
    try:
        return datetime.strptime((iso or "")[:19], "%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError):
        return None


def day_timeline(segments: list):
    """(work_min, gaps) for one day's engine segments, or None when the day
    cannot be judged. gaps = [{"at": work minutes before it, "min": length}]
    in time order - every unpaid stretch between two stretches of work."""
    work = []   # [(start, end)] stretches of work
    for s in segments or []:
        if s.get("payClass"):
            continue        # sick / vacation blocks are not work time
        flags = s.get("flags") or []
        if not s.get("in") or not s.get("out") or "missing_out" in flags or "auto_clock_out" in flags \
                or "out_without_in" in flags:
            return None
        if int(s.get("deductedMin") or 0) > 0:
            return None     # auto-lunch: no break punch to place on the day
        a, b = _t(s["in"]), _t(s["out"])
        if a is None or b is None or b <= a:
            return None
        cur = a
        for w in sorted(s.get("breaks") or [], key=lambda w: w.get("start") or ""):
            bs = _t(w.get("start"))
            be = _t(w.get("end")) if w.get("end") else b
            if bs is None or be is None:
                return None
            bs, be = max(bs, cur), min(be, b)
            if be <= bs:
                continue
            work.append((cur, bs))
            cur = be
        work.append((cur, b))
    work = [(x, y) for x, y in sorted(work) if y > x]
    if not work:
        return None
    gaps, done = [], 0.0
    for i, (x, y) in enumerate(work):
        done += (y - x).total_seconds() / 60
        if i + 1 < len(work):
            nxt = work[i + 1][0]
            if nxt > y:
                gaps.append({"at": int(round(done)), "min": int(round((nxt - y).total_seconds() / 60))})
    return int(round(done)), gaps


def _meal(gaps: list, by_min: int, skip=None):
    """(status, gap) for one required meal: ok / late / short / missed."""
    cands = [g for g in gaps if g is not skip]
    full = [g for g in cands if g["min"] >= MEAL_MIN]
    on_time = [g for g in full if g["at"] <= by_min]
    if on_time:
        return "ok", on_time[0]
    if full:
        return "late", full[0]
    short = [g for g in cands if SHORT_FLOOR_MIN <= g["min"] < MEAL_MIN]
    if short:
        return "short", None
    return "missed", None


_WORDS = {
    (1, "missed"): "No 30-minute meal break in a day over 5 hours",
    (1, "short"): "Meal break under 30 minutes",
    (1, "late"): "Meal break started after the 5th hour of work",
    (2, "missed"): "No second 30-minute meal break in a day over 10 hours",
    (2, "short"): "Second meal break under 30 minutes",
    (2, "late"): "Second meal break started after the 10th hour of work",
}
_CHIP = {"missed": "Meal Missed", "short": "Meal Short", "late": "Meal Late"}


def evaluate(work_min: int, gaps: list, waiver: bool = False) -> list:
    """[{meal: 1|2, status}] for the meals that are NOT ok ([] = compliant)."""
    out = []
    first_taken = False
    first_gap = None
    if work_min > FIRST_BY_MIN:
        st, first_gap = _meal(gaps, FIRST_BY_MIN)
        first_taken = first_gap is not None
        if st != "ok" and not (waiver and work_min <= WAIVE_FIRST_MAX):
            out.append({"meal": 1, "status": st})
    if work_min > SECOND_BY_MIN:
        if not (waiver and work_min <= WAIVE_SECOND_MAX and first_taken):
            st, _g = _meal(gaps, SECOND_BY_MIN, skip=first_gap)
            if st != "ok":
                out.append({"meal": 2, "status": st})
    return out


def detect_day(segments: list, waiver: bool = False):
    """The day's meal flag {status, issues, label, chip}, or None (compliant,
    or a day that cannot be judged)."""
    tl = day_timeline(segments)
    if tl is None:
        return None
    issues = evaluate(tl[0], tl[1], waiver)
    if not issues:
        return None
    worst = issues[0]["status"]
    chip = _CHIP[worst] if issues[0]["meal"] == 1 else f"Second {_CHIP[worst]}"
    if len(issues) > 1:
        chip = "Meals Missed" if all(i["status"] == "missed" for i in issues) else "Meal Flags"
    return {"status": worst, "issues": issues, "chip": chip,
            "label": "; ".join(_WORDS[(i["meal"], i["status"])] for i in issues),
            "workMin": tl[0], "waiver": bool(waiver)}


# ── The waiver ────────────────────────────────────────────────────────────

# A READ-ONLY roster pass (Payroll Readiness) prices one card per person;
# preload() reads every waiver and premium row for the roster in two queries
# and parks them on the session, so the engine's per-card reads below cost
# nothing. Always paired with clear_preload() in a finally.
_PRELOAD = "ca_breaks_preload"


def preload(db: Session, emails, start: str, end: str) -> None:
    ems = sorted({(e or "").lower() for e in emails if e})
    pre = {"start": start or "0", "end": end or "9", "emails": set(ems), "waivers": {}, "premiums": {},
           "entityCountry": {i: ((c or "").strip().upper()) for i, c in db.query(models.HrEntity.id, models.HrEntity.country).all()}}
    if ems:
        for w in (db.query(models.CaMealWaiver).filter(models.CaMealWaiver.employee_email.in_(ems))
                  .order_by(models.CaMealWaiver.sent_at.desc()).all()):
            pre["waivers"].setdefault(w.employee_email, []).append(w)
        for p in (db.query(models.TimeBreakPremium)
                  .filter(models.TimeBreakPremium.employee_email.in_(ems),
                          models.TimeBreakPremium.local_date >= pre["start"],
                          models.TimeBreakPremium.local_date <= pre["end"])
                  .order_by(models.TimeBreakPremium.local_date, models.TimeBreakPremium.kind,
                            models.TimeBreakPremium.created_at).all()):
            pre["premiums"].setdefault(p.employee_email, []).append(p)
    db.info[_PRELOAD] = pre


def clear_preload(db: Session) -> None:
    db.info.pop(_PRELOAD, None)


def _preloaded(db: Session, email: str):
    pre = db.info.get(_PRELOAD) if hasattr(db, "info") else None
    return pre if pre and email in pre["emails"] else None


def waiver_rows(db: Session, email: str) -> list:
    pre = _preloaded(db, (email or "").lower())
    if pre is not None:
        return list(pre["waivers"].get((email or "").lower(), []))
    return (db.query(models.CaMealWaiver)
            .filter(models.CaMealWaiver.employee_email == (email or "").lower())
            .order_by(models.CaMealWaiver.sent_at.desc()).all())


def _local_day(iso: str, tz_offset_min: int) -> str:
    """A UTC time's date on the employee's calendar (tz_offset_min is minutes
    WEST of UTC, the punch convention: local = UTC - offset)."""
    t = _t(iso)
    if t is None:
        return (iso or "")[:10]
    return (t - timedelta(minutes=tz_offset_min or 0)).strftime("%Y-%m-%d")


def waiver_on(rows: list, day: str, tz_offset_min: int = 0) -> bool:
    """A signed waiver covers `day` (the employee's local date): signed on or
    before it and not revoked by then, both read on their own calendar."""
    for w in rows or []:
        if w.status not in ("signed", "revoked") or not w.signed_at:
            continue
        if _local_day(w.signed_at, tz_offset_min) > day:
            continue
        if w.revoked_at and _local_day(w.revoked_at, tz_offset_min) <= day:
            continue
        return True
    return False


def waiver_state(db: Session, email: str) -> dict:
    rows = waiver_rows(db, email)
    cur = next((w for w in rows if w.status == "signed"), None)
    pending = next((w for w in rows if w.status == "sent"), None)
    last_rev = next((w for w in rows if w.status == "revoked"), None)
    return {"ca": is_ca(db, email),
            "status": "signed" if cur else ("sent" if pending else ("revoked" if last_rev else "none")),
            "signedAt": cur.signed_at if cur else "",
            "sentAt": pending.sent_at if pending else "",
            "revokedAt": (last_rev.revoked_at if (last_rev and not cur) else ""),
            "revokeNote": (last_rev.revoke_note if (last_rev and not cur) else ""),
            "firstMeal": WAIVER_FIRST, "secondMeal": WAIVER_SECOND,
            "history": [{"status": w.status, "sentAt": w.sent_at, "sentBy": w.sent_by, "signedAt": w.signed_at,
                         "revokedAt": w.revoked_at, "revokedBy": w.revoked_by, "revokeNote": w.revoke_note}
                        for w in rows]}


def _waiver_pdf(db: Session, email: str) -> tuple[bytes, int]:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfgen import canvas
    import timesheet_review as tsr
    buf = io.BytesIO()
    W, H = letter
    c = canvas.Canvas(buf, pagesize=letter)
    m = 56
    y = H - m
    c.setFont("Helvetica-Bold", 16)
    c.drawString(m, y, WAIVER_TITLE)
    y -= 20
    c.setFont("Helvetica", 10)
    c.drawString(m, y, f"{tsr.display_name(db, email)}  ({email})")
    y -= 28
    for head, body in (("First meal period", WAIVER_FIRST), ("Second meal period", WAIVER_SECOND)):
        c.setFont("Helvetica-Bold", 11)
        c.drawString(m, y, head)
        y -= 15
        c.setFont("Helvetica", 10)
        for ln in simpleSplit(body, "Helvetica", 10, W - 2 * m):
            c.drawString(m, y, ln)
            y -= 13
        y -= 14
    # Signature row at fixed positions (the fields below match them).
    base = H - 0.66 * H - 0.05 * H
    c.setFont("Helvetica-Bold", 9)
    c.drawString(m, base + 12, "Employee")
    c.line(0.20 * W, base, 0.62 * W, base)
    c.line(0.70 * W, base, 0.88 * W, base)
    c.setFont("Helvetica", 7)
    c.drawString(0.20 * W, base - 9, "Signature")
    c.drawString(0.70 * W, base - 9, "Date")
    c.save()
    return buf.getvalue(), 0


def send_waiver(db: Session, email: str, actor: str, *, ip: str = "", user_agent: str = "") -> models.CaMealWaiver:
    """HR sends the waiver to a CA-rule employee in Nexus Sign."""
    from routers import esign
    import timesheet_review as tsr
    email, actor = (email or "").strip().lower(), (actor or "").strip().lower()
    if not is_ca(db, email):
        raise HTTPException(409, "The meal waiver is only for hourly staff on the California overtime rule.")
    rows = waiver_rows(db, email)
    if any(w.status == "signed" for w in rows):
        raise HTTPException(409, "This person already has a signed meal waiver. Revoke it first to send a new one.")
    if any(w.status == "sent" for w in rows):
        raise HTTPException(409, "A meal waiver is already out for this person's signature.")
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    pdf, last_page = _waiver_pdf(db, email)
    safe = esign._safe_filename(f"Meal Waiver {tsr.display_name(db, email)}")
    path = f"esign/{uuid.uuid4()}/{safe}.pdf"
    up = esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
    if not up.is_success:
        raise HTTPException(502, "The waiver could not be stored for signing. Try again.")
    w = models.CaMealWaiver(id=str(uuid.uuid4()), employee_email=email, status="sent", sent_by=actor, sent_at=_now())
    db.add(w)
    fields = [{"id": "employee_sign", "role": "employee", "type": "sign", "page": last_page,
               "x": 0.20, "y": 0.66, "w": 0.42, "h": 0.05, "required": True},
              {"id": "employee_date", "role": "employee", "type": "date", "page": last_page,
               "x": 0.70, "y": 0.672, "w": 0.18, "h": 0.03, "required": True}]
    parties = [esign.PartyIn(role_key="employee", name=tsr.display_name(db, email), email=email,
                             kind="internal", ordinal=1, party_role="signer")]
    out = esign._create_request(
        db, {"email": actor}, title=f"{WAIVER_TITLE} - {tsr.display_name(db, email)}", source="pdf",
        template_id="", employee_id=(emp.id if emp else ""), candidate_id="",
        entity_id=(emp.company if emp else ""), body_snapshot=[], pdf_storage_path=path,
        fields=esign._clean_fields(fields), message="Please review and sign the California meal period waiver.",
        expires_on="", parties=parties, ip=ip, user_agent=user_agent, routing="sequential",
        excluded_ack=True, document_class="employment")
    req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == out["id"]).first()
    req.link_kind, req.link_id = WAIVER_LINK_KIND, w.id
    w.sign_request_id = req.id
    db.commit()
    return w


def revoke_waiver(db: Session, email: str, actor: str, note: str) -> None:
    email = (email or "").strip().lower()
    note = (note or "").strip()
    if len(note) < 3:
        raise HTTPException(422, "Say why the waiver is revoked (for example, the employee's written request).")
    rows = [w for w in waiver_rows(db, email) if w.status in ("signed", "sent")]
    if not rows:
        raise HTTPException(409, "There is no waiver to revoke.")
    for w in rows:
        if w.status == "sent":
            w.status = "canceled"
            if w.sign_request_id:
                from routers.esign import _log
                req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == w.sign_request_id).first()
                if req and req.status == "pending":
                    req.status = "voided"
                    _log(db, req.id, "voided", f"by {actor}: waiver revoked")
        else:
            w.status = "revoked"
        w.revoked_at, w.revoked_by, w.revoke_note = _now(), (actor or "").lower(), note[:400]
    db.commit()


def _waiver_for(db: Session, req):
    if (getattr(req, "link_kind", "") or "") != WAIVER_LINK_KIND:
        return None
    return db.query(models.CaMealWaiver).filter(models.CaMealWaiver.id == req.link_id).first()


def on_completed(db: Session, req) -> None:
    w = _waiver_for(db, req)
    if w and w.status == "sent":
        w.status, w.signed_at = "signed", _now()


def on_declined(db: Session, req, *_a) -> None:
    w = _waiver_for(db, req)
    if w and w.status == "sent":
        w.status = "canceled"


on_voided = on_declined


def safe(fn, *a, **kw) -> None:
    try:
        fn(*a, **kw)
    except Exception as e:   # pragma: no cover - never break a signature
        print(f"[ca-breaks] {getattr(fn, '__name__', fn)} failed: {type(e).__name__}: {e}")


# ── Premium lines ─────────────────────────────────────────────────────────

def premium_rows(db: Session, email: str, start: str, end: str, *, include_removed: bool = False) -> list:
    em = (email or "").lower()
    pre = _preloaded(db, em)
    if pre is not None and pre["start"] <= (start or "0") and (end or "9") <= pre["end"]:
        return [p for p in pre["premiums"].get(em, []) if (start or "0") <= p.local_date <= (end or "9")
                and (include_removed or p.status == "active")]
    q = db.query(models.TimeBreakPremium).filter(models.TimeBreakPremium.employee_email == (email or "").lower(),
                                                 models.TimeBreakPremium.local_date >= (start or "0"),
                                                 models.TimeBreakPremium.local_date <= (end or "9"))
    if not include_removed:
        q = q.filter(models.TimeBreakPremium.status == "active")
    return q.order_by(models.TimeBreakPremium.local_date, models.TimeBreakPremium.kind,
                      models.TimeBreakPremium.created_at).all()


def premium_dict(p) -> dict:
    return {"id": p.id, "date": p.local_date, "kind": p.kind, "label": KIND_LABEL.get(p.kind, p.kind),
            "status": p.status, "source": p.source, "note": p.note or "", "createdBy": p.created_by or "",
            "createdAt": p.created_at or "", "removedBy": p.removed_by or "", "removedAt": p.removed_at or "",
            "removedReason": p.removed_reason or ""}


def add_premium(db: Session, email: str, day: str, kind: str, actor: str, *, source: str = "manager",
                note: str = "", review_id: str = ""):
    """One active premium per person, day and kind: an existing one is kept
    (returns None)."""
    if kind not in KINDS:
        raise HTTPException(422, "Pick Meal or Rest.")
    email = (email or "").lower()
    existing = (db.query(models.TimeBreakPremium)
                .filter(models.TimeBreakPremium.employee_email == email, models.TimeBreakPremium.local_date == day,
                        models.TimeBreakPremium.kind == kind, models.TimeBreakPremium.status == "active")
                .with_for_update().first())
    # autoflush=False: a row added earlier in this same request is not in the
    # query above yet - look at the session's pending rows too.
    pending = any(isinstance(o, models.TimeBreakPremium) and o.employee_email == email and o.local_date == day
                  and o.kind == kind and o.status == "active" for o in db.new)
    if existing or pending:
        return None
    p = models.TimeBreakPremium(id=str(uuid.uuid4()), employee_email=email, local_date=day, kind=kind,
                                status="active", source=source, review_id=review_id or "",
                                note=(note or "").strip()[:500], created_by=(actor or "").lower(), created_at=_now())
    db.add(p)
    return p


def remove_premium(p, actor: str, reason: str) -> None:
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise HTTPException(422, "Say why this premium is removed.")
    if p.status != "active":
        raise HTTPException(409, "This premium was already removed.")
    p.status, p.removed_by, p.removed_at, p.removed_reason = "removed", (actor or "").lower(), _now(), reason[:500]


def worked_days(days: list) -> list:
    """The dates with WORKED minutes (regular / overtime / double time) - a
    sick or vacation block alone is not a work day, so no premium."""
    return sorted({d["date"] for d in days or []
                   if int(d.get("regMin") or 0) + int(d.get("otMin") or 0) + int(d.get("dtMin") or 0) > 0})


def premium_lines(prem: list, day_dates: set, rate_for_day) -> dict:
    """{date: {"meal": pay, "rest": pay}} from [{date, kind}] - only worked
    days, at most one of each kind per day, 1 h at the day's rate."""
    out = {}
    for p in prem or []:
        d, k = p.get("date"), p.get("kind")
        if d not in day_dates or k not in KINDS:
            continue
        out.setdefault(d, {})
        if k not in out[d]:
            out[d][k] = round(float(rate_for_day(d)), 2)
    return out
