"""Task table preferences - the per-user column arrangement API.

Covers the shape guarantees the client relies on: that a width save never
wipes the order the user just dragged, that junk is dropped rather than
stored, and that "restore defaults" means what it says at both scopes.

Uses a throwaway sqlite file. Run with: python -m unittest test_task_prefs
"""
import os, tempfile, unittest
_t = tempfile.NamedTemporaryFile(suffix=".db", delete=False); _t.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_t.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar.shoundik@greensglobal.com"
from fastapi.testclient import TestClient
import database, models
import main
models.Base.metadata.create_all(bind=database.engine)
c = TestClient(main.app)

class T(unittest.TestCase):
    def test_empty_until_arranged(self):
        c.delete("/task-prefs")
        r = c.get("/task-prefs"); self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["prefs"], {})

    def test_order_round_trips(self):
        c.delete("/task-prefs")
        r = c.put("/task-prefs/richlist", json={"order": ["status", "task", "due"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.get("/task-prefs").json()["prefs"]["richlist"]["order"], ["status", "task", "due"])

    def test_width_save_does_not_wipe_order(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/richlist", json={"order": ["status", "task"]})
        c.put("/task-prefs/richlist", json={"widths": {"task": 300}})
        got = c.get("/task-prefs").json()["prefs"]["richlist"]
        self.assertEqual(got["order"], ["status", "task"])
        self.assertEqual(got["widths"], {"task": 300})

    def test_duplicates_and_junk_are_dropped(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/richlist", json={"order": ["task", "task", "", "  ", "due"],
                                            "widths": {"task": 5, "due": 99999, "ok": 150}})
        got = c.get("/task-prefs").json()["prefs"]["richlist"]
        self.assertEqual(got["order"], ["task", "due"])
        self.assertEqual(got["widths"], {"ok": 150})   # 5 too small, 99999 too large

    def test_reset_one_table_leaves_the_others(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/richlist", json={"order": ["task"]})
        c.put("/task-prefs/projects", json={"order": ["name"]})
        c.delete("/task-prefs/richlist")
        prefs = c.get("/task-prefs").json()["prefs"]
        self.assertNotIn("richlist", prefs)
        self.assertIn("projects", prefs)

    def test_reset_all(self):
        c.put("/task-prefs/richlist", json={"order": ["task"]})
        c.put("/task-prefs/projects", json={"order": ["name"]})
        self.assertEqual(c.delete("/task-prefs").json()["prefs"], {})
        self.assertEqual(c.get("/task-prefs").json()["prefs"], {})

    def test_hidden_and_collapsed_round_trip(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/richlist", json={"hidden": ["estimate", "actual"],
                                            "collapsed": ["completed"]})
        got = c.get("/task-prefs").json()["prefs"]["richlist"]
        self.assertEqual(got["hidden"], ["estimate", "actual"])
        self.assertEqual(got["collapsed"], ["completed"])

    def test_an_empty_list_is_stored_not_treated_as_unset(self):
        # Re-opening a section that ships collapsed by default writes [], and
        # that has to survive - otherwise it reads back as "use the default"
        # and the section closes itself again on the next visit.
        c.delete("/task-prefs")
        c.put("/task-prefs/richlist", json={"collapsed": ["completed"]})
        c.put("/task-prefs/richlist", json={"collapsed": []})
        got = c.get("/task-prefs").json()["prefs"]["richlist"]
        self.assertEqual(got["collapsed"], [])

    def test_hidden_does_not_wipe_order_or_widths(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/richlist", json={"order": ["task"], "widths": {"task": 300}})
        c.put("/task-prefs/richlist", json={"hidden": ["team"]})
        got = c.get("/task-prefs").json()["prefs"]["richlist"]
        self.assertEqual(got["order"], ["task"])
        self.assertEqual(got["widths"], {"task": 300})
        self.assertEqual(got["hidden"], ["team"])

    def test_view_group_and_sort_round_trip(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/mytasks", json={"view": "board", "group": "priority",
                                           "sort": {"key": "dueOn", "dir": "desc"}})
        got = c.get("/task-prefs").json()["prefs"]["mytasks"]
        self.assertEqual(got["view"], "board")
        self.assertEqual(got["group"], "priority")
        self.assertEqual(got["sort"], {"key": "dueOn", "dir": "desc"})

    def test_a_bad_sort_direction_is_dropped_not_stored(self):
        c.delete("/task-prefs")
        c.put("/task-prefs/mytasks", json={"sort": {"key": "dueOn", "dir": "sideways"}})
        self.assertNotIn("sort", c.get("/task-prefs").json()["prefs"].get("mytasks", {}))

    def test_rejects_a_blank_table_id(self):
        self.assertEqual(c.put("/task-prefs/%20", json={"order": ["a"]}).status_code, 400)

if __name__ == "__main__":
    unittest.main(verbosity=2)
