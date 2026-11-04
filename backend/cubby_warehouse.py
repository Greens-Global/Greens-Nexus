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
# Cubby's API task carries no assignee; the warehouse's `tasks` table does
# (`assigned_managers` / `assigned_manager_groups` are staff and group NAMES),
# and `managers` maps a name to a work email. cubby_tasks.py reads both after
# each Cubby sync. Same dataset and credentials as StorTrack; a server
# without the key simply gets no assignees (facility routing still works).

TASKS_TABLE = "cubby-partner-data.analytics.tasks"
MANAGERS_TABLE = "cubby-partner-data.analytics.managers"
TASK_COLUMNS = ("task_id", "facility_id", "status", "task_title", "due_date", "schedule",
                "assigned_managers", "assigned_manager_groups", "created_by", "contact_id", "unit_id",
                "is_workflow_generated", "created_at", "updated_at")
MANAGER_COLUMNS = ("manager_id", "manager_name", "manager_email")
TASK_MAX_ROWS = 20_000
# Notes a manager typed on a task (Sagar, 11/03/2026: "get the notes also").
# `manager_notes` holds every note on every record; only rows with a task_id
# are read, inside a created_at window. Append-only there: an edit or a
# delete in Cubby never reaches this table.
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


def tasks_sql(stamp: str = "updated_at") -> str:
    # Every open task plus anything touched since @since, so a completion in
    # Cubby is seen even after the task left the open list. `stamp` is the
    # column that says when: `updated_at`, or `created_at` on a warehouse
    # whose tasks table has no `updated_at` (prod, 11/03/2026: BigQuery
    # answered "Unrecognized name: updated_at; Did you mean created_at?" and
    # every task came in unassigned) - task_rows falls back by itself.
    cols = ", ".join(c for c in TASK_COLUMNS if c != "updated_at" or stamp == "updated_at")
    return (f"SELECT {cols} FROM `{TASKS_TABLE}` "
            f"WHERE status = 'OPEN' OR {_since(stamp)} "
            f"ORDER BY {stamp} DESC LIMIT {TASK_MAX_ROWS}")


def _since(column: str) -> str:
    # The warehouse's `created_at` / `updated_at` are DATETIME (no zone; the
    # Postgres mirror shows them as "timestamp without time zone") and the
    # parameter is a TIMESTAMP - BigQuery refuses to compare the two ("No
    # matching signature for operator >="), and prod's tasks query only
    # reached that check once the missing-column retry landed (11/04/2026:
    # the assignees were still not read). Casting the column makes the
    # comparison work whichever of the two types the column really is.
    return f"CAST({column} AS TIMESTAMP) >= @since"


def _missing_updated_at(err: Exception) -> bool:
    return "unrecognized name: updated_at" in str(err).lower()


def notes_sql() -> str:
    return (f"SELECT {', '.join(NOTE_COLUMNS)} FROM `{NOTES_TABLE}` "
            f"WHERE task_id IS NOT NULL AND task_id != '' AND {_since('created_at')} "
            f"ORDER BY created_at LIMIT {NOTE_MAX_ROWS}")


def managers_sql() -> str:
    return f"SELECT {', '.join(MANAGER_COLUMNS)} FROM `{MANAGERS_TABLE}`"


def task_rows(since) -> list[dict]:
    """Cubby tasks from the warehouse: open ones and those updated since
    `since` (a datetime). Assignee columns come back as lists of names.
    [] when the warehouse is not configured. Raises WarehouseError."""
    if not configured():
        return []
    try:
        from google.cloud import bigquery
        params = [bigquery.ScalarQueryParameter("since", "TIMESTAMP", since)]
    except ImportError:
        params = [since]
    try:
        rows = _run(tasks_sql(), params)
    except WarehouseError as e:
        if not _missing_updated_at(e):
            raise
        rows = _run(tasks_sql("created_at"), params)
    out = []
    for r in rows:
        row = dict(r)
        row["assigned_managers"] = _names(row.get("assigned_managers"))
        row["assigned_manager_groups"] = _names(row.get("assigned_manager_groups"))
        for k in ("due_date", "created_at", "updated_at"):
            v = row.get(k)
            row[k] = v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else "")
        out.append(row)
    return out


def note_rows(since) -> list[dict]:
    """Task notes written since `since`, oldest first; `id` is the warehouse
    row id as a string, `created_at` ISO. [] when not configured. Raises
    WarehouseError."""
    if not configured():
        return []
    try:
        from google.cloud import bigquery
        params = [bigquery.ScalarQueryParameter("since", "TIMESTAMP", since)]
    except ImportError:
        params = [since]
    out = []
    for r in _run(notes_sql(), params):
        row = dict(r)
        v = row.get("created_at")
        row["created_at"] = v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else "")
        row["id"] = str(row.get("manager_note_id_int") or "")
        row["message"] = (row.get("message") or "").strip()
        if row["id"] and row.get("task_id") and row["message"]:
            out.append(row)
    return out


def manager_rows() -> list[dict]:
    """Cubby staff: name and work email. [] when not configured."""
    if not configured():
        return []
    return [dict(r) for r in _run(managers_sql(), [])]
