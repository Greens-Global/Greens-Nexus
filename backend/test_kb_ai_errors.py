"""kb_ai says WHY the model call failed (Oct 29 2026). ONE FILE PER PROCESS."""
import os
import unittest
from unittest import mock

import httpx

import kb_ai


def _client(resp):
    class C:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, *a, **k): return resp
    return C


class KbAiErrorCase(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "test-key"

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = self._prev

    def test_the_providers_reason_travels_with_the_error(self):
        resp = httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error", "message": "Your credit balance is too low"}})
        with mock.patch.object(kb_ai.httpx, "Client", _client(resp)):
            with self.assertRaises(kb_ai.AiError) as cm:
                kb_ai._call("system", "user")
        self.assertIn("400", str(cm.exception))
        self.assertIn("credit balance is too low", str(cm.exception))
        self.assertNotIn("test-key", str(cm.exception))

    def test_a_non_json_error_body_still_says_something(self):
        with mock.patch.object(kb_ai.httpx, "Client", _client(httpx.Response(502, text="Bad Gateway"))):
            with self.assertRaises(kb_ai.AiError) as cm:
                kb_ai._call("system", "user")
        self.assertIn("502 (Bad Gateway)", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
