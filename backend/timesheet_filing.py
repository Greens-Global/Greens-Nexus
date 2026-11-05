"""Retry filing a signed Time Sheet into Egnyte (Neil's Time Clock audit, Oct 20 2026).

Nexus Sign files the sealed copy of a signed Time Sheet into the employee's
Egnyte folder once, inside the sealing transaction (esign._egnyte_push via
timesheet_review.egnyte_folder), with short timeouts. A slow or briefly
unavailable Egnyte left it unfiled for good - logged `archive_failed` on the
envelope and nothing else. (Hiring packets already retry - hr_life_events'
filing pass with File Manually as the last resort; Time Sheets had neither.)

This pass, run every minute from hr_life_events.life_events_loop in a worker
thread, retries a timesheet envelope whose filing failed: at most
len(RETRY_AFTER_MIN) more attempts, each a while after the last failure, only
while Egnyte is connected (a missing connection needs a person, not a retry -
it is retried once Egnyte is connected again, within the window). The
envelope's own event log is the bookkeeping - every attempt is an
`archived` / `archive_failed` event - so no new column or table. When the
last attempt fails, the company's HR contact gets one bell
(`ts_filing:<envelope>`) to file it by hand from Nexus Sign; the signed copy
is always safe in Nexus (Documents, the employee's profile, the email).
"""
from datetime import datetime, timedelta, timezone

from database import SessionLocal
from models import HrSignEvent, HrSignRequest
import job_switch

# Minutes after the latest failure before the next attempt; past the end, give up.
RETRY_AFTER_MIN = (5, 30, 120)
# Only envelopes completed this recently are looked at (bounds every pass).
WINDOW_DAYS = 3
PER_PASS = 10
GAVE_UP = "archive_gave_up"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(s: str):
    try:
        t = datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _egnyte_connected() -> bool:
    import os
    import services.egnyte as svc
    return svc.configured() or bool((os.getenv("EGNYTE_DOMAIN") or "").strip()
                                    and (os.getenv("EGNYTE_TOKEN") or "").strip())


def _state(db, req_id: str) -> tuple:
    """(filed, gave_up, failures, last failure time) from the envelope's log."""
    rows = (db.query(HrSignEvent.type, HrSignEvent.at)
            .filter(HrSignEvent.request_id == req_id,
                    HrSignEvent.type.in_(("archived", "archive_failed", GAVE_UP)))
            .order_by(HrSignEvent.seq).all())
    fails = [r.at for r in rows if r.type == "archive_failed"]
    return (any(r.type == "archived" for r in rows), any(r.type == GAVE_UP for r in rows),
            len(fails), _parse(fails[-1]) if fails else None)


def _give_up(db, req: HrSignRequest, why: str) -> None:
    from routers import esign
    import timesheet_review as tsr
    from notify_rollup import upsert_rollup
    esign._log(db, req.id, GAVE_UP, why[:400])
    r = tsr._for(db, req)
    to = tsr.hr_of(db, r.employee_email) if r else ""
    if not to:
        return
    label = f"{tsr.display_name(db, r.employee_email)}'s time sheet for {tsr._label(r)}"
    upsert_rollup(db, recipient=to, key=f"ts_filing:{req.id}", title="Time Sheet Not Filed in Egnyte",
                  line=(f"{label} is signed and safe in Nexus, but it could not be filed in Egnyte "
                        f"({why}). Download it from Nexus Sign and file it by hand."),
                  action={"view": "documents", "sub": "documents-esign-requests", "request": req.id},
                  priority=0)


def retry_one(db, req: HrSignRequest, now: datetime) -> str:
    """One envelope: '' (nothing due), 'filed', 'failed' or 'gave_up'."""
    from routers import esign
    filed, gave_up, fails, last = _state(db, req.id)
    if filed or gave_up or not fails:
        return ""
    if fails > len(RETRY_AFTER_MIN):
        _give_up(db, req, f"{fails} attempts failed")
        return "gave_up"
    if last is not None and now < last + timedelta(minutes=RETRY_AFTER_MIN[fails - 1]):
        return ""
    if not _egnyte_connected():
        return ""      # nothing transient about it - wait for the connection
    blob = esign._storage_fetch(esign._DOC_BUCKET, req.final_pdf_path)
    if not blob.is_success:
        esign._log(db, req.id, "archive_failed", f"Retry {fails}: the sealed copy could not be read from storage")
        return "failed"
    ok, note = esign._egnyte_push(db, req, blob.content)
    if ok and not note and _state(db, req.id)[2] > fails:
        return "failed"   # the folder could not be made (egnyte_folder logged it) - retried later
    if ok and not note:
        # No folder resolved this time either (no person record / company):
        # a person has to decide where it goes.
        _give_up(db, req, "there is no Egnyte folder for this person")
        return "gave_up"
    esign._log(db, req.id, "archived" if ok else "archive_failed", f"Retry {fails}: {note}")
    return "filed" if ok else "failed"


# ── One-time re-file (Charmi, 11/06/2026) ───────────────────────────────────
# Eight signed Time Sheets (10/19 - 11/03) never reached Egnyte: the person
# folder lookup failed ("Egnyte folder not ready") until the 11/04 folder
# matching fix, and their retries ran out first. Once, after the deploy, every
# completed time sheet envelope with no `archived` event - whatever its age -
# is filed again through the same _egnyte_push; each attempt is logged on the
# envelope like any retry. The mark is claimed before the work, so two workers
# never both run it.
REFILE_MARK = "timesheet_filing.refile_2026_11_06"


def refile_once(db) -> dict | None:
    """None when already done (or Egnyte is not connected yet - it waits)."""
    from sqlalchemy.exc import IntegrityError
    from models import NexusSetting
    from routers import esign
    if not _egnyte_connected() or db.get(NexusSetting, REFILE_MARK):
        return None
    stamp = _now().isoformat()
    try:
        db.add(NexusSetting(key=REFILE_MARK, value=stamp, updated_by="startup", updated_at=stamp))
        db.commit()
    except IntegrityError:
        db.rollback()
        return None
    out = {"filed": 0, "failed": 0}
    ids = [r.id for r in db.query(HrSignRequest.id)
           .filter(HrSignRequest.link_kind == "timesheet", HrSignRequest.status == "completed",
                   HrSignRequest.final_pdf_path != "")
           .order_by(HrSignRequest.completed_at).all()]
    for rid in ids:
        try:
            if _state(db, rid)[0]:
                continue                     # already filed
            req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).with_for_update().first()
            if req is None:
                continue
            blob = esign._storage_fetch(esign._DOC_BUCKET, req.final_pdf_path)
            if not blob.is_success:
                esign._log(db, req.id, "archive_failed", "Refile: the sealed copy could not be read from storage")
                out["failed"] += 1
            else:
                ok, note = esign._egnyte_push(db, req, blob.content)
                if ok and note:
                    esign._log(db, req.id, "archived", f"Refile: {note}")
                    out["filed"] += 1
                else:
                    if not ok:
                        esign._log(db, req.id, "archive_failed", f"Refile: {note}")
                    out["failed"] += 1
            db.commit()
        except Exception as e:   # noqa: BLE001 - one envelope must not stop the rest
            db.rollback()
            out["failed"] += 1
            print(f"[timesheet-filing] refile {rid}: {type(e).__name__}: {e}")
    print(f"[timesheet-filing] one-time refile: {out}")
    return out


def process_due(now: datetime = None, db=None) -> dict:
    """The pass. Runs in a worker thread, never on the event loop."""
    if job_switch.off("timesheet_filing"):   # Workflows > Automations switch
        return {"filed": 0, "failed": 0, "gave_up": 0}
    own = db is None
    db = db or SessionLocal()
    now = now or _now()
    out = {"filed": 0, "failed": 0, "gave_up": 0}
    try:
        try:
            refile_once(db)
        except Exception as e:   # noqa: BLE001 - never stops the regular pass
            db.rollback()
            print(f"[timesheet-filing] refile: {type(e).__name__}: {e}")
        since = (now - timedelta(days=WINDOW_DAYS)).isoformat()
        ids = [r.id for r in db.query(HrSignRequest.id)
               .filter(HrSignRequest.link_kind == "timesheet", HrSignRequest.status == "completed",
                       HrSignRequest.final_pdf_path != "", HrSignRequest.completed_at >= since)
               .order_by(HrSignRequest.completed_at).all()]
        done = 0
        for rid in ids:
            if done >= PER_PASS:
                break
            req = db.query(HrSignRequest).filter(HrSignRequest.id == rid).with_for_update().first()
            if req is None:
                continue
            try:
                got = retry_one(db, req, now)
                db.commit()
            except Exception as e:   # noqa: BLE001 - one envelope must not stop the pass
                db.rollback()
                print(f"[timesheet-filing] {rid}: {type(e).__name__}: {e}")
                continue
            if got:
                out[got] += 1
                done += 1
    finally:
        if own:
            db.close()
    return out
