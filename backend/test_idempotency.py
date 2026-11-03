"""Idempotency-Key for the field outbox (full offline, Neil 11/03/2026;
backend/idempotency.py, docs/Offline.md).

- No header: the route behaves exactly as before (two calls, two rows).
- The same key twice: one row, the second answer is the first one (same
  status, same body) and says it is a replay.
- The same key for a different request (another body or route) is a 422,
  never the other request's answer; a malformed key is a 400.
- Keys are per person: another person's identical key is their own write.
- A refusal (4xx) is not stored - a retry is judged again.
- Two tries racing past the replay check: the loser's write is rolled back
  and it answers with the winner's row.
- Daily log create / edit and photo register honor it; an edit resent after a
  later edit never overwrites the later one.
- purge_expired removes answers older than 7 days and keeps newer ones.

Run alone (one file per process): python -m pytest test_idempotency.py
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
# The photo-link check (construction_storage.check_media) needs a storage base.
os.environ["SUPABASE_URL"] = "https://proj.supabase.co"

import atexit  # noqa: E402

from fastapi import Depends, FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import idempotency  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from idempotency import Idem  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


WORKER = "idem.worker@greensglobal.com"
OTHER = "idem.other@greensglobal.com"


# ── A tiny app around the mechanism alone ────────────────────────────────────

class NoteIn(BaseModel):
    text: str
    refuse: bool = False


def _me():
    return {"email": os.environ.get("NEXUS_DEV_EMAIL", WORKER)}


toy = FastAPI()
_made = []


@toy.post("/notes", status_code=201)
def make_note(body: NoteIn, user: dict = Depends(_me), db=Depends(database.get_db),
              idem: Idem = Depends(idempotency.idempotency)):
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    if body.refuse:
        raise HTTPException(403, "No")
    row = {"id": str(uuid.uuid4()), "text": body.text}
    _made.append(row)
    idem.remember(db, user, row, 201)
    lost = idem.commit(db, user)
    if lost is not None:
        return lost
    return row


@toy.post("/other")
def other_route(body: NoteIn, user: dict = Depends(_me), db=Depends(database.get_db),
                idem: Idem = Depends(idempotency.idempotency)):
    hit = idem.replay(db, user)
    if hit is not None:
        return hit
    idem.remember(db, user, {"ok": True}, 200)
    idem.commit(db, user)
    return {"ok": True}


def _key():
    return f"k-{uuid.uuid4()}"


class MechanismTests(unittest.TestCase):
    def setUp(self):
        os.environ["NEXUS_DEV_EMAIL"] = WORKER
        _made.clear()
        self.c = TestClient(toy)

    def test_no_header_is_the_route_as_before(self):
        a = self.c.post("/notes", json={"text": "a"})
        b = self.c.post("/notes", json={"text": "a"})
        self.assertEqual((a.status_code, b.status_code), (201, 201))
        self.assertNotEqual(a.json()["id"], b.json()["id"])
        self.assertEqual(len(_made), 2)

    def test_same_key_twice_is_one_write_and_the_first_answer(self):
        k = _key()
        a = self.c.post("/notes", json={"text": "a"}, headers={"Idempotency-Key": k})
        b = self.c.post("/notes", json={"text": "a"}, headers={"Idempotency-Key": k})
        self.assertEqual(a.status_code, 201)
        self.assertEqual(b.status_code, 201)
        self.assertEqual(a.json(), b.json())
        self.assertEqual(b.headers.get("Idempotent-Replay"), "true")
        self.assertEqual(len(_made), 1)

    def test_same_key_different_body_or_route_is_refused(self):
        k = _key()
        self.c.post("/notes", json={"text": "a"}, headers={"Idempotency-Key": k})
        r = self.c.post("/notes", json={"text": "b"}, headers={"Idempotency-Key": k})
        self.assertEqual(r.status_code, 422)
        r = self.c.post("/other", json={"text": "a"}, headers={"Idempotency-Key": k})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(len(_made), 1)

    def test_malformed_key_is_a_400(self):
        for bad in ("short", "has space in it", "x" * 101, "semi;colon-key"):
            r = self.c.post("/notes", json={"text": "a"}, headers={"Idempotency-Key": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.assertEqual(_made, [])

    def test_keys_are_per_person(self):
        k = _key()
        a = self.c.post("/notes", json={"text": "a"}, headers={"Idempotency-Key": k})
        os.environ["NEXUS_DEV_EMAIL"] = OTHER
        b = self.c.post("/notes", json={"text": "a"}, headers={"Idempotency-Key": k})
        self.assertNotEqual(a.json()["id"], b.json()["id"])
        self.assertEqual(len(_made), 2)

    def test_a_refusal_is_not_stored(self):
        k = _key()
        r = self.c.post("/notes", json={"text": "a", "refuse": True}, headers={"Idempotency-Key": k})
        self.assertEqual(r.status_code, 403)
        with database.SessionLocal() as db:
            self.assertEqual(db.query(models.NexusIdempotencyKey).filter_by(idem_key=k).count(), 0)

    def test_a_race_loser_answers_with_the_winner(self):
        k = _key()
        user = {"email": WORKER}
        with database.SessionLocal() as db1, database.SessionLocal() as db2:
            first = Idem(key=k, route="POST /notes", request_hash="h")
            second = Idem(key=k, route="POST /notes", request_hash="h")
            self.assertIsNone(first.replay(db1, user))
            self.assertIsNone(second.replay(db2, user))
            first.remember(db1, user, {"id": "winner"}, 201)
            self.assertIsNone(first.commit(db1, user))
            second.remember(db2, user, {"id": "loser"}, 201)
            lost = second.commit(db2, user)
            self.assertIsNotNone(lost)
            self.assertEqual(lost.status_code, 201)
            self.assertIn(b'"winner"', lost.body)

    def test_purge_keeps_the_last_seven_days(self):
        old, new = _key(), _key()
        with database.SessionLocal() as db:
            stamp = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
            db.add(models.NexusIdempotencyKey(id=str(uuid.uuid4()), idem_key=old, user_email=WORKER,
                                              route="POST /x", response_json="{}", created_at=stamp))
            db.add(models.NexusIdempotencyKey(id=str(uuid.uuid4()), idem_key=new, user_email=WORKER,
                                              route="POST /x", response_json="{}",
                                              created_at=datetime.now(timezone.utc).isoformat()))
            db.commit()
        self.assertGreaterEqual(idempotency.purge_expired(), 1)
        with database.SessionLocal() as db:
            keys = {r.idem_key for r in db.query(models.NexusIdempotencyKey).all()}
        self.assertNotIn(old, keys)
        self.assertIn(new, keys)


# ── The construction routes the outbox calls ─────────────────────────────────

class ConstructionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.pid = f"idem-proj-{uuid.uuid4().hex[:6]}"
        with database.SessionLocal() as db:
            db.add(models.ConstructionProject(id=cls.pid, name="Idempotency Yard", worker_emails=[WORKER],
                                              manager_emails=[], geofence_radius_m=0, deleted_at=""))
            db.commit()

    def setUp(self):
        os.environ["NEXUS_DEV_EMAIL"] = WORKER
        auth.invalidate_role_cache()

    def _log(self, day, key=None):
        h = {"Idempotency-Key": key} if key else {}
        return self.client.post(f"/construction/projects/{self.pid}/logs", json={"log_date": day}, headers=h)

    def test_log_create_replays(self):
        k = _key()
        a = self._log("2026-11-01", k)
        b = self._log("2026-11-01", k)
        self.assertEqual(a.status_code, 201, a.text)
        self.assertEqual(b.status_code, 201, b.text)
        self.assertEqual(a.json()["id"], b.json()["id"])

    def test_media_register_twice_is_one_row(self):
        log = self._log("2026-11-02").json()
        k = _key()
        body = {"kind": "photo", "mime_type": "image/jpeg", "size_bytes": 1234,
                "url": f"https://proj.supabase.co/storage/v1/object/public/construction-media/construction/{self.pid}/a.jpg"}
        a = self.client.post(f"/construction/logs/{log['id']}/media", json=body, headers={"Idempotency-Key": k})
        b = self.client.post(f"/construction/logs/{log['id']}/media", json=body, headers={"Idempotency-Key": k})
        self.assertEqual(a.status_code, 201, a.text)
        self.assertEqual(b.status_code, 201, b.text)
        self.assertEqual(a.json()["id"], b.json()["id"])
        with database.SessionLocal() as db:
            n = db.query(models.ConstructionMedia).filter_by(daily_log_id=log["id"], deleted_at="").count()
        self.assertEqual(n, 1)
        # Without the key a second photo is a second row, as before.
        c = self.client.post(f"/construction/logs/{log['id']}/media", json=body)
        self.assertEqual(c.status_code, 201)
        self.assertNotEqual(c.json()["id"], a.json()["id"])

    def test_an_old_edit_resent_never_overwrites_a_newer_one(self):
        log = self._log("2026-11-03").json()
        first = _key()
        r = self.client.patch(f"/construction/logs/{log['id']}", json={"notes_raw": "first"}, headers={"Idempotency-Key": first})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.patch(f"/construction/logs/{log['id']}", json={"notes_raw": "second"}, headers={"Idempotency-Key": _key()})
        self.assertEqual(r.json()["notes"], "second")
        # The first edit's answer was lost; the phone sends it again.
        r = self.client.patch(f"/construction/logs/{log['id']}", json={"notes_raw": "first"}, headers={"Idempotency-Key": first})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["notes"], "first")          # the answer it got then
        with database.SessionLocal() as db:
            row = db.get(models.ConstructionDailyLog, log["id"])
            self.assertEqual(row.notes_raw, "second")          # the record keeps the newer edit


if __name__ == "__main__":
    unittest.main()
