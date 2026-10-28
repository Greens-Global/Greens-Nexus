"""Settings > Workflows (spec 8.2): the organization's row and a company's
override, layered through scoped_settings (defaults <- tenant <- company).
Org-only keys (the pause-all switch, the webhook allow-list and secrets,
the Nexus run-as switch) are read from the tenant row whatever company is
asked for; a company may override `enabled`, `ownerDigest` and the two
caps (never above the organization's). Webhook secrets are stored
encrypted (`secret_box`) and never read back whole - the API says which
hosts have one."""
from __future__ import annotations

from datetime import datetime, timezone

import scoped_settings

BASE = "workflows.config"
DEFAULTS = {
    "enabled": True,
    "maxRunsPerHourCap": 500,
    "maxRecipientsCap": 200,
    "ownerDigest": False,
    "nexusRunAs": False,
    "webhookHosts": [],
    "webhookSecrets": {},
    "pausedAll": False,
    "pausedBy": "",
    "pausedAt": "",
}
HARD_RUNS_CAP = 500
HARD_RECIPIENTS_CAP = 200
ORG_ONLY = ("nexusRunAs", "webhookHosts", "webhookSecrets", "pausedAll", "pausedBy", "pausedAt")
COMPANY_KEYS = ("enabled", "ownerDigest", "maxRunsPerHourCap", "maxRecipientsCap")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(cfg: dict, base: dict) -> dict:
    out = dict(base)
    for k in ("enabled", "ownerDigest", "nexusRunAs", "pausedAll"):
        if k in cfg:
            out[k] = bool(cfg[k])
    for k, hard in (("maxRunsPerHourCap", HARD_RUNS_CAP), ("maxRecipientsCap", HARD_RECIPIENTS_CAP)):
        if k in cfg:
            try:
                out[k] = max(1, min(int(cfg[k]), hard))
            except (TypeError, ValueError):
                pass
    if "webhookHosts" in cfg:
        hosts = cfg["webhookHosts"]
        if isinstance(hosts, str):
            hosts = hosts.replace(",", "\n").split("\n")
        out["webhookHosts"] = sorted({str(h).strip().lower() for h in (hosts or []) if str(h).strip()})
    for k in ("pausedBy", "pausedAt"):
        if k in cfg:
            out[k] = str(cfg[k] or "")
    return out


def get(db, company_id: str = "") -> dict:
    """The effective settings for a company (or the organization when
    blank). Org-only keys always come from the tenant row."""
    org = scoped_settings.get(db, BASE, DEFAULTS, "")
    if not company_id:
        return org
    cfg = scoped_settings.get(db, BASE, DEFAULTS, company_id)
    for k in ORG_ONLY:
        cfg[k] = org.get(k, DEFAULTS[k])
    # a company's cap never exceeds the organization's
    for k in ("maxRunsPerHourCap", "maxRecipientsCap"):
        cfg[k] = min(int(cfg.get(k) or DEFAULTS[k]), int(org.get(k) or DEFAULTS[k]))
    return cfg


def has_override(db, company_id: str) -> bool:
    return scoped_settings.has_override(db, BASE, company_id)


def save(db, company_id: str, cfg: dict, actor: str, *, secrets: dict | None = None) -> dict:
    """Store the organization row (company '') or a company's override;
    `secrets` is {host: plaintext} for the secrets typed now - stored
    encrypted alongside the ones already kept (a blank drops that host's).
    The caller commits."""
    if company_id:
        current = scoped_settings.saved(db, BASE, company_id, COMPANY_KEYS)
        new = _clean({k: v for k, v in (cfg or {}).items() if k in COMPANY_KEYS}, current)
        new = {k: v for k, v in new.items() if k in COMPANY_KEYS}
        scoped_settings.save(db, BASE, company_id, new, actor)
        return new
    current = scoped_settings.saved(db, BASE, "", DEFAULTS)
    new = _clean(cfg or {}, {**DEFAULTS, **current})
    kept = dict(current.get("webhookSecrets") or {})
    if secrets:
        import secret_box
        for host, plain in secrets.items():
            h = str(host or "").strip().lower()
            if not h:
                continue
            if plain in (None, ""):
                kept.pop(h, None)
            else:
                kept[h] = secret_box.encrypt(str(plain))
    new["webhookSecrets"] = {h: v for h, v in kept.items() if h in new["webhookHosts"]}
    scoped_settings.save(db, BASE, "", new, actor)
    return new


def reset(db, company_id: str) -> bool:
    return scoped_settings.reset(db, BASE, company_id)


def pause_all(db, paused: bool, actor: str) -> dict:
    current = scoped_settings.saved(db, BASE, "", DEFAULTS)
    new = {**DEFAULTS, **current}
    new["pausedAll"] = bool(paused)
    new["pausedBy"] = (actor or "").lower() if paused else ""
    new["pausedAt"] = _now() if paused else ""
    scoped_settings.save(db, BASE, "", new, actor)
    return new


class SecretUnreadable(RuntimeError):
    pass


def webhook_secret(db, host: str) -> str:
    """The decrypted secret for `host`, '' when none is kept. A kept secret
    that cannot be decrypted (the encryption key changed) raises - the
    step fails rather than signing with an empty key."""
    raw = (get(db).get("webhookSecrets") or {}).get((host or "").lower(), "")
    if not raw:
        return ""
    import secret_box
    try:
        return secret_box.decrypt(raw)
    except Exception as e:   # noqa: BLE001 - whatever secret_box raises, the step must not sign blind
        raise SecretUnreadable(f"The webhook secret for {host} cannot be read (re-enter it in Settings > Workflows): "
                               f"{type(e).__name__}") from None


def public(db, company_id: str = "") -> dict:
    """The API's shape (contract notes): the settings without the secrets,
    plus which hosts have one and whether the company overrides."""
    cfg = get(db, company_id)
    out = {k: cfg.get(k) for k in DEFAULTS if k != "webhookSecrets"}
    out["webhookSecretsSet"] = sorted((cfg.get("webhookSecrets") or {}).keys())
    out["override"] = has_override(db, company_id) if company_id else False
    return out
