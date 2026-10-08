"""Documents "Import from Egnyte" (GET /documents/egnyte/browse and /file) -
Sep 30 review.

Both routes read with the Egnyte SERVICE token. They used to take any absolute
path from any signed-in employee: the whole domain, other people's private
folders included. Now they take the Documents screen's own access
(administrator+, or a Documents grant) and only reach paths under the configured import roots
(wiring slot documents.import-roots / EGNYTE_IMPORT_ROOTS, default /Shared).

Run with: python -m pytest test_documents_egnyte_access.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import auth
import database
import models
from routers import documents as D

EMPLOYEE = {"email": "dean@greensglobal.com", "level": 1}
SUPERVISOR = {"email": "sam@greensglobal.com", "level": 2}
ADMIN = {"email": "ada@greensglobal.com", "level": 4}

_LISTING = {"path": "", "description": "", "folders": [], "files": []}


class EgnyteImportAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        patches = [
            mock.patch.object(D.egnyte_svc, "configured", return_value=True),
            mock.patch.object(D.egnyte_svc, "list_folder", side_effect=lambda p: dict(_LISTING, path=p)),
            mock.patch.object(D.egnyte_svc, "read_file", return_value=b"bytes"),
            mock.patch.dict(os.environ, {"EGNYTE_IMPORT_ROOTS": "/Shared/Templates,/Shared/#Entities"}),
        ]
        for p in patches:
            self.mocks = getattr(self, "mocks", []) + [p.start()]
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.close()

    def _status(self, fn, *a):
        with self.assertRaises(HTTPException) as e:
            fn(*a)
        return e.exception.status_code

    # -- who ---------------------------------------------------------------
    def test_both_routes_take_the_documents_screen_access(self):
        for path in ("/documents/egnyte/browse", "/documents/egnyte/file"):
            route = next(r for r in D.router.routes if getattr(r, "path", "") == path)
            deps = [d.call for d in route.dependant.dependencies]
            self.assertIn(D._require_documents_access, deps, path)

    def test_without_a_documents_grant_is_refused_even_a_supervisor(self):
        # App.jsx shows Documents below administrator only through a grant.
        with mock.patch.object(auth, "_module_level", return_value=0):
            self.assertEqual(self._status(D._require_documents_access, EMPLOYEE, self.db), 403)
            self.assertEqual(self._status(D._require_documents_access, SUPERVISOR, self.db), 403)

    def test_a_documents_grant_or_an_administrator_is_admitted(self):
        with mock.patch.object(auth, "_module_level", return_value=1):
            self.assertEqual(D._require_documents_access(user=EMPLOYEE, db=self.db), EMPLOYEE)
        with mock.patch.object(auth, "_module_level", return_value=0):
            self.assertEqual(D._require_documents_access(user=ADMIN, db=self.db), ADMIN)

    # -- where -------------------------------------------------------------
    def test_the_domain_root_lists_only_the_import_roots(self):
        data = D.egnyte_browse(path="", user=SUPERVISOR)
        self.assertEqual([f["path"] for f in data["folders"]], ["/Shared/Templates", "/Shared/#Entities"])
        self.assertEqual(data["files"], [])
        D.egnyte_svc.list_folder.assert_not_called()

    def test_a_folder_above_a_root_also_shows_the_roots(self):
        # The picker's breadcrumb lets you click "Shared".
        data = D.egnyte_browse(path="Shared", user=SUPERVISOR)
        self.assertEqual(len(data["folders"]), 2)
        D.egnyte_svc.list_folder.assert_not_called()

    def test_inside_a_root_browses_normally(self):
        data = D.egnyte_browse(path="Shared/Templates/HR/", user=SUPERVISOR)
        self.assertEqual(data["path"], "/Shared/Templates/HR")

    def test_outside_every_root_is_refused(self):
        for p in ("/Private/neil", "/Shared/Finance", "/Shared/TemplatesX"):
            self.assertEqual(self._status(D.egnyte_browse, p, SUPERVISOR), 403, p)
        D.egnyte_svc.list_folder.assert_not_called()

    def test_dot_dot_cannot_walk_out_of_a_root(self):
        for p in ("/Shared/Templates/../../Private/neil", "/Shared/Templates/./x/.."):
            self.assertEqual(self._status(D.egnyte_browse, p, SUPERVISOR), 400, p)
        self.assertEqual(self._status(D.egnyte_file, "/Shared/Templates/../Finance/pay.pdf", SUPERVISOR), 400)

    def test_files_only_from_inside_a_root(self):
        D.egnyte_file(path="/Shared/Templates/offer.docx", user=SUPERVISOR)
        D.egnyte_svc.read_file.assert_called_once_with("/Shared/Templates/offer.docx")
        self.assertEqual(self._status(D.egnyte_file, "/Private/neil/salary.pdf", SUPERVISOR), 403)

    def test_the_default_root_is_shared_never_the_domain_root(self):
        with mock.patch.dict(os.environ, {"EGNYTE_IMPORT_ROOTS": "/"}):
            self.assertEqual(D._egnyte_import_roots(), ["/Shared"])
        with mock.patch.dict(os.environ, {"EGNYTE_IMPORT_ROOTS": ""}):
            self.assertEqual(D._egnyte_import_roots(), ["/Shared"])


if __name__ == "__main__":
    unittest.main()
