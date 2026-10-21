"""intacct_client.py - Nexus's read-only Intacct Web Services client (Oct 21 2026).

A fake transport stands in for Intacct: nothing leaves the machine. Covers
the login -> getAPISession -> readByQuery -> readMore flow, field parsing
(nested and dotted tags), safe error messages (no credential text) and the
not-configured case. No database.

    python -m pytest test_intacct_client.py -q
"""
import os
import unittest
from xml.sax.saxutils import escape

import httpx

import intacct_client as ic

ENV = {
    "INTACCT_SENDER_ID": "SenderXYZ",
    "INTACCT_SENDER_PASSWORD": "sender-Secret-123",
    "INTACCT_USER_ID": "nexus_api_user",
    "INTACCT_USER_PASSWORD": "user-Secret-456",
    "INTACCT_COMPANY_ID": "GreensCoTest",
    "INTACCT_ENTITY_ID": "",
}
SESSION = "sess-ABCDEF-987654"


def _ok(result_xml: str, auth_ok: bool = True) -> str:
    auth = "<status>success</status>" if auth_ok else "<status>failure</status>"
    return ("<?xml version=\"1.0\" encoding=\"UTF-8\"?><response><control><status>success</status></control>"
            f"<operation><authentication>{auth}</authentication>{result_xml}</operation></response>")


def _session_result(endpoint="https://api.intacct.com/ia/xml/xmlgw.phtml"):
    return ("<result><status>success</status><function>getAPISession</function><data><api>"
            f"<sessionid>{SESSION}</sessionid><endpoint>{endpoint}</endpoint><locationid></locationid>"
            "</api></data></result>")


def _emp_dotted(eid, printas, email, loc="", locname=""):
    return (f"<employee><EMPLOYEEID>{eid}</EMPLOYEEID><PERSONALINFO.PRINTAS>{escape(printas)}</PERSONALINFO.PRINTAS>"
            f"<PERSONALINFO.EMAIL1>{email}</PERSONALINFO.EMAIL1><STATUS>active</STATUS>"
            f"<LOCATIONID>{loc}</LOCATIONID><LOCATIONNAME>{escape(locname)}</LOCATIONNAME>"
            "<WHENMODIFIED>10/01/2026 09:00:00</WHENMODIFIED></employee>")


def _emp_nested(eid, first, last, email):
    return (f"<EMPLOYEE><EMPLOYEEID>{eid}</EMPLOYEEID><PERSONALINFO><PRINTAS>{last}, {first}</PRINTAS>"
            f"<FIRSTNAME>{first}</FIRSTNAME><LASTNAME>{last}</LASTNAME><EMAIL1>{email}</EMAIL1></PERSONALINFO>"
            "<STATUS>inactive</STATUS><LOCATIONID>200</LOCATIONID></EMPLOYEE>")


def _data(fn, rows, remaining=0, result_id="RID-1"):
    return (f"<result><status>success</status><function>{fn}</function>"
            f"<data listtype=\"employee\" count=\"{len(rows)}\" numremaining=\"{remaining}\" resultId=\"{result_id}\">"
            f"{''.join(rows)}</data></result>")


def _failure(desc2, auth_ok=True):
    return _ok("<result><status>failure</status><function>readByQuery</function><errormessage><error>"
               f"<errorno>BL01001973</errorno><description></description><description2>{desc2}</description2>"
               "<correction></correction></error></errormessage></result>", auth_ok)


class FakeIntacct:
    """Answers each POST from a queue of (status, body) pairs, keeping the
    request bodies so tests can look at what was sent."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, url, body):
        self.calls.append((url, body))
        if not self.answers:
            raise AssertionError("unexpected extra Intacct call")
        status, text = self.answers.pop(0)
        if isinstance(text, Exception):
            raise text
        return httpx.Response(status, text=text, request=httpx.Request("POST", url))


class Base(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def assertNoSecrets(self, text):
        for k, v in ENV.items():
            if v:
                self.assertNotIn(v, text, k)
        self.assertNotIn(SESSION, text)


class ConfiguredTests(Base):
    def test_required_five(self):
        self.assertTrue(ic.configured())
        os.environ["INTACCT_ENTITY_ID"] = ""
        self.assertTrue(ic.configured(), "the entity is optional")
        for k in ic.REQUIRED_ENV:
            v = os.environ.pop(k)
            self.assertFalse(ic.configured(), k)
            os.environ[k] = v

    def test_not_configured_reads_nothing(self):
        os.environ.pop("INTACCT_USER_PASSWORD")
        fake = FakeIntacct([])
        with self.assertRaises(ic.IntacctError) as e:
            ic.fetch_employees(post=fake)
        self.assertIn("not configured", str(e.exception))
        self.assertEqual(fake.calls, [])


class FlowTests(Base):
    def test_login_then_query_then_read_more(self):
        fake = FakeIntacct([
            (200, _ok(_session_result("https://api.intacct.com/ia/xml/xmlgw.phtml"))),
            (200, _ok(_data("readByQuery", [_emp_dotted("E100", "Bolanos, Amy", "amy@greensglobal.com", "15000", "Greens & Co"),
                                             _emp_dotted("E101", "Raj Patel", "raj@greensglobal.com")],
                            remaining=1, result_id="RID-77"))),
            (200, _ok(_data("readMore", [_emp_nested("E102", "Sam", "Lee", "sam@greensglobal.com")],
                            remaining=0, result_id="RID-77"))),
        ])
        out = ic.fetch_employees(post=fake)
        self.assertEqual([e["employeeId"] for e in out], ["E100", "E101", "E102"])

        login_body = fake.calls[0][1]
        self.assertIn("<senderid>SenderXYZ</senderid>", login_body)
        self.assertIn("<login><userid>nexus_api_user</userid><companyid>GreensCoTest</companyid>", login_body)
        self.assertIn("<locationid></locationid>", login_body)
        self.assertIn("<getAPISession/>", login_body)

        query_body = fake.calls[1][1]
        self.assertIn(f"<sessionid>{SESSION}</sessionid>", query_body)
        self.assertNotIn("<login>", query_body)
        self.assertIn("<readByQuery><object>EMPLOYEE</object>", query_body)
        for f in ("EMPLOYEEID", "PERSONALINFO.PRINTAS", "PERSONALINFO.EMAIL1", "STATUS", "LOCATIONID", "WHENMODIFIED"):
            self.assertIn(f, query_body)
        self.assertIn("<readMore><resultId>RID-77</resultId></readMore>", fake.calls[2][1])

        amy = out[0]
        self.assertEqual((amy["printAs"], amy["email"], amy["status"], amy["locationId"], amy["locationName"]),
                         ("Bolanos, Amy", "amy@greensglobal.com", "active", "15000", "Greens & Co"))
        self.assertEqual(amy["whenModified"], "10/01/2026 09:00:00")
        sam = out[2]   # nested <PERSONALINFO> form parses to the same keys
        self.assertEqual((sam["firstName"], sam["lastName"], sam["printAs"], sam["email"], sam["status"]),
                         ("Sam", "Lee", "Lee, Sam", "sam@greensglobal.com", "inactive"))

    def test_entity_goes_in_the_login(self):
        os.environ["INTACCT_ENTITY_ID"] = "ENT-200"
        fake = FakeIntacct([(200, _ok(_session_result())), (200, _ok(_data("readByQuery", [])))])
        self.assertEqual(ic.fetch_employees(post=fake), [])
        self.assertIn("<locationid>ENT-200</locationid>", fake.calls[0][1])

    def test_session_endpoint_must_be_intacct(self):
        fake = FakeIntacct([(200, _ok(_session_result("https://evil.example.com/xmlgw.phtml")))])
        with self.assertRaises(ic.IntacctError):
            ic.fetch_employees(post=fake)
        self.assertEqual(len(fake.calls), 1)

    def test_session_endpoint_is_used(self):
        ep = "https://na2.intacct.com/ia/xml/xmlgw.phtml"
        fake = FakeIntacct([(200, _ok(_session_result(ep))), (200, _ok(_data("readByQuery", [])))])
        ic.fetch_employees(post=fake)
        self.assertEqual(fake.calls[1][0], ep)

    def test_unknown_location_name_field_is_dropped_once(self):
        fake = FakeIntacct([
            (200, _ok(_session_result())),
            (200, _failure("Invalid field LOCATIONNAME for object EMPLOYEE")),
            (200, _ok(_data("readByQuery", [_emp_dotted("E100", "Amy Bolanos", "amy@greensglobal.com")]))),
        ])
        out = ic.fetch_employees(post=fake)
        self.assertEqual([e["employeeId"] for e in out], ["E100"])
        self.assertNotIn("LOCATIONNAME", fake.calls[2][1])

    def test_rows_without_an_id_are_dropped(self):
        fake = FakeIntacct([(200, _ok(_session_result())),
                            (200, _ok(_data("readByQuery", [_emp_dotted("", "Ghost", ""), _emp_dotted("E1", "A B", "")])))])
        self.assertEqual([e["employeeId"] for e in ic.fetch_employees(post=fake)], ["E1"])


class ErrorTests(Base):
    def _err(self, answers):
        fake = FakeIntacct(answers)
        with self.assertRaises(ic.IntacctError) as e:
            ic.fetch_employees(post=fake)
        msg = str(e.exception)
        self.assertNoSecrets(msg)
        return msg

    def test_sign_in_failure_scrubs_credentials(self):
        body = ("<response><control><status>success</status></control><operation><authentication>"
                "<status>failure</status></authentication><errormessage><error><errorno>XL03000006</errorno>"
                "<description></description><description2>Sign-in information is incorrect for user nexus_api_user "
                "in company GreensCoTest (password user-Secret-456)</description2></error></errormessage></operation></response>")
        msg = self._err([(200, body)])
        self.assertIn("sign-in failed", msg)
        self.assertIn("Sign-in information is incorrect", msg)

    def test_control_failure_scrubs_sender(self):
        body = ("<response><control><status>failure</status></control><errormessage><error><errorno>XL03000006</errorno>"
                "<description>Invalid Web Services Authorization</description><description2>The sender ID SenderXYZ "
                "is not authorized for company GreensCoTest</description2></error></errormessage></response>")
        msg = self._err([(200, body)])
        self.assertIn("not authorized", msg)

    def test_query_failure_scrubs_session(self):
        msg = self._err([(200, _ok(_session_result())),
                         (200, _failure(f"Session {SESSION} expired"))])
        self.assertIn("expired", msg)

    def test_http_error_and_network_error(self):
        msg = self._err([(503, "<html>down</html>")])
        self.assertIn("HTTP 503", msg)
        msg = self._err([(200, httpx.ConnectTimeout("timed out"))])
        self.assertIn("Could not reach Intacct", msg)

    def test_not_xml_and_doctype_refused(self):
        self.assertIn("not valid XML", self._err([(200, "not xml at all <")]))
        evil = ("<?xml version=\"1.0\"?><!DOCTYPE r [<!ENTITY a \"aaaa\"><!ENTITY b \"&a;&a;&a;\">]>"
                "<response><control><status>&b;</status></control></response>")
        self.assertIn("unexpected document", self._err([(200, evil)]))

    def test_no_session_id(self):
        body = _ok("<result><status>success</status><function>getAPISession</function><data><api>"
                   "<sessionid></sessionid></api></data></result>")
        self.assertIn("did not open a session", self._err([(200, body)]))


if __name__ == "__main__":
    unittest.main()
