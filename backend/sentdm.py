"""sent.dm - the ONE SMS client for Nexus (Aug 18; unified Aug 19).

Every SMS Nexus sends goes through here: external-login / activation codes
(routers/external_auth.py) and Credential Vault OTPs (routers/credvault.py).
Deliberately tiny: send_text against sent.dm's Send Message endpoint
(POST https://api.sent.dm/v3/messages, body {to, channel, text}) plus the
two code helpers callers use.

AUTH IS x-api-key, AND ONLY THAT. docs.sent.dm/reference/api/authentication:
"The Sent API v3 authenticates every request with an API key passed in the
x-api-key header" - Bearer is not accepted. This module sent Bearer until
08/19, so every external-login SMS on prod failed and silently degraded to
email (Archana's activation: SMS code issued 19:43:23.855, abandoned 75 ms
later, email code issued 19:43:24.04 - that is the fingerprint). CredVault
carried its own copy of the client with the right header but a DIFFERENT env
var, so the two surfaces could never both be configured at once. One module,
one header, one key now.

Key: NEXUS_SENTDM_KEY (canonical); SENTDM_API_KEY still honored so an Azure
setting made under the old name keeps working. When unset or a send fails,
callers degrade (external login -> emailed code; vault -> "use Email") - SMS
is an upgrade, never a dependency.

Only ever called from sync `def` endpoints (FastAPI threadpool), so the
outbound HTTP never sits on the async event loop. Never log the code itself -
log only delivery status.
"""
import os
import re

import httpx

_API_URL = "https://api.sent.dm/v3/messages"

# OTP template (sent.dm support, 08/19: "to send OTP/verification messages,
# create/use your OTP template and include its Template ID in your API call").
# The "OTP Verification Code" template in the sent.dm dashboard; its SMS body
# carries one placeholder for the code. Both overridable so a re-made template
# or a differently named placeholder is a setting, not a deploy.
_OTP_TEMPLATE_ID = "21fef045-2521-4678-a996-dd00bd46f37b"
_OTP_PARAM = "code"


def otp_template_id() -> str:
    return (os.getenv("NEXUS_SENTDM_OTP_TEMPLATE", _OTP_TEMPLATE_ID) or "").strip()


def otp_param_name() -> str:
    return (os.getenv("NEXUS_SENTDM_OTP_PARAM", _OTP_PARAM) or "code").strip()


def api_key() -> str:
    return (os.getenv("NEXUS_SENTDM_KEY", "") or os.getenv("SENTDM_API_KEY", "")).strip()


def configured() -> bool:
    return bool(api_key())


def normalize_phone(raw: str, default_country: str = "1") -> str:
    """E.164 for sent.dm. HR stores phones however they were typed -
    "(949) 400-3330", "949.400.3330", "+1 949 400 3330" - and the API wants
    +19494003330. Ten digits are taken as North American; 11 starting with 1
    likewise; anything already carrying '+' keeps its country code. Returns ''
    when there is no usable number, so callers fall back cleanly."""
    s = (raw or "").strip()
    if not s:
        return ""
    plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    if not digits:
        return ""
    if plus:
        return "+" + digits
    if len(digits) == 10:
        return f"+{default_country}{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    if len(digits) > 11:          # typed with a country code but no '+'
        return "+" + digits
    return ""


def _post(body: dict) -> tuple[bool, str]:
    key = api_key()
    if not key:
        return False, "sent.dm not configured (NEXUS_SENTDM_KEY unset)"
    try:
        resp = httpx.post(
            _API_URL,
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json=body,
            timeout=15,
        )
        if resp.status_code in (200, 201, 202):
            return True, ""
        detail = ""
        try:
            detail = " ".join((resp.text or "")[:160].split())
        except Exception:  # noqa: BLE001
            pass
        return False, f"sent.dm returned {resp.status_code} {detail}".strip()
    except Exception as exc:      # noqa: BLE001 - degrade, never crash a login request
        return False, f"sent.dm unreachable: {type(exc).__name__}"


def send_text(phone: str, text: str) -> tuple[bool, str]:
    """Free-form text to `phone`. Returns (ok, error) - never raises, so a
    messaging outage can only ever degrade to the caller's fallback. The body
    carries exactly one of text / template (sent.dm validation)."""
    to = normalize_phone(phone)
    if not to:
        return False, "no usable phone number on file"
    return _post({"to": [to], "channel": ["sms"], "text": text})


def send_otp(phone: str, code: str, fallback_text: str) -> tuple[bool, str]:
    """A verification code, via the OTP TEMPLATE first - sent.dm routes
    verification traffic through templates (carrier compliance), and a
    free-form OTP can be refused or filtered. Falls back to free-form text
    only if the template send itself is rejected (wrong id / parameter name),
    so a template misconfiguration degrades to a plain text rather than to
    no SMS at all; the error from the template attempt is kept in the reply
    so the audit row says which path delivered."""
    to = normalize_phone(phone)
    if not to:
        return False, "no usable phone number on file"
    tid = otp_template_id()
    if tid:
        ok, err = _post({"to": [to], "channel": ["sms"],
                         "template": {"id": tid, "parameters": {otp_param_name(): code}}})
        if ok:
            return True, ""
        ok2, err2 = _post({"to": [to], "channel": ["sms"], "text": fallback_text})
        if ok2:
            return True, f"template send failed ({err}); delivered as free-form text"
        return False, f"template: {err}; text: {err2}"
    return _post({"to": [to], "channel": ["sms"], "text": fallback_text})


def send_code(phone: str, code: str) -> tuple[bool, str]:
    """External login / activation code."""
    return send_otp(phone, code, f"{code} is your Greens Global Nexus verification code. "
                                 "It expires in 10 minutes. Never share it.")


def send_vault_code(phone: str, code: str) -> tuple[bool, str]:
    """Credential Vault reveal/share code."""
    return send_otp(phone, code, f"{code} is your Greens Nexus Credential Vault code. "
                                 "It expires in 10 minutes. Never share it.")
