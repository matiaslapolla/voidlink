/// CSS colour → hex, for the one consumer that cannot take a CSS colour.
///
/// Monaco's theme API predates CSS Color 4: `defineTheme` accepts `#RRGGBB` /
/// `#RRGGBBAA` strings and nothing else — no `oklch()`, no `var()`. VoidLink's
/// tokens are written in `oklch` (and the named themes in `themes.css` too), so
/// deriving a Monaco theme from those tokens means converting them here rather
/// than maintaining a second, hardcoded palette that silently drifts.
///
/// Deliberately not a general colour library: it handles exactly the notations
/// `index.css` and `themes.css` actually use — `oklch()`, hex, `rgb()/rgba()` —
/// and returns opaque-or-alpha hex. Anything it cannot parse returns `null` so
/// the caller can fall back rather than render a black editor.

/// A colour in gamma-encoded sRGB, channels and alpha 0–1.
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/// `0.5`, `50%`, `.5` → 0.5. Returns `NaN` for anything else.
function num(token: string, percentBase = 1): number {
  const t = token.trim();
  if (t.endsWith("%")) return (parseFloat(t.slice(0, -1)) / 100) * percentBase;
  return parseFloat(t);
}

/// sRGB transfer function (linear → gamma-encoded), per IEC 61966-2-1.
function encodeSrgb(c: number): number {
  const abs = Math.abs(c);
  const enc = abs <= 0.0031308 ? abs * 12.92 : 1.055 * Math.pow(abs, 1 / 2.4) - 0.055;
  return c < 0 ? -enc : enc;
}

/// Oklab → linear sRGB, using Björn Ottosson's published matrices. Kept
/// verbatim rather than folded into a matrix helper: the constants *are* the
/// specification, and a transcription error here is invisible until someone
/// notices the editor is slightly the wrong green.
function oklabToRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/// Split the inside of a `fn(...)` into its component tokens and its optional
/// `/ alpha`. Handles both the legacy comma form and the modern space form.
function splitArgs(inner: string): { parts: string[]; alpha: string | null } {
  const [head, alphaPart] = inner.split("/");
  const parts = head
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  return { parts, alpha: alphaPart?.trim() ?? null };
}

function parseHex(value: string): Rgba | null {
  const hex = value.slice(1);
  const expand = (h: string) => parseInt(h.length === 1 ? h + h : h, 16) / 255;
  if (hex.length === 3 || hex.length === 4) {
    return {
      r: expand(hex[0]),
      g: expand(hex[1]),
      b: expand(hex[2]),
      a: hex.length === 4 ? expand(hex[3]) : 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: expand(hex.slice(0, 2)),
      g: expand(hex.slice(2, 4)),
      b: expand(hex.slice(4, 6)),
      a: hex.length === 8 ? expand(hex.slice(6, 8)) : 1,
    };
  }
  return null;
}

const FUNCTIONAL = /^([a-z]+)\((.*)\)$/;

/// Parse any colour notation the token files use into gamma-encoded sRGB 0–1.
/// Returns `null` rather than throwing — a malformed token is a styling bug,
/// not a reason to fail an editor mount.
export function parseCssColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (value.startsWith("#")) return parseHex(value);

  const fn = value.match(FUNCTIONAL);
  if (!fn) return null;
  const [, name, inner] = fn;
  const { parts, alpha } = splitArgs(inner);
  if (parts.length < 3) return null;
  const a = alpha === null ? 1 : clamp01(num(alpha));

  if (name === "rgb" || name === "rgba") {
    // The legacy `rgba(r, g, b, a)` form puts alpha in the fourth component.
    const legacyAlpha = parts.length === 4 ? clamp01(num(parts[3])) : a;
    return {
      r: num(parts[0], 255) / 255,
      g: num(parts[1], 255) / 255,
      b: num(parts[2], 255) / 255,
      a: legacyAlpha,
    };
  }

  if (name === "oklch" || name === "oklab") {
    // `num` already maps `%` to 0–1, which is exactly oklch's lightness scale.
    const L = num(parts[0]);
    const c1 = num(parts[1]);
    const c2 = num(parts[2]);
    const lab =
      name === "oklch"
        ? { a: c1 * Math.cos((c2 * Math.PI) / 180), b: c1 * Math.sin((c2 * Math.PI) / 180) }
        : { a: c1, b: c2 };
    const linear = oklabToRgb(L, lab.a, lab.b);
    return {
      r: encodeSrgb(linear.r),
      g: encodeSrgb(linear.g),
      b: encodeSrgb(linear.b),
      a,
    };
  }

  return null;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function channelHex(n: number): string {
  return Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, "0");
}

export interface ToHexOptions {
  /// Multiply the parsed alpha by this. `0.15` applied to a token that is
  /// already 10% opaque gives 1.5% — the caller owns that being intentional.
  alpha?: number;
  /// Composite the (possibly translucent) colour over this one and return an
  /// opaque hex. Monaco treats a few colour ids (`editor.background`) as opaque
  /// surfaces and renders alpha there as a hole, so those go through this.
  over?: string;
}

/// A CSS colour as `#RRGGBB` (opaque) or `#RRGGBBAA`. `null` when the input
/// cannot be parsed, so callers can drop the key instead of guessing black.
export function cssColorToHex(input: string, opts: ToHexOptions = {}): string | null {
  const parsed = parseCssColor(input);
  if (!parsed) return null;

  let { r, g, b } = parsed;
  let a = opts.alpha === undefined ? parsed.a : clamp01(parsed.a * opts.alpha);

  if (opts.over) {
    const bg = parseCssColor(opts.over);
    if (bg) {
      r = r * a + bg.r * (1 - a);
      g = g * a + bg.g * (1 - a);
      b = b * a + bg.b * (1 - a);
      a = 1;
    }
  }

  const rgb = `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
  return a >= 0.999 ? rgb : `${rgb}${channelHex(a)}`;
}
