"""A 401 means one thing to the app: the Nexus sign-in is dead.

frontend/src/lib/session401.js knows the sign-in check's answers by their
words. This file fails when auth.py words one differently (the app would stop
signing people back in), and pins the routes that used to answer 401 for
something else.
"""
import asyncio
import os
import re
import unittest
from unittest import mock

from fastapi import HTTPException

HERE = os.path.dirname(os.path.abspath(__file__))


def _read(*parts):
    with open(os.path.join(HERE, *parts), encoding="utf-8") as f:
        return f.read()


class Session401(unittest.TestCase):
    def test_every_sign_in_401_is_one_the_app_recognizes(self):
        rule = re.compile(re.search(r"const SESSION = /(.+)/;", _read("..", "frontend", "src", "lib", "session401.js")).group(1))
        details = re.findall(r'status_code=401,\s*detail=f?"([^"]+)"', _read("auth.py"))
        self.assertGreaterEqual(len(details), 8, details)
        refusals = [d for d in details if not rule.match(d)]
        # The level and grant gates refuse with a 401 too; that one is NOT a dead sign-in.
        self.assertEqual(set(refusals), {"Insufficient permissions"})

    def test_unifi_refusing_its_key_is_not_a_401(self):
        import unifi_client

        class _Resp:
            status_code = 401
            is_success = False
            text = "unauthorized"

        class _Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def get(self, *a, **k):
                return _Resp()

        with mock.patch.object(unifi_client.httpx, "AsyncClient", _Client):
            with self.assertRaises(HTTPException) as cm:
                asyncio.run(unifi_client.unifi_get("/v1/sites"))
        self.assertEqual(cm.exception.status_code, 424)


if __name__ == "__main__":
    unittest.main()
