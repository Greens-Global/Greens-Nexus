"""Draw our Direct Deposit Authorization (one page, letter) and its field
map - the only one of the three federal forms that is Nexus's own.

    cd backend && .venv/bin/python -m federal_forms.make_direct_deposit

Writes `pdf/direct-deposit-v1.pdf` (no AcroForm: the boxes are drawn ink,
Nexus Sign stamps the values) and `maps/direct_deposit_v1.json`, where every
entry is a placed box ("@<id>", page 0, normalized top-left rect) because
this script knows exactly where it drew each one. The canvas is `invariant`,
so re-running it reproduces the same bytes and the SHA-256 in registry.py
stays true. Bump the edition (v2) when the layout changes - never redraw v1.
"""
import json
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as rl_canvas

HERE = Path(__file__).resolve().parent
PDF_OUT = HERE / "pdf" / "direct-deposit-v1.pdf"
MAP_OUT = HERE / "maps" / "direct_deposit_v1.json"

PAGE_W, PAGE_H = letter
M = 54.0                      # page margin
CW = PAGE_W - 2 * M           # content width
INK = HexColor("#1f2937")
MUTED = HexColor("#6b7280")
RULE = HexColor("#9ca3af")
BOX_H = 24.0
LABEL_PT = 7.5


class Sheet:
    def __init__(self, c):
        self.c = c
        self.top = PAGE_H - M     # cursor: the top of the next thing, PDF coords
        self.fields = {}

    def down(self, pts):
        self.top -= pts

    def text(self, s, size=9.5, bold=False, color=INK, x=M, leading=None):
        self.c.setFillColor(color)
        self.c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        self.c.drawString(x, self.top - size, s)
        self.down(leading or size * 1.35)

    def wrapped(self, s, size=9.5, color=INK, width=CW):
        words, line = s.split(), ""
        font = "Helvetica"
        for w in words:
            probe = (line + " " + w).strip()
            if stringWidth(probe, font, size) > width and line:
                self.text(line, size=size, color=color, leading=size * 1.4)
                line = w
            else:
                line = probe
        if line:
            self.text(line, size=size, color=color, leading=size * 1.4)

    def heading(self, s):
        self.down(8)
        self.text(s, size=11, bold=True)
        self.c.setStrokeColor(RULE)
        self.c.setLineWidth(0.6)
        self.c.line(M, self.top + 4, PAGE_W - M, self.top + 4)
        self.down(6)

    def _place(self, fid, x, top, w, h, **spec):
        self.fields["@" + fid] = {
            "id": fid, "page": 0,
            "rect": [round(x / PAGE_W, 4), round((PAGE_H - top) / PAGE_H, 4),
                     round(w / PAGE_W, 4), round(h / PAGE_H, 4)],
            **spec,
        }

    def box_row(self, boxes, h=BOX_H):
        """boxes: [(fid, label, width or None for the rest, spec)] on one line,
        label above each box, 10pt gaps."""
        gap = 10.0
        fixed = sum(b[2] for b in boxes if b[2])
        flex = [b for b in boxes if not b[2]]
        rest = (CW - fixed - gap * (len(boxes) - 1)) / len(flex) if flex else 0
        label_top = self.top
        box_top = label_top - LABEL_PT - 4
        x = M
        for fid, label, width, spec in boxes:
            w = width or rest
            self.c.setFillColor(MUTED)
            self.c.setFont("Helvetica", LABEL_PT)
            self.c.drawString(x, label_top - LABEL_PT, label.upper())
            self.c.setStrokeColor(RULE)
            self.c.setLineWidth(0.7)
            self.c.rect(x, box_top - h, w, h, stroke=1, fill=0)
            self._place(fid, x, box_top, w, h, label=label, **spec)
            x += w + gap
        self.top = box_top - h
        self.down(10)

    def check_row(self, intro, checks):
        """A line of checkboxes: intro text, then [(fid, label, spec)]."""
        size, side = 9.5, 10.0
        y_base = self.top - size
        self.c.setFillColor(INK)
        self.c.setFont("Helvetica", size)
        self.c.drawString(M, y_base, intro)
        x = M + stringWidth(intro, "Helvetica", size) + 12
        for fid, label, spec in checks:
            self.c.setStrokeColor(INK)
            self.c.setLineWidth(0.8)
            box_top = y_base + side - 1
            self.c.rect(x, box_top - side, side, side, stroke=1, fill=0)
            self._place(fid, x, box_top, side, side, label=label, **spec)
            self.c.setFillColor(INK)
            self.c.setFont("Helvetica", size)
            self.c.drawString(x + side + 5, y_base, label)
            x += side + 5 + stringWidth(label, "Helvetica", size) + 22
        self.down(size * 1.35 + 6)

    def account(self, n, optional):
        p = f"dd{n}"
        who = f"Account {n}"
        self.heading(f"{who} - {'Optional' if optional else 'Primary'}")
        EMP = {"role": "employee", "type": "text", "required": not optional, "source": "person"}
        self.box_row([
            (f"{p}_bank", "Bank or Credit Union Name", None, EMP),
            (f"{p}_routing", "Routing Number (9 Digits)", 150,
             {**EMP, "format": "routing", "sensitive": True}),
            (f"{p}_account", "Account Number", 150,
             {**EMP, "format": "account", "sensitive": True}),
        ])
        CHK = {"role": "employee", "type": "check", "required": False, "source": "person"}
        self.check_row("Account type:", [
            (f"{p}_type_checking", "Checking", CHK),
            (f"{p}_type_savings", "Savings", CHK),
        ])
        OPT = {"role": "employee", "type": "text", "required": False, "source": "person"}
        if optional:
            self.box_row([
                (f"{p}_amount", "Fixed Amount per Pay Period ($)", 170, {**OPT, "format": "money"}),
                (f"{p}_percent", "Or Percent of Net Pay (%)", 170, {**OPT, "format": "percent"}),
            ])
            self.wrapped("Use one for Account 2: a fixed amount (the rest of your pay goes to "
                         "Account 1), or percents for both accounts that total 100.",
                         size=8.5, color=MUTED)
        else:
            self.box_row([
                (f"{p}_percent", "Percent of Net Pay (%) - leave blank for all of it", 170,
                 {**OPT, "format": "percent"}),
            ])


def draw(path: Path) -> dict:
    c = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    c.setTitle("Direct Deposit Authorization")
    c.setAuthor("Greens Nexus")
    c.setSubject("Authorization for ACH direct deposit of net pay")
    s = Sheet(c)

    s.text("Direct Deposit Authorization", size=18, bold=True, leading=24)
    s.text("Authorization for automated clearing house (ACH) deposit of net pay",
           size=9.5, color=MUTED, leading=18)
    s.box_row([("employer_name", "Employer", None,
                {"role": "", "type": "text", "required": False, "source": "merge",
                 "mergeKey": "employer.legal_name"})])

    s.heading("Employee")
    s.box_row([("employee_name", "Employee Name (as it appears on your bank account)", None,
                {"role": "employee", "type": "text", "required": True, "source": "person"})])

    s.account(1, optional=False)
    s.account(2, optional=True)

    s.heading("Authorization")
    s.wrapped(
        "I authorize my employer named above, and the bank it uses to pay me, to deposit my "
        "net pay by electronic credit to the account or accounts listed, and to make debit "
        "entries to those accounts to correct any credit made in error. This authorization "
        "stays in effect until I give my employer written notice of a change or cancellation "
        "and my employer has had a reasonable time to act on it. I confirm that the account "
        "information above is correct and that each account is in my name or one I am "
        "authorized to use. I will attach a voided check or a letter from my bank for each "
        "account when asked."
    )
    s.down(8)
    s.box_row([
        ("signature", "Employee Signature", None,
         {"role": "employee", "type": "sign", "required": True, "source": "person"}),
        ("date", "Date", 150,
         {"role": "employee", "type": "date", "required": True, "source": "person"}),
    ], h=34)

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7.5)
    c.drawString(M, M - 10, "Nexus keeps the signed form in your employee file; bank numbers "
                            "are stored encrypted and printed only on the sealed copy.")
    c.drawRightString(PAGE_W - M, M - 22, "Direct Deposit Authorization v1")
    c.showPage()
    c.save()
    return s.fields


def main():
    PDF_OUT.parent.mkdir(parents=True, exist_ok=True)
    MAP_OUT.parent.mkdir(parents=True, exist_ok=True)
    fields = draw(PDF_OUT)
    with open(MAP_OUT, "w", encoding="utf-8") as fh:
        json.dump(fields, fh, indent=2)
        fh.write("\n")
    print(f"wrote {PDF_OUT.name} and {MAP_OUT.name} with {len(fields)} boxes")


if __name__ == "__main__":
    main()
