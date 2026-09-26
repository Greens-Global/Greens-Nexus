"""Email Appearance (Sep 26, 2026): one theme for every Nexus email.

Proves:
  * with the default theme, every refactored email renders byte for byte what
    it rendered before the theme existed (snapshots in testdata/email_theme/,
    captured from the pre-theme templates);
  * a custom theme reaches every family - accent, logo, footer and address;
  * the settings endpoints validate the color and logo, are Administrator
    only, audit the change, and the preview renders without saving.

    python -m pytest test_email_theme.py
"""
import json
import os
import re
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_APP_URL"] = "https://nexus.example"

from fastapi.testclient import TestClient

import auth
import cache
import database
import email_theme
import email_theme_samples
import main
import models
from routers import items as items_router

models.Base.metadata.create_all(bind=database.engine)

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "testdata", "email_theme")
ADMIN = "etheme.admin@greensglobal.com"
EMP = "etheme.emp@greensglobal.com"
STORAGE = "https://proj.supabase.co/storage/v1/object/public/"
LOGO = STORAGE + "document-images/email-theme/logo.png"

CUSTOM = email_theme.Theme(logoUrl=LOGO, accentColor="#1d4ed8",
                           footerText="Greens Global, Inc. - internal use",
                           companyAddressLine="100 Main St, Escondido, CA 92025")


def _norm(html: str) -> str:
    return re.sub(r"&copy; \d{4}", "&copy; YEAR", html)


class RenderTests(unittest.TestCase):
    def test_default_theme_matches_the_pre_theme_snapshots(self):
        rendered = email_theme_samples.render_all(email_theme.DEFAULT_THEME)
        self.assertEqual(set(rendered), set(email_theme_samples.SAMPLE_LABELS))
        for name, html in rendered.items():
            # Universal newlines: a Windows checkout may turn the snapshots into CRLF.
            with open(os.path.join(SNAP, f"{name}.html"), encoding="utf-8") as f:
                self.assertEqual(_norm(html), f.read(), f"{name} changed with the default theme")

    def test_custom_theme_reaches_every_family(self):
        for name, html in email_theme_samples.render_all(CUSTOM).items():
            self.assertIn("#1d4ed8", html, name)
            self.assertIn("logo.png", html, name)
            self.assertIn("Greens Global, Inc. - internal use", html, name)
            self.assertIn("100 Main St, Escondido, CA 92025", html, name)
            for classic in ("#0f3d2e", "#14532d", "#248f4b"):
                self.assertNotIn(classic, html, f"{name} still uses {classic}")

    def test_footer_text_is_escaped(self):
        th = email_theme.Theme(footerText="<script>x</script>")
        html = email_theme_samples.render("task", th)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_a_module_logo_still_wins_over_the_theme_logo(self):
        self.assertEqual(CUSTOM.logo_url("https://a/module.png"), "https://a/module.png")
        self.assertEqual(CUSTOM.logo_url(""), LOGO)

    def test_hex_normalizing(self):
        self.assertEqual(email_theme.normalize_hex("#ABC"), "#aabbcc")
        self.assertEqual(email_theme.normalize_hex("#1D4ED8"), "#1d4ed8")
        for bad in ("red", "#12345", "1d4ed8", "#1d4ed8;background:url(x)", ""):
            self.assertIsNone(email_theme.normalize_hex(bad), bad)

    def test_a_broken_saved_value_falls_back_to_defaults(self):
        self.assertEqual(email_theme.Theme.from_dict({"accentColor": "javascript:1"}).accentColor,
                         email_theme.DEFAULT_ACCENT)
        self.assertEqual(email_theme.Theme.from_dict(None), email_theme.DEFAULT_THEME)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._prefix = items_router._STORAGE_PREFIX
        items_router._STORAGE_PREFIX = STORAGE
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.add(models.NexusRole(email=EMP, role="employee"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN)

    def tearDown(self):
        self._cleanup()
        items_router._STORAGE_PREFIX = self._prefix
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(
                models.NexusSetting.key == email_theme.SETTINGS_KEY).delete()
            db.query(models.NexusRole).filter(models.NexusRole.email.like("etheme.%")).delete(
                synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.like("etheme.%")).delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for e in (ADMIN, EMP):
            auth.invalidate_role_cache(e)
        cache.settings_config.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def test_defaults_before_anything_is_saved(self):
        r = self.client.get("/branding/email-theme")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["theme"], email_theme.DEFAULT_THEME.as_dict())
        self.assertTrue(any(s["id"] == "ticket" for s in r.json()["samples"]))

    def test_save_validates_audits_and_is_used_by_emails(self):
        r = self.client.put("/branding/email-theme", json=CUSTOM.as_dict())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(email_theme.get_saved().accentColor, "#1d4ed8")
        self.assertIn("#1d4ed8", email_theme_samples.render("ticket"))
        db = database.SessionLocal()
        try:
            row = (db.query(models.AuditLog).filter(models.AuditLog.user_email == ADMIN,
                                                    models.AuditLog.resource_type == "branding").first())
            self.assertIsNotNone(row)
            self.assertIn("accentColor", json.loads(row.details)["changed"])
        finally:
            db.close()

    def test_rejects_bad_color_and_logo(self):
        bad = [{"accentColor": "green"},
               {"logoUrl": "https://evil.example/logo.png"},
               {"logoUrl": STORAGE + "ticket-evidence/x.png"},
               {"footerText": "x" * (email_theme.FOOTER_MAX + 1)}]
        for body in bad:
            r = self.client.put("/branding/email-theme", json=body)
            self.assertEqual(r.status_code, 400, body)

    def test_preview_renders_without_saving(self):
        r = self.client.post("/branding/email-theme/preview",
                             json={**CUSTOM.as_dict(), "sample": "welcome"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("#1d4ed8", r.json()["html"])
        self.assertEqual(email_theme.get_saved(), email_theme.DEFAULT_THEME)
        self.assertEqual(self.client.post("/branding/email-theme/preview",
                                          json={"sample": "nope"}).status_code, 400)

    def test_employees_cannot_read_or_change_it(self):
        self._as(EMP)
        self.assertIn(self.client.get("/branding/email-theme").status_code, (401, 403))
        self.assertIn(self.client.put("/branding/email-theme", json={}).status_code, (401, 403))
        self.assertIn(self.client.post("/branding/email-theme/preview", json={}).status_code, (401, 403))
        self.assertIn(self.client.put("/branding/config", json={"accent": "blue"}).status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
