import { describe, expect, it } from "vitest";
import { tsserverLibCandidates } from "./lspServers";

const ROOT = "/repo";
const lib = (dir: string) => `${dir}/node_modules/typescript/lib`;

describe("tsserverLibCandidates", () => {
  /// The case this exists for. VoidLink roots a workspace at the *git* root, so
  /// a repo whose app lives in a subdirectory has its only `node_modules` below
  /// the root — which is exactly where `typescript-language-server`'s own
  /// lookup does not go.
  it("offers the nearest package directory before the workspace root", () => {
    expect(tsserverLibCandidates("/repo/frontend/src/a.ts", ROOT)).toEqual([
      lib("/repo/frontend/src"),
      lib("/repo/frontend"),
      lib(ROOT),
    ]);
  });

  it("offers the root once for a file sitting directly in it", () => {
    expect(tsserverLibCandidates("/repo/a.ts", ROOT)).toEqual([lib(ROOT)]);
  });

  /// The bound. Without it a file opened from outside the workspace would walk
  /// up through `$HOME` and could pick up a stray install that governs nothing.
  it("refuses to leave the workspace", () => {
    expect(tsserverLibCandidates("/elsewhere/a.ts", ROOT)).toEqual([]);
    // A sibling whose name merely starts with the root's is not inside it.
    expect(tsserverLibCandidates("/repository/a.ts", ROOT)).toEqual([]);
  });

  it("is unbothered by a trailing slash on the root", () => {
    expect(tsserverLibCandidates("/repo/frontend/a.ts", "/repo/")).toEqual([
      lib("/repo/frontend"),
      lib(ROOT),
    ]);
  });
});
