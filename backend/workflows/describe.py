"""Describe It (spec 8.1): "Describe what should happen" -> a draft
definition. One Claude call (the same ANTHROPIC_API_KEY the ticket and KB
assistants use) with the caller's own catalog as the system prompt and
the pinned definition shape; the answer is parsed as JSON, run through
`validate` exactly like a hand-built definition and returned with its
problems and the model's notes. It never publishes anything. Off (503)
when no key is set.
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

import httpx

from workflows import catalog, validate

MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 4000
_JSON = re.compile(r"\{.*\}", re.S)


class NotConfigured(RuntimeError):
    pass


def configured() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


SHAPE = """A definition is JSON:
{"v": 1,
 "trigger": {"kind":"event","event":"<event key>","filters":[{"field","op","value"}]}
          | {"kind":"schedule","every":"day|week|month","days":[1..7 or 1..31],"time":"08:00","zone":"company"}
          | {"kind":"date","entity":"<entity key>","field":"<date field key>","offsetDays":-14,"time":"08:00","yearly":false}
          | {"kind":"manual","entity":"<entity key>"},
 "conditions": [[{"field","op","value"}, ...], ...],   (groups are OR, rows inside a group AND; [] = none)
 "steps": [
   {"id":"s1","kind":"action","action":"<action key>","params":{...},"enabled":true}
 | {"id":"s2","kind":"if","conditions":[{"field","op","value"}],"then":[steps],"else":[steps],"enabled":true}
 | {"id":"s3","kind":"approval","params":{"approvers":[recipients],"mode":"any|all|sequence","question":"...",
      "options":["Approve","Decline"],"remindDays":2,"expireDays":7},"branches":{"Approve":[steps],"Decline":[steps]},"enabled":true}
 | {"id":"s4","kind":"wait","params":{"mode":"duration","minutes":60} or {"mode":"until","field":"<date field>","offsetDays":0,"time":"08:00"} or {"mode":"business_morning"},"enabled":true}
 | {"id":"s5","kind":"for_each","source":{"key":"<list source key>","params":{...}},"as":"item","steps":[steps],"enabled":true}
 | {"id":"s6","kind":"stop","enabled":true} ],
 "settings": {"oncePerSubject":false,"cooldownHours":0,"suppress":{"people":[],"companies":[]},"logSkips":false,
              "allowDownstream":false,"maxRunsPerHour":100,"maxRecipients":50,"onError":"stop","faultSteps":[]}}
A recipients value is a list of {"kind": "self|manager|hr_contact|assignees|creator|followers|approver|owner|global_admins|company"}
or {"kind":"person","value":"<email>"} or {"kind":"role","value":"hr_contact|global_admins"} or {"kind":"department","value":"<name>"}.
Text params may use {{ subject.<field> }}, {{ change.<field>.from }} / {{ change.<field>.to }}, {{ actor.name }}, {{ today }},
{{ item.<field> }} inside For Each, {{ subject.link }}, with filters | us_date | us_datetime | upper | lower | default:"-".
Use only the entity fields, events, actions, list sources and operators listed in the catalog. Step ids are short unique strings.
Dates in text use the us_date filter. Titles are Title Case. Never use em dashes."""


def _catalog_text(db, user: dict) -> str:
    cat = catalog.serialize(db, user)
    lines = ["ENTITIES (key: fields [key:type], dates, people roles):"]
    for e in cat["entities"]:
        fields = ", ".join(f"{f['key']}:{f['type']}" for f in e["fields"])
        dates = ", ".join(d["key"] + (" (yearly)" if d["yearly"] else "") for d in e["dates"])
        people = ", ".join(p["key"] for p in e["people"])
        lines.append(f"- {e['key']} ({e['label']}): fields [{fields}]; dates [{dates}]; people [{people}]")
    lines.append("EVENTS (key: label, entity, change fields):")
    for ev in cat["events"]:
        lines.append(f"- {ev['key']}: {ev['label']}, entity {ev['entity']}, changes {ev['changes']}")
    lines.append("ACTIONS (key: label, params [key:type required]):")
    for a in cat["actions"]:
        params = ", ".join(f"{p['key']}:{p['type']}{'*' if p['required'] else ''}" for p in a["params"])
        lines.append(f"- {a['key']}: {a['label']} [{params}]" + (" (Global Admin only)" if a["adminOnly"] else ""))
    lines.append("LIST SOURCES (key: label, entity, params):")
    for s in cat["listSources"]:
        params = ", ".join(f"{p['key']}:{p['type']}" for p in s["params"])
        lines.append(f"- {s['key']}: {s['label']}, entity {s['entity']} [{params}]")
    lines.append("OPERATORS by field type: " + json.dumps({t: [o["key"] for o in ops] for t, ops in cat["operators"].items()}))
    return "\n".join(lines)


def system_prompt(db, user: dict) -> str:
    return ("You draft Nexus workflow definitions. Answer with ONE JSON object only - no prose, no code fence - "
            "of the form {\"definition\": {...}, \"notes\": \"one or two sentences on what you assumed or left blank\"}.\n\n"
            + SHAPE + "\n\nTHE CATALOG THIS PERSON MAY USE:\n" + _catalog_text(db, user))


def _call(system: str, text: str) -> str:
    import ai_assistant
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    body = {"model": MODEL, "max_tokens": MAX_TOKENS, "system": system,
            "messages": [{"role": "user", "content": text}]}
    with httpx.Client(timeout=ai_assistant._TIMEOUT) as c:
        r = c.post(ai_assistant._API, headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                               "content-type": "application/json"}, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic {r.status_code}: {r.text[:300]}")
    data = r.json()
    return "".join(b.get("text", "") for b in (data.get("content") or []) if b.get("type") == "text")


def parse(answer: str) -> tuple[Optional[dict], str]:
    """(definition, notes) from the model's text; None when no JSON object
    with a definition is in it."""
    m = _JSON.search(answer or "")
    if not m:
        return None, ""
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None, ""
    if not isinstance(data, dict):
        return None, ""
    if "definition" in data and isinstance(data["definition"], dict):
        return data["definition"], str(data.get("notes") or "")
    if "trigger" in data and "steps" in data:
        return data, ""
    return None, ""


def draft(db, user: dict, text: str, *, entity_hint: str = "", company_id: str = "") -> dict:
    """{"definition", "problems", "notes"} for `text`; raises NotConfigured
    without a key, RuntimeError when the model answers badly."""
    if not configured():
        raise NotConfigured("ANTHROPIC_API_KEY is not set")
    ask = (text or "").strip()
    if not ask:
        raise ValueError("Describe what should happen first")
    if entity_hint:
        ask += f"\n\n(The workflow is about: {entity_hint})"
    answer = _call(system_prompt(db, user), ask[:4000])
    definition, notes = parse(answer)
    if definition is None:
        raise RuntimeError("The draft could not be read - please try again with more detail")
    from workflows import store
    definition = store.normalize_definition(definition)
    problems = validate.validate(db, definition, owner=user, run_as="owner", company_id=company_id or "")
    return {"definition": definition, "problems": [p.to_dict() for p in problems], "notes": notes}
