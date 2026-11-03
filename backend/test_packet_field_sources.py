"""Who fills each variable, per hiring packet (Pranshu, 11/03/2026).

"From that hiring packet only I want to get few fields in the intake form -
all the fields will auto fetch from the intake form." The packet lists every
variable its documents print and says who fills each: the new hire on the
intake form, HR at the offer, or one value for everyone. The choice is laid
over the templates' own field definitions wherever a packet reads its
documents; the templates are never changed.

Binds its own throwaway SQLite (through test_hr_offer). Run ONE file per process:
    python -m pytest test_packet_field_sources.py -q
"""
import re
import unittest
from types import SimpleNamespace

import database
import hr_packet_docs as hpd
import models
from test_hr_offer import OfferCase, _tpl
from test_hr_packet_review import CAND, _doc, _p, _sig


def snap(defs, *tokens, name="Agreement"):
    tpl = models.DocTemplate(id=f"t-{name}", name=name, department="", version=1)
    return hpd.Snap(tpl, _doc(_p("x ", *[f"{{{{{t}}}}}" for t in tokens]), _sig("employee")), {"fieldDefs": defs}, 1)


TEMPLATE = snap([{"token": "pan_number", "label": "PAN Number", "type": "text", "source": "person"},
                 {"token": "probation_period", "label": "Probation Period", "type": "text", "source": "hr"}],
                "pan_number", "probation_period", "client_name", "salary", "joining_bonus", "full_name", "address")


class OverlayTests(unittest.TestCase):
    def packet(self, **choices):
        return SimpleNamespace(details_form=[], field_sources=hpd.clean_field_sources(choices, [TEMPLATE], "hire"))

    def test_the_packet_decides_and_every_reader_follows(self):
        p = self.packet(probation_period={"source": "person", "required": True},
                        pan_number={"source": "hr"}, client_name={"source": "same", "value": "Acme"})
        form = hpd.FormView(p, [TEMPLATE]).details_form
        self.assertEqual([(f["key"], f["required"]) for f in form], [("probation_period", True)])
        # An old "HR At The Offer" choice reads as "the new hire fills it while signing" (Nov 3 2026):
        # a hiring packet never asks HR at the offer.
        self.assertEqual(p.field_sources["pan_number"]["source"], "signing")
        self.assertEqual(hpd.hr_questions(hpd.with_sources(p, [TEMPLATE])), [])
        self.assertEqual(hpd.unfilled_variables(p, [TEMPLATE]), [])
        self.assertEqual(hpd.fixed_values(p), {"client_name": "Acme"})
        # The template itself is untouched - another packet still reads it as written.
        self.assertEqual([f["key"] for f in hpd.FormView(SimpleNamespace(details_form=[]), [TEMPLATE]).details_form],
                         ["pan_number"])
        # On a hiring packet nothing is left unfilled: what nobody fills, the new hire types while signing.
        self.assertEqual(hpd.unfilled_variables(SimpleNamespace(details_form=[], field_sources={}), [TEMPLATE]), [])
        letter = SimpleNamespace(details_form=[], field_sources={}, event="promotion")
        self.assertEqual([u["token"] for u in hpd.unfilled_variables(letter, [TEMPLATE])], ["client_name"])

    def test_private_answers_stay_private(self):
        p = self.packet(probation_period={"source": "person", "sensitive": True})
        form = {f["key"]: f for f in hpd.FormView(p, [TEMPLATE]).details_form}
        self.assertTrue(form["probation_period"]["sensitive"])

    def test_the_rules(self):
        bad = [({"joining_bonus": {"source": "person"}}, "hire", "is pay"),
               ({"pan_number": {"source": "person"}}, "offer", "only a hiring packet"),
               ({"client_name": {"source": "same", "value": " "}}, "hire", "every hire gets"),
               ({"client_name": {"source": "guess"}}, "hire", "Pick who fills")]
        for raw, event, words in bad:
            with self.assertRaises(hpd.PacketProblem) as e:
                hpd.clean_field_sources(raw, [TEMPLATE], event)
            self.assertIn(words, str(e.exception))
            self.assertEqual(hpd.clean_field_sources(raw, [TEMPLATE], event, strict=False), {})
        # Built-ins, the always-asked details and variables no document prints are not this list's.
        self.assertEqual(hpd.clean_field_sources({"full_name": {"source": "hr"}, "address": {"source": "hr"},
                                                  "gone": {"source": "hr"}}, [TEMPLATE], "hire"), {})

    def test_the_table_lists_every_variable_once_with_who_fills_it(self):
        p = self.packet(client_name={"source": "same", "value": "Acme"})
        other = snap([], "client_name", name="NDA")
        rows = {r["token"]: r for r in hpd.field_rows(hpd.with_sources(p, [TEMPLATE, other]), [], p.field_sources)}
        self.assertEqual({t: r["fill"] for t, r in rows.items()},
                         {"address": "standard", "client_name": "same", "full_name": "nexus", "pan_number": "person",
                          "probation_period": "signing", "salary": "pay", "joining_bonus": "pay"})
        self.assertEqual((rows["client_name"]["value"], rows["client_name"]["documents"], rows["client_name"]["packetChoice"]),
                         ("Acme", ["Agreement", "NDA"], True))
        self.assertFalse(rows["salary"]["editable"])


class PacketJourneyTests(OfferCase):
    """The hiring packet's own choice reaches the new hire's intake page and the documents."""

    def _packet(self):
        return next(s for s in self.client.get("/hr/packets").json()["settings"] if s["id"] == "s-hire")

    def _save(self, **extra):
        hire = self._packet()
        return self.client.put("/hr/packets/documents", json={
            "id": "s-hire", "entity_id": CO_ID, "event": "hire", "name": hire["name"], "doc_template_ids": ["t-intake"],
            "flow": hire["flow"], "verify_role": "hr", "country": hire["country"] or "US", **extra})

    def test_a_field_moved_off_the_intake_form_is_never_asked_and_still_prints(self):
        r = self._save(field_sources={"pan_number": {"source": "same", "value": "AAAAA0000A"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._packet()["fieldSources"]["pan_number"]["value"], "AAAAA0000A")
        self.assertEqual(self._save().status_code, 200)                     # a save without them keeps them
        self.assertIn("pan_number", self._packet()["fieldSources"])
        self.assertEqual(self._save(field_sources={"pan_number": {"source": "same"}}).status_code, 400)

        preview = self.client.post("/hr/packets/intake-preview", json={
            "doc_template_ids": ["t-intake"], "field_sources": {"pan_number": {"source": "same", "value": "AAAAA0000A"}}}).json()
        self.assertEqual(next(f for f in preview["fields"] if f["token"] == "pan_number")["fill"], "same")
        self.assertNotIn("pan_number", [f["key"] for f in preview["form"]])

        offer = self._offer().json()
        self._send_and_sign(offer["id"])
        packet = self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()
        token = re.search(r"/intake/([A-Za-z0-9_\-]+)", self._wait_for_mail()[2]).group(1)
        page = self.client.get(f"/hr/intake/public/{token}").json()
        self.assertEqual([f["key"] for f in page["form"]], [])              # not asked any more
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {
            "first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St"}})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.db.query(models.Document).filter_by(life_event_id=packet.id).one()
        self.assertEqual(row.merge_overrides["pan_number"], "AAAAA0000A")    # printed in the document
        self.assertEqual(self._ev(packet.id).status, "review")
        self.assertTrue(self._review(packet.id)["canVerify"], self._review(packet.id)["problems"])


CO_ID = __import__("test_hr_packet_review").CO
assert CAND and database and _tpl  # imported for the journey's helpers

if __name__ == "__main__":
    unittest.main()
