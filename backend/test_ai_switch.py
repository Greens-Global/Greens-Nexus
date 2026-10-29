"""AI is OFF unless Neil or Visesh turns it on (Neil, Oct 29 2026: "we cannot
afford it"). ONE FILE PER PROCESS - it imports main with a key in the
environment and checks nothing can see it."""
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import ai_switch

HERE = Path(__file__).resolve().parent


class AiSwitchCase(unittest.TestCase):
    def test_the_key_is_blanked_unless_ai_is_explicitly_on(self):
        for flag in (None, "", "false", "0", "yes", "TRUE-ish", "1"):
            env = {"ANTHROPIC_API_KEY": "sk-live"}
            if flag is not None:
                env["NEXUS_AI_ENABLED"] = flag
            self.assertFalse(ai_switch.apply(env), flag)
            self.assertEqual(env["ANTHROPIC_API_KEY"], "", flag)
        for flag in ("true", "True", " TRUE "):
            env = {"ANTHROPIC_API_KEY": "sk-live", "NEXUS_AI_ENABLED": flag}
            self.assertTrue(ai_switch.apply(env))
            self.assertEqual(env["ANTHROPIC_API_KEY"], "sk-live")

    def test_main_switches_ai_off_before_any_other_import(self):
        src = (HERE / "main.py").read_text()
        apply_at = src.index("ai_switch.apply()")
        first_app_import = min(m.start() for m in re.finditer(r"^(import models|from routers|from database|import auth)", src, re.M))
        self.assertLess(apply_at, first_app_import, "ai_switch.apply() must run before main imports any module")

    def test_with_main_loaded_no_ai_path_sees_the_key(self):
        db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        db.close()
        code = (
            "import os, main, kb_ai, ticket_ai, construction_ai, construction_report, ai_assistant\n"
            "from workflows import describe\n"
            "from routers import items, egnyte, external_links, hr_interviews, task_config\n"
            "assert os.environ['ANTHROPIC_API_KEY'] == '', 'key visible'\n"
            "assert not kb_ai.available()\n"
            "for m in (ticket_ai, construction_ai, construction_report, ai_assistant, describe):\n"
            "    assert not m.configured(), m.__name__\n"
            "for mod, name in ((items, '_ANTHROPIC_API_KEY'), (egnyte, '_ANTHROPIC_API_KEY'), (external_links, '_ANTHROPIC_API_KEY'),\n"
            "                  (hr_interviews, '_ANTHROPIC_KEY'), (task_config, '_ANTHROPIC_API_KEY')):\n"
            "    assert getattr(mod, name) == '', mod.__name__\n"
            "print('AI-OFF-OK')\n"
        )
        env = {**os.environ, "ANTHROPIC_API_KEY": "sk-should-never-be-read", "DATABASE_URL": f"sqlite:///{db.name}",
               "NEXUS_SKIP_AUTH": "true", "NEXUS_RATE_LIMIT": "off"}
        env.pop("NEXUS_AI_ENABLED", None)
        try:
            out = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True, timeout=180)
        finally:
            os.remove(db.name)
        self.assertIn("AI-OFF-OK", out.stdout, out.stderr[-2000:])

    def test_no_script_calls_the_api_outside_main(self):
        # A standalone script would skip main's switch - none may call Anthropic.
        for f in HERE.rglob("*.py"):
            if f.name.startswith("test_") or ".venv" in f.parts or "site-packages" in f.parts:
                continue
            s = f.read_text(errors="ignore")
            if "api.anthropic.com" in s or "ai_assistant._API" in s:
                self.assertNotRegex(s, r"if __name__ == ['\"]__main__['\"]", f"{f.name} can run on its own and call Anthropic")


if __name__ == "__main__":
    unittest.main()
