"""Public GitHub webhook receiver (NO auth - GitHub calls it; requests are
verified by the X-Hub-Signature-256 HMAC instead, same shape as
routers/asana_webhook.py's X-Hook-Signature check).

Two jobs, one receiver:
  - Tells every Global Admin when a pull request is merged into `dev` (deploys
    to dev.nexus.greensglobal.com) or `main` (nexus.greensglobal.com).
  - Brings the changelog sweep forward so the merged commits land as Pending
    Review "What's New" entries within minutes, instead of waiting for the
    daily backstop or for someone to press "Generate from git".

Setup on GitHub: repo Settings -> Webhooks -> Add webhook -> Payload URL
`<API base>/webhooks/github`, content type `application/json`, secret =
GITHUB_WEBHOOK_SECRET (set the same value in the backend env), events =
"Pull requests" AND "Pushes". Pull requests carry the merge that admins are
told about; pushes catch the merges that never open a PR (a branch merged
locally and pushed straight to dev, which the log shows happens), which a
PR-only hook would silently miss. A merged PR fires both - see the handoff
note below for why that costs nothing.

Dev and prod are separate databases behind separate Azure App Services, and a
GitHub webhook is repo-wide - not scoped to one branch - so BOTH the dev and
prod backends need their own webhook registered, and each receives EVERY event
regardless of which branch it targeted. Without a filter, whichever backend
happens to receive the call would write the notification into its OWN database
even for a merge into the other branch - a "merged to main" notification
landing in the dev DB, invisible to anyone on nexus.greensglobal.com.
task_config.deployment_branch() gates each deployment to the one branch its own
database's admins actually care about, via WEBSITE_SITE_NAME - the exact "dev"
(anywhere in the name) vs prod split app_url.py already uses.

THE DRAFTING HANDOFF. This request does no generation of its own: it moves the
persisted due time in changelog_auto.py and returns. GitHub allows a webhook
~10 seconds while the generation takes up to two minutes; the request lands on
whichever of the 8 gunicorn workers answers it, which for a merge touching
backend/** is a worker that same merge's deploy is about to restart. Handing
the job to the single elected sweeper keeps one runner and one draft, lets a
burst of merges (and a PR's own duplicate push event) coalesce into ONE entry,
and leaves a due time that outlives the restart. It used to run inline in a
daemon thread, which lost the draft whenever the deploy landed mid-call.
"""
import asyncio
import hashlib
import hmac
import json
import os

from fastapi import APIRouter, Request, Response, Depends
from sqlalchemy.orm import Session

import github_notify
from database import get_db

router = APIRouter(tags=["GitHub"])

_SITE_FOR_BRANCH = {
    "dev":  ("dev", "dev.nexus.greensglobal.com"),
    "main": ("production", "nexus.greensglobal.com"),
}


def _secret() -> str:
    """Read fresh, not cached at import - so a secret added to the app settings
    takes effect on restart rather than needing a redeploy, and so the tests
    can toggle it."""
    return os.getenv("GITHUB_WEBHOOK_SECRET", "").strip()


def _verify_signature(body: bytes, signature: str) -> bool:
    secret = _secret()
    if not secret or not signature:
        return False
    mac = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={mac}", signature)


async def _schedule_draft(reason: str) -> str:
    """Hand the drafting to changelog_auto's elected sweeper. Off the event
    loop: a DB write here would block every request this worker is serving
    (CLAUDE.md)."""
    from changelog_auto import mark_due_after_merge
    return await asyncio.to_thread(mark_due_after_merge, reason)


@router.post("/webhooks/github")
async def github_webhook(request: Request, db: Session = Depends(get_db)):
    if not _secret():
        # Explicitly off, rather than quietly 401-ing every delivery: the
        # difference between "somebody is spoofing us" and "nobody set the
        # secret" is the whole of a failed setup.
        return Response(status_code=503,
                        content='{"detail":"GITHUB_WEBHOOK_SECRET is not configured."}',
                        media_type="application/json")
    body = await request.body()
    if not _verify_signature(body, request.headers.get("X-Hub-Signature-256", "")):
        return Response(status_code=401)

    from routers.task_config import deployment_branch, tracked_branch
    event = request.headers.get("X-GitHub-Event", "")
    if event not in ("pull_request", "push"):
        return {"ok": True}  # ping / other events - nothing to do, still a clean 2xx

    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return {"ok": True}

    # ── A push straight to the tracked branch: draft, nobody to announce ──
    if event == "push":
        branch = str(payload.get("ref") or "").removeprefix("refs/heads/")
        if branch != tracked_branch():
            return {"ok": True, "ignored": f"other branch ({branch or 'none'})"}
        # A branch delete carries no commits, and neither does a no-op push.
        if payload.get("deleted") or not (payload.get("commits") or []):
            return {"ok": True, "ignored": "no commits"}
        scheduled = await _schedule_draft(f"push to {branch}")
        print(f"[changelog] push to {branch} "
              f"({len(payload.get('commits') or [])} commit(s)) - {scheduled}")
        return {"ok": True, "branch": branch, "scheduled": scheduled}

    # ── A merged PR: announce it to the admins, then draft ────────────────
    pr = payload.get("pull_request") or {}
    if payload.get("action") != "closed" or not pr.get("merged"):
        return {"ok": True}

    base_ref = ((pr.get("base") or {}).get("ref") or "")
    target = _SITE_FOR_BRANCH.get(base_ref)
    if not target:
        return {"ok": True}
    env_branch = deployment_branch()
    if env_branch and base_ref != env_branch:
        # This deployment's DB isn't the one whose admins should hear about a
        # merge into the OTHER branch - the other backend's own webhook call
        # handles it, into its own DB. See module docstring.
        return {"ok": True}
    label, site = target

    number = pr.get("number", "?")
    title = pr.get("title") or "(untitled)"
    author = ((pr.get("user") or {}).get("login") or "someone")
    url = pr.get("html_url") or ""

    github_notify.notify_global_admins(
        db,
        kind=f"pr_merged_{base_ref}",
        title=f"PR merged to {label}",
        body=f"#{number} \"{title}\" by {author} was merged into {base_ref} - "
             f"deploying to {site}.\n{url}",
        ref_id=str(number),
    )
    scheduled = await _schedule_draft(f"PR #{number} merged to {base_ref}")
    return {"ok": True, "branch": base_ref, "scheduled": scheduled}
