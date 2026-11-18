"""Meeting Notes highlights (Neil, 11/12/2026, Phase 2) - read by RULES, no AI.

Given a transcript's cues ([{at, speaker, text}], routers/meetings.py), find
the lines worth a second look:

  actions    - someone took something on or was asked to: "action item",
               "follow up", "next step", "can you send...", "I'll update...
               by Friday". A plain "I'll be honest" is not one: a promise
               counts only with a work verb or a deadline after it.
  decisions  - "we decided", "let's go with", "we're going with", "agreed".
  questions  - a real question still in the air: ends with "?", at least six
               words, not a tag ("right?", "you know?") and not already a
               request counted as an action.

Each item is {i, at, speaker, text, due} - `i` the cue it came from (the
screen jumps there), `due` the deadline words when there are any ("by
Friday"). Computed when the transcript is read and never stored: the
transcript is Teams', Nexus keeps no copy (Neil, 11/12/2026). Rules are
deliberately strict - a short list a person trusts beats a long one they
skim. An AI summary is Phase 4, behind ai_switch, off.
"""
from __future__ import annotations

import re

MAX_PER_KIND = 25
TEXT_MAX = 240

_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")

_DAYS = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
_DUE = re.compile(
    r"\b(?:by|before|until|no later than|due)\s+(?:the\s+)?(?:end of (?:the )?(?:day|week|month)|eod|eow|"
    r"tomorrow|tonight|today|next week|next month|this week|" + _DAYS + r"(?:\s+morning|\s+afternoon)?|"
    r"\d{1,2}/\d{1,2}(?:/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?)"
    r"|\b(?:tomorrow|end of (?:the )?(?:day|week)|eod|eow|next week)\b",
    re.I)

_EXPLICIT = re.compile(r"\b(?:action items?|to-?dos?|follow[- ]?ups?|follow up|next steps?|take(?:s)? (?:that|this) on|"
                       r"(?:i'll|i will|we'll|we will) own (?:that|this|it))\b", re.I)
_WORK = (r"(?:send|share|email|e-mail|call|text|ping|follow up|check|look into|look at|update|schedule|set up|book|"
         r"review|fix|finish|prepare|draft|write|get|order|create|build|submit|file|upload|confirm|reach out|talk to|"
         r"put together|circle back|get back|send over|pull|run|move|add|remove|reconcile|post|pay|invoice|sign|"
         r"approve|test|ship|deploy|close|open|assign|loop in|cc|forward|print|scan|clean|inspect|visit|meet|"
         r"organize|plan|price|quote|estimate|research|find|figure out|sort out|handle|take care of)")
_PROMISE = re.compile(
    r"\b(?:i'll|i will|i'm going to|i am going to|i can|let me|we'll|we will|we're going to|we need to|"
    r"we should|we have to|we've got to|you'll|you need to|someone needs to|somebody needs to|[a-z]+ will)\s+"
    r"(?:also\s+|just\s+|quickly\s+|go ahead and\s+|make sure to\s+|try to\s+)?" + _WORK + r"\b", re.I)
_REQUEST = re.compile(
    r"\b(?:can|could|would|will) you\s+(?:please\s+|also\s+|just\s+)?" + _WORK + r"\b|\bplease\s+" + _WORK + r"\b",
    re.I)
_DECISION = re.compile(
    r"\b(?:we(?:'ve| have)? decided|the decision is|decision made|let's go with|let's do it|we're going (?:to go )?with|"
    r"we'll go with|we are going with|we agreed|we all agree|agreed on|that's (?:the|our) (?:plan|decision)|"
    r"final answer|it's approved|we're approved|approved it|signed off on|we'll move forward|moving forward with)\b",
    re.I)
_TAG_QUESTION = re.compile(r"^(?:right|okay|ok|yeah|you know|correct|makes sense|does that make sense|"
                           r"sound good|sounds good|any questions|can you hear me|are you there)\??$", re.I)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text or "") if s.strip()]


def _item(i: int, cue: dict, sentence: str) -> dict:
    due = _DUE.search(sentence)
    text = sentence if len(sentence) <= TEXT_MAX else sentence[:TEXT_MAX - 1].rstrip() + "…"
    return {"i": i, "at": cue.get("at"), "speaker": cue.get("speaker") or "", "text": text,
            "due": due.group(0) if due else ""}


def is_action(sentence: str) -> bool:
    if _EXPLICIT.search(sentence) or _REQUEST.search(sentence):
        return True
    return bool(_PROMISE.search(sentence))


def is_decision(sentence: str) -> bool:
    return bool(_DECISION.search(sentence))


def is_question(sentence: str) -> bool:
    s = sentence.strip()
    if not s.endswith("?") or _TAG_QUESTION.match(s):
        return False
    return len(re.findall(r"[A-Za-z0-9']+", s)) >= 6


def extract(cues: list[dict]) -> dict:
    """{actions, decisions, questions} from the cues, in the order they were said."""
    out = {"actions": [], "decisions": [], "questions": []}
    seen = {k: set() for k in out}
    for i, cue in enumerate(cues or []):
        for sentence in _sentences(cue.get("text") or ""):
            key = re.sub(r"\W+", " ", sentence.lower()).strip()
            if not key:
                continue
            if is_action(sentence):
                kind = "actions"
            elif is_decision(sentence):
                kind = "decisions"
            elif is_question(sentence):
                kind = "questions"
            else:
                continue
            if key in seen[kind] or len(out[kind]) >= MAX_PER_KIND:
                continue
            seen[kind].add(key)
            out[kind].append(_item(i, cue, sentence))
    return out
