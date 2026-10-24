#!/usr/bin/env python3
"""Run one Build Mode regression spec the way the nightly qa-e2e workflow does.

    python3 tools/build_notes/run_e2e.py <spec.mjs> --ref origin/dev     # before the fix: expect FAILING
    python3 tools/build_notes/run_e2e.py <spec.mjs> --ref <branch>       # after the fix: expect PASSING
                                         [--pin ID] [--keep]

For the ref it makes a scratch worktree under ~/.cache/nexus-build-notes/e2e/,
then builds a CI-shaped stack there (.github/workflows/qa-e2e.yml):

  - backend: the main checkout's backend/.venv python, a FRESH SQLite
    (DATABASE_URL=sqlite:///./e2e.db, no rows), NEXUS_SKIP_AUTH=true,
    NEXUS_DEV_EMAIL / NEXUS_OWNER_EMAIL=ci@greensglobal.com,
    NEXUS_QA_MODULE=true, on a free port - started, primed with /roles/me and
    restarted once, as CI does;
  - frontend: `vite build` with VITE_E2E=true (skips the MSAL gate) pointed
    at that backend, served with `vite preview` on a local port the backend's
    CORS list allows;
  - the spec copied to e2e/tests/generated/<pin id>.spec.mjs (its
    '../helpers.mjs' import rewritten the way e2e/sync.mjs does) and run with
    `npx playwright test` and NEXUS_E2E_URL.

It prints PASSING (exit 0) or FAILING (exit 1), read from Playwright's JSON
report: FAILING only when the one test ran and an expectation (`expect(`)
failed. Exit 2 is no verdict: the stack could not be built, the spec still has
the template's TODO assertion, or the spec is broken (a syntax, import or
reference error, no tests, or a stop before any expectation). Everything is stopped and the scratch worktree
removed afterwards (--keep leaves it for a look).

Needs Node; the e2e dependencies and the Chromium build matching their
Playwright version are installed the way CI installs them (`npm ci`,
`npx playwright install chromium` - quick when already there). Standard
library only.
"""

import argparse
import json
import os
import re
import shutil
import sys
import uuid
from pathlib import Path

try:
    from . import common, stack
except ImportError:  # run as a plain script: python3 tools/build_notes/run_e2e.py
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import common
    import stack

CI_EMAIL = "ci@greensglobal.com"
E2E_DB = "e2e.db"
TITLE_ID = re.compile(r"""test\(\s*(['"`])\[([0-9a-fA-F-]{36})\]""")
HELPERS_IMPORT = "from '../helpers.mjs'"
GENERATED_IMPORT = "from '../../helpers.mjs'"
TODO_ASSERTION = "expect(false, 'TODO"
LOCKFILE = "package-lock.json"
REPORT = "results.json"          # e2e/playwright.config.mjs: the json reporter's outputFile
BROKEN = "the spec is broken, not the bug"
BUILD_TIMEOUT = 900
TEST_TIMEOUT = 900
BOOT_TIMEOUT = 90


def pin_id_from_spec(text):
    """The pin id from a spec's test title: test('[<uuid>] Pin #n - ...'."""
    m = TITLE_ID.search(text or "")
    return m.group(2).lower() if m else ""


def generated_spec(text):
    """The spec as it must sit in e2e/tests/generated/ (sync.mjs rewrites the
    helpers import the same way)."""
    return str(text).replace(HELPERS_IMPORT, GENERATED_IMPORT).replace(HELPERS_IMPORT.replace("'", '"'), GENERATED_IMPORT.replace("'", '"'))


def backend_env(base_env):
    env = dict(base_env)
    env.update({
        "DATABASE_URL": "sqlite:///./" + E2E_DB,
        "NEXUS_SKIP_AUTH": "true",
        "NEXUS_DEV_EMAIL": CI_EMAIL,
        "NEXUS_OWNER_EMAIL": CI_EMAIL,
        "NEXUS_QA_MODULE": "true",
        "PYTHONUNBUFFERED": "1",
    })
    return env


def build_env(base_env, api_url):
    env = dict(base_env)
    for key in ("VITE_DEV_SKIP_AUTH", "VITE_DEV_USER_EMAIL"):
        env.pop(key, None)
    env["VITE_E2E"] = "true"
    env["VITE_API_BASE"] = api_url
    return env


def _report_tests(report):
    """Every test in a Playwright JSON report: [(title, [results])]."""
    found = []

    def walk(suite):
        for child in suite.get("suites") or []:
            walk(child)
        for spec in suite.get("specs") or []:
            for t in spec.get("tests") or []:
                found.append((spec.get("title") or "", t.get("results") or []))

    for suite in (report or {}).get("suites") or []:
        walk(suite)
    return found


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _first_line(text):
    for line in ANSI.sub("", str(text or "")).splitlines():
        if line.strip():
            return line.strip()
    return ""


def _errors(result):
    """[(first line, is an assertion)] for a test result's errors. Only the
    error's own first line counts: Playwright appends a source snippet to the
    message, and an `expect(` on a nearby line of the spec must not turn a
    ReferenceError into an assertion."""
    errors = list(result.get("errors") or [])
    if result.get("error") and result["error"] not in errors:
        errors.append(result["error"])
    out = []
    for e in errors:
        if isinstance(e, dict):
            line = _first_line(e.get("message")) or _first_line(e.get("stack"))
            assertion = bool(e.get("matcherResult")) or "expect(" in line
        else:
            line = _first_line(e)
            assertion = "expect(" in line
        out.append((line, assertion))
    return out


def classify(report, exit_code):
    """('PASSING' | 'FAILING' | None, why). FAILING means the one test ran and
    an expectation failed; anything else that went wrong is no verdict."""
    if not isinstance(report, dict):
        return None, "Playwright wrote no JSON report - " + BROKEN
    load_errors = [str((e or {}).get("message") or e) for e in report.get("errors") or []]
    if load_errors:
        return None, "Playwright could not load the spec (" + load_errors[0].splitlines()[0][:200] + ") - " + BROKEN
    tests = _report_tests(report)
    if not tests:
        return None, "no tests found - " + BROKEN
    if len(tests) != 1:
        return None, "the spec holds " + str(len(tests)) + " tests - a regression spec has exactly one"
    title, results = tests[0]
    if not results:
        return None, "the test did not run - " + BROKEN
    statuses = [str(r.get("status") or "") for r in results]
    if exit_code == 0 and "passed" in statuses:
        return "PASSING", "passed"
    errors = _errors(results[-1])
    # A test timeout reported next to a pending expect() is still that expectation failing.
    failed = [line for line, assertion in errors if assertion]
    if failed:
        return "FAILING", (failed[0] or "an expectation failed")[:200]
    first = (errors[0][0] if errors else "") or statuses[-1]
    return None, "the test stopped before any expectation (" + first[:200] + ") - " + BROKEN


def cors_ports(main_py_text):
    """The localhost ports the backend's CORS list allows, in file order."""
    ports = []
    for m in re.finditer(r"""["']http://(?:localhost|127\.0\.0\.1):(\d+)["']""", main_py_text or ""):
        port = int(m.group(1))
        if port not in ports:
            ports.append(port)
    return ports


class E2ERun:
    def __init__(self, system=None, out=None, err=None, cwd=None, base_env=None):
        self.system = system or stack.System()
        self.out = out or (lambda text="": print(text, flush=True))
        self.err = err or common.eprint
        self.cwd = Path(cwd or os.getcwd())
        self.base_env = dict(os.environ if base_env is None else base_env)
        self.pids = []

    def _frontend_port(self, worktree):
        try:
            text = (worktree / "backend" / "main.py").read_text(encoding="utf-8")
        except OSError:
            text = ""
        ports = cors_ports(text)
        # The developer's own dev server usually holds 5173 - try it last.
        ordered = [p for p in ports if p != 5173] + [p for p in ports if p == 5173]
        for port in ordered:
            if not self.system.port_busy(port):
                return port
        raise stack.StackError("Every localhost port the backend's CORS list allows (" + ", ".join(str(p) for p in ordered)
                               + ") is in use - stop a dev server or the preview (preview.py stop) and run again")

    def _start_backend(self, python, worktree, port, log):
        pid = self.system.spawn([str(python), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
                                worktree / "backend", backend_env(self.base_env), log)
        self.pids.append(pid)
        stack.wait_until_up(self.system, ["http://127.0.0.1:" + str(port) + "/health"],
                            {"backend": (pid, log)}, BOOT_TIMEOUT, label="The e2e backend")
        return pid

    def run(self, spec, ref, pin_id="", keep=False):
        spec = Path(spec).expanduser()
        if not spec.is_file():
            raise stack.StackError("Spec not found: " + str(spec))
        text = spec.read_text(encoding="utf-8")
        pin_id = (pin_id or pin_id_from_spec(text)).strip()
        if not pin_id:
            raise stack.StackError("The spec's test title must start with [<pin id>] (or pass --pin)")
        if "@playwright/test" not in text:
            raise stack.StackError(str(spec) + " is not a Playwright Test spec (no @playwright/test import)")
        if TODO_ASSERTION in text:
            raise stack.StackError(str(spec) + " still has the template's TODO assertion - replace "
                                   "`expect(false, 'TODO: ...')` with the pin's complaint first")

        main_root = stack.main_checkout(self.system, self.cwd)
        python = main_root / "backend" / ".venv" / "bin" / "python"
        if not python.exists():
            raise stack.StackError("No backend virtualenv at " + str(python))
        if not (main_root / "frontend" / "node_modules").is_dir():
            raise stack.StackError("No frontend/node_modules in " + str(main_root) + " - run npm install in frontend first")

        scratch_root = common.CACHE_DIR / "e2e"
        scratch_root.mkdir(parents=True, exist_ok=True)
        worktree = scratch_root / (stack.slug(ref) + "-" + uuid.uuid4().hex[:8])
        logs = scratch_root / (worktree.name + "-logs")
        logs.mkdir(parents=True, exist_ok=True)
        if ref.startswith("origin/"):
            self.system.run(["git", "fetch", "origin", ref[len("origin/"):]], cwd=main_root, timeout=300)
        self.out("Building " + ref + " in " + str(worktree) + "...")
        self.system.run(["git", "worktree", "add", "--detach", str(worktree), ref], cwd=main_root, timeout=300)
        try:
            return self._run_in(worktree, logs, main_root, python, text, pin_id, ref)
        finally:
            for pid in reversed(self.pids):
                if self.system.alive(pid):
                    self.system.terminate(pid)
            self.pids = []
            if keep:
                self.out("Kept " + str(worktree) + " (remove it with: git worktree remove --force " + str(worktree) + ")")
            else:
                self.system.run(["git", "worktree", "remove", "--force", str(worktree)], cwd=main_root, check=False, timeout=120)
                shutil.rmtree(str(logs), ignore_errors=True)

    def _frontend_modules(self, main_root, worktree):
        """Link the main checkout's frontend/node_modules when the ref's lockfile
        is the same; otherwise the ref gets its own `npm ci`."""
        try:
            same = (worktree / "frontend" / LOCKFILE).read_bytes() == (main_root / "frontend" / LOCKFILE).read_bytes()
        except OSError:
            same = False
        if same:
            stack.link_node_modules(main_root, worktree, "frontend")
            return
        self.out("frontend/package-lock.json on " + str(worktree.name) + " differs from the main checkout's - "
                 "installing its own node_modules (npm ci)")
        self.system.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=worktree / "frontend", timeout=900)

    def _run_in(self, worktree, logs, main_root, python, text, pin_id, ref):
        self._frontend_modules(main_root, worktree)
        # Its own vite cache (vite.config.js cacheDir), never the main checkout's node_modules/.vite.
        cache_env = {"NX_VITE_CACHE_DIR": str(logs / ".vite-cache")}
        if not stack.link_node_modules(main_root, worktree, "e2e"):
            self.system.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=worktree / "e2e", timeout=600)
        # The browser build matching this Playwright version, as CI installs it -
        # a missing browser must be a setup error, never a FAILING verdict.
        self.out("Checking Playwright's Chromium...")
        self.system.run(["npx", "playwright", "install", "chromium"], cwd=worktree / "e2e", timeout=900)

        # Backend: fresh SQLite, auth skipped, QA module on; prime /roles/me
        # and restart once, exactly like the workflow (the first call seeds the
        # owner row but caches the pre-seed role).
        db = worktree / "backend" / E2E_DB
        for suffix in ("", "-wal", "-shm", "-journal"):
            try:
                Path(str(db) + suffix).unlink()
            except OSError:
                pass
        api_port = self.system.free_port()
        api = "http://127.0.0.1:" + str(api_port)
        pid = self._start_backend(python, worktree, api_port, logs / "uvicorn1.log")
        self.system.http_ok(api + "/roles/me", timeout=30)
        self.system.terminate(pid)
        self.pids.remove(pid)
        self._start_backend(python, worktree, api_port, logs / "uvicorn.log")
        self.system.http_ok(api + "/roles/me", timeout=30)

        # Frontend: the VITE_E2E build served by vite preview.
        vite = worktree / "frontend" / "node_modules" / ".bin" / "vite"
        self.out("Building the frontend (VITE_E2E=true)...")
        self.system.run([str(vite), "build"], cwd=worktree / "frontend",
                        env=dict(build_env(self.base_env, "http://localhost:" + str(api_port)), **cache_env), timeout=BUILD_TIMEOUT)
        port = self._frontend_port(worktree)
        site = "http://localhost:" + str(port)
        fpid = self.system.spawn([str(vite), "preview", "--port", str(port), "--strictPort"],
                                 worktree / "frontend", dict(self.base_env, **cache_env), logs / "preview.log")
        self.pids.append(fpid)
        stack.wait_until_up(self.system, [site + "/"], {"frontend": (fpid, logs / "preview.log")}, BOOT_TIMEOUT,
                            label="The e2e frontend")

        # The spec, where sync.mjs puts the nightly ones.
        generated = worktree / "e2e" / "tests" / "generated"
        generated.mkdir(parents=True, exist_ok=True)
        target = generated / (pin_id + ".spec.mjs")
        target.write_text(generated_spec(text), encoding="utf-8")
        env = dict(self.base_env)
        env["NEXUS_E2E_URL"] = site
        # Specs that seed data through the API read this (CI leaves it unset: :8000).
        env["NEXUS_E2E_API"] = api
        report_path = worktree / "e2e" / REPORT
        try:
            report_path.unlink()
        except OSError:
            pass
        self.out("Running " + target.name + " against " + ref + " (" + site + ")...")
        code = self.system.run_live(["npx", "playwright", "test", "tests/generated/" + target.name],
                                    cwd=worktree / "e2e", env=env, timeout=TEST_TIMEOUT)
        try:
            target.unlink()
        except OSError:
            pass
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            report = None
        verdict, why = classify(report, code)
        if verdict is None:
            raise stack.StackError(why)
        if verdict == "FAILING":
            self.out("Expectation failed: " + why)
        self.out(verdict)
        return 0 if verdict == "PASSING" else 1


def main(argv=None, runner=None):
    parser = argparse.ArgumentParser(prog="run_e2e.py", description="Run one regression spec like the nightly qa-e2e workflow.")
    parser.add_argument("spec", help="the spec file (from repro_template.py --e2e)")
    parser.add_argument("--ref", required=True, help="origin/dev (before the fix) or the branch (after)")
    parser.add_argument("--pin", default="", help="pin id (default: read from the test title)")
    parser.add_argument("--keep", action="store_true", help="keep the scratch worktree and logs")
    args = parser.parse_args(argv)
    runner = runner or E2ERun()
    try:
        return runner.run(args.spec, args.ref, args.pin, keep=args.keep)
    except stack.StackError as exc:
        common.eprint(str(exc))
        common.eprint("No verdict (exit 2) - fix what is named above and run again.")
        return 2
    except KeyboardInterrupt:
        common.eprint("Stopped.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
