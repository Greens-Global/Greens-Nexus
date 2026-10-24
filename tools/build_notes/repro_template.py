#!/usr/bin/env python3
"""Turn a pin's `actions` trace into a Playwright (Python, sync API) repro
script skeleton for Claude Code to finish.

    python3 tools/build_notes/repro_template.py ~/.cache/nexus-build-notes/<id>/pin.json \
        [--base http://localhost:5173] [--out repro_pin_<n>.py]

The input is the pin.json `claim` saved (uses `actions`, `url`, `route`, `sub`,
`number`, `comment`, `target`, `viewport`) or a bare JSON list of actions.
The script replays the clicks, inputs, keys and navigations, then asserts the
pin's complaint - the assertion is a TODO the skill fills in. Running the
finished script exits 0 (PASSING) or 1 (FAILING), which is what
`cli.py verify --before ... --after ...` records.

Standard library only; the generated script needs `pip install playwright`
and `playwright install chromium` where it runs.
"""

import argparse
import json
import sys
from pathlib import Path

# Address-bar aliases, mirroring frontend/src/lib/routes.js VIEW_TO_PATH.
VIEW_TO_PATH = {"inventory": "itemmanagement", "ops": "construction", "myhr": "workday",
                "bi": "insights", "shifts": "team", "support": "help-center"}
DEFAULT_BASE = "http://localhost:5173"
MASKED_MARKERS = ("***", "****", "[masked]", "(masked)", "<masked>")


def route_path(view, sub=None):
    """'/workday/timesheet' from view 'myhr', sub 'timesheet'; '/' for the dashboard."""
    view = str(view or "").strip()
    if not view:
        return "/"
    if view == "dashboard":
        # App.jsx: plain Dashboard is '/', its Links tab is '/links', other tabs '/dashboard/<sub>'.
        if not sub:
            return "/"
        return "/links" if sub == "links" else "/dashboard/" + str(sub)
    seg = VIEW_TO_PATH.get(view, view)
    return "/" + seg + ("/" + str(sub) if sub else "")


def _py(value):
    """A Python string literal."""
    return json.dumps(str(value))


def _is_masked(value):
    v = str(value or "").strip()
    return v in MASKED_MARKERS or (v and set(v) <= set("*•"))


def _locator(action):
    """A Playwright locator expression for an action: by label first, selector second."""
    label = action.get("label")
    selector = action.get("selector")
    if label:
        if str(action.get("type") or "").lower() == "input":
            # A field's label is its <label> or placeholder, not visible text.
            return "page.get_by_label(" + _py(label) + ").or_(page.get_by_placeholder(" + _py(label) + ")).first"
        return "page.get_by_text(" + _py(label) + ", exact=True).first"
    if selector:
        return "page.locator(" + _py(selector) + ").first"
    return "page.locator(\"TODO: no label or selector captured\")"


def _alternative(action):
    """A comment naming the captured selector when the locator went by label."""
    if action.get("label") and action.get("selector"):
        return ["# or: page.locator(" + _py(action.get("selector")) + ").first"]
    return []


def action_lines(action, index, base_var="BASE"):
    """The script lines (unindented) for one recorded action."""
    t = str(action.get("type") or "").lower()
    label = action.get("label") or action.get("selector") or ""
    head = "# " + str(index) + ". " + t + (" " + _py(label) if label else "")
    if t in ("click", "input"):
        head_lines = [head] + _alternative(action)
    else:
        head_lines = [head]
    if t == "click":
        return head_lines + [_locator(action) + ".click()"]
    if t == "input":
        value = action.get("value")
        if value in (None, "") or _is_masked(value):
            head_lines[0] += " (value was masked at capture)"
            return head_lines + [_locator(action) + ".fill(\"TODO: the value typed here\")"]
        return head_lines + [_locator(action) + ".fill(" + _py(value) + ")"]
    if t == "nav":
        path = route_path(action.get("view"), action.get("sub")) if action.get("view") else str(action.get("value") or action.get("label") or "/")
        if not path.startswith("/"):
            path = "/" + path
        return [head, "page.goto(" + base_var + " + " + _py(path) + ")", "page.wait_for_load_state(\"networkidle\")"]
    if t == "key":
        key = str(action.get("value") or action.get("label") or "Enter")
        return [head, "page.keyboard.press(" + _py(key) + ")"]
    if t == "scroll":
        amount = action.get("value")
        try:
            amount = int(float(amount))
        except (TypeError, ValueError):
            amount = 400
        return [head, "page.mouse.wheel(0, " + str(amount) + ")"]
    return [head + " (not replayed - check the brief)", "pass"]


def build_script(actions, route=None, sub=None, url=None, number=None, comment="", target=None, viewport=None, base=DEFAULT_BASE):
    """The whole repro script as text."""
    target = target or {}
    viewport = viewport or {}
    # Where the pin was taken: the pin's own URL path wins, else route/sub.
    path = None
    if url:
        try:
            from urllib.parse import urlparse
            path = urlparse(str(url)).path or None
        except ValueError:
            path = None
    if not path:
        path = route_path(route, sub)
    width = int(float(viewport.get("w") or 1440))
    height = int(float(viewport.get("h") or 900))
    title = "Pin #" + str(number if number is not None else "?")
    text = str(target.get("text") or "").strip()
    selector = str(target.get("selector") or "").strip()
    src = target.get("source") or {}
    body = []
    body.append("page.goto(BASE + ROUTE)")
    body.append("page.wait_for_load_state(\"networkidle\")")
    acts = [a for a in (actions or []) if isinstance(a, dict)]
    if acts:
        body.append("")
        body.append("# Replay of the author's last " + str(len(acts)) + " actions (newest last).")
        for i, a in enumerate(acts, 1):
            body.extend(action_lines(a, i))
    body.append("")
    body.append("# TODO: assert the pin's complaint. The expectation must FAIL on origin/dev")
    body.append("# code and PASS on the branch. Pick one:")
    if selector:
        body.append("target = page.locator(" + _py(selector) + ").first")
    elif text:
        body.append("target = page.get_by_text(" + _py(text) + ", exact=True).first")
    else:
        body.append("target = page.locator(\"TODO: selector\")")
    body.append("expect(target).to_be_visible()")
    body.append("# expect(target).to_have_text(\"TODO: the corrected text\")")
    body.append("# expect(target).to_have_css(\"padding\", \"12px 16px\")")
    body.append("# assert not [m for m in console_errors if \"TODO: the error text\" in m], console_errors")

    lines = [
        "#!/usr/bin/env python3",
        '"""Repro for ' + title + (" - " + str(comment).strip().splitlines()[0] if str(comment).strip() else "") + '',
        "",
        "Generated by tools/build_notes/repro_template.py from the pin's action trace.",
        "Run against the local dev server: exit 0 = PASSING, 1 = FAILING.",
        "    python3 " + ("repro_pin_" + str(number) if number is not None else "repro") + ".py",
    ]
    if src.get("file"):
        lines.append("Source stamp: " + str(src.get("file")) + ":" + str(src.get("line") or "?"))
    lines += [
        '"""',
        "import sys",
        "",
        "from playwright.sync_api import expect, sync_playwright",
        "",
        "BASE = " + _py(base),
        "ROUTE = " + _py(path),
        "VIEWPORT = {\"width\": " + str(width) + ", \"height\": " + str(height) + "}",
        "console_errors = []",
        "",
        "",
        "def run(page):",
    ]
    lines += ["    " + ln if ln else "" for ln in body]
    lines += [
        "",
        "",
        "def main():",
        "    with sync_playwright() as p:",
        "        browser = p.chromium.launch()",
        "        page = browser.new_page(viewport=VIEWPORT)",
        "        page.on(\"console\", lambda m: console_errors.append(m.text) if m.type == \"error\" else None)",
        "        try:",
        "            run(page)",
        "        except Exception as exc:  # noqa: BLE001 - any failure is the repro failing",
        "            print(\"FAILING: \" + str(exc).splitlines()[0])",
        "            browser.close()",
        "            return 1",
        "        browser.close()",
        "    print(\"PASSING\")",
        "    return 0",
        "",
        "",
        "if __name__ == \"__main__\":",
        "    sys.exit(main())",
        "",
    ]
    return "\n".join(lines)


def script_from_pin(pin, base=DEFAULT_BASE):
    """Build the script from a pin.json dict (or a bare actions list)."""
    if isinstance(pin, list):
        return build_script(pin, base=base)
    return build_script(
        pin.get("actions") or [], route=pin.get("route"), sub=pin.get("sub"), url=pin.get("url"),
        number=pin.get("number"), comment=pin.get("comment") or "", target=pin.get("target") or {},
        viewport=pin.get("viewport") or {}, base=base,
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Playwright repro skeleton from a pin's action trace.")
    parser.add_argument("pin", help="pin.json from `claim`, or a JSON list of actions")
    parser.add_argument("--base", default=DEFAULT_BASE, help="dev server base URL (default " + DEFAULT_BASE + ")")
    parser.add_argument("--out", help="write the script here instead of stdout")
    args = parser.parse_args(argv)
    try:
        pin = json.loads(Path(args.pin).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print("Cannot read " + args.pin + ": " + str(exc), file=sys.stderr)
        return 2
    script = script_from_pin(pin, base=args.base)
    if args.out:
        Path(args.out).expanduser().write_text(script, encoding="utf-8")
        print("Wrote " + args.out)
    else:
        print(script, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
