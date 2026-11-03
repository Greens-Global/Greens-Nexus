"""Hiring packet fields (Pranshu, 11/03/2026): ticked for the intake form = asked
there; NOT ticked = the new hire fills it in the document while signing - a
Nexus Sign text box on the line the document prints, theirs only, Required and
Private as the packet set them. HR is never asked a hiring packet's fields at
the offer (pay excepted).

    python -m pytest test_packet_signing_blanks.py -q
"""
import io
import re

from pypdf import PdfReader

import models
from routers import esign
from test_hr_offer import OfferCase, _tpl
from test_hr_packet_review import CAND, CO, HR, _doc, _sig


def _t(s):
    return {"type": "text", "text": s}


def _v(token):
    return {"type": "mergeField", "attrs": {"token": token}}


def _cell(*parts):
    return {"type": "tableCell", "content": [{"type": "paragraph", "content": list(parts)}]}


REG = _doc({"type": "paragraph", "content": [_t("New Contractor Registration")]},
           {"type": "table", "content": [
               {"type": "tableRow", "content": [_cell(_t("First Name")), _cell(_v("first_name")),
                                                _cell(_t("PAN Number")), _cell(_v("pan_number"))]},
               {"type": "tableRow", "content": [_cell(_t("WhatsApp Number")), _cell({"type": "hardBreak"}, _v("whatsapp_number")),
                                                _cell(), _cell()]}]},
           # A typed {{token}} inside a sentence, not a chip.
           {"type": "paragraph", "content": [_t("I am a citizen of {{nationality}} and agree to the terms.")]},
           _sig("employee"), _sig("company"))
DEFS = [{"token": "pan_number", "label": "PAN Number", "type": "text", "source": "person"},
        {"token": "whatsapp_number", "label": "WhatsApp Number", "type": "text", "source": "hr"}]


def _pdf(path):
    got = esign._storage_fetch(esign._DOC_BUCKET, path)
    assert got.is_success, path
    return PdfReader(io.BytesIO(got.content))


def mult(m, n):
    """Two PDF matrices [a b c d e f] multiplied (m then n)."""
    return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
            m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]]


def _blank_lines(page):
    """(x, baseline) in points where each blank line (underscores) is drawn -
    read from the page's own text operators (pypdf's extract_text visitor
    misplaces a line after a line break), the x moved past any words drawn
    before the blank on the same line."""
    from pypdf.generic import ContentStream
    from reportlab.pdfbase.pdfmetrics import stringWidth
    fonts = page["/Resources"]["/Font"]
    ctm, stack, tm, tl, font, size, out = [1, 0, 0, 1, 0, 0], [], None, 0, "Helvetica", 10, []
    for operands, op in ContentStream(page.get_contents(), page.pdf).operations:
        op = op.decode() if isinstance(op, bytes) else op
        f = [float(x) for x in operands] if op in ("cm", "Tm", "Td", "TD", "TL") else None
        if op == "q":
            stack.append(ctm)
        elif op == "Q":
            ctm = stack.pop()
        elif op == "cm":
            ctm = mult(f, ctm)
        elif op == "BT":
            tm = [1, 0, 0, 1, 0, 0]
        elif op == "Tm":
            tm = f
        elif op == "TL":
            tl = f[0]
        elif op == "Tf":
            font, size = str(fonts[operands[0]]["/BaseFont"])[1:], float(operands[1])
        elif op in ("Td", "TD"):
            tl = -f[1] if op == "TD" else tl
            tm = mult([1, 0, 0, 1, f[0], f[1]], tm)
        elif op == "T*":
            tm = mult([1, 0, 0, 1, 0, -tl], tm)
        elif op in ("Tj", "TJ"):
            parts = list(operands[0]) if op == "TJ" else [operands[0]]
            text = "".join(str(x) for x in parts if not isinstance(x, (int, float)))
            if "____" in text:
                m = mult(tm, ctm)
                out.append((m[4] + stringWidth(text[:text.index("____")], font, size), m[5]))
            # The text position moves on by what was drawn (a TJ number is a kern, in 1/1000 em).
            moved = stringWidth(text, font, size) - sum(float(x) for x in parts if isinstance(x, (int, float))) * size / 1000
            tm = mult([1, 0, 0, 1, moved, 0], tm)
    return out


class SigningBlankTests(OfferCase):
    def setUp(self):
        super().setUp()
        _tpl(self.db, "t-reg", "New Contractor Registration", REG, DEFS, category="hr")
        self.db.commit()
        hire = next(s for s in self.client.get("/hr/packets").json()["settings"] if s["id"] == "s-hire")
        r = self.client.put("/hr/packets/documents", json={
            "id": "s-hire", "entity_id": CO, "event": "hire", "name": hire["name"], "flow": hire["flow"],
            "doc_template_ids": ["t-reg"], "verify_role": "hr", "country": hire["country"] or "US",
            "field_sources": {"pan_number": {"source": "person", "required": True},
                              "whatsapp_number": {"source": "signing", "required": True},
                              "nationality": {"source": "signing", "sensitive": True}}})
        self.assertEqual(r.status_code, 200, r.text)

    def test_unticked_fields_are_typed_by_the_new_hire_while_signing(self):
        # The offer never asks HR for the hiring packet's fields - not even the template's own HR Answers one.
        opts = self.client.get("/hr/candidates/cand-1/offer/options", params={"worker_type": "employee"}).json()
        self.assertEqual([q["token"] for q in opts["hiringPacket"]["hrQuestions"]], [])
        eid = self._offer().json()["id"]
        self._send_and_sign(eid)
        packet = self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()

        # The intake form asks only the ticked one.
        token = re.search(r"/intake/([A-Za-z0-9_\-]+)", self._wait_for_mail()[2]).group(1)
        page = self.client.get(f"/hr/intake/public/{token}").json()
        self.assertEqual([f["key"] for f in page["form"]], ["pan_number"])
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {
            "first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
            "answers": {"pan_number": "ABCDE1234F"}}})
        self.assertEqual(r.status_code, 200, r.text)

        # HR's review: the unticked ones are the new hire's to fill, not problems.
        review = self._review(packet.id)
        doc = review["documents"][0]
        self.assertEqual(doc["atSigning"], ["Nationality", "WhatsApp Number"])
        self.assertTrue(review["canVerify"], review["problems"])
        self.assertEqual(self._verify(packet.id, review).status_code, 200)

        # Nexus Sign: one text box per blank, the new hire's, on the line the document printed.
        req = self.db.query(models.HrSignRequest).filter_by(id=self._ev(packet.id).sign_request_id).first()
        party = self._party(req.id, CAND)
        fields = [f for f in (req.fields or []) if f.get("type") == "text"]
        self.assertEqual(sorted((f["label"], f["required"], bool(f.get("sensitive"))) for f in fields),
                         [("Nationality", False, True), ("WhatsApp Number", True, False)])
        self.assertTrue(all(f["role"] == party.role_key for f in fields))
        self.assertTrue(req.prints_pay)                 # a Private answer: the signed copy is restricted
        reader = _pdf(req.pdf_storage_path)
        pw, ph = float(reader.pages[0].mediabox.width), float(reader.pages[0].mediabox.height)
        lines = _blank_lines(reader.pages[0])
        self.assertEqual(len(lines), 2, lines)
        for f in fields:
            x, bottom = f["x"] * pw, ph - (f["y"] + f["h"]) * ph      # the box's left edge and bottom, in points
            # On the line: same start, the box's bottom just under the baseline.
            self.assertTrue(any(abs(x - lx) < 1.5 and 0 < ly - bottom < 6 for lx, ly in lines),
                            (f["label"], x, bottom, lines))

        # The required box must be filled; then what they type is in the sealed copy.
        c = self.client
        c.post(f"/esign/public/{party.token}/consent", json={"agreed": True})
        c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"})
        c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        sign = {"consent": True, "signature_kind": "typed", "signature_data": party.name,
                "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1}
        self.assertEqual(c.post(f"/esign/public/{party.token}/sign", json=sign).status_code, 400)
        ids = {f["label"]: f["id"] for f in fields}
        r = c.post(f"/esign/public/{party.token}/sign", json={**sign, "field_values": {
            ids["WhatsApp Number"]: "+91 98765 43210", ids["Nationality"]: "India"}})
        self.assertEqual(r.status_code, 200, r.text)
        self._sign(self._party(req.id, HR))
        packet = self._ev(packet.id)
        self.assertEqual(packet.status, "completed", packet.apply_note)
        self.db.expire_all()
        req = self.db.query(models.HrSignRequest).filter_by(id=req.id).first()
        text = " ".join(" ".join(p.extract_text() or "" for p in _pdf(req.final_pdf_path).pages).split())
        for want in ("Jane", "ABCDE1234F", "+91 98765 43210", "India"):
            self.assertIn(want, text)

    def test_an_offer_letter_still_asks_hr(self):
        # Only a hiring packet changed: an offer letter's own HR Answers question is still HR's at the offer.
        opts = self.client.get("/hr/candidates/cand-1/offer/options", params={"worker_type": "employee"}).json()
        self.assertEqual([q["token"] for q in opts["offerLetter"]["hrQuestions"]], ["probation_period"])
