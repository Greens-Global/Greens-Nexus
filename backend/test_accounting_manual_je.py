"""Reports > Audit & Insights > Manual Journal Entries (CR-10, Oct 23) - as tests.

Intacct is a fake transport (nothing leaves the machine; nothing is ever
written - every request body is checked to be a read). Covers which entries
count as manual (the change-10-b system / bank-feed entry out, the
vinod.bhole entry in, a system entry a person changed in - team answer,
23 Oct), the read itself (dates, journals, login IDs from USERINFO, lines
only for the kept entries), and the endpoint: filters, entity scope, the
not-configured answer, a refused range.

    python -m pytest test_accounting_manual_je.py -q
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import httpx
from fastapi.testclient import TestClient

import auth
import cache
import database
import intacct_client as ic
import main
import models
from routers import accounting, accounting_manual_je as mje

models.Base.metadata.create_all(bind=database.engine)

ENV = {"INTACCT_SENDER_ID": "SenderXYZ", "INTACCT_SENDER_PASSWORD": "sender-Secret-123", "INTACCT_USER_ID": "nexus_api_user",
       "INTACCT_USER_PASSWORD": "user-Secret-456", "INTACCT_COMPANY_ID": "GreensCoTest", "INTACCT_ENTITY_ID": ""}
VIEWER = "viewer.mje.test@greensglobal.com"
LIMITED = "limited.mje.test@greensglobal.com"
GROUP = "grp-mje-test"
ENTITIES = [{"code": "12000", "name": "Greens Global, Inc.", "parent_code": None},
            {"code": "12019", "name": "GS Valley", "parent_code": "12000"},
            {"code": "15000", "name": "Greens Escondido", "parent_code": None}]


def _ok(result_xml):
    return ("<?xml version=\"1.0\" encoding=\"UTF-8\"?><response><control><status>success</status></control>"
            f"<operation><authentication><status>success</status></authentication>{result_xml}</operation></response>")


SESSION_XML = _ok("<result><status>success</status><function>getAPISession</function><data><api><sessionid>sess-1</sessionid>"
                  "<endpoint>https://api.intacct.com/ia/xml/xmlgw.phtml</endpoint></api></data></result>")


def _data(tag, rows):
    body = "".join("<" + tag + ">" + "".join(f"<{k}>{v}</{k}>" for k, v in r.items()) + "</" + tag + ">" for r in rows)
    return _ok(f"<result><status>success</status><function>readByQuery</function><data count=\"{len(rows)}\" numremaining=\"0\">{body}</data></result>")


def batch(rec, no, created, modified, journal="GJCA", module="2.GL", day="10/21/2026", **extra):
    return {"RECORDNO": rec, "BATCHNO": no, "JOURNAL": journal, "BATCH_DATE": day, "BATCH_TITLE": f"Entry {no}", "STATE": "Posted",
            "MODULE": module, "CREATEDBY": created, "MODIFIEDBY": modified, "WHENCREATED": "10/21/2026 16:25:51", "WHENMODIFIED": "10/21/2026 16:25:51", **extra}


# The two entries Charmi showed (change-10-b / -c), a system entry a person
# changed, one the Web Services user wrote, and an AP bill (not a GL entry).
BATCHES = [
    batch("501", "94731", "1", "1", BATCH_TITLE="RTP deposit from Cubby Enterprises", TRANSACTIONSOURCE="Rule", RULEID="Deposit Income-GSVC-GG-1548"),
    batch("502", "94650", "7", "7"),
    batch("503", "94700", "1", "7"),
    batch("504", "94701", "9", "9"),
    batch("505", "94702", "7", "7", journal="APJ", module="3.AP"),
]
USERS = [{"RECORDNO": "1", "LOGINID": "system"}, {"RECORDNO": "7", "LOGINID": "vinod.bhole"}, {"RECORDNO": "9", "LOGINID": "nexus_api_user"}]
LINES = [
    {"BATCHNO": "502", "TR_TYPE": "1", "AMOUNT": "497.00", "LOCATION": "12000"},
    {"BATCHNO": "502", "TR_TYPE": "-1", "AMOUNT": "497.00", "LOCATION": "12019"},
    {"BATCHNO": "503", "TR_TYPE": "1", "AMOUNT": "250.00", "LOCATION": "15000"},
    {"BATCHNO": "503", "TR_TYPE": "-1", "AMOUNT": "250.00", "LOCATION": "15000"},
]


class FakeIntacct:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, url, body):
        self.calls.append(body)
        for verb in ("<update", "<create", "<delete"):
            if verb in body:
                raise AssertionError("the manual entries read must never write to Intacct")
        status, text = self.answers.pop(0)
        return httpx.Response(status, text=text, request=httpx.Request("POST", url))


def standard_answers():
    return [(200, SESSION_XML), (200, _data("glbatch", BATCHES)), (200, _data("userinfo", USERS)), (200, _data("glentry", LINES))]


class EnvMixin:
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class ClassifyTests(EnvMixin, unittest.TestCase):
    def _h(self, **kw):
        return {"module": "2.GL", "createdBy": "", "modifiedBy": "", "sourceFields": {}, **kw}

    def test_the_two_entries_charmi_showed(self):
        system = self._h(createdBy="system", modifiedBy="system", sourceFields={"TRANSACTIONSOURCE": "Rule"})
        self.assertIsNone(mje.classify(system))
        self.assertEqual(mje.classify(self._h(createdBy="vinod.bhole", modifiedBy="vinod.bhole")), "created")

    def test_a_system_entry_a_person_changed_counts(self):
        self.assertEqual(mje.classify(self._h(createdBy="system", modifiedBy="vinod.bhole")), "edited")
        old, mje.assume.MANUAL_JE_EDITED_COUNTS = mje.assume.MANUAL_JE_EDITED_COUNTS, False
        try:
            self.assertIsNone(mje.classify(self._h(createdBy="system", modifiedBy="vinod.bhole")))
        finally:
            mje.assume.MANUAL_JE_EDITED_COUNTS = old

    def test_rules_api_user_and_subledgers_are_not_manual(self):
        self.assertIsNone(mje.classify(self._h(createdBy="vinod.bhole", sourceFields={"BATCH_SOURCE": "Bank feed"})))
        self.assertIsNone(mje.classify(self._h(createdBy="NEXUS_API_USER")))
        self.assertIsNone(mje.classify(self._h(createdBy="vinod.bhole", module="3.AP")))
        self.assertIsNone(mje.classify(self._h()))     # no creator read: not called manual


class ReadTests(EnvMixin, unittest.TestCase):
    def test_reads_headers_users_then_lines_of_the_kept_entries_only(self):
        fake = FakeIntacct(standard_answers())
        out = ic.read_entry_audit("2026-10-01", "2026-10-31", ["gjca", "GJ"], keep=lambda h: mje.classify(h) is not None, post=fake)
        head_q = fake.calls[1]
        self.assertIn("<object>GLBATCH</object>", head_q)
        self.assertIn("BATCH_DATE &gt;= '10/01/2026' AND BATCH_DATE &lt;= '10/31/2026' AND JOURNAL IN ('GJCA','GJ')", head_q)
        self.assertIn("<object>USERINFO</object>", fake.calls[2])
        self.assertIn("BATCHNO IN ('502','503')", fake.calls[3])
        got = {e["batchNo"]: e for e in out["entries"]}
        self.assertEqual(sorted(got), ["94650", "94700"])
        self.assertEqual((got["94650"]["createdBy"], got["94650"]["amount"], got["94650"]["locations"]), ("vinod.bhole", 497.0, ["12000", "12019"]))
        self.assertEqual((got["94700"]["createdBy"], got["94700"]["modifiedBy"]), ("system", "vinod.bhole"))
        self.assertEqual(got["94650"]["date"], "2026-10-21")

    def test_refuses_a_bad_journal_or_date_before_any_call(self):
        fake = FakeIntacct([])
        for args in (("2026-10-01", "2026-10-31", ["GJ'; DROP"]), ("10/01/2026", "2026-10-31", [])):
            with self.assertRaises(ic.IntacctError):
                ic.read_entry_audit(*args, post=fake)
        self.assertEqual(fake.calls, [])


class EndpointTests(EnvMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)

    def setUp(self):
        super().setUp()
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name=GROUP, allowed_modules="accounting:viewer"))
            for em in (VIEWER, LIMITED):
                db.add(models.NexusGroupMember(group_id=GROUP, email=em))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="12000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        mje._CACHE.clear()
        accounting._ACCT_CACHE.clear()
        self.fake = FakeIntacct(standard_answers())
        self._post, ic._default_post = ic._default_post, self.fake

        async def fake_get(path, params):
            return {"ok": True, "entities": ENTITIES}
        self._get, accounting._acct_get = accounting._acct_get, fake_get

    def tearDown(self):
        ic._default_post = self._post
        accounting._acct_get = self._get
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        super().tearDown()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_((VIEWER, LIMITED))).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _get_entries(self, qs="from=2026-10-01&to=2026-10-31"):
        return self.client.get(f"/accounting/manual-entries?{qs}")

    def test_lists_only_manual_entries_with_who_and_when(self):
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        r = self._get_entries()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual([(e["batchNo"], e["kind"], e["createdBy"], e["modifiedBy"]) for e in d["entries"]],
                         [("94700", "edited", "system", "vinod.bhole"), ("94650", "created", "vinod.bhole", "vinod.bhole")])
        self.assertNotIn("94731", [e["batchNo"] for e in d["entries"]])     # change-10-b, the bank-feed rule entry
        self.assertEqual(d["users"], ["vinod.bhole"])
        self.assertEqual(d["scanned"], 5)
        # The same range again is the cache: Intacct is not asked twice.
        n = len(self.fake.calls)
        self.assertEqual(self._get_entries("from=2026-10-01&to=2026-10-31&edited=false").json()["entries"][0]["batchNo"], "94650")
        self.assertEqual(len(self.fake.calls), n)

    def test_filters_by_entity_and_user(self):
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        self.assertEqual([e["batchNo"] for e in self._get_entries("from=2026-10-01&to=2026-10-31&locations=15000").json()["entries"]], ["94700"])
        # 12000 brings its sub-entity 12019.
        self.assertEqual([e["batchNo"] for e in self._get_entries("from=2026-10-01&to=2026-10-31&locations=12000").json()["entries"]], ["94650"])
        self.assertEqual(self._get_entries("from=2026-10-01&to=2026-10-31&user=someone.else").json()["entries"], [])

    def test_a_limited_person_sees_entries_inside_their_entities_only(self):
        os.environ["NEXUS_DEV_EMAIL"] = LIMITED
        self.assertEqual([e["batchNo"] for e in self._get_entries().json()["entries"]], ["94650"])

    def test_not_configured_and_bad_ranges(self):
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        self.assertEqual(self._get_entries("from=2026-10-31&to=2026-10-01").status_code, 400)
        self.assertEqual(self._get_entries("from=2024-01-01&to=2026-10-01").status_code, 400)
        os.environ.pop("INTACCT_USER_PASSWORD")
        d = self._get_entries().json()
        self.assertEqual((d["available"], d["entries"]), (False, []))
        self.assertEqual(self.fake.calls, [])


if __name__ == "__main__":
    unittest.main()
