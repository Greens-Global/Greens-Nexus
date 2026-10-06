"""Google Business Profile HTTP client (Marketing, Oct 2026).

The thin layer between Nexus and Google: OAuth (one dedicated Google account
connected once - Google offers no API key for Business Profile), the accounts
and locations lists, reviews, replies and listing edits. Nothing here touches
the database; gbp.py owns that. Every call is synchronous (httpx) - callers on
the event loop go through asyncio.to_thread (CLAUDE.md).

Endpoints, per Google's documentation:
  OAuth          accounts.google.com/o/oauth2/v2/auth, oauth2.googleapis.com/token
  Accounts       mybusinessaccountmanagement.googleapis.com/v1/accounts
  Locations      mybusinessbusinessinformation.googleapis.com/v1/{account}/locations
  Listing edit   PATCH mybusinessbusinessinformation.googleapis.com/v1/{location}?updateMask=
  Reviews        mybusiness.googleapis.com/v4/{account}/{location}/reviews
  Reply          PUT / DELETE mybusiness.googleapis.com/v4/{review}/reply
  Performance    businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries
  Keywords       businessprofileperformance.googleapis.com/v1/{location}/searchkeywords/impressions/monthly
  Photos         mybusiness.googleapis.com/v4/{account}/{location}/media (+ media:startUpload, upload/v1/media)
  Posts          mybusiness.googleapis.com/v4/{account}/{location}/localPosts

Until Google approves the project's Business Profile API access, every data
call answers 403 / quota 0 - gbp.py turns that into a readable status rather
than an error page.
"""
from __future__ import annotations

import os
import time
import urllib.parse

import httpx

SCOPES = "https://www.googleapis.com/auth/business.manage openid email"
_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN = "https://oauth2.googleapis.com/token"
_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
_ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts"
_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1"
_V4 = "https://mybusiness.googleapis.com/v4"
_UPLOAD = "https://mybusiness.googleapis.com/upload/v1/media"
_PERF = "https://businessprofileperformance.googleapis.com/v1"
# Mobile + desktop impressions are added together into Maps / Search views.
DAILY_METRICS = ("BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
                 "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
                 "WEBSITE_CLICKS", "CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS")
# What the listing form reads and may edit.
READ_MASK = ("name,title,storefrontAddress,phoneNumbers,websiteUri,regularHours,specialHours,"
             "profile,metadata,categories")
EDITABLE = ("profile.description", "regularHours", "specialHours", "phoneNumbers.primaryPhone", "websiteUri")
_TIMEOUT = 20


class GbpError(Exception):
    """`transport` is True when Google was never heard from (timeout, DNS,
    dropped connection) - the request may or may not have landed, so a write
    that fails this way must be checked against Google before it is called a
    failure (gbp.reply / gbp.delete_reply)."""
    def __init__(self, message: str, status: int = 0, transport: bool = False):
        super().__init__(message)
        self.status = status
        self.transport = transport


# The message for a refresh token Google no longer honors (revoked, the
# account's password changed, the grant expired). gbp.status() looks for it.
RECONNECT = "The Google connection has expired or was revoked - an administrator needs to reconnect it."


def client_id() -> str:
    return os.getenv("GBP_OAUTH_CLIENT_ID", "").strip()


def client_secret() -> str:
    return os.getenv("GBP_OAUTH_CLIENT_SECRET", "").strip()


def redirect_uri() -> str:
    from app_url import public_base
    base = public_base()
    return f"{base}/marketing/gbp/oauth/callback" if base else ""


def not_configured_reason() -> str:
    if not client_id() or not client_secret():
        return ("The Google connection is not set up on this server yet (GBP_OAUTH_CLIENT_ID / "
                "GBP_OAUTH_CLIENT_SECRET from the Google Cloud project).")
    if not redirect_uri():
        return "This environment has no public URL for Google to send you back to - connect from the deployed site."
    return ""


def authorize_url(state: str) -> str:
    # access_type=offline + prompt=consent: Google only hands out a refresh
    # token on a consented offline grant, and without one the connection would
    # die with the first access token an hour later.
    return f"{_AUTH}?" + urllib.parse.urlencode({
        "client_id": client_id(), "redirect_uri": redirect_uri(), "response_type": "code",
        "scope": SCOPES, "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
        "state": state,
    })


def _send(method: str, url: str, **kw) -> dict:
    """Every call to Google goes through here, so a network failure is a
    GbpError like any other refusal - never a bare httpx exception that the
    routes would turn into a 500."""
    try:
        r = httpx.request(method, url, timeout=_TIMEOUT, **kw)
    except httpx.HTTPError as e:
        raise GbpError(f"Could not reach Google ({type(e).__name__}) - try again in a minute.", 503, transport=True)
    return _check(r)


def _check(r: httpx.Response) -> dict:
    if r.status_code >= 400:
        try:
            body = r.json()
            err = body.get("error") or {}
            # API errors are {"error": {"message": ...}}; the token endpoint
            # answers {"error": "invalid_grant", "error_description": ...}.
            msg = (err.get("message") if isinstance(err, dict)
                   else " - ".join(x for x in (str(err), body.get("error_description") or "") if x)) or r.text
        except (ValueError, AttributeError):
            msg = r.text
        raise GbpError(f"Google said: {(msg or '').strip()[:300]}", r.status_code)
    if not r.content:
        return {}
    try:
        return r.json()
    except ValueError:
        raise GbpError("Google sent an answer Nexus could not read - try again in a minute.", 502)


def exchange_code(code: str, redirect: str = "") -> dict:
    """{refresh_token, access_token, expires_in, scope}. `redirect` is the
    callback the grant was started with (Google Ads has its own)."""
    return _send("POST", _TOKEN, data={"code": code, "client_id": client_id(), "client_secret": client_secret(),
                                       "redirect_uri": redirect or redirect_uri(), "grant_type": "authorization_code"})


def account_email(access_token: str) -> str:
    return (_send("GET", _USERINFO, headers=_auth(access_token)).get("email") or "").lower()


# One access token per refresh token, reused until a minute before it expires.
_tokens: dict = {}


def access_token(refresh_token: str) -> str:
    hit = _tokens.get(refresh_token)
    if hit and hit[1] - 60 > time.time():
        return hit[0]
    try:
        data = _send("POST", _TOKEN, data={"refresh_token": refresh_token, "client_id": client_id(),
                                           "client_secret": client_secret(), "grant_type": "refresh_token"})
    except GbpError as e:
        # A dead refresh token comes back 400 invalid_grant (not 401) - name
        # it, so the screens can ask for a reconnect instead of showing Google's code.
        if "invalid_grant" in str(e) or e.status == 401:
            raise GbpError(RECONNECT, 401)
        raise
    tok = data.get("access_token") or ""
    if not tok:
        raise GbpError(RECONNECT, 401)
    _tokens[refresh_token] = (tok, time.time() + int(data.get("expires_in") or 3600))
    return tok


def forget(refresh_token: str) -> None:
    _tokens.pop(refresh_token, None)


def revoke(refresh_token: str) -> None:
    """Best effort: a failed revoke must not keep a disconnect from happening."""
    try:
        httpx.post("https://oauth2.googleapis.com/revoke", data={"token": refresh_token}, timeout=_TIMEOUT)
    except httpx.HTTPError:
        pass
    forget(refresh_token)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _paged(url: str, token: str, key: str, params: dict) -> list:
    out, page = [], ""
    for _ in range(100):   # a hard stop - no listing has 100 pages
        q = {**params, **({"pageToken": page} if page else {})}
        data = _send("GET", url, params=q, headers=_auth(token))
        out += data.get(key) or []
        page = data.get("nextPageToken") or ""
        if not page:
            break
    return out


def list_accounts(token: str) -> list:
    return _paged(_ACCOUNTS, token, "accounts", {})


def list_locations(token: str, account: str) -> list:
    return _paged(f"{_INFO}/{account}/locations", token, "locations", {"readMask": READ_MASK, "pageSize": 100})


def get_location(token: str, location: str) -> dict:
    return _send("GET", f"{_INFO}/{location}", params={"readMask": READ_MASK}, headers=_auth(token))


def update_location(token: str, location: str, patch: dict, mask: list) -> dict:
    return _send("PATCH", f"{_INFO}/{location}", params={"updateMask": ",".join(mask)}, json=patch,
                 headers=_auth(token))


def list_reviews(token: str, account: str, location: str) -> list:
    """Every review, newest first. The v4 API names a location under its
    account: accounts/A/locations/L."""
    return _paged(f"{_V4}/{account}/{location}/reviews", token, "reviews", {"pageSize": 50, "orderBy": "updateTime desc"})


def put_reply(token: str, review_name: str, comment: str) -> dict:
    """Creates the reply, or replaces it - Google has one reply per review."""
    return _send("PUT", f"{_V4}/{review_name}/reply", json={"comment": comment}, headers=_auth(token))


def delete_reply(token: str, review_name: str) -> None:
    _send("DELETE", f"{_V4}/{review_name}/reply", headers=_auth(token))


def get_review(token: str, review_name: str) -> dict:
    """One review as Google has it now - used to settle a write whose answer
    never arrived."""
    return _send("GET", f"{_V4}/{review_name}", headers=_auth(token))


# ── Performance ────────────────────────────────────────────────────────────────

def daily_metrics(token: str, location: str, start, end) -> dict:
    """{metric: [(date, value)]} for one location, start..end inclusive
    (datetime.date). Days Google has no figure for are simply absent."""
    params = [("dailyMetrics", m) for m in DAILY_METRICS] + [
        ("dailyRange.startDate.year", start.year), ("dailyRange.startDate.month", start.month),
        ("dailyRange.startDate.day", start.day), ("dailyRange.endDate.year", end.year),
        ("dailyRange.endDate.month", end.month), ("dailyRange.endDate.day", end.day)]
    data = _send("GET", f"{_PERF}/{location}:fetchMultiDailyMetricsTimeSeries", params=params, headers=_auth(token))
    out: dict = {}
    for series in data.get("multiDailyMetricTimeSeries") or []:
        for row in series.get("dailyMetricTimeSeries") or []:
            metric = row.get("dailyMetric") or ""
            for dv in (row.get("timeSeries") or {}).get("datedValues") or []:
                d = dv.get("date") or {}
                if not d.get("year"):
                    continue
                out.setdefault(metric, []).append(
                    (f"{d['year']:04d}-{d.get('month', 1):02d}-{d.get('day', 1):02d}", int(dv.get("value") or 0)))
    return out


def search_keywords(token: str, location: str, year: int, month: int) -> list:
    """[(keyword, impressions, below_threshold)] for one month. Google gives
    a floor ("threshold") instead of a count for rare terms."""
    rows = _paged(f"{_PERF}/{location}/searchkeywords/impressions/monthly", token, "searchKeywordsCounts", {
        "monthlyRange.startMonth.year": year, "monthlyRange.startMonth.month": month,
        "monthlyRange.endMonth.year": year, "monthlyRange.endMonth.month": month, "pageSize": 100})
    out = []
    for r in rows:
        v = r.get("insightsValue") or {}
        if "value" in v:
            out.append((r.get("searchKeyword") or "", int(v.get("value") or 0), False))
        else:
            out.append((r.get("searchKeyword") or "", int(v.get("threshold") or 0), True))
    return [x for x in out if x[0]]


# ── Photos ────────────────────────────────────────────────────────────────────

def list_media(token: str, account: str, location: str) -> list:
    return _paged(f"{_V4}/{account}/{location}/media", token, "mediaItems", {"pageSize": 100})


def upload_photo(token: str, account: str, location: str, data: bytes, content_type: str, category: str) -> dict:
    """Bytes straight to Google (startUpload -> upload -> create), so a photo
    never needs a public URL of ours."""
    ref = _send("POST", f"{_V4}/{account}/{location}/media:startUpload", headers=_auth(token))
    resource = ref.get("resourceName") or ""
    if not resource:
        raise GbpError("Google did not open an upload for the photo - try again.", 502)
    _send("POST", f"{_UPLOAD}/{resource}", params={"upload_type": "media"}, content=data,
          headers={**_auth(token), "Content-Type": content_type})
    return _send("POST", f"{_V4}/{account}/{location}/media", headers=_auth(token), json={
        "mediaFormat": "PHOTO", "locationAssociation": {"category": category}, "dataRef": {"resourceName": resource}})


def delete_media(token: str, media_name: str) -> None:
    _send("DELETE", f"{_V4}/{media_name}", headers=_auth(token))


# ── Posts ─────────────────────────────────────────────────────────────────────

def list_posts(token: str, account: str, location: str) -> list:
    return _paged(f"{_V4}/{account}/{location}/localPosts", token, "localPosts", {"pageSize": 100})


def create_post(token: str, account: str, location: str, body: dict) -> dict:
    return _send("POST", f"{_V4}/{account}/{location}/localPosts", headers=_auth(token), json=body)


def update_post(token: str, post_name: str, body: dict, mask: list) -> dict:
    return _send("PATCH", f"{_V4}/{post_name}", params={"updateMask": ",".join(mask)}, json=body, headers=_auth(token))


def delete_post(token: str, post_name: str) -> None:
    _send("DELETE", f"{_V4}/{post_name}", headers=_auth(token))
