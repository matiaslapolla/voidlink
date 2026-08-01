import { describe, expect, it } from "vitest";
import { isValidRemoteName, isValidRemoteUrl, normalizeRemoteName } from "./remoteUrl";

/// libgit2 accepts *any* string as a remote URL and returns `Ok(())`, so
/// nothing downstream would ever catch a typo — the remote looked normal in
/// the dialog and failed later with an error about the network.
describe("isValidRemoteUrl", () => {
  it("accepts the forms people actually paste", () => {
    for (const url of [
      "git@github.com:user/repo.git",
      "https://github.com/user/repo.git",
      "https://user:token@gitlab.example.com:8443/group/sub/repo.git",
      "ssh://git@host.example.com:2222/~/repo.git",
      "git://host/repo.git",
      "file:///srv/git/repo.git",
      "/srv/git/repo.git",
    ]) {
      expect(isValidRemoteUrl(url), url).toBe(true);
    }
  });

  it("rejects what cannot possibly work", () => {
    for (const url of [
      "not a url",
      "",
      "   ",
      "https:///repo.git",
      ":repo.git",
      "github.com/user/repo",
    ]) {
      expect(isValidRemoteUrl(url), url).toBe(false);
    }
  });

  it("tolerates surrounding whitespace, since paste adds it", () => {
    expect(isValidRemoteUrl("  git@github.com:user/repo.git  ")).toBe(true);
  });
});

describe("remote names", () => {
  it("trims, because libgit2 answered a leading space with a raw error", () => {
    expect(normalizeRemoteName(" origin")).toBe("origin");
    expect(isValidRemoteName(" origin")).toBe(true);
  });

  it("rejects names git will not take", () => {
    expect(isValidRemoteName("with space")).toBe(false);
    expect(isValidRemoteName("with/slash")).toBe(false);
    expect(isValidRemoteName("")).toBe(false);
    expect(isValidRemoteName("   ")).toBe(false);
  });
});
