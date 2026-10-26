#!/usr/bin/env bash
# Build Mode watcher launcher: uses the backend virtualenv's Python when it is
# there, plain python3 otherwise (the tools are standard library only).
# All flags pass through to watch.py (--once, --api URL, --no-claude, --claude-args "...").
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PY="python3"
if [ -x "$ROOT/backend/.venv/bin/python" ]; then
  PY="$ROOT/backend/.venv/bin/python"
fi
cd "$ROOT"
exec "$PY" "$HERE/watch.py" "$@"
