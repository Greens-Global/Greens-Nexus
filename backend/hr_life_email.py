"""The emails an HR life event sends - written like a company that is glad
to have you (Pranshu, Oct 8: industry level, celebrate a hire or a
promotion, say what the pay went up by, never a dead template).

  invite (it is their turn to sign)
    hire        -> the new hire: a real welcome - the offer at a glance (role,
                   team, start date, manager, type, base pay, where), HR's
                   note, the documents, what happens next, the sign button
    promotion   -> the employee: congratulations - from -> to, effective date,
                   the pay card (previous, new, +amount, +%), their note
    promotion   -> the manager, after the employee: the same summary, approve
    separation  -> the person leaving: respectful and factual - last day, what
                   happens with final pay / benefits / property, documents
  completed (everyone has signed; the signed PDF is attached)
    hire        -> "You're officially part of the team" + first-day steps
    promotion   -> "It's official" + when the change shows up
    separation  -> "Your documents are complete" + what to expect

HTML is email-safe: tables, inline styles, bgcolor attributes for Outlook,
system-font stack, a bulletproof button, a hidden preheader, 600px wide.
Pay appears only in the person's own email and their manager's approval.
Anyone else on an envelope (HR signing for the company) gets Nexus Sign's
own email. preview() renders any of them with sample data (Packets >
Preview Email).
"""
from datetime import datetime, timezone
from html import escape
from typing import Optional

from sqlalchemy.orm import Session

from models import HrEntity, HrLifeEvent, HrSignParty, HrSignRequest, NexusEmployee

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
INK, MUTED, LINE, SOFT = "#111827", "#6b7280", "#e5e7eb", "#f9fafb"
EMPLOYMENT = {"full_time": "Full-Time", "part_time": "Part-Time", "contractor": "Contractor", "intern": "Intern"}
SYMBOL = {"USD": "$", "INR": "₹"}


# ── formatting ───────────────────────────────────────────────────────────────

def _long(iso: str) -> str:
    try:
        d = datetime.strptime((iso or "")[:10], "%Y-%m-%d")
    except ValueError:
        return iso or ""
    return f"{d.strftime('%A')}, {d.strftime('%B')} {d.day}, {d.year}"


def _short(iso: str) -> str:
    try:
        d = datetime.strptime((iso or "")[:10], "%Y-%m-%d")
    except ValueError:
        return iso or ""
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def _money(amount: float, currency: str = "USD", cents: bool = False) -> str:
    sym = SYMBOL.get(currency or "USD", "")
    return f"{sym}{amount:,.2f}" if cents else f"{sym}{amount:,.0f}"


def _pay_line(pay: dict) -> str:
    if not pay or pay.get("base") in (None, ""):
        return ""
    cur = pay.get("currency") or "USD"
    base = float(pay["base"])
    if pay.get("payBasis") == "hourly":
        return f"{_money(base, cur, True)} per hour"
    freq = pay.get("frequency") or "annual"
    if freq == "annual":
        return f"{_money(base, cur)} per year"
    return f"{_money(base, cur)} {_PER.get(freq, '')}".strip()


_PER = {"annual": "per year", "monthly": "per month", "semimonthly": "twice a month",
        "biweekly": "every two weeks", "weekly": "per week"}


def _unit(pay: dict) -> str:
    return "hourly" if (pay or {}).get("payBasis") == "hourly" else ((pay or {}).get("frequency") or "annual")


def pay_change(old: dict, new: dict):
    """The new pay and the previous one, each in the unit it is paid in - no
    yearly conversion, no percentage (Pranshu, Oct 8). The increase is given
    only when both are in the same unit and currency ("Up $1,000 per month",
    "Up $2.50 per hour"); across units it would be a made-up figure."""
    if not new or new.get("base") in (None, ""):
        return None
    cur = new.get("currency") or "USD"
    out = {"new": _pay_line(new), "previous": _pay_line(old) if (old or {}).get("base") not in (None, "") else "",
           "currency": cur, "delta": None, "unit": ""}
    try:
        same = (old and _unit(old) == _unit(new) and (old.get("currency") or cur) == cur)
        if same and float(new["base"]) > float(old["base"]):
            out["delta"] = float(new["base"]) - float(old["base"])
            out["unit"] = "per hour" if _unit(new) == "hourly" else _PER.get(_unit(new), "")
    except (TypeError, ValueError):
        pass
    return out


# ── building blocks ──────────────────────────────────────────────────────────
# Full-width layout (Pranshu, Oct 8: "make it full page"): a top bar, a hero
# band and a footer band run edge to edge; the text sits in an 880px column
# so lines stay readable on a wide screen and collapse cleanly on a phone.
# Written like an HR letter, not a dashboard: a few facts, plain paragraphs,
# a signature.

WIDTH = 880


def _preheader(text: str) -> str:
    return (f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;'
            f'mso-hide:all">{escape(text)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>')


def _band(inner: str, bg: str = "#ffffff", pad: str = "40px 40px", extra: str = "") -> str:
    """A full-width row with its content in the centered reading column."""
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{bg}" '
            f'style="background:{bg};{extra}"><tr><td align="center" style="padding:0 16px">'
            f'<table role="presentation" width="{WIDTH}" cellpadding="0" cellspacing="0" border="0" class="col-wrap" '
            f'style="width:100%;max-width:{WIDTH}px"><tr><td class="pad" style="padding:{pad}">{inner}</td></tr></table>'
            f'</td></tr></table>')


def _button(label: str, link: str, color: str) -> str:
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td bgcolor="{color}" style="border-radius:6px;background:{color}">'
            f'<a href="{link}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:{FONT};'
            f'font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px">{label}</a>'
            f'</td></tr></table>')


def _tint(color: str, amount: float = 0.92) -> str:
    """The accent mixed toward white - panel backgrounds that match the email's color."""
    c = (color or "#15803d").lstrip("#")
    if len(c) != 6:
        return SOFT
    rgb = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(v + (255 - v) * amount):02x}" for v in rgb)


def _heading(text: str, accent: str = "") -> str:
    bar = (f'<div style="width:32px;height:3px;background:{accent};border-radius:2px;margin:0 0 10px;'
           f'font-size:0;line-height:0">&nbsp;</div>') if accent else ""
    return (bar + f'<div style="font-family:{FONT};font-size:19px;font-weight:700;color:{INK};margin:0 0 14px">'
            f'{escape(text)}</div>')


def _card(title: str, rows: list, accent: str = "#15803d") -> str:
    """The facts as a two-up grid on a tinted panel - label above value."""
    rows = [(k, v) for k, v in rows if v]
    tint, rule = _tint(accent), _tint(accent, 0.8)
    cells = []
    for n, i in enumerate(range(0, len(rows), 2)):
        pair = rows[i:i + 2]
        top = f"border-top:1px solid {rule};" if n else ""
        tds = "".join(
            f'<td class="col" width="50%" style="width:50%;padding:16px 16px 16px 0;{top}vertical-align:top">'
            f'<div style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;'
            f'color:{MUTED}">{escape(k)}</div>'
            f'<div style="font-family:{FONT};font-size:16px;font-weight:700;color:{INK};margin-top:5px">{v}</div></td>'
            for k, v in pair)
        if len(pair) == 1:
            tds += f'<td class="col" width="50%" style="width:50%;{top}">&nbsp;</td>'
        cells.append(f'<tr>{tds}</tr>')
    return (_heading(title, accent)
            + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{tint}" '
              f'style="background:{tint};border-radius:12px;border:1px solid {rule}"><tr><td style="padding:8px 28px">'
              f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{"".join(cells)}</table>'
              f'</td></tr></table>')


def _pay_card(change: dict, accent: str, light: str) -> str:
    if not change:
        return ""
    up = ""
    if change.get("delta") is not None and change["delta"] > 0:
        up = (f'<span style="font-family:{FONT};font-size:14px;font-weight:700;color:{accent};margin-left:12px">'
              f'&#9650; Up {_money(change["delta"], change["currency"], cents=change["unit"] == "per hour")} '
              f'{change["unit"]}</span>')
    prev = (f'<div style="font-family:{FONT};font-size:14px;color:{MUTED};margin-top:6px">'
            f'Previously {escape(change["previous"])}</div>' if change.get("previous") else "")
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{light}" '
            f'style="background:{light};border-radius:12px"><tr>'
            f'<td width="5" bgcolor="{accent}" style="background:{accent};width:5px;border-radius:12px 0 0 12px"></td>'
            f'<td style="padding:22px 28px">'
            f'<div style="font-family:{FONT};font-size:13px;color:{MUTED}">Your new base pay</div>'
            f'<div style="font-family:{FONT};font-size:26px;font-weight:800;color:{INK};margin-top:4px">'
            f'{escape(change["new"])}{up}</div>{prev}</td></tr></table>')


def _initials(name: str) -> str:
    parts = [p for p in (name or "").split() if p[:1].isalpha()]
    return escape("".join(p[0] for p in parts[:2]).upper() or "HR")


def _note(note: str, sender: dict, accent: str) -> str:
    """A personal quote from whoever sent it - initials, name and title under the words."""
    if not note:
        return ""
    sender = sender or {}
    name = sender.get("name") or "Human Resources"
    sub = " &middot; ".join(escape(x) for x in (sender.get("title"), sender.get("entity")) if x)
    tint = _tint(accent, 0.94)
    return (_heading(f"A note from {name.split(' ')[0]}", accent)
            + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{tint}" '
              f'style="background:{tint};border-radius:12px"><tr>'
              f'<td width="4" bgcolor="{accent}" style="background:{accent};width:4px;border-radius:12px 0 0 12px"></td>'
              f'<td style="padding:22px 28px 24px">'
              f'<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:44px;line-height:.6;color:{accent};'
              f'height:22px">&#8220;</div>'
              f'<div style="font-family:{FONT};font-size:17px;line-height:1.7;color:{INK};white-space:pre-line">'
              f'{escape(note)}</div>'
              f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px"><tr>'
              f'<td width="40" height="40" bgcolor="{accent}" align="center" valign="middle" '
              f'style="width:40px;height:40px;border-radius:20px;background:{accent};font-family:{FONT};font-size:14px;'
              f'font-weight:700;color:#ffffff;text-align:center;line-height:40px">{_initials(name)}</td>'
              f'<td style="padding-left:12px;vertical-align:middle">'
              f'<div style="font-family:{FONT};font-size:14.5px;font-weight:700;color:{INK}">{escape(name)}</div>'
              + (f'<div style="font-family:{FONT};font-size:13px;color:{MUTED}">{sub}</div>' if sub else "")
            + '</td></tr></table></td></tr></table>')


def _docs(docs: list, accent: str = "#15803d", status: str = "Ready to Sign") -> str:
    """Each document as its own row: a PDF badge, the name, and where it stands."""
    if not docs:
        return ""
    rule = _tint(accent, 0.8)
    rows = "".join(
        f'<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" style="border:1px solid {LINE};border-radius:10px"><tr>'
        f'<td width="44" style="padding:14px 0 14px 16px;width:44px">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td width="40" height="40" bgcolor="{_tint(accent, 0.88)}" align="center" valign="middle" '
        f'style="width:40px;height:40px;border-radius:8px;background:{_tint(accent, 0.88)};font-family:{FONT};'
        f'font-size:10.5px;font-weight:800;letter-spacing:.04em;color:{accent};text-align:center">PDF</td>'
        f'</tr></table></td>'
        f'<td style="padding:14px 16px;font-family:{FONT};font-size:15px;font-weight:600;color:{INK}">{escape(d)}</td>'
        + (f'<td align="right" style="padding:14px 16px;white-space:nowrap">'
           f'<span style="display:inline-block;font-family:{FONT};font-size:12px;font-weight:700;color:{accent};'
           f'background:{_tint(accent, 0.9)};border:1px solid {rule};border-radius:999px;padding:4px 12px">'
           f'{escape(status)}</span></td>' if status else "")
        + '</tr></table></td></tr>'
        for d in docs)
    return (_heading("Your documents", accent)
            + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>')


def _steps(title: str, steps: list, accent: str) -> str:
    """Numbered tiles side by side on a wide screen, stacked on a phone."""
    n = max(1, len(steps))
    width = f"{(100 - 2 * (n - 1)) / n:g}%"           # 2% gutters between tiles
    tint = _tint(accent, 0.94)
    tiles = []
    for i, (h, b) in enumerate(steps, 1):
        if i > 1:
            tiles.append('<td class="gap" width="2%" style="width:2%;font-size:0">&nbsp;</td>')
        tiles.append(
            f'<td class="col tile" width="{width}" bgcolor="{tint}" style="width:{width};vertical-align:top;'
            f'background:{tint};border-radius:12px;padding:20px 20px 22px">'
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td width="32" height="32" bgcolor="{accent}" align="center" valign="middle" '
            f'style="width:32px;height:32px;border-radius:16px;background:{accent};font-family:{FONT};font-size:14px;'
            f'font-weight:800;color:#ffffff;text-align:center;line-height:32px">{i}</td></tr></table>'
            f'<div style="font-family:{FONT};font-size:15.5px;font-weight:700;color:{INK};margin-top:14px">{escape(h)}</div>'
            f'<div style="font-family:{FONT};font-size:14px;color:#4b5563;line-height:1.6;margin-top:6px">{escape(b)}</div>'
            f'</td>')
    return (_heading(title, accent)
            + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>{"".join(tiles)}</tr></table>')


def _contact(sender: dict, accent: str) -> str:
    """A signature, the way a person signs a letter."""
    name = sender.get("name") or ""
    lines = [escape(x) for x in (sender.get("title"), sender.get("entity")) if x]
    reach = []
    if sender.get("email"):
        reach.append(f'<a href="mailto:{escape(sender["email"])}" style="color:{accent};text-decoration:none">'
                     f'{escape(sender["email"])}</a>')
    if sender.get("phone"):
        reach.append(escape(sender["phone"]))
    return (f'<div style="font-family:{FONT};font-size:15.5px;line-height:1.7;color:#374151">Warm regards,</div>'
            f'<div style="font-family:{FONT};font-size:16px;font-weight:700;color:{INK};margin-top:14px">{escape(name)}</div>'
            + (f'<div style="font-family:{FONT};font-size:14px;color:{MUTED}">{" &middot; ".join(lines)}</div>' if lines else "")
            + (f'<div style="font-family:{FONT};font-size:14px;margin-top:2px">{" &middot; ".join(reach)}</div>' if reach else "")
            + f'<div style="font-family:{FONT};font-size:13.5px;color:{MUTED};margin-top:12px">'
              f'Questions? Just reply to this email.</div>')


def _shell(*, preheader: str, company: str, accent: str, hero_bg: str, hero_emoji: str, hero_title: str,
           hero_sub: str, sections: list, party, req, sender: dict, security: bool = True) -> str:
    """Top bar, hero band, body, security line, footer band - all full width."""
    from routers import esign
    import email_theme
    th = email_theme.current()
    logo = th.logo_url() if hasattr(th, "logo_url") else ""
    brand = (f'<img src="{escape(logo)}" alt="{escape(company)}" height="30" style="display:block;border:0;height:30px">'
             if logo else f'<span style="font-family:{FONT};font-size:17px;font-weight:800;color:{INK}">{escape(company)}</span>')
    top = _band(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
                f'<td style="vertical-align:middle">{brand}</td>'
                f'<td align="right" style="vertical-align:middle;font-family:{FONT};font-size:13px;color:{MUTED}">'
                f'Human Resources</td></tr></table>',
                pad="22px 40px", extra=f"border-bottom:4px solid {accent}")
    title = hero_title + (f'&nbsp;{hero_emoji}' if hero_emoji else "")
    hero = _band(f'<div style="font-family:{FONT};font-size:34px;line-height:1.2;font-weight:800;color:#ffffff">{title}</div>'
                 f'<div style="font-family:{FONT};font-size:17px;line-height:1.6;color:#e6f4ea;margin-top:14px;'
                 f'max-width:640px">{hero_sub}</div>',
                 bg=hero_bg, pad="52px 40px 48px")
    body = "".join(f'<div style="margin:0 0 36px">{s}</div>' for s in sections if s)
    who = escape(sender.get("name") or "the sender")
    # An external signer holds a tokenized link - the warning is about the
    # link. A teammate signs behind their Nexus login, so there is no link to
    # protect; what they need to know is what will be asked of them.
    external = (getattr(party, "kind", "") or "external") == "external"
    sec_text = (f"&#128274; This link is unique to you - please do not forward this email. You will confirm a "
                f"one-time code before signing. Not expecting it? Contact {who} directly before opening the link."
                if external else
                f"&#128274; The button opens Nexus; you sign in as usual and confirm a one-time code before "
                f"signing. Not expecting this? Contact {who} directly before signing.")
    sec = (f'<div style="font-family:{FONT};font-size:12.5px;line-height:1.6;color:{MUTED};border-top:1px solid {LINE};'
           f'padding-top:18px">{sec_text}</div>') if security else ""
    footer = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f9fafb" '
              f'style="background:#f9fafb;border-top:1px solid {LINE}"><tr><td align="center" style="padding:0 16px">'
              f'<table role="presentation" width="{WIDTH}" cellpadding="0" cellspacing="0" border="0" '
              f'style="width:100%;max-width:{WIDTH}px">{esign._email_legal_footer(party, req, sender)}'
              f'<tr><td style="padding:0 36px 24px;font-family:{FONT};font-size:12px;color:#9ca3af">'
              f'Sent by {escape(company)} through Nexus</td></tr></table></td></tr></table>')
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<style>@media only screen and (max-width:620px){{.col{{display:block!important;width:100%!important;padding-right:0!important}}
.pad{{padding-left:20px!important;padding-right:20px!important}}.gap{{display:none!important}}.tile{{border-bottom:12px solid #ffffff!important}}}}</style></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:{FONT}">{_preheader(preheader)}
{top}{hero}{_band(body + sec, pad="44px 40px 36px")}{footer}
</body></html>"""


def _p(text: str) -> str:
    return f'<div style="font-family:{FONT};font-size:15.5px;line-height:1.7;color:#374151">{text}</div>'


def _signed_line(signed_by: list, company: str, accent: str) -> str:
    """'Already signed for {company} by X on {date}' - the packet arrives
    countersigned, and saying so is what makes it an offer, not a form."""
    if not signed_by:
        return ""
    parts = []
    for name, at in signed_by:
        day = _short(at) if at else ""
        parts.append(escape(name) + (f" on {escape(day)}" if day else ""))
    return (f'<div style="font-family:{FONT};font-size:13.5px;color:{INK};margin-top:12px">'
            f'<span style="color:{accent};font-weight:700">&#10003;</span>&nbsp; Already signed for '
            f'{escape(company)} by {", ".join(parts)}.</div>')


def _after_me(after_me: list, fallback: str) -> str:
    names = [escape(n) for n in (after_me or []) if n]
    if not names:
        return "You are the last to sign - then it is official."
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    return f"{joined} sign{'s' if len(names) == 1 else ''} after you - then it is official."


# ── the emails ───────────────────────────────────────────────────────────────

def compose(kind: str, *, stage: str, role: str, first_name: str, company: str, location: str, inputs: dict,
            pay: dict, manager: str, note: str, docs: list, link: str, sender: dict, party, req,
            subject_name: str = "", signed_by: Optional[list] = None, after_me: Optional[list] = None) -> tuple:
    """(subject, html). stage: 'invite' (sign now) or 'completed' (all signed).
    signed_by: [(name, signed_at)] who signed before this person; after_me:
    names still to sign after them."""
    import email_theme
    th = email_theme.current()
    green = th.color("#15803d")
    d = inputs or {}
    first = escape(first_name or "there")

    if kind == "hire":
        title = d.get("job_title") or "your new role"
        start = _long(d.get("start_date"))
        offer = _card("Your offer at a glance", [
            ("Position", escape(title)),
            ("Team", escape(d.get("department") or "")),
            ("Company", escape(company)),
            ("Start date", escape(start)),
            ("Reports to", escape(manager)),
            ("Employment", escape(EMPLOYMENT.get(d.get("employment_type") or "", ""))),
            ("Base pay", escape(_pay_line(pay) or d.get("salary_text") or "")),
            ("Location", escape(location)),
        ], green)
        if stage == "completed":
            return (f"You're officially part of {company} 🎉",
                    _shell(preheader=f"Everything is signed - here is what happens before {_short(d.get('start_date'))}.",
                           company=company, accent=green, hero_bg="#14532d", hero_emoji="&#127881;",
                           hero_title=f"It's official, {first}!",
                           hero_sub=f"Your offer is signed. Welcome to {escape(company)} - we can't wait to have you.",
                           sections=[
                               _p("Every document is signed and a copy is attached to this email for your records. "
                                  "Here is what happens between now and your first day."),
                               _steps("Before you start", [
                                   ("Your accounts", "You'll receive a separate email with your work sign-in details "
                                                     "a few days before you start."),
                                   ("Your first day", f"{start or 'On your start date'} - "
                                                      f"{escape(manager) + ' will meet you and' if manager else 'your manager will'} "
                                                      "walk you through your first week."),
                                   ("Your documents", "Your signed offer and onboarding documents are saved to My Documents "
                                                      "in Nexus once you sign in."),
                               ], green),
                               offer, _contact(sender, green)],
                           party=party, req=req, sender=sender, security=False))
        return (f"Welcome to {company}, {first_name}! Your offer is ready to sign 🎉",
                _shell(preheader=f"We're delighted to offer you the {title} role - review and sign to accept.",
                       company=company, accent=green, hero_bg="#14532d", hero_emoji="&#127881;",
                       hero_title=f"Welcome to the team, {first}!",
                       hero_sub=(f"We're thrilled to offer you the <strong>{escape(title)}</strong> role at "
                                 f"{escape(company)}. Your offer and onboarding documents are ready for you."),
                       sections=[
                           _p(f"Hi {first},<br><br>On behalf of everyone at {escape(company)}, we're excited to offer "
                              f"you the role of <strong>{escape(title)}</strong>. We were impressed throughout the "
                              f"process and think you'll be a great addition to the team. The details of your offer "
                              f"are below, and your offer letter and onboarding documents are ready for your signature."),
                           offer,
                           _note(note, sender, green),
                           _docs(docs, green) + _signed_line(signed_by or [], company, green),
                           _button("Review &amp; Sign Your Offer", link, green)
                           + f'<div style="font-family:{FONT};font-size:13px;color:{MUTED};margin-top:10px">'
                             f'Takes about 10 minutes and works on your phone. Signing is how you accept the offer.</div>',
                           _steps("What happens next", [
                               ("Sign your offer", "Open the link, confirm the one-time code we email you, and sign each document."),
                               ("We get you set up", "Your work email and accounts are created before your first day."),
                               ("Day one", f"{start or 'Your start date'} - bring a government-issued photo ID for your "
                                           "employment paperwork; we'll have everything else ready."),
                           ], green),
                           _contact(sender, green)],
                       party=party, req=req, sender=sender))

    if kind == "promotion":
        is_change = d.get("change_type") == "role_change"
        new, old = d.get("job_title") or "your new role", d.get("old_title") or ""
        eff = _short(d.get("effective_date"))
        change = pay_change(d.get("old_pay") or {}, pay or {})
        move = _card("The change", [
            ("From", escape(old)),
            ("To", f'<span style="color:{green}">{escape(new)}</span>'),
            ("Team", escape(d.get("department") or "")),
            ("Effective", escape(eff)),
            ("Reports to", escape(manager)),
        ], green)
        resp = (_heading("Your new responsibilities", green)
                + f'<div style="font-family:{FONT};font-size:15.5px;line-height:1.7;color:#374151;white-space:pre-line;'
                  f'border:1px solid {LINE};border-radius:12px;padding:18px 24px">'
                  f'{escape(d["responsibilities"])}</div>') if d.get("responsibilities") else ""
        pay_card = _pay_card(change, green, "#ecfdf5")
        if role == "manager":
            return (f"Approval needed: {subject_name}'s {'role change' if is_change else 'promotion'} to {new}",
                    _shell(preheader=f"{subject_name} has signed - your signature makes it official.",
                           company=company, accent=green, hero_bg="#1e3a8a", hero_emoji="&#9997;&#65039;",
                           hero_title="Your approval is needed",
                           hero_sub=(f"<strong>{escape(subject_name)}</strong> has signed their "
                                     f"{'role change' if is_change else 'promotion'} letter. "
                                     "As their manager, your signature makes it official."),
                           sections=[move, pay_card, resp, _docs(docs, green),
                                     _button("Review &amp; Approve", link, green),
                                     _contact(sender, green)],
                           party=party, req=req, sender=sender))
        if stage == "completed":
            return ((f"It's official - your new role as {new}" if is_change else f"It's official - congratulations, {first_name}! 🎉"),
                    _shell(preheader=f"Your letter is fully signed. {new} takes effect {eff}.",
                           company=company, accent=green, hero_bg="#14532d", hero_emoji="" if is_change else "&#127881;",
                           hero_title=("Your new role is official" if is_change else f"It's official, {first}!"),
                           hero_sub=f"Everyone has signed. You are <strong>{escape(new)}</strong> from {escape(eff)}.",
                           sections=[
                               move, pay_card,
                               _steps("What changes", [
                                   ("Your title and access", "Your new title and access in Nexus are already in place."),
                                   ("Your pay", (f"Your new pay applies from {eff} and appears on the payroll that "
                                                 "covers that date.") if change else "Your pay is unchanged."),
                                   ("Your letter", "The signed letter is attached and saved to My Documents in Nexus."),
                               ], green),
                               _contact(sender, green)],
                           party=party, req=req, sender=sender, security=False))
        return ((f"Your new role: {new}" if is_change else f"Congratulations, {first_name}! You've been promoted to {new} 🎉"),
                _shell(preheader=(f"Effective {eff}" + (f" - base pay up {_money(change['delta'], change['currency'], cents=change['unit'] == 'per hour')} {change['unit']}"
                                                        if change and change.get("delta") else "")
                                  + ". Review and sign your letter."),
                       company=company, accent=green, hero_bg="#14532d", hero_emoji="" if is_change else "&#128640;",
                       hero_title=("Your new role" if is_change else f"Congratulations, {first}!"),
                       hero_sub=((f"Your role is changing to <strong>{escape(new)}</strong>." if is_change else
                                  f"Your hard work hasn't gone unnoticed. You've been promoted to "
                                  f"<strong>{escape(new)}</strong>.") + f" Effective {escape(eff)}."),
                       sections=[
                           _p(f"Hi {first},<br><br>" + ("We're writing to confirm a change to your role. " if is_change else
                              "Thank you for everything you bring to the team - your work has made a real difference, "
                              "and we're delighted to recognize it. ")
                              + "The details are below. Please review and sign your letter to make it official."),
                           move, pay_card, _note(note, sender, green), resp,
                           _docs(docs, green) + _signed_line(signed_by or [], company, green),
                           _button("Review &amp; Sign Your Letter", link, green)
                           + f'<div style="font-family:{FONT};font-size:13px;color:{MUTED};margin-top:10px">'
                             f'{_after_me(after_me if after_me is not None else ([manager] if manager else []), "")}</div>',
                           _contact(sender, green)],
                       party=party, req=req, sender=sender))

    if kind == "separation":
        slate = "#334155"
        last = _long(d.get("last_day"))
        facts = _card("The details", [
            ("Last day", escape(last)),
            ("Company", escape(company)),
            ("Position", escape(d.get("job_title") or "")),
        ], slate)
        after = _steps("What to expect", [
            ("Final pay", "Your final paycheck includes pay through your last day, as required by law."),
            ("Benefits", "Information on continuing your benefits will be sent to you separately."),
            ("Company property", "Please return your laptop, badge, keys and any other company property by your last day."),
            ("Your access", ("Your work email and Nexus access have ended; this message and your signed copies "
                             "come to your personal email." if d.get("immediate") else
                             "Your work email and Nexus access end after your last day - save anything personal "
                             "before then. Your signed copies are emailed to you.")),
        ], slate)
        if stage == "completed":
            return (f"Your separation documents from {company} are complete",
                    _shell(preheader="Everything is signed - a copy is attached for your records.",
                           company=company, accent=slate, hero_bg=slate, hero_emoji="",
                           hero_title="Your documents are complete",
                           hero_sub=f"Thank you for your time with {escape(company)}. A signed copy is attached.",
                           sections=[facts, after, _contact(sender, slate)],
                           party=party, req=req, sender=sender, security=False))
        return (f"Your separation documents from {company}",
                _shell(preheader=f"Your last day is {_short(d.get('last_day'))}. Please review and sign.",
                       company=company, accent=slate, hero_bg=slate, hero_emoji="",
                       hero_title="Your separation documents",
                       hero_sub=(f"Thank you for your contributions to {escape(company)}. Here is what you need "
                                 "to know before your last day."),
                       sections=[facts, _note(note, sender, slate), after,
                                 _docs(docs, slate) + _signed_line(signed_by or [], company, slate),
                                 _button("Review &amp; Sign Your Documents", link, slate),
                                 _p("If anything is unclear, contact us below before you sign."),
                                 _contact(sender, slate)],
                       party=party, req=req, sender=sender))
    return None


# ── wiring ───────────────────────────────────────────────────────────────────

def _context(db: Session, ev: HrLifeEvent):
    e = db.query(HrEntity).filter(HrEntity.id == ev.entity_id).first() if ev.entity_id else None
    company = (e.legal_name or e.name) if e else "Greens"
    location = (e.physical_address or e.registered_address or "") if e else ""
    d = ev.inputs or {}
    mgr = (d.get("manager_email") or "").lower()
    if not mgr and ev.employee_id:
        emp = db.query(NexusEmployee).filter(NexusEmployee.id == ev.employee_id).first()
        mgr = (emp.manager_email or "").lower() if emp else ""
    manager = ""
    if mgr:
        m = db.query(NexusEmployee).filter(NexusEmployee.work_email == mgr).first()
        manager = ((m.display_name or f"{m.first_name} {m.last_name}").strip()) if m else ""
    return company, location, manager


def _docs_of(req) -> list:
    names = [req.title] + [x.get("name", "") for x in (getattr(req, "documents", None) or [])]
    return [n for n in names if n]


def _event_email(db: Session, req: HrSignRequest, party, sender: dict, link: str, stage: str):
    ev = db.query(HrLifeEvent).filter(HrLifeEvent.id == req.link_id).first() if req.link_id else None
    if not ev:
        return None
    is_subject = (getattr(party, "email", "") or "").lower() == (ev.subject_email or "").lower()
    role = "subject" if is_subject else (getattr(party, "role_key", "") or "")
    if not is_subject and not (ev.kind == "promotion" and role == "manager" and stage == "invite"):
        return None
    company, location, manager = _context(db, ev)
    # Who signed before this person (the packet arrives countersigned) and
    # who still signs after them - read from the envelope, never assumed.
    signed_by, after_me = [], []
    if stage == "invite" and req.id:
        mine = getattr(party, "ordinal", None) or 0
        for p in (db.query(HrSignParty).filter(HrSignParty.request_id == req.id)
                  .order_by(HrSignParty.ordinal).all()):
            if p.id == getattr(party, "id", "") or (p.party_role or "signer") != "signer":
                continue
            if p.status == "signed" and p.ordinal < mine:
                signed_by.append((p.name, p.signed_at or ""))
            elif p.ordinal > mine:
                after_me.append(p.name)
    return compose(ev.kind, stage=stage, role=role, first_name=(getattr(party, "name", "") or "").split(" ")[0],
                   company=company, location=location, inputs=ev.inputs or {}, pay=ev.pay or {}, manager=manager,
                   note=(req.message or "") if is_subject else "", docs=_docs_of(req), link=link, sender=sender,
                   party=party, req=req, subject_name=ev.subject_name, signed_by=signed_by, after_me=after_me)


def invite_email(db: Session, req: HrSignRequest, party: HrSignParty, sender: dict, link: str):
    """(subject, html) when it is this party's turn to sign, or None for
    Nexus Sign's own email."""
    return _event_email(db, req, party, sender, link, "invite")


def completed_email(db: Session, req: HrSignRequest, party, sender: dict, link: str):
    """(subject, html) for the person once everyone has signed (the signed PDF
    is attached by Nexus Sign), or None for the standard completion email."""
    return _event_email(db, req, party, sender, link, "completed")


SAMPLE = {
    "hire": ({"job_title": "Senior Analyst", "department": "Accounting", "start_date": "2026-11-02",
              "employment_type": "full_time"},
             {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"}),
    "promotion": ({"job_title": "Senior Analyst II", "old_title": "Senior Analyst", "department": "Accounting",
                   "effective_date": "2026-11-01", "change_type": "promotion",
                   "responsibilities": "Own the month-end close for two entities and review the junior analysts' reconciliations.",
                   "old_pay": {"base": 7000, "payBasis": "salary", "frequency": "monthly", "currency": "USD"}},
                  {"base": 8000, "payBasis": "salary", "frequency": "monthly", "currency": "USD"}),
    "separation": ({"last_day": "2026-10-31", "job_title": "Senior Analyst"}, {}),
}


def preview(db: Session, user: dict, event: str, entity_id: str, template_name: str, note: str,
            documents: list, role: str = "subject", stage: str = "invite") -> tuple:
    """What the email for `event` looks like - sample person and pay, the real
    company, the packet's own note and documents."""
    from routers import esign
    now = datetime.now(timezone.utc).isoformat()
    fake_req = HrSignRequest(id="preview", title=template_name or "Hiring Packet", source="template",
                             documents=[{"name": x} for x in documents], message=note, expires_on="",
                             entity_id=entity_id, created_by=user["email"], created_at=now, status="pending",
                             link_kind="life_event", link_id="", governing_law="CA", verify_token="")
    fake_party = HrSignParty(id="preview", request_id="preview",
                             name="Jane Doe" if role == "subject" else "Max Manager",
                             email="jane.doe@example.com", kind="external", role_key="employee", token="preview",
                             access_code="", phone="", org="", title="", ordinal=1, party_role="signer",
                             status="notified")
    try:
        sender = esign._sender_identity(db, fake_req)
    except Exception:
        sender = {"name": user["email"], "email": user["email"]}
    e = db.query(HrEntity).filter(HrEntity.id == entity_id).first() if entity_id else None
    company = (e.legal_name or e.name) if e else "Greens"
    location = (e.physical_address or e.registered_address or "") if e else ""
    inputs, pay = SAMPLE.get(event, ({}, {}))
    if event == "promotion" and role == "subject":
        fake_party.kind = "internal"          # an employee signs behind their Nexus login
    # The sample envelope: the company (the sender) has signed a hire or
    # separation before the person sees it; a promotion goes to the manager next.
    signed_by = [(sender.get("name") or "HR", now)] if event in ("hire", "separation") else []
    after_me = ["Max Manager"] if event == "promotion" else []
    return compose(event, stage=stage, role=role, first_name="Jane" if role == "subject" else "Max", company=company,
                   location=location, inputs=inputs, pay=pay, manager="Max Manager", note=note,
                   docs=_docs_of(fake_req), link="#", sender=sender, party=fake_party, req=fake_req,
                   subject_name="Jane Doe", signed_by=signed_by, after_me=after_me)
