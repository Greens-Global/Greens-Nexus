#!/usr/bin/env python3
"""Turn a pin's `actions` trace into a Playwright repro skeleton for Claude
Code to finish.

    python3 tools/build_notes/repro_template.py ~/.cache/nexus-build-notes/<id>/pin.json \
        [--e2e | --python] [--base http://localhost:5173] [--out PATH | --stdout]

Two forms:

  --e2e (the default for a pin with an action trace, and for Bug pins): a
      Playwright Test spec in the repo's e2e/ format - the two imports (the
      helpers from '../helpers.mjs'), one test titled
      '[<pin id>] Pin #<n> - <summary>', the helpers first and a FAILING TODO
      assertion. Written to ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs.
      Run it with run_e2e.py; once the author accepts the fix it becomes a
      regression test in the nightly qa-e2e suite.
  --python: the standalone Python script (sync API) that exits 0 (PASSING) or
      1 (FAILING); written to repro_pin_<n>.py.

An --out name ending in .py picks the Python form, .mjs / .js the e2e form.
The input is the pin.json `claim` saved (uses `id`, `actions`, `url`,
`route`, `sub`, `number`, `comment`, `target`, `viewport`) or a bare JSON list
of actions. Pin text only ever lands in comments (and, escaped, in the e2e
test title) - never in code.

Standard library only; the Python form needs `pip install playwright` and
`playwright install chromium` where it runs.
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from . import common
except ImportError:  # run as a plain script: python3 tools/build_notes/repro_template.py
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import common

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


def _safe_title(text):
    """A title that cannot close the docstring: one line, no quotes, no trailing backslash."""
    one = " ".join(str(text or "").split())
    return one.replace('"', "'").replace("\\", "/").strip() or "pin"


def _comment_lines(label, text, limit=400):
    """`# Label: text` as one or more comment lines - pin text never goes into code or a docstring."""
    body = " ".join(str(text or "").split())
    if not body:
        return []
    body = body[:limit] + ("..." if len(body) > limit else "")
    return ["# " + label + ": " + body]


def default_script_name(number):
    return ("repro_pin_" + str(number) if number is not None else "repro") + ".py"


def default_out_path(pin, kind="python"):
    """~/.cache/nexus-build-notes/<id>/repro_pin_<n>.py (or .spec.mjs for the
    e2e form) for a pin.json; None for a bare actions list."""
    if not isinstance(pin, dict) or not pin.get("id"):
        return None
    name = default_spec_name(pin.get("number")) if kind == "e2e" else default_script_name(pin.get("number"))
    return common.CACHE_DIR / str(pin.get("id")) / name


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

    # Nothing from the pin goes inside the docstring - the comment and the
    # source path are emitted as `#` comment lines, one line each, so a
    # triple quote or a trailing backslash in them cannot break the script.
    lines = [
        "#!/usr/bin/env python3",
        '"""Repro for ' + _safe_title(title) + '.',
        "",
        "Generated by tools/build_notes/repro_template.py from the pin's action trace.",
        "Run against the local dev server: exit 0 = PASSING, 1 = FAILING.",
        "    python3 " + default_script_name(number),
        '"""',
    ]
    for ln in _comment_lines("Pin comment", comment):
        lines.append(ln)
    if src.get("file"):
        lines.extend(_comment_lines("Source stamp", str(src.get("file")) + ":" + str(src.get("line") or "?")))
    lines += [
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


# --------------------------------------------------------------------------
# The e2e form: a Playwright Test spec in the repo's e2e/ format
# --------------------------------------------------------------------------

E2E_HELPERS = "openApp, go, clickByText, fillByLabel, selectByLabel, expectVisible"
SUMMARY_LIMIT = 80


def _js(value):
    """A single-quoted JavaScript string literal."""
    text = str(value)
    for a, b in (("\\", "\\\\"), ("'", "\\'"), ("\n", "\\n"), ("\r", "\\r"), ("\t", "\\t"),
                 (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(a, b)
    return "'" + text + "'"


def _js_comment(label, text, limit=400):
    """`// Label: text` on one line - pin text never goes into code."""
    body = " ".join(str(text or "").split())
    if not body:
        return []
    body = body[:limit] + ("..." if len(body) > limit else "")
    return ["// " + label + ": " + body]


def spec_summary(comment):
    """The test title's one-line summary from the pin comment."""
    one = " ".join(str(comment or "").split())
    if len(one) > SUMMARY_LIMIT:
        one = one[:SUMMARY_LIMIT - 3].rstrip() + "..."
    return one or "regression"


def spec_title(pin_id, number, comment):
    """'[<pin id>] Pin #<n> - <summary>' - post-results.mjs maps verdicts by the id."""
    return "[" + str(pin_id) + "] Pin #" + str(number if number is not None else "?") + " - " + spec_summary(comment)


def _view_arg(path):
    """go(page, view) takes the path without its leading slash."""
    return str(path or "/").lstrip("/")


def e2e_action_lines(action, index):
    """The spec lines (unindented) for one recorded action: helpers first,
    a raw locator only when no helper fits."""
    t = str(action.get("type") or "").lower()
    label = action.get("label")
    selector = action.get("selector")
    shown = label or selector or ""
    head = "// " + str(index) + ". " + t + (" " + json.dumps(str(shown)) if shown else "")
    alt = ["// or: await page.locator(" + _js(selector) + ").first().click();"] if (t == "click" and label and selector) else []
    if t == "click":
        if label:
            return [head] + alt + ["await clickByText(page, " + _js(label) + ");"]
        if selector:
            return [head, "await page.locator(" + _js(selector) + ").first().click();"]
        return [head + " (no label or selector captured)", "// TODO: click the right element"]
    if t == "input":
        value = action.get("value")
        masked = value in (None, "") or _is_masked(value)
        filled = "TODO: the value typed here" if masked else str(value)
        if masked:
            head += " (value was masked at capture)"
        if label:
            lines = [head, "await fillByLabel(page, " + _js(label) + ", " + _js(filled) + ");"]
            if selector:
                lines.insert(1, "// or: await page.locator(" + _js(selector) + ").first().fill(...);")
            return lines
        if selector:
            return [head, "await page.locator(" + _js(selector) + ").first().fill(" + _js(filled) + ");"]
        return [head, "// TODO: fill the right field"]
    if t == "select":
        if label and action.get("value") not in (None, ""):
            return [head, "await selectByLabel(page, " + _js(label) + ", " + _js(action.get("value")) + ");"]
        return [head + " (not replayed - check the brief)"]
    if t == "nav":
        path = route_path(action.get("view"), action.get("sub")) if action.get("view") else str(action.get("value") or action.get("label") or "/")
        if not path.startswith("/"):
            path = "/" + path
        if path == "/":
            return [head, "await openApp(page);"]
        return [head, "await go(page, " + _js(_view_arg(path)) + ");"]
    if t == "key":
        key = str(action.get("value") or action.get("label") or "Enter")
        return [head, "await page.keyboard.press(" + _js(key) + ");"]
    if t == "scroll":
        amount = action.get("value")
        try:
            amount = int(float(amount))
        except (TypeError, ValueError):
            amount = 400
        return [head, "await page.mouse.wheel(0, " + str(amount) + ");"]
    return [head + " (not replayed - check the brief)"]


def build_spec(actions, pin_id="", route=None, sub=None, url=None, number=None, comment="", target=None, viewport=None):
    """The whole e2e spec as text, in the format e2e/sync.mjs and
    e2e/post-results.mjs expect."""
    target = target or {}
    viewport = viewport or {}
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
    text = str(target.get("text") or "").strip()
    selector = str(target.get("selector") or "").strip()
    src = target.get("source") or {}
    pid = str(pin_id or "TODO-pin-id")

    lines = [
        "// Regression spec for Pin #" + str(number if number is not None else "?") + " - generated by",
        "// tools/build_notes/repro_template.py --e2e from the pin's action trace.",
    ]
    lines += _js_comment("Pin comment", comment)
    if src.get("file"):
        lines += _js_comment("Source stamp", str(src.get("file")) + ":" + str(src.get("line") or "?"))
    lines += [
        "//",
        "// The nightly qa-e2e run starts from an EMPTY database (a fresh SQLite with",
        "// no rows). This spec must create every record it needs itself - through the",
        "// UI or page.request against the API - and never rely on data that happens to",
        "// exist on your machine.",
        "// Run it the way CI does: python3 tools/build_notes/run_e2e.py <this file> --ref origin/dev",
        "// (must print FAILING), then --ref <branch> (must print PASSING).",
        "// Use the helpers first; a raw page locator only when no helper fits.",
        "import { test, expect } from '@playwright/test';",
        "import { " + E2E_HELPERS + " } from '../helpers.mjs';",
        "",
        "test(" + _js(spec_title(pid, number, comment)) + ", async ({ page }) => {",
    ]
    body = []
    if width != 1440 or height != 900:
        body.append("await page.setViewportSize({ width: " + str(width) + ", height: " + str(height) + " });")
    body.append("await openApp(page);")
    body.append("")
    body.append("// TODO: create the data this pin needs first (the database is empty) - through")
    body.append("// the UI, or the API (auth is skipped on the e2e backend; CI runs it on :8000):")
    body.append("// const API = process.env.NEXUS_E2E_API || 'http://localhost:8000';")
    body.append("// const res = await page.request.post(API + '/TODO', { data: { /* ... */ } });")
    body.append("// expect(res.ok()).toBeTruthy();")
    body.append("")
    if path and path != "/":
        body.append("await go(page, " + _js(_view_arg(path)) + ");")
    acts = [a for a in (actions or []) if isinstance(a, dict)]
    if acts:
        body.append("")
        body.append("// Replay of the author's last " + str(len(acts)) + " actions (newest last).")
        for i, a in enumerate(acts, 1):
            body.extend(e2e_action_lines(a, i))
    body.append("")
    body.append("// TODO: replace the next line with the pin's complaint as an expectation that")
    body.append("// FAILS on origin/dev and PASSES on the branch. For example:")
    if selector:
        body.append("// await expect(page.locator(" + _js(selector) + ").first()).toHaveText('TODO: the corrected text');")
    if text:
        body.append("// await expectVisible(page, " + _js(text) + ");")
    body.append("// await expect(page.locator('TODO: selector').first()).toHaveCSS('padding', '12px 16px');")
    body.append("expect(false, 'TODO: assert the pin complaint').toBe(true);")
    lines += ["  " + ln if ln else "" for ln in body]
    lines += ["});", ""]
    return "\n".join(lines)


def spec_from_pin(pin, pin_id=""):
    """Build the e2e spec from a pin.json dict (or a bare actions list)."""
    if isinstance(pin, list):
        return build_spec(pin, pin_id=pin_id)
    return build_spec(
        pin.get("actions") or [], pin_id=pin_id or pin.get("id") or "", route=pin.get("route"), sub=pin.get("sub"),
        url=pin.get("url"), number=pin.get("number"), comment=pin.get("comment") or "",
        target=pin.get("target") or {}, viewport=pin.get("viewport") or {},
    )


def default_kind(pin, out=None):
    """e2e for a pin with an action trace or a Bug pin, python otherwise; an
    explicit --out file name decides first (.py -> python, .mjs/.js -> e2e)."""
    if out:
        name = str(out).lower()
        if name.endswith(".py"):
            return "python"
        if name.endswith((".mjs", ".js")):
            return "e2e"
    if isinstance(pin, dict):
        if pin.get("actions") or str(pin.get("kind") or "").lower() == "bug":
            return "e2e"
        return "python"
    return "python"   # a bare actions list has no pin id to put in a spec title


def default_spec_name(number):
    return ("repro_pin_" + str(number) if number is not None else "repro") + ".spec.mjs"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Playwright repro skeleton from a pin's action trace.")
    parser.add_argument("pin", help="pin.json from `claim`, or a JSON list of actions")
    form = parser.add_mutually_exclusive_group()
    form.add_argument("--e2e", action="store_true", help="a Playwright Test spec in the repo's e2e format (default for pins with actions and Bug pins)")
    form.add_argument("--python", action="store_true", help="the standalone Python script (exit 0 PASSING, 1 FAILING)")
    parser.add_argument("--pin-id", help="pin id for the spec title when the input is a bare actions list")
    parser.add_argument("--base", default=DEFAULT_BASE, help="dev server base URL for --python (default " + DEFAULT_BASE + ")")
    parser.add_argument("--out", help="where to write it (default ~/.cache/nexus-build-notes/<id>/repro_pin_<n>.spec.mjs or .py, next to pin.json - never the repo)")
    parser.add_argument("--stdout", action="store_true", help="print it instead of writing a file")
    args = parser.parse_args(argv)
    try:
        pin = json.loads(Path(args.pin).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print("Cannot read " + args.pin + ": " + str(exc), file=sys.stderr)
        return 2
    kind = "e2e" if args.e2e else "python" if args.python else default_kind(pin, args.out)
    if kind == "e2e":
        script = spec_from_pin(pin, pin_id=args.pin_id or "")
        if "[TODO-pin-id]" in script:
            print("Warning: no pin id - pass --pin-id so the test title starts with [<pin id>]", file=sys.stderr)
    else:
        script = script_from_pin(pin, base=args.base)
    out = Path(args.out).expanduser() if args.out else (None if args.stdout else default_out_path(pin, kind))
    if out is None:
        print(script, end="")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(script, encoding="utf-8")
    print("Wrote " + str(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
