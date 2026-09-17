"""Company logo upload accepts MP4 (Sep 17, Pranshu). Converts it server-side
to an animated GIF - the only animated-image format email clients actually
auto-play. A raw MP4 can never play inside a sent email signature; no mail
client executes <video>, so this conversion is the entire point, not an
optimization.

Deliberately capped (6s / 300px tall / ~2MB) so a signature logo can't turn
into a multi-megabyte attachment on every outgoing email - oversized inline
images are a real deliverability hit (spam scoring, slow-loading mail on a
weak connection). If a source video can't fit even at the minimum quality
this drops to, upload fails with a clear reason rather than silently
producing something enormous.
"""
import io

import imageio.v3 as iio
from PIL import Image

MAX_SECONDS = 6
MAX_HEIGHT_PX = 300
TARGET_FPS = 12
MAX_GIF_BYTES = 2 * 1024 * 1024          # 2 MB
MAX_SOURCE_VIDEO_BYTES = 40 * 1024 * 1024  # raw upload cap, before conversion


class VideoConversionError(Exception):
    pass


def mp4_to_gif(data: bytes) -> bytes:
    """Decode an MP4's frames and re-encode as an animated GIF, downsampling
    fps/resolution/frame count until it fits MAX_GIF_BYTES or giving up."""
    try:
        meta = iio.immeta(io.BytesIO(data), extension=".mp4", plugin="FFMPEG")
    except Exception as exc:  # noqa: BLE001 - ffmpeg failures are all "can't read this file"
        # imageio's ffmpeg plugin bakes the full subprocess stderr (build
        # config, library versions, everything) into str(exc) - fine for a
        # server log, not something to hand back as an API error message.
        raise VideoConversionError("Could not read video - is it a valid MP4 file?") from exc

    src_fps = meta.get("fps") or 24
    step = max(1, round(src_fps / TARGET_FPS))
    max_frames = int(MAX_SECONDS * TARGET_FPS)

    frames = []
    try:
        for i, frame in enumerate(iio.imiter(io.BytesIO(data), extension=".mp4", plugin="FFMPEG")):
            if i % step != 0:
                continue
            img = Image.fromarray(frame).convert("RGB")
            if img.height > MAX_HEIGHT_PX:
                ratio = MAX_HEIGHT_PX / img.height
                img = img.resize((max(1, round(img.width * ratio)), MAX_HEIGHT_PX))
            frames.append(img)
            if len(frames) >= max_frames:
                break
    except Exception as exc:  # noqa: BLE001 - same rationale as above, keep the API message short
        raise VideoConversionError("Could not decode video frames - try a different file") from exc

    if not frames:
        raise VideoConversionError("Video has no readable frames")

    # Shrink frame count (keep every Nth) until the encoded GIF fits the cap -
    # cheaper than re-decoding at a lower resolution, and duration/step stay
    # proportional so playback speed doesn't visibly change.
    candidate = frames
    while True:
        buf = io.BytesIO()
        duration_ms = int(1000 / TARGET_FPS) * max(1, len(frames) // len(candidate))
        candidate[0].save(
            buf, format="GIF", save_all=True, append_images=candidate[1:],
            duration=duration_ms, loop=0, optimize=True,
        )
        out = buf.getvalue()
        if len(out) <= MAX_GIF_BYTES or len(candidate) <= 2:
            if len(out) > MAX_GIF_BYTES:
                raise VideoConversionError(
                    f"Converted GIF is still {len(out) // 1024}KB after reducing quality - "
                    "try a shorter or simpler video"
                )
            return out
        candidate = candidate[::2]  # halve frame count, try again
