"""Defaults for a pytest run of the backend tests.

The request rate limiter (middleware_hardening.RequestRateLimit, Sep 22) counts
per caller per minute, and every test client is the same caller ("testclient").
A test file that makes more than 30 calls to a credential-taking route, or a
run of several files in one process, was answered 429 instead of what the test
was checking - which is how the e-sign and external sign-in tests started
failing without anyone touching them.

So the limiter is off for test runs unless a run asks for it. Its own tests
(test_security_debt_sep22.py) switch it on themselves, and production is not
affected: nothing imports this file outside pytest.

It also gives the run a throwaway database (`_testdb`) before any test module
can import `database`, so a test file that does not set DATABASE_URL itself can
no longer bind to `greens_nexus.db` or to whatever `backend/.env` points at.
"""
import os

import _testdb  # noqa: F401 - sets DATABASE_URL to a temp SQLite file; keep first

os.environ.setdefault("NEXUS_RATE_LIMIT", "off")
