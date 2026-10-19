"""Cubby's data warehouse (Google BigQuery, project `cubby-partner-data`).

Cubby shares a read-only analytics dataset with each operator, row-filtered to
the operator's org. The one table Nexus reads today is `analytics.stor_track`:
the StorTrack competitor rate feed (Cubby includes it in our plan), which
`ops_stortrack.py` imports into Operations -> Market Rates.

Credentials: a Google service account that Cubby has granted access to
`cubby-partner-data` (docs/Cubby-StorTrack-Setup.md).

  CUBBY_BQ_CREDENTIALS_JSON  the service account's whole JSON key, as text
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
    if not isinstance(info, dict) or info.get("type") != "service_account":
        raise WarehouseError("CUBBY_BQ_CREDENTIALS_JSON is not a Google service account key")
    return info


def billing_project() -> str:
    explicit = os.environ.get("CUBBY_BQ_PROJECT", "").strip()
    return explicit or str(_key_info().get("project_id") or "")


def _client():
    """A BigQuery client on the service account. Imported here, not at module
    load, so a server without the package (or the key) still starts. The tests
    replace this function."""
    try:
        from google.cloud import bigquery
        from google.oauth2 import service_account
    except ImportError as e:
        raise WarehouseError("The google-cloud-bigquery package is not installed on this server") from e
    info = _key_info()
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/bigquery"])   # running a query job needs the full scope
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
