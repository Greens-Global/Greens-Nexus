"""One look for every Nexus email (Sep 26, 2026).

Settings > Global Settings > Branding & Policies > Email Appearance stores a
single theme in NexusSetting key "email_theme_config":

    {"logoUrl": "", "accentColor": "#0f3d2e", "footerText": "", "companyAddressLine": ""}

and every email family that builds its own HTML - task and ticket
notifications (task_mail_templates.py, ticket_mail_templates.py), external
invitations and sign-in codes (routers/external_auth.py), Nexus Sign
(routers/esign.py) and the HR welcome email (routers/hr.py) - asks this module
for its header color, logo, button color and footer lines instead of
hardcoding them.

The defaults ARE today's look. Each family had its own shade of green (the
dark #0f3d2e band on most mail, #14532d/#15803d on Nexus Sign, #248f4b task
buttons); while the saved accent is the default, every family keeps its own
shade, byte for byte (test_email_theme.py compares against snapshots). Once an
admin picks a different accent, that one color is used for the header band and
the main button of every family. The footer text and address line are extra
lines under each email's own footer note (which says things specific to that
email, like "the link works once"), so they are empty by default.

Logo precedence: a module's own logo setting (the Ticket or Task notification
"Company logo URL") still wins for that module's mail, then this theme's logo,
then the text wordmark every email has today.

The theme is read through the shared settings cache (cache.settings_config),
so a send costs no extra query within the cache window, and any failure falls
back to the defaults - an email must never fail to send because its styling
could not be loaded. The Daily Briefing (daily_briefing.py / briefing_card.py)
does not use this yet; it is being reworked separately.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import re
from dataclasses import dataclass, asdict
from html import escape

SETTINGS_KEY = "email_theme_config"
DEFAULT_ACCENT = "#0f3d2e"
FOOTER_MAX = 500
ADDRESS_MAX = 200

_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

# The wordmark shown when no logo is set - identical to what the notification
# emails print today.
WORDMARK = "<span style='color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px'>GREENS GLOBAL</span>"


def normalize_hex(value: str) -> str | None:
    """'#ABC' / '#aabbcc' -> '#aabbcc'; anything else -> None."""
    v = (value or "").strip()
    if not _HEX.match(v):
        return None
    v = v.lower()
    if len(v) == 4:
        v = "#" + "".join(ch * 2 for ch in v[1:])
    return v


@dataclass(frozen=True)
class Theme:
    logoUrl: str = ""
    accentColor: str = DEFAULT_ACCENT
    footerText: str = ""
    companyAddressLine: str = ""

    @classmethod
    def from_dict(cls, d: dict | None) -> "Theme":
        d = d if isinstance(d, dict) else {}
        accent = normalize_hex(str(d.get("accentColor") or "")) or DEFAULT_ACCENT
        return cls(
            logoUrl=str(d.get("logoUrl") or "").strip(),
            accentColor=accent,
            footerText=str(d.get("footerText") or "").strip()[:FOOTER_MAX],
            companyAddressLine=str(d.get("companyAddressLine") or "").strip()[:ADDRESS_MAX],
        )

    def as_dict(self) -> dict:
        return asdict(self)

    # ── what the templates call ──────────────────────────────────────────
    @property
    def custom_accent(self) -> bool:
        return self.accentColor != DEFAULT_ACCENT

    def color(self, classic: str) -> str:
        """The family's own historic color while the accent is the default,
        else the chosen accent. Used for header bands and main buttons."""
        return self.accentColor if self.custom_accent else classic

    def logo_url(self, module_logo: str = "") -> str:
        return (module_logo or "").strip() or self.logoUrl

    def logo_block(self, module_logo: str = "", wordmark: str = WORDMARK, height: int = 28,
                   align: str = "") -> str:
        """The header's logo image, or the family's wordmark when there is no
        logo. Single quotes, matching the templates this came out of."""
        url = self.logo_url(module_logo)
        if not url:
            return wordmark
        margin = ";margin:0 auto" if align == "center" else ""
        return (f"<img src='{escape(url)}' alt='Company logo' height='{height}' "
                f"style='display:block{margin}' />")

    def footer_lines(self, color: str = "#6b7280") -> str:
        """Extra footer lines (the company text and address), or '' when
        neither is set so the default renders exactly as before."""
        parts = []
        if self.footerText:
            parts.append(f"<div style='margin-top:6px;color:{color}'>{escape(self.footerText)}</div>")
        if self.companyAddressLine:
            parts.append(f"<div style='margin-top:4px;color:#9ca3af'>{escape(self.companyAddressLine)}</div>")
        return "".join(parts)


DEFAULT_THEME = Theme()

# Set by override() (the Preview endpoint and tests) so a draft theme can be
# rendered without saving it.
_override: contextvars.ContextVar[Theme | None] = contextvars.ContextVar("email_theme_override", default=None)


@contextlib.contextmanager
def override(theme: Theme):
    token = _override.set(theme)
    try:
        yield
    finally:
        _override.reset(token)


def _load(db=None) -> dict:
    import models
    close = False
    if db is None:
        from database import SessionLocal
        db, close = SessionLocal(), True
    try:
        row = db.query(models.NexusSetting).filter(models.NexusSetting.key == SETTINGS_KEY).first()
        if not row or not row.value:
            return {}
        try:
            val = json.loads(row.value)
        except (TypeError, ValueError):
            return {}
        return val if isinstance(val, dict) else {}
    finally:
        if close:
            db.close()


def get_saved(db=None) -> Theme:
    """The saved theme (cached). Never raises: on any error, the defaults."""
    try:
        import cache
        raw = cache.settings_config.get_or_load(SETTINGS_KEY, lambda: _load(db))
        return Theme.from_dict(raw)
    except Exception as exc:  # noqa: BLE001 - styling must never block a send
        print(f"[email_theme] falling back to defaults: {type(exc).__name__}")
        return DEFAULT_THEME


def current() -> Theme:
    """What a template should use right now: a preview override if one is
    active, otherwise the saved theme."""
    return _override.get() or get_saved()
