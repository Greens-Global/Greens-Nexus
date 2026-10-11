"""Site Models router - the customer view must never leak occupancy, and the
model directory must list the Escondido model. Pure functions, no database."""
import unittest

from routers import site_models


class SiteModelTests(unittest.TestCase):
    def test_escondido_model_lists_and_loads(self):
        ids = [m["id"] for m in site_models.list_models()]
        self.assertIn("greens-storage-escondido", ids)
        model = site_models.load_model("greens-storage-escondido")
        self.assertEqual(len(model["units"]), 884)
        self.assertTrue(all("u" in u and "v" in u and "f" in u for u in model["units"]))
        names = {u["n"] for u in model["units"]}
        self.assertIn("C214", names)
        self.assertIn("G012", names)

    def test_public_view_strips_occupancy(self):
        pub = site_models.public_view(site_models.load_model("greens-storage-escondido"))
        for u in pub["units"]:
            for secret in ("l", "r", "why", "note", "dvac"):
                self.assertNotIn(secret, u)
        self.assertNotIn("flags", pub["layout"])
        self.assertNotIn("cubbyFacilityId", pub["property"])
        self.assertNotIn("apn", pub["property"])
        for b in pub["buildings"]:
            self.assertNotIn("note", b)
            self.assertNotIn("inferred", b)
            self.assertNotIn("ll", b)
        self.assertEqual(len(pub["units"]), 884)
        self.assertTrue(pub["buildings"] and pub["parcel"] and pub["gates"])

    def test_bad_ids_are_404(self):
        from fastapi import HTTPException
        for bad in ("../main", "GREENS", "", "nope-nope"):
            with self.assertRaises(HTTPException):
                site_models.load_model(bad)


if __name__ == "__main__":
    unittest.main()
