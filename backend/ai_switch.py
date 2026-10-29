"""The AI off switch (Neil, Oct 29 2026): Nexus never spends the Anthropic
key unless Neil or Visesh has explicitly turned AI on.

"We do not want to use this anthropic token unless Visesh or Neil explicitly
enables it ... we cannot afford it." So every AI feature (Ask Nexus, the
Knowledge Base tools, ticket AI, Construction reports, Describe It, photo
fill, the changelog polish, everything that calls api.anthropic.com) is OFF
by default, on every server and every laptop.

How it works: main.py calls `apply()` first thing, before any other module
is imported. Unless the environment carries NEXUS_AI_ENABLED=true, it
blanks ANTHROPIC_API_KEY for the whole process. Every AI path already reads
that key and treats a blank one as "not set up", so they all stand down -
including modules that read the key once at import time, and files owned by
other developers, without editing them. A blank value (not a deleted one)
also stops a later load_dotenv() from putting a .env key back.

Turning AI on is a server setting only Neil or Visesh changes (the Azure
app setting NEXUS_AI_ENABLED=true, then a restart) - never a code change,
a database row or a screen in Nexus. Do not add another way to switch it on,
do not read the key under another name, and do not call the API around it.
"""
import os

ENABLE_VAR = "NEXUS_AI_ENABLED"
KEY_VARS = ("ANTHROPIC_API_KEY",)


def enabled(env=None) -> bool:
    env = os.environ if env is None else env
    return (env.get(ENABLE_VAR) or "").strip().lower() == "true"


def apply(env=None) -> bool:
    """Blank the AI key unless AI is explicitly on. Returns whether it is on."""
    env = os.environ if env is None else env
    if enabled(env):
        return True
    for k in KEY_VARS:
        if k in env and env.get(k):
            print(f"[ai_switch] AI is off ({ENABLE_VAR} is not true): {k} is ignored")
        env[k] = ""
    return False
