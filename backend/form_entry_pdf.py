"""The PDF of one filled form (Forms & Checklists, Neil 11/02/2026).

Rendered through the Documents engine (services.doc_export.render_pdf) on the
company's default letterhead when one exists - the same page every other
Documents export uses, so a printed inspection matches a printed letter. The
page: the form's title, who submitted it and when (MM/DD/YYYY, 12-hour, in the
submitter's zone with its short name - the bell reads in the recipient's, the
CSV in the exporter's), the
site, the review state; then each section with its label / value rows, repeat
groups as a table, photos as thumbnails (read through the signed-URL path a
private bucket needs, each captioned "Photo 1 of 3" - when storage is not
configured the URL is printed instead), the signature image (else its URL),
and a map link for a location stamp.

`value_text(def, value)` is the one way an answer is written out - the CSV
export uses it too.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

import form_rules
from models import DocLetterhead, DocTemplate, HrWorkSite, NexusEmployee
from services.doc_export import _EMPTY_RUN_STYLE, render_pdf

MAX_THUMBS = 12
THUMB_WIDTH_PT = 180


# ── Text helpers ──────────────────────────────────────────────────────────

# The short name a US reader knows ("PT"), whatever the season; any other
# zone prints its own abbreviation ("IST").
_US_ZONE_NAMES = {
    "America/Los_Angeles": "PT", "America/Vancouver": "PT", "America/Tijuana": "PT",
    "America/Denver": "MT", "America/Phoenix": "MT", "America/Boise": "MT", "America/Edmonton": "MT",
    "America/Chicago": "CT", "America/Winnipeg": "CT",
    "America/New_York": "ET", "America/Detroit": "ET", "America/Toronto": "ET",
    "America/Anchorage": "AKT", "Pacific/Honolulu": "HT",
}


def zone_name(zone: str, local: datetime) -> str:
    return _US_ZONE_NAMES.get(zone) or local.strftime("%Z")


def us_datetime(iso: str, zone: str = "", named: bool = False) -> str:
    """'11/02/2026 2:14 PM' from an ISO stamp, in the reader's `zone` (an
    IANA name; stored stamps without an offset are UTC). No zone, or one
    ZoneInfo cannot read, reads in UTC as before. `named` adds the zone's
    short name ("2:14 PM PT", "2:14 PM IST"). The raw text when it is not a
    stamp."""
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    if len(iso) <= 10:   # a bare date has no time to move
        return dt.strftime("%m/%d/%Y")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    tz, name = timezone.utc, "UTC"
    if zone:
        try:
            tz = ZoneInfo(zone)
            name = ""
        except (ZoneInfoNotFoundError, ValueError):
            zone = ""
    local = dt.astimezone(tz)
    text = f"{local.strftime('%m/%d/%Y')} {local.strftime('%I:%M %p').lstrip('0')}"
    if named:
        text += f" {name or zone_name(zone, local)}"
    return text


def person_zone(db: Session, email: str) -> str:
    """The person's own time zone - daily_briefing._person_zone, the rule the
    ticket emails read (ticket_notify._zone_for): their shift preset's zone,
    else the company default. '' when it cannot be worked out."""
    em = (email or "").strip().lower()
    if not em:
        return ""
    try:
        import daily_briefing
        return daily_briefing._person_zone(db, em, daily_briefing.get_settings(db)) or ""
    except Exception:   # noqa: BLE001 - a missing zone reads as UTC, never a failed export
        return ""


def us_date(iso: str) -> str:
    try:
        return datetime.fromisoformat((iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


def map_link(gps: dict) -> str:
    try:
        return f"https://www.google.com/maps?q={float(gps['lat'])},{float(gps['lng'])}"
    except (KeyError, TypeError, ValueError):
        return ""


def value_text(d: dict, v) -> str:
    """One answer as a person reads it. Lists (photos) are joined with a
    space, a location is 'lat, lng (site)', yes / no is Yes / No, a date is
    MM/DD/YYYY, a number is plain."""
    if form_rules.is_blank(v):
        return ""
    ftype = (d or {}).get("type")
    if ftype in ("yesno", "checkbox") or isinstance(v, bool):
        y = form_rules._yes(v)
        return ("Yes" if y else "No") if y is not None else str(v)
    if ftype == "photo" or isinstance(v, list):
        return " ".join(value_text({}, x) for x in v if not form_rules.is_blank(x))
    if ftype == "gps" or (isinstance(v, dict) and "lat" in v):
        try:
            text = f"{float(v['lat']):.5f}, {float(v['lng']):.5f}"
        except (KeyError, TypeError, ValueError):
            return str(v)
        if v.get("siteName"):
            text += f" ({v['siteName']})"
        return text
    if ftype == "date":
        return us_date(str(v))
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (int, float)):
        return f"{v:.12g}"
    if isinstance(v, dict):
        return ", ".join(f"{k}: {value_text({}, x)}" for k, x in v.items())
    return str(v)


def person_name(db: Session, email: str) -> str:
    em = (email or "").strip().lower()
    if not em:
        return ""
    e = db.query(NexusEmployee).filter(NexusEmployee.work_email == em).first()
    if e is None:
        from sqlalchemy import func
        e = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == em).first()
    if e is None:
        return em
    return (e.display_name or f"{e.first_name or ''} {e.last_name or ''}").strip() or em


def site_name(db: Session, site_id: str) -> str:
    if not site_id:
        return ""
    s = db.query(HrWorkSite).filter(HrWorkSite.id == site_id).first()
    return s.name if s else ""


def group_label(group: str, members: list) -> str:
    """What a repeat group is called - ONE rule, shared with the screens
    (frontend/src/forms/formsModel.js groupLabel): its first member's
    section, else the group key humanized ("tires" -> "Tires", "tire_rows"
    -> "Tire Rows")."""
    section = str(((members or [{}])[0] or {}).get("section") or "").strip()
    if section:
        return section
    return " ".join(w[:1].upper() + w[1:].lower() for w in re.split(r"[\s_-]+", str(group or "")) if w)


STATUS_WORDS = {"submitted": "Submitted", "reviewed": "Reviewed", "follow_up": "Needs Follow-Up", "closed": "Closed"}


# ── Blocks ────────────────────────────────────────────────────────────────

def _run(text: str, bold: bool = False) -> dict:
    return {"text": text, "bold": bold, "italic": False, "underline": False, **_EMPTY_RUN_STYLE}


def _para(text: str, bold: bool = False) -> dict:
    return {"type": "paragraph", "align": "left", "runs": [_run(text, bold)]}


def _heading(text: str, level: int) -> dict:
    return {"type": "heading", "level": level, "align": "left", "runs": [_run(text, True)]}


def _cell(blocks: list) -> dict:
    return {"blocks": blocks, "background": None}


def _table(rows: list) -> dict:
    return {"type": "table", "rows": rows}


def _images_allowed() -> bool:
    """Thumbnails need the storage key (a private bucket is read through a
    signed URL); without it the URL is printed instead of a blank fetch."""
    try:
        from routers.files import _SERVICE_KEY
        return bool(_SERVICE_KEY)
    except Exception:   # noqa: BLE001 - no storage module, no pictures
        return False


def _photo_blocks(label: str, urls: list) -> list:
    """Each photo as a thumbnail captioned "Photo 1 of 3"; the URL is printed
    only when thumbnails cannot be drawn (no storage key)."""
    out = [_para(f"{label}:", True)]
    allowed = _images_allowed()
    shown = [x for x in urls if isinstance(x, str) and x.strip()][:MAX_THUMBS]
    for i, u in enumerate(shown, 1):
        if allowed:
            out.append({"type": "image", "src": u, "width": THUMB_WIDTH_PT / 0.75})
            out.append(_para(f"Photo {i} of {len(shown)}"))
        else:
            out.append(_para(u))
    return out


def _value_blocks(d: dict, v) -> list:
    """The blocks for one answer in a section table cell."""
    ftype = d.get("type")
    if ftype == "gps" and isinstance(v, dict):
        text = value_text(d, v)
        link = map_link(v)
        return [_para(text), _para(f"Map: {link}")] if link else [_para(text)]
    return [_para(value_text(d, v))]


def build_blocks(db: Session, entry, tpl: DocTemplate, defs: list) -> list:
    """The body of the entry's page."""
    answers = entry.answers if isinstance(entry.answers, dict) else {}
    blocks = [_heading(entry.title or tpl.name, 1)]
    who = person_name(db, entry.submitted_by)
    # Times read in the submitter's own zone, named ("2:14 PM PT").
    zone = person_zone(db, entry.submitted_by)
    line = f"Submitted by {who} on {us_datetime(entry.submitted_at, zone, named=True)}"
    site = site_name(db, entry.work_site_id)
    if site:
        line += f" at {site}"
    blocks.append(_para(line))
    state = STATUS_WORDS.get(entry.status or "submitted", entry.status or "")
    review = f"Status: {state}"
    if entry.reviewer_email:
        review += f" by {person_name(db, entry.reviewer_email)} on {us_datetime(entry.reviewed_at, zone, named=True)}"
    if entry.review_note:
        review += f". Note: {entry.review_note}"
    blocks.append(_para(review))

    by_group = form_rules.groups(defs)
    singles = [d for d in defs if not form_rules.group_of(d)]
    shown = form_rules.visible_tokens(singles, answers)
    sections = form_rules.sections(defs) or []
    ordered = sections + ([""] if any(not d.get("section") for d in singles) else [])
    for section in ordered:
        fields = [d for d in singles if (d.get("section") or "") == section and d.get("token") in shown]
        groups_here = [g for g, members in by_group.items() if (members[0].get("section") or "") == section]
        if not fields and not groups_here:
            continue
        blocks.append(_heading(section or "Details", 3))
        rows, after = [], []
        for d in fields:
            v = answers.get(d["token"])
            if d.get("type") == "photo":
                if not form_rules.is_blank(v):
                    after.extend(_photo_blocks(d.get("label") or d["token"], v if isinstance(v, list) else [v]))
                continue
            if d.get("type") == "signature":
                if isinstance(v, str) and v.strip():
                    after.append(_para(f"{d.get('label') or 'Signature'}:", True))
                    if _images_allowed():
                        after.append({"type": "image", "src": v, "width": THUMB_WIDTH_PT / 0.75})
                    else:
                        after.append(_para(v))   # the link only when the picture cannot be drawn
                continue
            rows.append([_cell([_para(d.get("label") or d["token"], True)]), _cell(_value_blocks(d, v))])
        if rows:
            blocks.append(_table(rows))
        blocks.extend(after)
        for g in groups_here:
            members = by_group[g]
            entries = answers.get(g) if isinstance(answers.get(g), list) else []
            blocks.append(_para(group_label(g, members), True))
            if not entries:
                blocks.append(_para("No rows"))
                continue
            header = [_cell([_para("#", True)])] + [_cell([_para(d.get("label") or d["token"], True)]) for d in members]
            table_rows = [header]
            for i, row in enumerate(entries):
                row = row if isinstance(row, dict) else {}
                table_rows.append([_cell([_para(str(i + 1))])]
                                  + [_cell([_para(value_text(d, row.get(d["token"])))]) for d in members])
            blocks.append(_table(table_rows))
    return blocks


def default_letterhead(db: Session):
    lh = db.query(DocLetterhead).filter(DocLetterhead.is_default == True).first()  # noqa: E712
    if lh is None:
        return None
    from routers.documents import _ser_letterhead
    return _ser_letterhead(lh)


def render(db: Session, entry, tpl: DocTemplate, defs: list | None = None) -> bytes:
    """The entry as PDF bytes."""
    if defs is None:
        from routers.documents import _released
        defs = _released(db, tpl)["fieldDefs"]
    blocks = build_blocks(db, entry, tpl, defs or [])
    title = f"{entry.title or tpl.name} - {us_date(entry.submitted_at)}"
    return render_pdf(title, [], [blocks], [], default_letterhead(db), {})
