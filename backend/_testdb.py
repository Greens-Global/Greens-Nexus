"""Point a test run at a throwaway database before anything imports `database`.

`database.py` reads DATABASE_URL once, when it is first imported, and falls
back to `sqlite:///./greens_nexus.db` - a developer's real local database.
`main.py` also loads `backend/.env`, which may name the shared dev Postgres.
A test file that did not set DATABASE_URL itself therefore ran against real
data; on Sep 29 a multi-file run emptied people and roles in a local
`greens_nexus.db`.

Importing this module gives the process its own empty SQLite file in the
system temp folder, removed when the process exits. It uses `setdefault`, so:

  * a test file that assigns its own `os.environ["DATABASE_URL"]` at import
    still gets the database it asked for (it runs after this and overwrites);
  * a DATABASE_URL already exported in the shell is left alone - that is a
    deliberate choice by whoever ran the command;
  * a DATABASE_URL in `backend/.env` can NOT take over: `load_dotenv()` in
    `main.py` / `unifi_client.py` runs without `override`, so it never replaces
    a variable that is already set, and this sets it first.

pytest gets this through `conftest.py`. `python -m unittest` does not load
conftest, so a test file run that way imports this as its FIRST import
(`test_app_boot.py`, `test_auth_access.py` - the two CI runs today).

Nothing outside the tests imports this file.
"""
import atexit
import os
import shutil
import sys
import tempfile


def _remove(folder):
    # Close the engine's connections first: Windows will not delete a file
    # that is still open. Best effort either way - it is a temp folder.
    try:
        db = sys.modules.get("database")
        if db is not None:
            db.engine.dispose()
    except Exception:  # noqa: BLE001 - cleanup must never fail a test run
        pass
    shutil.rmtree(folder, ignore_errors=True)


def _use_throwaway_database():
    if os.environ.get("DATABASE_URL"):
        return
    folder = tempfile.mkdtemp(prefix="nexus-test-db-")
    path = os.path.join(folder, "nexus_test.db").replace("\\", "/")
    os.environ["DATABASE_URL"] = "sqlite:///" + path
    atexit.register(_remove, folder)


_use_throwaway_database()
