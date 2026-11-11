"""Email signature: phone formatting, the link guard and every template's
render (Nov 2026 review: an extension printed a wrong number, India kept its
trunk 0, any scheme:// passed as a link).

Run alone: python -m unittest test_email_signature
"""
import html
import os
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite:///./_test_email_signature.db")
os.environ["NEXUS_SKIP_AUTH"] = "true"

from routers import myhr  # noqa: E402

fmt = myhr._format_signature_phone


class Phone(unittest.TestCase):
    def test_us(self):
        self.assertEqual(fmt("949-201-9160", "US"), "+1 (949) 201-9160")
        self.assertEqual(fmt("1 949 201 9160", "US"), "+1 (949) 201-9160")

    def test_extension_is_kept_apart(self):
        self.assertEqual(fmt("949-201-9160 x12", "US"), "+1 (949) 201-9160 ext. 12")
        self.assertEqual(fmt("(949) 201-9160 ext. 7", "US"), "+1 (949) 201-9160 ext. 7")
        self.assertEqual(fmt("07595898853 ext 3", "IN"), "+91 7595898853 ext. 3")

    def test_india_drops_trunk_zero(self):
        self.assertEqual(fmt("07595898853", "IN"), "+91 7595898853")
        self.assertEqual(fmt("7595898853", "IN"), "+91 7595898853")

    def test_left_alone(self):
        self.assertEqual(fmt("+44 20 7946 0958", "US"), "+44 20 7946 0958")
        self.assertEqual(fmt("0091 7595898853", "US"), "+917595898853")
        self.assertEqual(fmt("12345", "US"), "12345")     # not a NANP number
        self.assertEqual(fmt("555-1234", ""), "555-1234")  # no country, no guess
        self.assertEqual(fmt("", "US"), "")


class Links(unittest.TestCase):
    def test_only_http(self):
        n = myhr._normalize_url
        self.assertEqual(n("linkedin.com/in/x"), "https://linkedin.com/in/x")
        self.assertEqual(n("http://a.com"), "http://a.com")
        self.assertEqual(n("HTTPS://a.com"), "HTTPS://a.com")
        self.assertEqual(n("a.com:8080/x"), "https://a.com:8080/x")
        for bad in ("javascript://%0aalert(1)", "javascript:alert(1)", "data:text/html,x",
                    "vbscript:x", "file:///etc/passwd"):
            self.assertEqual(n(bad), "", bad)

    def test_bad_links_never_render(self):
        f = sample(facebookUrl="javascript://%0aalert(1)", website="javascript:alert(1)")
        for tid, (_, render) in myhr.SIGNATURE_TEMPLATES.items():
            out = render(f)
            self.assertNotIn('href="javascript', out, tid)
            self.assertNotIn("alert(1)\"", out, tid)   # never inside an attribute


def sample(**over):
    f = {"name": "Jane Doe", "role": "Manager", "phone": "+1 (949) 201-9160",
         "email": "jane@example.com", "photoUrl": "", "closing": "Best regards",
         "logoUrl": "https://x.supabase.co/logo.png", "website": "www.example.com",
         "address": "1 Main St", "companyPhone": "", "companyName": "Example",
         "facebookUrl": "facebook.com/x", "linkedinUrl": "linkedin.com/in/x",
         "twitterUrl": "", "instagramUrl": ""}
    f.update(over)
    return {k: html.escape(v) for k, v in f.items()}


class Templates(unittest.TestCase):
    def test_every_template_renders_the_person(self):
        for tid, (_, render) in myhr.SIGNATURE_TEMPLATES.items():
            out = render(sample())
            for part in ("Jane Doe", "jane@example.com", "https://facebook.com/x", "Best regards"):
                self.assertIn(part, out, (tid, part))

    def test_rows_state_their_own_size(self):
        # Pasted HTML loses inherited table font sizes - every row says its own.
        for tid in ("classic", "sincerely", "regards", "bold"):
            out = myhr.SIGNATURE_TEMPLATES[tid][1](sample())
            self.assertIn("line-height:18px", out, tid)


if __name__ == "__main__":
    unittest.main()
