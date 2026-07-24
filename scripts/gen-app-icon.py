#!/usr/bin/env python3
"""Generate the macOS-geometry app icon source from the master artwork.

macOS expects a 1024x1024 icon canvas where the artwork body is an 824x824
rounded square (corner radius 185.4) centred with a 100px transparent margin
on every side. A full-bleed square renders visibly larger and squarer than
every neighbouring app in the Dock.

The Tauri CLI's `icon` subcommand only rescales its source — it never adds
padding or a squircle mask — so the padding and mask have to be baked into the
source PNG first.

Usage (from the repo root):

    python3 scripts/gen-app-icon.py
    cd src-tauri && npx @tauri-apps/cli icon ../app-icon-macos.png

Input:  app-icon.png        full-bleed master artwork (square, any size)
Output: app-icon-macos.png  1024x1024 padded + masked source for the Tauri CLI

The padded source deliberately lives outside `src-tauri/icons/` because the
Tauri CLI writes `icons/icon.png` itself — generating into that directory would
make the next run rescale its own output.

Requires Pillow (`python3 -m pip install --user Pillow`).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024
BODY = 824
RADIUS = 185.4
MARGIN = (CANVAS - BODY) // 2
# The mask is drawn at 4x and downsampled so the corner arc is smoothly
# antialiased instead of stair-stepped.
SUPERSAMPLE = 4

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / "app-icon.png"
TARGET = REPO_ROOT / "app-icon-macos.png"


def rounded_mask(size: int, radius: float) -> Image.Image:
    """An L-mode rounded-square mask with antialiased corners."""
    hi = size * SUPERSAMPLE
    mask = Image.new("L", (hi, hi), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, hi - 1, hi - 1),
        radius=round(radius * SUPERSAMPLE),
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def dominant_opaque_color(image: Image.Image) -> tuple[int, int, int]:
    """The most common fully opaque RGB value — the artwork's flat backdrop."""
    colors = image.getcolors(maxcolors=image.width * image.height)
    if colors is None:
        raise SystemExit(f"{SOURCE} has too many distinct colors to sample")
    opaque = [(count, px[:3]) for count, px in colors if px[3] == 255]
    if not opaque:
        raise SystemExit(f"{SOURCE} has no opaque pixels")
    return max(opaque)[1]


def main() -> int:
    if not SOURCE.exists():
        raise SystemExit(f"missing master artwork: {SOURCE}")

    master = Image.open(SOURCE).convert("RGBA")
    if master.width != master.height:
        raise SystemExit(f"{SOURCE} must be square, got {master.size}")

    # Composite the artwork over its own flat backdrop first. The master's own
    # corner arc is slightly wider than the macOS one, so without this the few
    # pixels the new mask reveals would be undefined (transparent black).
    body = Image.new("RGBA", (BODY, BODY), dominant_opaque_color(master) + (255,))
    body.alpha_composite(master.resize((BODY, BODY), Image.LANCZOS))
    body.putalpha(rounded_mask(BODY, RADIUS))

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(body, (MARGIN, MARGIN))
    canvas.save(TARGET, format="PNG")

    print(f"wrote {TARGET.relative_to(REPO_ROOT)} ({CANVAS}x{CANVAS}, body {BODY}, margin {MARGIN})")
    print("next: cd src-tauri && npx @tauri-apps/cli icon ../app-icon-macos.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
