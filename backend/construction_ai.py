"""Construction AI - vision captioning and daily-log summarization.

Raw httpx against the Messages API, matching routers/knowledge_base.py, qa.py and
help.py. The codebase has no Anthropic SDK dependency and adding one for this
module alone would leave two ways to call the same API.

MODEL NOTES (these are not interchangeable knobs):
  - claude-opus-5. Thinking is ON by default on this model, and `max_tokens`
    caps thinking PLUS response text - so the budgets below are sized for both.
  - `temperature` / `top_p` / `top_k` are REMOVED on this model and return 400.
    Output shape is controlled by the schema, not by sampling.
  - `output_config.format` with a json_schema is what makes the result parseable
    without a regex. Every call here is an extraction, so all of them use it.
  - effort is per job kind: captioning one photo is not the same problem as
    reading a day of site evidence.

WHAT THE PROMPTS ARE FOR. These outputs end up in a report an executive or an
investor reads, and in a delay claim. So the system prompts push hard on one
thing: say what the evidence shows and nothing more. A model that infers "the
pour looks like it cured well" from a photo of formwork is worse than useless
here - it is a liability.
"""
import base64
import json
import os

import httpx

_API = "https://api.anthropic.com/v1/messages"
_MODEL = "claude-opus-5"
_TIMEOUT = 120


def configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def _call(*, system: str, content: list, schema: dict, effort: str = "high",
          max_tokens: int = 4000) -> dict:
    """One structured Messages call. Returns the parsed object.

    Raises on transport/API failure so the caller can decide retry vs dead -
    the sweep already distinguishes those."""
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = {
        "model": _MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": content}],
        # Adaptive is the only on-mode on this model; effort is the real dial.
        "thinking": {"type": "adaptive"},
        "output_config": {
            "effort": effort,
            "format": {"type": "json_schema", "schema": schema},
        },
        # A construction site is exactly the subject matter that trips a safety
        # classifier by accident: photos of trenches, scaffolding collapse risk,
        # damaged equipment, and notes about who got hurt. A refused caption
        # would surface to a worker as "your photo could not be processed" for
        # doing precisely what the module asks. "default" routes the retry by
        # refusal category rather than pinning a model we would then have to
        # migrate.
        "fallbacks": "default",
    }
    with httpx.Client(timeout=_TIMEOUT) as c:
        r = c.post(_API, headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "server-side-fallback-2026-07-01",
            "content-type": "application/json",
        }, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:300]}")
    data = r.json()
    # Safety classifiers can decline with HTTP 200 - check before reading content
    # or an indexing error masquerades as a parse failure.
    if data.get("stop_reason") == "refusal":
        raise RuntimeError("Anthropic declined this request")
    text = next((b.get("text", "") for b in data.get("content", [])
                 if b.get("type") == "text"), "")
    if not text:
        raise RuntimeError("Anthropic returned no text block")
    return json.loads(text)


def _image_block(url: str, mime: str, raw: bytes = None) -> dict:
    """A photo for the vision call. Bytes when we have them (a Supabase object
    behind a signed URL the API cannot reach), else the URL."""
    if raw:
        return {"type": "image", "source": {
            "type": "base64", "media_type": mime or "image/jpeg",
            "data": base64.standard_b64encode(raw).decode()}}
    return {"type": "image", "source": {"type": "url", "url": url}}


# ── Photo / video-frame captioning ───────────────────────────────────────────
_CAPTION_SYSTEM = """You caption construction site photographs for a weekly report read by project managers, executives and, if a claim is ever filed, lawyers.

Describe only what is visibly present. Name the trade, the element and the location when the image shows them; do not name them when it does not. If you cannot tell what a photo shows, say so in the caption rather than guessing - "unidentified formwork detail" is useful, an invented one is not.

Never infer quality, progress percentage, compliance, or whether work is correct. A photo shows that rebar is placed, not that it passed inspection.

Flag a safety concern only when it is visible in the frame: missing fall protection at height, an unshored trench, absent hard hats or high-visibility clothing where people appear, blocked egress, damaged equipment. Do not flag the absence of something you cannot see.

Captions are one sentence, plain, no leading "This image shows"."""

_CAPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "caption": {"type": "string", "description": "One sentence, what is visibly present."},
        "tags": {"type": "array", "items": {"type": "string"},
                 "description": "Lowercase trade/element keywords, e.g. concrete, formwork, rebar, mep."},
        "safety": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                    "issue": {"type": "string"},
                },
                "required": ["severity", "issue"],
                "additionalProperties": False,
            },
            "description": "Only concerns VISIBLE in the frame. Empty when none.",
        },
        "unclear": {"type": "boolean", "description": "True when the image is too poor to describe."},
    },
    "required": ["caption", "tags", "safety", "unclear"],
    "additionalProperties": False,
}


def caption_photo(*, url: str, mime_type: str = "", raw: bytes = None,
                  worker_note: str = "") -> dict:
    """Caption one photo. `worker_note` is the uploader's own description, which
    usually names the location far better than the pixels do."""
    content = [_image_block(url, mime_type, raw)]
    content.append({"type": "text", "text": (
        f"Caption this jobsite photo.\nThe worker labelled it: {worker_note.strip()}"
        if worker_note.strip() else "Caption this jobsite photo.")})
    # Captioning is a perception task, not a reasoning one - medium effort is the
    # cost/quality sweet spot and this call runs once per photo per day per site.
    return _call(system=_CAPTION_SYSTEM, content=content, schema=_CAPTION_SCHEMA,
                 effort="medium", max_tokens=1500)


# ── Daily log summarization ──────────────────────────────────────────────────
_LOG_SYSTEM = """You turn one day of raw jobsite evidence into the daily-log entry a project manager reads and a weekly report is built from.

Your inputs are a worker's own note (often terse, sometimes absent), captions of the photos and video they filed, and any voice-note transcript. Treat all of it as reported observation, not verified fact.

Rules that matter more than fluency:
- Report only what the evidence supports. If the worker wrote nothing and the photos show formwork, the summary says formwork was photographed - not that formwork was completed.
- Never invent quantities, percentages, or inspection outcomes. If a number is not in the evidence, it does not appear in your output.
- Distinguish what was DONE from what was SEEN. A photo of a delivery is not an installation.
- A delay is only a delay when the evidence names a cause - weather, a missing delivery, an absent crew, a blocked area. "Slow progress" is not a delay.
- Safety flags carry forward from photo captions and from anything the worker said. Do not add ones nobody observed.
- Action items must have an owner or be phrased so a manager can assign one.

Write the summary in plain professional English, past tense, 2-4 sentences. American spelling. Never use em dashes; use plain hyphens.

Set confidence honestly: below 0.5 when the evidence is thin (no note, few photos, nothing legible). A manager uses that number to decide what to read first."""

_LOG_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "2-4 sentences, past tense, plain professional English."},
        "work_completed": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "activity": {"type": "string"},
                    "trade": {"type": "string"},
                    "location": {"type": "string"},
                },
                "required": ["activity", "trade", "location"],
                "additionalProperties": False,
            },
        },
        "categories": {"type": "array", "items": {"type": "string"}},
        "safety_flags": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                    "issue": {"type": "string"},
                },
                "required": ["severity", "issue"],
                "additionalProperties": False,
            },
        },
        "delay_flags": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cause": {"type": "string"},
                    "impact_days": {"type": "number"},
                },
                "required": ["cause", "impact_days"],
                "additionalProperties": False,
            },
        },
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"text": {"type": "string"}, "owner": {"type": "string"}},
                "required": ["text", "owner"],
                "additionalProperties": False,
            },
        },
        "next_work": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "description": "0-1. Below 0.5 when the evidence is thin."},
    },
    "required": ["summary", "work_completed", "categories", "safety_flags",
                 "delay_flags", "action_items", "next_work", "confidence"],
    "additionalProperties": False,
}


def summarize_log(*, project_name: str, log_date: str, notes: str,
                  weather: str = "", crew_size: int = 0, hours: float = 0.0,
                  captions: list = None, transcripts: list = None) -> dict:
    """One day -> the structured entry. Text-only: the photos were already
    described by caption_photo, and re-sending every image would multiply the
    token cost of a day with 40 photos for no gain."""
    parts = [f"Project: {project_name}", f"Date: {log_date}"]
    if weather:
        parts.append(f"Weather: {weather}")
    if crew_size:
        parts.append(f"Crew size: {crew_size}")
    if hours:
        parts.append(f"Hours worked: {hours}")
    parts.append("")
    parts.append(f"Worker's note: {notes.strip()}" if notes.strip()
                 else "Worker's note: (none - they filed media only)")
    if captions:
        parts.append("")
        parts.append("Photo and video captions:")
        parts += [f"  - {c}" for c in captions if c]
    if transcripts:
        parts.append("")
        parts.append("Voice note transcript(s):")
        parts += [f"  {t}" for t in transcripts if t]
    if not captions and not transcripts and not notes.strip():
        parts.append("")
        parts.append("(No usable evidence was attached. Say so and set confidence low.)")

    # High effort: this is the reasoning step whose output a manager signs off and
    # an executive reads. Captioning can be cheap; this cannot.
    return _call(system=_LOG_SYSTEM, content=[{"type": "text", "text": "\n".join(parts)}],
                 schema=_LOG_SCHEMA, effort="high", max_tokens=6000)
