"""Entra writes (profile writeback / Push to Entra / two-way sync push) are
prod-only: dev and prod share one tenant, so dev's test profiles must never
reach the real directory (09/09/2026: two syncs from dev.nexus rewrote 55
people's titles). Pull stays allowed everywhere."""
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_DEV_EMAIL", "tester@greensglobal.com")

from routers.hr import _entra_writes_enabled  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("NEXUS_ENTRA_WRITEBACK", raising=False)
    monkeypatch.delenv("WEBSITE_SITE_NAME", raising=False)


def test_localhost_never_writes():
    assert _entra_writes_enabled() is False


def test_dev_site_never_writes(monkeypatch):
    monkeypatch.setenv("WEBSITE_SITE_NAME", "greens-nexus-api-dev-a6fad4brawevg8de")
    assert _entra_writes_enabled() is False


def test_prod_site_writes(monkeypatch):
    monkeypatch.setenv("WEBSITE_SITE_NAME", "greens-nexus-api-ejfxdjcbevfxb2ht")
    assert _entra_writes_enabled() is True


def test_prod_staging_slot_still_writes(monkeypatch):
    # Slot warm-up can suffix the site name (see app_url.py) - still prod.
    monkeypatch.setenv("WEBSITE_SITE_NAME", "greens-nexus-api-ejfxdjcbevfxb2ht__staging")
    assert _entra_writes_enabled() is True


def test_explicit_flag_overrides_both_ways(monkeypatch):
    monkeypatch.setenv("NEXUS_ENTRA_WRITEBACK", "true")
    assert _entra_writes_enabled() is True          # localhost, forced on
    monkeypatch.setenv("WEBSITE_SITE_NAME", "greens-nexus-api-ejfxdjcbevfxb2ht")
    monkeypatch.setenv("NEXUS_ENTRA_WRITEBACK", "false")
    assert _entra_writes_enabled() is False         # prod, forced off (rollback lever)


def test_nightly_pushback_skips_when_writes_off(monkeypatch):
    # reminders.run_m365_pushback must bail before touching Graph or the DB.
    import reminders
    monkeypatch.setenv("WEBSITE_SITE_NAME", "greens-nexus-api-dev-a6fad4brawevg8de")
    monkeypatch.setattr("routers.hr._graph_token",
                        lambda: (_ for _ in ()).throw(AssertionError("Graph must not be called")))
    assert reminders.run_m365_pushback() == {"pushed": 0, "failed": 0, "skipped": True}
