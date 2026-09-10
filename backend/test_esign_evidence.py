"""Evidence layer - acceptance criteria 1, 2, 3 and 14 of the build note.

These are the tests that back what a custodian would say on the stand:

  1  the audit log refuses UPDATE and DELETE at the DATABASE, not in Python
  2  chain verification detects a tampered row, an inserted row, a deleted row
  3  concurrent appends produce contiguous seq with no forked prev_hash
 14  the public verification endpoint discloses no identity or content

Criterion 1 is enforced by triggers on SQLite and by grants + rules on
Postgres (main.py, both migration lists). These tests run on SQLite, so they
prove the trigger half; the Postgres half is asserted by the same statements
being present in the migration list (test_migration_hygiene covers drift).

    python -m unittest test_esign_evidence
"""
import os
import threading
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from sqlalchemy import text

import database
import models
from routers import esign

models.Base.metadata.create_all(bind=database.engine)


def _envelope(db, **kw):
    d = dict(id=f"env-evidence-{uuid.uuid4()}", title="Evidence Test", source="pdf",
             status="pending", routing="sequential", created_by="a@greensglobal.com",
             created_at="2026-09-01T00:00:00+00:00")
    d.update(kw)
    req = models.HrSignRequest(**d)
    db.add(req)
    db.commit()
    return req


class AppendOnlyTests(unittest.TestCase):
    """Criterion 1."""

    def setUp(self):
        self.db = database.SessionLocal()
        self.req = _envelope(self.db)
        esign._log(self.db, self.req.id, "created", "envelope created")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _event_id(self):
        row = (self.db.query(models.HrSignEvent)
               .filter(models.HrSignEvent.request_id == self.req.id).first())
        return row.id

    def test_update_is_refused_by_the_database(self):
        with self.assertRaises(Exception) as ctx:
            self.db.execute(text("UPDATE hr_sign_events SET detail = 'tampered' WHERE id = :i"),
                            {"i": self._event_id()})
            self.db.commit()
        self.assertIn("append-only", str(ctx.exception).lower())
        self.db.rollback()

    def test_delete_is_refused_by_the_database(self):
        with self.assertRaises(Exception) as ctx:
            self.db.execute(text("DELETE FROM hr_sign_events WHERE id = :i"),
                            {"i": self._event_id()})
            self.db.commit()
        self.assertIn("append-only", str(ctx.exception).lower())
        self.db.rollback()

    def test_the_row_is_unchanged_after_a_refused_update(self):
        try:
            self.db.execute(text("UPDATE hr_sign_events SET detail = 'tampered'"))
            self.db.commit()
        except Exception:
            self.db.rollback()
        row = (self.db.query(models.HrSignEvent)
               .filter(models.HrSignEvent.request_id == self.req.id).first())
        self.assertEqual(row.detail, "envelope created")

    def test_two_events_cannot_share_a_sequence_number(self):
        dup = models.HrSignEvent(id=str(uuid.uuid4()), request_id=self.req.id, type="x",
                                 detail="d", at="2026-09-01T00:00:00+00:00", seq=1,
                                 event_hash="deadbeef")
        self.db.add(dup)
        with self.assertRaises(Exception):
            self.db.commit()
        self.db.rollback()


class ChainDetectionTests(unittest.TestCase):
    """Criterion 2 - tamper, insert, delete."""

    def setUp(self):
        self.db = database.SessionLocal()
        self.req = _envelope(self.db)
        for t, d in (("created", "envelope created"), ("sent", "notified signer"),
                     ("viewed", "signer opened"), ("signed", "signer signed")):
            esign._log(self.db, self.req.id, t, d)
        self.db.commit()
        self.events = (self.db.query(models.HrSignEvent)
                       .filter(models.HrSignEvent.request_id == self.req.id)
                       .order_by(models.HrSignEvent.seq).all())

    def tearDown(self):
        self.db.close()

    def _detached(self):
        """Plain copies - the chain verifier only reads attributes, and the real
        rows cannot be mutated (see AppendOnlyTests)."""
        return [models.HrSignEvent(id=e.id, request_id=e.request_id, party_id=e.party_id,
                                   type=e.type, detail=e.detail, ip=e.ip,
                                   user_agent=e.user_agent, at=e.at, seq=e.seq,
                                   event_hash=e.event_hash,
                                   # carry the version - an entry is verified
                                   # under the algorithm that produced it
                                   hash_version=e.hash_version) for e in self.events]

    def test_an_intact_chain_verifies(self):
        self.assertTrue(esign._verify_chain(self._detached())["valid"])

    def test_a_tampered_row_is_detected(self):
        rows = self._detached()
        rows[1].detail = "notified somebody else"
        self.assertFalse(esign._verify_chain(rows)["valid"])

    def test_an_inserted_row_is_detected(self):
        rows = self._detached()
        forged = models.HrSignEvent(id=str(uuid.uuid4()), request_id=self.req.id,
                                    type="signed", detail="a signature that never happened",
                                    ip="", user_agent="", at="2026-09-01T12:00:00+00:00",
                                    seq=3, event_hash="00" * 32)
        rows.insert(2, forged)
        self.assertFalse(esign._verify_chain(rows)["valid"])

    def test_a_deleted_middle_row_is_detected(self):
        rows = self._detached()
        del rows[1]
        self.assertFalse(esign._verify_chain(rows)["valid"])

    def test_a_truncated_tail_is_caught_by_the_event_count_not_the_chain(self):
        """Honest limit: lopping the LAST events off leaves a chain that still
        replays. What catches it is the event count recorded on the certificate
        at completion, and the nightly sweep comparing against it. Documented as
        a test so nobody assumes the chain alone covers truncation."""
        rows = self._detached()[:2]
        self.assertTrue(esign._verify_chain(rows)["valid"])
        self.assertEqual(esign._verify_chain(rows)["eventCount"], 2)
        self.assertEqual(esign._verify_chain(self._detached())["eventCount"], 4)


class ConcurrentAppendTests(unittest.TestCase):
    """Criterion 3."""

    def test_parallel_appends_produce_contiguous_seq_and_one_chain(self):
        db = database.SessionLocal()
        req_id = _envelope(db).id      # read the id BEFORE the session closes
        db.close()

        errors = []

        def append(n):
            s = database.SessionLocal()
            try:
                esign._log(s, req_id, "viewed", f"worker {n}")
                s.commit()
            except Exception as e:      # noqa: BLE001 - collected and asserted below
                errors.append(e)
                s.rollback()
            finally:
                s.close()

        threads = [threading.Thread(target=append, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        db = database.SessionLocal()
        try:
            events = (db.query(models.HrSignEvent)
                      .filter(models.HrSignEvent.request_id == req_id)
                      .order_by(models.HrSignEvent.seq).all())
            seqs = [e.seq for e in events]
            self.assertEqual(seqs, list(range(1, len(events) + 1)),
                             f"sequence is not contiguous: {seqs} (errors: {errors})")
            self.assertEqual(len(seqs), len(set(seqs)), "duplicate sequence numbers")
            hashes = [e.event_hash for e in events]
            self.assertEqual(len(hashes), len(set(hashes)), "two events share a hash - forked chain")
            self.assertTrue(esign._verify_chain(events)["valid"], "chain does not replay")
        finally:
            db.close()


class PublicVerifyDisclosureTests(unittest.TestCase):
    """Criterion 14 - the endpoint must leak nothing about who or what."""

    def setUp(self):
        from fastapi.testclient import TestClient
        import main
        self.client = TestClient(main.app)
        self.db = database.SessionLocal()
        self.req = _envelope(self.db, status="completed", verify_token=f"vt-{uuid.uuid4().hex}",
                             completed_at="2026-09-02T00:00:00+00:00",
                             final_pdf_path="esign/x/final.pdf", final_sha256="ab" * 32)
        self.db.add(models.HrSignParty(
            id=str(uuid.uuid4()), request_id=self.req.id, role_key="s",
            name="Wanda Signer", email="wanda.signer@greensglobal.com", kind="external",
            ordinal=1, status="signed", signed_at="2026-09-02T00:00:00+00:00",
            party_role="signer", ip="203.0.113.9", user_agent="Mozilla/5.0"))
        esign._log(self.db, self.req.id, "created", "envelope created")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_no_names_emails_ips_or_titles_are_returned(self):
        r = self.client.get(f"/esign/public/verify/{self.req.verify_token}")
        self.assertEqual(r.status_code, 200, r.text)
        blob = r.text.lower()
        for leaked in ("wanda", "signer@greensglobal.com", "203.0.113.9",
                       "mozilla", "evidence test"):
            self.assertNotIn(leaked, blob, f"verification endpoint leaked {leaked!r}")

    def test_it_returns_the_values_a_holder_compares_against(self):
        data = self.client.get(f"/esign/public/verify/{self.req.verify_token}").json()
        self.assertEqual(data["documentDigest"], "ab" * 32)
        self.assertEqual(data["signerCount"], 1)
        self.assertEqual(data["signedCount"], 1)
        self.assertTrue(data["auditChain"]["head"])
        self.assertGreaterEqual(data["auditChain"]["eventCount"], 1)

    def test_a_verification_attempt_is_itself_audited(self):
        before = (self.db.query(models.HrSignEvent)
                  .filter(models.HrSignEvent.request_id == self.req.id,
                          models.HrSignEvent.type == "verified").count())
        self.client.get(f"/esign/public/verify/{self.req.verify_token}")
        self.db.expire_all()
        after = (self.db.query(models.HrSignEvent)
                 .filter(models.HrSignEvent.request_id == self.req.id,
                         models.HrSignEvent.type == "verified").count())
        self.assertEqual(after, before + 1)

    def test_an_unknown_token_is_a_404(self):
        self.assertEqual(self.client.get("/esign/public/verify/nope-not-a-token").status_code, 404)


if __name__ == "__main__":
    unittest.main()


class CanonicalizationTests(unittest.TestCase):
    """Criterion 4 - RFC 8785 canonicalization, and the migration that makes it
    safe to adopt.

    The whole point of versioning rather than swapping: a hash format change is
    retroactive. Recomputing old entries under the new rules would fail every
    chain ever written, and the nightly sweep would alert on the entire table.
    """

    def test_new_entries_are_written_under_version_2(self):
        db = database.SessionLocal()
        try:
            req = _envelope(db)
            esign._log(db, req.id, "created", "envelope created")
            db.commit()
            row = (db.query(models.HrSignEvent)
                   .filter(models.HrSignEvent.request_id == req.id).first())
            self.assertEqual(row.hash_version, 2)
        finally:
            db.close()

    def test_canonicalization_ignores_key_insertion_order(self):
        """json.dumps(sort_keys=True) would also pass this; JCS additionally
        pins number formatting and string escaping, which is why it is the
        spec and not a convention."""
        import rfc8785
        a = rfc8785.dumps({"envelope_id": "e", "seq": 1, "detail": "x"})
        b = rfc8785.dumps({"detail": "x", "seq": 1, "envelope_id": "e"})
        self.assertEqual(a, b)

    def test_the_canonical_form_is_stable_for_the_same_entry(self):
        args = ("env-1", "signed", "Maria signed", "party-1", "198.51.100.1",
                "Mozilla/5.0", "2026-09-01T00:00:00+00:00", 3)
        self.assertEqual(esign._canonical_entry(*args), esign._canonical_entry(*args))

    def test_non_ascii_detail_hashes_stably(self):
        """A signer name with an accent or a CJK character must not make the
        digest depend on the encoder's mood."""
        args = ("env-1", "signed", "José signed - 日本語", "p", "", "", "2026-09-01T00:00:00+00:00", 1)
        first = esign._event_hash(*("",) + args[:3] + args[4:], party_id="p", version=2)
        for _ in range(10):
            self.assertEqual(
                esign._event_hash(*("",) + args[:3] + args[4:], party_id="p", version=2), first)

    def test_a_field_containing_a_pipe_is_unambiguous_under_v2(self):
        """The v1 format joined fields with '|', so a detail containing one
        could in principle collide with a different entry. JCS cannot."""
        a = esign._event_hash("", "env", "signed", "a|b", "", "", "2026-01-01T00:00:00+00:00", 1,
                              party_id="", version=2)
        b = esign._event_hash("", "env", "signed", "a", "b", "", "2026-01-01T00:00:00+00:00", 1,
                              party_id="", version=2)
        self.assertNotEqual(a, b)

    def test_version_1_entries_still_verify_after_the_switch(self):
        """The regression that matters most: every chain written before this
        change must keep replaying, forever."""
        db = database.SessionLocal()
        try:
            req = _envelope(db)
            prev, rows = req.id, []
            for i, (t, d) in enumerate([("created", "legacy created"),
                                        ("sent", "legacy sent"),
                                        ("signed", "legacy signed")], 1):
                at = f"2026-01-0{i}T00:00:00+00:00"
                hh = esign._event_hash_v1(prev, req.id, t, d, "198.51.100.9", "ua", at, i)
                rows.append(models.HrSignEvent(
                    id=str(uuid.uuid4()), request_id=req.id, type=t, detail=d,
                    ip="198.51.100.9", user_agent="ua", at=at, seq=i,
                    event_hash=hh, hash_version=1))
                prev = hh
            for r in rows:
                db.add(r)
            db.commit()
            result = esign._verify_chain(rows)
            self.assertTrue(result["valid"], "a v1 chain stopped verifying")
            self.assertEqual(result["hashVersions"], [1])
        finally:
            db.close()

    def test_a_chain_that_spans_the_switch_verifies_end_to_end(self):
        """A live envelope mid-signature when the change deploys: v1 entries,
        then v2 entries, one chain."""
        db = database.SessionLocal()
        try:
            req = _envelope(db)
            prev = req.id
            for i, (t, d) in enumerate([("created", "before the change"),
                                        ("sent", "also before")], 1):
                at = f"2026-01-0{i}T00:00:00+00:00"
                hh = esign._event_hash_v1(prev, req.id, t, d, "", "", at, i)
                db.add(models.HrSignEvent(id=str(uuid.uuid4()), request_id=req.id, type=t,
                                          detail=d, ip="", user_agent="", at=at, seq=i,
                                          event_hash=hh, hash_version=1))
                prev = hh
            db.commit()
            # ...and now the deploy happens; _log writes v2 from here on.
            esign._log(db, req.id, "signed", "after the change")
            esign._log(db, req.id, "completed", "sealed")
            db.commit()

            events = (db.query(models.HrSignEvent)
                      .filter(models.HrSignEvent.request_id == req.id)
                      .order_by(models.HrSignEvent.seq).all())
            result = esign._verify_chain(events)
            self.assertEqual(result["hashVersions"], [1, 2], "expected a mixed-version chain")
            self.assertTrue(result["valid"], "the chain broke across the version switch")
            self.assertEqual([e.seq for e in events], [1, 2, 3, 4])
        finally:
            db.close()

    def test_tampering_with_a_v2_entry_is_still_detected(self):
        db = database.SessionLocal()
        try:
            req = _envelope(db)
            for t, d in (("created", "a"), ("sent", "b"), ("signed", "c")):
                esign._log(db, req.id, t, d)
            db.commit()
            events = (db.query(models.HrSignEvent)
                      .filter(models.HrSignEvent.request_id == req.id)
                      .order_by(models.HrSignEvent.seq).all())
            copies = [models.HrSignEvent(
                id=e.id, request_id=e.request_id, party_id=e.party_id, type=e.type,
                detail=e.detail, ip=e.ip, user_agent=e.user_agent, at=e.at, seq=e.seq,
                event_hash=e.event_hash, hash_version=e.hash_version) for e in events]
            self.assertTrue(esign._verify_chain(copies)["valid"])
            copies[1].detail = "tampered"
            self.assertFalse(esign._verify_chain(copies)["valid"])
        finally:
            db.close()

    def test_downgrading_the_recorded_version_breaks_verification(self):
        """A row cannot be relabelled as v1 to slip a forged v2 digest past the
        replay - the version is part of what is being checked."""
        db = database.SessionLocal()
        try:
            req = _envelope(db)
            esign._log(db, req.id, "created", "x")
            db.commit()
            e = (db.query(models.HrSignEvent)
                 .filter(models.HrSignEvent.request_id == req.id).first())
            copy = models.HrSignEvent(
                id=e.id, request_id=e.request_id, party_id=e.party_id, type=e.type,
                detail=e.detail, ip=e.ip, user_agent=e.user_agent, at=e.at, seq=e.seq,
                event_hash=e.event_hash, hash_version=1)
            self.assertFalse(esign._verify_chain([copy])["valid"])
        finally:
            db.close()
