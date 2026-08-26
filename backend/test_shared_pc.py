"""Shared-PC agent capture: the pairing handshake + binding lifecycle (Aug 26).

A shared computer is one enrolled AgentDevice. Whoever clocks in on it binds
themselves to the PC via the localhost pairing handshake (nonce -> agent claims
with its device token -> clock-in sets active_email). The agent then captures
THAT person; a second person is blocked until the first clocks out; clock-out
frees the PC; coverage (_agent_active_for) and the admin pairing-status view
follow the bound user, never the enroll owner.

    python -m unittest test_shared_pc
"""
import os
import unittest
from datetime import datetime, timezone

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers.timeclock import _agent_active_for, _hash_token

models.Base.metadata.create_all(bind=database.engine)

OWNER = "sharedpc.owner@greensglobal.com"     # enroll-time owner of the PC
A = "sharedpc.alice@greensglobal.com"
B = "sharedpc.bob@greensglobal.com"
ADMIN = "sharedpc.admin@greensglobal.com"
DEV_ID = "dev-sharedpc"
DEV_TOKEN = "raw-shared-pc-token-123"
GROUP = "grp-sharedpc"


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


class SharedPcTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em, fn in ((OWNER, "Olive"), (A, "Alice"), (B, "Bob"), (ADMIN, "Admin")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="SharedPc",
                                            work_email=em, status="active", deleted_at=""))
            # the shared PC: one enrolled device, owned by OWNER, agent online now
            db.add(models.AgentDevice(id=DEV_ID, employee_email=OWNER, token_hash=_hash_token(DEV_TOKEN),
                                      device_name="FRONT-DESK-01", revoked=0, last_seen_at=_now(),
                                      active_email="", active_session_id="", created_at=_now()))
            # admin can read the devices view
            db.add(models.NexusGroup(id=GROUP, name="SharedPc Admin", allowed_modules="employee-tracking:full"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("sharedpc.%")).delete(synchronize_session=False))
            db.query(models.AgentDevice).filter(models.AgentDevice.id == DEV_ID).delete(synchronize_session=False)
            db.query(models.AgentPairing).filter(models.AgentPairing.employee_email.like("sharedpc.%")).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email.like("sharedpc.%")).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _device(self):
        db = database.SessionLocal()
        try:
            return db.query(models.AgentDevice).filter(models.AgentDevice.id == DEV_ID).first()
        finally:
            db.close()

    def _pair_and_clock_in(self, email):
        """Full handshake: mint a nonce as `email`, have the local agent claim it
        with its device token, then clock in with the nonce (binds active_email)."""
        self._as(email)
        nonce = self.client.post("/timeclock/agent/pair-challenge").json()["nonce"]
        r = self.client.post("/timeclock/agent/pair", json={"nonce": nonce},
                             headers={"X-Agent-Token": DEV_TOKEN})
        self.assertEqual(r.status_code, 200, r.text)
        return self.client.post("/timeclock/punch", json={"kind": "in", "pair_nonce": nonce})

    def _auto_out_count(self, email):
        db = database.SessionLocal()
        try:
            return (db.query(models.TimePunch)
                    .filter(models.TimePunch.employee_email == email,
                            models.TimePunch.kind == "out", models.TimePunch.source == "auto_eod")
                    .count())
        finally:
            db.close()

    def test_clean_handoff_via_clockout(self):
        # Alice pairs + clocks in -> bound to her, not the enroll owner.
        self.assertEqual(self._pair_and_clock_in(A).status_code, 200)
        self.assertEqual(self._device().active_email, A)
        self.assertTrue(_agent_active_for(database.SessionLocal(), A))
        self.assertFalse(_agent_active_for(database.SessionLocal(), OWNER))
        # Alice clocks out -> the PC is freed; Bob then binds it cleanly.
        self._as(A)
        self.assertEqual(self.client.post("/timeclock/punch", json={"kind": "out"}).status_code, 200)
        self.assertEqual(self._device().active_email, "")
        self.assertEqual(self._pair_and_clock_in(B).status_code, 200)
        self.assertEqual(self._device().active_email, B)

    def test_takeover_when_previous_forgot_to_clock_out(self):
        # Alice clocks in on the shared PC, then walks away / logs out WITHOUT
        # clocking out (still bound, still on an open shift).
        self.assertEqual(self._pair_and_clock_in(A).status_code, 200)
        self.assertEqual(self._device().active_email, A)
        self.assertEqual(self._auto_out_count(A), 0)

        # Bob sits down and clocks in on the SAME PC. He is NOT blocked - he takes
        # the PC over, and Alice's forgotten shift is closed with a pay-safe
        # flagged auto clock-out.
        r = self._pair_and_clock_in(B)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._device().active_email, B)          # Bob now bound
        self.assertEqual(self._auto_out_count(A), 1)              # Alice auto-clocked-out
        self.assertTrue(_agent_active_for(database.SessionLocal(), B))
        self.assertFalse(_agent_active_for(database.SessionLocal(), A))

    def test_pairing_status_bound_vs_owner_fallback(self):
        # Alice bound -> the admin devices view shows this PC as "bound" to Alice.
        self._pair_and_clock_in(A)
        self._as(ADMIN)
        dev = next(d for d in self.client.get("/timeclock/agent/devices").json()["devices"] if d["id"] == DEV_ID)
        self.assertEqual(dev["pairingStatus"], "bound")
        self.assertEqual(dev["activeEmail"], A)

        # Alice clocks out; the OWNER clocks in WITHOUT pairing (no local agent
        # reachable) -> the agent falls back to capturing the owner, and the view
        # flags it as owner_fallback so an admin can see pairing isn't binding.
        self._as(A)
        self.client.post("/timeclock/punch", json={"kind": "out"})
        self._as(OWNER)
        self.assertEqual(self.client.post("/timeclock/punch", json={"kind": "in"}).status_code, 200)
        self.assertEqual(self._device().active_email, "")   # never bound
        self._as(ADMIN)
        dev = next(d for d in self.client.get("/timeclock/agent/devices").json()["devices"] if d["id"] == DEV_ID)
        self.assertEqual(dev["pairingStatus"], "owner_fallback")


if __name__ == "__main__":
    unittest.main()
