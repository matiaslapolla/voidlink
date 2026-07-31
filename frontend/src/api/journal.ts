/// Transport for the append-only event log. Rust owns it
/// (`src-tauri/src/journal/mod.rs` — read its header for why); this module only
/// moves records across the boundary.
///
/// Nothing here decides *what* is worth recording or when to flush. That is
/// `store/journal.ts`, and the split is the same one `api/agent.ts` makes
/// against `commands/agent.ts`: a transport that also had a policy would have
/// to be mocked to test the policy.

import { invoke } from "@tauri-apps/api/core";

/// Emitted by Rust when events land, in every window, carrying the batch.
export const JOURNAL_APPENDED_EVENT = "voidlink://journal-appended";

/// Who caused an event. Closed on purpose — views filter on it (see the Rust
/// `Actor` comment).
export type Actor = "user" | "agent" | "system";

/// One recorded fact.
///
/// `kind` is a dotted string rather than a union type for the same reason it is
/// a string in Rust: a build must be able to read a log written by a build that
/// knew kinds it does not. Narrow it at the point of use with `startsWith`, and
/// always be able to fall back to `summary`.
export interface JournalEvent {
  id: string;
  /// Unix milliseconds, stamped by Rust so every window's events sort together.
  at: number;
  kind: string;
  actor: Actor;
  actorName: string | null;
  repo: string | null;
  /// The workspace name this repository belonged to when the event was
  /// recorded, resolved by Rust from the registry. `null` for events recorded
  /// before the field existed, and for a checkout nobody had registered yet.
  workspace: string | null;
  subject: string | null;
  /// One human-readable line, always present. The only field a generic renderer
  /// needs, and the reason an unknown `kind` is still displayable.
  summary: string;
  data: unknown;
}

/// What a caller supplies. Rust stamps `id` and `at`.
export interface NewJournalEvent {
  kind: string;
  /// Defaults to `"user"` in Rust when omitted.
  actor?: Actor;
  actorName?: string;
  repo?: string;
  /// Almost never set here. Rust resolves it from `repo` via the registry, so a
  /// call site that knows the repository does not also have to know which
  /// workspace owns it — and cannot stamp one that disagrees.
  workspace?: string;
  subject?: string;
  summary: string;
  data?: unknown;
}

export interface JournalQuery {
  repo?: string;
  /// Several checkouts at once. Unions with `repo` rather than intersecting.
  repos?: string[];
  /// One workspace, across its main checkout and every worktree under it.
  workspace?: string;
  /// Matched as **prefixes**: `["git."]` selects every git event.
  kinds?: string[];
  actors?: Actor[];
  /// Unix millis; events at or after it.
  since?: number;
  /// The most recent N.
  limit?: number;
}

/// What Rust is told about a checkout. Mirrors `journal::RepoIdentity`.
export interface RepoIdentity {
  path: string;
  workspaceId: string;
  workspaceName: string;
  worktreeId?: string | null;
  isMain?: boolean;
}

/// A turn running right now. Live state from Rust's own registry, not derived
/// from the log — turns are recorded on their end, so the log has no open
/// intervals to read (see `recordTurn` in `commands/agent.ts`).
export interface ActiveAgent {
  repo: string;
  name: string;
  /// Unix millis.
  since: number;
}

export const journalApi = {
  /// Record a batch. Resolves with the stamped events.
  append(events: NewJournalEvent[]): Promise<JournalEvent[]> {
    return invoke<JournalEvent[]>("journal_append", { events });
  },

  /// Read matching events, oldest first.
  query(query: JournalQuery = {}): Promise<JournalEvent[]> {
    return invoke<JournalEvent[]>("journal_query", { query });
  },

  /// Publish the whole workspace/worktree map. A replacement, not an upsert —
  /// a worktree that is gone has to leave the registry.
  registerRepos(repos: RepoIdentity[]): Promise<void> {
    return invoke<void>("journal_register_repos", { repos });
  },

  /// Every checkout Rust currently knows about.
  repos(): Promise<RepoIdentity[]> {
    return invoke<RepoIdentity[]>("journal_repos", {});
  },

  /// Turns running right now, per repository.
  activeAgents(): Promise<ActiveAgent[]> {
    return invoke<ActiveAgent[]>("journal_active_agents", {});
  },
};
