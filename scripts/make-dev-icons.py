#!/usr/bin/env python3
"""Regenerate the purple dev icon set from the shipped app icon.

The output of this script is committed (`src-tauri/icons/dev/`), so a fresh
clone can `make dev` without Pillow or the Tauri CLI installed. Run it only when
the real icon changes.

    python3 scripts/make-dev-icons.py

Why a tint rather than separate artwork: a `make dev` window sitting next to the
installed voidlink in the dock has to be tellable apart at a glance, but it is
still the same app — same silhouette, different colour. The mapping below sends
icon luminance through a dark-purple → near-white ramp, so the rounded square
turns deep violet while the `<V/>` glyph stays legible.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src-tauri" / "icons" / "icon.png"
OUT_DIR = ROOT / "src-tauri" / "icons" / "dev"

# Endpoints of the ramp. Dark end matches the `.dev-chrome` title-bar purple in
# `frontend/src/index.css`; keep the two in step so the window and its dock icon
# read as the same signal.
DARK = (59, 7, 100)      # #3b0764
LIGHT = (237, 233, 254)  # #ede9fe

# The five entries `bundle.icon` actually lists. Everything else the Tauri CLI
# emits (mobile assets, Windows Store logos) is dead weight for a dev-only set.
KEEP = {"32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico"}


def tint(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGBA")
    pixels = img.load()
    width, height = img.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            # Rec. 601 luma is close enough for a two-tone mark.
            t = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
            pixels[x, y] = (
                round(DARK[0] + (LIGHT[0] - DARK[0]) * t),
                round(DARK[1] + (LIGHT[1] - DARK[1]) * t),
                round(DARK[2] + (LIGHT[2] - DARK[2]) * t),
                a,
            )
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst)


def main() -> None:
    if not SOURCE.exists():
        sys.exit(f"missing source icon: {SOURCE}")
    base = OUT_DIR / "icon.png"
    tint(SOURCE, base)
    print(f"tinted → {base.relative_to(ROOT)}")

    if shutil.which("cargo-tauri") is None and shutil.which("tauri") is None:
        sys.exit("cargo-tauri not found; install it to generate the icns/ico set")
    subprocess.run(
        ["cargo", "tauri", "icon", str(base), "--output", str(OUT_DIR)],
        cwd=ROOT / "src-tauri",
        check=True,
    )

    for path in sorted(OUT_DIR.iterdir()):
        if path.name == "icon.png" or path.name in KEEP:
            continue
        shutil.rmtree(path) if path.is_dir() else path.unlink()
        print(f"pruned  {path.name}")


if __name__ == "__main__":
    main()
