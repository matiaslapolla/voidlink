/// Filesystem watching for the repositories the app has open.
///
/// The Rust side (`src-tauri/src/watch/mod.rs`) owns the watchers and the
/// filtering; this is the transport plus the one rule about who calls it.
///
/// **Only the workbench calls `watchRepos`.** It is the window that owns the
/// workspace list, and the command has *set* semantics — each call replaces the
/// whole watched set. A second window sending its own idea of the set would
/// stop watching everything the first one wanted.

import { invoke } from "@tauri-apps/api/core";

/// Emitted by Rust when a watched repository changed on disk. Broadcast to
/// every window; the payload is the repository root.
export const GIT_CHANGED_EVENT = "voidlink://git-changed";

/// Replace the set of watched repositories.
///
/// Returns the paths that could not be watched, as human-readable messages —
/// one unreadable repository does not stop the others, so this is a report
/// rather than a failure. Callers may ignore it; the surfaces still have their
/// manual refresh.
export function watchRepos(repoPaths: string[]): Promise<string[]> {
  return invoke<string[]>("watch_repos", { repoPaths });
}
