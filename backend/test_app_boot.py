"""App-boot + router-import smoke test.

Catches the backend equivalent of a runtime crash: an import error, a syntax
slip in a router, or a startup/migration failure - none of which `ruff` alone
would flag. If the app can't import, boot, and serve /health, this fails.

    python -m unittest test_app_boot
"""
import importlib
import os
import pkgutil
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")


class TestAppBoot(unittest.TestCase):
    def test_app_imports(self):
        import main
        from fastapi.routing import APIRoute
        routes = [r for r in main.app.routes if isinstance(r, APIRoute)]
        self.assertGreater(len(routes), 100, "far fewer routes than expected - a router failed to register")

    def test_lifespan_and_health(self):
        import main
        from fastapi.testclient import TestClient
        # The context manager runs the lifespan (startup migrations). A failed
        # migration or startup task throws here.
        with TestClient(main.app) as client:
            self.assertEqual(client.get("/health").status_code, 200)
            self.assertEqual(client.get("/version").status_code, 200)

    def test_every_router_module_imports(self):
        """Import each routers/*.py explicitly - a syntax/import error in a
        router that main.py happens to import lazily would otherwise slip by."""
        import routers
        failed = []
        for mod in pkgutil.iter_modules(routers.__path__):
            if mod.name.startswith("_"):
                continue
            try:
                importlib.import_module(f"routers.{mod.name}")
            except Exception as e:  # noqa: BLE001 - we want the name + reason
                failed.append(f"{mod.name}: {type(e).__name__}: {e}")
        self.assertEqual(failed, [], f"router import failures: {failed}")


if __name__ == "__main__":
    unittest.main()
