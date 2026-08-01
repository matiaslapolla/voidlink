import { describe, expect, it } from "vitest";
import {
  browserTabLabel,
  isPrivateHost,
  normalizeUrl,
  readAddress,
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
