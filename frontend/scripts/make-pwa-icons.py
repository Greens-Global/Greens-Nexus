"""Draw the Nexus app icons for the PWA manifest (Frontline Reach, Nov 2026).

The mark is the login "N" badge (public/favicon.svg): a green rounded square
with a white N. PNGs are what iOS and Android launchers want; this renders
them with Pillow from the same geometry, so nothing is traced by hand.

Run once from frontend/: ../backend/.venv/bin/python scripts/make-pwa-icons.py
Outputs public/icons/nexus-{192,512}.png, nexus-maskable-512.png (the mark
inside the 80% safe zone on a full green tile), apple-touch-icon-180.png
(no transparency, square corners - iOS rounds them) and nexus-badge-96.png
(white N on transparent, the notification badge).
"""
from pathlib import Path

from PIL import Image, ImageDraw

GREEN = (36, 143, 75, 255)      # #248f4b, the favicon's fill
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"

# The N as the favicon draws it, on a 64-unit grid:
#   M19 46 V18 h8 l10 17 V18 h8 v28 h-8 L27 29 v17 z
N_PATH = [(19, 46), (19, 18), (27, 18), (37, 35), (37, 18), (45, 18), (45, 46), (37, 46), (27, 29), (27, 46)]


def draw_n(img: Image.Image, box: tuple, color=WHITE) -> None:
    """The N fitted into `box` (x0, y0, x1, y1) of the image, from the 64-grid."""
    x0, y0, x1, y1 = box
    sx = (x1 - x0) / 64.0
    sy = (y1 - y0) / 64.0
    pts = [(x0 + x * sx, y0 + y * sy) for x, y in N_PATH]
    ImageDraw.Draw(img).polygon(pts, fill=color)


def tile(size: int, radius_ratio: float, pad_ratio: float, transparent_corners: bool) -> Image.Image:
    """A green rounded square with the N; `pad_ratio` shrinks the mark into a
    safe zone (maskable icons are cropped to a circle by some launchers)."""
    scale = 4   # draw big, shrink for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0) if transparent_corners else GREEN)
    d = ImageDraw.Draw(img)
    r = int(s * radius_ratio)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=r, fill=GREEN)
    pad = int(s * pad_ratio)
    draw_n(img, (pad, pad, s - pad, s - pad))
    return img.resize((size, size), Image.LANCZOS)


def badge(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    pad = int(s * 0.08)
    draw_n(img, (pad, pad, s - pad, s - pad))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tile(192, 0.25, 0.0, True).save(OUT / "nexus-192.png")
    tile(512, 0.25, 0.0, True).save(OUT / "nexus-512.png")
    # Maskable: the launcher may crop to a circle, so the mark sits inside the
    # middle 80% on a full-bleed green square.
    tile(512, 0.0, 0.10, False).save(OUT / "nexus-maskable-512.png")
    # iOS wants an opaque square; it rounds the corners itself.
    tile(180, 0.0, 0.0, False).convert("RGB").save(OUT / "apple-touch-icon-180.png")
    badge(96).save(OUT / "nexus-badge-96.png")
    for p in sorted(OUT.glob("*.png")):
        print(f"{p.name:28} {p.stat().st_size:>6} bytes")


if __name__ == "__main__":
    main()
