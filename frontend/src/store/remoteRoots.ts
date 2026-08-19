/// The remote roots currently in the files panel.
///
/// Module-level signal rather than a slice of the layout store, and
/// deliberately not persisted: a session id is meaningless after the app
/// restarts, so a restored root would be a folder that looks alive and answers
/// nothing. Reconnect-on-launch is a later slice; until then the honest state
/// after a restart is "no remote roots".
import { createSignal } from "solid-js";
import { forgetRemoteProvider, remotePath } from "@/api/fsProvider";
import { remoteApi, type RemoteConnection } from "@/api/remote";

export interface RemoteRoot {
  sessionId: string;
  /// The `~/.ssh/config` alias, shown on the panel header and its chip.
  alias: string;
  /// The explorer path the tree opens at — the remote home directory, already
  /// scheme-prefixed.
  root: string;
  /// The remote home directory as the far side spells it, kept so a reconnect
  /// can reopen the same place.
  homeDir: string;
  /// The connection dropped. The root stays in the panel — removing it would
  /// throw away the user's place — but it is marked and offers a reconnect
  /// instead of failing every click with a stat error.
  dead: boolean;
}

const [roots, setRoots] = createSignal<RemoteRoot[]>([]);

export function remoteRoots(): RemoteRoot[] {
  return roots();
}

export function remoteRootFor(sessionId: string): RemoteRoot | undefined {
  return roots().find((r) => r.sessionId === sessionId);
}

function rootFrom(conn: RemoteConnection): RemoteRoot {
  return {
    sessionId: conn.sessionId,
    alias: conn.alias,
    root: remotePath(conn.sessionId, conn.homeDir),
    homeDir: conn.homeDir,
    dead: false,
  };
}

/// Add a fresh connection, or replace a dead root for the same alias.
///
/// Replacing rather than appending is what makes the reconnect affordance land
/// where the user expects: they clicked "Reconnect" on a root in a position,
/// and the live one takes that position instead of appearing at the bottom
/// beside its own corpse.
export function addRemoteRoot(conn: RemoteConnection): RemoteRoot {
  const next = rootFrom(conn);
  setRoots((cur) => {
    const stale = cur.findIndex((r) => r.dead && r.alias === conn.alias);
    if (stale === -1) return [...cur, next];
    forgetRemoteProvider(cur[stale].sessionId);
    return cur.map((r, i) => (i === stale ? next : r));
  });
  return next;
}

/// The supervisor said this session is gone. Marking rather than removing:
/// see `RemoteRoot.dead`.
export function markRemoteRootDead(sessionId: string): void {
  forgetRemoteProvider(sessionId);
  setRoots((cur) => cur.map((r) => (r.sessionId === sessionId ? { ...r, dead: true } : r)));
}

/// Close a connection the user is done with and drop its root.
export async function disconnectRemoteRoot(sessionId: string): Promise<void> {
  const root = remoteRootFor(sessionId);
  setRoots((cur) => cur.filter((r) => r.sessionId !== sessionId));
  forgetRemoteProvider(sessionId);
  // A root already marked dead has nothing on the other end to hang up on, but
  // the call is idempotent and clearing the Rust-side entry is still correct.
  if (root) await remoteApi.disconnect(sessionId);
}
