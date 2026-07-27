import { describe, expect, it } from "vitest";
import { browserTabLabel, normalizeUrl } from "@/components/browser/url";

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

  it("is empty for empty input", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
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
