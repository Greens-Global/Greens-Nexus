# Build Notes tools

The local half of **Build Mode**: a watcher that waits for pins sent from Nexus
and hands them to Claude Code in your terminal, and the command line Claude Code
uses to claim pins, post progress, reply, attach after screenshots and record
the PR. Standard library only - plain `python3` runs them, no virtualenv.

What Build Mode is, who can use it and the whole loop: `docs/Build-Mode.md`.
The procedure Claude Code follows: `.claude/skills/build-notes/SKILL.md`.

## Setup (once per machine)

1. In Nexus open the profile menu (top right) > **Build Mode** > **Settings** >
   **Build Tokens**, mint a token with a label ("Neil's MacBook") and copy it -
   it is shown once. Tokens expire after 30 days and can be revoked there.
2. Save it where the tools look for it:

   ```
   mkdir -p ~/.config/nexus
   printf '%s\n' 'nxbn_...' > ~/.config/nexus/build-notes.token
   chmod 600 ~/.config/nexus/build-notes.token
   ```

   `NEXUS_BUILD_TOKEN` in the environment wins over the file. Never commit a
   token; `.gitignore` already keeps `.env*` out, and the token file lives
   outside the repository.
3. Check it:

   ```
   python3 tools/build_notes/cli.py whoami
   ```

   prints your email and the token label.

The tools talk to the dev API by default (the same `VITE_API_BASE` the dev
site is built with, see `.github/workflows/ci.yml`). `NEXUS_API_BASE` or
`--api URL` points them elsewhere, for example `--api http://localhost:8000`
for a local backend.

## The watcher

```
tools/build_notes/watch.sh
```

prints `Build Mode - waiting for pins (Ctrl+C to stop)` and a dot every
long-poll (about every 25 seconds). When someone clicks **Send To Claude Code**
in Nexus the watcher prints the pins and runs

```
claude "/build-notes <id> <id> ..."
```

in the same terminal with the repository root as the working directory - the
terminal becomes the Claude Code session, which claims the pins, fixes them,
opens the PR and writes it back. When Claude exits the watcher goes back to
waiting. Network trouble is retried with backoff (2 s up to 60 s) and the
watcher keeps going; a revoked token stops it with the reason.

`watch.sh` uses `backend/.venv/bin/python` when it exists, else `python3`.
`python3 tools/build_notes/watch.py` works just as well.

Flags (all pass through `watch.sh`):

| flag | meaning |
|---|---|
| `--once` | handle one batch of pins, then exit |
| `--api URL` | API base (default `NEXUS_API_BASE`, else the dev API) |
| `--no-claude` | print the pin ids and the command instead of running Claude Code |
| `--claude-args "..."` | extra arguments for `claude`, e.g. `--claude-args "--model opus"` |
| `--timeout N` | long-poll seconds per request (default 25, max 50) |
| `--token TOKEN` | a token for this run only |
| `--repo PATH` | run Claude Code in another checkout (default: this repository) |

### VS Code task

`.vscode/` is gitignored, so add this yourself to `.vscode/tasks.json` (create
the file if you do not have one) and run it with **Terminal > Run Task... >
Nexus: Build Notes Watcher**:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Nexus: Build Notes Watcher",
      "type": "shell",
      "command": "${workspaceFolder}/tools/build_notes/watch.sh",
      "isBackground": false,
      "presentation": { "reveal": "always", "panel": "dedicated", "focus": true, "clear": true },
      "problemMatcher": []
    }
  ]
}
```

Add `"runOptions": { "runOn": "folderOpen" }` to the task to start it whenever
the workspace opens (VS Code asks once to allow automatic tasks).

## The command line

```
python3 tools/build_notes/cli.py whoami
python3 tools/build_notes/cli.py list [--status dispatched] [--route tasks] [--mine] [--json]
python3 tools/build_notes/cli.py claim <id>... [--out DIR] [--no-download]
python3 tools/build_notes/cli.py progress <id> "Reading pins"
python3 tools/build_notes/cli.py reply <id> "text" [--needs-input | --answered] [--image PATH]
python3 tools/build_notes/cli.py after <id> --image PATH
python3 tools/build_notes/cli.py complete <id>... --pr URL --branch NAME [--summary "..."]
```

`--api` and `--token` go before the subcommand.

- `claim` moves the pins to Building, downloads every media file (screenshot,
  page shot, contact sheet, video, pasted attachments, after shots) into
  `~/.cache/nexus-build-notes/<id>/` (`--out DIR` to change it) and prints one
  markdown brief per pin: header, author and date, route / sub / URL / build,
  viewport, comment, thread, target (selector, tag, text, headings, breadcrumb,
  components, record ids, HTML), the markup in words ("red rectangle around
  the target"), the Edit In Place diff, transcript, console (last 50), network
  (last 30) and the local file paths. The brief is also saved as `brief.md`
  next to the files, with the raw `pin.json`.
- `progress` is one line the author sees on the pin.
- `reply` adds a thread entry as Claude; `--needs-input` parks the pin in Needs
  Input and rings the author's bell, `--answered` closes a Question pin;
  `--image` uploads a png/jpg/webp (8 MB max) with the reply.
- `after` attaches an after screenshot (kind `after`).
- `complete` records the PR on the pins and the Build Session (`prNumber` is
  read from the URL; `--pr-number` overrides it).

Exit codes: 0 ok, 1 API or network error (message on stderr), 2 bad arguments
or missing token.

## Troubleshooting

- **"No Build Token found"** - save the token to
  `~/.config/nexus/build-notes.token` or export `NEXUS_BUILD_TOKEN`.
- **"Your Build Token was revoked or expired - mint a new one in Nexus > Build
  Mode > Settings"** - a 401. Tokens live 30 days; mint a new one and replace
  the file.
- **"Build Mode is not enabled for you"** - a 403. Your account is not a Global
  Admin and no Access Group grants the `build-mode` module. The check runs on
  every call, so a token keeps working only while its owner has access.
- **"Cannot reach https://..."** - the API is down or you are offline. The
  watcher retries on its own; the CLI exits 1.
- **The watcher prints dots but nothing arrives** - the pins must be sent
  (Send To Claude Code in the Build Mode panel, or Send Instantly on). Pins
  already Building were claimed by another terminal; `list --status building`
  shows them.
- **"The `claude` command is not on PATH"** - install Claude Code, or run
  `--no-claude` and paste the printed command into a Claude Code session.
- **A pin came back after Claude exited** - the watcher only hands over pins
  in Dispatched (or Needs Input with a fresh answer). If Claude exited without
  claiming them they return on the next poll by design.
- **Local backend** - `--api http://localhost:8000`; the token must have been
  minted on that backend's database.

## Tests

From the repository root:

```
backend/.venv/bin/python -m unittest tools/build_notes/test_build_notes.py
```

The tests start a fake `/dev-notes/cli/*` server on 127.0.0.1 and run the
watcher and every subcommand against it; nothing touches the real API.
