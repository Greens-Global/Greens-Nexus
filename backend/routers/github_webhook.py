"""Public GitHub push-webhook receiver for the changelog (Sept 2026).

"What's New" should fill in just after a merge, not the next morning. GitHub
POSTs here on every push to the repo; a push to the branch THIS deployment
tracks (routers.task_config.tracked_branch - dev on the dev API, main on prod)
brings the changelog sweep forward to a few minutes' time.

NOT a deploy hook. Merging frontend-only work does not restart the API - both
Azure workflows filter on `backend/**` - so anything hung off a restart would
miss exactly the user-facing merges most worth announcing. The webhook fires on
all of them.

The request does NO work of its own: it moves the persisted due time and
returns. GitHub gives a webhook ~10 seconds and this generation takes up to two
minutes; worse, the request lands on whichever of the 8 gunicorn workers
answers it, which for a backend merge is a worker that is about to be restarted
by that very merge's deploy. Handing the job to the single elected sweeper in
changelog_auto.py keeps one runner, one draft, and a due time that outlives the
restart.

Own router, like routers/asana_webhook.py, because the Task routers require a
logged-in user and GitHub is not one. Its credential is the
X-Hub-Signature-256 HMAC over the raw body, verified against
GITHUB_WEBHOOK_SECRET; the CSRF guard in main.py does not apply because GitHub
sends no session cookie. Without the secret set the endpoint is off and says
so, rather than accepting unverified callers.

Setup: GitHub repo > Settings > Webhooks > Add webhook
  Payload URL  https://<api-host>/task-changelog/github-webhook
  Content type application/json
  Secret       the same value as GITHUB_WEBHOOK_SECRET
  Events       "Just the push event"
"""
import asyncio
import hashlib
import hmac
import json
import os

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

router = APIRouter(tags=["Tasks"])


def _secret() -> str:
    return os.getenv("GITHUB_WEBHOOK_SECRET", "").strip()


def _signature_ok(body: bytes, header: str) -> bool:
    """Constant-time compare of GitHub's HMAC-SHA256 over the RAW body."""
    secret = _secret()
    if not secret or not header:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


@router.post("/task-changelog/github-webhook")
async def github_push_webhook(request: Request):
    if not _secret():
        return JSONResponse(status_code=503,
                            content={"detail": "GITHUB_WEBHOOK_SECRET is not configured."})
    body = await request.body()
    if not _signature_ok(body, request.headers.get("X-Hub-Signature-256", "")):
        return JSONResponse(status_code=401, content={"detail": "Bad signature."})

    event = request.headers.get("X-GitHub-Event", "")
    if event == "ping":     # sent once when the webhook is created
        return {"ok": True, "pong": True}
    if event != "push":
        return {"ok": True, "ignored": event or "unknown"}

    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return {"ok": True, "ignored": "unparsable payload"}

    from routers.task_config import _GITHUB_REPO, tracked_branch
    repo = ((payload.get("repository") or {}).get("full_name") or "")
    if repo and _GITHUB_REPO and repo.lower() != _GITHUB_REPO.lower():
        return {"ok": True, "ignored": f"other repo ({repo})"}

    branch = str(payload.get("ref") or "").removeprefix("refs/heads/")
    if branch != tracked_branch():
        return {"ok": True, "ignored": f"other branch ({branch or 'none'})"}
    # A branch delete, or a push whose commits are all already summarised, would
    # only wake the sweep to find nothing. Deletes carry no commits at all.
    if payload.get("deleted") or not (payload.get("commits") or []):
        return {"ok": True, "ignored": "no commits"}

    from changelog_auto import mark_due_after_merge
    # Off the event loop: a DB write here would block every request this worker
    # is serving (CLAUDE.md).
    scheduled = await asyncio.to_thread(mark_due_after_merge, f"merge to {branch}")
    print(f"[changelog] push to {branch} ({len(payload.get('commits') or [])} commit(s)) - {scheduled}")
    return {"ok": True, "branch": branch, "scheduled": scheduled}
