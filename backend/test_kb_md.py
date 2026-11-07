import pytest

import kb_blocks
import kb_md

SAMPLE = """---
title: X
summary: Y
---

## Heading

Hello **world** and *you*.

- one
- two

1. first
2. second

- [ ] check **it**

| Size | Fits |
|---|---|
| 5x5 | Boxes |

> [!TIP]
> Be kind.

---

### Sub
"""


def test_headings_and_paragraphs():
    d = kb_md.to_blocks("## A\n\nHello **world**.")
    assert d["content"][0]["type"] == "heading" and d["content"][0]["attrs"]["level"] == 2
    assert d["content"][0]["content"][0]["text"] == "A"
    node = d["content"][1]["content"][1]
    assert node["text"] == "world" and node["marks"] == [{"type": "bold"}]


def test_lists_and_checklist():
    d = kb_md.to_blocks("- a\n- b\n\n1. x\n2. y\n\n- [ ] x")
    assert [n["type"] for n in d["content"]] == ["bulletList", "orderedList", "checklist"]
    assert len(d["content"][0]["content"]) == 2
    assert d["content"][2]["content"][0]["type"] == "checkItem"
    assert len(d["content"][2]["content"]) == 1


def test_table():
    t = kb_md.to_blocks("| Size | Fits |\n|---|---|\n| 5x5 | Boxes |")["content"][0]
    assert t["type"] == "table" and len(t["content"]) == 2
    assert [c["type"] for c in t["content"][0]["content"]] == ["tableHeader"] * 2
    assert t["content"][0]["content"][0]["content"][0]["content"][0]["text"] == "Size"
    assert t["content"][1]["content"][1]["content"][0]["content"][0]["text"] == "Boxes"


@pytest.mark.parametrize("k", ["TIP", "NOTE", "WARNING", "SAFETY"])
def test_callouts(k):
    n = kb_md.to_blocks(f"> [!{k}]\n> Careful.")["content"][0]
    assert n["type"] == "callout" and n["attrs"]["kind"] == k.lower()
    assert n["content"][0]["content"][0]["text"] == "Careful."


def test_front_matter():
    meta, body = kb_md.parse("---\ntitle: X\nsummary: Y\n---\n\n## A")
    assert meta == {"title": "X", "summary": "Y"} and body == "## A"


def test_h1_rejected():
    with pytest.raises(ValueError):
        kb_md.to_blocks("# Title")


def test_output_survives_sanitize():
    d = kb_md.to_blocks(kb_md.parse(SAMPLE)[1])
    assert kb_blocks.sanitize(d) == d
    assert any(n["type"] == "horizontalRule" for n in d["content"])
    assert kb_md.word_count(SAMPLE) > 10


def test_figure_fence_becomes_a_figure_block():
    d = kb_md.to_blocks('## A\n\n```figure\n{"kind": "steps", "title": "Flow", "items": [{"label": "One", "note": "first"}], "bogus": 1}\n```\n\nAfter.')
    fig = d["content"][1]
    assert fig["type"] == "figure" and fig["attrs"]["kind"] == "steps"
    assert fig["attrs"]["data"] == {"title": "Flow", "items": [{"label": "One", "note": "first"}]}   # unknown keys dropped
    assert d["content"][2]["content"][0]["text"] == "After."
    assert kb_blocks.sanitize(d) == d
    assert "Flow" in kb_blocks.node_text(fig) and "first" in kb_blocks.node_text(fig)


@pytest.mark.parametrize("md", ["```figure\nnot json\n```", "```figure\n{\"kind\": \"pie\"}\n```", "```python\nx = 1\n```", "```figure\n{\"kind\": \"steps\"}"])
def test_bad_fences_are_errors(md):
    with pytest.raises(ValueError):
        kb_md.to_blocks(md)


def test_sanitize_bounds_a_figure():
    big = {"type": "doc", "content": [{"type": "figure", "attrs": {"kind": "bars", "data": {"title": "x" * 500, "items": [{"label": "a", "value": 1, "tone": "neon", "evil": "<script>"}] * 60, "max": float("inf")}}}]}
    out = kb_blocks.sanitize(big)["content"][0]["attrs"]["data"]
    assert len(out["title"]) == 300 and len(out["items"]) == 40 and "max" not in out
    assert out["items"][0] == {"label": "a", "value": 1, "tone": ""}
    assert kb_blocks.sanitize({"type": "doc", "content": [{"type": "figure", "attrs": {"kind": "nope", "data": {}}}]})["content"][0]["type"] == "paragraph"
