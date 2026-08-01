#!/usr/bin/env python3
"""Generate the bundled notification cues.

Run from `src-tauri/`:  python3 tools/gen-sounds.py

Deliberately dependency-free — stdlib only, PCM written by hand. A generator
that needed a package installed is one nobody runs, and then the assets stop
being reproducible and start being binaries of unknown origin. See
`resources/sounds/LICENSE.md`.

Every cue is a sum of sine partials under an exponential envelope. The envelope
matters more than the pitches: a tone with a hard edge clicks, and a click is
the one thing a notification sound is not allowed to do.
"""
import math
import os
import struct

RATE = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "resources", "sounds", "default")


def env(i, n, attack=0.01, release=0.6):
    """Linear attack, exponential release."""
    a = int(RATE * attack)
    if i < a:
        return i / a
    t = (i - a) / max(1, (n - a))
    return math.exp(-t / release) * (1 - t) ** 0.5


def tone(partials, dur, gain=0.5):
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        s = sum(amp * math.sin(2 * math.pi * f * t) for f, amp in partials)
        out.append(s * env(i, n) * gain)
    return out


def seq(*segments):
    """Concatenate with overlap, so notes ring into each other."""
    out = []
    for samples, offset in segments:
        start = int(RATE * offset)
        if len(out) < start + len(samples):
            out.extend([0.0] * (start + len(samples) - len(out)))
        for i, s in enumerate(samples):
            out[start + i] += s
    return out


def bell(f, dur=0.55, gain=0.45):
    """Fundamental, a fifth, and two quiet upper partials."""
    return tone([(f, 1.0), (f * 1.5, 0.30), (f * 2.0, 0.18), (f * 3.01, 0.06)], dur, gain)


def write(name, samples):
    peak = max(1e-9, max(abs(s) for s in samples))
    if peak > 0.95:
        samples = [s * 0.95 / peak for s in samples]
    frames = b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16))
        f.write(b"data" + struct.pack("<I", len(frames)) + frames)
    print(f"{name}: {os.path.getsize(path)} bytes")


def main():
    write("turn-finished.wav", seq((bell(659.25), 0.0), (bell(830.61), 0.09)))
    write("turn-failed.wav", seq((bell(415.30, 0.5), 0.0), (bell(392.00, 0.7), 0.10)))
    write("attention.wav", seq((bell(587.33, 0.42, 0.38), 0.0)))
    write("conflict.wav", seq((bell(293.66, 0.65), 0.0), (bell(415.30, 0.75), 0.13)))
    write(
        "run-adopted.wav",
        seq((bell(523.25), 0.0), (bell(659.25), 0.08), (bell(783.99, 0.7), 0.16)),
    )


if __name__ == "__main__":
    main()
