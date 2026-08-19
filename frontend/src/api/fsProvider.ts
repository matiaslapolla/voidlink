/// The seven operations the file explorer needs, and the two things that can
/// serve them.
///
/// Before this, `FileTree.tsx` imported `fsApi` and called it directly, so
/// "the files" meant "files on this machine" everywhere in the tree — the
/// listing, the create, the rename, the delete. A remote root needs the same
/// seven verbs against a different transport, and the tree should not be the
/// place that knows which. So the tree asks [`providerFor`] and calls that.
///
/// ## Why the provider is chosen from the path, not passed down
///
/// A remote root is spelled `voidlink-remote://<sessionId>/abs/path`, and every
/// path *under* it inherits the prefix by plain string join — which is what the
/// tree already does (`${dir}/${name}`), what `relativeTo` already does, and
/// what `path.split("/").slice(0, -1)` already does. Encoding the session in
/// the path therefore costs the tree nothing: it keeps handling opaque strings
/// and every existing helper keeps working. The alternative — threading a
/// provider object through every row, menu, clipboard entry and editor tab —
/// would have touched all of them to say something the string already knows.
///
/// The remote provider translates in both directions at its own boundary: it
/// strips the prefix before invoking, and puts it back on every path that comes
/// out. Nothing above this file ever sees a bare remote path.
import { fsApi, type FsEntry } from "@/api/fs";
import { remoteApi } from "@/api/remote";

export interface FsProvider {
  /// Which side this is. Callers branch on it for the things that are
  /// genuinely different — git decorations, watching, LSP — rather than
  /// re-deriving it from a path.
  readonly kind: "local" | "remote";
  /// Identity of the backing connection: `"local"`, or the session id. Two
  /// paths with the same source can be copied between; two with different
  /// sources cannot (not in this slice).
  readonly sourceId: string;
  listDir(path: string, includeIgnored?: boolean): Promise<FsEntry[]>;
  readFile(path: string): Promise<string>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
}

export const REMOTE_SCHEME = "voidlink-remote://";

/// The explorer's spelling of one path on one connection.
export function remotePath(sessionId: string, path: string): string {
  return `${REMOTE_SCHEME}${sessionId}${path}`;
}

/// Split a prefixed path back into its session and its real remote path, or
/// `null` when it is an ordinary local path.
export function parseRemotePath(path: string): { sessionId: string; path: string } | null {
  if (!path.startsWith(REMOTE_SCHEME)) return null;
  const rest = path.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf("/");
  // A prefix with no path after it is not addressable — the root itself is
  // always spelled with the remote's absolute home directory.
  if (slash <= 0) return null;
  return { sessionId: rest.slice(0, slash), path: rest.slice(slash) };
}

export function isRemotePath(path: string): boolean {
  return parseRemotePath(path) !== null;
}

/// The path as the far side spells it. For display, for the editor's title,
/// and for anything that would otherwise show the scheme to a human.
export function displayPath(path: string): string {
  return parseRemotePath(path)?.path ?? path;
}

export const localFsProvider: FsProvider = {
  kind: "local",
  sourceId: "local",
  listDir: (path, includeIgnored) => fsApi.listDir(path, includeIgnored),
  readFile: (path) => fsApi.readFile(path),
  createFile: (path) => fsApi.createFile(path),
  createDir: (path) => fsApi.createDir(path),
  rename: (from, to) => fsApi.rename(from, to),
  delete: (path) => fsApi.delete(path),
  copy: (from, to) => fsApi.copy(from, to),
};

/// One provider per session, memoised so `providerFor` returns the same object
/// for the same root across renders — a fresh object every call would make any
/// memo keyed on the provider recompute forever.
const remoteProviders = new Map<string, FsProvider>();

export function remoteFsProvider(sessionId: string): FsProvider {
  const cached = remoteProviders.get(sessionId);
  if (cached) return cached;

  /// Strip the prefix on the way in. Every method takes explorer paths, so a
  /// caller cannot forget to.
  const bare = (p: string) => parseRemotePath(p)?.path ?? p;
  const dress = (p: string) => remotePath(sessionId, p);

  const provider: FsProvider = {
    kind: "remote",
    sourceId: sessionId,
    async listDir(path) {
      const entries = await remoteApi.listDir(sessionId, bare(path));
      return entries.map((e) => ({ ...e, path: dress(e.path) }));
    },
    readFile: (path) => remoteApi.readFile(sessionId, bare(path)),
    createFile: (path) => remoteApi.createFile(sessionId, bare(path)),
    createDir: (path) => remoteApi.createDir(sessionId, bare(path)),
    rename: (from, to) => remoteApi.rename(sessionId, bare(from), bare(to)),
    delete: (path) => remoteApi.delete(sessionId, bare(path)),
    copy: (from, to) => remoteApi.copy(sessionId, bare(from), bare(to)),
  };
  remoteProviders.set(sessionId, provider);
  return provider;
}

/// Drop a session's provider once its connection is gone, so a reconnect that
/// happens to reuse an id does not inherit the dead one.
export function forgetRemoteProvider(sessionId: string): void {
  remoteProviders.delete(sessionId);
}

/// The provider that owns `path`. The single decision point — everything else
/// in the explorer just calls what this returns.
export function providerFor(path: string): FsProvider {
  const remote = parseRemotePath(path);
  return remote ? remoteFsProvider(remote.sessionId) : localFsProvider;
}

/// Whether two paths live on the same side, and so whether one can be copied
/// onto the other. Cross-provider transfer is a later slice; this is what says
/// so before a paste is offered.
export function sameSource(a: string, b: string): boolean {
  return providerFor(a).sourceId === providerFor(b).sourceId;
}
