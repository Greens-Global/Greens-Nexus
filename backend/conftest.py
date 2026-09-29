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
"""
import os

os.environ.setdefault("NEXUS_RATE_LIMIT", "off")
