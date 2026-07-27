import { describe, expect, it } from "vitest";
import { isAutoWorkspaceName, repoDisplayName } from "@/types/workspace";

describe("isAutoWorkspaceName", () => {
  it("recognises the names the app hands out", () => {
    expect(isAutoWorkspaceName("Workspace 1")).toBe(true);
    expect(isAutoWorkspaceName("Workspace 42")).toBe(true);
    expect(isAutoWorkspaceName("Workspace")).toBe(true);
    expect(isAutoWorkspaceName("Main")).toBe(true);
    expect(isAutoWorkspaceName("  main  ")).toBe(true);
  });

  it("leaves names the user typed alone", () => {
    expect(isAutoWorkspaceName("voidlink")).toBe(false);
    expect(isAutoWorkspaceName("Workspace stuff")).toBe(false);
    expect(isAutoWorkspaceName("Main app")).toBe(false);
  });
});

describe("repoDisplayName", () => {
  it("prefers the remote's repository name", () => {
    expect(repoDisplayName("/x/wt/feat", "git@github.com:me/voidlink.git")).toBe("voidlink");
    expect(repoDisplayName("/x/wt/feat", "https://github.com/me/void-link")).toBe("void-link");
    expect(repoDisplayName("/x/wt/feat", "https://github.com/me/voidlink.git/")).toBe("voidlink");
  });

  it("falls back to the root folder name", () => {
    expect(repoDisplayName("/Users/me/dev/voidlink", null)).toBe("voidlink");
    expect(repoDisplayName("/Users/me/dev/voidlink/", "  ")).toBe("voidlink");
  });

  it("never returns an empty label", () => {
    expect(repoDisplayName("", null)).toBe("Workspace");
  });
});
