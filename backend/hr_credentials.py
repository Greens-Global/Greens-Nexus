"""Licenses & Certifications (Neil, 11/11/2026 - Deputy parity, "training
records"). The one calculation for what a person holds and whether it is
good on a day.

A credential TYPE (HrCredentialType: Driver's License, Forklift
Certification, OSHA 10...) is set up once under Settings > People & Access;
a person's RECORD (HrCredential) is added on their Documents tab, with the
proof as an ordinary HrDocument in the private hr-docs bucket. A shift type
may require types (Shift.required_credentials); the planner then warns -
never blocks - when the person placed has no valid record on the shift's day
(shift_warnings, read by the grid, the Add / Edit Shift dialog and the Share
review). The daily reminder scan bells the person, their manager and HR
ahead of an expiry (reminders.py, `credentialExpiry` in hr_reminder_config),
and the Records Audit lists an expired one (hr_record_audit.gaps).

Rules:
  - Only the last four characters of a license number are ever stored.
  - Nothing is hard-deleted: a removed record keeps its row (`removed_at`),
    a type is archived.
  - The state words are `state()`'s: Valid, Expiring Soon (EXPIRING_DAYS),
    Expired, No Expiry - the screen, the bell and the audit read the same.
"""
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func

EXPIRING_DAYS = 30
MAX_NAME = 80
MAX_TEXT = 200
MAX_TYPES = 200
MAX_VALIDITY_MONTHS = 240

STATES = ("valid", "expiring", "expired", "no_expiry")
STATE_LABEL = {"valid": "Valid", "expiring": "Expiring Soon", "expired": "Expired", "no_expiry": "No Expiry"}
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class CredentialError(ValueError):
    """A record or type that fails validation. The message is shown as is."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today() -> date:
    return datetime.now(timezone.utc).date()


def us_date(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def clean_date(raw, label: str) -> str:
    v = (raw or "").strip()[:10]
    if not v:
        return ""
    if not _ISO.match(v):
        raise CredentialError(f"{label} must be a date.")
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise CredentialError(f"{label} must be a date.") from None
    return v


def last4(raw) -> str:
    """The last four letters or digits of a license number - all we keep."""
    chars = re.sub(r"[^A-Za-z0-9]", "", str(raw or ""))
    return chars[-4:].upper()


def add_months(iso: str, months: int) -> str:
    """`iso` plus whole calendar months, the day clamped to the month's end."""
    d = datetime.strptime(iso[:10], "%Y-%m-%d").date()
    m = d.month - 1 + int(months)
    y, m = d.year + m // 12, m % 12 + 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(y, m, min(d.day, day)).isoformat()
        except ValueError:
            continue
    return date(y, m, 28).isoformat()


def state(expires_on: str, on: date = None) -> str:
    """Valid / Expiring Soon / Expired / No Expiry on `on` (default today)."""
    exp = (expires_on or "")[:10]
    if not exp:
        return "no_expiry"
    on = on or today()
    try:
        d = datetime.strptime(exp, "%Y-%m-%d").date()
    except ValueError:
        return "no_expiry"
    if d < on:
        return "expired"
    if (d - on).days <= EXPIRING_DAYS:
        return "expiring"
    return "valid"


def good_on(cred, day: str) -> bool:
    """Whether a record covers `day` (YYYY-MM-DD): not removed, issued on or
    before it (when a date is known), and not expired before it."""
    if getattr(cred, "removed_at", ""):
        return False
    issued = (getattr(cred, "issued_on", "") or "")[:10]
    exp = (getattr(cred, "expires_on", "") or "")[:10]
    return (not issued or issued <= day) and (not exp or exp >= day)


# ── Types ────────────────────────────────────────────────────────────────

def serialize_type(t, in_use: int = 0) -> dict:
    return {"id": t.id, "name": t.name or "", "description": t.description or "",
            "companyId": t.company_id or "", "expires": bool(t.expires),
            "validityMonths": int(t.validity_months or 0), "archived": bool(t.archived),
            "inUse": int(in_use or 0), "updatedBy": t.updated_by or "", "updatedAt": t.updated_at or ""}


def clean_type_fields(name=None, description=None, expires=None, validity_months=None) -> dict:
    out = {}
    if name is not None:
        n = (name or "").strip()[:MAX_NAME]
        if not n:
            raise CredentialError("Give the license or certification a name.")
        out["name"] = n
    if description is not None:
        out["description"] = (description or "").strip()[:MAX_TEXT]
    if expires is not None:
        out["expires"] = 1 if expires else 0
    if validity_months is not None:
        try:
            v = int(validity_months or 0)
        except (TypeError, ValueError):
            raise CredentialError("Valid for is a whole number of months.") from None
        if not 0 <= v <= MAX_VALIDITY_MONTHS:
            raise CredentialError(f"Valid for is 0 to {MAX_VALIDITY_MONTHS} months.")
        out["validity_months"] = v
    return out


def types_by_id(db, ids=None) -> dict:
    from models import HrCredentialType
    q = db.query(HrCredentialType)
    if ids is not None:
        ids = [i for i in ids if i]
        if not ids:
            return {}
        q = q.filter(HrCredentialType.id.in_(ids))
    return {t.id: t for t in q.all()}


def type_in_company(t, company_id: str) -> bool:
    return not (t.company_id or "") or (t.company_id == (company_id or ""))


# ── Records ──────────────────────────────────────────────────────────────

def serialize(c, t=None, doc=None, on: date = None) -> dict:
    st = state(c.expires_on, on)
    return {"id": c.id, "employeeId": c.employee_id, "typeId": c.type_id or "",
            "name": (t.name if t is not None and t.name else c.name) or "",
            "issuer": c.issuer or "", "numberLast4": c.number_last4 or "",
            "issuedOn": c.issued_on or "", "expiresOn": c.expires_on or "",
            "state": st, "stateLabel": STATE_LABEL[st],
            "documentId": c.document_id or "",
            "documentName": (doc.file_name if doc is not None else "") or "",
            "note": c.note or "", "verifiedBy": c.verified_by or "", "verifiedAt": c.verified_at or "",
            "createdBy": c.created_by or "", "createdAt": c.created_at or "",
            "updatedBy": c.updated_by or "", "updatedAt": c.updated_at or ""}


def live_for(db, employee_ids) -> dict:
    """{employee id: [HrCredential]} - records not removed, newest expiry first."""
    from models import HrCredential
    ids = [i for i in (employee_ids or []) if i]
    if not ids:
        return {}
    out = {}
    rows = (db.query(HrCredential)
            .filter(HrCredential.employee_id.in_(ids), HrCredential.removed_at == "").all())
    for c in rows:
        out.setdefault(c.employee_id, []).append(c)
    for lst in out.values():
        lst.sort(key=lambda c: ((c.name or "").lower(), c.expires_on or "9999"), reverse=False)
    return out


def required_ids(shift_type) -> list:
    """A shift type's required credential type ids; [] = none."""
    try:
        v = json.loads(getattr(shift_type, "required_credentials", "") or "[]")
    except (TypeError, ValueError):
        return []
    return [str(x) for x in v if str(x).strip()] if isinstance(v, list) else []


def clean_required(db, ids, keep=()) -> str:
    """The stored form of a picked list: known, live type ids, in order. An
    archived type already on the list (`keep`) may stay; it cannot be added."""
    known = {t.id: t for t in types_by_id(db).values()}
    out = []
    for tid in ids or []:
        tid = str(tid or "").strip()
        if not tid or tid in out:
            continue
        t = known.get(tid)
        if t is None:
            raise CredentialError("That license or certification type does not exist.")
        if t.archived and tid not in set(keep or ()):
            raise CredentialError(f"{t.name} is archived - restore it first.")
        out.append(tid)
    return json.dumps(out) if out else ""


def _sentence(type_name: str, held: list, day: str) -> str:
    """Why `held` (this person's records of one type) does not cover `day`,
    or '' when one does."""
    if any(good_on(c, day) for c in held):
        return ""
    if not held:
        return f"Needs {type_name} - none on file."
    issued_later = [c for c in held if (c.issued_on or "")[:10] > day and (not c.expires_on or c.expires_on >= day)]
    if issued_later:
        first = min(c.issued_on for c in issued_later)
        return f"Needs {type_name} - theirs starts {us_date(first)}."
    last = max((c.expires_on or "") for c in held)
    today_iso = today().isoformat()
    if last >= today_iso:
        return f"{type_name} expires {us_date(last)}, before this shift."
    return f"{type_name} expired {us_date(last)}."


def shift_warnings(db, shifts: list, presets: dict = None) -> dict:
    """{shift id: [sentences]} for shifts whose type needs a license or
    certification the person placed does not hold on that day. `shifts` are
    _sched_dict-shaped ({id, email, date, shiftId}); open shifts (no email)
    and shift types with nothing required are skipped. Three reads at most,
    however many shifts."""
    from models import NexusEmployee, Shift
    if presets is None:
        ids = {s.get("shiftId") for s in shifts or [] if s.get("shiftId")}
        presets = {p.id: p for p in db.query(Shift).filter(Shift.id.in_(list(ids))).all()} if ids else {}
    need = {}
    for s in shifts or []:
        if not (s.get("email") and s.get("shiftId") and s.get("date")):
            continue
        req = required_ids(presets.get(s["shiftId"]))
        if req:
            need[s["id"]] = (s["email"].lower(), s["date"][:10], req)
    if not need:
        return {}
    emails = sorted({em for em, _, _ in need.values()})
    people = {(e.work_email or "").lower(): e.id for e in
              db.query(NexusEmployee.id, NexusEmployee.work_email)
              .filter(func.lower(NexusEmployee.work_email).in_(emails)).all()}
    held = live_for(db, list(people.values()))
    types = types_by_id(db, sorted({t for _, _, req in need.values() for t in req}))
    out = {}
    for sid, (em, day, req) in need.items():
        mine = held.get(people.get(em, ""), [])
        for tid in req:
            t = types.get(tid)
            if t is None:
                continue
            text = _sentence(t.name or "A license", [c for c in mine if c.type_id == tid], day)
            if text:
                out.setdefault(sid, []).append(text)
    return out


def expired_gaps(db, employee_ids) -> dict:
    """{employee id: [sentences]} for the Records Audit: each type whose
    newest record has expired."""
    out = {}
    td = today().isoformat()
    for eid, lst in live_for(db, employee_ids).items():
        by_type = {}
        for c in lst:
            by_type.setdefault(c.type_id or c.name, []).append(c)
        for recs in by_type.values():
            if any(not c.expires_on or c.expires_on >= td for c in recs):
                continue
            last = max(recs, key=lambda c: c.expires_on or "")
            out.setdefault(eid, []).append(f"{last.name or 'License'} expired {us_date(last.expires_on)}")
    return out


def new_id() -> str:
    return str(uuid.uuid4())


def default_expiry(t, issued_on: str) -> str:
    """A new record's expiry from its type's length, when it has one."""
    if t is None or not t.expires or not int(t.validity_months or 0) or not issued_on:
        return ""
    return add_months(issued_on, int(t.validity_months))


def days_until(iso: str):
    try:
        return (datetime.strptime((iso or "")[:10], "%Y-%m-%d").date() - today()).days
    except ValueError:
        return None


def window(days: int):
    """(today, today + days) as ISO strings."""
    t = today()
    return t.isoformat(), (t + timedelta(days=days)).isoformat()
