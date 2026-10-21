"""The asset workspace save (PUT /property-assets/workspace), one file per
process like every backend test: the stale guard, the wipe guard, the
activity-log cap. Run: .venv/bin/python -m pytest test_property_assets.py"""
import os
import tempfile
import unittest

from fastapi import HTTPException

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database                                       # noqa: E402
import models                                         # noqa: E402
from routers import property_assets as PA             # noqa: E402

ADMIN = {"email": "neil@greensglobal.com", "role": "administrator", "level": 4}
STAFF = {"email": "amy@greensglobal.com", "role": "employee", "level": 2}


def ws(props, logs=None, base_ts=None):
    return PA.Workspace(properties=props, logs=logs or [], baseTs=base_ts)


class WorkspaceSaveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog, models.PropertyWorkspaceMeta):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _save(self, props, **kw):
        return PA.put_workspace(ws(props, **kw), db=self.db, user=ADMIN)

    def test_first_save_lands_and_stamps_a_server_ts(self):
        out = self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}])
        self.assertEqual(out["properties"], 2)
        self.assertGreater(out["_ts"], 0)
        self.assertEqual(PA.get_workspace(db=self.db, user=ADMIN)["_ts"], out["_ts"])

    def test_a_stale_copy_is_refused(self):
        first = self._save([{"id": "a", "name": "A"}])["_ts"]
        with self.assertRaises(HTTPException) as cm:
            self._save([{"id": "a", "name": "A (old tab)"}], base_ts=first - 1)
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn("stale", cm.exception.detail)
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A")

    def test_a_copy_without_a_base_ts_is_stale_too(self):
        """Every client sends baseTs now; one that does not predates the guard and
        must pull before it may replace a populated portfolio."""
        self._save([{"id": "a", "name": "A"}])
        with self.assertRaises(HTTPException) as cm:
            self._save([{"id": "a", "name": "A (legacy)"}], base_ts=None)
        self.assertEqual(cm.exception.status_code, 409)

    def test_a_current_copy_saves(self):
        first = self._save([{"id": "a", "name": "A"}])["_ts"]
        out = self._save([{"id": "a", "name": "A2"}], base_ts=first)
        self.assertGreaterEqual(out["_ts"], first)
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A2")

    def test_an_empty_copy_never_wipes_a_portfolio(self):
        first = self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}])["_ts"]
        with self.assertRaises(HTTPException) as cm:
            self._save([], base_ts=first)
        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(self.db.query(models.PropertyAsset).count(), 2)

    def test_the_activity_log_is_kept_whole_and_the_workspace_carries_the_newest(self):
        logs = [{"id": f"l{i}", "propertyId": "a", "ts": f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z", "action": "edited"} for i in range(PA.LOG_CAP_PER_ASSET + 40)]
        logs += [{"id": "other", "propertyId": "b", "ts": "2025-01-01T00:00:00Z", "action": "added"}]
        first = self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], logs=logs)
        # Nothing is ever trimmed from the database...
        kept = self.db.query(models.PropertyActivityLog).filter(models.PropertyActivityLog.property_id == "a").all()
        self.assertEqual(len(kept), PA.LOG_CAP_PER_ASSET + 40)
        # ...a second blob save with fewer entries removes none of them...
        self._save([{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], logs=logs[:3], base_ts=first["_ts"])
        self.assertEqual(self.db.query(models.PropertyActivityLog).count(), PA.LOG_CAP_PER_ASSET + 41)
        # ...and the workspace carries the newest LOG_CAP_PER_ASSET per asset.
        ws_logs = PA.get_workspace(db=self.db, user=ADMIN)["logs"]
        ids_a = {l["id"] for l in ws_logs if l.get("propertyId") == "a"}
        self.assertEqual(len(ids_a), PA.LOG_CAP_PER_ASSET)
        self.assertIn(f"l{PA.LOG_CAP_PER_ASSET + 39}", ids_a)     # the newest is there
        self.assertNotIn("l0", ids_a)                               # the oldest is not sent
        self.assertEqual(len([l for l in ws_logs if l.get("propertyId") == "b"]), 1)



class FileUrlTests(unittest.TestCase):
    """With storage configured, a photo or document must be an asset-files URL;
    a data: URL the server already holds is tolerated (still migrating), a new
    one is refused; with no storage configured anything goes."""
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog, models.PropertyWorkspaceMeta):
            self.db.query(m).delete()
        self.db.commit()
        self._prefix = PA._FILES_PREFIX
        PA._FILES_PREFIX = "https://proj.supabase.co/storage/v1/object/public/asset-files/"

    def tearDown(self):
        PA._FILES_PREFIX = self._prefix
        self.db.rollback()
        self.db.close()

    def _save(self, props, records=None, base_ts=None):
        w = PA.Workspace(properties=props, warranties=records or [], baseTs=base_ts)
        return PA.put_workspace(w, db=self.db, user=ADMIN)

    def test_a_bucket_url_is_accepted(self):
        self._save([{"id": "a", "name": "A", "image": PA._FILES_PREFIX + "photos/a/1.jpg", "images": [PA._FILES_PREFIX + "photos/a/1.jpg"]}],
                   [{"id": "w1", "propertyId": "a", "docFile": PA._FILES_PREFIX + "documents/a/2.pdf"}])
        self.assertEqual(self.db.query(models.PropertyRecord).count(), 1)

    def test_a_new_data_url_is_refused(self):
        with self.assertRaises(HTTPException) as cm:
            self._save([{"id": "a", "name": "A", "image": "data:image/png;base64,AAAA"}])
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("A", cm.exception.detail)
        with self.assertRaises(HTTPException):
            self._save([{"id": "a", "name": "A"}], [{"id": "w1", "propertyId": "a", "docFile": "data:application/pdf;base64,AAAA"}])

    def test_a_data_url_the_server_already_holds_is_tolerated(self):
        PA._FILES_PREFIX = ""                                   # stored before storage existed
        ts = self._save([{"id": "a", "name": "A", "image": "data:image/png;base64,OLD"}])["_ts"]
        PA._FILES_PREFIX = "https://proj.supabase.co/storage/v1/object/public/asset-files/"
        self._save([{"id": "a", "name": "A renamed", "image": "data:image/png;base64,OLD"}], base_ts=ts)
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A renamed")

    def test_a_foreign_url_is_left_alone(self):
        # A legacy /assets path or an outside link is a link, not an upload:
        # refusing it would make the row unsaveable until someone re-uploads.
        self._save([{"id": "a", "name": "A", "image": "/assets/properties/a.jpg"}],
                   [{"id": "w1", "propertyId": "a", "docFile": "https://elsewhere.example/x.pdf"}])
        self.assertEqual(self.db.get(models.PropertyAsset, "a").payload["image"], "/assets/properties/a.jpg")

    def test_without_storage_anything_goes(self):
        PA._FILES_PREFIX = ""
        self._save([{"id": "a", "name": "A", "image": "data:image/png;base64,AAAA"}])
        self.assertEqual(self.db.query(models.PropertyAsset).count(), 1)


class MigrationTests(unittest.TestCase):
    """asset_files_migrate moves every data: URL and leaves the rest alone."""
    def test_rows_move_and_the_image_pointer_follows(self):
        import asset_files_migrate as M
        uploaded = []
        M._upload = lambda path, raw, ct: (uploaded.append((path, raw, ct)) or f"https://x/storage/v1/object/public/asset-files/{path}")
        payload = {"image": "data:image/png;base64,QUJD", "images": ["data:image/png;base64,QUJD", "https://x/storage/v1/object/public/asset-files/photos/a/kept.jpg"]}
        self.assertTrue(M._migrate_row(payload, M.PROPERTY_FILE_FIELDS, "photos", "a"))
        self.assertEqual(len(uploaded), 2)
        self.assertEqual(uploaded[0][1], b"ABC")
        self.assertTrue(payload["image"].startswith("https://x/storage/v1/object/public/asset-files/photos/a/migrated-"))
        self.assertTrue(payload["images"][0].startswith("https://x/"))
        self.assertTrue(payload["images"][1].endswith("kept.jpg"))
        self.assertFalse(M._migrate_row({"image": "https://x/already.jpg"}, M.PROPERTY_FILE_FIELDS, "photos", "a"))
        none_image = {"image": None, "images": ["data:image/png;base64,QUJD"]}
        self.assertTrue(M._migrate_row(none_image, M.PROPERTY_FILE_FIELDS, "photos", "a"))   # a null image does not crash
        self.assertTrue(none_image["image"].startswith("https://"))


class RowSaveTests(unittest.TestCase):
    """POST /property-assets/changes: rows are written one by one, a stale row
    is reported not overwritten, private assets are officers' alone, scope rows
    narrow what a person reads and writes."""
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog, models.PropertyWorkspaceMeta, models.NexusAccessScope):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _changes(self, user=ADMIN, **kw):
        return PA.post_changes(PA.Changes(**kw), db=self.db, user=user)

    def _get(self, user=ADMIN):
        return PA.get_workspace(db=self.db, user=user)

    def test_rows_are_written_on_their_own(self):
        out = self._changes(properties={"upsert": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
                            warranties={"upsert": [{"id": "w1", "propertyId": "a", "item": "Roof"}]},
                            logs={"append": [{"id": "l1", "propertyId": "a", "ts": "2026-10-21T10:00:00Z", "action": "added"}]})
        self.assertEqual(out["conflicts"], [])
        self.assertGreater(out["_ts"], 0)
        self.assertEqual(set(out["revs"]), {"a", "b", "w1"})
        self._changes(properties={"upsert": [{"id": "b", "name": "B2", "_rev": out["revs"]["b"]}]})     # touching B leaves A alone
        ws = self._get()
        self.assertEqual({p["id"]: p["name"] for p in ws["properties"]}, {"a": "A", "b": "B2"})
        self.assertEqual(ws["warranties"][0]["item"], "Roof")
        self.assertTrue(all("_rev" in p for p in ws["properties"]))
        self._changes(warranties={"delete": ["w1"], "deleteRevs": {"w1": out["revs"]["w1"]}})
        self.assertEqual(self._get()["warranties"], [])

    def test_a_stale_row_is_reported_not_overwritten(self):
        self._changes(properties={"upsert": [{"id": "a", "name": "A"}]})
        rev = self._get()["properties"][0]["_rev"]
        out1 = self._changes(properties={"upsert": [{"id": "a", "name": "A by Neil", "_rev": rev}]})
        # the same tab's next edit carries the rev it was just handed, and lands
        self._changes(properties={"upsert": [{"id": "a", "name": "A by Neil, again", "_rev": out1["revs"]["a"]}]})
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A by Neil, again")
        out = self._changes(properties={"upsert": [{"id": "a", "name": "A by an old tab", "_rev": rev}]})
        self.assertEqual(out["conflicts"], ["a"])
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A by Neil, again")
        out = self._changes(properties={"upsert": [{"id": "a", "name": "A again"}]})   # no rev at all = a cached copy
        self.assertEqual(out["conflicts"], ["a"])
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A by Neil, again")

    def test_private_assets_are_officers_alone(self):
        self._changes(properties={"upsert": [{"id": "home", "name": "Residence", "private": True}, {"id": "gs", "name": "GS"}]},
                      warranties={"upsert": [{"id": "w1", "propertyId": "home", "item": "Roof"}]},
                      logs={"append": [{"id": "l1", "propertyId": "home", "ts": "2026-10-21T10:00:00Z", "action": "edited"}]})
        staff = self._get(STAFF)
        self.assertEqual([p["id"] for p in staff["properties"]], ["gs"])
        self.assertEqual(staff["warranties"], [])
        self.assertEqual(staff["logs"], [])
        self.assertEqual([p["id"] for p in self._get()["properties"]], ["home", "gs"])
        with self.assertRaises(HTTPException) as cm:
            self._changes(STAFF, properties={"upsert": [{"id": "home", "name": "Residence (edited)"}]})
        self.assertEqual(cm.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            self._changes(STAFF, warranties={"upsert": [{"id": "w2", "propertyId": "home", "item": "Gate"}]})
        with self.assertRaises(HTTPException):
            self._changes(STAFF, properties={"delete": ["home"]})
        with self.assertRaises(HTTPException) as cm:                      # only an officer flips the flag
            self._changes(STAFF, properties={"upsert": [{"id": "gs", "name": "GS", "private": True}]})
        self.assertEqual(cm.exception.status_code, 403)
        gs_rev = [p for p in staff["properties"] if p["id"] == "gs"][0]["_rev"]
        self._changes(STAFF, properties={"upsert": [{"id": "gs", "name": "GS (staff edit)", "_rev": gs_rev}]})
        self.assertEqual(self.db.get(models.PropertyAsset, "gs").name, "GS (staff edit)")

    def test_scope_rows_narrow_a_person(self):
        import uuid
        self._changes(properties={"upsert": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]})
        self.db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=STAFF["email"], module_id="property-asset", scope_type="property", scope_id="a"))
        self.db.commit()
        self.assertEqual([p["id"] for p in self._get(STAFF)["properties"]], ["a"])
        with self.assertRaises(HTTPException) as cm:
            self._changes(STAFF, properties={"upsert": [{"id": "b", "name": "B!"}]})
        self.assertEqual(cm.exception.status_code, 403)
        a_rev = self._get(STAFF)["properties"][0]["_rev"]
        self._changes(STAFF, properties={"upsert": [{"id": "a", "name": "A!", "_rev": a_rev}]})
        self.assertEqual(self.db.get(models.PropertyAsset, "a").name, "A!")

    def test_a_conflicted_change_leaves_no_log_entry_and_undone_persists(self):
        out = self._changes(properties={"upsert": [{"id": "a", "name": "A"}]},
                            logs={"append": [{"id": "l1", "propertyId": "a", "ts": "2026-10-21T10:00:00Z", "action": "added"}]})
        stale = self._changes(properties={"upsert": [{"id": "a", "name": "A (stale)", "_rev": "old"}]},
                              logs={"append": [{"id": "l2", "propertyId": "a", "ts": "2026-10-21T10:01:00Z", "action": "edited"}]})
        self.assertEqual(stale["conflicts"], ["a"])
        self.assertIsNone(self.db.get(models.PropertyActivityLog, "l2"))     # nothing landed, nothing logged
        self._changes(logs={"update": [{"id": "l1", "undone": True}]})
        self.assertTrue(self.db.get(models.PropertyActivityLog, "l1").payload["undone"])
        del out

    def test_what_the_server_did_to_a_row_travels_with_the_tabs_next_save(self):
        prefix = "https://proj.supabase.co/storage/v1/object/public/asset-files/"
        saved = PA._FILES_PREFIX
        PA._FILES_PREFIX = ""
        try:
            out = self._changes(properties={"upsert": [{"id": "a", "name": "A", "address": "1 Main St", "city": "Austin", "state": "TX",
                                                        "image": "data:image/png;base64,OLD", "images": ["data:image/png;base64,OLD"]}]})
            # the migration moved the photo and the geocoder placed the pin while a tab held the row
            row = self.db.get(models.PropertyAsset, "a")
            row.payload = {**row.payload, "image": prefix + "photos/a/1.jpg", "images": [prefix + "photos/a/1.jpg"],
                           "geo": {"lat": 1.0, "lng": 2.0, "for": PA.address_of(row.payload) if hasattr(PA, "address_of") else "1 Main St, Austin, TX"}}
            self.db.commit()
            PA._FILES_PREFIX = prefix
            from asset_geocode import address_of
            row = self.db.get(models.PropertyAsset, "a")
            row.payload = {**row.payload, "geo": {**row.payload["geo"], "for": address_of(row.payload)}}
            self.db.commit()
            # the tab's next save still carries the data: URL and no geo - neither is undone
            self._changes(properties={"upsert": [{"id": "a", "name": "A renamed", "address": "1 Main St", "city": "Austin", "state": "TX",
                                                  "image": "data:image/png;base64,OLD", "images": ["data:image/png;base64,OLD"], "_rev": out["revs"]["a"]}]})
            got = self.db.get(models.PropertyAsset, "a").payload
            self.assertEqual(got["name"], "A renamed")
            self.assertEqual(got["image"], prefix + "photos/a/1.jpg")
            self.assertEqual(got["images"], [prefix + "photos/a/1.jpg"])
            self.assertEqual(got["geo"]["lat"], 1.0)
        finally:
            PA._FILES_PREFIX = saved

    def test_a_viewer_cannot_save_rows(self):
        from fastapi import Request
        viewer = {"email": "vic@greensglobal.com", "role": "employee", "level": 1}
        from auth import require_module_grant
        with self.assertRaises(HTTPException) as cm:
            require_module_grant("property-asset", "editor")(user=viewer, db=self.db)   # the route's dependency
        self.assertEqual(cm.exception.status_code, 403)
        del Request

    def test_a_record_cannot_be_moved_off_an_asset_outside_reach(self):
        import uuid
        self._changes(properties={"upsert": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
                      warranties={"upsert": [{"id": "w1", "propertyId": "b", "item": "Roof"}]})
        self.db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=STAFF["email"], module_id="property-asset", scope_type="property", scope_id="a"))
        self.db.commit()
        with self.assertRaises(HTTPException) as cm:
            self._changes(STAFF, warranties={"upsert": [{"id": "w1", "propertyId": "a", "item": "Roof (taken)"}]})
        self.assertEqual(cm.exception.status_code, 403)

    def test_the_whole_portfolio_replace_is_an_officers_tool(self):
        with self.assertRaises(HTTPException) as cm:
            PA.put_workspace(PA.Workspace(properties=[{"id": "a", "name": "A"}]), db=self.db, user=STAFF)
        self.assertEqual(cm.exception.status_code, 403)

    def test_deleting_a_property_takes_its_rows_and_the_log_is_kept_whole(self):
        self._changes(properties={"upsert": [{"id": "a", "name": "A"}]},
                      inspections={"upsert": [{"id": "i1", "propertyId": "a", "type": "Fire"}]},
                      logs={"append": [{"id": f"l{i}", "propertyId": "a", "ts": f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z"} for i in range(PA.LOG_CAP_PER_ASSET + 10)]})
        self.assertEqual(self.db.query(models.PropertyActivityLog).count(), PA.LOG_CAP_PER_ASSET + 10)   # never trimmed
        rev = self._get()["properties"][0]["_rev"]
        # Delete Forever on a LIVE asset only moves it to the Trash...
        out = self._changes(properties={"delete": ["a"], "deleteRevs": {"a": rev}})
        self.assertTrue(self.db.get(models.PropertyAsset, "a").payload["deleted"])
        self.assertEqual(self.db.query(models.PropertyRecord).count(), 1)
        # ...a wrong rev is a conflict...
        self.assertEqual(self._changes(properties={"delete": ["a"], "deleteRevs": {"a": rev}})["conflicts"], ["a"])
        # ...and from the Trash it goes, with its records - the log is history and stays.
        self._changes(properties={"delete": ["a"], "deleteRevs": {"a": out["revs"]["a"]}})
        self.assertIsNone(self.db.get(models.PropertyAsset, "a"))
        self.assertEqual(self.db.query(models.PropertyRecord).count(), 0)
        self.assertEqual(self.db.query(models.PropertyActivityLog).count(), PA.LOG_CAP_PER_ASSET + 10)


class GeocodeTests(unittest.TestCase):
    """asset_geocode: one lookup per address, a miss remembered, a private asset
    never sent out, a changed address looked up again."""
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog, models.PropertyWorkspaceMeta):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_addresses_get_a_point_once(self):
        import asset_geocode as G
        PA.post_changes(PA.Changes(properties={"upsert": [
            {"id": "a", "name": "A", "address": "25260 N Centre City Pkwy", "city": "Escondido", "state": "CA"},
            {"id": "nowhere", "name": "N", "address": "1 Nowhere Rd", "city": "Atlantis"},
            {"id": "home", "name": "Residence", "address": "1 Private Ln", "city": "San Clemente", "private": True},
            {"id": "noaddr", "name": "No address"},
        ]}), db=self.db, user=ADMIN)
        asked = []
        def fetch(q):
            asked.append(q)
            return (33.17, -117.09) if q.startswith("25260") else None
        n = G.geocode_pending(self.db, fetch=fetch, pace=lambda: None)
        self.assertEqual(n, 2)
        self.assertEqual(asked, ["25260 N Centre City Pkwy, Escondido, CA", "1 Nowhere Rd, Atlantis"])   # never the private one
        a = self.db.get(models.PropertyAsset, "a").payload["geo"]
        self.assertEqual((a["lat"], a["lng"], a["for"]), (33.17, -117.09, "25260 N Centre City Pkwy, Escondido, CA"))
        self.assertIsNone(self.db.get(models.PropertyAsset, "nowhere").payload["geo"]["lat"])
        self.assertNotIn("geo", self.db.get(models.PropertyAsset, "home").payload)
        self.assertGreater(self.db.get(models.PropertyWorkspaceMeta, 1).ts, 0)
        # a second pass asks nothing: the hit is kept, the miss is remembered
        asked.clear()
        self.assertEqual(G.geocode_pending(self.db, fetch=fetch, pace=lambda: None), 0)
        self.assertEqual(asked, [])
        # the address changes -> looked up again
        row = self.db.get(models.PropertyAsset, "a")
        row.payload = {**row.payload, "address": "100 Main St"}
        self.db.commit()
        self.assertEqual(G.geocode_pending(self.db, fetch=fetch, pace=lambda: None), 1)
        self.assertEqual(asked, ["100 Main St, Escondido, CA"])

    def test_a_service_error_stops_the_pass_not_the_loop(self):
        import asset_geocode as G
        PA.post_changes(PA.Changes(properties={"upsert": [{"id": "a", "name": "A", "address": "1 Main St", "city": "Austin", "state": "TX"}]}), db=self.db, user=ADMIN)
        def fetch(q):
            raise RuntimeError("nominatim 429")
        self.assertEqual(G.geocode_pending(self.db, fetch=fetch, pace=lambda: None), 0)
        self.assertNotIn("geo", self.db.get(models.PropertyAsset, "a").payload)


class MetricsTests(unittest.TestCase):
    """GET /property-assets/metrics: a construction asset's % complete, only
    for assets the caller may see; a site-model-less asset simply has none."""
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        from construction_models import ConstructionProject
        for m in (models.PropertyAsset, models.PropertyRecord, models.PropertyActivityLog, models.PropertyWorkspaceMeta, ConstructionProject):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_percent_complete_rides_with_the_visible_asset(self):
        from construction_models import ConstructionProject
        PA.post_changes(PA.Changes(properties={"upsert": [{"id": "build", "name": "Build"}, {"id": "home", "name": "Home", "private": True}]}), db=self.db, user=ADMIN)
        self.db.add(ConstructionProject(id="cp1", name="Build phase 2", property_id="build", status="active", percent_complete=42.5))
        self.db.add(ConstructionProject(id="cp2", name="Home reno", property_id="home", status="active", percent_complete=10))
        self.db.commit()
        self.assertEqual(PA.get_metrics(db=self.db, user=ADMIN).get("build", {}).get("percentComplete"), 42.5)
        staff = PA.get_metrics(db=self.db, user=STAFF)
        self.assertIn("build", staff)
        self.assertNotIn("home", staff)


if __name__ == "__main__":
    unittest.main()
