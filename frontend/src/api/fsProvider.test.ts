/// Provider selection: the one decision that says whether an explorer
/// operation goes to this machine or over SSH.
///
/// Worth its own tests because the whole design rests on a path being enough
/// to answer it — get the parsing wrong and a remote delete runs against the
/// local disk, or a local one is sent to a session that has never heard of it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsApi = {
  listDir: vi.fn(),
  readFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  copy: vi.fn(),
};
const remoteApi = {
  listDir: vi.fn(),
  readFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  copy: vi.fn(),
};

vi.mock("@/api/fs", () => ({ fsApi }));
vi.mock("@/api/remote", () => ({ remoteApi }));

const {
  displayPath,
  forgetRemoteProvider,
  isRemotePath,
  localFsProvider,
  parseRemotePath,
  providerFor,
  remotePath,
  sameSource,
} = await import("./fsProvider");

const LOCAL = "/Users/m/project/src/main.rs";
const REMOTE = remotePath("sess-1", "/home/m/project/src/main.rs");

beforeEach(() => {
  for (const fn of [...Object.values(fsApi), ...Object.values(remoteApi)]) fn.mockReset();
});

describe("path spelling", () => {
  it("round-trips a session id and an absolute remote path", () => {
    expect(REMOTE).toBe("voidlink-remote://sess-1/home/m/project/src/main.rs");
    expect(parseRemotePath(REMOTE)).toEqual({
      sessionId: "sess-1",
      path: "/home/m/project/src/main.rs",
    });
  });

  /// The property the whole design leans on: the tree joins paths with plain
  /// string concatenation, and that has to keep producing valid remote paths.
  it("survives the joins the tree already does", () => {
    const child = `${REMOTE}/nested/file.ts`;
    expect(parseRemotePath(child)?.path).toBe("/home/m/project/src/main.rs/nested/file.ts");
    const parent = REMOTE.split("/").slice(0, -1).join("/");
    expect(parseRemotePath(parent)?.path).toBe("/home/m/project/src");
  });

  it("treats an ordinary absolute path as local", () => {
    expect(parseRemotePath(LOCAL)).toBeNull();
    expect(isRemotePath(LOCAL)).toBe(false);
    expect(isRemotePath(REMOTE)).toBe(true);
  });

  /// A prefix with no path after it addresses nothing — a root is always
  /// spelled with the remote's absolute home directory.
  it("rejects a prefix with no path behind it", () => {
    expect(parseRemotePath("voidlink-remote://sess-1")).toBeNull();
    expect(parseRemotePath("voidlink-remote://")).toBeNull();
  });

  it("shows the far side's own spelling to humans", () => {
    expect(displayPath(REMOTE)).toBe("/home/m/project/src/main.rs");
    expect(displayPath(LOCAL)).toBe(LOCAL);
  });
});

describe("providerFor", () => {
  it("routes a local path to the local provider", () => {
    expect(providerFor(LOCAL)).toBe(localFsProvider);
    expect(providerFor(LOCAL).kind).toBe("local");
    expect(providerFor(LOCAL).sourceId).toBe("local");
  });

  it("routes a remote path to a provider carrying its session id", () => {
    const p = providerFor(REMOTE);
    expect(p.kind).toBe("remote");
    expect(p.sourceId).toBe("sess-1");
  });

  /// Memoised, so a memo keyed on the provider does not recompute forever.
  it("returns the same provider object for the same session", () => {
    expect(providerFor(REMOTE)).toBe(providerFor(`${REMOTE}/other.ts`));
    expect(providerFor(remotePath("sess-2", "/home/m"))).not.toBe(providerFor(REMOTE));
  });

  it("forgets a session's provider once its connection is gone", () => {
    const before = providerFor(REMOTE);
    forgetRemoteProvider("sess-1");
    expect(providerFor(REMOTE)).not.toBe(before);
  });
});

describe("the remote provider's translation", () => {
  it("strips the prefix on the way in and puts it back on the way out", async () => {
    remoteApi.listDir.mockResolvedValue([
      { name: "main.rs", path: "/home/m/project/main.rs", isDir: false, size: 3, modified: 1, ignored: false },
    ]);
    const root = remotePath("sess-9", "/home/m/project");
    const entries = await providerFor(root).listDir(root);

    expect(remoteApi.listDir).toHaveBeenCalledWith("sess-9", "/home/m/project");
    // The tree only ever sees explorer paths — never a bare remote one.
    expect(entries[0].path).toBe("voidlink-remote://sess-9/home/m/project/main.rs");
  });

  it("passes both sides of a two-path operation through bare", async () => {
    const from = remotePath("sess-9", "/home/m/a");
    const to = remotePath("sess-9", "/home/m/b");
    await providerFor(from).copy(from, to);
    expect(remoteApi.copy).toHaveBeenCalledWith("sess-9", "/home/m/a", "/home/m/b");

    await providerFor(from).rename(from, to);
    expect(remoteApi.rename).toHaveBeenCalledWith("sess-9", "/home/m/a", "/home/m/b");
  });

  it("sends a local operation to fsApi untouched", async () => {
    await providerFor(LOCAL).delete(LOCAL);
    expect(fsApi.delete).toHaveBeenCalledWith(LOCAL);
    expect(remoteApi.delete).not.toHaveBeenCalled();
  });
});

describe("sameSource", () => {
  it("is true within one machine and within one session", () => {
    expect(sameSource(LOCAL, "/Users/m/elsewhere")).toBe(true);
    expect(sameSource(REMOTE, `${REMOTE}/child`)).toBe(true);
  });

  /// What stops a cross-provider paste being offered in this slice.
  it("is false across the connection, and across two connections", () => {
    expect(sameSource(LOCAL, REMOTE)).toBe(false);
    expect(sameSource(REMOTE, remotePath("sess-2", "/home/m"))).toBe(false);
  });
});
