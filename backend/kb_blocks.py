"""Knowledge Base page content (Oct 2026 rebuild).

A page is ONE TipTap document (`{"type": "doc", "content": [...]}`) stored as
JSON in `kb_documents.blocks`. The same shape the editor edits is what the
reader renders, what search indexes and what Start as Task reads, so there
is exactly one content format - the old module had two.

Node types the editor and this module agree on (anything else is dropped by
`sanitize`, text kept):
  paragraph, heading(level 1-3), text (+ marks bold/italic/underline/strike/
  code/link), bulletList, orderedList, listItem, blockquote, horizontalRule,
  hardBreak, codeBlock, table/tableRow/tableHeader/tableCell, image(src, alt),
  checklist > checkItem(checked), steps > step(photos[], warning, tip, photoRequired),
  callout(kind: warning|tip|note|safety), video(url, title), embedPage(docId, title).

`from_guided` converts the OLD form-based body (purpose / scope / procedure…)
with a fixed, deterministic mapping - never AI - so the migration report can
say exactly what each page became and the old `body` stays beside it.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

BLOCK_TYPES = {
    "paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote",
    "horizontalRule", "hardBreak", "codeBlock", "table", "tableRow", "tableHeader",
    "tableCell", "image", "checklist", "checkItem", "steps", "step", "callout",
    "video", "embedPage", "text", "doc",
}
MARK_TYPES = {"bold", "italic", "underline", "strike", "code", "link", "highlight"}
CALLOUT_KINDS = ("warning", "tip", "note", "safety")
VIDEO_HOSTS = ("youtube.com", "youtu.be", "vimeo.com", "loom.com", "sharepoint.com", "microsoft.com")


# ----------------------------------------------------------------- builders

def doc(content: list | None = None) -> dict:
    return {"type": "doc", "content": content or [paragraph("")]}


def text(s: str, marks: list | None = None) -> dict:
    node = {"type": "text", "text": s}
    if marks:
        node["marks"] = marks
    return node


def paragraph(s: str = "", marks: list | None = None) -> dict:
    s = (s or "").strip()
    return {"type": "paragraph", "content": [text(s, marks)] if s else []}


def heading(s: str, level: int = 2) -> dict:
    return {"type": "heading", "attrs": {"level": max(1, min(3, int(level or 2)))}, "content": [text((s or "").strip())]}


def bullet_list(items: Iterable[str]) -> dict:
    return {"type": "bulletList", "content": [
        {"type": "listItem", "content": [paragraph(i)]} for i in items if (i or "").strip()
    ]}


def ordered_list(items: Iterable[str]) -> dict:
    return {"type": "orderedList", "content": [
        {"type": "listItem", "content": [paragraph(i)]} for i in items if (i or "").strip()
    ]}


def callout(kind: str, blocks: list) -> dict:
    kind = kind if kind in CALLOUT_KINDS else "note"
    return {"type": "callout", "attrs": {"kind": kind}, "content": blocks or [paragraph("")]}


def table(headers: list[str], rows: list[list[str]]) -> dict:
    def cell(kind: str, s: str) -> dict:
        return {"type": kind, "content": [paragraph(str(s if s is not None else ""))]}
    out = []
    if headers:
        out.append({"type": "tableRow", "content": [cell("tableHeader", h) for h in headers]})
    width = len(headers) or max((len(r) for r in rows), default=1)
    for r in rows:
        r = list(r) + [""] * (width - len(r))
        out.append({"type": "tableRow", "content": [cell("tableCell", c) for c in r[:width]]})
    return {"type": "table", "content": out}


def image(src: str, alt: str = "") -> dict:
    return {"type": "image", "attrs": {"src": src, "alt": alt or ""}}


def video(url: str, title: str = "") -> dict:
    return {"type": "video", "attrs": {"url": url, "title": title or ""}}


def embed_page(doc_id: str, title: str = "") -> dict:
    return {"type": "embedPage", "attrs": {"docId": doc_id, "title": title or ""}}


def step(title: str, detail_blocks: list | None = None, photos: list | None = None,
         warning: str = "", tip: str = "", photo_required: bool = False) -> dict:
    content = [paragraph(title)] + (detail_blocks or [])
    return {"type": "step", "attrs": {"photos": [p for p in (photos or []) if p], "warning": warning or "",
                                      "tip": tip or "", "photoRequired": bool(photo_required)},
            "content": content}


def steps(step_nodes: list) -> dict:
    return {"type": "steps", "content": step_nodes}


def checklist(items: Iterable[str]) -> dict:
    return {"type": "checklist", "content": [
        {"type": "checkItem", "attrs": {"checked": False}, "content": [text((i or "").strip())]}
        for i in items if (i or "").strip()
    ]}


# ----------------------------------------------------------------- parsing

def loads(raw: Any) -> dict:
    """blocks column -> doc dict (never raises; empty -> blank doc)."""
    if isinstance(raw, dict):
        d = raw
    else:
        try:
            d = json.loads(raw) if raw else None
        except (ValueError, TypeError):
            d = None
    if not isinstance(d, dict) or d.get("type") != "doc" or not isinstance(d.get("content"), list):
        return doc()
    return d


def dumps(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


def is_blank(d: dict) -> bool:
    return not plain_text(d).strip()


def _walk(node: dict):
    yield node
    for c in node.get("content") or []:
        if isinstance(c, dict):
            yield from _walk(c)


def node_text(node: dict) -> str:
    """The text inside one node, paragraphs joined with newlines."""
    if node.get("type") == "text":
        return node.get("text") or ""
    out: list[str] = []
    for c in node.get("content") or []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "text":
            out.append(c.get("text") or "")
        elif c.get("type") == "hardBreak":
            out.append("\n")
        else:
            inner = node_text(c)
            if inner:
                out.append(inner if not out or out[-1].endswith("\n") else "\n" + inner)
    s = "".join(out)
    # a step's / callout's attrs carry text too
    attrs = node.get("attrs") or {}
    for k in ("warning", "tip", "alt", "title"):
        v = attrs.get(k)
        if isinstance(v, str) and v.strip():
            s += ("\n" if s else "") + v.strip()
    return s


def plain_text(d: dict, limit: int = 60000) -> str:
    """Flatten a doc for search / signatures / the assistant. Headings become
    their own lines, lists one item per line."""
    lines: list[str] = []
    for n in d.get("content") or []:
        if not isinstance(n, dict):
            continue
        t = node_text(n)
        if t.strip():
            lines.append(t.strip())
    s = "\n".join(lines)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s[:limit]


def headings(d: dict) -> list[dict]:
    """[{level, text, anchor}] for the On This Page list."""
    out = []
    for i, n in enumerate(d.get("content") or []):
        if isinstance(n, dict) and n.get("type") == "heading":
            t = node_text(n).strip()
            if t:
                out.append({"level": int((n.get("attrs") or {}).get("level") or 2), "text": t, "anchor": f"h-{i}"})
    return out


def step_list(d: dict) -> list[dict]:
    """Every step in reading order: [{title, detail, photos, photoRequired, warning}].
    Start as Task turns these into checklist items."""
    out = []
    for n in _walk(d):
        if n.get("type") != "step":
            continue
        content = [c for c in (n.get("content") or []) if isinstance(c, dict)]
        title = node_text(content[0]).strip() if content else ""
        detail = "\n".join(node_text(c).strip() for c in content[1:] if node_text(c).strip())
        attrs = n.get("attrs") or {}
        out.append({
            "title": title or detail.split("\n")[0][:200] or "Step",
            "detail": detail,
            "photos": [p for p in (attrs.get("photos") or []) if isinstance(p, str)],
            "photoRequired": bool(attrs.get("photoRequired")),
            "warning": attrs.get("warning") or "",
        })
    return out


def image_urls(d: dict) -> list[str]:
    urls = []
    for n in _walk(d):
        if n.get("type") == "image":
            src = (n.get("attrs") or {}).get("src")
            if src:
                urls.append(src)
        elif n.get("type") == "step":
            urls.extend(p for p in ((n.get("attrs") or {}).get("photos") or []) if isinstance(p, str))
    return urls


def embedded_page_ids(d: dict) -> list[str]:
    return [str((n.get("attrs") or {}).get("docId") or "") for n in _walk(d)
            if n.get("type") == "embedPage" and (n.get("attrs") or {}).get("docId")]


def section_names(d: dict) -> set[str]:
    return {h["text"].strip().lower() for h in headings(d)}


# ----------------------------------------------------------------- sanitize

_SAFE_HREF = re.compile(r"^(https?://|mailto:|/|#)", re.IGNORECASE)


def sanitize(d: Any, image_ok=None) -> dict:
    """Keep only known nodes / marks / attrs. Unknown nodes keep their text as
    a paragraph. `image_ok(url) -> bool` decides which image sources survive
    (the router passes the storage-URL rule); a rejected image is dropped,
    its alt text kept, so a page never carries a data: blob or an outside
    image into the database."""
    d = loads(d)

    def ok_img(u: Any) -> bool:
        return isinstance(u, str) and bool(u) and (image_ok(u) if image_ok else not u.startswith("data:"))

    def fix_marks(marks: Any) -> list:
        out = []
        for m in marks or []:
            if not isinstance(m, dict) or m.get("type") not in MARK_TYPES:
                continue
            if m.get("type") == "link":
                href = str((m.get("attrs") or {}).get("href") or "")
                if not _SAFE_HREF.match(href):
                    continue
                out.append({"type": "link", "attrs": {"href": href, "target": "_blank", "rel": "noopener"}})
            else:
                out.append({"type": m["type"]})
        return out

    def fix(node: Any, depth: int = 0) -> list[dict]:
        if not isinstance(node, dict) or depth > 40:
            return []
        t = node.get("type")
        if t == "text":
            s = node.get("text")
            if not isinstance(s, str) or not s:
                return []
            n = {"type": "text", "text": s[:20000]}
            marks = fix_marks(node.get("marks"))
            if marks:
                n["marks"] = marks
            return [n]
        if t not in BLOCK_TYPES or t == "doc":
            txt = node_text(node).strip()
            return [paragraph(txt)] if txt else []
        attrs_in = node.get("attrs") or {}
        attrs: dict = {}
        if t == "heading":
            attrs = {"level": max(1, min(3, int(attrs_in.get("level") or 2)))}
        elif t == "image":
            src = attrs_in.get("src")
            if not ok_img(src):
                alt = str(attrs_in.get("alt") or "").strip()
                return [paragraph(alt)] if alt else []
            attrs = {"src": src, "alt": str(attrs_in.get("alt") or "")[:300]}
        elif t == "video":
            url = str(attrs_in.get("url") or "")
            if not url.startswith("https://"):
                return []
            attrs = {"url": url[:500], "title": str(attrs_in.get("title") or "")[:200]}
        elif t == "embedPage":
            did = str(attrs_in.get("docId") or "")
            if not did:
                return []
            attrs = {"docId": did[:64], "title": str(attrs_in.get("title") or "")[:300]}
        elif t == "callout":
            k = attrs_in.get("kind")
            attrs = {"kind": k if k in CALLOUT_KINDS else "note"}
        elif t == "checkItem":
            attrs = {"checked": bool(attrs_in.get("checked"))}
        elif t == "step":
            attrs = {
                "photos": [p for p in (attrs_in.get("photos") or []) if ok_img(p)][:12],
                "warning": str(attrs_in.get("warning") or "")[:1000],
                "tip": str(attrs_in.get("tip") or "")[:1000],
                "photoRequired": bool(attrs_in.get("photoRequired")),
            }
        elif t in ("tableCell", "tableHeader"):
            cs = attrs_in.get("colspan")
            rs = attrs_in.get("rowspan")
            attrs = {"colspan": int(cs) if isinstance(cs, int) and cs > 1 else 1,
                     "rowspan": int(rs) if isinstance(rs, int) and rs > 1 else 1}
        elif t == "codeBlock":
            attrs = {"language": str(attrs_in.get("language") or "")[:30]}
        children: list[dict] = []
        for c in node.get("content") or []:
            children.extend(fix(c, depth + 1))
        n = {"type": t}
        if attrs:
            n["attrs"] = attrs
        if t in ("horizontalRule", "hardBreak", "image", "video", "embedPage"):
            return [n]
        # containers need at least one child the schema accepts
        if t == "steps":
            children = [c for c in children if c["type"] == "step"]
            if not children:
                return []
        elif t == "step":
            if not children:
                children = [paragraph("")]
        elif t in ("bulletList", "orderedList"):
            children = [c for c in children if c["type"] == "listItem"]
            if not children:
                return []
        elif t == "listItem":
            if not children:
                children = [paragraph("")]
        elif t == "checklist":
            children = [c for c in children if c["type"] == "checkItem"]
            if not children:
                return []
        elif t == "checkItem":
            children = [c for c in children if c["type"] == "text"]
        elif t == "table":
            children = [c for c in children if c["type"] == "tableRow"]
            if not children:
                return []
        elif t == "tableRow":
            children = [c for c in children if c["type"] in ("tableCell", "tableHeader")]
            if not children:
                return []
        elif t in ("tableCell", "tableHeader", "blockquote", "callout"):
            if not children:
                children = [paragraph("")]
        elif t in ("paragraph", "heading", "codeBlock"):
            children = [c for c in children if c["type"] in ("text", "hardBreak")]
        n["content"] = children
        return [n]

    content: list[dict] = []
    for c in d.get("content") or []:
        content.extend(fix(c))
    return {"type": "doc", "content": content or [paragraph("")]}


# ------------------------------------------------- converters (migration)

_CAPS = re.compile(r"^[A-Z0-9][A-Z0-9 &/\-:,.()']{3,}$")
_IMG_MARK = re.compile(r"\[\[IMG(\d+)\]\]")


def _detail_blocks(detail: str) -> list[dict]:
    """The old step `detail`: lines starting "- " become a bullet list, the
    rest paragraphs."""
    detail = (detail or "").strip()
    if not detail:
        return []
    out: list[dict] = []
    bullets: list[str] = []
    for line in detail.split("\n"):
        s = line.strip()
        if s.startswith("- ") or s.startswith("• "):
            bullets.append(s[2:].strip())
            continue
        if bullets:
            out.append(bullet_list(bullets))
            bullets = []
        if s:
            out.append(paragraph(s))
    if bullets:
        out.append(bullet_list(bullets))
    return out


def from_guided(body: dict, resolve_image=None, title: str = "") -> tuple[dict, list[str]]:
    """Old form body -> doc. Returns (doc, notes) where notes list anything a
    person should look at ("2 inline images kept as data URLs", "chapter
    sections reference missing pages"). `resolve_image(ref) -> url|None`
    turns a kb-media path / data URL into a stored URL."""
    notes: list[str] = []
    body = body if isinstance(body, dict) else {}
    out: list[dict] = []

    def img(ref: Any) -> str:
        if not isinstance(ref, str) or not ref.strip():
            return ""
        if resolve_image:
            url = resolve_image(ref)
            if url:
                return url
            notes.append(f"image could not be stored: {ref[:60]}")
            return ""
        return ref

    purpose = (body.get("purpose") or "").strip()
    scope = (body.get("scopeText") or "").strip()
    if purpose:
        out.append(heading("Purpose"))
        out.extend(paragraph(p) for p in purpose.split("\n\n") if p.strip())
    if scope:
        out.append(heading("Scope"))
        out.extend(paragraph(p) for p in scope.split("\n\n") if p.strip())

    materials = [m if isinstance(m, str) else (m.get("text") or "") for m in (body.get("materials") or []) if m]
    if any(materials):
        out.append(heading("Materials and Required Items"))
        out.append(bullet_list(materials))

    resp = [r for r in (body.get("responsibilities") or []) if isinstance(r, dict)]
    if resp:
        out.append(heading("Responsibilities"))
        out.append(table(["Role", "Responsibility"], [[r.get("role") or r.get("who") or "", r.get("duty") or r.get("responsibility") or ""] for r in resp]))
    elif any(isinstance(r, str) and r.strip() for r in (body.get("responsibilities") or [])):
        out.append(heading("Responsibilities"))
        out.append(bullet_list([r for r in body.get("responsibilities") if isinstance(r, str)]))

    defs = [r for r in (body.get("definitions") or []) if isinstance(r, dict)]
    if defs:
        out.append(heading("Definitions"))
        out.append(table(["Term", "Definition"], [[r.get("term") or "", r.get("def") or r.get("definition") or ""] for r in defs]))

    for t in body.get("tables") or []:
        if not isinstance(t, dict):
            continue
        hdr = [str(h) for h in (t.get("headers") or [])]
        rows = [[str(c) for c in (r or [])] for r in (t.get("rows") or []) if isinstance(r, list)]
        if hdr or rows:
            if t.get("title"):
                out.append(heading(str(t["title"]), 3))
            out.append(table(hdr, rows))

    proc = [s for s in (body.get("procedure") or []) if s]
    if proc:
        out.append(heading("Procedure"))
        group: list[dict] = []

        def flush():
            nonlocal group
            if group:
                out.append(steps(group))
                group = []

        for s in proc:
            if isinstance(s, str):
                s = {"text": s}
            if not isinstance(s, dict):
                continue
            txt = (s.get("text") or s.get("step") or "").strip()
            detail = s.get("detail") or ""
            photo = img(s.get("image"))
            # ALL-CAPS line with nothing under it = a sub-heading in the old import
            if txt and not detail.strip() and not photo and _CAPS.match(txt) and len(txt) < 80:
                flush()
                out.append(heading(txt.title() if txt.isupper() else txt, 3))
                continue
            if not txt and not detail and not photo:
                continue
            group.append(step(txt or "Step", _detail_blocks(detail), [photo] if photo else []))
        flush()

    safety = [s for s in (body.get("safety") or []) if isinstance(s, str) and s.strip()]
    if safety:
        out.append(heading("Safety and Compliance"))
        out.append(callout("safety", [bullet_list(safety)]))

    refs = [r for r in (body.get("references") or []) if isinstance(r, str) and r.strip()]
    if refs:
        out.append(heading("References"))
        out.append(bullet_list(refs))

    media = [m for m in (body.get("media") or []) if isinstance(m, dict) and m.get("url")]
    if media:
        out.append(heading("Videos"))
        for m in media:
            url = str(m.get("url"))
            if url.startswith("https://"):
                out.append(video(url, str(m.get("title") or "")))
            else:
                out.append(paragraph(f"{m.get('title') or 'Video'}: {url}"))

    atts = [a for a in (body.get("attachments") or []) if isinstance(a, dict)]
    if atts:
        out.append(heading("Attachments"))
        for a in atts:
            data = a.get("data") or ""
            name = str(a.get("name") or "attachment")
            if a.get("type") == "image" or str(data).startswith("data:image"):
                url = img(data)
                if url:
                    out.append(image(url, name))
                else:
                    out.append(paragraph(f"Attachment (image): {name}"))
                    notes.append(f"attachment image not stored: {name}")
            else:
                out.append(paragraph(f"Attachment: {name}"))
                notes.append(f"non-image attachment kept by name only: {name}")

    # Manuals: chapters -> headings; SOP sections -> embedded pages
    chapters = [c for c in (body.get("chapters") or []) if isinstance(c, dict)]
    if chapters:
        for ch in chapters:
            out.append(heading(str(ch.get("title") or "Chapter"), 2))
            if ch.get("intro"):
                out.append(paragraph(str(ch["intro"])))
            for sec in ch.get("sections") or []:
                if not isinstance(sec, dict):
                    continue
                if sec.get("kind") == "sop" and sec.get("docId"):
                    out.append(embed_page(str(sec["docId"]), str(sec.get("title") or "")))
                else:
                    if sec.get("title"):
                        out.append(heading(str(sec["title"]), 3))
                    for p in str(sec.get("body") or "").split("\n\n"):
                        if p.strip():
                            out.append(paragraph(p))
        notes.append("manual: chapters converted to headings; consider making it a collection with a reading order")

    if not out:
        notes.append("empty body")
    return doc(out or None), notes


_STYLE_MAP = {"styledParagraph": "paragraph", "styledHeading": "heading", "resizableImage": "image"}


def from_tiptap_document(content: Any, image_ok=None) -> tuple[dict, list[str]]:
    """A Document Builder document (`content.pages[].json` or `content.body`)
    -> page doc. Builder-only nodes are flattened: section boxes become a
    heading plus their body, merge fields their token text, page breaks a
    rule."""
    notes: list[str] = []
    content = content if isinstance(content, dict) else {}
    pages = content.get("pages")
    docs = []
    if isinstance(pages, list):
        for p in pages:
            j = (p or {}).get("json") if isinstance(p, dict) else None
            if isinstance(j, dict):
                docs.append(j)
    elif isinstance(content.get("body"), dict):
        docs.append(content["body"])
    if not docs:
        notes.append("linked document has no content")
        return doc(), notes

    def conv(node: Any) -> list[dict]:
        if not isinstance(node, dict):
            return []
        t = node.get("type")
        t = _STYLE_MAP.get(t, t)
        if t == "sectionBox":
            label = str((node.get("attrs") or {}).get("label") or "").strip()
            out = [heading(label, 2)] if label else []
            for c in node.get("content") or []:
                out.extend(conv(c))
            return out
        if t == "mergeField":
            tok = str((node.get("attrs") or {}).get("token") or "")
            return [text(f"{{{{{tok}}}}}")] if tok else []
        if t == "pageBreak":
            return [{"type": "horizontalRule"}]
        if t in ("docShape", "docTextbox", "signatureBlock", "bookmark"):
            txt = node_text(node).strip()
            return [paragraph(txt)] if txt else []
        n = {"type": t}
        if node.get("attrs"):
            n["attrs"] = dict(node["attrs"])
        if node.get("marks"):
            n["marks"] = node["marks"]
        if node.get("text") is not None:
            n["text"] = node["text"]
        kids: list[dict] = []
        for c in node.get("content") or []:
            kids.extend(conv(c))
        if kids or "content" in node:
            n["content"] = kids
        return [n]

    content_nodes: list[dict] = []
    for i, d in enumerate(docs):
        if i:
            content_nodes.append({"type": "horizontalRule"})
        for c in d.get("content") or []:
            content_nodes.extend(conv(c))
    return sanitize({"type": "doc", "content": content_nodes}, image_ok=image_ok), notes


def from_plain_text(txt: str) -> dict:
    """Pasted or extracted text -> paragraphs, with simple structure: a short
    line followed by a blank line becomes a heading, "1." / "-" lines become
    lists. The honest fallback when the AI import fails."""
    txt = (txt or "").replace("\r\n", "\n").replace("\r", "\n")
    out: list[dict] = []
    bullets: list[str] = []
    numbered: list[str] = []

    def flush():
        nonlocal bullets, numbered
        if bullets:
            out.append(bullet_list(bullets))
            bullets = []
        if numbered:
            out.append(ordered_list(numbered))
            numbered = []

    paras = [p for p in re.split(r"\n\s*\n", txt)]
    for p in paras:
        lines = [ln.rstrip() for ln in p.split("\n") if ln.strip()]
        if not lines:
            continue
        if len(lines) == 1 and len(lines[0]) < 70 and not lines[0].endswith(".") and (
                _CAPS.match(lines[0].strip()) or lines[0].strip().endswith(":")):
            flush()
            out.append(heading(lines[0].strip().rstrip(":").title() if lines[0].isupper() else lines[0].strip().rstrip(":"), 2))
            continue
        for ln in lines:
            s = ln.strip()
            if re.match(r"^[-*•]\s+", s):
                if numbered:
                    flush()
                bullets.append(re.sub(r"^[-*•]\s+", "", s))
            elif re.match(r"^\d+[.)]\s+", s):
                if bullets:
                    flush()
                numbered.append(re.sub(r"^\d+[.)]\s+", "", s))
            else:
                flush()
                out.append(paragraph(s))
        flush()
    flush()
    return doc(out or None)


def _units(d: dict) -> list[str]:
    """The comparable units of a page: each top-level block, except that a
    steps block yields one unit per step and a list one per item, so a
    revision that adds one step reads as one addition."""
    out: list[str] = []
    for n in d.get("content") or []:
        if not isinstance(n, dict):
            continue
        if n.get("type") == "steps":
            out.extend(node_text(s).strip() for s in (n.get("content") or []) if isinstance(s, dict))
        elif n.get("type") in ("bulletList", "orderedList", "checklist"):
            out.extend(node_text(i).strip() for i in (n.get("content") or []) if isinstance(i, dict))
        else:
            out.append(node_text(n).strip())
    return [u for u in out if u]


def diff_summary(old: dict, new: dict) -> dict:
    """Change summary for a revision: the units added and removed (text),
    used by the review screen's "Changes Only" view and the policy re-sign
    banner."""
    o, n = _units(old), _units(new)
    os_, ns = set(o), set(n)
    added = [t for t in n if t not in os_]
    removed = [t for t in o if t not in ns]
    return {"added": added[:80], "removed": removed[:80], "unchanged": len([t for t in n if t in os_]),
            "old_blocks": len(o), "new_blocks": len(n)}


def word_count(d: dict) -> int:
    return len(re.findall(r"\w+", plain_text(d)))


def reading_minutes(d: dict) -> int:
    return max(1, round(word_count(d) / 200))
