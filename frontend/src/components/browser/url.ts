/// Pure URL/label helpers for the embedded browser.
///
/// Split out of `BrowserPane` so this module is unit-testable in plain node —
/// the pane itself imports Solid and the Tauri bridge, neither of which exists
/// in a test runner.

/// Split whatever the user typed into its authority, before any path, query or
/// fragment. Returns the bare host: no userinfo, no port, no brackets.
function hostOf(input: string): string {
  const authority = input.split(/[/?#]/, 1)[0] ?? "";
  // `user:pass@host` — the last `@` wins, because a password may contain one.
  const afterUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  // A bracketed IPv6 literal is the one form where a colon is not a port.
  const bracketed = afterUserinfo.match(/^\[([^\]]*)\]/);
  if (bracketed) return bracketed[1].toLowerCase();
  return afterUserinfo.split(":", 1)[0]?.toLowerCase() ?? "";
}

/// Whether `host` names something on this machine or this network, and
/// therefore something no public certificate authority can have vouched for.
///
/// This is the rule behind the `http://` guess. A dev server is the address
/// most often typed into this bar and dev servers do not do TLS, so guessing
/// `https://` for one produces a connection error that reads like the server is
/// down. The rule used to be the hard-coded pair `localhost` and `127.0.0.1`,
/// which got the machine you are sitting at right and every *other* machine you
/// develop against wrong: a Vite server on `192.168.1.5:3000`, a container on
/// `10.x`, a Pi advertising itself over mDNS as `pi.local`. Those are the same
/// case, and they are enumerated here rather than accumulated one hard-coded
/// host at a time.
///
/// The question asked is deliberately "is this address unroutable from the
/// public internet", not "is this a dev server" — the second is unknowable, and
/// the first is exactly the set for which a public CA cannot have issued a
/// certificate, so it is also the set where `https://` is the wrong guess.
///
/// Two ranges are knowingly left out. Carrier-grade NAT (`100.64.0.0/10`) is
/// private to an ISP rather than to you, and `.internal` is a reserved TLD used
/// by corporate networks that overwhelmingly *do* terminate TLS — guessing
/// `http://` for either would downgrade a connection that works.
///
/// Exported so the rule has its own tests: it is the kind of predicate that is
/// only ever wrong at a boundary (`172.15` is public, `172.16` is not), and
/// those boundaries are invisible in a test that only goes through
/// `normalizeUrl`.
export function isPrivateHost(host: string): boolean {
  if (!host) return false;

  // RFC 6761: `localhost` and anything under it resolve to the loopback
  // interface by definition, so `api.localhost` is as local as `localhost`.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // mDNS. A `.local` name is resolved by multicast on the link you are on and
  // cannot leave it.
  if (host.endsWith(".local")) return true;

  // IPv6 loopback, unique-local (`fc00::/7`) and link-local (`fe80::/10`).
  // Matched on the leading hextet because that is where the whole prefix lives,
  // and parsing an IPv6 literal to learn one nibble would be theatre.
  if (host === "::1" || host === "::") return true;
  if (/^(f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):/.test(host)) return true;

  const quad = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!quad) return false;
  const octets = quad.slice(1).map(Number);
  // A dotted quad with a component over 255 is not an address at all, and
  // treating it as private would hand `999.1.1.1` an `http://` guess.
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;

  if (a === 127) return true; // loopback, the whole /8
  if (a === 0) return true; // 0.0.0.0 — "this host", what a server binds to
  if (a === 10) return true; // RFC 1918 /8
  if (a === 192 && b === 168) return true; // RFC 1918 /16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 /12
  if (a === 169 && b === 254) return true; // RFC 3927 link-local
  return false;
}

/// Normalise whatever the user typed into something a webview will load.
/// A bare host becomes https — unless it is private, where it becomes http.
/// Anything with a scheme is left alone.
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `${isPrivateHost(hostOf(trimmed)) ? "http" : "https"}://${trimmed}`;
}

/// Why a URL was refused. Two reasons because they are two different mistakes,
/// and only the second is one the user can act on by picking something else.
export type Refusal = "scheme" | "file-type";

/// Extensions a `file://` URL may carry — **the mirror of
/// `RENDERABLE_FILE_EXTENSIONS` in `src-tauri/src/browser/mod.rs`.**
///
/// The rule is enforced in Rust, at the navigation hook, because that is the
/// only point every frame a page loads passes through. This copy exists so the
/// address bar *agrees* with it: without it the bar would happily accept
/// `file:///Users/me/id_rsa`, send it, and the hook would cancel it silently —
/// a bar that takes an address and then does nothing is the freeze the whole
/// policy is written to avoid. It is a duplicate because the enforcement point
/// is in another language, not because the rule has two owners.
///
/// HTML, plain text and PDF, per the decision. Images are absent on purpose:
/// they are none of the three, and `svg` is a script carrier wearing a
/// picture's extension.
const RENDERABLE_FILE_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "txt",
  "text",
  "log",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "pdf",
]);

/// Whether a browser tab may go to `url`, and why not if it may not. `null`
/// means allowed.
///
/// Keep in step with `navigation_refusal` in `src-tauri/src/browser/mod.rs`;
/// the same case table is asserted on both sides for exactly that reason.
///
/// - `http`, `https` — the web.
/// - `file` — only a document the tab can render. The child webview holds no
///   capability, so this was never a route to an app command; it was an
///   unrestricted local file reader that any page could aim.
/// - `about`, `blob` — allowed. Neither reaches outside the document that made
///   it, and both are how ordinary pages build frames. Refusing them would
///   break working sites rather than stop anything.
/// - everything else — refused, `data:` included: it renders attacker-authored
///   HTML under an address nobody can read, in a tab that has an address bar.
///
/// A malformed URL is *not* this function's problem — `readAddress` classifies
/// that as `not-an-address` before it gets here.
export function navigationRefusal(url: string): Refusal | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  switch (parsed.protocol) {
    case "http:":
    case "https:":
    case "about:":
    case "blob:":
      return null;
    case "file:":
      return fileRefusal(parsed.pathname);
    default:
      return "scheme";
  }
}

/// `pathname` rather than the whole URL: a query string or a fragment is not
/// part of the path, so `a.html?v=2` must stay allowed and `secret.key?x=.html`
/// must stay refused. Percent-encoding is deliberately not decoded, so an
/// encoded dot makes the rule stricter and never looser.
function fileRefusal(pathname: string): Refusal | null {
  // A trailing slash names a directory, and a listing is none of the three
  // allowed types. A directory reached *without* the slash falls into the
  // no-extension case below and is refused there — the two agree, which is why
  // this never has to ask the filesystem what a path actually is.
  if (!pathname || pathname.endsWith("/")) return "file-type";
  const name = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // `dot < 1` covers both "no extension" and a dotfile literally named `.html`,
  // which is a dotfile and not an HTML document.
  if (dot < 1) return "file-type";
  return RENDERABLE_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
    ? null
    : "file-type";
}

/// The sentence a refusal is reported with, written once so the toast raised by
/// a blocked *frame* and the toast raised by the *address bar* say the same
/// thing. Mirrors `refusal_reason` in the Rust module.
export function refusalMessage(url: string, reason: Refusal): string {
  return reason === "scheme"
    ? `Blocked ${url} — a browser tab only opens web pages and local files`
    : `Blocked ${url} — a local file has to be a web page, a text file or a PDF`;
}

/// What the address bar made of what the user typed.
///
/// `normalizeUrl` alone cannot say "that is not an address": it prefixes a
/// scheme onto anything, so `git rebase onto` became `https://git rebase onto`,
/// which failed to parse in Rust and surfaced as a red toast naming a Rust
/// error — a message that reads like a bug in the app rather than like a typo.
/// This splits the two outcomes apart at the only place that still holds the
/// user's original string.
///
/// **`not-an-address` is where a search fallback would go, and deliberately is
/// not one.** Which engine to send keystrokes to, and whether a git workbench
/// should send them anywhere at all, is a product decision. Classifying is not:
/// it is right under either answer, and saying "that is not an address" beats
/// showing a parser error under both.
///
/// **`refused` is the address bar agreeing with the navigation policy.** The
/// policy is enforced in Rust, at the hook every frame passes through, and that
/// hook cancels *silently*. So a URL the hook will drop must never be sent:
/// the user would type an address, press Enter, and watch nothing happen. It is
/// classified here instead and refused with the reason, before anything is
/// dispatched.
export type Address =
  | { kind: "empty" }
  | { kind: "url"; url: string }
  | { kind: "not-an-address"; input: string }
  | { kind: "refused"; url: string; reason: Refusal };

export function readAddress(input: string): Address {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  const url = normalizeUrl(trimmed);
  try {
    // The same parse Rust will do on the other side of the command. Doing it
    // here means the failure is reported against what the user typed rather
    // than against the string we built out of it.
    new URL(url);
  } catch {
    return { kind: "not-an-address", input: trimmed };
  }
  const reason = navigationRefusal(url);
  if (reason) return { kind: "refused", url, reason };
  return { kind: "url", url };
}

/// The label shown on a browser tab: the page's own title once it has one,
/// falling back to the host while the first load is in flight, and to the raw
/// string if it isn't a parseable URL.
export function browserTabLabel(tab: { url: string; title?: string }): string {
  const title = tab.title?.trim();
  if (title) return title;
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "new tab";
  }
}
