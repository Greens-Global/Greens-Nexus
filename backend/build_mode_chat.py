"""Build Mode -> Microsoft Teams (Oct 24 2026).

A Build Session is mirrored into ONE Teams chat the author picked - any group
chat or 1:1 chat they are in (Pranshu: "they are not bound to the Feedback
and Bugs group"). The pin stays the record; the chat only points at it.

Three posts per session, never more (Neil hates notification spam):

  - sent      one card: title, who, every pin grouped by module with its kind,
              comment and Where line, the marked-up element shot of each pin
              inline (the cropped screenshot WITH the drawing - never the
              full page), and a link that opens Build Mode on the pin;
  - question  "Pin #n needs your answer" when Claude Code parks a pin;
  - fixed     "Fixed - please verify" with the PR when it merges to dev.

Delivery rides the ticket Teams queue (`ticket_teams_message`, kind
"build_mode", `ticket_id` = the session id) so it retries like every other
Teams post and keeps its reason in send_error. It posts AS THE AUTHOR with
their delegated Graph token (bff_session.graph_token_for_email) into the
chat id saved on the session - the same scopes feature requests use
(Chat.ReadBasic + ChatMessage.Send), nothing new to consent.

Images travel as Graph hostedContents on the message: the card's html names
each one as `<img data-nx-src="<canonical url>">` and deliver() swaps that
for `../hostedContents/<n>/$value` after reading the bytes through the
signed URL (files.fetchable_url). An image that cannot be read is dropped,
the card still goes.
"""
import base64
import html as html_lib
import re

import httpx

import models
from routers.task_util import gen_id, now_iso

KIND = "build_mode"
GRAPH = "https://graph.microsoft.com/v1.0"
MAX_IMAGES = 6                    # per message; Teams caps hosted content size, 6 shots stay well under
MAX_IMAGE_BYTES = 2 * 1024 * 1024
COMMENT_CHARS = 300

_IMG = re.compile(r'<img data-nx-src="([^"]+)">')


# ── Text helpers ───────────────────────────────────────────────────────────

def source_location(target) -> str:
    """'frontend/src/tasks/TasksHome.jsx:142' from target.source (the build-time
    stamp); '' when the pin has none. Mirrors tools/build_notes/cli.py."""
    src = (target or {}).get("source") if isinstance(target, dict) else None
    if not isinstance(src, dict) or not src.get("file"):
        return ""
    file = str(src.get("file")).replace("\\", "/")
    while file.startswith("./"):
        file = file[2:]
    file = file.lstrip("/")
    if file.startswith("src/"):
        file = "frontend/" + file
    elif not file.startswith("frontend/"):
        file = "frontend/src/" + file
    line = src.get("line")
    return f"{file}:{line}" if line else file


def pin_link(note_id: str) -> str:
    from app_url import app_url
    return f"{app_url()}/dev-notes?pin={note_id}"


def _name(db, email: str) -> str:
    from ticket_notify import _name_of
    return _name_of(db, email or "") or (email or "")


def _module(route: str, sub: str = "") -> str:
    """'Tasks > Home' from the pin's route and sub. The server has no copy of
    the sidebar's labels; Title Case of the route key reads right for every
    module (tasks, tickets, accounting, property-asset -> Property Asset)."""
    words = lambda k: (k or "").replace("-", " ").replace("_", " ").strip().title()  # noqa: E731
    r = words(route) or "Nexus"
    s = words(sub)
    return f"{r} > {s}" if s and s.lower() != "home" else r


def _short(text: str, n: int = COMMENT_CHARS) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 3].rstrip() + "..."


# ── Cards ──────────────────────────────────────────────────────────────────

def session_card_html(db, s, notes) -> str:
    e = html_lib.escape
    notes = sorted(notes, key=lambda n: (n.route or "", n.number or 0))
    who = _name(db, s.created_by)
    parts = [f"<p><strong>Build Session</strong> · {e(s.title or 'Build Session')} · "
             f"{len(notes)} pin{'' if len(notes) == 1 else 's'} · from {e(who)}</p>"]
    module = None
    for n in notes:
        m = _module(n.route, n.sub)
        if m != module:
            module = m
            parts.append(f"<p><strong>{e(m)}</strong></p>")
        kind = (n.kind or "bug").capitalize()
        line = f"<p><strong>#{n.number} {e(kind)}</strong> - {e(_short(n.comment))}"
        where = source_location(n.target)
        if where:
            line += f'<br><span style="color:#8a8886;font-size:12px">Where: {e(where)}</span>'
        if n.transcript:
            line += f'<br><em>{e(_short(n.transcript, 200))}</em>'
        line += f' <a href="{e(pin_link(n.id))}">Open</a></p>'
        parts.append(line)
        if n.screenshot_url:
            parts.append(f'<img data-nx-src="{e(n.screenshot_url)}">')
    return "".join(parts)


def question_html(db, n, text: str) -> str:
    e = html_lib.escape
    return (f"<p><strong>Pin #{n.number} Needs Your Answer</strong> · {e(_module(n.route, n.sub))}</p>"
            f"<p>{e(_short(text, 400))}</p>"
            f'<p><a href="{e(pin_link(n.id))}">Answer in Nexus</a></p>')


def fixed_html(db, s, notes, pr_number: int, pr_url: str) -> str:
    e = html_lib.escape
    pins = ", ".join(f"#{n.number}" for n in sorted(notes, key=lambda n: n.number or 0))
    return (f"<p><strong>Fixed - Please Verify</strong> · {e(s.title or 'Build Session')}</p>"
            f'<p>PR <a href="{e(pr_url or "")}">#{pr_number}</a> merged to dev for pin{"" if len(notes) == 1 else "s"} {e(pins)}. '
            f"Open the screen and accept or reopen each pin.</p>"
            f'<p><a href="{e(pin_link(notes[0].id))}">Open in Nexus</a></p>')


# ── Queue ──────────────────────────────────────────────────────────────────

def queue(db, s, html: str):
    """Queue (not send) one post for a session that has a Teams chat; None
    when it has none. Caller commits, then hands the row to deliver_later."""
    chat_id = getattr(s, "teams_chat_id", "") or ""
    if not chat_id or not html:
        return None
    row = models.TicketTeamsMessage(id=gen_id(), ticket_id=s.id, agent_email=(s.created_by or "").lower(),
                                    requester_email=(s.created_by or "").lower(), html=html, chat_id=chat_id,
                                    created_at=now_iso(), kind=KIND)
    db.add(row)
    return row


def deliver_later(background_tasks, row) -> None:
    """One inline attempt after the response; the sweep owns a miss."""
    if row is None or background_tasks is None:
        return
    from routers.tickets import _deliver_teams_dm
    background_tasks.add_task(_deliver_teams_dm, row.id)


# ── Delivery ───────────────────────────────────────────────────────────────

def _read_image(url: str):
    """(bytes, content type) of a pin's screenshot through its signed URL, or None."""
    from routers import files as _files
    try:
        signed = _files.fetchable_url(url)
        r = httpx.get(signed, timeout=15)
        if r.status_code >= 400 or len(r.content) > MAX_IMAGE_BYTES or not r.content:
            return None
        ctype = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
        return r.content, ctype if ctype.startswith("image/") else "image/png"
    except Exception:  # noqa: BLE001 - a missing shot must not stop the card
        return None


def with_hosted_images(html: str) -> tuple:
    """Swap every <img data-nx-src> for a hostedContents reference; returns
    (html, hostedContents). Shots that cannot be read are dropped."""
    hosted = []

    def swap(m):
        if len(hosted) >= MAX_IMAGES:
            return ""
        got = _read_image(m.group(1))
        if not got:
            return ""
        data, ctype = got
        hosted.append({"@microsoft.graph.temporaryId": str(len(hosted) + 1),
                       "contentBytes": base64.b64encode(data).decode("ascii"), "contentType": ctype})
        return f'<img src="../hostedContents/{len(hosted)}/$value" style="max-width:480px">'

    return _IMG.sub(swap, html or ""), hosted


def post(token: str, chat_id: str, html: str, hosted: list) -> None:
    from teams_post import with_signature
    body = {"body": {"contentType": "html", "content": with_signature(html)}}
    if hosted:
        body["hostedContents"] = hosted
    r = httpx.post(f"{GRAPH}/chats/{chat_id}/messages",
                   headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                   json=body, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"Graph {r.status_code}: {r.text[:180]}")


def deliver(db, row) -> bool:
    """One delivery attempt for a claimed build_mode row (teams_post.
    deliver_ticket_row calls this after _claim). Commits the outcome."""
    import bff_session
    try:
        tok = bff_session.graph_token_for_email(db, row.agent_email)
        if not tok:
            raise RuntimeError("no usable session token for the author (signed out everywhere, or Teams consent missing)")
        html, hosted = with_hosted_images(row.html)
        post(tok, row.chat_id, html, hosted)
        row.sent, row.send_error = 1, ""
        db.commit()
        return True
    except Exception as e:  # noqa: BLE001
        row.send_error = str(e)[:300]
        db.commit()
        return False
