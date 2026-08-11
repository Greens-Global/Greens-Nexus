"""Weekly report -> PDF, in the format of the supplied sample (Sagar, Aug 5).

ONE FILE, TWO DOCUMENTS. That is the shape of the sample and it is why this uses
BaseDocTemplate with two page templates rather than the simpler
SimpleDocTemplate:

  page 1      "Construction Update" - four sections, bullets, no images.
              Header: logo, then Project Name / Project No / Date.
  pages 2..n  the photo log. Different header entirely (Printed on, Job #, site
              address), two photos per page, each with its own metadata column,
              and its OWN page numbering restarting at "Page 1 of N".

The footer numbering is the reason for _numbered_canvas. "Page 1 of 6" in the
sample counts photo pages only - the update page is not page zero of anything -
and a total is not knowable until every page is laid out. So pages are buffered
and the footer is stamped on the way out.

WHAT THIS DELIBERATELY DROPPED from the previous version: a six-column stats
table (daily logs / crew-days / hours / photos / videos / safety flags), a
per-section daily-log listing, separate Risks and Recommendations blocks, and
nine narrative headings. None of them appear in the sample. They are all still
STORED on the report row and shown in the app; they just are not part of this
document.

Videos are still links rather than embeds - a clip cannot be embedded in a PDF
anyone can reliably open, and a 100 MB attachment is undeliverable. They are
listed at the end of the photo log.

Manager text wins everywhere: each section renders `text` (what the manager
approved), falling back to `ai_text` only when nobody edited it.
"""
import io
import os
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as _canvas
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether,
                                NextPageTemplate, PageBreak, PageTemplate,
                                Paragraph, Table, TableStyle)

import construction_report

_INK = colors.HexColor("#111827")
_DIM = colors.HexColor("#6b7280")
_RULE = colors.HexColor("#c9c9c9")
_LINK = colors.HexColor("#1155cc")

# The sample runs two photos to a page.
_PHOTOS_PER_PAGE = 2

# Served from the frontend's public/ tree; this is the same asset main.py seeds
# the Knowledge Base letterhead with. Absent is not fatal - see _logo.
_LOGO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "frontend", "public", "assets", "branding", "greens-global-logo.png")


def _escape(s) -> str:
    """reportlab's paraparser reads a Paragraph as mini-HTML, so a caption
    containing & or < would throw or silently swallow text."""
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _styles():
    ss = getSampleStyleSheet()
    return {
        # Centered and underlined, as in the sample. <u> rather than a drawn rule
        # so the line tracks the text width instead of the frame width.
        "doctitle": ParagraphStyle("dt", parent=ss["Normal"], fontName="Helvetica-Bold",
                                   fontSize=13, leading=17, alignment=TA_CENTER,
                                   textColor=_INK, spaceBefore=10, spaceAfter=16),
        "h": ParagraphStyle("h", parent=ss["Normal"], fontName="Helvetica-Bold",
                            fontSize=10.5, leading=14, textColor=_INK,
                            spaceBefore=14, spaceAfter=8),
        "bullet": ParagraphStyle("b", parent=ss["Normal"], fontSize=9.5, leading=13.5,
                                 textColor=_INK, alignment=TA_LEFT,
                                 leftIndent=18, bulletIndent=6, spaceAfter=3),
        "meta": ParagraphStyle("m", parent=ss["Normal"], fontSize=8, leading=11,
                               textColor=_INK),
        "metalabel": ParagraphStyle("ml", parent=ss["Normal"], fontSize=8, leading=11,
                                    textColor=_DIM),
        "hdr": ParagraphStyle("hd", parent=ss["Normal"], fontSize=8.5, leading=11.5,
                              textColor=_INK),
        "note": ParagraphStyle("n", parent=ss["Normal"], fontSize=8, leading=11,
                               textColor=_DIM, spaceBefore=8),
    }


def _logo(width=42 * mm):
    """The letterhead mark, or None when the asset is missing.

    A missing logo must not fail the render: the report is the deliverable and a
    file-layout change should degrade the letterhead, not block the week."""
    try:
        if os.path.exists(_LOGO):
            return Image(_LOGO, width=width, height=width * 0.28, kind="proportional")
    except Exception:
        pass
    return None


def _fmt_date(value, fmt="%m/%d/%Y") -> str:
    """ISO -> the sample's US format. Returns the input unchanged if unparseable
    rather than printing an empty cell, so a bad value is visible."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw[:10]
    # Zero-padded and lowercase meridiem: "06/05/2026", "06/04/2026 at 02:37 pm".
    return d.strftime(fmt).replace("AM", "am").replace("PM", "pm")


def _fmt_stamp(dt: datetime) -> str:
    """'Sun Jun 7, 2026 at 12:01 pm' - the sample's printed-on line."""
    tz = dt.strftime("%Z") or "UTC"
    return (dt.strftime("%a %b ") + str(dt.day) + dt.strftime(", %Y at ")
            + dt.strftime("%I:%M %p").lstrip("0").lower() + f" {tz}")


# ── Page furniture ───────────────────────────────────────────────────────────
def _header_update(cv, doc, project, report):
    """Page 1: logo left, project identity right."""
    cv.saveState()
    top = doc.pagesize[1] - 14 * mm
    lg = _logo()
    if lg:
        lg.drawOn(cv, doc.leftMargin, top - lg.drawHeight)
    x = doc.pagesize[0] - doc.rightMargin
    cv.setFillColor(_INK)
    rows = [("Project Name: ", project.name or ""),
            ("Project No: ", project.code or ""),
            ("Date: ", _fmt_date(report.published_at or report.generated_at or ""))]
    y = top - 4 * mm
    for label, value in rows:
        cv.setFont("Helvetica", 8.5)
        w_val = cv.stringWidth(str(value), "Helvetica-Bold", 8.5)
        cv.drawRightString(x - w_val, y, label)
        cv.setFont("Helvetica-Bold", 8.5)
        cv.drawRightString(x, y, str(value))
        y -= 4.4 * mm
    cv.restoreState()


def _header_photos(cv, doc, project, printed_at):
    """Photo log: logo left; printed-on, job number and site address right."""
    cv.saveState()
    top = doc.pagesize[1] - 12 * mm
    lg = _logo(38 * mm)
    if lg:
        lg.drawOn(cv, doc.leftMargin, top - lg.drawHeight)
    x = doc.pagesize[0] - doc.rightMargin
    cv.setFillColor(_INK)
    cv.setFont("Helvetica", 7.6)
    job = " - ".join([p for p in [project.code or "", project.name or ""] if p])
    lines = [f"Printed on {_fmt_stamp(printed_at)}"]
    if job:
        lines.append(f"Job #: {job}")
    lines += [ln for ln in (project.address or "").split("\n") if ln.strip()]
    y = top - 2 * mm
    for ln in lines:
        cv.drawRightString(x, y, ln)
        y -= 3.9 * mm
    # The rule the sample runs under the header block.
    cv.setStrokeColor(_RULE)
    cv.setLineWidth(0.6)
    rule_y = min(y - 1 * mm, top - (lg.drawHeight if lg else 0) - 3 * mm)
    cv.line(doc.leftMargin, rule_y, doc.pagesize[0] - doc.rightMargin, rule_y)
    cv.restoreState()


def _numbered_canvas(photo_pages: set):
    """Canvas that stamps 'Page N of M' on photo-log pages only.

    Two-pass by necessity: the total is not known until the last page is laid
    out, so pages are buffered and the footer written during save(). The count
    covers photo pages ONLY and restarts at 1, matching the sample - the update
    page is not page zero of the photo log."""
    class _C(_canvas.Canvas):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._saved = []

        def showPage(self):
            self._saved.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            ordered = sorted(photo_pages)
            total = len(ordered)
            for i, state in enumerate(self._saved, start=1):
                self.__dict__.update(state)
                if total and i in photo_pages:
                    self.setFont("Helvetica", 7.6)
                    self.setFillColor(_INK)
                    self.drawCentredString(self._pagesize[0] / 2.0, 10 * mm,
                                           f"Page {ordered.index(i) + 1} of {total}")
                super().showPage()
            super().save()
    return _C


# ── Photo log ────────────────────────────────────────────────────────────────
def _fetch(url: str) -> bytes:
    """Bytes behind a media row's url. Handles the inline (data:) case, which a
    laptop with no Supabase produces - see services/construction_storage.is_inline."""
    if (url or "").startswith("data:"):
        import base64
        return base64.b64decode((url.split(",", 1) + [""])[1])
    import httpx
    with httpx.Client(timeout=30) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.content


def _photo_block(m, st, avail_w):
    """One photo row: metadata column left, image right, as in the sample."""
    try:
        img = Image(io.BytesIO(_fetch(m.url)), width=avail_w * 0.66,
                    height=52 * mm, kind="proportional")
    except Exception:
        # One unreachable object must not fail the document - the rest of the
        # week is still worth delivering.
        return None

    def row(label, value, link=False):
        v = _escape(value)
        if link and value:
            v = f'<font color="#1155cc">{v}</font>'
        return [Paragraph(_escape(label), st["metalabel"]),
                Paragraph(v or "", st["meta"])]

    # File name is elided the way the sample does, keeping the extension-free
    # head so two rows are still distinguishable.
    fname = (m.egnyte_path or m.storage_path or "").rsplit("/", 1)[-1] or (m.id or "")
    if len(fname) > 22:
        fname = fname[:22] + "..."

    meta = Table([
        row("", (m.ai_categories[0] if getattr(m, "ai_categories", None) else "") or "Unclassified"),
        row("Description", m.caption or m.description or m.ai_caption or ""),
        row("Taken Date", _fmt_date(m.taken_at, "%m/%d/%Y at %I:%M %p")),
        row("Upload Date", _fmt_date(m.uploaded_at, "%m/%d/%Y at %I:%M %p")),
        row("Uploaded By", (m.uploaded_by or "").split("@")[0].replace(".", " ").title()),
        row("File Name", fname, link=True),
    ], colWidths=[avail_w * 0.13, avail_w * 0.19])
    meta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))

    block = Table([[meta, img]], colWidths=[avail_w * 0.32, avail_w * 0.68])
    block.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, _RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return KeepTogether(block)


# ── Build ────────────────────────────────────────────────────────────────────
def build(report, project, media_by_id: dict, logs: list) -> bytes:
    """Render one report. `media_by_id` is {id: ConstructionMedia}."""
    st = _styles()
    buf = io.BytesIO()
    printed_at = datetime.now(timezone.utc)
    photo_pages = set()

    doc = BaseDocTemplate(buf, pagesize=LETTER,
                          leftMargin=20 * mm, rightMargin=20 * mm,
                          topMargin=34 * mm, bottomMargin=18 * mm,
                          title=report.title or "Construction Update",
                          author="Greens Global")
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def on_photos(cv, d):
        photo_pages.add(cv.getPageNumber())
        _header_photos(cv, d, project, printed_at)

    doc.addPageTemplates([
        PageTemplate(id="update", frames=[frame],
                     onPage=lambda cv, d: _header_update(cv, d, project, report)),
        PageTemplate(id="photos", frames=[frame], onPage=on_photos),
    ])

    flow = [Paragraph("<u>Construction Update</u>", st["doctitle"])]

    sections = report.sections or {}
    order = report.section_order or [k for k, _ in construction_report.SECTIONS]
    labels = dict(construction_report.SECTIONS)

    for key in order:
        sec = sections.get(key) or {}
        # Manager text wins; ai_text is the fallback for an unedited section.
        text = (sec.get("text") or sec.get("ai_text") or "").strip()
        if not text:
            continue
        flow.append(Paragraph(f"<u>{_escape(labels.get(key, key.replace('_', ' ').title()))}</u>",
                              st["h"]))
        for line in text.split("\n"):
            if line.strip():
                flow.append(Paragraph(_escape(line.strip()), st["bullet"],
                                      bulletText="•"))

    # ── Photo log ────────────────────────────────────────────────────────────
    shots = [media_by_id[s["id"]]
             for s in ({"id": i} for i in (report.media_ids or []))
             if s["id"] in media_by_id and media_by_id[s["id"]].kind == "photo"]
    vids = [media_by_id[i] for i in (report.media_ids or [])
            if i in media_by_id and media_by_id[i].kind == "video"]

    if shots or vids:
        flow.append(NextPageTemplate("photos"))
        flow.append(PageBreak())
        placed = 0
        for m in shots:
            block = _photo_block(m, st, doc.width)
            if block is None:
                continue
            # PER_PAGE is a layout decision, not a consequence of image height:
            # let these flow and three fit, which reads nothing like the sample.
            if placed and placed % _PHOTOS_PER_PAGE == 0:
                flow.append(PageBreak())
            flow.append(block)
            placed += 1
        if vids:
            flow.append(Paragraph("<u>Site Video</u>", st["h"]))
            for m in vids:
                href = m.egnyte_web_url or m.url
                name = m.caption or m.ai_caption or m.description or "Site video"
                dur = f" ({int(m.duration_s)}s)" if m.duration_s else ""
                flow.append(Paragraph(
                    f'&bull; <link href="{_escape(href)}" color="#1155cc">'
                    f'{_escape(name)}{dur}</link>', st["bullet"]))

    if (report.ai_model or "").startswith("fallback"):
        flow.append(Paragraph(
            "Summary of Progress was assembled from the daily logs without AI assistance.",
            st["note"]))

    doc.build(flow, canvasmaker=_numbered_canvas(photo_pages))
    return buf.getvalue()
