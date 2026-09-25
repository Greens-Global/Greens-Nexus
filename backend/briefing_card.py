"""Outlook card version of the Daily Briefing (Sep 25, Neil: collapsible
sections that also work in Outlook).

Outlook desktop renders HTML email with Word, which ignores every CSS
click-to-toggle trick, so the HTML briefing's collapsible sections only work
in Apple Mail and Gmail. An Outlook Actionable Message (Adaptive Card) is the
one format Outlook runs interactively in every client (classic desktop, new
Outlook, web, mobile): Action.ToggleVisibility gives real collapse, and
Action.Http runs Approve / Comment / Mark Complete in the email itself.

The card is the WHOLE briefing, not a card stacked on top of the HTML
(hideOriginalBody: True). The Sep 23 attempt (PR #329, reverted in #331) put
only Action Required in a card above the HTML, so Outlook readers got the
list twice. Other clients never read the card and keep the HTML version.

Colors come from Adaptive Card container styles (attention / warning / good /
emphasis), which Outlook maps onto its own light or dark theme - a card
cannot force our brand colors, so it follows the reader's Outlook theme.

Every click posts to /briefing-actions/card (routers/briefing_actions.py),
which runs the action and answers with this card rebuilt for the same
briefing window, so the email updates in place and still shows everything
else that is pending.
"""
from urllib.parse import urlencode

import briefing_mail_actions
import task_mail_actions

_SECTION = {
    # key: (heading, container style, number color, summary label)
    "action_required": ("Action Required", "attention", "attention", "Need your action"),
    "needs_to_know":   ("Updates for You", "warning", "warning", "Updates for you"),
    "completed":       ("Completed Since Your Last Briefing", "good", "good", "Completed"),
}
_ORDER = ["action_required", "needs_to_know", "completed"]
_MODULE_LABEL = {
    "tasks": "Tasks", "tickets": "Tickets", "documents": "Documents", "time_off": "Time Off",
    "timecard": "Time Card", "items": "Items", "team": "Team",
}
_MODULE_ORDER = ["tasks", "tickets", "documents", "time_off", "timecard", "items", "team"]
# First rows show; the next ones sit behind "Show N More" (still in the email);
# past that it is a link to Nexus, so one busy module can't blow up the card.
_ROWS_SHOWN = 3
_ROWS_IN_CARD = 10


def _card_url(ctx: dict, **params) -> str:
    extra = {"v": ctx["variant"]} if ctx.get("variant") else {}
    q = urlencode({**params, **extra, "d": ctx["briefing_date"], "s": ctx["since_iso"]})
    return f"{task_mail_actions.api_base()}/briefing-actions/card?{q}"


def _post(ctx: dict, title: str, body: str = "", style: str = "", **params) -> dict:
    # Same text/plain body convention as task_mail_actions._http: typed text is
    # sent raw, since Outlook substitutes {{input.value}} without escaping.
    a = {"type": "Action.Http", "title": title, "method": "POST", "url": _card_url(ctx, **params),
         "body": body, "headers": [{"name": "Content-Type", "value": "text/plain"}]}
    if style:
        a["style"] = style
    return a


def _decision_actions(ctx: dict, kind: str, action_id: str, email: str) -> list:
    approve = briefing_mail_actions.sign_token(kind, action_id, "approve", email)
    reject = briefing_mail_actions.sign_token(kind, action_id, "reject", email)
    out = [_post(ctx, "Approve", style="positive", kind="decision", token=approve)]
    if kind == "ticket_approval":
        # Nexus requires a reason to reject a ticket request.
        note_id = ctx["next_id"]("note")
        out.append({"type": "Action.ShowCard", "title": "Reject", "style": "destructive", "card": {
            "type": "AdaptiveCard",
            "body": [{"type": "Input.Text", "id": note_id, "isMultiline": True,
                      "placeholder": "Reason for rejecting (required)"}],
            "actions": [_post(ctx, "Confirm Reject", f"{{{{{note_id}.value}}}}", style="destructive",
                              kind="decision", token=reject)],
        }})
    else:
        # "destructive" is the card's red button style.
        out.append(_post(ctx, "Reject", style="destructive", kind="decision", token=reject))
    return out


def _task_actions(ctx: dict, row: dict) -> list:
    tok = task_mail_actions.sign_token(row["task_id"], row.get("action_email", ""))
    comment_id, react_id = ctx["next_id"]("comment"), ctx["next_id"]("react")
    out = [
        {"type": "Action.ShowCard", "title": "Comment", "card": {
            "type": "AdaptiveCard",
            "body": [{"type": "Input.Text", "id": comment_id, "isMultiline": True,
                      "placeholder": "Write a comment"}],
            "actions": [_post(ctx, "Post Comment", f"{{{{{comment_id}.value}}}}",
                              kind="task", token=tok, action="comment")],
        }},
        {"type": "Action.ShowCard", "title": "React", "card": {
            "type": "AdaptiveCard",
            "body": [{"type": "Input.ChoiceSet", "id": react_id, "style": "expanded",
                      "value": task_mail_actions.REACTION_EMOJIS[0],
                      "choices": [{"title": e, "value": e} for e in task_mail_actions.REACTION_EMOJIS]}],
            "actions": [_post(ctx, "Send Reaction", f"{{{{{react_id}.value}}}}",
                              kind="task", token=tok, action="react")],
        }},
    ]
    if row.get("task_open"):
        options = ctx["status_options"](row.get("project_id") or "")
        if options:
            status_id = ctx["next_id"]("status")
            out.append({"type": "Action.ShowCard", "title": "Change Status", "card": {
                "type": "AdaptiveCard",
                "body": [{"type": "Input.ChoiceSet", "id": status_id, "style": "compact",
                          "value": row.get("task_status") or options[0][0],
                          "choices": [{"title": label, "value": key} for key, label in options]}],
                "actions": [_post(ctx, "Update Status", f"{{{{{status_id}.value}}}}",
                                  kind="task", token=tok, action="status")],
            }})
        out.append(_post(ctx, "Mark Complete", kind="task", token=tok, action="complete"))
    return out


def _row(ctx: dict, row: dict, first: bool) -> dict:
    """One table row: item on the left, update on the right - the same Item /
    Update columns as the HTML version - with comments and buttons on their
    own full-width lines underneath, so a row of buttons is never cut off."""
    title = row["title"] if not row.get("ref") else f"{row['ref']}  {row['title']}"
    items = [{"type": "ColumnSet", "columns": [
        {"type": "Column", "width": 64, "items": [
            {"type": "TextBlock", "text": title, "weight": "bolder", "wrap": True}]},
        {"type": "Column", "width": 36, "items": [
            {"type": "TextBlock", "text": row.get("detail") or "", "wrap": True, "isSubtle": True}]},
    ]}]
    if row.get("comments"):
        items.append({"type": "Container", "style": "emphasis", "spacing": "small", "items": [
            {"type": "TextBlock", "text": "Recent Comments", "size": "small", "weight": "bolder",
             "isSubtle": True}] + [
            {"type": "TextBlock", "text": f"**{c['author']}:** {c['body']}", "size": "small",
             "wrap": True, "spacing": "small"} for c in row["comments"]]})
    for sub in row.get("sub_actions") or []:
        items.append({"type": "TextBlock", "text": sub["detail"], "wrap": True, "spacing": "small"})
        items.append({"type": "ActionSet", "spacing": "none",
                      "actions": _decision_actions(ctx, sub["action_kind"], sub["action_id"], sub["action_email"])})
    actions = []
    if row.get("action_kind"):
        actions += _decision_actions(ctx, row["action_kind"], row["action_id"], row["action_email"])
    if row.get("task_id"):
        actions += _task_actions(ctx, row)
    if row.get("url"):
        actions.append({"type": "Action.OpenUrl", "title": "Open in Nexus", "url": row["url"]})
    if actions:
        items.append({"type": "ActionSet", "spacing": "small", "actions": actions})
    return {"type": "Container", "separator": True, "spacing": "medium", "items": items}


def _module(ctx: dict, module: str, rows: list, view_url: str, style: str) -> list:
    """A module is one box in its section's color (Pranshu, Sep 26: same boxes
    as the HTML version): a header row, then one row per item."""
    label = _MODULE_LABEL.get(module, module.replace("_", " ").title())
    head = {"type": "ColumnSet", "columns": [
        {"type": "Column", "width": 64, "items": [
            {"type": "TextBlock", "text": "ITEM", "size": "small", "weight": "bolder", "isSubtle": True}]},
        {"type": "Column", "width": 36, "items": [
            {"type": "TextBlock", "text": "UPDATE", "size": "small", "weight": "bolder", "isSubtle": True}]},
    ]}
    box = [head] + [_row(ctx, r, i == 0) for i, r in enumerate(rows[:_ROWS_SHOWN])]
    more = rows[_ROWS_SHOWN:_ROWS_IN_CARD]
    footer = []
    if more:
        more_id = ctx["next_id"]("more")
        box.append({"type": "Container", "id": more_id, "isVisible": False, "spacing": "none",
                    "items": [_row(ctx, r, False) for r in more]})
        footer.append({"type": "Action.ToggleVisibility", "title": f"Show {len(more)} More",
                       "targetElements": [more_id]})
    if len(rows) > _ROWS_IN_CARD and view_url:
        footer.append({"type": "Action.OpenUrl", "title": f"View All {len(rows)} in Nexus", "url": view_url})
    if footer:
        box.append({"type": "ActionSet", "separator": True, "spacing": "medium", "actions": footer})
    return [
        {"type": "TextBlock", "text": f"{label} ({len(rows)})", "weight": "bolder",
         "spacing": "large", "wrap": True},
        {"type": "Container", "style": style, "spacing": "small", "items": box},
    ]


def _section(ctx: dict, key: str, rows: list, view_urls: dict) -> list:
    heading, style, _color, _ = _SECTION[key]
    body_id, show_id, hide_id = ctx["next_id"]("sec"), ctx["next_id"]("show"), ctx["next_id"]("hide")
    buckets: dict = {}
    for r in rows:
        buckets.setdefault(r.get("module") or "other", []).append(r)
    order = [m for m in _MODULE_ORDER if m in buckets] + [m for m in buckets if m not in _MODULE_ORDER]
    content = []
    for m in order:
        content += _module(ctx, m, buckets[m], view_urls.get(m, ""), style)
    header = {
        "type": "Container", "style": style, "spacing": "large",
        # The whole header row is the toggle - clicking anywhere on it opens
        # or closes the section, and flips the Show / Hide label with it.
        "selectAction": {"type": "Action.ToggleVisibility", "title": f"Show or hide {heading}",
                         "targetElements": [body_id, show_id, hide_id]},
        "items": [{"type": "ColumnSet", "columns": [
            {"type": "Column", "width": "stretch", "verticalContentAlignment": "center", "items": [
                {"type": "TextBlock", "text": f"{heading} ({len(rows)})", "weight": "bolder",
                 "size": "medium", "wrap": True}]},
            {"type": "Column", "width": "auto", "verticalContentAlignment": "center", "items": [
                {"type": "TextBlock", "id": show_id, "text": "Show", "color": "accent", "weight": "bolder"},
                {"type": "TextBlock", "id": hide_id, "text": "Hide", "color": "accent", "weight": "bolder",
                 "isVisible": False, "spacing": "none"}]},
        ]}],
    }
    return [header, {"type": "Container", "id": body_id, "isVisible": False, "items": content}]


def build_card(*, sections: dict, first_name: str, greeting: str, weekday_date: str,
               briefing_date: str, since_iso: str, logo_url: str, app_url: str,
               view_urls: dict, status_options, outcome: str = "") -> dict:
    """The whole briefing as one Adaptive Card. `status_options(project_id)`
    returns [(key, label), ...] for a task's Change Status list; `outcome` is
    the line shown at the top after a click."""
    counter = {"n": 0}
    status_cache: dict = {}

    def next_id(prefix: str) -> str:
        counter["n"] += 1
        return f"{prefix}{counter['n']}"

    def cached_status(project_id: str) -> list:
        if project_id not in status_cache:
            status_cache[project_id] = status_options(project_id)
        return status_cache[project_id]

    ctx = {"briefing_date": briefing_date, "since_iso": since_iso, "next_id": next_id,
           "status_options": cached_status}
    brand = ({"type": "Image", "url": logo_url, "height": "24px", "altText": "Greens Global"} if logo_url else
             {"type": "TextBlock", "text": "GREENS GLOBAL", "weight": "bolder", "size": "small"})
    body = [{"type": "ColumnSet", "columns": [
        {"type": "Column", "width": "stretch", "verticalContentAlignment": "center", "items": [brand]},
        {"type": "Column", "width": "auto", "verticalContentAlignment": "center", "items": [
            {"type": "TextBlock", "text": weekday_date, "isSubtle": True, "size": "small"}]},
    ]}]
    if outcome:
        body.append({"type": "Container", "style": "good", "spacing": "medium", "items": [
            {"type": "TextBlock", "text": outcome, "weight": "bolder", "wrap": True}]})
    body += [
        {"type": "TextBlock", "text": "Daily Briefing", "size": "large", "weight": "bolder", "spacing": "medium"},
        {"type": "TextBlock", "text": (f"{greeting}, {first_name}." if first_name else f"{greeting}.") +
         " Here is what changed since your last briefing.", "wrap": True, "spacing": "small"},
    ]
    present = [k for k in _ORDER if sections.get(k)]
    if present:
        body.append({"type": "Container", "spacing": "medium", "items": [
            {"type": "ColumnSet", "columns": [
                {"type": "Column", "width": "stretch", "style": _SECTION[k][1], "items": [
                    {"type": "TextBlock", "text": str(len(sections[k])), "size": "extraLarge",
                     "weight": "bolder", "color": _SECTION[k][2]},
                    # Label in the section color too: Outlook picks the tile's
                    # background from its own theme, so the text carries the color.
                    {"type": "TextBlock", "text": _SECTION[k][3], "color": _SECTION[k][2], "weight": "bolder",
                     "size": "small", "spacing": "none", "wrap": True}]}
                for k in present]}]})
        body.append({"type": "TextBlock", "text": "Select a section to show or hide it.", "isSubtle": True,
                     "size": "small", "spacing": "small"})
        for k in present:
            body += _section(ctx, k, sections[k], view_urls)
    else:
        body.append({"type": "TextBlock", "text": "Nothing new since your last briefing.", "isSubtle": True,
                     "wrap": True, "spacing": "medium"})
    body.append({"type": "TextBlock", "text": "You receive one briefing a day, before your shift starts.",
                 "isSubtle": True, "size": "small", "wrap": True, "spacing": "extraLarge", "separator": True})
    return {
        "type": "AdaptiveCard", "version": "1.2", "originator": task_mail_actions.AM_ORIGINATOR,
        # The card is the whole briefing in Outlook; the HTML stays for every
        # other client.
        "hideOriginalBody": True,
        "body": body,
        "actions": [{"type": "Action.OpenUrl", "title": "Open Nexus", "url": app_url}],
    }


def outcome_only_card(outcome: str, app_url: str) -> dict:
    """Shown when someone other than the briefing's owner acts on a forwarded
    copy: the action ran as them, but the owner's briefing is not theirs to see."""
    return {
        "type": "AdaptiveCard", "version": "1.2", "originator": task_mail_actions.AM_ORIGINATOR,
        "hideOriginalBody": True,
        "body": [{"type": "Container", "style": "good", "items": [
            {"type": "TextBlock", "text": outcome, "weight": "bolder", "wrap": True}]}],
        "actions": [{"type": "Action.OpenUrl", "title": "Open Nexus", "url": app_url}],
    }


# ── Quick Actions card (Sep 26, option A) ────────────────────────────────
# Outlook always draws a card ABOVE the email body and cannot place buttons
# inside our HTML, so this keeps our designed email as the body
# (hideOriginalBody: False) and adds one compact block on top: a single
# "N decisions waiting on you" line that opens the list of Approve / Reject
# buttons. Only plain yes/no decisions belong here - everything else stays in
# the email.
_QUICK_MAX = 10


def _decision_rows(rows: list) -> list:
    return [r for r in rows if r.get("action_kind") or r.get("sub_actions")]


def build_quick_card(*, action_rows: list, briefing_date: str, since_iso: str, outcome: str = ""):
    """None when there is nothing to decide - the email then goes out with no
    card at all. After a click (`outcome`) the card is redrawn with the list
    open, since the person is in the middle of deciding."""
    decisions = _decision_rows(action_rows)
    if not decisions and not outcome:
        return None
    counter = {"n": 0}

    def next_id(prefix: str) -> str:
        counter["n"] += 1
        return f"{prefix}{counter['n']}"

    ctx = {"briefing_date": briefing_date, "since_iso": since_iso, "next_id": next_id, "variant": "quick"}
    list_id, show_id, hide_id = "qa-list", "qa-show", "qa-hide"
    opened = bool(outcome)
    n = len(decisions)
    body = []
    if outcome:
        body.append({"type": "Container", "style": "good", "items": [
            {"type": "TextBlock", "text": outcome, "weight": "bolder", "wrap": True}]})
    header = {"type": "Container", "spacing": "small" if outcome else "none", "items": [
        {"type": "ColumnSet", "columns": [
            {"type": "Column", "width": "stretch", "verticalContentAlignment": "center", "items": [
                {"type": "TextBlock", "weight": "bolder", "wrap": True,
                 "text": f"{n} decision{'' if n == 1 else 's'} waiting on you" if n else "Nothing left to decide."}]
                + ([{"type": "TextBlock", "text": "Approve or reject here without leaving Outlook.",
                     "isSubtle": True, "size": "small", "wrap": True, "spacing": "none"}] if n else [])},
        ] + ([{"type": "Column", "width": "auto", "verticalContentAlignment": "center", "items": [
            {"type": "TextBlock", "id": show_id, "text": "Show", "color": "accent", "weight": "bolder",
             "isVisible": not opened},
            {"type": "TextBlock", "id": hide_id, "text": "Hide", "color": "accent", "weight": "bolder",
             "isVisible": opened, "spacing": "none"}]}] if n else [])}]}
    if n:
        header["selectAction"] = {"type": "Action.ToggleVisibility", "title": "Show or hide decisions",
                                  "targetElements": [list_id, show_id, hide_id]}
    body.append(header)

    items = []
    for row in decisions[:_QUICK_MAX]:
        cols = [{"type": "Column", "width": "stretch", "verticalContentAlignment": "center", "items": [
            {"type": "TextBlock", "text": row["title"], "weight": "bolder", "wrap": True},
            {"type": "TextBlock", "text": row.get("detail") or "", "isSubtle": True, "size": "small",
             "wrap": True, "spacing": "none"}]}]
        if row.get("action_kind"):
            cols.append({"type": "Column", "width": "auto", "verticalContentAlignment": "center", "items": [
                {"type": "ActionSet", "actions": _decision_actions(
                    ctx, row["action_kind"], row["action_id"], row["action_email"])}]})
        entry = [{"type": "ColumnSet", "columns": cols}]
        for sub in row.get("sub_actions") or []:
            entry.append({"type": "ColumnSet", "spacing": "small", "columns": [
                {"type": "Column", "width": "stretch", "verticalContentAlignment": "center", "items": [
                    {"type": "TextBlock", "text": sub["detail"], "size": "small", "wrap": True}]},
                {"type": "Column", "width": "auto", "verticalContentAlignment": "center", "items": [
                    {"type": "ActionSet", "actions": _decision_actions(
                        ctx, sub["action_kind"], sub["action_id"], sub["action_email"])}]},
            ]})
        items.append({"type": "Container", "separator": True, "spacing": "medium", "items": entry})
    if n > _QUICK_MAX:
        items.append({"type": "TextBlock", "text": f"{n - _QUICK_MAX} more in the briefing below.",
                      "isSubtle": True, "size": "small", "separator": True})
    if items:
        body.append({"type": "Container", "id": list_id, "isVisible": opened, "items": items})
    return {
        "type": "AdaptiveCard", "version": "1.2", "originator": task_mail_actions.AM_ORIGINATOR,
        # On top of our designed email, not instead of it.
        "hideOriginalBody": False,
        "body": body,
    }
