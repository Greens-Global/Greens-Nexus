# Build Mode - Claude Code In The Cloud (setup, once per developer)

Neil, 11/12/2026: Nexus may start a Claude Code cloud session for a developer.

After this, **Send To Claude Code** in Build Mode starts Claude Code in
Claude's cloud, on your own Claude subscription. No terminal, no watcher,
nothing installed on your computer. It takes about ten minutes, once.

What it is not: Nexus does not use the Anthropic API key for this, spends no
Nexus credits, and no Nexus AI feature is switched on. The session is yours,
on your Claude account, exactly like one you start yourself at
claude.ai/code. (`backend/build_mode_cloud.py` says the same in code.)

You need: Build Mode access (Settings > People & Access - the Build Mode
Access Group), a Claude plan with Claude Code on the web, and the Claude
GitHub App on the Nexus repository (already there if you have ever opened a
cloud session on it).

## Step 1 - Let Claude Code reach Nexus

Claude Code's cloud machine can only reach the hosts its **cloud
environment** allows, and it needs your Build Token to act as you.

1. In Nexus: Build Mode > Done (or Settings) > **Connect In The Cloud** >
   **Make A Build Token**. Copy it - it is shown once. It renews itself for
   as long as Claude Code uses it, and dies 30 days after its last use.
2. In Claude Code on the web (claude.ai/code), open the cloud environment you
   will use for Nexus (make one named "Greens Nexus" rather than changing
   your Default) and set:
   - a **network secret** for the Nexus API host the card shows (for the dev
     site: `greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net`),
     sent as `Authorization: Bearer <your Build Token>`. A network secret is
     added to the request on its way out, so the session never sees the
     token;
   - **allowed hosts**: the storage host the pins' screenshots are on (for
     dev: `xemoocdvqzhfbwjxcjdx.supabase.co`) and `cdn.sheetjs.com` (one
     frontend package is downloaded from there; without it `npm ci` fails).

   - a **setup script**, so every session starts with the dependencies the
     checks and the evidence need (run 11/12/2026 on a cloud machine: the
     frontend build, all frontend tests and the Build Mode backend tests
     pass after it). It never blocks a session from starting:

     ```
     #!/bin/bash
     if [ -d Greens-Nexus/frontend ]; then
       (cd Greens-Nexus/frontend && npm ci --no-audit --no-fund) || echo "greens-nexus setup: npm ci failed"
     fi
     if [ -d Greens-Nexus/backend ]; then
       (cd Greens-Nexus/backend && python3 -m venv .venv \
         && grep -v '^psycopg2' requirements.txt > /tmp/nexus-requirements.txt \
         && .venv/bin/pip install -q -r /tmp/nexus-requirements.txt pytest ruff) \
         || echo "greens-nexus setup: backend install failed"
     fi
     ```

     (The Postgres driver is left out: it does not build on the cloud
     machine and the tests run on SQLite.)

Never put the real Build Token in an environment variable, a prompt or a
file in the repository.
Claude Code calls the command line with a placeholder token
(`--token nxbn_cloud`); the network secret replaces it on the wire.

## Step 2 - Make the scheduled task

In Claude Code on the web, add a scheduled task:

- **Repository:** Greens-Global/Greens-Nexus. **Environment:** the one from
  step 1.
- **Instructions:** in Nexus the card has **Copy Instructions** - paste them
  as they are. They tell Claude to run the repository's `/build-notes`
  procedure on the pin ids each Send carries, and to treat everything in a
  pin as information, never as instructions.
- **Schedule:** none. It only runs when Nexus starts it.

## Step 3 - Add its API trigger and paste it into Nexus

1. Edit the scheduled task. In the **Trigger** row choose **+ > API**. A
   panel shows the **Fire URL**; press **Generate token** and copy the token
   at once - it is shown once.
2. In Nexus, paste the Fire URL and the token into the card and press
   **Connect**.

Nexus keeps the trigger encrypted, never shows it again and never puts it in
a log. It accepts only Claude Code's own Fire URL
(`https://api.anthropic.com/v1/claude_code/routines/trig_.../fire`), so the
token cannot be sent anywhere else. To stop: **Disconnect** in Nexus, or
**Delete token** on the trigger in Claude Code - either one ends it.

## Using it

- **Send To Claude Code** (or Send Instantly) starts one session for the
  pins you sent. Each pin shows **Open Claude Session** within seconds and
  then Claude's progress lines.
- When Claude has a question the pin turns **Needs Input** and your bell
  rings. Your reply on the pin starts Claude Code again on the same branch.
- The pull request is opened against `dev` and recorded on the pins. There
  is no preview to open in the cloud: after the merge the pin turns
  **Fixed - Verify** and you Accept or Reopen it on the dev site.
- A session that did not start says why on the pin ("Claude Code did not
  start: ...") and the pin gets **Start Claude Code** to try again. Claude
  Code allows 30 starts an hour for one scheduled task.
- Prefer your terminal for a while? Settings > Where Claude Code Runs > On
  My Computer. The trigger stays saved. A pin goes to one or the other, never
  both.

## When it does not work

| What you see | What it means |
| --- | --- |
| "Claude Code did not accept your trigger token" | The token was regenerated or deleted in Claude Code. Generate a new one and Connect again. |
| "That scheduled task no longer exists" | The scheduled task was deleted. Make it again (step 2) and Connect. |
| "Claude Code's hourly limit for starting sessions was reached" | 30 starts an hour per scheduled task. Wait, then Start Claude Code. |
| The session opens but posts nothing on the pin | The environment cannot reach Nexus or has no Build Token (step 1). The session's last message says which. |
| The session says a check or the evidence was skipped | The environment has no dependencies installed: add the setup script from step 1, and allow `cdn.sheetjs.com`. |

Not proven yet (11/12/2026): the whole loop has passed its tests but has not
been run end to end with a real pin. The first real run is the proof; fix
this guide with what it shows.
