"""AMA - the other side of the entry, Notes and the bookkeeper's GL reclass
(Charmi, Oct 22 call, change request 13) - as tests.

The offsetting accounts from the entry, Notes saved per line, a GL pick that
waits for the bookkeeper, only a bookkeeper changing / sending back /
pushing it (an Accounting editor or administrator who is not one cannot),
the approver and time kept, the line and its question moving to Resolved,
the reclass entry's own AMA line shown Resolved, the push as a NEW entry
through intacct_client (mocked - nothing reaches Intacct) or recorded for
the import file while the switch is off, and the Bookkeepers setting.

    python -m pytest test_accounting_ask_review.py -q
"""
import csv
import io
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import httpx
from fastapi.testclient import TestClient

import accounting_assumptions as assumptions
import ama_review
import auth
import cache
import database
import intacct_client
import intacct_gl
import main
import models
from routers import accounting, accounting_ask as ask

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.amarev.test@greensglobal.com"      # accounting:editor - NOT a bookkeeper
ANSWER = "answer.amarev.test@greensglobal.com"      # accounting:viewer - answers (Neil's seat)
BOOK = "book.amarev.test@greensglobal.com"          # accounting:viewer, bookkeeper
BOOK2 = "book2.amarev.test@greensglobal.com"        # accounting:viewer, bookkeeper
LIMITED = "limited.amarev.test@greensglobal.com"    # accounting:editor, entity 56000 only
EVERYONE = (EDITOR, ANSWER, BOOK, BOOK2, LIMITED)
GROUPS = {"grp-amarev-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-amarev-v": ("accounting:viewer", (ANSWER, BOOK, BOOK2))}
ENTITIES = [{"code": "15000", "name": "Greens Escondido", "parent_code": None}, {"code": "56000", "name": "MCD Services", "parent_code": None}]
CHART = [("11000", "Chase Checking"), ("11050", "Wells Checking"), ("61000", "Repairs"), ("40100", "Rental Income"), ("63501", "? Ask My Accountant")]
ENTRY_A = str(uuid.uuid5(uuid.NAMESPACE_URL, "IA-1294340"))


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def ln(line_id, account="63501", debit=3000.0, credit=0.0, location="15000", entry="IA-1294340", day="2026-09-30", desc="DDA Withdrawal"):
    return {"line_id": line_id, "entry_id": str(uuid.uuid5(uuid.NAMESPACE_URL, entry)), "entry_no": entry, "entry_date": day,
            "location": location, "location_name": location, "gl_code": account, "account_name": dict(CHART).get(account, ""),
            "description": desc, "memo": "", "debit": debit, "credit": credit, "journal": "IA", "department": "4100", "department_name": "Storage"}


def body(line_id="L1", account="63501", amount=3000.0, entity="15000", entry="IA-1294340", **extra):
    return {"entityCode": entity, "entryId": str(uuid.uuid5(uuid.NAMESPACE_URL, entry)), "entryNo": entry, "lineId": line_id, "accountNo": account,
            "accountTitle": dict(CHART).get(account, ""), "date": "2026-09-30", "amount": amount, "description": "DDA Withdrawal",
            "departmentId": "4100", **extra}


class PureTests(unittest.TestCase):
    def test_offsets_are_the_other_lines_largest_first(self):
        lines = [ln("A1", debit=3000), ln("A2", account="11000", debit=0, credit=2500), ln("A3", account="11050", debit=0, credit=500),
                 ln("A4", account="11000", debit=0, credit=0), ln("A5", account="61000", location="56000", debit=0, credit=1)]
        got = ama_review.entry_offsets(lines, {"63501"}, None)
        self.assertEqual([(o["accountNo"], o["amount"]) for o in got["offsets"]], [("11000", -2500.0), ("11050", -500.0), ("61000", -1.0)])
        self.assertEqual(got["offsets"][0]["accountTitle"], "Chase Checking")
        limited = ama_review.entry_offsets(lines, {"63501"}, {"15000"})
        self.assertEqual((len(limited["offsets"]), limited["hidden"]), (2, 1))

    def test_line_ref(self):
        self.assertEqual(ama_review.line_ref("L1", "E", "63501", 1, "2026-01-01"), "L1")
        self.assertEqual(ama_review.line_ref("", "E-1", "63501", -12.5, "2026-01-01T00:00"), "k:E-1|63501|-12.50|2026-01-01")

    def test_reclass_entry_is_a_new_balanced_entry(self):
        rv = {"amount": 3000.0, "date": "2026-09-30", "reclassRef": "R-0a1b2c3d", "entryNo": "IA-1294340", "partyKind": "vendor", "partyId": "V01812",
              "entityCode": "12001", "departmentId": "4100", "toAccount": "61000", "accountNo": "63501"}
        e = ama_review.reclass_entry(rv)
        self.assertEqual((e["journal"], e["date"], e["reference_no"]), (assumptions.AMA_RECLASS_JOURNAL, "2026-09-30", "R-0a1b2c3d"))
        self.assertTrue(e["description"].startswith(assumptions.AMA_RECLASS_TAG))
        first, second = e["lines"]
        self.assertEqual((first["acct_no"], first["debit"], first["credit"], first["vendor_id"], first["location_id"], first["dept_id"]),
                         ("61000", 3000.0, None, "V01812", "12001", "4100"))
        self.assertEqual((second["acct_no"], second["debit"], second["credit"]), ("63501", None, 3000.0))
        self.assertTrue(intacct_gl.balanced([e]))
        income = ama_review.reclass_entry({**rv, "amount": -2000.0, "partyKind": "customer", "partyId": "C9", "toAccount": "40100"})
        self.assertEqual((income["lines"][0]["credit"], income["lines"][0]["customer_id"], income["lines"][1]["debit"]), (2000.0, "C9", 2000.0))
        self.assertNotIn("vendor_id", income["lines"][0])

    def test_reclass_date_follows_the_assumption(self):
        rv = {"amount": 1.0, "date": "2026-09-30", "reclassRef": "R-00000000", "toAccount": "61000", "accountNo": "63501"}
        keep = assumptions.AMA_RECLASS_DATE
        try:
            assumptions.AMA_RECLASS_DATE = "today"
            from datetime import date
            self.assertEqual(ama_review.reclass_entry(rv, today=date(2026, 10, 23))["date"], "2026-10-23")
        finally:
            assumptions.AMA_RECLASS_DATE = keep

    def test_the_reclass_entry_line_is_known(self):
        self.assertEqual(ama_review.reclass_ref_of({"description": f"{assumptions.AMA_RECLASS_TAG} R-0a1b2c3d of IA-1"}), "R-0a1b2c3d")
        self.assertIsNone(ama_review.reclass_ref_of({"description": "DDA Withdrawal", "memo": "R-0a1b2c3d"}))

    def test_import_file_carries_vendor_and_customer(self):
        rv = {"amount": 5.0, "date": "2026-09-30", "reclassRef": "R-00000001", "partyKind": "customer", "partyId": "C42", "toAccount": "40100", "accountNo": "63501"}
        rows = list(csv.reader(io.StringIO(intacct_gl.to_csv([ama_review.reclass_entry(rv)]))))
        head = rows[0]
        self.assertEqual(rows[1][head.index("GLENTRY_CUSTOMERID")], "C42")
        self.assertEqual(rows[1][head.index("GLENTRY_VENDORID")], "")
        self.assertEqual(rows[1][head.index("DATE")], "09-30-2026")


class IntacctWriteTests(unittest.TestCase):
    """create_gl_batch through a fake poster - nothing leaves the process."""

    def setUp(self):
        self._env = {k: os.environ.get(k) for k in intacct_client.REQUIRED_ENV}
        for k in intacct_client.REQUIRED_ENV:
            os.environ[k] = f"{k.lower()}-value"

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _post(self, answers):
        sent = []

        def post(url, xml):
            sent.append((url, xml))
            return httpx.Response(200, text=answers[len(sent) - 1])
        return post, sent

    SESSION = ("<response><control><status>success</status></control><operation><authentication><status>success</status></authentication>"
               "<result><status>success</status><data><api><sessionid>sess123</sessionid><endpoint>https://api.intacct.com/ia/xml/xmlgw.phtml</endpoint></api></data></result></operation></response>")

    def test_creates_one_glbatch_and_returns_its_record(self):
        ok = ("<response><control><status>success</status></control><operation><authentication><status>success</status></authentication>"
              "<result><status>success</status><function>create</function><data><glbatch><RECORDNO>98765</RECORDNO></glbatch></data></result></operation></response>")
        post, sent = self._post([self.SESSION, ok])
        e = ama_review.reclass_entry({"amount": 3000.0, "date": "2026-09-30", "reclassRef": "R-0a1b2c3d", "entryNo": "IA-1", "partyKind": "vendor",
                                      "partyId": "V1&2", "entityCode": "12001", "toAccount": "61000", "accountNo": "63501"})
        self.assertEqual(intacct_client.create_gl_batch(e, post=post), "98765")
        xml = sent[1][1]
        self.assertIn("<create><GLBATCH><JOURNAL>", xml)
        self.assertIn("<BATCH_DATE>09/30/2026</BATCH_DATE>", xml)
        self.assertIn("<ACCOUNTNO>61000</ACCOUNTNO><LOCATION>12001</LOCATION><TR_TYPE>1</TR_TYPE><TRX_AMOUNT>3000.00</TRX_AMOUNT>", xml)
        self.assertIn("<ACCOUNTNO>63501</ACCOUNTNO><LOCATION>12001</LOCATION><TR_TYPE>-1</TR_TYPE>", xml)
        self.assertIn("<VENDORID>V1&amp;2</VENDORID>", xml)
        self.assertIn("<sessionid>sess123</sessionid>", xml)

    def test_a_refusal_is_an_intacct_error(self):
        bad = ("<response><control><status>success</status></control><operation><authentication><status>success</status></authentication>"
               "<result><status>failure</status><errormessage><error><description2>The period is closed</description2></error></errormessage></result></operation></response>")
        post, _ = self._post([self.SESSION, bad])
        e = ama_review.reclass_entry({"amount": 1.0, "date": "2026-01-31", "reclassRef": "R-00000002", "toAccount": "61000", "accountNo": "63501"})
        with self.assertRaises(intacct_client.IntacctError) as cm:
            intacct_client.create_gl_batch(e, post=post)
        self.assertIn("period is closed", str(cm.exception))

    def test_not_configured(self):
        os.environ.pop("INTACCT_COMPANY_ID")
        with self.assertRaises(intacct_client.IntacctError):
            intacct_client.create_gl_batch({"lines": [{}, {}]}, post=lambda u, x: self.fail("must not post"))


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._push, self._fallback = assumptions.AMA_PUSH_TO_INTACCT, assumptions.AMA_BOOKKEEPERS_FALLBACK
        self._create, self._configured = intacct_client.create_gl_batch, intacct_client.configured
        assumptions.AMA_PUSH_TO_INTACCT = False
        assumptions.AMA_BOOKKEEPERS_FALLBACK = []
        intacct_client.create_gl_batch = lambda *a, **k: self.fail("Intacct must not be called")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (mods, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
                for em in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=em))
            for em in EVERYONE:
                db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name=em.split(".")[0].title(), last_name="Test", work_email=em, status="active"))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="56000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting._ACCT_CACHE.clear()
        self.lines = [ln("L1"), ln("L1b", account="11000", debit=0, credit=3000),
                      ln("L2", debit=0, credit=2000, entry="IA-1293973", desc="ZELLE from DINA"), ln("L2b", account="11050", debit=2000, credit=0, entry="IA-1293973"),
                      ln("L3", location="56000", entry="IA-9")]

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/buckets"):
                return {"ok": True, "rows": [{"bucket": "total", "account_no": c, "title": t, "debit": 1, "credit": 0} for c, t in CHART]}
            if path.endswith("/search"):
                locs = {clean["location"]} if "location" in clean else set((clean.get("locations") or "").split(",")) - {""}
                rows = [r for r in self.lines if r["gl_code"] == clean.get("account") and (not locs or r["location"] in locs)]
                return {"ok": True, "rows": rows, "total": len(rows)}
            if path.endswith("/entry"):
                return {"ok": True, "entry": {"id": clean["id"]}, "lines": [r for r in self.lines if r["entry_id"] == clean["id"]]}
            return {"ok": True}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"
        _as(EDITOR)
        r = self.client.put("/accounting/ask/settings", json={"bookkeepers": [BOOK, BOOK2]})
        self.assertEqual(r.status_code, 200, r.text)

    def tearDown(self):
        accounting._acct_get = self._get
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        assumptions.AMA_PUSH_TO_INTACCT, assumptions.AMA_BOOKKEEPERS_FALLBACK = self._push, self._fallback
        intacct_client.create_gl_batch, intacct_client.configured = self._create, self._configured
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
            db.query(models.AccountingAmaLineReview).delete(synchronize_session=False)
            ids = [t.id for t in db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.asked_by.in_(EVERYONE)).all()]
            if ids:
                db.query(models.AccountingAmaMessage).filter(models.AccountingAmaMessage.thread_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.AccountingAmaThread).filter(models.AccountingAmaThread.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.type == ask.NOTIFY_TYPE,
                                                      models.NexusNotification.recipient.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingAmaSetting).filter(models.AccountingAmaSetting.updated_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _bells(self, recipient):
        db = database.SessionLocal()
        try:
            return [n.title for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.type == ask.NOTIFY_TYPE, models.NexusNotification.recipient == recipient).all()]
        finally:
            db.close()

    def _items(self):
        r = self.client.get("/accounting/ask/items?from=2026-01-01&to=2026-12-31")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _row(self, d, line_id):
        return next(x for x in d["rows"] if x["lineId"] == line_id)

    # ── The other side ──
    def test_offsets_for_the_entries_on_screen(self):
        _as(ANSWER)
        e2 = str(uuid.uuid5(uuid.NAMESPACE_URL, "IA-1293973"))
        r = self.client.get(f"/accounting/ask/offsets?entries={ENTRY_A},{e2}")
        self.assertEqual(r.status_code, 200, r.text)
        got = r.json()["offsets"]
        self.assertEqual([(o["accountNo"], o["accountTitle"], o["amount"]) for o in got[ENTRY_A]["offsets"]], [("11000", "Chase Checking", -3000.0)])
        self.assertEqual(got[e2]["offsets"][0]["accountNo"], "11050")
        self.assertEqual(self.client.get("/accounting/ask/offsets?entries=nope").status_code, 400)
        many = ",".join(str(uuid.uuid4()) for _ in range(assumptions.AMA_OFFSET_BATCH_MAX + 1))
        self.assertEqual(self.client.get(f"/accounting/ask/offsets?entries={many}").status_code, 400)

    def test_offsets_keep_to_the_callers_entities(self):
        _as(LIMITED)
        r = self.client.get(f"/accounting/ask/offsets?entries={ENTRY_A}").json()
        self.assertEqual(r["offsets"], {})
        self.assertIn(ENTRY_A, r["errors"])

    def test_gl_accounts_leave_out_the_ama_account(self):
        _as(ANSWER)
        codes = [a["code"] for a in self.client.get("/accounting/ask/gl-accounts").json()["accounts"]]
        self.assertIn("61000", codes)
        self.assertNotIn("63501", codes)

    # ── Notes ──
    def test_notes_are_saved_per_line_and_listed(self):
        _as(ANSWER)
        r = self.client.put("/accounting/ask/lines/note", json={**body(), "note": "Paid the laborers in cash"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["note"], r.json()["noteBy"]), ("Paid the laborers in cash", ANSWER))
        _as(BOOK)
        d = self._items()
        self.assertEqual(self._row(d, "L1")["note"], "Paid the laborers in cash")
        self.assertEqual(self._row(d, "L2")["note"], "")
        self.assertEqual(self._row(d, "L1")["departmentId"], "4100")
        _as(LIMITED)
        self.assertEqual(self.client.put("/accounting/ask/lines/note", json={**body(), "note": "x"}).status_code, 403)

    # ── The reclass ──
    def test_the_answerer_proposes_and_only_a_bookkeeper_pushes(self):
        _as(ANSWER)
        r = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000", "partyKind": "vendor", "partyId": "V01812", "partyName": "Greens Global, Inc."})
        self.assertEqual(r.status_code, 200, r.text)
        rv = r.json()
        self.assertEqual((rv["status"], rv["toAccount"], rv["toAccountTitle"], rv["proposedBy"]), ("Awaiting Bookkeeper", "61000", "Repairs", ANSWER))
        self.assertTrue(rv["reclassRef"].startswith("R-"))
        self.assertEqual(len(self._bells(BOOK)), 1)
        self.assertEqual(len(self._bells(BOOK2)), 1)
        d = self._items()
        self.assertEqual((self._row(d, "L1")["reclass"]["status"], self._row(d, "L1")["status"], d["isBookkeeper"]), ("Awaiting Bookkeeper", "Open", False))

        # The answerer, an Accounting editor: no changes now, no push.
        self.assertEqual(self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "11050"}).status_code, 403)
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 403)
        _as(EDITOR)
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 403)
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/send-back", json={}).status_code, 403)

        # The bookkeeper changes it, then approves and pushes (switch off = recorded for import).
        _as(BOOK)
        r = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000", "partyKind": "vendor", "partyId": "V05126"})
        self.assertEqual((r.status_code, r.json()["partyId"], r.json()["proposedBy"]), (200, "V05126", ANSWER))
        r = self.client.post(f"/accounting/ask/reviews/{rv['id']}/push")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["status"], out["pushMode"], out["approvedBy"]), ("Pushed", "import", BOOK))
        self.assertTrue(out["approvedAt"])
        self.assertTrue(any("recorded for the Intacct import file" in h["event"] for h in out["history"]))
        self.assertEqual(self._bells(ANSWER), ["AMA Reclass Pushed: Entry IA-1294340 · $3,000.00"])
        d = self._items()
        l1 = self._row(d, "L1")
        self.assertEqual((l1["status"], l1["movedToAccount"], l1["resolvedBy"]), ("Resolved", "61000", BOOK))
        self.assertEqual(d["counts"]["Resolved"], 1)
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 409)
        _as(ANSWER)
        self.assertEqual(self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "11050"}).status_code, 409)

        # The import file.
        _as(BOOK)
        f = self.client.get("/accounting/ask/reviews/export.csv")
        self.assertEqual(f.status_code, 200, f.text)
        rows = list(csv.reader(io.StringIO(f.text)))
        self.assertEqual([r[7] for r in rows[1:]], ["61000", "63501"])
        self.assertEqual(rows[1][rows[0].index("GLENTRY_VENDORID")], "V05126")
        _as(ANSWER)
        self.assertEqual(self.client.get("/accounting/ask/reviews/export.csv").status_code, 403)

    def test_the_reclass_entrys_own_ama_line_shows_resolved(self):
        _as(BOOK)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        self.client.post(f"/accounting/ask/reviews/{rv['id']}/push")
        self.lines.append(ln("R1", debit=0, credit=3000, entry="GJ-555", desc=f"{assumptions.AMA_RECLASS_TAG} {rv['reclassRef']} of IA-1294340"))
        d = self._items()
        r1 = self._row(d, "R1")
        self.assertEqual((r1["status"], r1["reclassOf"]), ("Resolved", "IA-1294340"))

    def test_a_push_resolves_the_question_on_the_line(self):
        _as(ANSWER)
        t = self.client.post("/accounting/ask/threads", json={**{k: v for k, v in body().items() if k not in ("amount", "departmentId")},
                                                               "debit": 3000.0, "credit": 0.0, "question": "What is this?", "accountant": BOOK})
        self.assertEqual(t.status_code, 201, t.text)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        _as(BOOK)
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 200)
        thread = self.client.get(f"/accounting/ask/threads/{t.json()['id']}").json()
        self.assertEqual((thread["status"], thread["movedToAccount"], thread["resolvedBy"]), ("Resolved", "61000", BOOK))

    def test_send_back_then_the_answerer_picks_again(self):
        _as(ANSWER)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        _as(BOOK)
        r = self.client.post(f"/accounting/ask/reviews/{rv['id']}/send-back", json={"note": "This is rent income"})
        self.assertEqual((r.status_code, r.json()["status"], r.json()["reviewNote"]), (200, "Sent Back", "This is rent income"))
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 409)
        self.assertIn("AMA Reclass Sent Back: Entry IA-1294340 · $3,000.00", self._bells(ANSWER))
        _as(ANSWER)
        r = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "40100", "partyKind": "customer", "partyId": "C100"})
        self.assertEqual((r.status_code, r.json()["status"], r.json()["partyKind"]), (200, "Awaiting Bookkeeper", "customer"))

    def test_bad_picks_are_refused(self):
        _as(ANSWER)
        post = lambda **kw: self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000", **kw})  # noqa: E731
        self.assertEqual(post(toAccount="99999").status_code, 400)                     # not on the ledger
        self.assertEqual(post(toAccount="63501").status_code, 400)                     # the AMA account itself
        self.assertEqual(post(accountNo="11000").status_code, 400)                     # not an AMA line
        self.assertEqual(post(partyKind="employee", partyId="E1").status_code, 400)
        self.assertEqual(post(partyKind="vendor", partyId="").status_code, 400)
        self.assertEqual(post(amount=0).status_code, 400)
        self.assertEqual(post(entityCode="56000").status_code, 200)                    # ANSWER reaches every entity

    def test_self_approval_follows_the_assumption(self):
        _as(BOOK)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        keep = assumptions.AMA_BOOKKEEPER_MAY_APPROVE_OWN
        try:
            assumptions.AMA_BOOKKEEPER_MAY_APPROVE_OWN = False
            self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 403)
            _as(BOOK2)
            self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").json()["approvedBy"], BOOK2)
        finally:
            assumptions.AMA_BOOKKEEPER_MAY_APPROVE_OWN = keep

    def test_push_to_intacct_when_switched_on(self):
        sent = []

        def fake_create(entry, post=None):
            sent.append(entry)
            return "98765"
        assumptions.AMA_PUSH_TO_INTACCT = True
        intacct_client.configured = lambda: True
        intacct_client.create_gl_batch = fake_create
        _as(ANSWER)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        self.assertTrue(self._items()["pushToIntacct"])
        _as(BOOK)
        out = self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").json()
        self.assertEqual((out["status"], out["pushMode"], out["intacctRef"], out["approvedBy"]), ("Pushed", "intacct", "98765", BOOK))
        self.assertEqual(len(sent), 1)
        self.assertEqual([x["acct_no"] for x in sent[0]["lines"]], ["61000", "63501"])
        self.assertEqual(sent[0]["reference_no"], rv["reclassRef"])

    def test_a_refused_push_stays_with_the_bookkeeper(self):
        def refuse(entry, post=None):
            raise intacct_client.IntacctError("Intacct: The period is closed")
        assumptions.AMA_PUSH_TO_INTACCT = True
        intacct_client.configured = lambda: True
        intacct_client.create_gl_batch = refuse
        _as(BOOK)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        r = self.client.post(f"/accounting/ask/reviews/{rv['id']}/push")
        self.assertEqual(r.status_code, 424)
        self.assertIn("period is closed", r.json()["detail"])
        l1 = self._row(self._items(), "L1")
        self.assertEqual((l1["status"], l1["reclass"]["status"], l1["reclass"]["approvedBy"]), ("Open", "Awaiting Bookkeeper", ""))
        self.assertIn("period is closed", l1["reclass"]["pushError"])

    def test_switched_on_but_not_configured(self):
        assumptions.AMA_PUSH_TO_INTACCT = True
        intacct_client.configured = lambda: False
        _as(BOOK)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 503)

    # ── Who the bookkeepers are ──
    def test_bookkeepers_setting(self):
        _as(BOOK)
        s = self.client.get("/accounting/ask/settings").json()
        self.assertEqual(([b["email"] for b in s["bookkeepers"]], s["isBookkeeper"], s["bookkeepersFromEnv"]), ([BOOK, BOOK2], True, False))
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"bookkeepers": [ANSWER]}).status_code, 403)    # a viewer
        _as(LIMITED)
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"bookkeepers": [LIMITED]}).status_code, 403)   # limited editor
        _as(EDITOR)
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"bookkeepers": ["nobody@greensglobal.com"]}).status_code, 400)
        # Accounts and accountants saved without `bookkeepers` leave the list alone.
        self.assertEqual(self.client.put("/accounting/ask/settings", json={"accounts": []}).status_code, 200)
        self.assertEqual([b["email"] for b in self.client.get("/accounting/ask/settings").json()["bookkeepers"]], [BOOK, BOOK2])
        # Emptied: the environment's list takes over.
        assumptions.AMA_BOOKKEEPERS_FALLBACK = [BOOK2]
        s = self.client.put("/accounting/ask/settings", json={"bookkeepers": []}).json()
        self.assertEqual(([b["email"] for b in s["bookkeepers"]], s["bookkeepersFromEnv"]), ([BOOK2], True))
        _as(BOOK)
        rv = self.client.post("/accounting/ask/lines/reclass", json={**body(), "toAccount": "61000"}).json()
        self.assertEqual(self.client.post(f"/accounting/ask/reviews/{rv['id']}/push").status_code, 403)


if __name__ == "__main__":
    unittest.main()
