"""Construction media storage: size limits and the Egnyte folder layout.

These are the rules a worker hits on a phone at a jobsite, so the failure modes
matter more than the happy path: a rejected upload means the day's update never
gets filed at all.

Run with: python -m unittest test_construction_storage -v
"""
import unittest

from services import construction_storage as cs

MB = 1024 * 1024


class ValidationTests(unittest.TestCase):
    def test_video_cap_is_100mb(self):
        """Matches routers/egnyte.py's MAX_UPLOAD_BYTES. That endpoint reads the
        whole file into the API process, so this is a memory budget on a gunicorn
        worker, not a preference somebody can raise casually."""
        self.assertEqual(cs.MAX_BYTES["video"], 100 * MB)
        self.assertEqual(cs.validate("video", 100 * MB, "video/mp4"), "")
        self.assertNotEqual(cs.validate("video", 100 * MB + 1, "video/mp4"), "")

    def test_oversize_message_names_the_size_and_the_limit(self):
        """"Upload failed" on a jobsite means the update is lost. The worker has
        to be told what to do instead."""
        msg = cs.validate("video", 250 * MB, "video/mp4")
        self.assertIn("250 MB", msg)
        self.assertIn("100 MB", msg)
        self.assertIn("shorter clip", msg)

    def test_heic_is_accepted(self):
        """It is the iPhone default. Rejecting it rejects half the workforce."""
        self.assertEqual(cs.validate("photo", 4 * MB, "image/heic"), "")
        self.assertIn("image/heic", cs.NEEDS_TRANSCODE_FOR_WEB)

    def test_wrong_format_for_kind_is_rejected(self):
        self.assertNotEqual(cs.validate("photo", 2 * MB, "video/mp4"), "")

    def test_empty_file_is_rejected(self):
        self.assertIn("empty", cs.validate("photo", 0, "image/jpeg").lower())

    def test_missing_mime_is_allowed_through(self):
        """Some Android browsers send no content type on a camera capture.
        Blocking on that would reject a valid photo for a client quirk; the
        extension and the size still gate it."""
        self.assertEqual(cs.validate("photo", 3 * MB, ""), "")


class FolderLayoutTests(unittest.TestCase):
    PROP = "/Shared/Properties/GSVC Valley Center"

    def test_matches_the_agreed_layout(self):
        self.assertEqual(
            cs.daily_log_folder(self.PROP, "2026-08-04"),
            f"{self.PROP}/Construction/Daily Logs/2026-08/2026-08-04",
        )

    def test_month_level_keeps_the_tree_browsable(self):
        """A 14-month job is 14 month folders, not 400 date folders in one list.
        People browse this in Egnyte's own UI."""
        a = cs.daily_log_folder(self.PROP, "2026-08-04")
        b = cs.daily_log_folder(self.PROP, "2026-09-04")
        self.assertIn("/2026-08/", a)
        self.assertIn("/2026-09/", b)

    def test_trailing_slash_on_property_folder_does_not_double_up(self):
        self.assertNotIn("//Construction", cs.daily_log_folder(self.PROP + "/", "2026-08-04"))

    def test_bad_date_raises_rather_than_filing_somewhere_wrong(self):
        """Silently filing under a malformed folder buries the media where
        nobody looks. Better to fail the sync and retry."""
        for bad in ("04-08-2026", "2026-8-4", "", "yesterday"):
            with self.assertRaises(ValueError):
                cs.daily_log_folder(self.PROP, bad)


class FilenameTests(unittest.TestCase):
    BASE = dict(uploaded_by="sagar.shoundik@greensglobal.com",
                taken_at="2026-08-04T09:13:22Z", uploaded_at="2026-08-04T21:40:00Z",
                kind="photo", mime_type="image/jpeg")

    def test_the_agreed_shape(self):
        self.assertEqual(
            cs.media_filename(**self.BASE, description="Formwork"),
            "sagar.shoundik-0913-formwork.jpg",
        )

    def test_taken_at_wins_over_uploaded_at(self):
        """A worker shoots at 09:13 and uploads at 21:40 from the truck. The
        filename records the moment on site, which is the point."""
        self.assertIn("-0913-", cs.media_filename(**self.BASE, description="x"))

    def test_falls_back_to_uploaded_at_when_exif_is_missing(self):
        kw = {**self.BASE, "taken_at": ""}
        self.assertIn("-2140-", cs.media_filename(**kw, description="x"))

    def test_camera_roll_names_are_not_used_as_descriptions(self):
        """IMG_4821 describes nothing. Using it would make every filename look
        meaningful and none be."""
        for junk in ("IMG_4821.jpg", "VID_20260804.mp4", "PXL_20260804_091322.jpg", "DCIM1234.jpg"):
            name = cs.media_filename(**self.BASE, original_name=junk, media_id="abc123def")
            self.assertNotIn("img", name.split("-")[-1].lower())
            self.assertNotIn("4821", name)

    def test_a_real_original_name_is_used(self):
        name = cs.media_filename(**self.BASE, original_name="north-wall-rebar.jpg")
        self.assertIn("north-wall-rebar", name)

    def test_no_description_gets_an_id_suffix_to_avoid_collision(self):
        """Two photos in the same minute by the same person would otherwise
        produce the same path, and Egnyte would overwrite or version one away."""
        a = cs.media_filename(**self.BASE, media_id="aaaaaa11")
        b = cs.media_filename(**self.BASE, media_id="bbbbbb22")
        self.assertNotEqual(a, b)

    def test_unsafe_characters_are_stripped(self):
        name = cs.media_filename(**self.BASE, description='north/wall: "east" side?')
        for ch in '\\/:*?"<>|':
            self.assertNotIn(ch, name)

    def test_long_description_cuts_on_a_word_boundary(self):
        name = cs.media_filename(
            **self.BASE,
            description="formwork north wall east elevation second pour section")
        slug = name.split("-", 2)[2].rsplit(".", 1)[0]
        self.assertLessEqual(len(slug), 28)
        self.assertFalse(slug.endswith("-"))

    def test_extension_comes_from_mime_not_the_client_filename(self):
        """A client that sends `photo.png` for a JPEG should not have the wrong
        extension filed into the record copy."""
        kw = {**self.BASE, "mime_type": "image/jpeg"}
        self.assertTrue(cs.media_filename(**kw, original_name="photo.png").endswith(".jpg"))


class SupabasePathTests(unittest.TestCase):
    def test_is_id_keyed_not_date_keyed(self):
        """The opposite of the Egnyte path on purpose: nobody browses this
        bucket, and a link already printed into a published report must not break
        when the file is renamed or re-filed in Egnyte."""
        p = cs.supabase_path(project_id="p1", media_id="m1", mime_type="image/jpeg")
        self.assertEqual(p, "construction/p1/m1.jpg")

    def test_unknown_mime_still_produces_a_path(self):
        p = cs.supabase_path(project_id="p1", media_id="m1", mime_type="application/x-weird")
        self.assertTrue(p.endswith(".bin"))


class EgnyteReadinessTests(unittest.TestCase):
    def setUp(self):
        import os
        self._saved = {k: os.environ.get(k) for k in ("EGNYTE_DOMAIN", "EGNYTE_TOKEN")}

    def tearDown(self):
        import os
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_unconfigured_is_reported_not_raised(self):
        """Media must still upload when Egnyte is not connected - the row sits at
        egnyte_status='pending' and the sweep files it later. Failing the
        worker's upload for an operator problem loses the day's update."""
        import os
        os.environ.pop("EGNYTE_DOMAIN", None)
        os.environ.pop("EGNYTE_TOKEN", None)
        self.assertFalse(cs.egnyte_ready())

    def test_both_vars_are_required(self):
        import os
        os.environ["EGNYTE_DOMAIN"] = "greens.egnyte.com"
        os.environ.pop("EGNYTE_TOKEN", None)
        self.assertFalse(cs.egnyte_ready())
        os.environ["EGNYTE_TOKEN"] = "tok"
        self.assertTrue(cs.egnyte_ready())


class ThumbnailTests(unittest.TestCase):
    def test_path_is_derived_from_the_serving_key(self):
        """Derived, never independently constructed - two ways of building the
        key is how a thumbnail ends up orphaned from the photo it belongs to."""
        self.assertEqual(
            cs.thumbnail_path("construction/p1/abc-123.jpg"),
            "construction/p1/abc-123-thumb.jpg")

    def test_thumbnail_is_always_jpeg(self):
        """A 480px tile does not need PNG's lossless fidelity, and JPEG is the
        smallest thing every browser renders."""
        self.assertTrue(cs.thumbnail_path("construction/p1/shot.png").endswith("-thumb.jpg"))
        self.assertTrue(cs.thumbnail_path("construction/p1/shot.webp").endswith("-thumb.jpg"))

    def test_empty_path_raises_rather_than_producing_a_bare_suffix(self):
        """Without this, "" yields "-thumb.jpg" at the bucket root, which would
        collide across every project on the very first upload."""
        with self.assertRaises(ValueError):
            cs.thumbnail_path("")

    def test_heic_is_not_thumbnailed(self):
        """Decoding HEIC needs pillow-heif, which is not installed. The client
        already converts (toWebSafe); when that fails the original lands here and
        must be skipped cleanly rather than failing a job four times."""
        self.assertFalse(cs.can_thumbnail("photo", "image/heic"))
        self.assertFalse(cs.can_thumbnail("photo", "image/heif"))

    def test_only_photos_are_thumbnailed(self):
        """Video needs a frame extracted first and there is no ffmpeg here;
        audio has no still frame at all."""
        self.assertFalse(cs.can_thumbnail("video", "video/mp4"))
        self.assertFalse(cs.can_thumbnail("audio", "audio/mpeg"))
        self.assertTrue(cs.can_thumbnail("photo", "image/jpeg"))

    def test_mime_parameters_and_casing_are_tolerated(self):
        """Browsers send 'image/jpeg; charset=binary' and phones vary the case.
        Rejecting either would silently drop thumbnails for whole device
        families."""
        self.assertTrue(cs.can_thumbnail("photo", "IMAGE/JPEG"))
        self.assertTrue(cs.can_thumbnail("photo", "image/jpeg; charset=binary"))


class InlineMediaTests(unittest.TestCase):
    """Rows whose bytes live in the row itself, as a base64 data: URL.

    Only produced when the client has no Supabase configured - which on dev and
    prod never happens - so this is the path that makes the module testable on a
    laptop with nothing but SQLite."""

    def test_data_urls_are_recognized(self):
        self.assertTrue(cs.is_inline("data:image/jpeg;base64,/9j/4AAQSkZJRg=="))

    def test_real_object_urls_are_not(self):
        self.assertFalse(cs.is_inline("https://xyz.supabase.co/storage/v1/object/public/x/y.jpg"))
        self.assertFalse(cs.is_inline(""))
        self.assertFalse(cs.is_inline(None))

    def test_a_url_merely_containing_data_is_not_inline(self):
        """Substring matching here would mark a real object inline and silently
        skip filing its record copy to Egnyte."""
        self.assertFalse(cs.is_inline("https://cdn.example.com/data:image/x.jpg"))
        self.assertFalse(cs.is_inline("https://example.com/my-data:set.png"))


if __name__ == "__main__":
    unittest.main()
