/// The explorer menu's policy: which rows appear, which are greyed, and where
/// a Duplicate or a Paste actually lands.
import { describe, expect, it } from "vitest";
import { remotePath } from "@/api/fsProvider";
import type { FileClipboardEntry } from "./fileClipboard";
import {
  duplicateName,
  duplicateTargetPath,
  fileTreeMenuState,
  pasteTargetPath,
} from "./fileTreeMenu";

const LOCAL_DIR = { path: "/repo/src", name: "src", isDir: true };
const LOCAL_FILE = { path: "/repo/src/main.rs", name: "main.rs", isDir: false };
const REMOTE_DIR = {
  path: remotePath("sess-1", "/home/m/proj"),
  name: "proj",
  isDir: true,
};

const clip = (over: Partial<FileClipboardEntry> = {}): FileClipboardEntry => ({
  path: "/repo/other/thing.ts",
  name: "thing.ts",
  isDir: false,
  ...over,
});

describe("git rows", () => {
  it("are offered on a local root", () => {
    const s = fileTreeMenuState({ target: LOCAL_FILE, clipboard: null });
    expect(s.isRemote).toBe(false);
    expect(s.showGitRows).toBe(true);
  });

  /// A remote root has no repository behind it in this slice. The rows are
  /// withheld rather than disabled: half a menu of greyed git actions would
  /// promise they are coming.
  it("are withheld on a remote root", () => {
    const s = fileTreeMenuState({ target: REMOTE_DIR, clipboard: null });
    expect(s.isRemote).toBe(true);
    expect(s.showGitRows).toBe(false);
  });
});

describe("Duplicate and Copy", () => {
  it("are always available, local and remote alike", () => {
    for (const target of [LOCAL_FILE, LOCAL_DIR, REMOTE_DIR]) {
      const s = fileTreeMenuState({ target, clipboard: null });
      expect(s.duplicate.enabled).toBe(true);
      expect(s.copy.enabled).toBe(true);
    }
  });
});

describe("Paste enablement", () => {
  it("is off with an empty clipboard, and says so", () => {
    const s = fileTreeMenuState({ target: LOCAL_DIR, clipboard: null });
    expect(s.paste.enabled).toBe(false);
    expect(s.paste.disabledReason).toBe("Nothing copied yet");
    expect(s.pasteDir).toBeNull();
  });

  it("is off over a file — the folder the user meant is one row up", () => {
    const s = fileTreeMenuState({ target: LOCAL_FILE, clipboard: clip() });
    expect(s.paste.enabled).toBe(false);
    expect(s.paste.disabledReason).toBe("Paste into a folder");
  });

  it("is on over a directory on the same side", () => {
    const s = fileTreeMenuState({ target: LOCAL_DIR, clipboard: clip() });
    expect(s.paste.enabled).toBe(true);
    expect(s.paste.disabledReason).toBeUndefined();
    expect(s.pasteDir).toBe("/repo/src");
  });

  it("is on over a remote directory when the clipboard is from that session", () => {
    const s = fileTreeMenuState({
      target: REMOTE_DIR,
      clipboard: clip({ path: remotePath("sess-1", "/home/m/other.ts") }),
    });
    expect(s.paste.enabled).toBe(true);
    expect(s.pasteDir).toBe(REMOTE_DIR.path);
  });

  /// Cross-provider transfer is out of scope for this slice, in both
  /// directions and between two different hosts.
  it("is off across the connection", () => {
    const reason = "Copying between local and remote is not supported yet";
    expect(
      fileTreeMenuState({ target: REMOTE_DIR, clipboard: clip() }).paste.disabledReason,
    ).toBe(reason);
    expect(
      fileTreeMenuState({
        target: LOCAL_DIR,
        clipboard: clip({ path: remotePath("sess-1", "/home/m/x") }),
      }).paste.disabledReason,
    ).toBe(reason);
    expect(
      fileTreeMenuState({
        target: REMOTE_DIR,
        clipboard: clip({ path: remotePath("sess-2", "/home/m/x") }),
      }).paste.disabledReason,
    ).toBe(reason);
  });

  /// `cp -a` into a subtree of its own source recurses until the disk fills.
  it("is off when a folder would be pasted into itself or its own subtree", () => {
    const folder = clip({ path: "/repo/src", name: "src", isDir: true });
    expect(
      fileTreeMenuState({ target: LOCAL_DIR, clipboard: folder }).paste.disabledReason,
    ).toBe("Cannot paste a folder into itself");
    expect(
      fileTreeMenuState({
        target: { path: "/repo/src/nested", name: "nested", isDir: true },
        clipboard: folder,
      }).paste.disabledReason,
    ).toBe("Cannot paste a folder into itself");
    // A sibling whose name merely starts the same is not inside it.
    expect(
      fileTreeMenuState({
        target: { path: "/repo/srcx", name: "srcx", isDir: true },
        clipboard: folder,
      }).paste.enabled,
    ).toBe(true);
  });
});

describe("duplicateName", () => {
  it("puts the suffix before the extension so the file keeps its language", () => {
    expect(duplicateName("main.rs", [])).toBe("main copy.rs");
  });

  it("numbers from 2, skipping every name already taken", () => {
    expect(duplicateName("main.rs", ["main.rs", "main copy.rs"])).toBe("main copy 2.rs");
    expect(duplicateName("main.rs", ["main copy.rs", "main copy 2.rs"])).toBe("main copy 3.rs");
  });

  it("treats a dotfile's leading dot as its name, not an extension", () => {
    expect(duplicateName(".env", [])).toBe(".env copy");
  });

  it("handles a name with no extension at all", () => {
    expect(duplicateName("Makefile", ["Makefile copy"])).toBe("Makefile copy 2");
  });
});

describe("where a duplicate and a paste land", () => {
  it("puts a duplicate beside the original", () => {
    expect(duplicateTargetPath("/repo/src/main.rs", ["main.rs"])).toBe("/repo/src/main copy.rs");
  });

  it("keeps the remote prefix on a remote duplicate", () => {
    const path = remotePath("sess-1", "/home/m/main.rs");
    expect(duplicateTargetPath(path, ["main.rs"])).toBe(
      "voidlink-remote://sess-1/home/m/main copy.rs",
    );
  });

  it("pastes under the original name when the folder has room for it", () => {
    expect(pasteTargetPath("/repo/src", "thing.ts", ["main.rs"])).toBe("/repo/src/thing.ts");
  });

  it("falls back to a copy name when the folder already holds that name", () => {
    expect(pasteTargetPath("/repo/src", "thing.ts", ["thing.ts"])).toBe(
      "/repo/src/thing copy.ts",
    );
  });
});
