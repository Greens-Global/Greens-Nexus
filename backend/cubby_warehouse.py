"""Cubby's data warehouse (Google BigQuery, project `cubby-partner-data`).

Cubby shares a read-only analytics dataset with each operator, row-filtered to
the operator's org. The one table Nexus reads today is `analytics.stor_track`:
the StorTrack competitor rate feed (Cubby includes it in our plan), which
`ops_stortrack.py` imports into Operations -> Market Rates.

Credentials (docs/Cubby-StorTrack-Setup.md), either:
  * a Google service account that Cubby has granted access to
    `cubby-partner-data`, or
  * a signed-in Google account Cubby already granted (Cubby provisions
    people's Google accounts, Sep 2026): an "authorized_user" JSON - OAuth
    client id + secret + refresh token - made once with
    `backend/scripts/cubby_bq_login.py`. It acts as that person, so it stops
    working if their access or account goes away.

  CUBBY_BQ_CREDENTIALS_JSON  the whole JSON (service account key or
                             authorized_user), as text
  CUBBY_BQ_PROJECT           optional: the project query jobs are billed to.
                             Usually the service account's own project, which
                             is the default (the `project_id` in the key).

Without the key `configured()` is False and nothing here is ever called. The
Google package is imported only inside `_client`, so the app boots without it.
The key is never logged or echoed in an error.

Everything here blocks (network). Call it in a thread.
"""
import json
import os
from datetime import date

TABLE = "cubby-partner-data.analytics.stor_track"
QUERY_TIMEOUT_SEC = 120
MAX_ROWS = 250_000          # a backstop: a first run reads a few months, never the whole history

# Only what the import uses - never SELECT *.
STOR_TRACK_COLUMNS = (
    "facility_id", "competitor_weight", "store_name", "address", "city", "state", "zip",
    "class_type", "date_collected", "space_type", "size", "width", "length",
    "climate_controlled", "has_elevator", "drive_up", "regular_price", "online_price",
    "promo_price", "promo",
)


class WarehouseError(Exception):
    """BigQuery said no or could not be reached. The message is safe to show:
    it never carries the key."""


def _key_text() -> str:
    return os.environ.get("CUBBY_BQ_CREDENTIALS_JSON", "").strip()


def configured() -> bool:
    return bool(_key_text())


def _key_info() -> dict:
    try:
        info = json.loads(_key_text())
    except ValueError:
        # Never include the text: it is the private key.
        raise WarehouseError("CUBBY_BQ_CREDENTIALS_JSON is not valid JSON") from None
    if not isinstance(info, dict) or info.get("type") not in KEY_TYPES:
        raise WarehouseError("CUBBY_BQ_CREDENTIALS_JSON is not a Google service account key or signed-in account")
    if info["type"] == "authorized_user" and not all(info.get(k) for k in ("client_id", "client_secret", "refresh_token")):
        raise WarehouseError("CUBBY_BQ_CREDENTIALS_JSON is missing the client id, client secret or refresh token")
    return info


KEY_TYPES = ("service_account", "authorized_user")


def billing_project() -> str:
    explicit = os.environ.get("CUBBY_BQ_PROJECT", "").strip()
    info = _key_info()
    return explicit or str(info.get("project_id") or info.get("quota_project_id") or "")


def _client():
    """A BigQuery client on the service account or signed-in account. Imported here, not at module
    load, so a server without the package (or the key) still starts. The tests
    replace this function."""
    try:
        from google.cloud import bigquery
        from google.oauth2 import credentials as user_credentials
        from google.oauth2 import service_account
    except ImportError as e:
        raise WarehouseError("The google-cloud-bigquery package is not installed on this server") from e
    info = _key_info()
    scopes = ["https://www.googleapis.com/auth/bigquery"]   # running a query job needs the full scope
    if info["type"] == "authorized_user":
        creds = user_credentials.Credentials.from_authorized_user_info(info, scopes=scopes)
    else:
        creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
    project = billing_project()
    if not project:
        raise WarehouseError("No billing project: set CUBBY_BQ_PROJECT")
    return bigquery.Client(project=project, credentials=creds)


def stor_track_sql() -> str:
    cols = ", ".join(STOR_TRACK_COLUMNS)
    # date_collected is a DATE; the window is inclusive and parameterized.
    return (f"SELECT {cols} FROM `{TABLE}` "
            "WHERE date_collected >= @since AND date_collected <= @until "
            "ORDER BY date_collected, facility_id, store_name, size "
            f"LIMIT {MAX_ROWS}")


def stor_track_rows(since: date, until: date) -> list[dict]:
    """StorTrack rows collected between `since` and `until` (both inclusive),
    oldest first, as plain dicts. Raises WarehouseError."""
    if not configured():
        return []
    client = _client()
    try:
        from google.cloud import bigquery
        params = [bigquery.ScalarQueryParameter("since", "DATE", since),
                  bigquery.ScalarQueryParameter("until", "DATE", until)]
        job_config = bigquery.QueryJobConfig(query_parameters=params)
    except ImportError:
        # The tests' fake client takes the parameters as a plain dict.
        job_config = {"since": since, "until": until}
    try:
        job = client.query(stor_track_sql(), job_config=job_config)
        return [dict(r.items()) if hasattr(r, "items") else dict(r) for r in job.result(timeout=QUERY_TIMEOUT_SEC)]
    except WarehouseError:
        raise
    except Exception as e:  # noqa: BLE001 - google.api_core raises many kinds; none may carry the key
        msg = str(getattr(e, "message", "") or "").strip()
        if "private_key" in msg or "BEGIN PRIVATE KEY" in msg:
            msg = ""
        raise WarehouseError(f"BigQuery did not answer ({type(e).__name__}){': ' + msg[:200] if msg else ''}") from None


# ── Tasks and staff (Cubby tasks -> Nexus Tasks, Neil, Oct 30 2026) ──────────
# Cubby's API task carries no assignee (its docs: "assignees ... are managed
# in the Cubby app"); the BigQuery warehouse's `tasks` table does. The columns
# below are Cubby's OWN published BigQuery schema
# (https://cubbystorage.github.io/docs/data-dictionary/schema.csv, read
# 11/06/2026) - NOT the Postgres reporting copy the Cubby MCP reads, whose
# names differ (assigned_managers, task_title, updated_at...): every earlier
# query was written from that copy, which is why prod never got assignees.
#   tasks.assignee            ARRAY<STRING>  manager IDs assigned to the task
#   tasks.manager_created_by  STRING         manager ID of the creator
#   managers.manager_id / manager_name / manager_email
# There is no group assignment column and no updated_at (created_at,
# completed_at, archived_at instead). cubby_tasks.py reads both after each
# Cubby sync. Same dataset and credentials as StorTrack; a server without the
# key simply gets no assignees (facility routing still works).

TASKS_TABLE = "cubby-partner-data.analytics.tasks"
MANAGERS_TABLE = "cubby-partner-data.analytics.managers"
TASK_COLUMNS = ("task_id", "facility_id", "status", "title", "due_date", "schedule", "assignee",
                "manager_created_by", "contact_id", "unit_id", "workflow_run_id",
                "created_at", "completed_at", "archived_at")
TASK_STAMPS = ("created_at", "completed_at", "archived_at")
TASK_MAX_ROWS = 20_000
# Notes on a task (Sagar, 11/03/2026: "get the notes also"). Cubby's BigQuery
# `manager_notes` is linked to TENANTS only (contact_name, unit_name, note -
# no task_id), so task notes cannot come from the warehouse; notes_sql says
# so in the run's note rather than guessing. Kept for a warehouse that ever
# carries task_id.
NOTES_TABLE = "cubby-partner-data.analytics.manager_notes"
NOTE_COLUMNS = ("manager_note_id_int", "task_id", "message", "manager_name", "manager_id", "created_at")
NOTE_MAX_ROWS = 20_000


def _names(value) -> list[str]:
    """A warehouse ARRAY as a clean list of names - BigQuery hands a list,
    a Postgres mirror a '{"A","B"}' string."""
    if value is None:
        return []
    if isinstance(value, str):
        s = value.strip()
        if s.startswith("{") and s.endswith("}"):
            s = s[1:-1]
        parts = []
        for p in s.split(","):
            p = p.strip().strip('"').strip()
            if p:
                parts.append(p)
        return parts
    try:
        return [str(v).strip() for v in value if str(v).strip()]
    except TypeError:
        return []


def _run(sql: str, params: list) -> list[dict]:
    client = _client()
    try:
        from google.cloud import bigquery
        job_config = bigquery.QueryJobConfig(query_parameters=params)
    except ImportError:
        job_config = {p.name: p.value for p in params} if params and hasattr(params[0], "name") else {}
    try:
        job = client.query(sql, job_config=job_config)
        return [dict(r.items()) if hasattr(r, "items") else dict(r) for r in job.result(timeout=QUERY_TIMEOUT_SEC)]
    except WarehouseError:
        raise
    except Exception as e:  # noqa: BLE001 - never let the key into an error
        msg = str(getattr(e, "message", "") or "").strip()
        if "private_key" in msg or "BEGIN PRIVATE KEY" in msg:
            msg = ""
        raise WarehouseError(f"BigQuery did not answer ({type(e).__name__}){': ' + msg[:200] if msg else ''}") from None


# BigQuery's tables are NOT the Postgres mirror the Cubby MCP reads (prod,
# 11/03-11/05/2026): `tasks` has no `updated_at`, and BigQuery checks a
# query's filter before its column list, so each fix of a guessed column only
# uncovered the next one. So every query is built from the table's REAL
# columns and types, read from BigQuery itself (one cheap metadata call per
# table, cached for the process): only columns that exist are selected, the
# time window compares in the column's own type, and whatever is missing is
# said in the run's note instead of failing the read.
_COLUMNS_TTL_SEC = 3600
_columns_cache: dict = {}
NAME_COLUMNS = ("manager_name", "name", "full_name")
EMAIL_COLUMNS = ("manager_email", "email", "work_email")
_missing: dict = {}        # table -> columns the code wanted but the table lacks (for the run's note)


def _columns(table: str) -> dict:
    """{column name: BigQuery type} for `table`. Raises WarehouseError."""
    import time as _time
    hit = _columns_cache.get(table)
    if hit and _time.monotonic() - hit[0] < _COLUMNS_TTL_SEC:
        return hit[1]
    client = _client()
    try:
        try:
            schema = client.get_table(table).schema
        except Exception:  # noqa: BLE001 - no metadata permission: ask a dry run instead
            # A dry run is free, returns no rows, and needs only the query
            # permission every read here already uses.
            from google.cloud import bigquery
            job = client.query(f"SELECT * FROM `{table}`", job_config=bigquery.QueryJobConfig(dry_run=True))
            schema = job.schema
        cols = {f.name: str(f.field_type or "").upper() for f in schema}
    except WarehouseError:
        raise
    except Exception as e:  # noqa: BLE001 - never let the key into an error
        msg = str(getattr(e, "message", "") or "").strip()
        if "private_key" in msg or "BEGIN PRIVATE KEY" in msg:
            msg = ""
        raise WarehouseError(f"BigQuery would not describe {table.rsplit('.', 1)[-1]} "
                             f"({type(e).__name__}){': ' + msg[:200] if msg else ''}") from None
    _columns_cache[table] = (_time.monotonic(), cols)
    return cols


def _window(column: str, kind: str) -> str:
    """`column` on or after @since (a TIMESTAMP), compared in the column's own
    type - BigQuery will not compare a DATETIME or DATE with a TIMESTAMP."""
    kind = (kind or "").upper()
    if kind == "TIMESTAMP":
        return f"{column} >= @since"
    if kind == "DATETIME":
        return f"{column} >= DATETIME(@since)"
    if kind == "DATE":
        return f"{column} >= DATE(@since)"
    return f"SAFE_CAST({column} AS TIMESTAMP) >= @since"


def _pick(cols: dict, wanted: tuple, table: str) -> list[str]:
    have = [c for c in wanted if c in cols]
    _missing[table] = [c for c in wanted if c not in cols]
    return have


def missing_note() -> str:
    """What the last reads wanted and the warehouse does not have, for the
    run's summary ('' when nothing is missing)."""
    parts = [f"{t.rsplit('.', 1)[-1]} has no {', '.join(c)}" for t, c in _missing.items() if c]
    return "; ".join(parts)


def tasks_sql(cols: dict) -> str:
    # Every open task plus anything created, completed or archived since
    # @since, so a completion in Cubby is seen after it left the open list.
    if "task_id" not in cols:
        raise WarehouseError("The warehouse's tasks table has no task_id")
    if "assignee" not in cols:
        raise WarehouseError(f"The warehouse's tasks table has no assignee column "
                             f"(it has: {', '.join(sorted(cols))[:240]})")
    have = _pick(cols, TASK_COLUMNS, TASKS_TABLE)
    where = ["status = 'OPEN'"] if "status" in cols else ["TRUE"]
    where += [_window(c, cols[c]) for c in TASK_STAMPS if c in cols]
    order = "created_at" if "created_at" in cols else "task_id"
    return (f"SELECT {', '.join(have)} FROM `{TASKS_TABLE}` WHERE {' OR '.join(where)} "
            f"ORDER BY {order} DESC LIMIT {TASK_MAX_ROWS}")


def notes_sql(cols: dict) -> str:
    if "task_id" not in cols or "message" not in cols:
        raise WarehouseError("Cubby's warehouse links notes to tenants only, not to tasks, "
                             "so task notes cannot be read")
    have = _pick(cols, NOTE_COLUMNS, NOTES_TABLE)
    where = "task_id IS NOT NULL AND task_id != ''"
    if "created_at" in cols:
        where += f" AND {_window('created_at', cols['created_at'])}"
    order = "created_at" if "created_at" in cols else "task_id"
    return f"SELECT {', '.join(have)} FROM `{NOTES_TABLE}` WHERE {where} ORDER BY {order} LIMIT {NOTE_MAX_ROWS}"


def managers_sql(cols: dict) -> str:
    name = next((c for c in NAME_COLUMNS if c in cols), "")
    email = next((c for c in EMAIL_COLUMNS if c in cols), "")
    if not name or not email:
        _missing[MANAGERS_TABLE] = [c for c, ok in (("a name column", name), ("an email column", email)) if not ok]
        raise WarehouseError(f"The warehouse's managers table has no {'name' if not name else 'email'} column "
                             f"(it has: {', '.join(sorted(cols))[:200]})")
    _missing[MANAGERS_TABLE] = []
    mid = "manager_id" if "manager_id" in cols else "''"
    return f"SELECT {mid} AS manager_id, {name} AS manager_name, {email} AS manager_email FROM `{MANAGERS_TABLE}`"


def _since_param(since):
    try:
        from google.cloud import bigquery
        return [bigquery.ScalarQueryParameter("since", "TIMESTAMP", since)]
    except ImportError:
        return [since]


def _iso(v) -> str:
    return v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else "")


def task_rows(since) -> list[dict]:
    """Cubby tasks from the warehouse: open ones and those created, completed
    or archived since `since` (a datetime), in the shape cubby_tasks reads:
      assignee_ids       the manager IDs Cubby assigned (`assignee`)
      created_by_id      the creator's manager ID (`manager_created_by`)
      task_title, is_workflow_generated, updated_at (the latest of the stamps)
    cubby_tasks turns the IDs into names and Nexus people through
    manager_rows. [] when the warehouse is not configured. Raises
    WarehouseError."""
    if not configured():
        return []
    out = []
    for r in _run(tasks_sql(_columns(TASKS_TABLE)), _since_param(since)):
        row = dict(r)
        row["assignee_ids"] = _names(row.get("assignee"))
        row["created_by_id"] = str(row.get("manager_created_by") or "")
        row["task_title"] = row.get("title") or ""
        row["is_workflow_generated"] = row.get("workflow_run_id") is not None
        for k in ("due_date", *TASK_STAMPS):
            row[k] = _iso(row.get(k))
        row["updated_at"] = max((row[k] for k in TASK_STAMPS if row.get(k)), default="")
        out.append(row)
    return out


def note_rows(since) -> list[dict]:
    """Task notes written since `since`, oldest first; `id` is the warehouse
    row id as a string, `created_at` ISO. [] when not configured. Raises
    WarehouseError."""
    if not configured():
        return []
    out = []
    for r in _run(notes_sql(_columns(NOTES_TABLE)), _since_param(since)):
        row = dict(r)
        v = row.get("created_at")
        row["created_at"] = v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else "")
        row["id"] = str(row.get("manager_note_id_int") or "")
        row["message"] = (row.get("message") or "").strip()
        if row["id"] and row.get("task_id") and row["message"]:
            out.append(row)
    return out


def manager_rows() -> list[dict]:
    """Cubby staff: manager_id, name and work email. [] when not configured."""
    if not configured():
        return []
    return [dict(r) for r in _run(managers_sql(_columns(MANAGERS_TABLE)), [])]
