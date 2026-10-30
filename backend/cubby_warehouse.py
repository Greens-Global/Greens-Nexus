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


def tasks_sql() -> str:
    cols = ", ".join(TASK_COLUMNS)
    # Every open task plus anything touched since @since, so a completion in
    # Cubby is seen even after the task left the open list.
    return (f"SELECT {cols} FROM `{TASKS_TABLE}` "
            "WHERE status = 'OPEN' OR updated_at >= @since "
            f"ORDER BY updated_at DESC LIMIT {TASK_MAX_ROWS}")


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
    out = []
    for r in _run(tasks_sql(), params):
        row = dict(r)
        row["assigned_managers"] = _names(row.get("assigned_managers"))
        row["assigned_manager_groups"] = _names(row.get("assigned_manager_groups"))
        for k in ("due_date", "created_at", "updated_at"):
            v = row.get(k)
            row[k] = v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else "")
        out.append(row)
    return out


def manager_rows() -> list[dict]:
    """Cubby staff: name and work email. [] when not configured."""
    if not configured():
        return []
    return [dict(r) for r in _run(managers_sql(), [])]
