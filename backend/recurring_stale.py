"""Possibly Ended - the staleness check for MRI and MRE (Neil, Oct 21: "if a
relationship ended or changed and there are no payments for a period, it
should recommend marking it inactive ... and generate a task for accounting").

Once a day, on the deployed worker (recurring_stale_loop, started from
main.py's lifespan), every ACTIVE recurring line is checked against the
ledger:

  - MRI: a lease / CAM / interest / loan payment source (models.Lease) whose
    status is active, whose end date has not passed, and which has a customer
    code - what posted to its income accounts for that customer.
  - MRE: a recurring expense (models.RecurringExpense) that is active and not
    past its end date - what posted to its expense accounts for its vendor.

A line in force for the whole window that had NOTHING post in any month of
the window is flagged Possibly Ended (stale_since, stale_last_paid). The
window is the last N complete months (N = staleMonths, default 3,
configurable in the settings below), never shorter than one cycle of the
line's frequency - a quarterly bill gets three months, an annual one twelve,
so a line that is simply not due yet is never flagged.

A flagged line gets ONE accounting task (models.Task, stale_task_id),
assigned to the entity's accountants from Ask My Accountant's settings (the
entity's own, else the default "every entity" ones; nobody set up = the
person who added the line). It is never opened twice for the same lapse -
completing the task while the line is still quiet does not bring it back. The
task is closed, and the flag cleared, when money posts again or the line is
marked ended / inactive; a later lapse opens a new one.

Only the stale_* columns are written - never a lease, a rent, a receipt, an
amount or a status: the scan only recommends, a person decides. A read the
ledger cannot answer leaves that line as it was.

The settings (`nexus_settings` key acct_recurring_settings, JSON) also hold
MRE's Egnyte root - the folder vendor folders are looked for under.

10/27 (Urmi, "possibly ended settings logic is not working"): saving a new
number of months runs the check right away (PUT /accounting/mre/settings),
not at the next daily pass - flags that no longer qualify clear, new ones
appear, and the screens reload when it is done. MRE reads the ledger with the
grid's grouped read (seconds), and each finished pass is recorded
(acct_recurring_last_check) so the settings say when it last ran.
"""
import asyncio
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import models
from database import SessionLocal
import job_switch

SETTINGS_KEY = "acct_recurring_settings"
LAST_CHECK_KEY = "acct_recurring_last_check"
DEFAULTS = {"staleMonths": 3, "egnyteRoot": ""}
STALE_MIN, STALE_MAX = 1, 24
LOOKBACK = 12            # months read back for "last posted"
_POSTED = 0.5            # dollars: below this a month did not post
CHECK_EVERY_SEC = 24 * 3600
ACTOR = "nexus"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Settings ─────────────────────────────────────────────────────────────────
def get_settings(db) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
    try:
        saved = json.loads(row.value) if row and row.value else {}
    except ValueError:
        saved = {}
    out = {**DEFAULTS, **{k: v for k, v in (saved or {}).items() if k in DEFAULTS}}
    try:
        out["staleMonths"] = max(STALE_MIN, min(STALE_MAX, int(out["staleMonths"])))
    except (TypeError, ValueError):
        out["staleMonths"] = DEFAULTS["staleMonths"]
    out["egnyteRoot"] = str(out.get("egnyteRoot") or "")
    return out


def load_settings() -> dict:
    db = SessionLocal()
    try:
        return get_settings(db)
    finally:
        db.close()


def save_settings(patch: dict, by: str) -> dict:
    db = SessionLocal()
    try:
        cur = get_settings(db)
        cur.update({k: v for k, v in patch.items() if k in DEFAULTS and v is not None})
        row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
        if not row:
            row = models.NexusSetting(key=SETTINGS_KEY)
            db.add(row)
        row.value, row.updated_by, row.updated_at = json.dumps(cur), by, _now()
        db.commit()
        return get_settings(db)
    finally:
        db.close()


# ── The rule (pure) ──────────────────────────────────────────────────────────
def month_add(key: str, n: int) -> str:
    i = int(key[:4]) * 12 + int(key[5:7]) - 1 + n
    return f"{i // 12}-{i % 12 + 1:02d}"


def window(today: date, months: int, step: int = 1) -> list[str]:
    """The last max(months, step) COMPLETE months before today's month, oldest first."""
    n = max(int(months or 1), int(step or 1), 1)
    this = today.isoformat()[:7]
    return [month_add(this, -k) for k in range(n, 0, -1)]


def lookback(today: date, win: list[str]) -> list[str]:
    n = max(LOOKBACK, len(win))
    this = today.isoformat()[:7]
    return [month_add(this, -k) for k in range(n, 0, -1)]


def judge(posted: dict, win: list[str], back: list[str]) -> tuple[bool, str]:
    """(stale, last month anything posted within the lookback or '')."""
    stale = all(abs(posted.get(m, 0) or 0) <= _POSTED for m in win)
    hits = [m for m in back if abs(posted.get(m, 0) or 0) > _POSTED]
    return stale, (hits[-1] if hits else "")


def in_force_since(start: str, win: list[str]) -> bool:
    """The line started on or before the first day of the window ('' = always)."""
    return not start or start[:10] <= f"{win[0]}-01"


def mri_candidates(leases: list[dict], today: date, months: int) -> list[tuple[dict, list[str]]]:
    from routers import leasing
    out = []
    for l in leases:
        if l["status"] != "active" or leasing.expired(l, today) or not l["customerId"] or not l["rates"]:
            continue
        win = window(today, months, leasing.lease_step(l))
        start = l["leaseStart"] or l["rates"][0]["startDate"]
        if in_force_since(start, win):
            out.append((l, win))
    return out


def mre_candidates(lines: list[dict], today: date, months: int) -> list[tuple[dict, list[str]]]:
    from routers import accounting_mre
    out = []
    for l in lines:
        if l["status"] != "active" or (l["endDate"] and l["endDate"] < today.isoformat()) or not l["vendorId"]:
            continue
        win = window(today, months, accounting_mre.step_months(l))
        if in_force_since(l["startDate"], win):
            out.append((l, win))
    return out


def mri_posted(lease: dict, receipts: dict, back: list[str]) -> dict:
    """{'YYYY-MM': received} for one source - the rent roll's own lookup."""
    cid, ent = lease["customerId"], lease.get("entityCode", "")
    out = {}
    for key in back:
        cell = receipts.get((ent, cid, key)) or receipts.get((cid, key), {})
        out[key] = round(sum(v for code, v in cell.items() if code in lease["incomeAccounts"]), 2)
    return out


def mre_posted(line: dict, months: dict) -> dict:
    accounts = set(line["expenseAccounts"])
    return {m: round(sum(v for gl, v in cell.items() if gl in accounts), 2) for m, cell in (months or {}).items()}


# ── Ledger reads (async; never a blocking call on the loop) ─────────────────
_SCOPE = {"user": {"email": "recurring-stale", "name": "Possibly Ended Check"}, "allowed": None}


async def _mri_results(today: date, months: int) -> list[dict]:
    from routers import leasing
    rows, rates, _m, names = await asyncio.to_thread(leasing._load_all_named)
    leases = [leasing._lease_out(l, rates.get(l.id, []), names) for l in rows]
    cands = mri_candidates(leases, today, months)
    if not cands:
        return []
    back_all = sorted({m for _l, win in cands for m in lookback(today, win)})
    receipts: dict = {}
    for year in sorted({int(m[:4]) for m in back_all}):
        receipts.update(await leasing._receipts(_SCOPE, [l for l, _w in cands], year, every=rows))
    out = []
    for l, win in cands:
        back = lookback(today, win)
        stale, last = judge(mri_posted(l, receipts, back), win, back)
        out.append({"id": l["id"], "stale": stale, "lastPaid": last, "entity": l["entityCode"], "window": win,
                    "label": l["propertyName"], "who": l["tenantName"] or l["customerId"]})
    return out


async def _mre_grouped(cands: list[tuple[dict, list[str]]], today: date) -> tuple[dict, set]:
    """({(entity, vendor): {'YYYY-MM': {gl: amount}}}, the pairs it could not
    answer) - the grid's grouped read (one per calendar year of the lookback,
    about a second each) instead of one ledger read per line (10/27, Urmi:
    saving the months setting has to re-check right away, and ~180 reads took
    minutes). A pair the grouped read cannot answer is read on its own."""
    from routers import accounting_mre
    pairs = sorted({(l["entityCode"], l["vendorId"]) for l, _w in cands})
    accounts = {a for l, _w in cands for a in l["expenseAccounts"] or []}
    years = sorted({int(m[:4]) for _l, win in cands for m in lookback(today, win)})
    got: dict = {p: {} for p in pairs}
    slow: set = set()
    for year in years:
        try:
            part, missing = await accounting_mre._grid_payments(_SCOPE, pairs, year, accounts)
        except Exception as e:  # noqa: BLE001 - the one-line reads stand in
            print(f"[recurring-stale] grouped read {year} failed: {getattr(e, 'detail', None) or e}")
            part, missing = {}, pairs
        for p, months in part.items():
            got.setdefault(p, {}).update(months)
        slow.update(missing)
    return got, slow


async def _mre_results(today: date, months: int) -> list[dict]:
    from routers import accounting_mre
    lines = await asyncio.to_thread(accounting_mre._load_all)
    cands = mre_candidates(lines, today, months)
    if not cands:
        return []
    grouped, slow = await _mre_grouped(cands, today)
    out = []
    for l, win in cands:
        back = lookback(today, win)
        pair = (l["entityCode"], l["vendorId"])
        if pair in slow:
            try:
                got = await accounting_mre._vendor_months(_SCOPE, l["entityCode"], l["vendorId"], f"{back[0]}-01", _month_end(back[-1]))
            except Exception as e:  # noqa: BLE001 - this line is left as it was
                print(f"[recurring-stale] MRE {l['vendorId']} at {l['entityCode']} not read: {getattr(e, 'detail', None) or e}")
                continue
        else:
            got = grouped.get(pair, {})
        stale, last = judge(mre_posted(l, got), win, back)
        out.append({"id": l["id"], "stale": stale, "lastPaid": last, "entity": l["entityCode"], "window": win,
                    "label": l["vendorName"] or l["vendorId"], "who": l["entityName"] or l["entityCode"]})
    return out


def _month_end(key: str) -> str:
    import calendar
    return f"{key}-{calendar.monthrange(int(key[:4]), int(key[5:7]))[1]:02d}"


# ── Writes (sync, run in a thread) ───────────────────────────────────────────
def _month_text(key: str) -> str:
    if not key:
        return ""
    return datetime(int(key[:4]), int(key[5:7]), 1).strftime("%B %Y")


def accountants_for(db, entity: str) -> list[str]:
    rows = {(r.entity_code or ""): [str(e).lower() for e in (r.accountants or []) if e] for r in db.query(models.AccountingAmaSetting).all()}
    return rows.get(entity or "") or rows.get("") or []


def _task_text(kind: str, r: dict, months: int) -> tuple[str, str]:
    last = _month_text(r["lastPaid"])
    quiet = f"{len(r['window'])} months ({_month_text(r['window'][0])} to {_month_text(r['window'][-1])})"
    if kind == "mri":
        title = f"Possibly Ended: {r['label']} - No Income in {len(r['window'])} Months"
        body = (f"MRI: nothing has posted for {r['who']} at {r['label']} (entity {r['entity'] or 'not set'}) in the last {quiet}. "
                f"{f'The last payment posted in {last}.' if last else 'Nothing posted in the last twelve months.'} "
                "If the lease or income source has ended, open Accounting > MRI > Payers and set its Status to Ended (or Vacant). "
                "If it is still going, check the customer code and income accounts on it. "
                "This task closes itself when a payment posts again or the source is marked ended.")
    else:
        title = f"Possibly Ended: {r['label']} - No Expense in {len(r['window'])} Months"
        body = (f"MRE: nothing has posted for {r['label']} on {r['who']} in the last {quiet}. "
                f"{f'The last expense posted in {last}.' if last else 'Nothing posted in the last twelve months.'} "
                "If the bill has stopped, open Accounting > MRE, edit the line and press End Today. "
                "If it is still going, check the vendor and expense accounts on it. "
                "This task closes itself when an expense posts again or the line is ended.")
    return title, body


def _new_task(db, owners: list[str], title: str, body: str, today: date) -> models.Task:
    from auth import company_of
    from routers.task_util import set_task_assignees
    from routers.tasks import _next_code
    now = _now()
    t = models.Task(
        id=str(uuid.uuid4()), code=_next_code(db), company_id=company_of(owners[0], db) if owners else "", title=title[:300],
        description=body, type="task", status="not_started", priority="medium", position=datetime.now().timestamp(),
        assignee_email="", assignee_emails=[], owner_email=ACTOR, follower_emails=[], liked_by_emails=[],
        access_level="restricted", project_id="", project_ids=[], section_id="", team_id="", parent_task_id="",
        subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={}, tags=[], custom_field_values={},
        start_on="", due_on=(today + timedelta(days=7)).isoformat(), approval_status="none", completed=False,
        completed_at="", comment_ids=[], attachment_ids=[], activity_ids=[], created_at=now, modified_at=now, created_by=ACTOR)
    set_task_assignees(t, owners)
    db.add(t)
    return t


def _close_task(db, task_id: str) -> None:
    if not task_id:
        return
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if t is not None and not t.completed:
        now = _now()
        t.completed, t.completed_at, t.status, t.modified_at = True, now, "completed", now


def _inactive(kind: str, row, today: date) -> bool:
    if kind == "mri":
        return (row.status or "active") != "active" or bool(row.lease_end and row.lease_end < today.isoformat())
    return (row.status or "active") != "active" or bool(row.end_date and row.end_date < today.isoformat())


def apply(kind: str, results: list[dict], today: date, months: int) -> dict:
    """Write the flags and open / close the tasks. Returns what changed; the
    caller sends the task emails for `opened` (outside the transaction)."""
    Model = models.Lease if kind == "mri" else models.RecurringExpense
    by_id = {r["id"]: r for r in results}
    opened, flagged, cleared = [], 0, 0
    db = SessionLocal()
    try:
        rows = db.query(Model).filter((Model.id.in_(list(by_id))) | (Model.stale_since != "") | (Model.stale_task_id != "")).with_for_update().all()
        for row in rows:
            r = by_id.get(row.id)
            if r is None:
                # Not checked: ended / inactive since (clear it), or the read failed (leave it).
                if _inactive(kind, row, today) and (row.stale_since or row.stale_task_id):
                    _close_task(db, row.stale_task_id or "")
                    row.stale_since, row.stale_last_paid, row.stale_task_id = "", "", ""
                    cleared += 1
                continue
            if r["stale"]:
                row.stale_last_paid = r["lastPaid"]
                if not row.stale_since:
                    row.stale_since = today.isoformat()
                    flagged += 1
                if not row.stale_task_id:
                    owners = accountants_for(db, r["entity"])
                    if not owners:
                        made = (row.created_by or "").lower()
                        owners = [made] if "@" in made else []
                    if owners:
                        title, body = _task_text(kind, r, months)
                        t = _new_task(db, owners, title, body, today)
                        row.stale_task_id = t.id
                        opened.append(t.id)
            elif row.stale_since or row.stale_task_id:
                _close_task(db, row.stale_task_id or "")
                row.stale_since, row.stale_last_paid, row.stale_task_id = "", "", ""
                cleared += 1
        db.commit()
    finally:
        db.close()
    return {"flagged": flagged, "cleared": cleared, "opened": opened}


def _send_task_emails(ids: list[str]) -> None:
    try:
        from task_notify import notify_task_event
    except Exception:  # noqa: BLE001 - the tasks exist either way
        return
    for tid in ids:
        try:
            notify_task_event(tid, "created", ACTOR)
        except Exception as e:  # noqa: BLE001
            print(f"[recurring-stale] task email {tid}: {e}")


def save_last_check(started: str, months: int, result: dict) -> None:
    """When the check last finished, with how many months and what it found -
    the settings hint shows it, and a screen waiting on a re-check reads it
    (any worker: the run's own memory is per worker)."""
    db = SessionLocal()
    try:
        row = db.query(models.NexusSetting).filter(models.NexusSetting.key == LAST_CHECK_KEY).first()
        if not row:
            row = models.NexusSetting(key=LAST_CHECK_KEY)
            db.add(row)
        row.value = json.dumps({"startedAt": started, "at": _now(), "months": months, "result": result})
        row.updated_by, row.updated_at = ACTOR, _now()
        db.commit()
    finally:
        db.close()


def load_last_check() -> Optional[dict]:
    db = SessionLocal()
    try:
        row = db.query(models.NexusSetting).filter(models.NexusSetting.key == LAST_CHECK_KEY).first()
        try:
            return json.loads(row.value) if row and row.value else None
        except ValueError:
            return None
    finally:
        db.close()


async def check(today: Optional[date] = None) -> dict:
    """One full pass over MRI and MRE. Safe to run twice: a flagged line is
    never re-flagged or given a second task."""
    started = _now()
    today = today or date.today()
    settings = await asyncio.to_thread(load_settings)
    months = settings["staleMonths"]
    out = {}
    for kind, read in (("mri", _mri_results), ("mre", _mre_results)):
        try:
            results = await read(today, months)
        except Exception as e:  # noqa: BLE001 - the other side still runs
            print(f"[recurring-stale] {kind} not read: {getattr(e, 'detail', None) or e}")
            out[kind] = {"error": str(getattr(e, "detail", None) or e)}
            continue
        done = await asyncio.to_thread(apply, kind, results, today, months)
        if done["opened"]:
            await asyncio.to_thread(_send_task_emails, done["opened"])
        out[kind] = {"checked": len(results), "flagged": done["flagged"], "cleared": done["cleared"], "tasks": len(done["opened"]),
                     "possiblyEnded": sum(1 for r in results if r["stale"])}
    try:
        await asyncio.to_thread(save_last_check, started, months, out)
    except Exception as e:  # noqa: BLE001 - the flags are written either way
        print(f"[recurring-stale] last check not recorded: {e}")
    return out


async def recurring_stale_loop():
    """Once a day on the deployed worker. Every ledger read is async HTTP,
    every database touch in asyncio.to_thread."""
    from leader import is_deployed_worker
    from routers import accounting

    if not is_deployed_worker():
        print("[recurring-stale] skipped (not the deployed worker)")
        return
    await asyncio.sleep(900)  # let startup and the leasing sync settle
    while True:
        try:
            if accounting._ACCT_BASE and accounting._ACCT_KEY \
                    and not await asyncio.to_thread(job_switch.off, "recurring_stale"):   # Workflows > Automations switch
                out = await check()
                print(f"[recurring-stale] {out}")
        except Exception as e:  # noqa: BLE001 - tomorrow tries again
            print(f"[recurring-stale] failed: {e}")
        await asyncio.sleep(CHECK_EVERY_SEC)
