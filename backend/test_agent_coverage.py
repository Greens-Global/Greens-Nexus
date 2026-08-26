"""Chrome screenshare / desktop-agent coverage (Visesh, Aug 26).

_agent_active_for must report a person "covered" ONLY when a desktop agent is
bound to their current session on the machine they clocked in from (active_email
with a fresh heartbeat) - NOT merely because they OWN an agent PC somewhere. The
browser reads this (plus a direct localhost probe) to decide whether to skip its
Chrome screen share; the old owner-based check made someone working on a
different, agent-less computer read as covered, so that machine went uncaptured.

    python -m unittest test_agent_coverage
"""
import os
import unittest
from datetime import datetime, timezone, timedelta

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database
import models
from routers.timeclock import _agent_active_for, _AGENT_FRESH_SEC

models.Base.metadata.create_all(bind=database.engine)

PERSON = "agentcov.person@greensglobal.com"


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class AgentCoverageTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self._cleanup()

    def tearDown(self):
        self._cleanup()
        self.db.close()

    def _cleanup(self):
        self.db.query(models.AgentDevice).filter(models.AgentDevice.id.like("agentcov-%")).delete(synchronize_session=False)
        self.db.commit()

    def _dev(self, did, **kw):
        fresh = _iso(datetime.now(timezone.utc))
        d = models.AgentDevice(id=did, token_hash="x", revoked=0, last_seen_at=fresh, **kw)
        self.db.add(d); self.db.commit()
        return d

    def test_owner_only_is_not_covered(self):
        # Owns an agent PC (employee_email) that is heartbeating, but is NOT bound
        # to a session here - they're working on a different machine. NOT covered.
        self._dev("agentcov-owner", employee_email=PERSON, active_email="")
        self.assertFalse(_agent_active_for(self.db, PERSON))

    def test_bound_session_is_covered(self):
        # Agent on the machine they clocked in from claimed the session.
        self._dev("agentcov-bound", employee_email="someone.else@greensglobal.com", active_email=PERSON)
        self.assertTrue(_agent_active_for(self.db, PERSON))

    def test_stale_heartbeat_not_covered(self):
        old = _iso(datetime.now(timezone.utc) - timedelta(seconds=_AGENT_FRESH_SEC + 120))
        d = models.AgentDevice(id="agentcov-stale", employee_email=PERSON, token_hash="x", revoked=0,
                               active_email=PERSON, last_seen_at=old)
        self.db.add(d); self.db.commit()
        self.assertFalse(_agent_active_for(self.db, PERSON))

    def test_revoked_not_covered(self):
        d = models.AgentDevice(id="agentcov-revoked", employee_email=PERSON, token_hash="x", revoked=1,
                               active_email=PERSON, last_seen_at=_iso(datetime.now(timezone.utc)))
        self.db.add(d); self.db.commit()
        self.assertFalse(_agent_active_for(self.db, PERSON))


if __name__ == "__main__":
    unittest.main()
