"""Microsoft 365 contact info, kept in step with People both ways (Neil, 10/07).

"We should be able to select office, office phone, have all of these fields
inside Nexus and change it there and it updates [in Microsoft 365]. Change it
in MS, it updates in Nexus. It's a two-way sync." HR keeps people's details in
Nexus; IT should not have to edit them in the M365 admin center.

The fields are the M365 admin center's contact and job info, minus fax:
mobile phone, office phone, office, street address, city, state, ZIP,
country or region, job title and department.

How a change is told apart from a difference - a three-way merge per field.
`NexusEmployee.m365_sync["base"]` holds each field as Microsoft 365 last had
it (the common ancestor):
  - M365 moved off the base and Nexus did not  -> M365's value comes into Nexus
  - Nexus moved off the base (M365 did or not) -> Nexus's value goes to M365;
    when both moved, Nexus wins - HR is the source of truth for people
  - no base yet (first sync) -> an empty Nexus field takes M365's value, a
    filled one is pushed
Writes to Entra follow the same switch as every other one
(hr._entra_writes_enabled - production only); pulling is allowed everywhere.
Nothing here runs on the event loop: the loop hands each pass to a thread.
"""
import asyncio
import json
from datetime import datetime, timezone

import httpx

from countries import country_code, country_name

SYNC_EVERY_SEC = 15 * 60

# (Nexus column, Graph user property)
FIELDS = (
    ("phone", "mobilePhone"),
    ("office_phone", "businessPhones"),
    ("location", "officeLocation"),
    ("street_address", "streetAddress"),
    ("city", "city"),
    ("state", "state"),
    ("postal_code", "postalCode"),
    ("country", "country"),
    ("job_title", "jobTitle"),
    ("department", "department"),
)
CONTACT_COLUMNS = frozenset(f for f, _ in FIELDS)
_SELECT = "id," + ",".join(a for _, a in FIELDS)
LABELS = {"phone": "Mobile phone", "office_phone": "Office phone", "location": "Office",
          "street_address": "Street address", "city": "City", "state": "State or province",
          "postal_code": "ZIP or postal code", "country": "Country or region",
          "job_title": "Job title", "department": "Department"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(v) -> str:
    return " ".join(str(v or "").split())


def remote_value(g: dict, attr: str) -> str:
    """A Graph user's property in Nexus's shape."""
    if attr == "businessPhones":
        phones = g.get("businessPhones") or []
        return _clean(phones[0]) if phones else ""
    if attr == "country":
        raw = _clean(g.get("country"))
        return country_code(raw) or raw   # an unknown name stays as typed
    return _clean(g.get(attr))


def local_value(emp, field: str) -> str:
    """A Nexus field as it would read in Microsoft 365."""
    v = _clean(getattr(emp, field, ""))
    if field == "job_title":
        from routers.hr import _m365_job_title   # levels stay in Nexus, never in Entra
        return _clean(_m365_job_title(v))
    if field == "country":
        return v.upper()
    return v


def graph_value(field: str, value: str):
    """A Nexus value as Graph wants it. Empty clears the property."""
    if field == "office_phone":
        return [value] if value else []
    if field == "country":
        return (country_name(value) or value) if value else None
    return value or None


def _base(emp) -> dict:
    s = emp.m365_sync if isinstance(emp.m365_sync, dict) else {}
    b = s.get("base")
    return dict(b) if isinstance(b, dict) else {}


def _save_state(emp, base: dict, error: str = "") -> None:
    # A new dict, so SQLAlchemy sees the JSON column change.
    emp.m365_sync = {"base": base, "at": _now(), "error": error[:300]}


def merge(emp, g: dict) -> tuple[dict, set]:
    """Apply what changed in Microsoft 365 to `emp`; say what Nexus must push.
    Returns ({field: (old, new)} pulled into Nexus, {fields to push})."""
    base = _base(emp)
    pulled, to_push = {}, set()
    for field, attr in FIELDS:
        r = remote_value(g, attr)
        loc = local_value(emp, field)
        if r == loc:
            base[field] = r
            continue
        b = base.get(field)
        if b is None:   # first sync: fill an empty Nexus field, otherwise Nexus wins
            m365_moved, nexus_moved = (not loc and bool(r)), bool(loc)
        else:
            m365_moved, nexus_moved = r != b, loc != b
        if m365_moved and not nexus_moved:
            if field == "country" and r and len(r) != 2:
                continue   # a country Nexus has no code for - leave Nexus as is
            old = getattr(emp, field, "") or ""
            setattr(emp, field, r)
            pulled[field] = (old, r)
            base[field] = r
        elif nexus_moved:
            to_push.add(field)
    _save_state(emp, base)
    return pulled, to_push


def push(token: str, emp, fields) -> list:
    """PATCH these fields onto the person's Entra account - an emptied field
    clears it there too - and record them as the new base. Raises on failure."""
    fields = [f for f in fields if f in CONTACT_COLUMNS]
    if not fields:
        return []
    payload = {}
    for field, attr in FIELDS:
        if field in fields:
            payload[attr] = graph_value(field, local_value(emp, field))
    r = httpx.patch(f"https://graph.microsoft.com/v1.0/users/{emp.m365_id}",
                    headers={"Authorization": f"Bearer {token}"}, json=payload, timeout=20)
    if not r.is_success:
        raise RuntimeError(f"Graph {r.status_code}: {r.text[:180]}")
    base = _base(emp)
    for f in fields:
        base[f] = local_value(emp, f)
    _save_state(emp, base)
    return [a for f, a in FIELDS if f in fields]


def fetch_user(token: str, m365_id: str) -> dict:
    r = httpx.get(f"https://graph.microsoft.com/v1.0/users/{m365_id}?$select={_SELECT}",
                  headers={"Authorization": f"Bearer {token}"}, timeout=20)
    if not r.is_success:
        raise RuntimeError(f"Graph {r.status_code}: {r.text[:180]}")
    return r.json()


def _fetch_all(token: str) -> dict:
    out, url = {}, f"https://graph.microsoft.com/v1.0/users?$select={_SELECT}&$top=999"
    while url:
        r = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        if not r.is_success:
            raise RuntimeError(f"Graph {r.status_code}: {r.text[:180]}")
        data = r.json()
        for g in data.get("value", []):
            if g.get("id"):
                out[g["id"].lower()] = g
        url = data.get("@odata.nextLink")
    return out


def _audit(db, emp, pulled: dict) -> None:
    from models import AuditLog
    db.add(AuditLog(timestamp=_now(), user_email="microsoft365-sync", user_role="system",
                    action="Updated from Microsoft 365", resource_type="employee", resource_id=emp.id,
                    details=json.dumps({"employee": emp.work_email,
                                        "changes": {k: [str(a)[:120], str(b)[:120]] for k, (a, b) in pulled.items()}})[:4000]))


def sync_one(db, token: str, emp, g: dict, writes: bool) -> dict:
    """Merge one person and push what Nexus owns. Commits nothing."""
    pulled, to_push = merge(emp, g)
    if pulled:
        emp.updated_at = _now()
        _audit(db, emp, pulled)
    pushed, error = [], ""
    if to_push and writes:
        try:
            pushed = push(token, emp, to_push)
        except Exception as e:   # noqa: BLE001 - recorded on the row, the run goes on
            error = str(e)[:300]
            _save_state(emp, _base(emp), error)
    return {"pulled": sorted(pulled), "pushed": pushed, "error": error,
            "waiting": sorted(to_push) if not writes else []}


def sync_person(db, emp) -> dict:
    """One person, now (the People profile's Refresh). Commits."""
    from routers.hr import _entra_writes_enabled, _graph_token
    if not (emp.m365_id or "").strip():
        return {"pulled": [], "pushed": [], "error": "Not linked to a Microsoft 365 account."}
    token = _graph_token()
    out = sync_one(db, token, emp, fetch_user(token, emp.m365_id), _entra_writes_enabled())
    db.commit()
    return out


def sync_all() -> dict:
    """Every linked person. Synchronous - run it off the event loop."""
    from database import SessionLocal
    from models import NexusEmployee
    from routers.hr import _entra_writes_enabled, _graph_token
    db = SessionLocal()
    stats = {"checked": 0, "pulled": 0, "pushed": 0, "failed": 0}
    try:
        emps = [e for e in db.query(NexusEmployee).filter(NexusEmployee.m365_id != "").all()
                if (e.status or "") != "offboarded"]
        if not emps:
            return stats
        token = _graph_token()
        remote = _fetch_all(token)
        writes = _entra_writes_enabled()
        for emp in emps:
            g = remote.get((emp.m365_id or "").lower())
            if not g:
                continue   # account gone - the directory sync owns unlinking
            stats["checked"] += 1
            try:
                r = sync_one(db, token, emp, g, writes)
                stats["pulled"] += bool(r["pulled"])
                stats["pushed"] += bool(r["pushed"])
                stats["failed"] += bool(r["error"])
                db.commit()
            except Exception as e:   # noqa: BLE001 - one person never stops the rest
                db.rollback()
                stats["failed"] += 1
                print(f"[m365-contact] {emp.work_email}: {type(e).__name__}: {str(e)[:200]}")
        stats["photos"] = sync_missing_photos(db, token, emps)
        return stats
    finally:
        db.close()


# Photos (Oct 2026, Contact Directory): a person with no picture on file gets
# their Entra photo pulled in during the regular pass, so faces show up without
# HR pressing Sync Photos. A person Entra has no photo for is remembered here
# for a day rather than asked about every 15 minutes; a new upload in M365
# shows within a day, a Nexus upload shows at once (it sets photo_url itself).
PHOTO_RECHECK_SEC = 24 * 3600
PHOTOS_PER_PASS = 25
_no_photo_until: dict[str, float] = {}


def sync_missing_photos(db, token: str, emps) -> int:
    import time
    from routers.hr import pull_entra_photo
    now = time.monotonic()
    done = 0
    for emp in emps:
        if done >= PHOTOS_PER_PASS:
            break
        if (emp.photo_url or "").strip() or (emp.status or "") == "offboarded":
            continue
        if _no_photo_until.get(emp.id, 0) > now:
            continue
        try:
            result = pull_entra_photo(emp, token)
            if result == "updated":
                db.commit()
                done += 1
            else:
                db.rollback()
                _no_photo_until[emp.id] = now + PHOTO_RECHECK_SEC
        except Exception as e:   # noqa: BLE001
            db.rollback()
            _no_photo_until[emp.id] = now + PHOTO_RECHECK_SEC
            print(f"[m365-contact] photo {emp.work_email}: {type(e).__name__}: {str(e)[:200]}")
    return done


async def m365_contact_sync_loop():
    """Every 15 minutes (deployed worker only, main.py)."""
    while True:
        try:
            s = await asyncio.to_thread(sync_all)
            if s.get("pulled") or s.get("pushed") or s.get("failed"):
                print(f"[m365-contact] {s}")
        except Exception as e:   # noqa: BLE001
            print(f"[m365-contact] pass failed: {type(e).__name__}: {e}")
        await asyncio.sleep(SYNC_EVERY_SEC)
