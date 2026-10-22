"""A small Sage Intacct Web Services client (Oct 21 2026). Reads only, but
for the switched-off-by-default AMA writes at the end (CR-13, Oct 23): the
edit of an original entry (update_gl_batch, the default) and the older new
reclass entry (create_gl_batch, only with AMA_RECLASS_MODE=new_entry).

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
import re
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


# ── One write: a GL journal entry (AMA reclass, CR-13, Oct 23 2026) ─────────
# The only thing Nexus ever writes to Intacct, and only when the AMA push
# switch is on (accounting_assumptions.AMA_PUSH_TO_INTACCT). A NEW entry is
# created - an existing one is never edited. `batch` = {journal, date (ISO),
# description, reference_no, state, lines: [{acct_no, location_id, dept_id,
# memo, debit, credit, vendor_id, customer_id}]}.

def _amount(v) -> str:
    return f"{float(v or 0):.2f}"


def _glentry_xml(line: dict) -> str:
    debit, credit = float(line.get("debit") or 0), float(line.get("credit") or 0)
    tr_type, amount = ("1", debit) if debit else ("-1", credit)
    parts = [f"<ACCOUNTNO>{escape(str(line.get('acct_no') or ''))}</ACCOUNTNO>"]
    for tag, key in (("DEPARTMENT", "dept_id"), ("LOCATION", "location_id")):
        if line.get(key):
            parts.append(f"<{tag}>{escape(str(line[key]))}</{tag}>")
    parts.append(f"<TR_TYPE>{tr_type}</TR_TYPE><TRX_AMOUNT>{_amount(amount)}</TRX_AMOUNT>")
    if line.get("memo"):
        parts.append(f"<DESCRIPTION>{escape(str(line['memo'])[:1000])}</DESCRIPTION>")
    for tag, key in (("VENDORID", "vendor_id"), ("CUSTOMERID", "customer_id")):
        if line.get(key):
            parts.append(f"<{tag}>{escape(str(line[key]))}</{tag}>")
    return "<GLENTRY>" + "".join(parts) + "</GLENTRY>"


def glbatch_xml(batch: dict) -> str:
    """The <create><GLBATCH> function for one journal entry (pure)."""
    day = (batch.get("date") or "")[:10]
    us = f"{day[5:7]}/{day[8:10]}/{day[0:4]}" if len(day) == 10 else ""
    head = (f"<JOURNAL>{escape(batch.get('journal') or '')}</JOURNAL>"
            f"<BATCH_DATE>{escape(us)}</BATCH_DATE>"
            f"<BATCH_TITLE>{escape((batch.get('description') or '')[:80])}</BATCH_TITLE>")
    if batch.get("reference_no"):
        head += f"<REFERENCENO>{escape(str(batch['reference_no'])[:20])}</REFERENCENO>"
    if batch.get("state"):
        head += f"<STATE>{escape(batch['state'])}</STATE>"
    lines = "".join(_glentry_xml(ln) for ln in batch.get("lines") or [])
    return f"<create><GLBATCH>{head}<ENTRIES>{lines}</ENTRIES></GLBATCH></create>"


def create_gl_batch(batch: dict, post: Optional[Poster] = None) -> str:
    """Create one journal entry in Intacct; returns its RECORDNO. Raises
    IntacctError with a user-safe message."""
    creds = _creds()
    if not all(creds[k] for k in REQUIRED_ENV):
        raise IntacctError("Intacct is not configured on this server.")
    if len(batch.get("lines") or []) < 2:
        raise IntacctError("A journal entry needs at least two lines. Nothing was posted.")
    post = post or _default_post
    session = _call(post, DEFAULT_ENDPOINT, creds, _login_xml(creds), "<getAPISession/>")
    api = session.find("data/api")
    sid = (api.findtext("sessionid") if api is not None else "") or ""
    if not sid.strip():
        raise IntacctError("Intacct did not open a session. Nothing was posted.")
    url = _allowed_endpoint(((api.findtext("endpoint") or "").strip() if api is not None else "") or DEFAULT_ENDPOINT)
    creds = {**creds, "_session": sid.strip()}   # scrubbed from any error text too
    result = _call(post, url, creds, f"<sessionid>{escape(sid.strip())}</sessionid>", glbatch_xml(batch))
    data = result.find("data")
    if data is not None:
        for el in data.iter():
            if el.tag.upper() == "RECORDNO" and (el.text or "").strip():
                return el.text.strip()
    return ""


# ── Editing an existing entry (AMA, CR-13 rework, Oct 23 2026) ──────────────
# Neil (23 Oct): "The push should edit the original and the change should be
# visible on the other end. CAREFUL TO GET THIS RIGHT, WE DONT WANT TO SCREW
# UP INTACCT DATA." So an existing GLBATCH is read IN FULL, every line is sent
# back exactly as read but for the account (and the vendor / customer) of the
# AMA line(s), and the entry is read again afterwards to confirm. Anything on
# the entry this code does not know how to carry back (a custom field, a
# foreign currency, a reconciled line) is a refusal - never a silent drop.
# Intacct's GLBATCH update replaces ALL the entry's lines with the ones sent,
# which is why nothing may be left out.

# Header fields sent back on the update, as read.
BATCH_CARRY = ("JOURNAL", "BATCH_DATE", "REVERSEDATE", "BATCH_TITLE", "REFERENCENO", "SUPDOCID", "TAXIMPLICATIONS")
# Line fields sent back on the update, as read (the account, vendor and
# customer of the line being reclassed are the only ones that change).
ENTRY_CARRY = ("DOCUMENT", "ACCOUNTNO", "CURRENCY", "TRX_AMOUNT", "TR_TYPE", "DESCRIPTION", "ALLOCATION", "DEPARTMENT", "LOCATION",
               "PROJECTID", "CUSTOMERID", "VENDORID", "EMPLOYEEID", "ITEMID", "CLASSID", "CONTRACTID", "WAREHOUSEID", "BILLABLE",
               "EXCH_RATE_DATE", "EXCH_RATE_TYPE_ID", "EXCHANGE_RATE")
# Fields Intacct answers with that are computed or read-only - safe to leave
# off an update (Intacct fills them again). Anything else that comes back
# non-empty and is not carried makes the entry uneditable from Nexus.
_READ_ONLY = {
    "RECORDNO", "BATCHNO", "BATCH_NUMBER", "LINE_NO", "ENTRY_DATE", "STATE", "MODULE", "AMOUNT", "BASECURR",
    "CREATEDBY", "MODIFIEDBY", "USERID", "CLEARED", "CLRDATE", "RECON_DATE", "RECONDATE", "TIMEPERIOD", "BOOKID", "ADJ",
    "STATISTICAL", "JOURNAL", "BATCH_DATE", "BATCH_TITLE", "ACCOUNTTYPE", "NORMALBALANCE", "TRX_DEBITAMOUNT", "TRX_CREDITAMOUNT",
    "DEBITAMOUNT", "CREDITAMOUNT", "PARENTENTRY", "TOTAL", "HISTORY_COMMENT", "BILLED", "ISBILLED", "STATUS", "DOCNUMBER",
}
_READ_ONLY_ENDINGS = ("NAME", "TITLE", "KEY", "DIMKEY", "_URL", "_NO")
_READ_ONLY_STARTS = ("MEGAENTITY", "WHEN", "CREATEDBY", "MODIFIEDBY", "BASE")
_NUM = re.compile(r"^\d{1,20}$")


def _uncarried(row: dict, carried: tuple) -> list:
    """The fields of one read row that are set but neither carried nor known
    to be read-only - the reasons an entry cannot be edited from Nexus."""
    out = []
    for k, v in row.items():
        name = k.split(".")[-1].upper()
        if not str(v or "").strip() or name in carried or name in _READ_ONLY:
            continue
        if name.endswith(_READ_ONLY_ENDINGS) or name.startswith(_READ_ONLY_STARTS):
            continue
        out.append(k)
    return sorted(out)


def _open(post: Optional[Poster], verb: str):
    creds = _creds()
    if not all(creds[k] for k in REQUIRED_ENV):
        raise IntacctError("Intacct is not configured on this server.")
    post = post or _default_post
    session = _call(post, DEFAULT_ENDPOINT, creds, _login_xml(creds), "<getAPISession/>")
    api = session.find("data/api")
    sid = (api.findtext("sessionid") if api is not None else "") or ""
    if not sid.strip():
        raise IntacctError(f"Intacct did not open a session. Nothing was {verb}.")
    url = _allowed_endpoint(((api.findtext("endpoint") or "").strip() if api is not None else "") or DEFAULT_ENDPOINT)
    creds = {**creds, "_session": sid.strip()}   # scrubbed from any error text too
    return post, url, creds, f"<sessionid>{escape(sid.strip())}</sessionid>"


def _query_all(conn, obj: str, query: str, fields: str = "*", max_pages: int = 20) -> list:
    post, url, creds, sess = conn
    result = _call(post, url, creds, sess, f"<readByQuery><object>{obj}</object><fields>{escape(fields)}</fields>"
                                           f"<query>{escape(query)}</query><pagesize>{PAGE_SIZE}</pagesize></readByQuery>")
    rows, result_id, remaining = _rows(result)
    pages = 1
    while remaining > 0 and result_id:
        if pages >= max_pages:
            raise IntacctError(f"Intacct kept returning more {obj} rows than expected. Nothing was changed.")
        result = _call(post, url, creds, sess, f"<readMore><resultId>{escape(result_id)}</resultId></readMore>")
        more, next_id, remaining = _rows(result)
        rows.extend(more)
        result_id = next_id or result_id
        pages += 1
        if not more:
            break
    return rows


def _iso_us(v: str) -> str:
    """Intacct's MM/DD/YYYY as YYYY-MM-DD (an ISO date passes through)."""
    s = (v or "").strip()
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else s[:10]


def _gl_line(row: dict) -> dict:
    tr = str(row.get("TR_TYPE") or "").strip()
    try:
        amount = round(abs(float(row.get("TRX_AMOUNT") or row.get("AMOUNT") or 0)), 2)
    except ValueError:
        amount = 0.0
    return {
        "recordNo": row.get("RECORDNO", ""), "lineNo": row.get("LINE_NO", ""), "accountNo": row.get("ACCOUNTNO", ""),
        "accountTitle": row.get("ACCOUNTTITLE", ""), "trType": -1 if tr == "-1" else 1, "amount": amount,
        "location": row.get("LOCATION", ""), "department": row.get("DEPARTMENT", ""), "memo": row.get("DESCRIPTION", ""),
        "vendorId": row.get("VENDORID", ""), "customerId": row.get("CUSTOMERID", ""),
        "currency": row.get("CURRENCY", ""), "baseCurrency": row.get("BASECURR", ""), "cleared": row.get("CLEARED", ""),
        "carry": {k: row[k] for k in ENTRY_CARRY if str(row.get(k) or "").strip()},
        "uncarried": _uncarried(row, ENTRY_CARRY),
    }


def _line_sort(ln: dict):
    try:
        return (0, int(ln.get("lineNo") or 0), str(ln.get("recordNo")))
    except ValueError:
        return (1, 0, str(ln.get("recordNo")))


def _read_batch(conn, batch_key: str) -> dict:
    heads = _query_all(conn, "GLBATCH", f"RECORDNO = '{batch_key}'")
    if len(heads) != 1:
        raise IntacctError(f"Intacct has no single journal entry with record number {batch_key}. Nothing was changed.")
    head = heads[0]
    lines = sorted((_gl_line(r) for r in _query_all(conn, "GLENTRY", f"BATCHNO = '{batch_key}'")), key=_line_sort)
    carry = {k: head[k] for k in BATCH_CARRY if str(head.get(k) or "").strip()}
    return {
        "recordNo": head.get("RECORDNO", "") or batch_key, "batchNo": head.get("BATCHNO", "") or head.get("BATCH_NUMBER", ""),
        "journal": head.get("JOURNAL", ""), "date": _iso_us(head.get("BATCH_DATE", "")), "title": head.get("BATCH_TITLE", ""),
        "state": head.get("STATE", ""), "module": head.get("MODULE", ""), "whenModified": head.get("WHENMODIFIED", ""),
        "modifiedBy": head.get("MODIFIEDBY", ""), "carry": carry,
        "uncarried": _uncarried(head, BATCH_CARRY), "lines": lines, "source": "intacct",
    }


def read_gl_batch_of_line(glentry_record: str, post: Optional[Poster] = None) -> dict:
    """The whole journal entry (header and EVERY line, as read) that the
    GLENTRY with this RECORDNO belongs to. Reads only."""
    rec = str(glentry_record or "").strip()
    if not _NUM.match(rec):
        raise IntacctError("The line has no Intacct record number. Nothing was read.")
    conn = _open(post, "read")
    found = _query_all(conn, "GLENTRY", f"RECORDNO = '{rec}'", "RECORDNO,BATCHNO")
    if len(found) != 1 or not _NUM.match(str(found[0].get("BATCHNO") or "")):
        raise IntacctError(f"Intacct has no journal line with record number {rec}. Nothing was read.")
    batch = _read_batch(conn, found[0]["BATCHNO"])
    if not any(ln["recordNo"] == rec for ln in batch["lines"]):
        raise IntacctError(f"Intacct's entry {batch['recordNo']} does not hold line {rec}. Nothing was read.")
    return batch


def reread_gl_batch(batch_key: str, post: Optional[Poster] = None) -> dict:
    """The entry read again by its own RECORDNO (after an update)."""
    if not _NUM.match(str(batch_key or "")):
        raise IntacctError("The entry has no Intacct record number. Nothing was read.")
    return _read_batch(_open(post, "read"), str(batch_key))


def _carry_xml(fields: dict, order: tuple) -> str:
    out = []
    for k in order:
        v = fields.get(k)
        if v is None or not str(v).strip():
            continue
        if k == "TRX_AMOUNT":
            v = _amount(v)
        out.append(f"<{k}>{escape(str(v))}</{k}>")
    return "".join(out)


def glbatch_update_xml(update: dict) -> str:
    """The <update><GLBATCH> function (pure). `update` = {recordNo, header:
    {carried header fields as read}, state, historyComment, lines: [{carried
    line fields}]} - built by ama_review.edit_update and shown to the
    bookkeeper as the preview before it is ever sent."""
    head = f"<RECORDNO>{escape(str(update['recordNo']))}</RECORDNO>" + _carry_xml(update.get("header") or {}, BATCH_CARRY)
    if update.get("state"):
        head += f"<STATE>{escape(update['state'])}</STATE>"
    if update.get("historyComment"):
        head += f"<HISTORY_COMMENT>{escape(update['historyComment'][:1000])}</HISTORY_COMMENT>"
    lines = "".join("<GLENTRY>" + _carry_xml(ln, ENTRY_CARRY) + "</GLENTRY>" for ln in update.get("lines") or [])
    return f"<update><GLBATCH>{head}<ENTRIES>{lines}</ENTRIES></GLBATCH></update>"


def update_gl_batch(update: dict, post: Optional[Poster] = None) -> str:
    """Send one GLBATCH update (the original entry, edited) and return what
    Intacct answered (its RECORDNO, else 'success'). Raises IntacctError with
    a user-safe message. Callers re-read the entry afterwards to confirm."""
    if not _NUM.match(str(update.get("recordNo") or "")):
        raise IntacctError("The entry has no Intacct record number. Nothing was changed.")
    if len(update.get("lines") or []) < 2:
        raise IntacctError("A journal entry needs at least two lines. Nothing was changed.")
    post_, url, creds, sess = _open(post, "changed")
    result = _call(post_, url, creds, sess, glbatch_update_xml(update))
    data = result.find("data")
    if data is not None:
        for el in data.iter():
            if el.tag.upper() == "RECORDNO" and (el.text or "").strip():
                return el.text.strip()
    return "success"


# ── Who keyed an entry (CR-10, Oct 23) ───────────────────────────────────────
# Reports > Audit & Insights > Manual Journal Entries. Neither the Nexus
# Accounting ledger copy nor its sync keeps who created an entry, so the
# journal entry headers (GLBATCH) are read here, READ ONLY, for a date range:
# every field ("*"), so CREATEDBY, MODIFIEDBY, WHENCREATED, WHENMODIFIED and
# whatever source / rule fields the company exposes come back. Intacct
# answers CREATEDBY / MODIFIEDBY as a user's record number; USERINFO turns
# those into login IDs ("vinod.bhole", "system"). Lines (GLENTRY) are read
# only for the entries a caller keeps, for their amount and entities.
_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SYMBOL = re.compile(r"^[A-Za-z0-9_-]{1,20}$")
AUDIT_MAX_PAGES = 100      # 100,000 entry headers in one range at most
_LINE_CHUNK = 100          # BATCHNO IN (...) values per GLENTRY read


def _us_day(iso: str) -> str:
    if not _ISO_DAY.match(iso or ""):
        raise IntacctError("Pick a from and a to date. Nothing was read.")
    return f"{iso[5:7]}/{iso[8:10]}/{iso[0:4]}"


def _audit_head(row: dict) -> dict:
    """A GLBATCH row as the audit read keeps it; `sourceFields` = every
    header field whose name speaks of a source or a rule (as read)."""
    return {
        "recordNo": row.get("RECORDNO", ""), "batchNo": row.get("BATCHNO", "") or row.get("BATCH_NUMBER", ""),
        "journal": row.get("JOURNAL", ""), "date": _iso_us(row.get("BATCH_DATE", "")), "title": row.get("BATCH_TITLE", ""),
        "state": row.get("STATE", ""), "module": row.get("MODULE", ""),
        "createdBy": row.get("CREATEDBY", ""), "modifiedBy": row.get("MODIFIEDBY", ""),
        "whenCreated": row.get("WHENCREATED", ""), "whenModified": row.get("WHENMODIFIED", ""),
        "sourceFields": {k: v for k, v in row.items() if ("SOURCE" in k or "RULE" in k) and str(v or "").strip()},
    }


def _quoted(values) -> str:
    return ",".join(f"'{v}'" for v in values)


def read_entry_audit(from_iso: str, to_iso: str, journals=None, keep=None, post: Optional[Poster] = None) -> dict:
    """{entries, users}: the journal entry headers dated from..to (optionally
    of some journals) with who created and last changed each one, as login
    IDs; for the entries `keep(entry)` accepts (all when None), `amount` (the
    debits) and `locations` (the entities of its lines). Reads only."""
    syms = [str(s).strip().upper() for s in (journals or []) if str(s or "").strip()]
    if any(not _SYMBOL.match(s) for s in syms):
        raise IntacctError("A journal symbol is letters and numbers only. Nothing was read.")
    query = f"BATCH_DATE >= '{_us_day(from_iso)}' AND BATCH_DATE <= '{_us_day(to_iso)}'"
    if syms:
        query += f" AND JOURNAL IN ({_quoted(syms)})"
    conn = _open(post, "read")
    heads = [_audit_head(r) for r in _query_all(conn, "GLBATCH", query, max_pages=AUDIT_MAX_PAGES)]
    users = {}
    for u in _query_all(conn, "USERINFO", "", "RECORDNO,LOGINID,DESCRIPTION", max_pages=AUDIT_MAX_PAGES):
        login = str(u.get("LOGINID") or "").strip()
        if login:
            users[str(u.get("RECORDNO") or "").strip()] = login
    for h in heads:
        for k in ("createdBy", "modifiedBy"):
            v = str(h[k] or "").strip()
            h[k] = users.get(v, v)
    kept = [h for h in heads if keep is None or keep(h)]
    keys = [str(h["recordNo"]) for h in kept if _NUM.match(str(h["recordNo"] or ""))]
    totals: dict = {}
    for i in range(0, len(keys), _LINE_CHUNK):
        chunk = keys[i:i + _LINE_CHUNK]
        for ln in _query_all(conn, "GLENTRY", f"BATCHNO IN ({_quoted(chunk)})", "BATCHNO,TR_TYPE,AMOUNT,TRX_AMOUNT,LOCATION", max_pages=AUDIT_MAX_PAGES):
            t = totals.setdefault(str(ln.get("BATCHNO") or ""), {"amount": 0.0, "locations": set()})
            if str(ln.get("TR_TYPE") or "").strip() != "-1":
                try:
                    t["amount"] += abs(float(ln.get("AMOUNT") or ln.get("TRX_AMOUNT") or 0))
                except ValueError:
                    pass
            if str(ln.get("LOCATION") or "").strip():
                t["locations"].add(str(ln["LOCATION"]).strip())
    for h in kept:
        t = totals.get(str(h["recordNo"]), {"amount": 0.0, "locations": set()})
        h["amount"] = round(t["amount"], 2)
        h["locations"] = sorted(t["locations"])
    return {"entries": kept, "users": users}
