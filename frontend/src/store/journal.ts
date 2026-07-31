/// Recording into the append-only event log, from a window.
///
/// Rust owns the log itself (`src-tauri/src/journal/mod.rs` — its header states
/// why it is not a `localStorage` blob). This module is the write policy: what
/// a caller has to supply, how bursts are batched, and the one rule that makes
/// it safe to call from anywhere.
///
/// ## The rule: recording must never be able to break the thing it records
///
/// `record()` returns `void`, never throws, and never rejects. A failed append
/// is warned about and dropped. This is not laziness — it is the only policy
/// under which a call to `record()` can be added to an existing handler without
/// re-reasoning about that handler's error path. The moment logging can throw,
/// every call site becomes a `try`/`catch` and half of them will be missing one.
///
/// ## Batching, for the same reason `gitEvents.ts` coalesces
///
/// A burst of events is one IPC round trip, not N. The window is longer than
/// the refresh pulse's 40ms because nothing is *waiting* on an event landing —
/// a log is allowed a quarter second of latency in a way a stale sidebar is not.

import {
  journalApi,
  type JournalEvent,
  type NewJournalEvent,
  type RepoIdentity,
} from "@/api/journal";
import { JOURNAL_APPENDED_EVENT } from "@/api/journal";
import type { Workspace } from "@/types/workspace";

export type { JournalEvent, NewJournalEvent };

/// Trailing-edge batching window. See the header.
export const JOURNAL_BATCH_MS = 250;

let queue: NewJournalEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/// The repository events default to.
///
/// A window shows exactly one worktree at a time — pane geometry is stored
/// `Record<worktreeId, PaneNode>` and only the active one renders — so an
/// ambient value is accurate rather than a guess. It exists because the
/// alternative was threading a repo path through `watchTerminal`, `activity.ts`
/// and every caller of both, to arrive at the same answer.
///
/// Set by the app root on worktree change. `record()` callers that know better
/// (the agent, which is bound to a worktree structurally) pass `repo`
/// explicitly and win.
let ambientRepo: string | null = null;

export function setJournalRepo(repo: string | null): void {
  ambientRepo = repo;
}

async function flush(): Promise<void> {
  timer = null;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;
  try {
    await journalApi.append(batch);
  } catch (e) {
    // Outside Tauri (the test runner) `invoke` rejects; inside it, this is a
    // disk problem Rust has already warned about. Either way the action that
    // produced the event has already happened and must not be disturbed.
    console.warn(`could not record ${batch.length} event(s)`, e);
  }
}

/// Record one event. Fire-and-forget by contract — see the header.
///
/// `repo` defaults to the ambient worktree. `actor` defaults to `"user"` in
/// Rust, which is right for anything a person triggered.
export function record(event: NewJournalEvent): void {
  queue.push(event.repo === undefined && ambientRepo ? { ...event, repo: ambientRepo } : event);
  if (timer === null) timer = setTimeout(() => void flush(), JOURNAL_BATCH_MS);
}

/// Send anything queued now.
///
/// Wired to `pagehide` below for the same reason `gitEvents.ts` is: a batching
/// window the window closes on top of is a lost batch, and the events most
/// likely to be in it are the last things that happened before a quit — exactly
/// what the next morning's "what happened yesterday" wants.
export function flushJournal(): void {
  if (timer !== null) clearTimeout(timer);
  void flush();
}

/// Flatten the workspace model into the rows Rust stamps and groups by.
///
/// Pure, and exported for its own test: the shape of what Rust is told is the
/// whole contract, and getting it wrong shows up as events with no workspace
/// rather than as an error.
///
/// Worktrees with no path are dropped. A synthetic main worktree of a folder
/// that is not a repository has `path: ""`, and registering that would map the
/// empty string to a workspace — after which every event with no repo would
/// join it.
export function repoIdentities(workspaces: Workspace[]): RepoIdentity[] {
  const rows: RepoIdentity[] = [];
  for (const ws of workspaces) {
    for (const wt of ws.worktrees) {
      if (!wt.path) continue;
      rows.push({
        path: wt.path,
        workspaceId: ws.id,
        workspaceName: ws.name,
        worktreeId: wt.id,
        isMain: wt.isMain,
      });
    }
  }
  return rows;
}

/// The last map published, so an unchanged workspace list does not cross the
/// IPC boundary on every unrelated store write.
let publishedRepos = "";

/// Tell Rust the workspace/worktree map. Idempotent and cheap to over-call.
///
/// Fire-and-forget, like `record()` and for the same reason: a registry that
/// failed to publish costs grouping, and grouping is not worth propagating an
/// error into a store update over.
export function publishRepos(workspaces: Workspace[]): void {
  const rows = repoIdentities(workspaces);
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === publishedRepos) return;
  publishedRepos = fingerprint;
  void journalApi.registerRepos(rows).catch((e) => {
    // Retry on the next change rather than sitting on a stale fingerprint.
    publishedRepos = "";
    console.warn("could not publish the repository registry", e);
  });
}

/// Test seam: drop anything queued without sending it.
export function resetJournal(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue = [];
  ambientRepo = null;
  publishedRepos = "";
}

/// Subscribe to events as they land, in this window, whichever window recorded
/// them. Returns an unsubscribe fn; pass it to `onCleanup`.
///
/// Async because the Tauri listener is, which means a subscriber that unmounts
/// before the listener attaches must still be able to cancel — hence the
/// synchronous disposer over a flag rather than returning a promise.
export function onJournalAppended(handler: (events: JournalEvent[]) => void): () => void {
  let cancelled = false;
  let detach: (() => void) | null = null;

  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<JournalEvent[]>(JOURNAL_APPENDED_EVENT, (e) => {
        handler(e.payload ?? []);
      });
      if (cancelled) un();
      else detach = un;
    } catch {
      // No Tauri host. Nothing will ever be delivered, which is the correct
      // behaviour outside the app.
    }
  })();

  return () => {
    cancelled = true;
    detach?.();
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushJournal);
}
