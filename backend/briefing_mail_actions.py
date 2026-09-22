"""Signed one-click action links for the Daily Briefing email (Sep 2026 - see
daily_briefing.py's module-accordion header for the "collapsed by module, act
without opening Nexus" ask). Same shape as task_mail_actions.py's tokens, with
its own context prefix so a token minted for one purpose can never be replayed
as the other, and its own recipient-bound routing (routers/briefing_actions.py)
- GET only ever renders a confirm page, never mutates, because link scanners
(Outlook Safe Links, Gmail) prefetch every URL in a message.

Scope is deliberately narrow: only a row that is a single yes/no decision with
no photo or picker attached gets a token (task approval, a single time-off
request). Checkout/handover/receipt/assignment rows stay "Open in Nexus" -
CLAUDE.md's "photos are evidence" rule and the allocator-picker on checkout
approval mean those genuinely need the app, not a stub reason to skip them.
"""
import base64
import hashlib
import hmac
import json
import time

import task_mail_actions

# Same key task_mail_actions.py signs with, own context prefix.
_SECRET = task_mail_actions._SECRET
_CONTEXT = b"briefing-mail-action:v1:"

TOKEN_TTL_SEC = 14 * 24 * 3600   # the briefing is daily - two weeks covers a
                                  # slow reader without a link that outlives
                                  # the decision it names


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_token(kind: str, entity_id: str, action: str, recipient: str, *, now: float | None = None) -> str:
    """Opaque `<payload>.<sig>` binding one decision (kind+id+action) to one
    recipient until expiry."""
    payload = json.dumps({"k": kind, "id": entity_id, "a": action, "r": (recipient or "").lower(),
                          "e": int((now or time.time()) + TOKEN_TTL_SEC)},
                         separators=(",", ":")).encode()
    sig = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:16]
    return f"{_b64(payload)}.{_b64(sig)}"


def verify_token(token: str, *, now: float | None = None) -> dict | None:
    """{"kind", "id", "action", "recipient"} for a valid, unexpired token - else None."""
    try:
        p64, s64 = (token or "").split(".", 1)
        payload = _unb64(p64)
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(want, _unb64(s64)):
            return None
        data = json.loads(payload)
        if int(data.get("e", 0)) < (now or time.time()):
            return None
        return {"kind": data["k"], "id": data["id"], "action": data["a"], "recipient": data.get("r", "")}
    except Exception:
        return None


def action_url(kind: str, entity_id: str, action: str, recipient: str) -> str:
    token = sign_token(kind, entity_id, action, recipient)
    return f"{task_mail_actions.api_base()}/briefing-actions/page?token={token}"


# ── Outlook Actionable Message card (Sep 23, Pranshu: full in-mail action
# buttons for Daily Briefing, not just task emails) ─────────────────────────
#
# Outlook's Actionable Message spec is built around ONE card per email
# (task_mail_actions.build_card: one task, one card). Daily Briefing is a
# digest of many unrelated decisions, so this rolls every Action Required
# row into ONE card body instead, each item with its own Action.Http
# button(s) POSTing to /briefing-actions/card (approvals) or the EXISTING
# /mail-actions/card (task comment/complete - reusing that endpoint and its
# token, not a second copy of task-update logic). hideOriginalBody is False:
# the rest of the digest (Needs to know/Completed) keeps rendering as plain
# HTML underneath in clients that show both - losing the whole rest of the
# briefing just to show an actionable card would be a worse trade than a
# little visual redundancy with the plain-link fallback buttons.

def _approve_reject_actions(kind: str, entity_id: str, recipient: str) -> list:
    approve_tok = sign_token(kind, entity_id, "approve", recipient)
    reject_tok = sign_token(kind, entity_id, "reject", recipient)
    base = task_mail_actions.api_base()
    approve_btn = {"type": "Action.Http", "title": "Approve", "method": "POST",
                   "url": f"{base}/briefing-actions/card?token={approve_tok}",
                   "headers": [{"name": "Content-Type", "value": "text/plain"}]}
    if kind == "ticket_approval":
        # Ticket rejection needs a reason (Nexus requires one on reject) -
        # nested ShowCard with a required text box, same as the fallback
        # page's own note field for this one kind+action combination.
        note_id = f"note_{entity_id}"
        reject_btn = {"type": "Action.ShowCard", "title": "Reject", "card": {
            "type": "AdaptiveCard",
            "body": [{"type": "Input.Text", "id": note_id, "isMultiline": True,
                      "placeholder": "Reason for rejecting (required)"}],
            "actions": [{"type": "Action.Http", "title": "Confirm Reject", "method": "POST",
                        "url": f"{base}/briefing-actions/card?token={reject_tok}",
                        "body": f"{{{{{note_id}.value}}}}",
                        "headers": [{"name": "Content-Type", "value": "text/plain"}]}],
        }}
    else:
        reject_btn = {"type": "Action.Http", "title": "Reject", "method": "POST",
                      "url": f"{base}/briefing-actions/card?token={reject_tok}",
                      "headers": [{"name": "Content-Type", "value": "text/plain"}]}
    return [approve_btn, reject_btn]


def build_card(rows: list, recipient: str, *, outcome: str = "") -> dict:
    """The consolidated Action Required card for one recipient. `outcome` is
    shown at the top after an action, when the endpoint refreshes the card
    with whatever is STILL pending (not just a confirmation of the one
    thing just decided) - a manager with 3 pending items who acts on 1
    should still see the other 2, not lose them from view."""
    body: list = []
    if outcome:
        body.append({"type": "TextBlock", "text": outcome, "weight": "bolder",
                     "color": "good", "wrap": True})
    if not rows:
        body.append({"type": "TextBlock", "text": "Nothing needs your decision right now.",
                     "wrap": True, "isSubtle": True})
    for row in rows:
        item_body = [{"type": "TextBlock", "text": row["title"], "weight": "bolder",
                      "wrap": True, "separator": True, "spacing": "medium"}]
        item_actions = []
        if row.get("sub_actions"):
            # Bundled multi-request card (several time-off requests for one
            # employee, one card, Sep 20) - one Approve/Reject pair PER
            # request, same as the plain-link version's per-row buttons.
            for sub in row["sub_actions"]:
                if sub.get("detail"):
                    item_body.append({"type": "TextBlock", "text": sub["detail"], "wrap": True, "spacing": "small"})
                item_actions.extend(_approve_reject_actions(sub["action_kind"], sub["action_id"], sub["action_email"]))
        elif row.get("action_kind"):
            if row.get("detail"):
                item_body.append({"type": "TextBlock", "text": row["detail"], "isSubtle": True,
                                  "wrap": True, "spacing": "none"})
            item_actions.extend(_approve_reject_actions(row["action_kind"], row["action_id"], row["action_email"]))
        elif row.get("task_id"):
            # An approval-type task assigned to the recipient still carries
            # task_id - reuse the EXISTING per-task action set + the EXISTING
            # /mail-actions/card endpoint (its own token), not a second copy
            # of task-update logic.
            if row.get("detail"):
                item_body.append({"type": "TextBlock", "text": row["detail"], "isSubtle": True,
                                  "wrap": True, "spacing": "none"})
            tok = task_mail_actions.sign_token(row["task_id"], row.get("action_email", ""))
            comment_id = f"c_{row['task_id']}"
            item_actions.append({"type": "Action.ShowCard", "title": "Comment", "card": {
                "type": "AdaptiveCard",
                "body": [{"type": "Input.Text", "id": comment_id, "isMultiline": True,
                          "placeholder": "Write a comment…"}],
                "actions": [task_mail_actions._http("Post Comment", "comment", tok, f"{{{{{comment_id}.value}}}}")],
            }})
            if row.get("task_open"):
                item_actions.append(task_mail_actions._http("Mark Complete", "complete", tok))
        if row.get("url"):
            item_actions.append({"type": "Action.OpenUrl", "title": "Open in Nexus", "url": row["url"]})
        if item_actions:
            item_body.append({"type": "ActionSet", "actions": item_actions})
        body.extend(item_body)
    return {
        "type": "AdaptiveCard", "version": "1.0", "originator": task_mail_actions.AM_ORIGINATOR,
        "hideOriginalBody": False,
        "body": body, "actions": [],
    }
