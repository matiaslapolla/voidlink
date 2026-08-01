import { describe, expect, it } from "vitest";
import {
  browserTabLabel,
  isPrivateHost,
  navigationRefusal,
  normalizeUrl,
  readAddress,
  refusalMessage,
} from "@/components/browser/url";

/// The private-range rule, tested as a rule rather than through the two hosts
/// that used to be hard-coded. Every case here is a boundary: the ranges are
/// only ever wrong one octet either side of themselves, and a test that only
/// checked `192.168.1.5` would pass with `192.` hard-coded.
describe("isPrivateHost", () => {
  it("covers loopback by name, including the reserved subdomains", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("api.localhost")).toBe(true);
    expect(isPrivateHost("LocalHost")).toBe(false); // callers lower-case first
    expect(isPrivateHost("notlocalhost")).toBe(false);
  });

  it("covers mDNS names", () => {
    expect(isPrivateHost("pi.local")).toBe(true);
    expect(isPrivateHost("build-box.local")).toBe(true);
    expect(isPrivateHost("local")).toBe(false);
    expect(isPrivateHost("mylocal")).toBe(false);
  });

  it("covers the whole loopback /8, not just 127.0.0.1", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.1.2.3")).toBe(true);
    expect(isPrivateHost("128.0.0.1")).toBe(false);
    expect(isPrivateHost("126.255.255.255")).toBe(false);
  });

  /// What a server binds to, and what people then type to reach it.
  it("covers 0.0.0.0", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("covers the RFC 1918 ranges at their edges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("10.255.255.255")).toBe(true);
    expect(isPrivateHost("11.0.0.1")).toBe(false);
    expect(isPrivateHost("9.255.255.255")).toBe(false);

    expect(isPrivateHost("192.168.0.1")).toBe(true);
    expect(isPrivateHost("192.168.255.1")).toBe(true);
    expect(isPrivateHost("192.167.1.1")).toBe(false);
    expect(isPrivateHost("192.169.1.1")).toBe(false);

    // The /12 is the one range whose bounds nobody remembers.
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });

  it("covers IPv4 link-local", () => {
    expect(isPrivateHost("169.254.1.1")).toBe(true);
    expect(isPrivateHost("169.253.1.1")).toBe(false);
    expect(isPrivateHost("169.255.1.1")).toBe(false);
  });

  it("covers IPv6 loopback, unique-local and link-local", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("2001:db8::1")).toBe(false);
    expect(isPrivateHost("fe00::1")).toBe(false);
  });

  /// A quad with an octet over 255 is not an address, and calling it private
  /// would hand it an `http://` guess on the strength of a leading `10.`.
  it("rejects a dotted quad that is not an address", () => {
    expect(isPrivateHost("10.0.0.999")).toBe(false);
    expect(isPrivateHost("999.1.1.1")).toBe(false);
  });

  /// The ranges argued about in the rule's own comment. Both are reachable
  /// over TLS in the networks that use them, so guessing http would downgrade
  /// a connection that works.
  it("leaves carrier-grade NAT and .internal public", () => {
    expect(isPrivateHost("100.64.0.1")).toBe(false);
    expect(isPrivateHost("wiki.internal")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("leaves anything with a scheme alone", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("file:///tmp/x.html")).toBe("file:///tmp/x.html");
  });

  it("assumes https for a bare host", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("  example.com/a/b  ")).toBe("https://example.com/a/b");
  });

  /// Dev servers are the reason the pane exists at all, and they don't do TLS.
  it("assumes http for localhost", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("localhost")).toBe("http://localhost");
    expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  });

  /// The finding: a dev server on the LAN is the same case as one on this
  /// machine, and used to get an `https://` it could not answer.
  it("assumes http for a dev server on the network too", () => {
    expect(normalizeUrl("192.168.1.5:3000")).toBe("http://192.168.1.5:3000");
    expect(normalizeUrl("10.1.2.3:8080/health")).toBe("http://10.1.2.3:8080/health");
    expect(normalizeUrl("pi.local:1880")).toBe("http://pi.local:1880");
    expect(normalizeUrl("[::1]:5173")).toBe("http://[::1]:5173");
  });

  /// The host is read out of the authority, so a private-looking *path* on a
  /// public host must not flip the scheme.
  it("reads the host, not the rest of the string", () => {
    expect(normalizeUrl("example.com/10.0.0.1")).toBe("https://example.com/10.0.0.1");
    expect(normalizeUrl("example.com/?q=localhost")).toBe("https://example.com/?q=localhost");
    expect(normalizeUrl("example.com#localhost")).toBe("https://example.com#localhost");
    // Userinfo is not the host either.
    expect(normalizeUrl("localhost@example.com")).toBe("https://localhost@example.com");
  });

  it("is empty for empty input", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });
});

/// BR-S3's URL policy, on this side of the boundary.
///
/// **The case table below is deliberately the same one as
/// `src-tauri/src/browser/mod.rs`'s `navigation_refusal` tests.** The rule is
/// enforced there, at the navigation hook, because that is the only point every
/// frame a page loads passes through; this copy exists so the address bar
/// refuses before it sends, rather than sending something the hook will cancel
/// silently. Two languages, one rule — and if either table is edited alone the
/// bar and the hook stop agreeing, which is what having both tables guards.
///
/// What is *not* tested anywhere, in either language: that a cancelled
/// navigation actually stops a real child webview. That needs an OS-level view
/// and a page that tries to navigate, and no harness in this repo can host one.
/// The hook's `return false` is read from the pinned `tauri` 2.11.2 API
/// ("Returning `false` cancels the navigation"), not executed.
describe("navigationRefusal", () => {
  it("allows the web", () => {
    expect(navigationRefusal("https://example.com/")).toBeNull();
    expect(navigationRefusal("http://192.168.1.5:3000/app?q=1#top")).toBeNull();
  });

  it("refuses every other scheme", () => {
    for (const url of [
      "ftp://files.test/x",
      "javascript:alert(1)",
      "vscode://file/etc/passwd",
      "mailto:someone@test",
      "tauri://localhost/",
    ]) {
      expect(navigationRefusal(url), url).toBe("scheme");
    }
  });

  /// A `data:` page renders attacker-authored HTML under an address nobody can
  /// read, in a tab that has an address bar to show it in. Real browsers block
  /// top-level `data:` for the same reason.
  it("refuses data urls", () => {
    expect(navigationRefusal("data:text/html,<h1>hi</h1>")).toBe("scheme");
  });

  /// The exception that keeps the policy from breaking ordinary sites. Neither
  /// scheme reaches outside the document that created it, and both are how a
  /// page builds a frame it then writes into — refusing them would cancel page
  /// machinery, silently, on sites doing nothing wrong.
  it("allows the page-internal schemes", () => {
    expect(navigationRefusal("about:blank")).toBeNull();
    expect(navigationRefusal("about:srcdoc")).toBeNull();
    expect(navigationRefusal("blob:https://example.com/8f3c-4a2b")).toBeNull();
  });

  it("allows local files it can render", () => {
    for (const url of [
      "file:///Users/me/coverage/index.html",
      "file:///Users/me/notes.htm",
      "file:///Users/me/page.xhtml",
      "file:///var/log/build.log",
      "file:///Users/me/README.md",
      "file:///Users/me/data.json",
      "file:///Users/me/rows.csv",
      "file:///Users/me/Cargo.toml",
      "file:///Users/me/spec.pdf",
    ]) {
      expect(navigationRefusal(url), url).toBeNull();
    }
  });

  /// The point of the whole change: any page could pull one of these into a
  /// hidden frame and read it off the user's disk.
  it("refuses local files it cannot render", () => {
    for (const url of [
      "file:///Users/me/.ssh/id_rsa",
      "file:///Users/me/wallet.dat",
      "file:///Users/me/photo.png",
      "file:///Users/me/diagram.svg",
      "file:///Users/me/archive.zip",
      "file:///Users/me/db.sqlite3",
    ]) {
      expect(navigationRefusal(url), url).toBe("file-type");
    }
  });

  it("ignores case in the extension and the scheme", () => {
    expect(navigationRefusal("file:///Users/me/REPORT.HTML")).toBeNull();
    expect(navigationRefusal("file:///Users/me/Spec.PdF")).toBeNull();
    expect(navigationRefusal("FILE:///Users/me/a.html")).toBeNull();
  });

  /// A query or fragment is not part of the path. A rule that read the whole
  /// URL would refuse a page that is fine — and, worse, could be talked into
  /// allowing one that is not.
  it("reads the path, not the query or the fragment", () => {
    expect(navigationRefusal("file:///Users/me/a.html?v=2")).toBeNull();
    expect(navigationRefusal("file:///Users/me/a.html#section-3")).toBeNull();
    expect(navigationRefusal("file:///Users/me/a.html?v=2#s")).toBeNull();
    expect(navigationRefusal("file:///Users/me/secret.key?x=.html")).toBe("file-type");
    expect(navigationRefusal("file:///Users/me/secret.key#a.html")).toBe("file-type");
  });

  /// A directory listing is none of the three allowed types, and allowing one
  /// would turn a single refusal into a file browser the user can walk out of.
  /// Both spellings have to agree, because only one of them is distinguishable
  /// from a file without touching the disk — which is why this rule never does.
  it("refuses a directory, with or without the trailing slash", () => {
    expect(navigationRefusal("file:///Users/me/")).toBe("file-type");
    expect(navigationRefusal("file:///")).toBe("file-type");
    expect(navigationRefusal("file:///Users/me/Documents")).toBe("file-type");
    expect(navigationRefusal("file:///Users/me/site.html/")).toBe("file-type");
  });

  it("refuses a path with no extension", () => {
    expect(navigationRefusal("file:///etc/hosts")).toBe("file-type");
    expect(navigationRefusal("file:///Users/me/Makefile")).toBe("file-type");
    // A dot in a directory along the way is not the file's extension.
    expect(navigationRefusal("file:///Users/me/v1.2/changelog")).toBe("file-type");
  });

  /// `.html` is a dotfile, not an HTML document — and `~/.htaccess`-shaped
  /// things are exactly what a hostile frame would ask for if an empty stem
  /// counted as a name.
  it("does not treat a dotfile as its own extension", () => {
    expect(navigationRefusal("file:///Users/me/.html")).toBe("file-type");
    expect(navigationRefusal("file:///Users/me/.md")).toBe("file-type");
    expect(navigationRefusal("file:///Users/me/.config/notes.md")).toBeNull();
  });

  /// Encoding must only ever make the rule stricter. A path that looks
  /// renderable only once decoded is refused.
  it("does not decode percent-encoding before reading the extension", () => {
    expect(navigationRefusal("file:///Users/me/a%2Ehtml")).toBe("file-type");
    // An encoded space in a filename is ordinary and must still pass.
    expect(navigationRefusal("file:///Users/me/my%20notes.md")).toBeNull();
  });

  /// Two reasons because they are two different mistakes, and only one of them
  /// is something the user can act on by choosing a different file.
  it("says something different for each reason", () => {
    const scheme = refusalMessage("ftp://x.test/y", "scheme");
    const file = refusalMessage("file:///Users/me/id_rsa", "file-type");
    expect(scheme).not.toBe(file);
    expect(scheme).toContain("ftp://x.test/y");
    expect(file).toContain("file:///Users/me/id_rsa");
  });
});

/// The classification BR-N3 asked for. It stops short of a search fallback on
/// purpose — the point is only that "that is not an address" is knowable here,
/// where the user's original string still exists.
describe("readAddress", () => {
  it("reports a normalised url for anything that parses", () => {
    expect(readAddress("example.com")).toEqual({ kind: "url", url: "https://example.com" });
    expect(readAddress(" localhost:5173 ")).toEqual({
      kind: "url",
      url: "http://localhost:5173",
    });
  });

  it("reports empty input as empty rather than as a bad address", () => {
    expect(readAddress("")).toEqual({ kind: "empty" });
    expect(readAddress("   ")).toEqual({ kind: "empty" });
  });

  /// The case that used to reach Rust and come back as a parser error.
  it("reports a phrase as not an address, keeping what the user typed", () => {
    expect(readAddress("git rebase onto")).toEqual({
      kind: "not-an-address",
      input: "git rebase onto",
    });
  });

  /// The address bar and the policy have to give the same answer. A URL the
  /// hook will cancel must not be accepted here as if it were fine — the user
  /// would press Enter and watch nothing happen, which is the freeze this whole
  /// change exists to avoid.
  it("refuses what the navigation policy would cancel, rather than sending it", () => {
    expect(readAddress("file:///Users/me/.ssh/id_rsa")).toEqual({
      kind: "refused",
      url: "file:///Users/me/.ssh/id_rsa",
      reason: "file-type",
    });
    expect(readAddress("ftp://files.test/x")).toEqual({
      kind: "refused",
      url: "ftp://files.test/x",
      reason: "scheme",
    });
  });

  it("still accepts a local file it can render", () => {
    expect(readAddress("file:///Users/me/coverage/index.html")).toEqual({
      kind: "url",
      url: "file:///Users/me/coverage/index.html",
    });
  });
});

describe("browserTabLabel", () => {
  it("prefers the page title", () => {
    expect(browserTabLabel({ url: "https://example.com/a", title: "Example" })).toBe("Example");
  });

  it("falls back to the host before the page reports a title", () => {
    expect(browserTabLabel({ url: "https://example.com/a/b" })).toBe("example.com");
    expect(browserTabLabel({ url: "http://localhost:5173/" })).toBe("localhost:5173");
  });

  /// A whitespace-only title is what clearing one looks like on the wire.
  it("treats a blank title as no title", () => {
    expect(browserTabLabel({ url: "https://example.com", title: "   " })).toBe("example.com");
  });

  it("falls back to the raw string when the url will not parse", () => {
    expect(browserTabLabel({ url: "not a url" })).toBe("not a url");
    expect(browserTabLabel({ url: "" })).toBe("new tab");
  });
});
