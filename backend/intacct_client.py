"""A small, read-only Sage Intacct Web Services client (Oct 21 2026).

Used by People > Sync Employee Codes From Intacct (routers/hr_intacct_codes.py)
to read the EMPLOYEE list straight from Intacct - the accounting app is not
involved. The request shape mirrors the Greens Accounting client: a <control>
block with the Web Services sender, a <login> block for the API user, then one
function per request.

  1. getAPISession with the login block -> a session id (and the endpoint
     Intacct wants the session used on, always an *.intacct.com host).
  2. readByQuery on EMPLOYEE with that session, then readMore (resultId) until
     nothing remains.

Credentials come ONLY from the environment:
  INTACCT_SENDER_ID, INTACCT_SENDER_PASSWORD, INTACCT_USER_ID,
  INTACCT_USER_PASSWORD, INTACCT_COMPANY_ID (required) and INTACCT_ENTITY_ID
  (optional; empty = top level, every entity).

Never logs or echoes a credential, the session id or the request XML. Error
text is Intacct's own error description with every credential value scrubbed.
Blocking (httpx, 30 s per call) - callers run it in a thread.
"""
from __future__ import annotations

import os
import uuid
from typing import Callable, Optional
from urllib.parse import urlparse
from xml.sax.saxutils import escape

import httpx

try:   # defusedxml when present; otherwise the stdlib parser with DTDs refused below
    from defusedxml import ElementTree as _ET  # type: ignore
except ImportError:   # pragma: no cover - depends on the environment
    import xml.etree.ElementTree as _ET  # noqa: N814

DEFAULT_ENDPOINT = "https://api.intacct.com/ia/xml/xmlgw.phtml"
TIMEOUT_SEC = 30
PAGE_SIZE = 1000
MAX_PAGES = 200   # 200k employees - a runaway readMore loop stops here

REQUIRED_ENV = ("INTACCT_SENDER_ID", "INTACCT_SENDER_PASSWORD", "INTACCT_USER_ID",
                "INTACCT_USER_PASSWORD", "INTACCT_COMPANY_ID")
ENTITY_ENV = "INTACCT_ENTITY_ID"

EMPLOYEE_FIELDS = ["EMPLOYEEID", "PERSONALINFO.PRINTAS", "PERSONALINFO.FIRSTNAME", "PERSONALINFO.LASTNAME",
                   "PERSONALINFO.EMAIL1", "STATUS", "LOCATIONID", "LOCATIONNAME", "WHENMODIFIED"]
# Asked for when the company exposes it; dropped (one retry) when Intacct
# rejects the field list because of it.
OPTIONAL_FIELDS = ("LOCATIONNAME",)

# Tests swap this for a fake: (url, body) -> httpx.Response.
Poster = Callable[[str, str], httpx.Response]


class IntacctError(Exception):
    """Intacct could not be read. The message is safe to show to a user."""


def _creds() -> dict:
    return {k: os.getenv(k, "").strip() for k in (*REQUIRED_ENV, ENTITY_ENV)}


def configured() -> bool:
    c = _creds()
    return all(c[k] for k in REQUIRED_ENV)


def _scrub(text: str, creds: dict) -> str:
    out = str(text or "")
    for v in creds.values():
        if v and len(v) >= 3:
            out = out.replace(v, "***")
    return " ".join(out.split())[:500]


def _allowed_endpoint(raw: str) -> str:
    u = urlparse(raw or "")
    host = (u.hostname or "").lower()
    if u.scheme != "https" or not (host == "api.intacct.com" or host.endswith(".intacct.com")):
        raise IntacctError("Intacct answered with an endpoint that is not an intacct.com address.")
    return raw


def _default_post(url: str, body: str) -> httpx.Response:
    return httpx.post(url, content=body.encode("utf-8"), timeout=TIMEOUT_SEC,
                      headers={"Content-Type": "application/xml; charset=utf-8"})


def _request(creds: dict, auth_xml: str, function_xml: str) -> str:
    return ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            "<request><control>"
            f"<senderid>{escape(creds['INTACCT_SENDER_ID'])}</senderid>"
            f"<password>{escape(creds['INTACCT_SENDER_PASSWORD'])}</password>"
            f"<controlid>nexus-{uuid.uuid4().hex[:12]}</controlid>"
            "<uniqueid>false</uniqueid><dtdversion>3.0</dtdversion><includewhitespace>false</includewhitespace>"
            "</control><operation>"
            f"<authentication>{auth_xml}</authentication>"
            f"<content><function controlid=\"f-{uuid.uuid4().hex[:8]}\">{function_xml}</function></content>"
            "</operation></request>")


def _login_xml(creds: dict) -> str:
    return ("<login>"
            f"<userid>{escape(creds['INTACCT_USER_ID'])}</userid>"
            f"<companyid>{escape(creds['INTACCT_COMPANY_ID'])}</companyid>"
            f"<password>{escape(creds['INTACCT_USER_PASSWORD'])}</password>"
            f"<locationid>{escape(creds.get(ENTITY_ENV) or '')}</locationid>"
            "</login>")


def _parse(text: str):
    # Intacct never sends a DTD; refusing one keeps entity expansion off even
    # when defusedxml is not installed.
    head = text[:4096].upper()
    if "<!DOCTYPE" in head or "<!ENTITY" in head:
        raise IntacctError("Intacct answered with an unexpected document. Nothing was read.")
    try:
        return _ET.fromstring(text)
    except Exception as e:   # noqa: BLE001 - ParseError or a defusedxml refusal
        raise IntacctError("Intacct answered with something that is not valid XML. Nothing was read.") from e


def _error_text(node, creds: dict) -> str:
    parts = []
    for err in node.iter("error"):
        for tag in ("description2", "description", "correction"):
            v = (err.findtext(tag) or "").strip()
            if v and v not in parts:
                parts.append(v)
    return _scrub(" - ".join(parts), creds) or "Intacct rejected the request"


def _call(post: Poster, url: str, creds: dict, auth_xml: str, function_xml: str):
    """POST one request; return the <result> element or raise IntacctError."""
    try:
        r = post(url, _request(creds, auth_xml, function_xml))
    except httpx.HTTPError as e:
        raise IntacctError(f"Could not reach Intacct ({type(e).__name__}). Try again in a few minutes.") from e
    if r.status_code != 200:
        raise IntacctError(f"Intacct answered HTTP {r.status_code}. Try again in a few minutes.")
    root = _parse(r.text)
    control = root.find("control")
    if control is not None and (control.findtext("status") or "").strip().lower() == "failure":
        raise IntacctError(f"Intacct: {_error_text(root, creds)}")
    op = root.find("operation")
    if op is None:
        raise IntacctError(f"Intacct: {_error_text(root, creds)}")
    auth = op.find("authentication")
    if auth is not None and (auth.findtext("status") or "").strip().lower() == "failure":
        raise IntacctError(f"Intacct sign-in failed: {_error_text(op, creds)}")
    result = op.find("result")
    if result is None:
        raise IntacctError(f"Intacct: {_error_text(op, creds)}")
    if (result.findtext("status") or "").strip().lower() != "success":
        raise IntacctError(f"Intacct: {_error_text(result, creds)}")
    return result


def _flatten(el, prefix: str = "") -> dict:
    """<EMPLOYEE><PERSONALINFO><EMAIL1>x</EMAIL1></PERSONALINFO></EMPLOYEE> and
    <PERSONALINFO.EMAIL1>x</PERSONALINFO.EMAIL1> both become
    {'PERSONALINFO.EMAIL1': 'x'}."""
    out = {}
    for child in el:
        key = f"{prefix}{child.tag.upper()}"
        if len(child):
            out.update(_flatten(child, key + "."))
        else:
            out[key] = (child.text or "").strip()
    return out


def _rows(result) -> tuple[list, str, int]:
    data = result.find("data")
    if data is None:
        return [], "", 0
    rows = [_flatten(el) for el in data]
    try:
        remaining = int(data.get("numremaining") or 0)
    except ValueError:
        remaining = 0
    return rows, (data.get("resultId") or "").strip(), remaining


def _employee(row: dict) -> dict:
    return {
        "employeeId": row.get("EMPLOYEEID", ""),
        "printAs": row.get("PERSONALINFO.PRINTAS", ""),
        "firstName": row.get("PERSONALINFO.FIRSTNAME", ""),
        "lastName": row.get("PERSONALINFO.LASTNAME", ""),
        "email": row.get("PERSONALINFO.EMAIL1", ""),
        "status": row.get("STATUS", ""),
        "locationId": row.get("LOCATIONID", ""),
        "locationName": row.get("LOCATIONNAME", "") or row.get("LOCATION.NAME", ""),
        "whenModified": row.get("WHENMODIFIED", ""),
    }


def _read_by_query(fields: list) -> str:
    return (f"<readByQuery><object>EMPLOYEE</object><fields>{escape(','.join(fields))}</fields>"
            f"<query></query><pagesize>{PAGE_SIZE}</pagesize></readByQuery>")


def fetch_employees(post: Optional[Poster] = None) -> list:
    """Every Intacct EMPLOYEE as plain dicts (employeeId, printAs, firstName,
    lastName, email, status, locationId, locationName, whenModified).
    Raises IntacctError with a user-safe message."""
    creds = _creds()
    if not all(creds[k] for k in REQUIRED_ENV):
        raise IntacctError("Intacct is not configured on this server.")
    post = post or _default_post

    session = _call(post, DEFAULT_ENDPOINT, creds, _login_xml(creds), "<getAPISession/>")
    api = session.find("data/api")
    sid = (api.findtext("sessionid") if api is not None else "") or ""
    if not sid.strip():
        raise IntacctError("Intacct did not open a session. Nothing was read.")
    url = _allowed_endpoint(((api.findtext("endpoint") or "").strip() if api is not None else "") or DEFAULT_ENDPOINT)
    creds = {**creds, "_session": sid.strip()}   # scrubbed from any error text too
    sess_xml = f"<sessionid>{escape(sid.strip())}</sessionid>"

    fields = list(EMPLOYEE_FIELDS)
    try:
        result = _call(post, url, creds, sess_xml, _read_by_query(fields))
    except IntacctError as e:
        dropped = [f for f in OPTIONAL_FIELDS if f in str(e).upper()]
        if not dropped:
            raise
        fields = [f for f in fields if f not in dropped]
        result = _call(post, url, creds, sess_xml, _read_by_query(fields))

    rows, result_id, remaining = _rows(result)
    out = [_employee(r) for r in rows]
    pages = 1
    while remaining > 0 and result_id:
        if pages >= MAX_PAGES:
            raise IntacctError("Intacct kept returning more employees than expected. Nothing was read.")
        result = _call(post, url, creds, sess_xml, f"<readMore><resultId>{escape(result_id)}</resultId></readMore>")
        rows, next_id, remaining = _rows(result)
        out.extend(_employee(r) for r in rows)
        result_id = next_id or result_id
        pages += 1
        if not rows:
            break
    return [e for e in out if e["employeeId"]]
