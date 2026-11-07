"""Markdown subset -> Knowledge Base block JSON (Storage Academy authoring).

Supported: ## / ### headings, paragraphs, **bold**, *italic*, bullets, 1. lists,
- [ ] checklists, GitHub tables, > [!TIP|NOTE|WARNING|SAFETY] callouts, ---,
and a figure (11/07/2026): a fenced block whose first line is ```figure and
whose body is the figure's JSON ({"kind": "steps", "title": ..., "items":
[...]}; the kinds and keys are kb_blocks.FIGURE_KINDS / _FIGURE_KEYS). A
fence that is not valid JSON, or names no known kind, is an error.
Anything else stays a paragraph. A `#` line is an error: the lesson title
comes from the front matter.
"""
from __future__ import annotations

import json
import re

import kb_blocks as kb

_INLINE = re.compile(r"\*\*(.+?)\*\*|\*(.+?)\*")
_CALLOUT = re.compile(r"^>\s*\[!(TIP|NOTE|WARNING|SAFETY)\]\s*$", re.I)
_BULLET = re.compile(r"^[-*]\s+(.*)$")
_ORDERED = re.compile(r"^\d+\.\s+(.*)$")
_CHECK = re.compile(r"^-\s+\[ \]\s+(.*)$")
_SEP = re.compile(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$")


def parse(md: str) -> tuple[dict, str]:
    """Split optional `---` front matter (key: value lines) from the body."""
    lines = md.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, md
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            meta = {}
            for ln in lines[1:i]:
                k, sep, v = ln.partition(":")
                if sep and k.strip():
                    meta[k.strip()] = v.strip().strip('"')
            return meta, "\n".join(lines[i + 1:]).lstrip("\n")
    return {}, md


def _inline(s: str) -> list[dict]:
    out, pos = [], 0
    for m in _INLINE.finditer(s):
        if m.start() > pos:
            out.append(kb.text(s[pos:m.start()]))
        bold = m.group(1) is not None
        out.append(kb.text(m.group(1) or m.group(2), [{"type": "bold" if bold else "italic"}]))
        pos = m.end()
    if pos < len(s):
        out.append(kb.text(s[pos:]))
    return out


def _para(s: str) -> dict:
    return {"type": "paragraph", "content": _inline(s.strip())}


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _is_block_start(ln: str) -> bool:
    s = ln.strip()
    return (not s or s.startswith(("#", ">", "|", "```")) or s == "---" or bool(_BULLET.match(s) or _ORDERED.match(s)))


def to_blocks(md: str) -> dict:
    lines = md.replace("\r\n", "\n").split("\n")
    out: list[dict] = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s:
            i += 1
        elif s.startswith("# "):
            raise ValueError(f"line {i + 1}: '#' is reserved for the lesson title; use ##")
        elif s.startswith("### ") or s.startswith("## "):
            level = 3 if s.startswith("###") else 2
            out.append(kb.heading(s.lstrip("#").strip(), level))
            i += 1
        elif s == "---":
            out.append({"type": "horizontalRule"})
            i += 1
        elif s.startswith("```"):
            fence = s[3:].strip().lower()
            start = i
            i += 1
            body: list[str] = []
            while i < len(lines) and lines[i].strip() != "```":
                body.append(lines[i])
                i += 1
            if i >= len(lines):
                raise ValueError(f"line {start + 1}: the ``` fence is never closed")
            i += 1
            if fence != "figure":
                raise ValueError(f"line {start + 1}: only ```figure fences are supported")
            try:
                data = json.loads("\n".join(body))
            except ValueError as e:
                raise ValueError(f"line {start + 1}: figure is not valid JSON ({e})") from None
            if not isinstance(data, dict) or data.get("kind") not in kb.FIGURE_KINDS:
                raise ValueError(f"line {start + 1}: figure needs a kind: {', '.join(kb.FIGURE_KINDS)}")
            out.append(kb.figure(data["kind"], {k: v for k, v in data.items() if k != "kind"}))
        elif _CALLOUT.match(s):
            kind = _CALLOUT.match(s).group(1).lower()
            i += 1
            body: list[str] = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                body.append(lines[i].strip()[1:].strip())
                i += 1
            paras = [_para(p.replace("\n", " ")) for p in "\n".join(body).split("\n\n") if p.strip()]
            out.append(kb.callout(kind, paras))
        elif s.startswith("|") and i + 1 < len(lines) and _SEP.match(lines[i + 1].strip()):
            headers = _cells(s)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(_cells(lines[i]))
                i += 1
            t = kb.table(headers, rows)
            for row, raw in zip(t["content"], [headers] + rows):  # cells carry bold/italic too
                for cell, txt in zip(row["content"], raw):
                    cell["content"] = [_para(txt)]
            out.append(t)
        elif _CHECK.match(s):
            items = []
            while i < len(lines) and _CHECK.match(lines[i].strip()):
                items.append(_CHECK.match(lines[i].strip()).group(1))
                i += 1
            c = kb.checklist(items)
            for node, raw in zip(c["content"], items):
                node["content"] = _inline(raw.strip())
            out.append(c)
        elif _BULLET.match(s) or _ORDERED.match(s):
            rx = _BULLET if _BULLET.match(s) else _ORDERED
            items = []
            while i < len(lines) and rx.match(lines[i].strip()) and not _CHECK.match(lines[i].strip()):
                items.append(rx.match(lines[i].strip()).group(1))
                i += 1
            lst = (kb.bullet_list if rx is _BULLET else kb.ordered_list)(items)
            for li, raw in zip(lst["content"], items):
                li["content"] = [_para(raw)]
            out.append(lst)
        else:
            buf = [s]
            i += 1
            while i < len(lines) and not _is_block_start(lines[i]):
                buf.append(lines[i].strip())
                i += 1
            out.append(_para(" ".join(buf)))
    return kb.sanitize(kb.doc(out))


def word_count(md: str) -> int:
    return kb.word_count(to_blocks(parse(md)[1]))
