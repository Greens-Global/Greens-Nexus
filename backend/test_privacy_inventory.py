"""The privacy inventory (privacy_inventory.py, 11/02/2026) stays true.

  * Every hostname the backend or frontend/src names, and every host the CSP
    allows, is either a listed processor or a listed non-processor (a link, a
    namespace). A NEW outbound integration fails here until it is added to
    the inventory - and so to the Privacy Policy.
  * Every storage bucket the code names is classified, and the protected ones
    are exactly routers/files.py's and frontend/src/lib/storageView.js's
    PROTECTED_BUCKETS.
  * The AI section follows the live switch, never a fixed word.
  * The public notice says nothing about any person or this server's optional
    services; the signed-in one adds the viewer's contact, and only
    administrators see the counsel-review note.

Run on its own: `python -m pytest test_privacy_inventory.py` (one file per
process - see CLAUDE.md)."""
import fnmatch
import json
import os
import re
import unittest
import uuid

import _testdb  # noqa: F401  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import privacy_inventory as inv  # noqa: E402
from routers import files  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SKIP_DIRS = {".venv", "node_modules", "__pycache__", "venv"}
HOST_RE = re.compile(r"(?:https?|wss?)://([A-Za-z0-9*{][A-Za-z0-9*{}._-]*\.[A-Za-z]{2,})")


def _is_test(name):
    return name.startswith("test_") or ".test." in name or name.endswith(".spec.js") or name == "conftest.py"


def _tracked():
    """The files git tracks (so an untracked scratch file never fails this
    locally); None when git is not available - then the tree is walked."""
    import subprocess
    try:
        out = subprocess.run(["git", "ls-files", "backend", "frontend/src", "frontend/public/_headers"],
                             cwd=REPO, capture_output=True, text=True, timeout=60, check=True).stdout
    except Exception:
        return None
    return [os.path.join(REPO, p) for p in out.splitlines() if p]


def _files():
    tracked = _tracked()
    if tracked:
        for p in tracked:
            name = os.path.basename(p)
            if _is_test(name) or any(d in p.split(os.sep) for d in SKIP_DIRS):
                continue
            in_backend = p.startswith(HERE + os.sep) and name.endswith(".py")
            in_src = (os.sep + os.path.join("frontend", "src") + os.sep) in p and name.endswith((".js", ".jsx"))
            if (in_backend or in_src or name == "_headers") and os.path.exists(p):
                yield p
        return
    for base, exts in ((HERE, (".py",)), (os.path.join(REPO, "frontend", "src"), (".js", ".jsx"))):
        if not os.path.isdir(base):
            continue
        for dp, dn, fn in os.walk(base):
            dn[:] = [d for d in dn if d not in SKIP_DIRS]
            for f in fn:
                if f.endswith(exts) and not _is_test(f):
                    yield os.path.join(dp, f)
    headers = os.path.join(REPO, "frontend", "public", "_headers")
    if os.path.exists(headers):
        yield headers


def _read(p):
    with open(p, encoding="utf-8", errors="ignore") as f:
        return f.read()


def _covered(host, patterns):
    return any(host == p or fnmatch.fnmatch(host, p) for p in patterns)


class HostInventoryTests(unittest.TestCase):
    def test_every_named_host_is_in_the_inventory(self):
        listed = [h.lower() for p in inv.PROCESSORS for h in p["hosts"]] + list(inv.NOT_PROCESSORS)
        missing = {}
        for path in _files():
            for m in HOST_RE.finditer(_read(path)):
                host = m.group(1).lower().rstrip(".")
                if host.endswith(".azurewebsites.net") or host.endswith(".supabase.co"):
                    host = "*." + ".".join(host.split(".")[-2:])   # the deployed API / project hosts
                if not _covered(host, listed):
                    missing.setdefault(host, os.path.relpath(path, REPO))
        self.assertEqual(missing, {}, "Add each host to privacy_inventory.PROCESSORS (it receives data) or "
                                      "NOT_PROCESSORS (a link or namespace): " + json.dumps(missing, indent=1))

    def test_every_processor_says_what_and_why(self):
        keys = set()
        for p in inv.PROCESSORS:
            with self.subTest(p=p["key"]):
                self.assertNotIn(p["key"], keys)
                keys.add(p["key"])
                for f in ("name", "purpose", "data", "where", "group"):
                    self.assertTrue(p.get(f), f)
                self.assertIn(p["group"], inv.GROUP_TITLES)
        self.assertIn("anthropic", keys)


class BucketTests(unittest.TestCase):
    BUCKET_RES = [
        re.compile(r"BUCKET\s*=\s*['\"]([a-z0-9_-]+)['\"]"),
        re.compile(r"storage\s*\.from\(\s*['\"]([a-z0-9_-]+)['\"]"),
        re.compile(r"uploadToSupabase\([^,]+,\s*['\"]([a-z0-9_-]+)['\"]"),
        re.compile(r"/storage/v1/object/(?:public/|sign/)?([a-z][a-z0-9_-]+)/"),
    ]

    def test_every_bucket_in_the_code_is_classified(self):
        seen = {}
        for path in _files():
            text = _read(path)
            for rx in self.BUCKET_RES:
                for m in rx.finditer(text):
                    seen.setdefault(m.group(1), os.path.relpath(path, REPO))
        seen = {b: p for b, p in seen.items() if b not in ("copy", "list", "upload", "sign", "public", "x")}
        unknown = {b: p for b, p in seen.items() if b not in inv.BUCKETS}
        self.assertEqual(unknown, {}, "Classify each bucket in privacy_inventory.BUCKETS")

    def test_protected_lists_match(self):
        protected = {b for b, kind in inv.BUCKETS.items() if kind == "protected"}
        self.assertEqual(protected, set(files.PROTECTED_BUCKETS))
        sv = os.path.join(REPO, "frontend", "src", "lib", "storageView.js")
        if os.path.exists(sv):
            m = re.search(r"PROTECTED_BUCKETS\s*=\s*\[([^\]]*)\]", _read(sv))
            self.assertEqual(set(re.findall(r"'([^']+)'", m.group(1))), protected)


class AiStatusTests(unittest.TestCase):
    def _ai_section(self, env):
        n = inv.notice(env=env)
        return next(s for s in n["sections"] if s["h"].endswith("AI Features"))

    def test_off_without_the_switch_even_with_a_key(self):
        sec = self._ai_section({"ANTHROPIC_API_KEY": "sk-test"})
        self.assertFalse(sec["aiStatus"]["enabled"])
        self.assertIn("AI features are OFF", " ".join(sec["p"]))

    def test_off_with_the_switch_but_no_key(self):
        self.assertFalse(self._ai_section({"NEXUS_AI_ENABLED": "true", "ANTHROPIC_API_KEY": ""})["aiStatus"]["enabled"])

    def test_on_only_with_both(self):
        sec = self._ai_section({"NEXUS_AI_ENABLED": "true", "ANTHROPIC_API_KEY": "sk-test"})
        self.assertTrue(sec["aiStatus"]["enabled"])
        self.assertIn("AI features are ON", " ".join(sec["p"]))

    def test_shot_retention_follows_the_setting(self):
        cats = {c["key"]: c for c in inv.categories({"NEXUS_SHOT_RETENTION_DAYS": "45"})}
        self.assertIn("after 45 days", cats["monitoring"]["retention"])


class NoticeRouteTests(unittest.TestCase):
    ADMIN = "privnote.admin@greensglobal.com"
    EMP = "privnote.emp@greensglobal.com"
    HR = "privnote.hr@greensglobal.com"

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            self.ent = str(uuid.uuid4())
            self.bare = str(uuid.uuid4())
            db.add(models.HrEntity(id=self.ent, name="Privnote Co", legal_name="Privnote Holdings LLC",
                                   hr_contact_email=self.HR))
            db.add(models.HrEntity(id=self.bare, name="Privnote Bare Co", hr_contact_email=""))
            db.add(models.NexusEmployee(id=str(uuid.uuid4()), work_email=self.EMP, first_name="Em",
                                        last_name="Ployee", company=self.ent))
            db.add(models.NexusEmployee(id=str(uuid.uuid4()), work_email=self.HR, first_name="Hana",
                                        last_name="Rivera", company=self.ent))
            db.add(models.NexusRole(email=self.ADMIN, role="owner"))
            db.add(models.NexusRole(email=self.EMP, role="employee"))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.like("privnote.%")).delete(
                synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("privnote.%")).delete(
                synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.name.like("Privnote%")).delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for e in (self.ADMIN, self.EMP, self.HR):
            auth.invalidate_role_cache(e)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def test_public_notice_needs_no_login_and_names_no_one(self):
        auth.SKIP_AUTH = False
        r = self.client.get("/policy/privacy-notice")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        text = json.dumps(body, ensure_ascii=False)
        self.assertNotIn("—", text)                       # no em dashes
        self.assertNotIn("Greens", text)                       # white-label
        self.assertNotIn("inUse", text)                        # nothing about this server's services
        self.assertNotIn("admin", body)
        self.assertEqual(body["ai"], {"enabled": False})   # never the switch or the key
        ai_sec = next(s for s in body["sections"] if s["h"].endswith("AI Features"))
        self.assertEqual(set(ai_sec["aiStatus"]), {"enabled"})
        heads = [s["h"] for s in body["sections"]]
        for h in ("What We Collect", "Location and Work Monitoring", "AI Features", "Who We Share It With",
                  "How Long We Keep It", "Your Rights"):
            self.assertTrue(any(h in x for x in heads), h)
        self.assertIn("Anthropic", text)
        self.assertIn("Digital Personal Data Protection Act", text)
        self.assertIn("CPRA", text)

    def test_signed_in_notice_has_the_contact_and_services_in_use(self):
        self._as(self.EMP)
        body = self.client.get("/policy/privacy-notice/me").json()
        text = json.dumps(body)
        self.assertIn("Hana Rivera at privnote.hr@greensglobal.com", text)
        self.assertIn("Privnote Holdings LLC", text)
        self.assertTrue(all("inUse" in p for p in body["processors"]))
        self.assertTrue(next(p for p in body["processors"] if p["key"] == "supabase")["inUse"])
        self.assertNotIn("admin", body)   # counsel-review note: administrators only

    def test_admin_sees_counsel_review_and_what_to_fill(self):
        self._as(self.ADMIN)
        body = self.client.get("/policy/privacy-notice/me").json()
        self.assertTrue(body["admin"]["counselReview"])
        self.assertIn("Privnote Bare Co", [n["company"] for n in body["admin"]["needsInput"]])
        self.assertNotIn("Privnote Co", [n["company"] for n in body["admin"]["needsInput"]])
        self.assertIn("signInPolicyOutOfDate", body["admin"])


if __name__ == "__main__":
    unittest.main()
