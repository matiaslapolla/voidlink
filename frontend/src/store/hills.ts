/// Hill-chart scopes: the store, and the rule that every move is recorded.
///
/// The model and its maths are in `components/mission/hillModel.ts`; this is
/// state and policy. Two decisions worth stating, both of which are the reason
/// this is a module and not a `createSignal` inside the surface:
///
///   1. **Every move writes to the event log.** Moving a dot is a judgement,
///      and a judgement nobody recorded is one nobody can revisit. The scope's
///      current position lives in `localStorage`; the history of it lives in
///      Rust, which is what lets a check-in say "went over the crest on Search
///      last Tuesday" six weeks later. Callers cannot forget, because the only
///      way to move a scope is through here.
///
///   2. **Scopes are per workspace.** See `STORAGE_KEYS.hills` for why keying
///      them by worktree — as every other collection in this app is keyed —
///      would be wrong.
///
/// Written from the workbench only. Nothing in the satellite windows renders a
/// hill, so the multi-writer problem that put the event log in Rust does not
/// arise here.

import { createStore, produce } from "solid-js/store";
import { STORAGE_KEYS, readJson, writeJson } from "@/store/layout/persistence";
import { record } from "@/store/journal";
import {
  clampPosition,
  describeMove,
  phaseOf,
  type HillScope,
} from "@/components/mission/hillModel";

export type { HillScope };

type ScopesByWorkspace = Record<string, HillScope[]>;

/// Rebuild a scope from disk, defensively.
///
/// This is user-editable JSON, and a malformed entry must cost that entry
/// rather than the workspace's whole chart — the same policy `reviveWorkspace`
/// applies. A scope with no name is dropped: a nameless dot on a hill is not
/// recoverable information, it is a mystery the user has to delete by hand.
function reviveScope(raw: unknown, workspaceId: string): HillScope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
    workspaceId,
    name,
    position: clampPosition(typeof r.position === "number" ? r.position : 0),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    done: !!r.done,
  };
}

export function reviveHills(raw: unknown): ScopesByWorkspace {
  if (!raw || typeof raw !== "object") return {};
  const out: ScopesByWorkspace = {};
  for (const [workspaceId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const scopes = list
      .map((entry) => reviveScope(entry, workspaceId))
      .filter((s): s is HillScope => s !== null);
    if (scopes.length) out[workspaceId] = scopes;
  }
  return out;
}

const [scopes, setScopes] = createStore<ScopesByWorkspace>(
  reviveHills(readJson<unknown>(STORAGE_KEYS.hills, {})),
);

function persist(): void {
  writeJson(STORAGE_KEYS.hills, scopes);
}

/// The scopes of one workspace. Unsorted — `compareScopes` is the caller's
/// choice, and the surface applies it in a memo.
export function hillScopes(workspaceId: string): HillScope[] {
  return scopes[workspaceId] ?? [];
}

/// All scopes, for a cross-workspace read. Flattened rather than grouped
/// because the only consumer today wants a count.
export function allHillScopes(): HillScope[] {
  return Object.values(scopes).flat();
}

export interface AddScopeOptions {
  workspaceId: string;
  name: string;
  /// The repository to file the log event under, when the workspace has one.
  repo?: string;
  now?: number;
}

/// Add a scope at the bottom of the hill. Returns its id, or `null` when the
/// name was blank — a scope with no name is not addable rather than added with
/// a placeholder that somebody then has to find and fix.
export function addHillScope(options: AddScopeOptions): string | null {
  const name = options.name.trim();
  if (!name) return null;
  const scope: HillScope = {
    id: crypto.randomUUID(),
    workspaceId: options.workspaceId,
    name,
    position: 0,
    updatedAt: options.now ?? Date.now(),
    done: false,
  };
  setScopes(
    produce((s) => {
      (s[options.workspaceId] ??= []).push(scope);
    }),
  );
  persist();
  record({
    kind: "hill.scope.added",
    actor: "user",
    repo: options.repo,
    subject: name,
    summary: `Started tracking “${name}”`,
    data: { scopeId: scope.id, workspaceId: options.workspaceId },
  });
  return scope.id;
}

function find(workspaceId: string, scopeId: string): HillScope | undefined {
  return scopes[workspaceId]?.find((s) => s.id === scopeId);
}

export interface MoveOptions {
  workspaceId: string;
  scopeId: string;
  position: number;
  repo?: string;
  now?: number;
}

/// Move a scope along the curve, recording the move.
///
/// A move to the position it already occupies writes nothing. Dragging is
/// continuous and a `mousemove` handler will call this many times per second;
/// recording every pixel would bury the log under a thousand events describing
/// one decision. The caller commits on drag *end* — but this guard is here
/// rather than there, because "the caller remembers to debounce" is not a
/// property the log can rely on.
export function moveHillScope(options: MoveOptions): void {
  const scope = find(options.workspaceId, options.scopeId);
  if (!scope) return;
  const next = clampPosition(options.position);
  if (next === scope.position) return;
  const from = scope.position;
  const now = options.now ?? Date.now();

  setScopes(
    options.workspaceId,
    (s) => s.id === options.scopeId,
    produce((s) => {
      s.position = next;
      s.updatedAt = now;
    }),
  );
  persist();

  record({
    kind: "hill.position.moved",
    actor: "user",
    repo: options.repo,
    subject: scope.name,
    summary: describeMove(scope.name, from, next),
    data: {
      scopeId: scope.id,
      workspaceId: options.workspaceId,
      from,
      to: next,
      // The phase, not the number, is what a later reader is looking for — and
      // it is what survives if the curve's shape is ever changed.
      phase: phaseOf({ position: next, done: false }),
    },
  });
}

export interface FinishOptions {
  workspaceId: string;
  scopeId: string;
  done: boolean;
  repo?: string;
  now?: number;
}

/// Mark a scope finished, or reopen it.
///
/// Finishing does not move the dot to 1. Where the work actually was when it
/// shipped is information — a scope marked done at 0.6 says something true
/// about how it went that a dot snapped to the end would erase.
export function setHillScopeDone(options: FinishOptions): void {
  const scope = find(options.workspaceId, options.scopeId);
  if (!scope || scope.done === options.done) return;
  setScopes(
    options.workspaceId,
    (s) => s.id === options.scopeId,
    produce((s) => {
      s.done = options.done;
      s.updatedAt = options.now ?? Date.now();
    }),
  );
  persist();
  record({
    kind: options.done ? "hill.scope.finished" : "hill.scope.reopened",
    actor: "user",
    repo: options.repo,
    subject: scope.name,
    summary: options.done ? `Finished “${scope.name}”` : `Reopened “${scope.name}”`,
    data: { scopeId: scope.id, workspaceId: options.workspaceId, at: scope.position },
  });
}

export interface RemoveOptions {
  workspaceId: string;
  scopeId: string;
  repo?: string;
}

export function removeHillScope(options: RemoveOptions): void {
  const scope = find(options.workspaceId, options.scopeId);
  if (!scope) return;
  setScopes(
    produce((s) => {
      const list = s[options.workspaceId];
      if (!list) return;
      s[options.workspaceId] = list.filter((entry) => entry.id !== options.scopeId);
    }),
  );
  persist();
  record({
    kind: "hill.scope.removed",
    actor: "user",
    repo: options.repo,
    subject: scope.name,
    summary: `Stopped tracking “${scope.name}”`,
    data: { scopeId: scope.id, workspaceId: options.workspaceId },
  });
}

/// Test seam: drop everything without writing an event for each removal.
export function resetHills(): void {
  setScopes(produce((s) => {
    for (const key of Object.keys(s)) delete s[key];
  }));
  persist();
}
