"""What's New from merged work - no AI required (Oct 2026).

Drafting used to hand the raw commit list to Claude and file whatever came
back as Pending Review for an admin to publish. Two things went wrong with
that: when the Anthropic account ran out of credit (Jul-Oct 2026) nothing was
drafted at all, and nobody published the drafts that did arrive.

Now every merged feature PR becomes ONE published entry, built from what the
developer already wrote:
  - title / module   the PR title ("Workday: exempt people ..." -> module
                     Workday), else the folders the PR changed
  - type             the branch prefix (fix/, feat/, hotfix/) and title words
  - description      the first paragraph of the PR description
  - What's Changed   its first few bullets
When the Anthropic key works, Claude rewrites that wording for non-technical
readers and may mark a PR as not user-facing (polish). When it does not, the
plain version is published anyway and the reason is shown as a note - Claude
is never what decides whether an update appears.

WHAT COUNTS. The branch this deployment tracks (task_config.tracked_branch:
dev on dev, main on prod) is read from GitHub, following only the commits that
landed ON it (_mainline), not the ones inside feature branches. Work reaches
dev three ways and each is an update:
  - a GitHub PR (one entry per PR)
  - a branch merged locally and pushed ("Merge branch 'feat/x' into dev")
  - commits pushed straight to dev - a run of them by one developer is ONE
    entry (one push), a commit pushed twice counts once
Release merges (dev into main) are walked through rather than listed, so prod
shows the same entries as dev, each when it reaches production. Something
that only touches CI, docs, infra or tests, or says [skip changelog], is
skipped.

Needs GITHUB_TOKEN with Contents: Read; with Pull requests: Read as well the
PR description is used (otherwise only the title and commit messages are).
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone

import httpx

GITHUB_API = "https://api.github.com"
MAX_PRS_PER_RUN = 25
BACKFILL_DAYS = 3           # first run on a server with no cursor yet
_POLISH_MAX_TOKENS = 12000

CHANGE_TYPES = ["Bug Fix", "Performance", "New Feature", "Security Update",
                "Hotfix", "Maintenance", "Improvement"]

_MERGE_RE = re.compile(r"^Merge pull request #(\d+) from ([^/\s]+)/(\S+)")
_SQUASH_RE = re.compile(r"\(#(\d+)\)\s*$")
_SKIP_MARK_RE = re.compile(r"\[(skip|no)[ -]changelog\]", re.I)
_CHORE_TITLE_RE = re.compile(r"^(chore|ci|docs?|tests?|build|deps|bump|release)\b", re.I)
_INTERNAL_PATH_RE = re.compile(
    r"^(\.github/|docs/|infra/|\.claude/)"
    r"|(^|/)(test_[^/]+\.py|conftest\.py|[^/]+\.test\.[jt]sx?|CLAUDE\.md|README\.md|\.gitignore)$"
    r"|\.md$"
)


class GitHubError(Exception):
    """The commit history could not be read - nothing can be published."""


def _token() -> str:
    return os.getenv("GITHUB_TOKEN", "")


def _repo() -> str:
    return os.getenv("GITHUB_REPO", "Greens-Global/Greens-Nexus")


def polish_model() -> str:
    return os.getenv("NEXUS_CHANGELOG_MODEL", "").strip() or "claude-sonnet-5-5"


# ── Reading GitHub ─────────────────────────────────────────────────────────

def _get(client: httpx.Client, path: str, **params):
    r = client.get(f"{GITHUB_API}/repos/{_repo()}{path}", params=params or None)
    if r.status_code >= 400:
        raise GitHubError(f"GitHub {path.split('?')[0]} - HTTP {r.status_code}")
    return r.json()


def _client() -> httpx.Client:
    return httpx.Client(timeout=30, headers={"Authorization": f"Bearer {_token()}",
                                             "Accept": "application/vnd.github+json"})


def _compare(client, base: str, head: str) -> dict:
    """GitHub's compare, every page of commits (one page stops at 250, and a
    release to main easily carries more once feature branches are counted)."""
    first = _get(client, f"/compare/{base}...{head}", per_page=100, page=1)
    commits = list(first.get("commits") or [])
    page = 1
    while len(commits) < (first.get("total_commits") or 0) and page < 10:
        page += 1
        more = _get(client, f"/compare/{base}...{head}", per_page=100, page=page).get("commits") or []
        if not more:
            break
        commits += more
    first["commits"] = commits
    return first


def _new_commits(client, branch: str, cursor: str) -> tuple[list[dict], str]:
    """Commits that reached `branch` since `cursor` (a sha), and the branch
    head to store as the next cursor. No cursor (first run) or a cursor GitHub
    no longer knows (history rewritten) reads the last few days."""
    head = _get(client, f"/commits/{branch}")["sha"]
    if cursor and cursor == head:
        return [], head
    if cursor:
        try:
            return _compare(client, cursor, head).get("commits") or [], head
        except GitHubError:
            pass
    since = (datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Feature-branch commits count toward the pages too, so a few days can be
    # several hundred; a cut-off list would end the dev line walk early.
    rows: list = []
    for page in range(1, 11):
        batch = _get(client, "/commits", sha=branch, since=since, per_page=100, page=page)
        rows += batch
        if len(batch) < 100:
            break
    return rows, head


def _subject(c: dict) -> str:
    return ((c.get("commit") or {}).get("message") or "").strip().split("\n", 1)[0]


def _parents(c: dict) -> list[str]:
    return [p.get("sha") for p in (c.get("parents") or [])]


_LOCAL_MERGE_RE = re.compile(r"^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?(?: into (\S+))?(?: - (.*))?$")
_LINE_BRANCHES = {"dev", "main", "origin/dev", "origin/main"}


def _is_line_merge(subject: str) -> bool:
    """A merge of dev or main itself - a release, or a back-merge."""
    m = _MERGE_RE.match(subject)
    if m:
        return m.group(3) in ("dev", "main")
    m = _LOCAL_MERGE_RE.match(subject)
    return bool(m) and m.group(1) in _LINE_BRANCHES


def _mainline(commits: list[dict], head: str) -> list[dict]:
    """The commits that landed ON dev, oldest first - not the ones inside a
    feature branch. Walks first parents down from the head; a release merge
    (dev into main) also walks dev's own line through its second parent, so
    prod sees everything dev did. Stops where the batch ends (the last run)."""
    by_sha = {c.get("sha"): c for c in commits}
    out, seen, stack = [], set(), [head]
    while stack:
        sha = stack.pop()
        while sha in by_sha and sha not in seen:
            seen.add(sha)
            c = by_sha[sha]
            out.append(c)
            parents = _parents(c)
            if len(parents) == 2 and _is_line_merge(_subject(c)):
                stack.append(parents[1])
            sha = parents[0] if parents else None
    out.sort(key=lambda c: ((c.get("commit") or {}).get("committer") or {}).get("date") or "")
    return out


def _humanize_branch(branch: str) -> str:
    name = branch.rsplit("/", 1)[-1].replace("-", " ").replace("_", " ").strip()
    return name[:1].upper() + name[1:]


def _change_refs(commits: list[dict]) -> list[dict]:
    """One ref per change that landed on dev, in order. Three ways work lands,
    all three seen in the log (Sep-Oct 2026):
      - a GitHub PR merge ("Merge pull request #N from org/branch") or a
        squash merge ("Title (#N)")                       key pr:N
      - a branch merged locally and pushed ("Merge branch 'feat/x' into dev
        - summary")                                       key merge:<sha8>
      - a commit pushed straight onto dev                 key commit:<sha8>
    Releases and back-merges of dev/main are not changes of their own."""
    out, seen = [], set()
    for c in commits:
        msg = ((c.get("commit") or {}).get("message") or "").strip()
        subject, sha, parents = msg.split("\n", 1)[0], c.get("sha", ""), _parents(c)
        ref = {"sha": sha, "parents": parents, "message": msg, "number": None, "branch": "",
               "author": _login(c.get("author"))}
        m = _MERGE_RE.match(subject)
        local = _LOCAL_MERGE_RE.match(subject)
        if _is_line_merge(subject):
            continue
        if m and len(parents) == 2:
            ref.update(kind="pr", key=f"pr:{m.group(1)}", number=int(m.group(1)), branch=m.group(3))
        elif local and len(parents) == 2:
            summary = (local.group(3) or "").strip()
            ref.update(kind="merge", key=f"merge:{sha[:8]}", branch=local.group(1), summary=summary,
                       title=summary or _humanize_branch(local.group(1)))
        elif len(parents) == 1 and (s := _SQUASH_RE.search(subject)):
            ref.update(kind="pr", key=f"pr:{s.group(1)}", number=int(s.group(1)))
        elif len(parents) == 1:
            ref.update(kind="commit", key=f"commit:{sha[:8]}", title=subject)
        else:
            continue
        if ref["key"] not in seen:
            seen.add(ref["key"])
            out.append(ref)
    return _group_pushes(out)


def _group_pushes(refs: list[dict]) -> list[dict]:
    """Direct commits in a row by the same developer are ONE update - one
    push. Visesh pushes many small commits straight to dev (70 in nine days
    of Oct 2026); an entry per commit would bury everything else. A commit
    pushed twice (same subject, rebased) counts once."""
    out: list[dict] = []
    for ref in refs:
        prev = out[-1] if out else None
        if ref["kind"] == "commit" and prev and prev["kind"] in ("commit", "push") \
                and prev.get("author") == ref.get("author"):
            if prev["kind"] == "commit":
                prev.update(kind="push", shas=[prev["sha"]], subjects=[prev["title"]])
            if ref["title"] not in prev["subjects"]:
                prev["shas"].append(ref["sha"])
                prev["subjects"].append(ref["title"])
            continue
        out.append(ref)
    return out


def _login(user) -> str:
    login = (user or {}).get("login") or ""
    return "" if login.endswith("[bot]") else login


def _developers(client, logins: list[str], names: dict) -> list[dict]:
    """[{login, name, url}] for GitHub accounts, in order, deduplicated. The
    name is the GitHub profile's display name (falls back to the login);
    `names` caches lookups across one run."""
    out, seen = [], set()
    for login in logins:
        if not login or login.lower() in seen:
            continue
        seen.add(login.lower())
        if login not in names:
            try:
                r = client.get(f"{GITHUB_API}/users/{login}")
                names[login] = ((r.json() or {}).get("name") or "").strip() if r.status_code < 400 else ""
            except (httpx.HTTPError, ValueError):
                names[login] = ""
        out.append({"login": login, "name": names[login] or login, "url": f"https://github.com/{login}"})
    return out


def _details(client, ref: dict, names: dict | None = None) -> dict:
    """Title, description, branch, changed files and developers for one change.

    Developers come from GitHub ONLY: whoever opened the PR (or made the merge
    or commit), then every other GitHub account with a commit in it. Never the
    Nexus user who pressed Check for Updates or edited the entry - that put
    Neil on every update.

    A PR needs Pull requests: Read on the token; without it its title comes
    from the merge commit and the bullets from its own commits."""
    kind, sha = ref.get("kind", "pr"), ref.get("sha", "")
    body_lines = ref.get("message", "").split("\n")[1:]
    change = {"key": ref.get("key") or f"pr:{ref.get('number')}", "kind": kind, "number": ref.get("number"),
              "shas": list(ref.get("shas") or [sha]),
              "branch": ref.get("branch", ""), "sha": sha, "title": ref.get("title", ""),
              "body": "\n".join(body_lines).strip() if kind != "pr" else "",
              "files": [], "commits": [], "developers": [],
              "url": (f"https://github.com/{_repo()}/pull/{ref.get('number')}" if kind == "pr"
                      else f"https://github.com/{_repo()}/commit/{sha}")}
    logins = [ref.get("author", "")] if kind != "pr" else []
    if kind == "pr":
        try:
            d = _get(client, f"/pulls/{ref['number']}")
            change.update(title=(d.get("title") or "").strip(), body=d.get("body") or "",
                          branch=((d.get("head") or {}).get("ref") or change["branch"]),
                          url=d.get("html_url") or change["url"])
            logins.append(_login(d.get("user")))
        except GitHubError:
            lines = [ln.strip() for ln in body_lines if ln.strip()]
            change["title"] = lines[0] if lines else ref.get("message", "").split("\n", 1)[0]
    parents = ref.get("parents") or []
    try:
        if kind == "push":
            change["commits"] = list(ref.get("subjects") or [])
            change["body"] = ""
            for s in (ref.get("shas") or [])[:10]:
                d = _get(client, f"/commits/{s}")
                change["files"] += [f.get("filename", "") for f in (d.get("files") or [])]
                logins.append(_login(d.get("author")))
        elif len(parents) == 2:
            cmp = _compare(client, parents[0], parents[1])
            change["files"] = [f.get("filename", "") for f in (cmp.get("files") or [])]
            change["commits"] = [_subject(c) for c in (cmp.get("commits") or [])]
            logins += [_login(c.get("author")) for c in (cmp.get("commits") or [])]
        else:
            d = _get(client, f"/commits/{sha}")
            change["files"] = [f.get("filename", "") for f in (d.get("files") or [])]
            logins.append(_login(d.get("author")))
    except GitHubError:
        pass
    # "Merge branch 'worktree-agent-ac4b...' into dev" says nothing: a merge
    # with no summary of its own is named after what it brought in.
    if kind == "merge" and not ref.get("summary"):
        own = [c for c in change["commits"] if c and not c.lower().startswith("merge ")]
        if own:
            change["title"] = own[0]
    change["developers"] = _developers(client, logins, {} if names is None else names)
    return change


def fetch_merged_prs(branch: str, cursor: str, known: set[str]) -> tuple[list[dict], str]:
    """The changes (PRs, local branch merges, direct commits) that landed on
    `branch` since `cursor` and whose key is not in `known`, plus the new
    cursor. Raises GitHubError when history cannot be read."""
    if not _token():
        raise GitHubError("GITHUB_TOKEN is not set on this server.")
    try:
        with _client() as client:
            commits, head = _new_commits(client, branch, cursor)
            refs = [r for r in _change_refs(_mainline(commits, head)) if r["key"] not in known]
            refs = refs[-MAX_PRS_PER_RUN:]
            names: dict = {}
            return [_details(client, r, names) for r in refs], head
    except httpx.HTTPError as e:
        raise GitHubError(f"Could not reach GitHub ({type(e).__name__}).")


# ── Building an entry without AI ───────────────────────────────────────────

def skip_reason(pr: dict) -> str:
    """Why a change is not worth a What's New entry, or "" when it is."""
    if _SKIP_MARK_RE.search(pr.get("title", "")) or _SKIP_MARK_RE.search(pr.get("body", "")):
        return "marked [skip changelog]"
    titles = pr.get("commits") if pr.get("kind") == "push" else [pr.get("title", "")]
    if titles and all(_CHORE_TITLE_RE.match(t or "") for t in titles):
        return "chore"
    files = [f for f in pr.get("files") or [] if f]
    if files and all(_INTERNAL_PATH_RE.search(f) for f in files):
        return "only CI, docs or tests"
    return ""


def _split_title(title: str) -> tuple[str, str]:
    """"Workday: exempt people ..." -> ("Workday", "Exempt people ...")."""
    head, sep, rest = title.partition(":")
    if sep and rest.strip() and len(head) <= 30 and len(head.split()) <= 4:
        rest = rest.strip()
        return head.strip(), rest[:1].upper() + rest[1:]
    return "", title.strip()


_MODULE_DIRS = {"tasks": "Tasks", "marketing": "Marketing", "accounting": "Accounting",
                "construction": "Construction", "timeclock": "Time Clock", "tickets": "Tickets",
                "hr": "HR", "myhr": "HR", "leasing": "Leasing", "pfs": "PFS", "dashboard": "Dashboard",
                "items": "Item Management", "assets": "Asset Management", "links": "Links",
                "docs": "Documents", "esign": "Nexus Sign", "qa": "QA"}


def _module_from_files(files: list[str]) -> str:
    counts: dict[str, int] = {}
    for f in files:
        parts = f.lower().split("/")
        name = ""
        if f.startswith("frontend/src/") and len(parts) > 3:
            name = _MODULE_DIRS.get(parts[2], "")
        elif f.startswith("backend/routers/"):
            name = _MODULE_DIRS.get(parts[-1].removesuffix(".py"), "")
        if name:
            counts[name] = counts.get(name, 0) + 1
    return max(counts, key=counts.get) if counts else "General"


def _change_type(title: str, branch: str) -> str:
    b, t = branch.lower(), title.lower()
    if b.startswith("hotfix/"):
        return "Hotfix"
    if re.search(r"\b(security|vulnerab\w*|xss|csrf)\b", t):
        return "Security Update"
    if b.startswith(("fix/", "bugfix/")) or re.search(r"\b(fix|fixes|fixed|bug|broken|crash\w*)\b", t):
        return "Bug Fix"
    if re.search(r"\b(faster|performance|perf|speed\w*|slow\w*)\b", t):
        return "Performance"
    if b.startswith(("feat/", "feature/")) or re.search(r"\b(new|add|adds|added)\b", t):
        return "New Feature"
    return "Improvement"


_DATED_ASIDE_RE = re.compile(r"\s*\([^()]*\b\d{1,2}/\d{1,2}\b[^()]*\)")          # (Charmi, 10/07)
_WHO_WHEN_RE = re.compile(r"^[A-Z][\w ,/&.]{0,40}?\b\d{1,2}/\d{1,2}\b(\s*\([^)]*\))?\s*:\s*")  # "Charmi 10/07: "
_PROVENANCE_RE = re.compile(r"^(from the\b|builds on\b|follow-?up to\b|[A-Z][\w ,/&.]{0,40}?\b\d{1,2}/\d{1,2}\b)", re.I)
_HOUSEKEEPING_RE = re.compile(r"^(docs?|tests?|test plan|ruff|lint|ci)\b", re.I)


def _plain(text: str) -> str:
    """Markdown and the team's who-asked-when notes out; words kept. Code
    spans keep their text (only the backticks go) and snake_case survives -
    stripping every underscore turned names into one long word."""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)     # [label](url) -> label
    text = re.sub(r"\*\*|__|`", "", text)
    text = _DATED_ASIDE_RE.sub("", text)
    text = _WHO_WHEN_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:1].upper() + text[1:]


def _body_parts(body: str) -> tuple[str, list[str]]:
    """First descriptive paragraph and the first top-level bullets of a PR
    description, stopping at the test plan (checklists are for reviewers)."""
    body = re.split(r"(?im)^#+\s*(test plan|testing|tests)\b", body or "")[0]
    body = re.sub(r"(?s)```.*?```", "", body)
    paragraph, bullets, buf = "", [], []
    for line in body.split("\n") + [""]:
        s = line.rstrip()
        if re.match(r"^[-*] (?!\[[ xX]\])", s):
            b = _plain(s[2:])
            if b and not _HOUSEKEEPING_RE.match(b):
                bullets.append(b)
        if not s.strip() or s.lstrip().startswith(("#", ">", "|", "-", "*", "🤖")) or re.match(r"^\d+\.", s.strip()):
            if buf and not paragraph:
                paragraph = _description(" ".join(buf))
            buf = []
            continue
        if not line.startswith(" "):
            buf.append(s)
    return paragraph, bullets


def _description(raw: str) -> str:
    """A paragraph worth showing, or "". Skipped: one that opens by quoting
    the request (Neil: "...") - the brief, not the result - and a bare
    provenance line ("From the 10/06 call with Neil.")."""
    if re.match(r'^\w[\w .]{0,20}: ["“]', raw.strip()):
        return ""
    text = _plain(raw)
    if len(text) < 40 or (_PROVENANCE_RE.match(raw.strip()) and len(text) < 90):
        return ""
    # Notes to reviewers: test results, @mentions, merge order, "two changes:".
    if _HOUSEKEEPING_RE.match(text) or text.startswith("@") or text.endswith(":") \
            or re.search(r"\b(merge (that|this) first|branch is on|no conflicts)\b", text, re.I):
        return ""
    return text


def _shorten(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("; "))
    return cut[:end + 1] if end > limit // 2 else cut.rsplit(" ", 1)[0] + "..."


def _title_words(text: str) -> str:
    """Title Case without lowering what is already capital ("Time off" ->
    "Time Off", "HR" stays "HR")."""
    return " ".join(w[:1].upper() + w[1:] for w in text.split())


def draft(pr: dict) -> dict:
    """The entry for one change, from its own words. Always complete enough to
    publish - Claude's polish only rewrites it."""
    module, title = _split_title(pr.get("title") or _humanize_branch(pr.get("branch") or "") or "Update")
    if pr.get("kind") == "push" and len(pr.get("commits") or []) > 1:
        # Several commits in one push: each is a bullet; the title names the
        # area (Claude's polish, when it runs, writes a real one).
        modules = [m for m, _ in (_split_title(c) for c in pr["commits"]) if m]
        module = max(set(modules), key=modules.count) if modules else _module_from_files(pr.get("files") or [])
        bullets = [_plain(_split_title(c)[1]) for c in pr["commits"]]
        return {
            "title": f"{_title_words(module)} Updates" if module and module != "General" else "Updates",
            "description": _shorten("; ".join(bullets[:2]) + ".", 320),
            "type": _change_type(" ".join(pr["commits"]), ""),
            "module": module,
            "businessImpact": None,
            "whatsChanged": [_shorten(b, 160) for b in bullets if b][:5],
        }
    title = title[:1].upper() + title[1:]
    paragraph, bullets = _body_parts(pr.get("body", ""))
    if not bullets:
        bullets = [_plain(c) for c in pr.get("commits") or [] if c and not c.lower().startswith("merge ")]
    first = _shorten(paragraph, 320) if paragraph else ""
    return {
        "title": _shorten(title, 120),
        "description": first or (title.rstrip(".") + "."),
        "type": _change_type(pr.get("title", ""), pr.get("branch", "")),
        "module": module or _module_from_files(pr.get("files") or []),
        "businessImpact": None,
        "whatsChanged": [_shorten(b, 160) for b in bullets if b][:5],
    }


# ── Optional: Claude rewrites the wording ──────────────────────────────────

class PolishError(Exception):
    """Claude could not rewrite the entries; the plain ones are used."""


def polish(prs: list[dict], drafts: list[dict]) -> list[dict]:
    """Ask Claude to rewrite each draft for non-technical readers. Returns one
    dict per draft (same order) with the rewritten fields and `userFacing`.
    Raises PolishError on any failure - the caller keeps the plain drafts."""
    key = os.getenv("ANTHROPIC_API_KEY", "")
    if not key:
        raise PolishError("ANTHROPIC_API_KEY is not set.")
    items = []
    for i, (pr, d) in enumerate(zip(prs, drafts)):
        items.append({"id": i, "title": pr.get("title", ""), "module": d["module"],
                      "type": d["type"], "description": (pr.get("body") or "")[:3000]
                      or "\n".join(pr.get("commits") or [])[:1500]})
    prompt = (
        "These changes were merged into Nexus, the Greens Global staff portal. Each becomes "
        "one \"What's New\" entry that every employee reads - most are not technical.\n\n"
        "For EACH change return an object. Write in plain American English, no code names, "
        "file names, endpoints, ticket numbers or jargon; describe what people will see or can now do. "
        "Use hyphens, never em dashes. Title Case for the title.\n"
        "Set userFacing to false ONLY when nobody using Nexus would notice the change at all "
        "(internal tooling, deploy scripts, test-only work).\n\n"
        f"Allowed type values: {', '.join(CHANGE_TYPES)}.\n\n"
        "Return ONLY a JSON array, one element per change, in this shape:\n"
        '{"id": number (the change id), "userFacing": boolean, "title": string (short), '
        '"description": string (1-2 sentences), "type": string, "module": string (product area), '
        '"businessImpact": string (one sentence), "whatsChanged": string[] (2-4 short bullets)}\n\n'
        f"CHANGES:\n{json.dumps(items, ensure_ascii=False)}"
    )
    try:
        with httpx.Client(timeout=180) as client:
            r = client.post("https://api.anthropic.com/v1/messages",
                            headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                     "content-type": "application/json"},
                            json={"model": polish_model(), "max_tokens": _POLISH_MAX_TOKENS,
                                  "messages": [{"role": "user", "content": prompt}]})
    except httpx.HTTPError as e:
        raise PolishError(f"Could not reach Claude ({type(e).__name__}).")
    if r.status_code >= 400:
        try:
            err = (r.json() or {}).get("error") or {}
            msg = err.get("message") if isinstance(err, dict) else str(err)
        except ValueError:
            msg = r.text
        raise PolishError(f"HTTP {r.status_code}: {(msg or '').strip()[:200]}")
    data = r.json()
    if data.get("stop_reason") == "max_tokens":
        raise PolishError("Claude's answer was cut off.")
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    start, end = text.find("["), text.rfind("]")
    try:
        parsed = json.loads(text[start:end + 1]) if start != -1 and end != -1 else None
    except ValueError:
        parsed = None
    if not isinstance(parsed, list):
        raise PolishError("Claude's answer could not be read.")
    by_id = {p.get("id"): p for p in parsed if isinstance(p, dict)}
    out = []
    for i in range(len(prs)):
        p = by_id.get(i) or {}
        out.append({
            "userFacing": p.get("userFacing") is not False,
            "title": str(p.get("title") or "").strip(),
            "description": str(p.get("description") or "").strip(),
            "type": p.get("type") if p.get("type") in CHANGE_TYPES else "",
            "module": str(p.get("module") or "").strip(),
            "businessImpact": str(p.get("businessImpact") or "").strip(),
            "whatsChanged": [str(x).strip() for x in (p.get("whatsChanged") or []) if str(x).strip()][:5],
        })
    return out
