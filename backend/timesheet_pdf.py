"""The time sheet pages of the signed Time Sheet PDF (Charmi, Oct 20 2026:
"the way our timesheet UI is"). SwipeClock's Time Card Report, cell for cell
what the Time Sheet screen draws (PayrollTimecard.jsx): one row per shift, a
Break row under it for each break punched, the day's total on its last row,
the week's total in a yellow band, the note line under a day, then the
totals and the HOURS / WAGE summary. Hourly and salaried cards each get
their own columns, as on screen.

Landscape, built with platypus; timesheet_review.build_pdf adds the portrait
signature page after these, so no signature field moves.

Only what the employee may read is printed - they are the signer: the
manager / HR day note never travels (Neil, Oct 12: supervisor notes are not
shown to employees); the employee's own note and the punch reasons do.
"""
from __future__ import annotations

import io
from datetime import date, timedelta
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

PAGE = landscape(letter)
MARGIN = 30
WIDTH = PAGE[0] - 2 * MARGIN - 12      # the frame keeps 6pt of padding each side

INK = colors.HexColor("#1a1a1f")
DIM = colors.HexColor("#6b6b75")
LINE = colors.HexColor("#c4c7cd")
HEAD = colors.HexColor("#e3e5e8")
BAND = colors.HexColor("#f2f3f5")
WEEK = colors.HexColor("#fdf3c4")
EDITED = colors.HexColor("#1d4ed8")
RED = colors.HexColor("#b91c1c")
AMBER = colors.HexColor("#b45309")
BLUE = colors.HexColor("#2563eb")
PURPLE = colors.HexColor("#6d28d9")

_CELL = ParagraphStyle("cell", fontName="Helvetica", fontSize=7.5, leading=9, alignment=1, textColor=INK)
_LEFT = ParagraphStyle("left", parent=_CELL, alignment=0)
_RIGHT = ParagraphStyle("right", parent=_CELL, alignment=2)
_HEAD = ParagraphStyle("head", parent=_CELL, fontName="Helvetica-Bold")
_TEXT = ParagraphStyle("text", fontName="Helvetica", fontSize=8.5, leading=11, textColor=INK)

# Markers the server writes on punches that are not a reason (segReasons).
_INTERNAL_NOTES = {"payroll edit"}
# A salaried day's status, as the Day column names it (FixedTimecard STATUS).
_STATUS = {"working": "Working", "present": "Present", "late": "Late", "half": "Half Day",
           "absent": "Absent", "sick": "Sick", "vacation": "Vacation", "personal": "Personal",
           "holiday": "Holiday", "holiday_half": "Half-Day Holiday", "holiday_half_worked": "Half-Day Holiday",
           "weekend": "Weekend", "weekend_worked": "Weekend OT", "upcoming": "Upcoming"}


def hm(minutes) -> str:
    m = int(minutes or 0)
    return f"{m // 60}:{m % 60:02d}"


def hd(minutes) -> str:
    """SwipeClock's '44:05 (44.08)': clock time and decimal hours."""
    return f"{hm(minutes)} ({int(minutes or 0) / 60:.2f})"


def money(v, currency: str = "USD") -> str:
    # The PDF's core fonts have no rupee sign: other currencies print their code.
    cur = (currency or "USD").upper()
    return f"${float(v or 0):,.2f}" if cur == "USD" else f"{cur} {float(v or 0):,.2f}"


def day_label(ds: str) -> str:
    d = date.fromisoformat(ds)
    return f"{d.strftime('%a')} {d.month:02d}/{d.day:02d}"


def _p(text: str, style=_CELL, color=None, bold=False, italic=False) -> Paragraph:
    s = escape(str(text))
    if bold and italic:
        s = f"<b><i>{s}</i></b>"
    elif bold:
        s = f"<b>{s}</b>"
    elif italic:
        s = f"<i>{s}</i>"
    if color is not None:
        s = f'<font color="#{color.hexval()[2:]}">{s}</font>'
    return Paragraph(s, style)


def _reasons(seg: dict) -> list:
    """The human reasons on a shift's punches, each once (segReasons)."""
    out = []
    if seg.get("inEditStatus") == "pending" and seg.get("inEditReason"):
        out.append(f"Proposed in-time: {seg['inEditReason']}")
    if seg.get("outEditStatus") == "pending" and seg.get("outEditReason"):
        out.append(f"Proposed out-time: {seg['outEditReason']}")
    for n in [seg.get("inAdjustNote"), seg.get("outAdjustNote"), *str(seg.get("note") or "").split(" · ")]:
        t = (n or "").strip()
        if t and t.lower() not in _INTERNAL_NOTES and t not in out:
            out.append(t)
    return out


class _Grid:
    """Rows and their TableStyle commands, built together."""

    def __init__(self, header: list):
        self.rows = [[_p(h, _HEAD) for h in header]]
        self.cmds = [("BACKGROUND", (0, 0), (-1, 0), HEAD)]
        self.ncols = len(header)

    def add(self, cells: list, band: bool = False) -> int:
        self.rows.append(cells)
        i = len(self.rows) - 1
        if band:
            self.cmds.append(("BACKGROUND", (0, i), (-1, i), BAND))
        return i

    def line(self, para: Paragraph, bg=None) -> int:
        """A full-width line: a week total, a note, a holiday."""
        i = self.add([para] + [""] * (self.ncols - 1))
        self.cmds.append(("SPAN", (0, i), (-1, i)))
        if bg is not None:
            self.cmds.append(("BACKGROUND", (0, i), (-1, i), bg))
        return i

    def span_down(self, cols, top: int, bottom: int) -> None:
        if bottom > top:
            self.cmds.extend(("SPAN", (c, top), (c, bottom)) for c in cols)

    def table(self, widths: list) -> LongTable:
        t = LongTable(self.rows, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, LINE),
                               ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                               ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                               ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                               *self.cmds]))
        return t


def _time_cell(iso: str, pid: str, ctx: dict, *, missing: bool = True) -> Paragraph:
    """A punch time; one someone entered or changed reads bold blue (SwipeClock)."""
    if not iso:
        return _p("Missing", color=RED, bold=True) if missing else _p("-")
    meta = (ctx["punch_meta"] or {}).get(pid) or {}
    edited = bool(meta.get("manual") or meta.get("adjustedAt"))
    return _p(ctx["time"](iso, pid), color=EDITED if edited else None, bold=edited)


def _note_line(g: _Grid, ds: str, segs: list, ctx: dict, indent: bool = True) -> None:
    parts = []
    emp = ((ctx["notes"] or {}).get(ds) or {}).get("employeeNote") or ""
    if emp.strip():
        parts.append(f"<b>Note by employee:</b> {escape(emp.strip())}")
    reasons = [r for s in segs for r in _reasons(s)]
    reasons = [r for i, r in enumerate(reasons) if r not in reasons[:i]]
    if reasons:
        parts.append(f"<b>On the punches:</b> <i>{escape(ctx['names_in']('  ·  '.join(reasons)))}</i>")
    if parts:
        style = ParagraphStyle("note", parent=_LEFT, leftIndent=14 if indent else 0)
        g.line(Paragraph("<br/>".join(parts), style))


def _auto_line(g: _Grid, segs: list) -> None:
    if any("auto_clock_out" in (s.get("flags") or []) for s in segs):
        g.line(_p("Auto-closed at end of day - no clock-out was recorded. The day is held at 0 hours.",
                  _LEFT, color=RED, bold=True))


def hourly_rows(card: dict, ctx: dict) -> Table:
    cur = card.get("currency") or "USD"
    g = _Grid(["Date", "In", "Out", "Deducted Time", "Category", "Hours", "Hrs/Day", "Non-OT", "OT", "Loc",
               "Pay Rate", "Wage"])
    by_date = {d["date"]: d for d in card.get("days") or []}
    start, end = date.fromisoformat(ctx["start"]), date.fromisoformat(ctx["end"])
    week, week_min = None, 0

    def week_line():
        ws = date.fromisoformat(week)
        we = ws + timedelta(days=6)
        g.line(_p(f"Total hours clocked for week of {ws.month}/{ws.day} to {we.month}/{we.day}: {hm(week_min)}",
                  bold=True), WEEK)

    for n in range((end - start).days + 1):
        ds = (start + timedelta(days=n)).isoformat()
        d = by_date.get(ds) or {}
        wk = d.get("weekStart") or (start + timedelta(days=n - (start + timedelta(days=n)).isoweekday() % 7)).isoformat()
        if week and wk != week:
            week_line()
            week_min = 0
        week = wk
        week_min += int(d.get("workedMin") or 0)
        band = n % 2 == 1
        segs = d.get("segments") or []
        rate = money(d.get("rate", card.get("rate")), cur) + "/hr"
        if not segs:
            g.add([_p(day_label(ds), _LEFT, bold=True, italic=True)] + [_p("-")] * 11, band)
            if d.get("isHoliday"):
                half = d.get("holidayType") == "half_day"
                g.line(_p(f"{'Half-Day Holiday' if half else 'Holiday'}: {d.get('holidayName') or 'Company holiday'}"
                          f" - not worked, paid {money(d.get('holidayPay'), cur)}{' (half day)' if half else ''}.",
                          _LEFT, color=BLUE, bold=True))
            continue
        first_row = len(g.rows)
        for si, seg in enumerate(segs):
            leave = bool(seg.get("payClass"))
            ot = " · ".join(x for x in [hm(seg["otMin"]) if seg.get("otMin") else "",
                                        f"{hm(seg['dtMin'])} 2x" if seg.get("dtMin") else ""] if x) or "-"
            top = g.add([
                _p(day_label(ds), _LEFT, color=RED if leave else None, bold=True, italic=True) if si == 0 else "",
                _time_cell(seg.get("inR") or seg.get("in"), seg.get("inId") or "", ctx),
                _p(ctx["time"](seg.get("outR") or seg.get("out"), seg.get("outId") or "") + " (auto)",
                   color=RED, bold=True) if "auto_clock_out" in (seg.get("flags") or [])
                else _time_cell(seg.get("outR") or seg.get("out"), seg.get("outId") or "", ctx),
                _p(f"-{seg['deductedMin']}m", color=AMBER) if seg.get("deductedMin") else _p("-"),
                _p(seg.get("category") or "-", color=RED if leave else None),
                _p(hm(seg.get("workedMin")), bold=True),
                "",   # Hrs/Day, filled below
                _p(hm(seg["regMin"]) if seg.get("regMin") else "-"),
                _p(ot, color=RED if seg.get("dtMin") else AMBER if seg.get("otMin") else None,
                   bold=bool(seg.get("otMin") or seg.get("dtMin"))),
                _p(seg.get("workSite") or seg.get("workSiteOut") or "-"),
                _p(rate, _RIGHT),
                _p(money(seg.get("amount"), cur), _RIGHT, bold=True),
            ], band)
            for b in seg.get("breaks") or []:
                g.add([_p("Break", _LEFT, color=DIM, italic=True),
                       _time_cell(b.get("start"), b.get("startId") or "", ctx),
                       _time_cell("" if b.get("implicit") else b.get("end"), b.get("endId") or "", ctx),
                       "", "", "", "", "", "", "", "", ""], band)
            # Merged down over the shift's Break rows, as on screen.
            g.span_down((3, 4, 5, 7, 8, 9, 10, 11), top, len(g.rows) - 1)
        # Hrs/Day: the day's total on its last row, an arrow down to it above.
        for i in range(first_row, len(g.rows)):
            g.rows[i][6] = (_p(hm(d.get("workedMin")), bold=True) if i == len(g.rows) - 1
                            else Paragraph('<font name="Symbol">↓</font>', _CELL))
        _auto_line(g, segs)
        if d.get("meal") or d.get("mealPremiumMin") or d.get("restPremiumMin"):
            bits = []
            if d.get("meal"):
                bits.append(f"{d['meal'].get('chip', '')} - {d['meal'].get('label', '')}.")
            for key, pay, label in (("mealPremiumMin", "mealPremiumPay", "Meal Premium"),
                                    ("restPremiumMin", "restPremiumPay", "Rest Premium")):
                if d.get(key):
                    bits.append(f"{label}: 1 hour of pay ({money(d.get(pay), cur)})")
            g.line(_p("   ".join(bits), _LEFT, color=AMBER, bold=True))
        if d.get("holidayPay"):
            g.line(_p(f"Half-Day Holiday: {d.get('holidayName') or 'Company holiday'} - worked the half day, plus "
                      f"{money(d['holidayPay'], cur)} credited for the other half.", _LEFT, color=BLUE, bold=True))
        if d.get("diffMin") or d.get("callBackMin"):
            bits = [f"{x.get('name')}: {hm(x.get('min'))} worked in the window - {money(x.get('pay'), cur)}"
                    for x in d.get("differentials") or []]
            if d.get("callBackMin"):
                bits.append(f"Call-Back Pay: {hm(d['callBackMin'])} short of the minimum - "
                            f"{money(d.get('callBackPay'), cur)}")
            g.line(_p("   ".join(bits), _LEFT, color=PURPLE, bold=True))
        _note_line(g, ds, segs, ctx)
    if week:
        week_line()

    t = card.get("totals") or {}
    worked = int(t.get("regMin") or 0) + int(t.get("otMin") or 0) + int(t.get("dtMin") or 0)
    ot = " · ".join(x for x in [hm(t["otMin"]) if t.get("otMin") else "",
                                f"{hm(t['dtMin'])} 2x" if t.get("dtMin") else ""] if x) or "-"
    i = g.add([_p("Total Worked", _LEFT, bold=True), "", "", _p(f"-{t['deductedMin']}m" if t.get("deductedMin") else "-", bold=True),
               "", _p(hm(worked), bold=True), "", _p(hm(t.get("regMin")), bold=True), _p(ot, bold=True), "", "",
               _p(money(float(t.get("regPay") or 0) + float(t.get("otPay") or 0) + float(t.get("dtPay") or 0), cur),
                  _RIGHT, bold=True)])
    g.cmds += [("SPAN", (0, i), (2, i)), ("BACKGROUND", (0, i), (-1, i), HEAD)]
    for label, mk, pk in (("Sick", "sickMin", "sickPay"), ("Vacation", "vacationMin", "vacationPay"),
                          ("Personal", "personalMin", "personalPay")):
        if t.get(mk):
            i = g.add([_p(f"Time Off - {label}", _LEFT, color=RED, bold=True), "", "", "", _p(label),
                       _p(hm(t[mk]), bold=True), "", "", "", "", "", _p(money(t.get(pk), cur), _RIGHT, bold=True)])
            g.cmds += [("SPAN", (0, i), (2, i)), ("BACKGROUND", (0, i), (-1, i), HEAD)]
    return g.table([62, 54, 58, 48, 72, 40, 42, 42, 54, 124, 58, 66])


def hourly_summary(card: dict) -> list:
    """The HOURS / WAGE lines under the grid - the Time Sheet's summary box."""
    t = card.get("totals") or {}
    cur = card.get("currency") or "USD"
    rate = float(card.get("rate") or 0)
    split = len(card.get("rateSplits") or []) > 1

    def at(mult):
        return "" if split else f" at {money(rate * mult, cur)}/hr"

    rows = [(f"Total Regular hours{at(1)}", hd(t.get("regMin")), money(t.get("regPay"), cur)),
            (f"Total Overtime hours{at(1.5)}", hd(t.get("otMin")), money(t.get("otPay"), cur))]
    if t.get("dtMin"):
        rows.append((f"Total Double-time hours{at(2)}", hd(t["dtMin"]), money(t.get("dtPay"), cur)))
    for label, mk, pk in (("Sick", "sickMin", "sickPay"), ("Vacation", "vacationMin", "vacationPay"),
                          ("Personal", "personalMin", "personalPay")):
        if t.get(mk):
            rows.append((f"Total {label} hours{at(1)}", hd(t[mk]), money(t.get(pk), cur)))
    rows += [(f"{x.get('name')} (shift differential)", hd(x.get("min")), money(x.get("pay"), cur))
             for x in t.get("differentials") or []]
    if t.get("callBackMin"):
        rows.append((f"Call-Back Pay (minimum not worked){at(1)}", hd(t["callBackMin"]), money(t.get("callBackPay"), cur)))
    if t.get("holidayDays"):
        n = int(t["holidayDays"])
        rows.append((f"Company holiday{'' if n == 1 else 's'} ({n} day{'' if n == 1 else 's'}, not worked)", "-",
                     money(t.get("holidayPay"), cur)))
    if t.get("mealPremiumMin"):
        rows.append((f"Meal Premium ({int(t['mealPremiumMin']) // 60} x 1 hour of pay)", "-",
                     money(t.get("mealPremiumPay"), cur)))
    if t.get("restPremiumMin"):
        rows.append((f"Rest Premium ({int(t['restPremiumMin']) // 60} x 1 hour of pay)", "-",
                     money(t.get("restPremiumPay"), cur)))
    worked = t.get("workedMin")
    if worked is None:
        worked = int(t.get("regMin") or 0) + int(t.get("otMin") or 0) + int(t.get("dtMin") or 0)
    rows.append(("TOTALS", hd(worked), money(t.get("totalPay"), cur)))
    rows.append(("TOTAL EDITED PUNCHES", str(int(t.get("editedPunches") or 0)), ""))
    rows.append(("MISSING PUNCHES", str(int(t.get("missingPunches") or 0)), ""))
    return rows


def fixed_rows(card: dict, ctx: dict) -> Table:
    cur = card.get("currency") or "USD"
    g = _Grid(["Date", "Day", "In", "Out", "Category", "Total Hours", "Effect on Pay"])
    by_date = {d["date"]: d for d in card.get("days") or []}
    for n, fd in enumerate(card.get("fixedDays") or []):
        ds = fd["date"]
        segs = (by_date.get(ds) or {}).get("segments") or []
        band = n % 2 == 1
        status = _STATUS.get(fd.get("status"), (fd.get("status") or "").replace("_", " ").title())
        # A missed day covered by approved time off is named after it.
        if fd.get("timeOff") and fd.get("status") in ("absent", "half"):
            status = f"{fd['timeOff']} · Half Day" if fd["status"] == "half" else fd["timeOff"]
        if fd.get("holidayName") and fd.get("status", "").startswith("holiday"):
            status = f"{status}: {fd['holidayName']}"
        leave = bool(fd.get("leaveClass"))
        effect = (_p(f"-{money(fd['deduct'], cur)}", _RIGHT, color=RED, bold=True) if fd.get("deduct")
                  else _p(f"+{money(fd['bonus'], cur)}", _RIGHT, color=BLUE, bold=True) if fd.get("bonus")
                  else _p("no change", _RIGHT, color=DIM))
        date_cell = _p(day_label(ds), _LEFT, color=RED if leave else None, bold=True, italic=True)
        day_cell = _p(status, color=RED if leave or fd.get("status") == "absent" else None, bold=True)
        if not segs:
            g.add([date_cell, day_cell, _p("-"), _p("-"), _p("-"), _p("-"), effect], band)
        top = len(g.rows)
        for si, seg in enumerate(segs):
            seg_top = g.add([date_cell if si == 0 else "", day_cell if si == 0 else "",
                             _time_cell(seg.get("inR") or seg.get("in"), seg.get("inId") or "", ctx),
                             _time_cell(seg.get("outR") or seg.get("out"), seg.get("outId") or "", ctx),
                             _p(seg.get("category") or "-"), _p(hm(seg.get("workedMin")), bold=True),
                             effect if si == 0 else ""], band)
            for b in seg.get("breaks") or []:
                g.add(["", _p("Break", color=DIM, italic=True),
                       _time_cell(b.get("start"), b.get("startId") or "", ctx),
                       _time_cell("" if b.get("implicit") else b.get("end"), b.get("endId") or "", ctx),
                       "", "", ""], band)
            g.span_down((4, 5), seg_top, len(g.rows) - 1)
        if segs:
            g.span_down((0, 6), top, len(g.rows) - 1)
        _auto_line(g, segs)
        _note_line(g, ds, segs, ctx)
    return g.table([84, 130, 84, 84, 158, 80, 100])


def fixed_summary(card: dict) -> list:
    t = card.get("totals") or {}
    cur = card.get("currency") or "USD"
    split = len(card.get("rateSplits") or []) > 1
    reasons = " · ".join(
        f"{m.get('label')} x{m.get('full')}" + (f" + {m.get('half')} half" if m.get("half") else "")
        if m.get("full") else f"{m.get('label')} {m.get('half')} half"
        for m in t.get("missedReasons") or [])
    missed = (f"Missed days ({t.get('missedFullDays', 0)} full"
              + (f", {t['missedHalfDays']} half" if t.get("missedHalfDays") else "") + ")"
              + (f": {reasons}" if reasons else ""))
    wk = int(t.get("weekendDaysWorked") or 0)
    return [("Salary this month (pro-rated by day)" if split else "Monthly salary", "",
             money(t.get("salaryForPeriod", t.get("monthlySalary")), cur)),
            (missed, "", f"-{money(t['deduction'], cur)}" if t.get("deduction") else money(0, cur)),
            (f"Weekend pay ({wk} day{'' if wk == 1 else 's'}, {card.get('weekendMultiplier') or 1.35} x daily by hours)",
             "", f"+{money(t['weekendBonus'], cur)}" if t.get("weekendBonus") else money(0, cur)),
            ("NET PAY THIS MONTH", hd(t.get("workedMin")), money(t.get("totalPay"), cur)),
            ("MISSING PUNCHES", str(int(t.get("missingPunches") or 0)), "")]


def _summary_table(rows: list, fixed: bool) -> Table:
    data = [[_p(""), _p("HOURS" if not fixed else "", bold=True), _p("WAGE" if not fixed else "AMOUNT", bold=True)]]
    data += [[_p(a, _RIGHT, bold=a.isupper()), _p(b, bold=a.isupper()), _p(c, _RIGHT, bold=a.isupper())]
             for a, b, c in rows]
    t = Table(data, colWidths=[300, 90, 90], hAlign="RIGHT")
    cmds = [("GRID", (0, 0), (-1, -1), 0.4, LINE), ("BACKGROUND", (0, 0), (-1, 0), HEAD),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]
    cmds += [("BACKGROUND", (0, i + 1), (-1, i + 1), BAND) for i, (a, _b, _c) in enumerate(rows) if a.isupper()]
    t.setStyle(TableStyle(cmds))
    return t


def render(card: dict, ctx: dict) -> bytes:
    """The time sheet pages. `ctx`: start, end, pay_type, entity, name, email,
    code, dept, period, kind, rule, approvals (lines), version, history
    (lines), generated, notes, punch_meta, time(iso, punch_id) -> '8:45 AM',
    names_in(text) -> text with emails as names."""
    fixed = ctx["pay_type"] == "fixed"
    cur = card.get("currency") or "USD"
    head = ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=13, leading=16, alignment=1, textColor=INK)
    who = [f"<b>Employee:</b> {escape(ctx['name'])} ({escape(ctx['email'])})"]
    if ctx.get("code"):
        who.append(f"<b>Code:</b> {escape(ctx['code'])}")
    if ctx.get("dept"):
        who.append(f"<b>Dept:</b> {escape(ctx['dept'])}")
    who.append(f"<b>Period:</b> {escape(ctx['period'])}")
    pay = [escape(ctx["kind"])]
    if fixed:
        pay.append(f"<b>Monthly salary:</b> {money(card.get('monthlySalary'), cur)}")
    else:
        pay.append(f"<b>Pay rate:</b> {money(card.get('rate'), cur)}/hr")
        pay.append(f"<b>OT rule:</b> {escape(ctx.get('rule') or 'None')}")
    splits = card.get("rateSplits") or []
    if len(splits) > 1:
        key = "monthlySalary" if fixed else "rate"
        unit = "/mo" if fixed else "/hr"
        pay.append(" · ".join(
            (f"Through {ctx['us_date'](s.get('through'))}" if i == 0 else f"From {ctx['us_date'](s.get('from'))}")
            + f" at {money(s.get(key), cur)}{unit}" for i, s in enumerate(splits)))
    if ctx.get("version"):
        pay.append(f"Version {escape(ctx['version'])}")
    right = ParagraphStyle("appr", parent=_TEXT, alignment=2)
    top = Table([[Paragraph(" &nbsp;|&nbsp; ".join(who) + "<br/>" + " &nbsp;|&nbsp; ".join(pay), _TEXT),
                  Paragraph("<b>Approvals:</b><br/>" + "<br/>".join(escape(a) for a in ctx["approvals"]), right)]],
                colWidths=[WIDTH * 0.68, WIDTH * 0.32])
    top.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                             ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story = [Paragraph(f"Time Sheet Report for {escape(ctx['entity'] or 'Greens Global')}", head), Spacer(1, 6), top,
             Spacer(1, 6), fixed_rows(card, ctx) if fixed else hourly_rows(card, ctx), Spacer(1, 6),
             _summary_table(fixed_summary(card) if fixed else hourly_summary(card), fixed)]
    if ctx.get("history"):
        story += [Spacer(1, 10), Paragraph("<b>Review history</b>", _TEXT)]
        story += [Paragraph(escape(line), ParagraphStyle("h", parent=_TEXT, fontSize=8, leading=10))
                  for line in ctx["history"]]
    story += [Spacer(1, 8), Paragraph(f"<b>Report generated on:</b> {escape(ctx['generated'])}", _TEXT)]

    def later(cv, _doc):
        # A short running head so a loose page still says whose time sheet it is.
        cv.saveState()
        cv.setFont("Helvetica", 7.5)
        cv.setFillColor(DIM)
        cv.drawString(MARGIN, PAGE[1] - 20, f"Time Sheet - {ctx['name']} - {ctx['period']} (continued)")
        cv.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=PAGE, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=28,
                            bottomMargin=34, title=f"Time Sheet - {ctx['name']} - {ctx['period']}")
    doc.build(story, onLaterPages=later)
    return buf.getvalue()
