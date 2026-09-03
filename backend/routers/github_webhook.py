"""Public GitHub webhook receiver (NO auth - GitHub calls it; requests are
verified by the X-Hub-Signature-256 HMAC instead, same shape as
routers/asana_webhook.py's X-Hook-Signature check).

Tells every Global Admin when a pull request is merged into `dev` (deploys to
dev.nexus.greensglobal.com) or `main` (deploys to nexus.greensglobal.com), and
kicks off the same "Generate from git" drafting that the Manage tab's button
runs manually - the merged commits land as Pending Review changelog entries
without anyone having to remember to click it.

Setup on GitHub: repo Settings -> Webhooks -> Add webhook -> Payload URL
`<API base>/webhooks/github`, content type `application/json`, secret =
GITHUB_WEBHOOK_SECRET (set the same value in the backend env), events =
"Pull requests" only.

Dev and prod are separate databases behind separate Azure App Services, and a
GitHub webhook is repo-wide - not scoped to one branch - so BOTH the dev and
prod backends need their own webhook registered, and each receives EVERY
pull_request event regardless of which branch it targeted. Without a filter,
whichever backend happens to receive the call would write the notification
into its OWN database even for a merge into the other branch - a "merged to
main" notification landing in the dev DB, invisible to anyone on
nexus.greensglobal.com. _this_env_branch() below gates each deployment to the
one branch its own database's admins actually care about, via WEBSITE_SITE_NAME
- the exact "dev" (anywhere in the name) vs prod split app_url.py already uses.
"""
import hashlib
import hmac
import json
import os
import threading

from fastapi import APIRouter, Request, Response, Depends
from sqlalchemy.orm import Session

import github_notify
from database import get_db, SessionLocal

router = APIRouter(tags=["GitHub"])

_WEBHOOK_SECRET = os.getenv("GITHUB_WEBHOOK_SECRET", "")

_SITE_FOR_BRANCH = {
    "dev":  ("dev", "dev.nexus.greensglobal.com"),
    "main": ("production", "nexus.greensglobal.com"),
}


def _this_env_branch() -> str:
    """Which branch THIS deployment's database cares about. Mirrors
    app_url.py's dev/prod split exactly: "dev" anywhere in WEBSITE_SITE_NAME is
    the dev deployment, anything else on Azure is prod, no site name at all is
    local (unfiltered, so a merge event can be tested against a local
    backend). Read fresh each call, not cached at import - matches app_url.py's
    documented reasoning against baking in a value that only came from a
    slot-suffixed WEBSITE_SITE_NAME during warm-up."""
    site = os.getenv("WEBSITE_SITE_NAME", "").strip().lower()
    if not site:
        return ""
    return "dev" if "dev" in site else "main"


def _verify_signature(body: bytes, signature: str) -> bool:
    if not _WEBHOOK_SECRET or not signature:
        return False
    mac = hmac.new(_WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={mac}", signature)


def _trigger_generate_async() -> None:
    """Draft "What's New" entries from the commits that just landed, in the
    background - never blocks the response to GitHub and never raises (same
    shape as asana_sync.trigger_pull_async). Own DB session: the request-scoped
    one is closed long before this thread's AI call (up to two minutes) returns."""
    def _run():
        import routers.task_config as task_config
        db = SessionLocal()
        try:
            task_config.generate_changelog_from_commits(db)
        except Exception:
            pass
        finally:
            db.close()
    threading.Thread(target=_run, daemon=True).start()


@router.post("/webhooks/github")
async def github_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if not _verify_signature(body, request.headers.get("X-Hub-Signature-256", "")):
        return Response(status_code=401)

    if request.headers.get("X-GitHub-Event") != "pull_request":
        return {"ok": True}  # ping / other events - nothing to do, still a clean 2xx

    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return {"ok": True}
    pr = payload.get("pull_request") or {}
    if payload.get("action") != "closed" or not pr.get("merged"):
        return {"ok": True}

    base_ref = ((pr.get("base") or {}).get("ref") or "")
    target = _SITE_FOR_BRANCH.get(base_ref)
    if not target:
        return {"ok": True}
    env_branch = _this_env_branch()
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
    _trigger_generate_async()
    return {"ok": True}
