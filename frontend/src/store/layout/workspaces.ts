/// Workspaces and worktrees: hydration from disk, and the CRUD/selection
/// actions over them.
///
/// The two-level model is the point of this module. A *workspace* is a repo you
/// added; a *worktree* is one checkout of it. Every tab collection in the store
/// is keyed by worktree id, never by workspace id, which is what makes
/// switching worktrees swap the entire tab set for free.
import type { SetStoreFunction } from "solid-js/store";
import { produce } from "solid-js/store";
import { terminalApi } from "@/api/terminal";
import { gitApi } from "@/api/git";
import {
  type PersistedWorkspace,
  type Workspace,
  type Worktree,
  isAutoWorkspaceName,
  makeWorkspace,
  makeWorktree,
  repoDisplayName,
} from "@/types/workspace";
import { runLayoutMigration } from "@/store/migrate";
import {
  STORAGE_KEYS,
  layoutKeyValueStore,
  readJson,
  readRaw,
  writeJson,
  writeRaw,
} from "./persistence";
import {
  type AppStoreState,
  dropWorktreeCollections,
  seedWorktreeCollections,
} from "./state";
import { samePath } from "./tabs";

/// Rebuild a runtime `Workspace` from its persisted form. Defensive about
/// every field because this is user-editable JSON on disk: a workspace with no
/// worktrees array (or an empty one) is repaired with a synthetic main worktree
/// rather than crashing the app on boot.
export function reviveWorkspace(p: PersistedWorkspace): Workspace {
  const repoRoot = p.repoRoot ?? null;
  const worktrees = (Array.isArray(p.worktrees) ? p.worktrees : [])
    .filter((w) => w && typeof w.id === "string" && typeof w.path === "string")
    .map((w) =>
      makeWorktree({
        id: w.id,
        path: w.path,
        branch: typeof w.branch === "string" ? w.branch : null,
        isMain: !!w.isMain,
        isSynthetic: !!w.isSynthetic,
      }),
    );
  if (worktrees.length === 0) {
    worktrees.push(
      makeWorktree({ id: p.id, path: repoRoot ?? "", isMain: true, isSynthetic: true }),
    );
  }
  const activeWorktreeId = worktrees.some((w) => w.id === p.activeWorktreeId)
    ? p.activeWorktreeId
    : worktrees[0].id;
  return {
    id: p.id,
    name: p.name,
    repoRoot,
    worktrees,
    activeWorktreeId,
    isRepo: !!p.isRepo,
  };
}

export function serializeWorkspaces(workspaces: Workspace[]): PersistedWorkspace[] {
  return workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    repoRoot: w.repoRoot,
    worktrees: w.worktrees.map((wt) => ({
      id: wt.id,
      path: wt.path,
      branch: wt.branch,
      isMain: wt.isMain,
      isSynthetic: wt.isSynthetic,
    })),
    activeWorktreeId: w.activeWorktreeId,
    isRepo: w.isRepo,
  }));
}

export function persistWorkspaces(workspaces: Workspace[], activeWorkspaceId: string) {
  writeJson(STORAGE_KEYS.workspaces, serializeWorkspaces(workspaces));
  writeRaw(STORAGE_KEYS.activeWorkspace, activeWorkspaceId);
}

export function loadWorkspaces(): { workspaces: Workspace[]; activeId: string } {
  // Upgrade the on-disk shape before we read a byte of it. Idempotent and
  // gated on `voidlink-layout-version`, so this is a no-op on every boot after
  // the first — see `store/migrate.ts` for why the tab blobs need no re-keying.
  const kv = layoutKeyValueStore();
  if (kv) runLayoutMigration(kv);
  const parsed = readJson<PersistedWorkspace[] | null>(STORAGE_KEYS.workspaces, null);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const workspaces = parsed.map(reviveWorkspace);
    const stored = readRaw(STORAGE_KEYS.activeWorkspace);
    const activeId =
      stored && workspaces.some((w) => w.id === stored) ? stored : workspaces[0].id;
    return { workspaces, activeId };
  }
  const first = makeWorkspace("Main");
  return { workspaces: [first], activeId: first.id };
}

// ── Actions ───────────────────────────────────────────────────────────────

export interface WorkspaceActionsContext {
  state: AppStoreState;
  setState: SetStoreFunction<AppStoreState>;
  /// Find a worktree anywhere in the store by id, with its owning workspace.
  locateWorktree(wtId: string): { workspace: Workspace; worktree: Worktree } | null;
}

export function createWorkspaceActions(ctx: WorkspaceActionsContext) {
  const { state, setState } = ctx;

  const actions = {
    addWorkspace(name?: string, repoRoot: string | null = null) {
      const count = state.workspaces.length + 1;
      const ws = makeWorkspace(name ?? `Workspace ${count}`, repoRoot);
      setState(produce((s) => {
        s.workspaces.push(ws);
        for (const wt of ws.worktrees) seedWorktreeCollections(s, wt.id);
        s.activeWorkspaceId = ws.id;
        s.activeWorktreeId = ws.activeWorktreeId;
      }));
      return ws.id;
    },

    removeWorkspace(id: string) {
      const ws = state.workspaces.find((w) => w.id === id);
      const worktreeIds = ws?.worktrees.map((wt) => wt.id) ?? [id];
      for (const wtId of worktreeIds) {
        for (const t of state.terminalsByWorktree[wtId] ?? []) {
          void terminalApi.closePty(t.ptyId).catch(() => {});
        }
      }
      setState(produce((s) => {
        s.workspaces = s.workspaces.filter((w) => w.id !== id);
        for (const wtId of worktreeIds) dropWorktreeCollections(s, wtId);
        if (s.workspaces.length === 0) {
          const fresh = makeWorkspace("Main");
          s.workspaces.push(fresh);
          for (const wt of fresh.worktrees) seedWorktreeCollections(s, wt.id);
          s.activeWorkspaceId = fresh.id;
          s.activeWorktreeId = fresh.activeWorktreeId;
        } else if (s.activeWorkspaceId === id) {
          const next = s.workspaces[s.workspaces.length - 1];
          s.activeWorkspaceId = next.id;
          s.activeWorktreeId = next.activeWorktreeId;
        }
      }));
    },

    renameWorkspace(id: string, name: string) {
      setState("workspaces", (w) => w.id === id, "name", name.trim() || "Workspace");
    },

    /// Switch workspaces, restoring whichever worktree that workspace was last
    /// looking at. Selecting a workspace never silently resets you to main.
    selectWorkspace(id: string) {
      const ws = state.workspaces.find((w) => w.id === id);
      if (!ws) return;
      setState(produce((s) => {
        s.activeWorkspaceId = id;
        s.activeWorktreeId = ws.activeWorktreeId;
      }));
    },

    /// Make `wtId` the active worktree (switching workspaces if needed). The
    /// whole tab set swaps as a side effect because every collection is keyed
    /// by worktree id.
    selectWorktree(wtId: string) {
      const found = ctx.locateWorktree(wtId);
      if (!found) return;
      setState(produce((s) => {
        s.activeWorkspaceId = found.workspace.id;
        s.activeWorktreeId = wtId;
        const ws = s.workspaces.find((w) => w.id === found.workspace.id);
        if (ws) ws.activeWorktreeId = wtId;
        seedWorktreeCollections(s, wtId);
      }));
    },

    /// Register a worktree the wizard (or hydration) just discovered. Returns
    /// the worktree id. Matching is by path so re-adding an existing worktree
    /// updates it in place instead of orphaning its tabs.
    addWorktree(
      workspaceId: string,
      init: { path: string; branch: string | null; isMain?: boolean },
    ): string | null {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return null;
      const existing = ws.worktrees.find((wt) => samePath(wt.path, init.path));
      if (existing) {
        setState(
          "workspaces",
          (w) => w.id === workspaceId,
          "worktrees",
          (wt) => wt.id === existing.id,
          (wt) => ({ ...wt, branch: init.branch, isSynthetic: false }),
        );
        return existing.id;
      }
      const wt = makeWorktree({
        path: init.path,
        branch: init.branch,
        isMain: init.isMain ?? false,
      });
      setState(produce((s) => {
        const target = s.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        target.worktrees.push(wt);
        seedWorktreeCollections(s, wt.id);
      }));
      return wt.id;
    },

    /// Forget a worktree and everything open inside it. The main worktree is
    /// never removable — that is the workspace itself.
    removeWorktree(workspaceId: string, wtId: string) {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      const wt = ws?.worktrees.find((w) => w.id === wtId);
      if (!ws || !wt || wt.isMain) return;
      for (const t of state.terminalsByWorktree[wtId] ?? []) {
        void terminalApi.closePty(t.ptyId).catch(() => {});
      }
      setState(produce((s) => {
        const target = s.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        target.worktrees = target.worktrees.filter((w) => w.id !== wtId);
        dropWorktreeCollections(s, wtId);
        const fallback = target.worktrees.find((w) => w.isMain) ?? target.worktrees[0];
        if (!fallback) return;
        if (target.activeWorktreeId === wtId) target.activeWorktreeId = fallback.id;
        if (s.activeWorktreeId === wtId) s.activeWorktreeId = target.activeWorktreeId;
      }));
    },

    /// Reconcile a workspace's worktree list against `git worktree list`.
    /// Existing entries are matched by canonicalised path so their ids — and
    /// therefore their open tabs — survive. Entries git no longer reports are
    /// dropped, but only on a successful listing: a failed call means "not a
    /// repo (yet)" and leaves the synthetic worktree in place.
    async hydrateWorktrees(workspaceId: string): Promise<void> {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws?.repoRoot) return;
      let listed;
      try {
        listed = await gitApi.listWorktrees(ws.repoRoot);
      } catch {
        setState("workspaces", (w) => w.id === workspaceId, "isRepo", false);
        return;
      }
      if (listed.length === 0) return;
      // PTYs belonging to worktrees git no longer reports have to be collected
      // *before* the state update, because that update deletes the very
      // collections we'd need to find them in — otherwise we leak a shell per
      // removed worktree.
      const orphanedPtys: string[] = [];
      setState(produce((s) => {
        const target = s.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        const keptIds = new Set<string>();
        const next: typeof target.worktrees = [];
        for (const info of listed) {
          const prior =
            target.worktrees.find((wt) => samePath(wt.path, info.path)) ??
            // The migrated/synthetic main worktree may still be pointing at the
            // repo root under a different spelling; adopt it for git's main
            // entry so its tabs come along.
            (info.isMain ? target.worktrees.find((wt) => wt.isMain) : undefined);
          const id = prior?.id ?? crypto.randomUUID();
          keptIds.add(id);
          next.push({
            id,
            path: info.path,
            branch: info.branch,
            isMain: info.isMain,
            isSynthetic: false,
            isDirty: info.isDirty,
            ahead: info.ahead,
            behind: info.behind,
            isLocked: info.isLocked,
            isDetached: info.isDetached,
            statusUnknown: info.statusUnknown,
            isPrunable: info.isPrunable,
          });
          seedWorktreeCollections(s, id);
        }
        for (const old of target.worktrees) {
          if (keptIds.has(old.id)) continue;
          for (const t of s.terminalsByWorktree[old.id] ?? []) orphanedPtys.push(t.ptyId);
          dropWorktreeCollections(s, old.id);
        }
        target.worktrees = next;
        target.isRepo = true;
        if (!keptIds.has(target.activeWorktreeId)) {
          target.activeWorktreeId = (next.find((w) => w.isMain) ?? next[0]).id;
        }
        if (s.activeWorkspaceId === workspaceId) {
          s.activeWorktreeId = target.activeWorktreeId;
        }
      }));
      for (const ptyId of orphanedPtys) void terminalApi.closePty(ptyId).catch(() => {});
    },

    /// Hydrate every workspace that has a repo root. Fire-and-forget on boot.
    async hydrateAllWorktrees(): Promise<void> {
      await Promise.all(
        state.workspaces
          .filter((w) => !!w.repoRoot)
          .map((w) => actions.hydrateWorktrees(w.id)),
      );
    },

    /// Drop the workspace `fromId` immediately before `toId`. If `toId` is
    /// `null`, drop at the end. No-op when the move would leave order
    /// unchanged. Used by drag-and-drop on the workspace tab bar.
    reorderWorkspace(fromId: string, toId: string | null) {
      setState(produce((s) => {
        const from = s.workspaces.findIndex((w) => w.id === fromId);
        if (from === -1) return;
        const [item] = s.workspaces.splice(from, 1);
        if (toId === null) {
          s.workspaces.push(item);
          return;
        }
        const to = s.workspaces.findIndex((w) => w.id === toId);
        if (to === -1) {
          s.workspaces.push(item);
          return;
        }
        s.workspaces.splice(to, 0, item);
      }));
    },

    /// Point a workspace at a folder. The main worktree follows the root — it
    /// *is* the root — and we immediately try to read the real worktree list so
    /// picking a repo with linked worktrees populates the rail without a reload.
    setRepoRoot(id: string, repoRoot: string | null) {
      setState(produce((s) => {
        const ws = s.workspaces.find((w) => w.id === id);
        if (!ws) return;
        ws.repoRoot = repoRoot;
        ws.isRepo = false;
        const main = ws.worktrees.find((w) => w.isMain) ?? ws.worktrees[0];
        if (main) {
          main.path = repoRoot ?? "";
          main.branch = null;
          main.isSynthetic = true;
        }
      }));
      if (repoRoot) {
        void actions.hydrateWorktrees(id);
        void actions.adoptRepoName(id);
      }
    },

    /// Name a workspace after the repository it points at. Runs on every
    /// folder pick but only ever replaces a name we invented — a workspace
    /// the user renamed keeps that name forever. The remote's repo name is
    /// preferred over the folder basename; a folder that isn't a repo still
    /// gets its basename, which beats `Workspace 3`.
    async adoptRepoName(workspaceId: string): Promise<void> {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      const repoRoot = ws?.repoRoot;
      if (!ws || !repoRoot || !isAutoWorkspaceName(ws.name)) return;
      let remoteUrl: string | null = null;
      try {
        remoteUrl = (await gitApi.repoInfo(repoRoot)).remoteUrl;
      } catch {
        // Not a repo (or git failed) — the folder name is still the answer.
      }
      // The await gave the user time to re-point or rename this workspace;
      // re-read before writing so we never clobber a newer decision.
      const current = state.workspaces.find((w) => w.id === workspaceId);
      if (!current || current.repoRoot !== repoRoot) return;
      if (!isAutoWorkspaceName(current.name)) return;
      actions.renameWorkspace(workspaceId, repoDisplayName(repoRoot, remoteUrl));
    },
  };

  return actions;
}
