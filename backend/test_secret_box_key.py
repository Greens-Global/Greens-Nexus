"""secret_box's key on Azure vs. locally (Sep 30 review).

The dev fallback key is in the repo, so a deployed API running on it encrypts
sessions and OAuth tokens with a public key. On Azure (WEBSITE_SITE_NAME set,
the same test as the NEXUS_SKIP_AUTH refusal) there is now no fallback and the
lifespan refuses to start; locally the fallback stays, with a loud warning.

secret_box decides at import time, so each case runs in a fresh interpreter.
No database. Run with: python -m pytest test_secret_box_key.py
"""
import ast
import os
import subprocess
import sys
import unittest

from cryptography.fernet import Fernet

HERE = os.path.dirname(os.path.abspath(__file__))


def _run(code: str, *, azure: bool, key: str = ""):
    env = {k: v for k, v in os.environ.items() if k not in ("WEBSITE_SITE_NAME", "NEXUS_VAULT_KEY")}
    if azure:
        env["WEBSITE_SITE_NAME"] = "greens-nexus-api"
    if key:
        env["NEXUS_VAULT_KEY"] = key
    return subprocess.run([sys.executable, "-c", "import secret_box as sb\n" + code],
                          cwd=HERE, env=env, capture_output=True, text=True, timeout=60)


class SecretBoxKeyTests(unittest.TestCase):
    def test_on_azure_without_the_key_nothing_is_encrypted_with_the_fallback(self):
        r = _run("""
try:
    sb.encrypt("refresh-token")
    print("ENCRYPTED")
except RuntimeError:
    print("REFUSED")
print("configured", sb.KEY_CONFIGURED)
""", azure=True)
        self.assertIn("REFUSED", r.stdout, r.stderr)
        self.assertIn("configured False", r.stdout)
        self.assertIn("FATAL", r.stderr)

    def test_on_azure_without_the_key_startup_exits(self):
        r = _run("sb.require_key_on_azure()\nprint('STARTED')", azure=True)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("STARTED", r.stdout)
        self.assertIn("NEXUS_VAULT_KEY must be set", r.stderr)

    def test_on_azure_with_the_key_it_starts_and_round_trips(self):
        r = _run("sb.require_key_on_azure()\nprint(sb.decrypt(sb.encrypt('x1')))",
                 azure=True, key=Fernet.generate_key().decode())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "x1")

    def test_locally_the_dev_fallback_still_works_with_a_loud_warning(self):
        r = _run("sb.require_key_on_azure()\nprint(sb.decrypt(sb.encrypt('x2')))", azure=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "x2")
        self.assertIn("DEV-ONLY fallback key", r.stderr)

    def test_the_lifespan_calls_the_refusal(self):
        with open(os.path.join(HERE, "main.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
        lifespan = next(n for n in ast.walk(tree)
                        if isinstance(n, ast.AsyncFunctionDef) and n.name == "lifespan")
        calls = [n.func.attr for n in ast.walk(lifespan)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        self.assertIn("require_key_on_azure", calls)


if __name__ == "__main__":
    unittest.main()
