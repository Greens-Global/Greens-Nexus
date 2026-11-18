"""Merge To Dev from Build Mode (Neil, 11/12/2026: "5. Yes").

A Super Administrator merges a Build Mode pull request into `dev` from the
pin, and the team-chat heads-up goes out by the same click - the house rule
("announce in team chat before merging to dev") done by the button instead
of by memory.

What this is, and is not:

- OFF until the server carries `NEXUS_GITHUB_MERGE_TOKEN` - a fine-grained
  GitHub token for THIS repository only with Pull requests: Read and write
  and Contents: Read and write (a merge writes to the branch). Only Neil or
  Visesh sets Azure app settings; never commit one, never read it under
  another name. The read-only `GITHUB_TOKEN` What's New uses is never used
  to merge.
- Only a pull request recorded on a Build Mode pin, only into `dev`, only
  from a branch of this repository (never a fork), only when GitHub says it
  can merge and every check on its head commit finished green.
- The merge names the head commit it was checked at (`sha`), so a push that
  lands between the look and the click is refused by GitHub, not merged
  unseen.
- One call, no retry: a merge that may have gone through is never sent twice.
- Nothing here approves a review, changes branch protection or touches
  `main`.

Every outbound call goes through `_request` (tests patch that one function).
"""
from __future__ import annotations

import os

import httpx

GITHUB_API = "https://api.github.com"
BASE_BRANCH = "dev"
TOKEN_ENV = "NEXUS_GITHUB_MERGE_TOKEN"
GREEN = ("success", "neutral", "skipped")
TIMEOUT = 30


class MergeError(Exception):
    """A refusal the person should read (never carries the token)."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def _token() -> str:
    return (os.getenv(TOKEN_ENV) or "").strip()


def repo() -> str:
    return (os.getenv("GITHUB_REPO") or "Greens-Global/Greens-Nexus").strip()


def available() -> bool:
    return bool(_token())


def _request(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    """The ONE outbound call. Returns (status, json or {})."""
    with httpx.Client(timeout=TIMEOUT, headers={"Authorization": f"Bearer {_token()}",
                                                "Accept": "application/vnd.github+json",
                                                "X-GitHub-Api-Version": "2022-11-28"}) as client:
        r = client.request(method, f"{GITHUB_API}/repos/{repo()}{path}", json=body)
    try:
        data = r.json()
    except ValueError:
        data = {}
    return r.status_code, data if isinstance(data, dict) else {"items": data}


def _get(path: str) -> dict:
    try:
        status, data = _request("GET", path)
    except httpx.HTTPError:
        raise MergeError("GitHub could not be reached - try again in a moment.", 502)
    if status == 404:
        raise MergeError("GitHub does not know that pull request.", 404)
    if status in (401, 403):
        raise MergeError("GitHub refused the merge credential - it may have expired or lost its access to this repository.", 502)
    if status >= 400:
        raise MergeError(f"GitHub answered HTTP {status}.", 502)
    return data


def _checks(sha: str) -> dict:
    """Every check on the head commit: check runs (Actions, Cloudflare) and
    the older commit statuses, counted together."""
    runs = _get(f"/commits/{sha}/check-runs?per_page=100").get("check_runs") or []
    combined = _get(f"/commits/{sha}/status")
    passed = failed = pending = 0
    failing: list[str] = []
    for r in runs:
        if not isinstance(r, dict):
            continue
        if r.get("status") != "completed":
            pending += 1
        elif r.get("conclusion") in GREEN:
            passed += 1
        else:
            failed += 1
            failing.append(str(r.get("name") or "a check")[:80])
    for s in combined.get("statuses") or []:
        if not isinstance(s, dict):
            continue
        state = s.get("state")
        if state == "success":
            passed += 1
        elif state == "pending":
            pending += 1
        else:
            failed += 1
            failing.append(str(s.get("context") or "a check")[:80])
    return {"total": passed + failed + pending, "passed": passed, "failed": failed, "pending": pending,
            "failing": failing[:6]}


def look(pr_number: int) -> dict:
    """What a merge would do right now, and every reason it may not. Never
    merges. `ok` is True only when nothing stands in the way."""
    if not available():
        raise MergeError("Merge To Dev is not set up on this server.", 503)
    pr = _get(f"/pulls/{int(pr_number)}")
    head = pr.get("head") or {}
    base = pr.get("base") or {}
    sha = str(head.get("sha") or "")
    reasons: list[str] = []
    if pr.get("merged"):
        reasons.append("It is already merged.")
    elif pr.get("state") != "open":
        reasons.append("The pull request is closed.")
    if base.get("ref") != BASE_BRANCH:
        reasons.append(f"It targets {base.get('ref') or 'another branch'}, not {BASE_BRANCH}.")
    if ((head.get("repo") or {}).get("full_name") or "").lower() != repo().lower():
        reasons.append("Its branch is not in this repository.")
    if pr.get("draft"):
        reasons.append("It is still a draft.")
    checks = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "failing": []}
    if not reasons:
        mergeable, state = pr.get("mergeable"), str(pr.get("mergeable_state") or "")
        if mergeable is None:
            reasons.append("GitHub is still working out whether it can merge - try again in a moment.")
        elif not mergeable or state == "dirty":
            reasons.append("It conflicts with dev - the branch needs dev merged in first.")
        elif state == "blocked":
            reasons.append("GitHub's branch rules are holding it (a required review or check).")
        checks = _checks(sha) if sha else checks
        if checks["failed"]:
            reasons.append("Checks failed: " + ", ".join(checks["failing"]) + ".")
        elif checks["pending"]:
            reasons.append(f"{checks['pending']} check{'' if checks['pending'] == 1 else 's'} still running.")
        elif not checks["total"]:
            reasons.append("No checks have run on it yet.")
    return {"ok": not reasons, "reasons": reasons, "number": int(pr_number), "title": str(pr.get("title") or "")[:300],
            "url": str(pr.get("html_url") or ""), "branch": str(head.get("ref") or ""), "headSha": sha,
            "author": str((pr.get("user") or {}).get("login") or ""), "checks": checks}


def merge(pr_number: int, head_sha: str, title: str = "") -> str:
    """Merge it, as a merge commit (how every PR lands on dev), only if its
    head is still `head_sha`. Returns the merge commit's sha. One call."""
    if not available():
        raise MergeError("Merge To Dev is not set up on this server.", 503)
    body = {"sha": head_sha, "merge_method": "merge"}
    try:
        status, data = _request("PUT", f"/pulls/{int(pr_number)}/merge", body)
    except httpx.HTTPError:
        # Unknown outcome: say so, never try again by ourselves.
        raise MergeError("GitHub did not answer. Open the pull request to see whether it merged before you try again.", 502)
    if status == 200 and data.get("merged"):
        return str(data.get("sha") or "")
    if status == 409:
        raise MergeError("The branch changed since you looked - check it again, then merge.")
    if status == 405:
        raise MergeError("GitHub will not merge it: " + (str(data.get("message") or "it is not mergeable")[:200]))
    if status in (401, 403):
        raise MergeError("GitHub refused the merge credential - it needs Pull requests and Contents: Read and write on this repository.", 502)
    raise MergeError(f"GitHub answered HTTP {status}" + (": " + str(data.get("message"))[:200] if data.get("message") else "."), 502)
