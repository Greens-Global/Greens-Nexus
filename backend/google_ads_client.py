"""Google Ads API HTTP client (Marketing, Oct 2026). Read-only.

Same shape as gbp_client.py, and it shares that module's Google OAuth
plumbing (the same OAuth client, refresh-token handling and GbpError): only
the scope, the callback and the API calls differ. Nothing here touches the
database; google_ads.py owns that. Every call is synchronous (httpx) -
callers on the event loop go through asyncio.to_thread (CLAUDE.md).

Access (Google's policy since Sep 9, 2026): there is no developer token any
more - the access level belongs to the Google Cloud project that owns the
OAuth client. A new project has Test access (test accounts only); Explorer
access (2,880 operations a day, production accounts, read-only reporting is
fine) is applied for on the project's Google Ads API page. This module
makes a handful of calls per account per sync - far inside that.

On top of the OAuth token, a call through a manager account carries
`login-customer-id` (the manager it goes through).

Endpoints, per Google's documentation (REST):
  Accounts   GET  googleads.googleapis.com/{v}/customers:listAccessibleCustomers
  Reports    POST googleads.googleapis.com/{v}/customers/{id}/googleAds:searchStream  (GAQL)

The API version moves roughly every quarter and each lives about a year -
GOOGLE_ADS_API_VERSION overrides the default when Google retires it.
"""
from __future__ import annotations

import os
import urllib.parse

import httpx

import gbp_client
from gbp_client import GbpError

SCOPES = "https://www.googleapis.com/auth/adwords openid email"
_TIMEOUT = 60   # a year of daily keyword rows is one streamed answer
DEFAULT_VERSION = "v25"   # released Jul 2026; each version lives about a year


def login_customer_override() -> str:
    """Optional: the manager account to go through, when the connected
    Google account can see several (GOOGLE_ADS_LOGIN_CUSTOMER_ID, digits)."""
    return clean_id(os.getenv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", ""))


def _base() -> str:
    v = (os.getenv("GOOGLE_ADS_API_VERSION", "") or DEFAULT_VERSION).strip()
    return f"https://googleads.googleapis.com/{v}"


def clean_id(cid) -> str:
    """123-456-7890, customers/1234567890 or 1234567890 -> 1234567890."""
    s = str(cid or "").replace("customers/", "").replace("-", "").strip()
    return s if s.isdigit() else ""


def redirect_uri() -> str:
    from app_url import public_base
    base = public_base()
    return f"{base}/marketing/ads/oauth/callback" if base else ""


def not_configured_reason() -> str:
    if not gbp_client.client_id() or not gbp_client.client_secret():
        return ("The Google connection is not set up on this server yet (GBP_OAUTH_CLIENT_ID / "
                "GBP_OAUTH_CLIENT_SECRET from the Google Cloud project).")
    if not redirect_uri():
        return "This environment has no public URL for Google to send you back to - connect from the deployed site."
    return ""


def authorize_url(state: str) -> str:
    # Offline + consent for a refresh token, as gbp_client.authorize_url.
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": gbp_client.client_id(), "redirect_uri": redirect_uri(), "response_type": "code",
        "scope": SCOPES, "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
        "state": state,
    })


def _headers(token: str, login_customer: str = "") -> dict:
    h = {"Authorization": f"Bearer {token}"}
    if login_customer:
        h["login-customer-id"] = login_customer
    return h


# Google Ads explains a refusal in error.details[].errors[]; the top-level
# message is often just "Request contains an invalid argument."
_FRIENDLY = {
    # Google still names the access-level refusals after the old token.
    "DEVELOPER_TOKEN_NOT_APPROVED": ("The Google Cloud project only has Test access to the Google Ads API, so real "
                                     "accounts cannot be read - apply for Explorer access on the project's "
                                     "Google Ads API page in Google Cloud Console."),
    "DEVELOPER_TOKEN_PROHIBITED": ("This Google Cloud project is not allowed to use the Google Ads API - check its "
                                   "access level on the Google Ads API page in Google Cloud Console."),
    "USER_PERMISSION_DENIED": ("The connected Google account cannot read this Ads account - give it access in "
                               "the manager account, or set GOOGLE_ADS_LOGIN_CUSTOMER_ID."),
    "CUSTOMER_NOT_ENABLED": "This Google Ads account is not active (cancelled or never finished setting up).",
}


def _error(r: httpx.Response) -> GbpError:
    msg, code = "", ""
    try:
        body = r.json()
        if isinstance(body, list):
            body = body[0] if body else {}
        err = body.get("error") or {}
        msg = err.get("message") or ""
        for d in err.get("details") or []:
            for e in d.get("errors") or []:
                code = next(iter((e.get("errorCode") or {}).values()), "") or code
                msg = e.get("message") or msg
    except (ValueError, AttributeError, TypeError):
        msg = r.text
    if r.status_code == 404 and not msg:
        msg = "This Google Ads API version is not available - set GOOGLE_ADS_API_VERSION to a current one."
    text = _FRIENDLY.get(str(code)) or f"Google Ads said: {(msg or r.text or '').strip()[:300]}"
    return GbpError(text, r.status_code)


def _send(method: str, url: str, **kw):
    try:
        r = httpx.request(method, url, timeout=_TIMEOUT, **kw)
    except httpx.HTTPError as e:
        raise GbpError(f"Could not reach Google Ads ({type(e).__name__}) - try again in a minute.", 503, transport=True)
    if r.status_code >= 400:
        raise _error(r)
    try:
        return r.json() if r.content else {}
    except ValueError:
        raise GbpError("Google Ads sent an answer Nexus could not read - try again in a minute.", 502)


def accessible_customers(token: str) -> list:
    """The Ads accounts the connected Google account can reach directly
    (ids only)."""
    data = _send("GET", f"{_base()}/customers:listAccessibleCustomers", headers=_headers(token))
    return [c for c in (clean_id(n) for n in data.get("resourceNames") or []) if c]


def search(token: str, customer: str, query: str, login_customer: str = "") -> list:
    """Every row of a GAQL query (searchStream answers a list of batches)."""
    data = _send("POST", f"{_base()}/customers/{customer}/googleAds:searchStream",
                 headers=_headers(token, login_customer), json={"query": query})
    out = []
    for batch in data if isinstance(data, list) else [data]:
        out += (batch or {}).get("results") or []
    return out


def customer_info(token: str, customer: str) -> dict:
    rows = search(token, customer, "SELECT customer.id, customer.descriptive_name, customer.manager, "
                                    "customer.currency_code FROM customer LIMIT 1", customer)
    return (rows[0].get("customer") if rows else None) or {}


def client_accounts(token: str, manager: str) -> list:
    """The Ads accounts directly under a manager account (itself excluded)."""
    rows = search(token, manager,
                  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, "
                  "customer_client.status, customer_client.currency_code, customer_client.level "
                  "FROM customer_client WHERE customer_client.level <= 1", manager)
    out = []
    for r in rows:
        c = r.get("customerClient") or {}
        if int(c.get("level") or 0) == 0:
            continue
        out.append(c)
    return out


def campaigns(token: str, customer: str, login_customer: str = "") -> list:
    return search(token, customer,
                  "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, "
                  "campaign.advertising_channel_type, campaign_budget.amount_micros "
                  "FROM campaign WHERE campaign.status != 'REMOVED'", login_customer)


def campaign_days(token: str, customer: str, start: str, end: str, login_customer: str = "") -> list:
    return search(token, customer,
                  "SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, "
                  "metrics.conversions, metrics.cost_micros FROM campaign "
                  f"WHERE segments.date BETWEEN '{start}' AND '{end}'", login_customer)


def keyword_days(token: str, customer: str, start: str, end: str, login_customer: str = "") -> list:
    return search(token, customer,
                  "SELECT campaign.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, "
                  "ad_group_criterion.keyword.match_type, segments.date, metrics.impressions, metrics.clicks, "
                  "metrics.conversions, metrics.cost_micros FROM keyword_view "
                  f"WHERE segments.date BETWEEN '{start}' AND '{end}' AND metrics.impressions > 0", login_customer)
