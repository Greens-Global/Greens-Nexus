"""Per-user Asana connection - the endpoints behind Account Settings.

Two routers on purpose:
  - `router`        needs a signed-in user; every endpoint acts on THAT user's
                    own grant only, never anyone else's (no admin surface -
                    these are personal credentials).
  - `public_router` is the OAuth callback. Asana redirects a browser there with
                    no bearer token, so it can't sit behind auth - same reason
                    routers/asana_webhook.py is its own unauthenticated router.
                    Identity comes from the single-use `state` row instead.

Tokens are never returned to the client by any of these.
"""
import urllib.parse

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

import asana_oauth
import asana_sync
import models
from app_url import app_url
from auth import get_current_user
from database import get_db

router = APIRouter(prefix="/asana-oauth", tags=["Asana"], dependencies=[Depends(get_current_user)])
public_router = APIRouter(prefix="/asana-oauth", tags=["Asana"])


@router.get("/status")
def status(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = asana_oauth.get_row(db, user["email"])
    return {
        "configured": asana_oauth.oauth_configured(),
        "notConfiguredReason": asana_oauth.not_configured_reason(),
        # The exact string that must be registered as the app's redirect URI in
        # Asana. Not a secret (it's visible in the authorize URL anyway), and
        # having the server state it removes the guesswork from setup - a
        # mismatch here is the usual reason a first connection attempt fails.
        "redirectUri": asana_oauth.redirect_uri(),
        "connected": bool(row and row.refresh_token_enc),
        # Set when a push could not use this grant. "Connected" alone is not the
        # same as working - a grant whose vault key changed still looks connected
        # while every comment posts as somebody else.
        "lastError": (row.last_error or "") if row else "",
        "lastErrorAt": (row.last_error_at or "") if row else "",
        "asanaName": (row.asana_name or "") if row else "",
        "asanaEmail": (row.asana_email or "") if row else "",
        "connectedAt": (row.created_at or "") if row else "",
    }


@router.get("/check")
def check(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Would a comment posted right now go out as this person, or as the
    service account - and if the latter, why?

    Exists because the fallback is deliberately silent: losing a comment is
    worse than posting it under the wrong name, so every failure degrades
    instead of raising. That is right for the comment and useless for the
    person, who is told "comments appear as you" and then sees somebody else's
    name in Asana with nothing to explain it.

    Does the real thing rather than inspecting state: takes the same token
    push_comment would take and calls Asana with it. A grant can be perfectly
    valid and still be rejected by the project the task lives in, and only an
    actual request finds that out."""
    email = user["email"]
    token, why = asana_oauth.token_reason(db, email)
    out = {"willPostAsMe": False, "asanaName": "", "asanaEmail": "", "reason": why,
           "serviceAccountName": "", "partial": False}

    # Who the shared token is - the name that shows up instead. Naming it turns
    # "why is Sai posting my comments" into an answered question.
    try:
        cfg = asana_sync.get_config(db)
        if cfg and cfg.token:
            me = asana_sync.asana_identity(cfg.token)
            out["serviceAccountName"] = me.get("name") or ""
    except Exception:
        pass

    if not token:
        return out
    try:
        me = asana_sync.asana_identity(token)
    except Exception as e:
        out["reason"] = f"Asana rejected your grant ({e}) - disconnect and reconnect"
        return out
    out.update({"asanaName": me.get("name") or "", "asanaEmail": me.get("email") or ""})

    # A valid grant is not the same as a usable one: Asana refuses writes on a
    # task the token's owner cannot reach, and /users/me succeeds regardless.
    #
    # Probed against a REAL synced task, not the workspace. A guest account is
    # a workspace member and would pass a workspace check while still being
    # unable to touch the task a comment is actually posted to - so a
    # workspace-level probe reports "working" about a connection that falls back
    # on every comment, which is the same blindness this endpoint exists to end.
    #
    # A read: proving write access by writing would leave test comments in a
    # real project.
    #
    # A SAMPLE, not one task. Access is per project, so a single probe cannot
    # tell "this account is locked out" from "this account is not on the one
    # project that task happens to live in" - and reporting the first as the
    # second tells somebody their connection is broken when their own project
    # works fine.
    # The sample starts with THIS PERSON'S OWN tasks and only then tops up with
    # the most recently synced ones. "Most recent" alone was wrong the night
    # personal tasks were pulled (08/19): the newest links were other people's
    # private My Tasks rows, which nobody else can open, so every account
    # tested - including a perfectly good one - was told it could reach nothing.
    own_ids = [t.id for t in db.query(models.Task.id)
               .filter(models.Task.assignee_email == (email or "").lower()).limit(400).all()]
    links = []
    if own_ids:
        links = (db.query(models.AsanaTaskLink)
                   .filter(models.AsanaTaskLink.asana_gid != "",
                           models.AsanaTaskLink.nexus_task_id.in_(own_ids))
                   .order_by(models.AsanaTaskLink.last_synced_at.desc()).limit(8).all())
    if len(links) < 8:
        seen_ids = {l.id for l in links}
        for l in (db.query(models.AsanaTaskLink)
                    .filter(models.AsanaTaskLink.asana_gid != "")
                    .order_by(models.AsanaTaskLink.last_synced_at.desc()).limit(8 + len(links)).all()):
            if l.id not in seen_ids and len(links) < 8:
                links.append(l)
    reachable, blocked, last_err = 0, 0, ""
    for link in links:
        try:
            asana_sync.asana_task(token, link.asana_gid)
            reachable += 1
        except Exception as e:
            blocked += 1
            last_err = str(e)

    who = me.get("name") or "your Asana account"
    if links and not reachable:
        out["reason"] = (f"{who} cannot access any of the tasks this syncs to, so Asana refuses "
                         f"their comments ({last_err}). A Guest account only sees projects it has "
                         f"been added to - add it to the project, or connect an account that is a "
                         f"full workspace member.")
        return out
    if blocked:
        # Partly working: real, and worth saying plainly rather than rounding to
        # either "fine" or "broken".
        out.update({"willPostAsMe": True, "partial": True})
        out["reason"] = (f"{who} can reach {reachable} of {reachable + blocked} recently synced "
                         f"tasks. Comments on the rest post as the service account - that account "
                         f"has not been added to those projects.")
        return out

    out.update({"willPostAsMe": True, "reason": ""})
    return out


@router.post("/start")
def start(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not asana_oauth.oauth_configured():
        return {"url": "", "error": asana_oauth.not_configured_reason()}
    state = asana_oauth.issue_state(db, user["email"])
    return {"url": asana_oauth.authorize_url(state), "error": ""}


@router.delete("/me", status_code=204)
def disconnect(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    asana_oauth.disconnect(db, user["email"])


def _back(result: str, detail: str = ""):
    """Land the browser back on the app. TopHeader reads ?asana= on mount and
    reopens Account Settings with the outcome, so the user ends up where they
    started rather than on a bare page."""
    q = {"asana": result}
    if detail:
        q["reason"] = detail[:200]
    return RedirectResponse(f"{app_url()}/?{urllib.parse.urlencode(q)}", status_code=303)


@public_router.get("/callback")
def callback(code: str = "", state: str = "", error: str = "",
             db: Session = Depends(get_db)):
    # Asana sends ?error=access_denied when the user clicks Deny.
    if error:
        return _back("denied")
    email = asana_oauth.consume_state(db, state)
    if not email:
        # Unknown or expired state - also the CSRF case (a callback for a flow
        # this server never issued).
        return _back("error", "This connection link expired. Please try again.")
    if not code:
        return _back("error", "Asana did not return an authorization code.")
    try:
        payload = asana_oauth.exchange_code(code)
    except ValueError as e:
        return _back("error", str(e))
    if not payload.get("access_token"):
        return _back("error", "Asana did not return an access token.")
    asana_oauth.save_grant(db, email, payload)
    return _back("connected")


@router.get("/coverage")
def coverage(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Is everything Asana assigns to me in Nexus? Counted with MY grant.

    The service token cannot list a person's private ("Only me") tasks, so
    no admin-side count can answer this - the night before Asana closed,
    Charmi's 700-odd tasks read as 425 to the service PAT and 643 in Nexus, and
    the only way to know whether the gap was real was to ask Asana as her.
    Every task assigned to the caller is fetched with the caller's own token
    and matched to Nexus through the Asana links; whatever is left over is
    listed with the reason it could not have come across, so the person (or
    whoever runs the pull) knows what to do about it."""
    from asana_import import Asana
    email = (user.get("email") or "").strip().lower()
    token, why = asana_oauth.token_reason(db, email)
    out = {"ok": False, "reason": why, "asanaTotal": 0, "asanaOpen": 0, "inNexus": 0,
           "inNexusOpen": 0, "missing": 0, "missingOpen": 0, "missingTasks": []}
    if not token:
        return out
    cfg = asana_sync.get_config(db)
    ws = (cfg.workspace_gid or "").strip() if cfg else ""
    if not ws:
        out["reason"] = "The Asana workspace is not set on this server (Manage > Two-way Sync > Find my workspace)."
        return out
    me = Asana(token)
    try:
        rows = me.get("/tasks", assignee="me", workspace=ws,
                      opt_fields="name,completed,due_on,parent.gid,projects.gid,projects.name,projects.archived,memberships.project.name")
    except Exception as e:
        out["reason"] = f"Asana refused the listing ({e})"
        return out
    linked = {l.asana_gid for l in db.query(models.AsanaTaskLink.asana_gid).all() if l.asana_gid}
    mapped = {pm.asana_project_gid for pm in db.query(models.AsanaProjectMap.asana_project_gid).all()}
    out["ok"] = True
    out["asanaTotal"] = len(rows)
    out["asanaOpen"] = sum(1 for t in rows if not t.get("completed"))
    missing = []
    for t in rows:
        if t["gid"] in linked:
            out["inNexus"] += 1
            if not t.get("completed"):
                out["inNexusOpen"] += 1
            continue
        projects = t.get("projects") or []
        if t.get("parent"):
            reason = "subtask of a task Nexus does not have"
        elif not projects:
            reason = "personal task (no project) - run Pull Personal Tasks again"
        elif any(p.get("archived") for p in projects):
            reason = "in an ARCHIVED Asana project (unarchive it, then Import All + Pull new only)"
        elif not any(p.get("gid") in mapped for p in projects):
            reason = "in an Asana project Nexus has not imported (Import All)"
        else:
            reason = "in an imported project but not linked - run Pull new only"
        missing.append({"gid": t["gid"], "title": t.get("name") or "(untitled)",
                        "completed": bool(t.get("completed")), "dueOn": t.get("due_on") or "",
                        "projects": [p.get("name") or "" for p in projects], "reason": reason})
    # Open work first, then by due date - the part a person actually acts on.
    missing.sort(key=lambda m: (m["completed"], m["dueOn"] or "9999", m["title"].lower()))
    out["missing"] = len(missing)
    out["missingOpen"] = sum(1 for m in missing if not m["completed"])
    out["missingTasks"] = missing[:200]
    return out
