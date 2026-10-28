"""Nightly fetch of third-party operator reports - DESIGNED, OFF BY DEFAULT
(Operations, Oct 20 2026; docs/Third-Party-Properties.md).

Neil asked for the CubeSmart figures to arrive every night, from the cloud
(not an office PC that stops when the power does). This module is the shape of
that job; until it is switched on, the figures come in by upload.

Nothing here runs unless ALL of these are true:
  1. NEXUS_THIRD_PARTY_FETCH=on in the API's app settings (the global switch),
  2. the property has fetch_enabled = true (third_party_properties),
  3. the source's credentials are present in the environment - for CubeSmart
     CUBESMART_USERNAME and CUBESMART_PASSWORD, set as Azure app settings and
     never committed, logged or stored in the database,
  4. the source has a working `fetch` - CubeSmartSource.fetch is a stub until
     CubeSmart confirms how their reports may be read by a machine (a Qlik
     export / REST access for a service account, or a scheduled report email).

Credentials are read at call time from os.environ and nowhere else. Every
message this module prints or stores goes through `scrub`, which blanks any
credential value it carries.

The loop runs on the deployed API worker, and its blocking work (HTTP, the
database) goes through asyncio.to_thread (CLAUDE.md: never on the event loop).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable, Dict, List, Optional
import job_switch

SWITCH = "NEXUS_THIRD_PARTY_FETCH"
RUN_AT_HOUR = 3                 # 3 AM in the store's time zone: CubeSmart's nightly close is done
CHECK_EVERY_SEC = 15 * 60
OFF_SLEEP_SEC = 60 * 60


def enabled() -> bool:
    """The global switch. Off unless the app setting says exactly on/true/1."""
    return (os.environ.get(SWITCH) or "").strip().lower() in ("on", "true", "1", "yes")


class FetchError(Exception):
    """A fetch that did not produce a report. The message is scrubbed before it is shown or stored."""


class FetchNotConfigured(FetchError):
    pass


@dataclass
class FetchedReport:
    kind: str           # sre | flash | rent_roll (third_party_parse.KINDS)
    file_name: str
    raw: bytes


class ThirdPartySource(ABC):
    """One operator's reports. `fetch(property, day)` returns the report files
    for that store and day, exactly as an upload would carry them, so the
    nightly path and the upload path share the parser, the validation and the
    upsert (third_party.build_preview / save)."""
    source = ""
    username_env = ""
    password_env = ""

    def credentials(self) -> Optional[tuple]:
        """(username, password) from the environment, or None. Read at call
        time; never cached, never returned to a caller outside this module."""
        u = (os.environ.get(self.username_env) or "").strip()
        p = os.environ.get(self.password_env) or ""
        return (u, p) if u and p else None

    def configured(self) -> bool:
        return self.credentials() is not None

    def secrets(self) -> List[str]:
        c = self.credentials()
        return [x for x in (c or ()) if x]

    @abstractmethod
    def fetch(self, prop, day: date) -> List[FetchedReport]:
        ...


class CubeSmartSource(ThirdPartySource):
    """CubeSmart: SRE Summary (Qlik Sense, qsreports.cubesmart.com) and the
    Daily Flash (SmartView, smartviewweb.cubesmart.com, also Qlik inside).

    The intended order (docs/Third-Party-Properties.md):
      1. a report CubeSmart schedules to a Nexus mailbox (Qlik subscriptions /
         NPrinting / SmartView email) - no login at all, read through Graph;
      2. Qlik Sense's own export: the Engine API (JSON-RPC over a WebSocket,
         `GetObject` -> `ExportData` on the SRE table returns a temporary
         .xlsx link) or the app's REST endpoints, with a session or JWT
         CubeSmart issues for a service account - plain HTTPS, so it runs in
         the API's background loop, in a thread;
      3. only if neither is offered, a headless browser in an Azure Container
         Apps job - never on an office PC.
    Until CubeSmart confirms which one, `fetch` refuses: nothing is scraped.
    """
    source = "cubesmart"
    username_env = "CUBESMART_USERNAME"
    password_env = "CUBESMART_PASSWORD"

    def fetch(self, prop, day: date) -> List[FetchedReport]:
        if not self.configured():
            raise FetchNotConfigured(f"{self.username_env} / {self.password_env} are not set")
        raise FetchNotConfigured("CubeSmart has not confirmed a machine-readable export for this account yet; "
                                 "upload the SRE Summary and Daily Flash instead")


SOURCES: Dict[str, ThirdPartySource] = {"cubesmart": CubeSmartSource()}


def scrub(text: str, secrets: List[str]) -> str:
    """Blank every credential value (and its URL-encoded form) in a message."""
    from urllib.parse import quote
    out = str(text or "")
    for s in secrets:
        if s:
            out = out.replace(s, "***").replace(quote(s, safe=""), "***")
    return out[:500]


def run_nightly(db, day: Optional[date] = None, sources: Optional[Dict[str, ThirdPartySource]] = None,
                log: Callable[[str], None] = print) -> Dict:
    """One pass: fetch, parse, validate and upsert each fetch-enabled store.
    Blocking - call it through asyncio.to_thread. Returns what happened, per
    store; a failure is recorded as a third_party_imports row (scrubbed)."""
    import third_party
    from third_party_models import ThirdPartyImport
    if not enabled():
        return {"ran": False, "reason": "off"}
    day = day or date.today()
    sources = SOURCES if sources is None else sources
    done: Dict[str, str] = {}
    for p in third_party.properties(db):
        if not p.fetch_enabled:
            continue
        src = sources.get(p.source)
        if src is None:
            done[p.id] = "no source"
            continue
        if not src.configured():
            done[p.id] = "not configured"     # no credentials: never attempt a request
            continue
        secrets = src.secrets()
        try:
            reports = src.fetch(p, day)
            for rep in reports:
                pv = third_party.build_preview(db, rep.raw, rep.file_name, rep.kind, property_id=p.id)
                third_party.save(db, pv, by="nightly fetch", via="fetch")
            done[p.id] = f"ok ({len(reports)} reports)"
        except Exception as e:  # noqa: BLE001 - one store never stops the others; parse errors too
            db.rollback()
            msg = scrub(f"{type(e).__name__}: {e}", secrets)
            db.add(ThirdPartyImport(id=str(uuid.uuid4()), property_id=p.id, kind="", via="fetch", file_name="",
                                    rows=0, status="skipped" if isinstance(e, FetchNotConfigured) else "failed",
                                    error=msg, created_by="nightly fetch", created_at=datetime.now(timezone.utc).isoformat()))
            db.commit()
            done[p.id] = msg
            log(f"[third-party] {p.id} fetch: {msg}")
    return {"ran": True, "day": day.isoformat(), "stores": done}


def _due(last_run: Optional[str], now_local: datetime) -> bool:
    return now_local.hour >= RUN_AT_HOUR and last_run != now_local.date().isoformat()


async def third_party_fetch_loop():
    """Started from main.py on the deployed API only. Checks every 15 minutes
    and runs once a night after RUN_AT_HOUR (Central time - the Texas stores).
    Does nothing at all while the switch is off."""
    from zoneinfo import ZoneInfo
    await asyncio.sleep(300)
    last_run: Optional[str] = None
    while True:
        try:
            if not enabled():
                await asyncio.sleep(OFF_SLEEP_SEC)
                continue
            now_local = datetime.now(ZoneInfo("America/Chicago"))
            if _due(last_run, now_local):
                last_run = now_local.date().isoformat()

                def go():
                    if job_switch.off("third_party_fetch"):   # Workflows > Automations switch
                        return {"ran": False, "reason": "off"}
                    from database import SessionLocal
                    db = SessionLocal()
                    try:
                        return run_nightly(db, now_local.date())
                    finally:
                        db.close()
                result = await asyncio.to_thread(go)
                print(f"[third-party] nightly fetch: {len(result.get('stores') or {})} stores")
        except Exception as e:  # noqa: BLE001
            print(f"[third-party] loop error: {type(e).__name__}")   # type only: a message could carry a URL
        await asyncio.sleep(CHECK_EVERY_SEC)
