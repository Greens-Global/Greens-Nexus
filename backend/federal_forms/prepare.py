"""Turn a bundled form into what Nexus Sign sends: a flat PDF (no widgets)
plus typed fields in Nexus Sign's own frame.

`prepare(kind)` reads the bundled PDF, lists every /Widget on every page,
looks each widget's fully-qualified name up in the form's map, and emits one
field per mapped widget with the widget's rectangle as normalized TOP-LEFT
fractions of the page (x, y, w, h in 0..1 - the frame `_clean_fields` and
`_stamp_pdf` in routers/esign.py use), then returns the PDF with the widgets
and the AcroForm removed so the stamped values are the only ink.

Widgets the map does not name are dropped with a warning (the I-9's
Supplements A and B, the W-4's worksheets). Map entries whose widget is
MISSING are the dangerous case - a new edition renamed a field and a box
would print somewhere else - so `check_map(kind)` reports them and
`test_federal_forms.py` fails on any. A map key starting with "@" is a box
the PDF has no widget for (the W-4's Step 5 signature line, every box on our
own direct deposit form) and places itself with `page` and `rect`.

Field shape: {id, role ("employee" | "hr" | "" for a merge box no signer
owns), type (text | check | radio | date | sign), page, x, y, w, h, required,
label, options?, format?, sensitive?, source (person | hr | merge), mergeKey?}.
A `source: "merge"` field is printed from the company record and the hire
(registry.MERGE_KEYS) by the packet builder; it is never required of a signer.
"""
import io
import logging

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

from .registry import FORMS, MERGE_KEYS, load_map, pdf_bytes

log = logging.getLogger(__name__)

FIELD_TYPES = ("text", "check", "radio", "date", "sign")
PLACED = "@"


def _fq_name(annot) -> str:
    parts, node, hops = [], annot, 0
    while node is not None and hops < 32:
        t = node.get("/T")
        if t is not None:
            parts.append(str(t))
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
        hops += 1
    return ".".join(reversed(parts))


def _inherited(annot, key):
    node, hops = annot, 0
    while node is not None and hops < 32:
        if key in node:
            return node[key]
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
        hops += 1
    return None


def widgets(kind: str) -> list:
    """Every /Widget in the bundled PDF: {name, page, x, y, w, h, ft, states}
    with the rectangle already in the normalized top-left frame."""
    reader = PdfReader(io.BytesIO(pdf_bytes(kind)))
    out = []
    for idx, page in enumerate(reader.pages):
        if getattr(page, "rotation", 0):
            try:
                page.transfer_rotation_to_content()
            except Exception:
                pass
        mb = page.mediabox
        pw, ph = float(mb.width), float(mb.height)
        left, bottom = float(mb.left), float(mb.bottom)
        for ref in page.get("/Annots") or []:
            a = ref.get_object()
            if a.get("/Subtype") != "/Widget" or "/Rect" not in a:
                continue
            x0, y0, x1, y1 = (float(v) for v in a["/Rect"])
            ft = _inherited(a, "/FT")
            states = []
            if ft == "/Btn":
                ap = a.get("/AP")
                if ap is not None and "/N" in ap:
                    try:
                        states = [str(k) for k in ap["/N"].keys() if str(k) != "/Off"]
                    except Exception:
                        states = []
            out.append({
                "name": _fq_name(a), "page": idx,
                "x": (min(x0, x1) - left) / pw, "y": (ph - (max(y0, y1) - bottom)) / ph,
                "w": abs(x1 - x0) / pw, "h": abs(y1 - y0) / ph,
                "ft": str(ft) if ft is not None else "", "states": states,
            })
    return out


def _field(entry: dict, page: int, x: float, y: float, w: float, h: float) -> dict:
    ftype = entry.get("type")
    if ftype not in FIELD_TYPES:
        raise ValueError(f"map entry {entry.get('id')!r}: unknown type {ftype!r}")
    source = entry.get("source") or "person"
    f = {
        "id": entry["id"], "role": entry.get("role", ""), "type": ftype, "page": int(page),
        "x": round(min(1.0, max(0.0, x)), 4), "y": round(min(1.0, max(0.0, y)), 4),
        "w": round(min(1.0, max(0.0, w)), 4), "h": round(min(1.0, max(0.0, h)), 4),
        "required": False if source == "merge" else bool(entry.get("required", True)),
        "label": entry.get("label", entry["id"]), "source": source,
    }
    if entry.get("options"):
        f["options"] = [str(o) for o in entry["options"]]
    if entry.get("format"):
        f["format"] = entry["format"]
    if entry.get("sensitive"):
        f["sensitive"] = True
    if source == "merge":
        key = entry.get("mergeKey", "")
        if key not in MERGE_KEYS:
            raise ValueError(f"map entry {entry['id']!r}: unknown mergeKey {key!r}")
        f["mergeKey"] = key
    return f


def _assemble(kind: str) -> tuple:
    """(fields, dropped widget names, missing map keys)"""
    mapping = load_map(kind)
    by_name = {k: v for k, v in mapping.items() if not k.startswith(PLACED)}
    fields, dropped, seen = [], [], set()
    for wd in widgets(kind):
        entry = by_name.get(wd["name"])
        if entry is None:
            dropped.append(wd["name"])
            continue
        if wd["name"] in seen:
            # The I-9 reuses "Document Title 1" on Supplement B: the first
            # (page 1, List A) is the mapped one; the twin is dropped.
            log.warning("federal_forms %s: widget %r appears twice, first one kept", kind, wd["name"])
            dropped.append(wd["name"])
            continue
        seen.add(wd["name"])
        fields.append(_field(entry, wd["page"], wd["x"], wd["y"], wd["w"], wd["h"]))
    missing = sorted(set(by_name) - seen)
    for key, entry in mapping.items():
        if key.startswith(PLACED):
            rect = entry.get("rect") or []
            if len(rect) != 4:
                raise ValueError(f"map entry {key!r}: a placed box needs rect [x, y, w, h]")
            fields.append(_field(entry, entry.get("page", 0), *[float(v) for v in rect]))
    fields.sort(key=lambda f: (f["page"], round(f["y"], 3), f["x"]))
    ids = [f["id"] for f in fields]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"federal_forms {kind}: duplicate field ids {dup}")
    return fields, dropped, missing


def check_map(kind: str) -> dict:
    """{"missing": [map keys with no widget], "dropped": [widget names not mapped]}"""
    _, dropped, missing = _assemble(kind)
    return {"missing": missing, "dropped": dropped}


def _flatten(raw: bytes) -> bytes:
    """The PDF with every widget annotation and the AcroForm gone - a flat
    page the stamped values print onto, nothing a viewer could still type in."""
    reader = PdfReader(io.BytesIO(raw))
    writer = PdfWriter(clone_from=reader)
    writer.remove_annotations(subtypes="/Widget")
    root = writer._root_object
    if "/AcroForm" in root:
        del root[NameObject("/AcroForm")]
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def prepare(kind: str) -> dict:
    """{"pdf": bytes, "fields": [field], "pages": int} for a bundled form."""
    if kind not in FORMS:
        raise KeyError(f"Unknown federal form: {kind!r}")
    fields, dropped, missing = _assemble(kind)
    if missing:
        raise ValueError(f"federal_forms {kind}: map entries with no widget in the PDF: {missing}")
    if dropped:
        log.warning("federal_forms %s: %d unmapped widgets dropped", kind, len(dropped))
    raw = pdf_bytes(kind)
    pages = len(PdfReader(io.BytesIO(raw)).pages)
    return {"pdf": _flatten(raw), "fields": fields, "pages": pages}
