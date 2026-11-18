"""Public Microsoft Graph change-notification receiver for kudos posts in
Teams (Neil, 11/12/2026, perf_kudos_teams.py). NO auth - Microsoft calls it.

Two kinds of call:
  * validation - when a subscription is made, Graph POSTs with
    `?validationToken=...` and needs the token back as text/plain within
    10 seconds;
  * notifications - `{"value": [...]}`, each naming a subscription and the
    clientState we gave it. One whose subscription and clientState are ours
    marks that kudos post due to be read again; that is all a notification
    can do, so a forged one costs at most a Graph read. The read runs after
    the response (Graph wants an answer within 3 seconds), and the leader's
    loop picks up anything this worker does not.
Rate limited as a shared source (Microsoft's senders share addresses).
"""
import asyncio
import json

from fastapi import APIRouter, BackgroundTasks, Request, Response

import perf_kudos_teams as pkt

router = APIRouter(tags=["Teams"])

MAX_BODY = 1024 * 1024


@router.post(pkt.WEBHOOK_PATH)
async def teams_kudos_webhook(request: Request, background_tasks: BackgroundTasks):
    token = request.query_params.get("validationToken")
    if token is not None:
        return Response(content=token[:2000], media_type="text/plain")
    body = await request.body()
    if len(body) > MAX_BODY:
        return Response(status_code=413)
    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        return Response(status_code=400)
    items = payload.get("value") if isinstance(payload, dict) else None
    ids = await asyncio.to_thread(pkt.note_notifications, items or [])
    for kid in ids[:10]:
        background_tasks.add_task(pkt.sync_one, kid)
    return Response(status_code=202)
