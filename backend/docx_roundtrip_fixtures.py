"""The Word round-trip fixtures (Neil, 11/11/2026: "Make sure it's fully word
compatible").

Four documents a company actually sends, written by the real exporter
(services/doc_export.render_docx) and committed under
frontend/src/lib/__fixtures__/word/. The frontend's wordRoundTrip.test.js
imports each one with the real importer (lib/docxToTiptap.js) and checks
that what went out came back: headings, tab stops, variables, page numbers,
the watermark, footnotes, tracked changes, comments, a landscape table.
test_docx_roundtrip_fixtures.py fails when the exporter's output drifts
from the committed files - then run this to rebuild them:

    cd backend && python docx_roundtrip_fixtures.py
"""
import io
import os
import zipfile

from services.doc_export import render_docx, tiptap_to_blocks

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "lib", "__fixtures__", "word")


def _t(text, *marks):
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = list(marks)
    return node


def _p(*content, **attrs):
    return {"type": "paragraph", "attrs": attrs, "content": list(content)}


def _h(level, text):
    return {"type": "heading", "attrs": {"level": level}, "content": [_t(text)]}


def _mf(token):
    return {"type": "mergeField", "attrs": {"token": token}}


BOLD = {"type": "bold"}


def offer_letter():
    body = {"type": "doc", "content": [
        _h(1, "Offer of Employment"),
        _p(_t("Dear "), _mf("full_name"), _t(",")),
        _p(_t("We are pleased to offer you the position of "), _mf("job_title"), _t(" at "), _mf("company"), _t(".")),
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [_p(_t("Start Date: ", BOLD), _mf("start_date"))]},
            {"type": "listItem", "content": [_p(_t("Annual Salary: ", BOLD), _mf("salary"))]},
        ]},
        _p(_t("Employee"), {"type": "tab"}, _t("Date"), tabStops=[{"pos": 432, "align": "right"}]),
    ]}
    footer = {"type": "doc", "content": [_p(_t("Greens Global - Confidential"))]}
    return dict(header=None, footer=footer, body=body, page_setup={"size": "letter", "pageNumbers": "bottom-center"},
                merge_fields=True)


def policy():
    body = {"type": "doc", "content": [
        _h(2, "Table of Contents"),
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [_p(_t("Purpose - p.1", {"type": "link", "attrs": {"href": "#toc:p1:purpose"}}))]},
            {"type": "listItem", "content": [_p(_t("Scope - p.1", {"type": "link", "attrs": {"href": "#toc:p1:scope"}}), indent=1)]},
        ]},
        _h(1, "Purpose"),
        _p(_t("Every site keeps its gate code private"), {"type": "footnote", "attrs": {"text": "Codes change every 90 days."}}, _t(".")),
        _h(2, "Scope"),
        _p(_t("This policy applies to every storage site."), {"type": "footnote", "attrs": {"text": "Including sites under construction."}}),
    ]}
    return dict(header=None, footer=None, body=body,
                page_setup={"size": "letter", "watermark": "DRAFT", "pageNumbers": "bottom-right"}, merge_fields=False)


def redlined_contract():
    ins = {"type": "insertion", "attrs": {"author": "neil@example.test", "name": "Neil Patel", "at": "2026-11-11T09:00:00Z"}}
    dele = {"type": "deletion", "attrs": {"author": "charmi@example.test", "name": "Charmi Shah", "at": "2026-11-11T09:30:00Z"}}
    note = {"type": "comment", "attrs": {"id": "c1"}}
    body = {"type": "doc", "content": [
        _h(1, "Services Agreement"),
        _p(_t("The fee is "), _t("$4,000", dele), _t("$4,500", ins), _t(" per month.")),
        _p(_t("Either party may end this agreement "), _t("with 30 days notice", note), _t(".")),
    ]}
    comments = {"c1": {"author": "Sagar Mehta", "initials": "SM", "text": "Should this be 60 days?"}}
    return dict(header=None, footer=None, body=body, page_setup={"size": "letter"}, merge_fields=False, comments=comments)


def landscape_table():
    def cell(text, **attrs):
        return {"type": "tableCell", "attrs": attrs, "content": [_p(_t(text))]}
    table = {"type": "table", "content": [
        {"type": "tableRow", "content": [cell("Site", colspan=2), cell("Units")]},
        {"type": "tableRow", "content": [cell("Austin"), cell("North"), cell("412")]},
    ]}
    body = {"type": "doc", "content": [_h(1, "Occupancy"), table]}
    return dict(header=None, footer=None, body=body,
                page_setup={"size": "letter", "orientation": "landscape", "margins": "custom",
                            "marginIn": {"top": 0.75, "right": 0.75, "bottom": 0.75, "left": 0.75}, "pageColor": "#f0fdf4"},
                merge_fields=False)


FIXTURES = {"offer-letter": offer_letter, "policy": policy, "redlined-contract": redlined_contract, "landscape-table": landscape_table}


def build(name: str) -> bytes:
    f = FIXTURES[name]()
    band = lambda doc: tiptap_to_blocks(doc, {}) if doc else []   # noqa: E731
    return render_docx(name, band(f["header"]), [tiptap_to_blocks(f["body"], {})], band(f["footer"]), None,
                       f["page_setup"], comments=f.get("comments"), merge_fields=f["merge_fields"])


def document_xml(data: bytes) -> str:
    return zipfile.ZipFile(io.BytesIO(data)).read("word/document.xml").decode("utf-8")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in FIXTURES:
        path = os.path.join(OUT_DIR, f"{name}.docx")
        with open(path, "wb") as fh:
            fh.write(build(name))
        print("wrote", os.path.relpath(path))
