/// Deciding whether a changed file is an image the diff surface can draw.
///
/// Two questions, deliberately kept apart, because a file answers them
/// differently and only the *pair* is trustworthy:
///
///   1. **What does the name claim?** Cheap, and the only thing available
///      before the bytes arrive — it is what decides whether to fetch them at
///      all.
///   2. **What do the bytes say?** A `.png` that is not a PNG is an ordinary
///      thing in a repository: a placeholder someone `touch`ed, an LFS pointer,
///      an HTML error page a download wrote over the file. Handing that to an
///      `<img>` renders a broken-image glyph with no explanation, which is a
///      worse answer than the binary placeholder it replaced.
///
/// So the image view is offered only when both agree. Disagreement is not an
/// error — it falls back to the placeholder, which is already the honest
/// answer for "a binary file we cannot show you".
///
/// SVG is the exception that shapes the API: it is an image *and* a text file,
/// git diffs it as text, and both readings are useful. It reports
/// `hasTextDiff: true` and the surface offers a toggle, defaulting to the
/// picture because that is what changed.

export type ImageKind = "png" | "jpeg" | "gif" | "webp" | "svg";

const EXTENSIONS: Record<string, ImageKind> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  svg: "svg",
};

const MIME: Record<ImageKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/// What the filename claims, or `null`.
///
/// Lowercased, because `SCREENSHOT.PNG` is a PNG, and last-segment only, so a
/// directory called `png/` does not make every file inside it an image.
export function imageKindFromPath(path: string | null | undefined): ImageKind | null {
  if (!path) return null;
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function mimeFor(kind: ImageKind): string {
  return MIME[kind];
}

/// A `data:` URL for an `<img src>`. Base64 comes from `git_binary_sides`.
export function dataUrl(kind: ImageKind, base64: string): string {
  return `data:${MIME[kind]};base64,${base64}`;
}

/// What the bytes say, or `null` when they say nothing recognisable.
///
/// Magic numbers only — no decoding. The question is "is this plausibly the
/// format the name claims", and a signature answers it in eight bytes.
export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  // JPEG's SOI plus the first marker byte. Every JPEG variant — JFIF, Exif,
  // raw — shares these three.
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matchesAscii(bytes, 0, "GIF87a") || matchesAscii(bytes, 0, "GIF89a")) return "gif";
  // WebP is a RIFF container: the tag sits after the four-byte length.
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) return "webp";
  if (looksLikeSvg(bytes)) return "svg";
  return null;
}

/// SVG has no signature, so this is a shape check rather than a magic number:
/// skip a BOM, whitespace, an XML declaration, comments and a doctype, then
/// require the root element to be `<svg`.
///
/// Deliberately strict about the *root*. "Contains `<svg` somewhere" would
/// accept an HTML error page with an inline icon in it, which is exactly the
/// wrong-content case this whole module exists to catch.
function looksLikeSvg(bytes: Uint8Array): boolean {
  // A `<svg` root within the first 2 KB or it is not one. Decoding the whole
  // file to answer a question about its first tag is work for nothing.
  // A UTF-8 BOM is three bytes, not a character — stripping it has to happen
  // before the bytes become a string, or it shows up as three mojibake
  // characters ahead of the root tag and nothing matches.
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let s = decodeAscii(bytes.subarray(start, start + 2048));
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("<?")) {
      const end = s.indexOf("?>");
      if (end === -1) return false;
      s = s.slice(end + 2);
    } else if (s.startsWith("<!--")) {
      const end = s.indexOf("-->");
      if (end === -1) return false;
      s = s.slice(end + 3);
    } else if (/^<!doctype/i.test(s)) {
      const end = s.indexOf(">");
      if (end === -1) return false;
      s = s.slice(end + 1);
    }
    if (s === before) break;
  }
  // `/` included so a self-closing `<svg/>` counts, excluded from the *name*
  // so `<svgfoo>` still does not.
  return /^<svg[\s/>]/i.test(s);
}

function starts(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function decodeAscii(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/// What the surface should do with this file.
///
/// `null` means "not an image we can draw" — the caller falls back to whatever
/// it shows for a binary file, which for a mismatched extension is the correct
/// and *deliberate* outcome rather than a failure.
export interface ImageDiffPlan {
  kind: ImageKind;
  mime: string;
  /// True only for SVG: the file is also text, so git produced hunks for it
  /// and both readings are worth offering.
  hasTextDiff: boolean;
}

/// Decide from the path and whichever side's bytes are available.
///
/// Both sides are passed because either can be missing — an added image has no
/// old side, a deleted one no new side — and a file is an image if *any*
/// present side sniffs as the kind its name claims. A modification that
/// replaced a real PNG with a text placeholder is not drawable and must not be
/// drawn just because the side that still parses does.
export function planImageDiff(
  path: string | null | undefined,
  oldBytes: Uint8Array | null,
  newBytes: Uint8Array | null,
): ImageDiffPlan | null {
  const claimed = imageKindFromPath(path);
  if (!claimed) return null;

  const present = [oldBytes, newBytes].filter((b): b is Uint8Array => b !== null && b.length > 0);
  if (present.length === 0) return null;
  // Every side that exists has to be the claimed kind. One good side and one
  // that is secretly an LFS pointer would otherwise render as "the image
  // vanished", which is a different fact from the one that happened.
  if (!present.every((b) => sniffImageKind(b) === claimed)) return null;

  return { kind: claimed, mime: MIME[claimed], hasTextDiff: claimed === "svg" };
}

/// Decode base64 straight from `git_binary_sides` into bytes to sniff.
///
/// `atob` is enough: the payload is standard base64 and this only ever reads
/// the first few bytes back out. Returns `null` on malformed input rather than
/// throwing — a corrupt payload should end in the placeholder, like every
/// other unreadable case here.
export function bytesFromBase64(base64: string): Uint8Array | null {
  try {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/// A byte count a human reads. Used beside each side of an image diff, where
/// "1.4 MB → 180 kB" is often the whole story of the change.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
