"""construction-media joins the private evidence buckets (Sep 30 review).

Jobsite daily-log photos were served from a public bucket. The bucket is now
in BOTH PROTECTED_BUCKETS lists (backend files.py, frontend storageView.js),
so browsers open it through GET /files/view, and the background jobs that
used to GET the canonical public URL (Egnyte filing, thumbnails, the AI
caption, the PDF export) go through files.fetchable_url, which signs it.

No database. Run with: python -m pytest test_construction_media_private.py
"""
import os
import re
import tempfile
import unittest
from unittest import mock

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/construction_media_test.db"
os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "service-key"

from routers import files  # noqa: E402  (env must be set first)

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = "https://proj.supabase.co/storage/v1/object/public"
PHOTO = f"{PUB}/construction-media/construction/p1/abc.jpg"


class _Resp:
    status_code = 200

    def __init__(self, url="https://signed.example/x?token=t"):
        self._url = url
        self.content = b"img"

    def json(self):
        return {"signedURL": "/object/sign/construction-media/construction/p1/abc.jpg?token=t"}

    def raise_for_status(self):
        pass


class ConstructionMediaPrivateTests(unittest.TestCase):
    def setUp(self):
        files._cache.clear()

    def test_the_bucket_is_protected_on_both_sides(self):
        self.assertIn("construction-media", files.PROTECTED_BUCKETS)
        with open(os.path.join(HERE, "..", "frontend", "src", "lib", "storageView.js"), encoding="utf-8") as f:
            m = re.search(r"export const PROTECTED_BUCKETS = \[([^\]]*)\]", f.read())
        front = set(re.findall(r"'([^']+)'", m.group(1)))
        self.assertEqual(front, set(files.PROTECTED_BUCKETS))

    def test_the_viewer_accepts_a_construction_photo(self):
        self.assertEqual(files.parse_public_url(PHOTO),
                         ("construction-media", "construction/p1/abc.jpg"))

    def test_server_side_fetches_get_a_signed_url(self):
        with mock.patch.object(files.httpx, "post", return_value=_Resp()) as post:
            url = files.fetchable_url(PHOTO)
        self.assertTrue(url.startswith("https://proj.supabase.co/storage/v1/object/sign/construction-media/"))
        self.assertIn("/object/sign/construction-media/construction/p1/abc.jpg", post.call_args[0][0])

    def test_anything_else_passes_through(self):
        with mock.patch.object(files.httpx, "post") as post:
            for u in (f"{PUB}/avatars/me.png", "data:image/png;base64,AAAA", "https://example.com/x.jpg", ""):
                self.assertEqual(files.fetchable_url(u), u)
        post.assert_not_called()

    def test_the_pdf_export_fetches_the_signed_url(self):
        import construction_pdf
        seen = []

        class _Client:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get(self, url):
                seen.append(url)
                return _Resp()

        with mock.patch.object(files.httpx, "post", return_value=_Resp()), \
                mock.patch("httpx.Client", _Client):
            self.assertEqual(construction_pdf._fetch(PHOTO, "p1"), b"img")
        self.assertEqual(len(seen), 1)
        self.assertIn("/object/sign/construction-media/", seen[0])

    def test_the_worker_uses_the_same_helper(self):
        """Every server-side fetch goes through construction_storage.fetch_url,
        which signs through files.fetchable_url (11/03/2026)."""
        from services import construction_storage as storage
        with mock.patch.object(files.httpx, "post", return_value=_Resp()):
            self.assertIn("/object/sign/construction-media/", storage.fetch_url(PHOTO, "p1"))

    def test_the_pdf_refuses_a_link_outside_the_jobs_storage(self):
        import construction_pdf
        for u in ("https://example.com/x.jpg", f"{PUB}/task-files/secret.pdf",
                  f"{PUB}/construction-media/construction/other/abc.jpg",
                  "http://169.254.169.254/latest/meta-data"):
            with self.assertRaises(ValueError):
                construction_pdf._fetch(u, "p1")


if __name__ == "__main__":
    unittest.main()
