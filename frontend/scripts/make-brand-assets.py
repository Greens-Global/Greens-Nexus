"""Cut the Nexus brand assets from the logo files (Pranshu, 11/15/2026).

The files the designer sent (frontend/brand-src/) have a solid black
background baked in, not transparency. This keys that black to alpha and
writes what the app uses, so nothing is traced or edited by hand:

  public/brand/nexus-mark.png          the ring mark, transparent, 512 px
                                       (Welcome to Nexus)
  public/brand/nexus-n.png             the two-figure N alone, transparent -
                                       the small sizes (the sidebar, Help, the
                                       tab and launcher icons), where the
                                       ring's icons would be mush
  public/brand/nexus-lockup-white.png  ring + white "Nexus" wordmark, the
                                       tagline removed, a white disc under
                                       the ring so it stands off the dark
                                       green login panel (white text: dark
                                       backgrounds only)
  public/icons/nexus-{192,512}.png     the N on a white rounded tile
  public/icons/nexus-maskable-512.png  the N inside the 80% safe zone of a
                                       white square (launchers crop circles)
  public/icons/apple-touch-icon-180.png  opaque white square (iOS rounds it)
  public/favicon-32.png                the browser tab

nexus-badge-96.png (the notification badge) stays the white N: a badge must
be one flat color, and the ring is not.

Run from frontend/: python scripts/make-brand-assets.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand-src"
BRAND = ROOT / "public" / "brand"
ICONS = ROOT / "public" / "icons"
WHITE = (255, 255, 255, 255)
BLACK_MAX = 60   # r+g+b at or under this is the baked-in background


def keyed(im: Image.Image) -> Image.Image:
    """The image with its black background turned transparent."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, _a = px[x, y]
            if r + g + b <= BLACK_MAX:
                px[x, y] = (0, 0, 0, 0)
    return im


def fit(im: Image.Image, size: int) -> Image.Image:
    return im.resize((size, size), Image.LANCZOS)


def squared(path: Path) -> Image.Image:
    """The keyed image, cropped to its content and centered on a square."""
    im = keyed(Image.open(path))
    im = im.crop(im.getbbox())
    side = max(im.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.alpha_composite(im, ((side - im.width) // 2, (side - im.height) // 2))
    return sq


def tile(mark: Image.Image, size: int, radius_ratio: float, pad_ratio: float, transparent_corners: bool) -> Image.Image:
    """The mark on a white tile; `pad_ratio` shrinks it into a safe zone."""
    scale = 2
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0) if transparent_corners else WHITE)
    ImageDraw.Draw(img).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * radius_ratio), fill=WHITE)
    pad = int(s * pad_ratio)
    img.alpha_composite(fit(mark, s - 2 * pad), (pad, pad))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    ring = squared(SRC / "nexus-mark-1024.png")
    fit(ring, 512).save(BRAND / "nexus-mark.png", optimize=True)
    n_mark = squared(SRC / "nexus-n-1024.png")
    fit(n_mark, 512).save(BRAND / "nexus-n.png", optimize=True)

    # The lockup minus its tagline: blank the tagline band (below the word,
    # right of the ring) before keying, crop to what is left, then put a
    # white disc under the ring - on the green login panel the ring's green
    # segments otherwise melt into the background (Pranshu, 11/15/2026).
    lockup = Image.open(SRC / "nexus-lockup-2000x720.png").convert("RGBA")
    w, h = lockup.size
    lockup.paste((0, 0, 0, 255), (int(w * 0.37), int(h * 0.64), w, h))
    cut = keyed(lockup)
    cut = cut.crop(cut.getbbox())
    # The ring is the leftmost square of the crop (its height).
    r = cut.height / 2
    cx, cy = r, r
    disc = Image.new("RGBA", cut.size, (0, 0, 0, 0))
    grow = r * 0.06
    ImageDraw.Draw(disc).ellipse((cx - r - grow, cy - r - grow, cx + r + grow, cy + r + grow), fill=WHITE)
    disc.alpha_composite(cut)
    disc.save(BRAND / "nexus-lockup-white.png", optimize=True)

    # Tab and launcher icons: the N on white, padded so it never touches the
    # tile's edge.
    tile(n_mark, 192, 0.22, 0.14, True).save(ICONS / "nexus-192.png", optimize=True)
    tile(n_mark, 512, 0.22, 0.14, True).save(ICONS / "nexus-512.png", optimize=True)
    tile(n_mark, 512, 0.0, 0.20, False).save(ICONS / "nexus-maskable-512.png", optimize=True)
    tile(n_mark, 180, 0.0, 0.14, False).convert("RGB").save(ICONS / "apple-touch-icon-180.png", optimize=True)
    fit(n_mark, 64).save(ROOT / "public" / "favicon-32.png", optimize=True)

    for p in [*sorted(BRAND.glob("*.png")), *sorted(ICONS.glob("*.png")), ROOT / "public" / "favicon-32.png"]:
        im = Image.open(p)
        print(f"{str(p.relative_to(ROOT)):40} {im.size[0]}x{im.size[1]} {p.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
