"""Import Hub bank statement rules (Charmi, 10/27 call item 01): listed,
added, changed and deleted through /accounting/import-hub/rules, shared by
the whole accounting team (the Accounting grant reads, its editor level
writes), with a plain reason for anything wrong.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_import_hub_rules.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import import_hub  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

VIEWER = "viewer.rules.test@greensglobal.com"     # accounting:viewer
EDITOR = "editor.rules.test@greensglobal.com"     # accounting:editor
EDITOR_2 = "editor2.rules.test@greensglobal.com"  # accounting:editor, another person
GROUP_V, GROUP_E = "grp-rules-test-viewer", "grp-rules-test-editor"
RULE = {"matchText": "  INTEREST   PAYMENT ", "matchType": "contains", "direction": "in", "amount": -200,
        "account": "40100", "accountName": "Interest Income", "priority": 10, "notes": "Monthly interest"}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class StatementRuleTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        try:
            db.query(import_hub.Rule).delete()
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_V, GROUP_E))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_V, GROUP_E))).delete(synchronize_session=False)
            db.add(models.NexusGroup(id=GROUP_V, name="Rules Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroup(id=GROUP_E, name="Rules Test Editors", allowed_modules="accounting:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.NexusGroupMember(group_id=GROUP_E, email=EDITOR))
            db.add(models.NexusGroupMember(group_id=GROUP_E, email=EDITOR_2))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        _as(EDITOR)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _rules(self):
        r = self.client.get("/accounting/import-hub/rules")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["rules"]

    def test_add_list_edit_delete(self):
        r = self.client.post("/accounting/import-hub/rules", json=RULE)
        self.assertEqual(r.status_code, 200, r.text)
        rule = r.json()
        # Spacing tidied, the amount kept as a positive figure to the cent.
        self.assertEqual((rule["matchText"], rule["amount"], rule["direction"]), ("INTEREST PAYMENT", 200.0, "in"))
        self.assertEqual(rule["createdBy"], EDITOR)
        r = self.client.post("/accounting/import-hub/rules", json={**RULE, "matchText": "WIRE TO", "direction": "out", "amount": None,
                                                                   "account": "60100", "vendorId": "V00037", "vendorName": "AAA Insurance", "priority": 5})
        self.assertEqual(r.status_code, 200, r.text)
        rules = self._rules()
        self.assertEqual([x["matchText"] for x in rules], ["WIRE TO", "INTEREST PAYMENT"])   # lower priority first
        self.assertEqual((rules[0]["vendorId"], rules[0]["amount"]), ("V00037", None))
        r = self.client.put(f"/accounting/import-hub/rules/{rule['id']}", json={**RULE, "account": "40200", "active": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["account"], r.json()["active"]), ("40200", False))
        self.assertEqual(self.client.delete(f"/accounting/import-hub/rules/{rule['id']}").status_code, 200)
        self.assertEqual([x["matchText"] for x in self._rules()], ["WIRE TO"])
        # Deleting again is harmless; editing a deleted rule says so.
        self.assertEqual(self.client.delete(f"/accounting/import-hub/rules/{rule['id']}").status_code, 200)
        r = self.client.put(f"/accounting/import-hub/rules/{rule['id']}", json=RULE)
        self.assertEqual(r.status_code, 404)
        self.assertIn("deleted", r.json()["detail"])

    def test_plain_reasons(self):
        for patch, words in (({"matchText": "   "}, "description holds"), ({"matchType": "regex"}, "Contains, Equals"),
                             ({"direction": "both"}, "Money In"), ({"account": ""}, "GL account"),
                             ({"account": "40 100; drop"}, "GL account"), ({"priority": 10000}, "0 to 9999"),
                             ({"vendorId": "V<1>"}, "vendor or customer")):
            r = self.client.post("/accounting/import-hub/rules", json={**RULE, **patch})
            self.assertEqual(r.status_code, 400, patch)
            self.assertIn(words, r.json()["detail"], patch)
        self.assertEqual(self._rules(), [])

    def test_shared_by_the_team_editors_change_them(self):
        self.assertEqual(self.client.post("/accounting/import-hub/rules", json=RULE).status_code, 200)
        # Another editor sees the same rule and may change it - rules are the team's, not one person's.
        _as(EDITOR_2)
        rule = self._rules()[0]
        r = self.client.put(f"/accounting/import-hub/rules/{rule['id']}", json={**RULE, "account": "40300"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["createdBy"], r.json()["updatedBy"]), (EDITOR, EDITOR_2))
        # A viewer reads them but cannot add, change or delete.
        _as(VIEWER)
        self.assertEqual([x["account"] for x in self._rules()], ["40300"])
        self.assertEqual(self.client.post("/accounting/import-hub/rules", json=RULE).status_code, 403)
        self.assertEqual(self.client.put(f"/accounting/import-hub/rules/{rule['id']}", json=RULE).status_code, 403)
        self.assertEqual(self.client.delete(f"/accounting/import-hub/rules/{rule['id']}").status_code, 403)
        self.assertEqual(len(self._rules()), 1)


if __name__ == "__main__":
    unittest.main()
