/// Fetch, Pull and Manage-remotes, as one thing both git surfaces can mount.
///
/// These three lived only in `GitSidebar`'s header. The standalone git window —
/// the one you open precisely *because* you want the git surface at full size —
/// had no way to fetch, no way to pull, and no way to reach the remotes dialog
/// at all. You could rebase, cherry-pick, reset and delete branches there, but
/// not find out that the branch you were about to rebase onto had moved.
///
/// Extracted rather than duplicated because the interesting part is not the
/// buttons, it is `pullBlockedReason` and the conflict routing: a second copy
/// of those would have drifted, and the drift would be silent.

import { Show, createSignal } from "solid-js";
import { ArrowDownToLine, Cloud, DownloadCloud } from "lucide-solid";
import type { GitRepoInfo } from "@/types/git";
import { gitApi } from "@/api/git";
import { openMerge } from "@/components/git/openMerge";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { useAppStore } from "@/store/LayoutContext";

/// What the header needs to know about the repository to gate Pull.
export type SyncInfo = Pick<
  GitRepoInfo,
  "operation" | "isDetached" | "headOid" | "upstream" | "behind"
>;

export interface GitSync {
  syncing: () => boolean;
  doFetch: () => Promise<void>;
  doPull: (mode?: "ff-only" | "merge" | "rebase") => Promise<void>;
  /// Why Pull cannot run right now, or `null` when it can.
  ///
  /// Enabled-in-every-state meant clicking it on a detached HEAD, an unborn
  /// branch or a branch with no upstream produced a raw porcelain error string
  /// in a toast. The button says the reason before you press it.
  pullBlockedReason: () => string | null;
}

export function createGitSync(opts: {
  repoPath: () => string;
  worktreeId: () => string;
  info: () => SyncInfo | null;
}): GitSync {
  const { actions } = useAppStore();
  const [syncing, setSyncing] = createSignal(false);

  async function doFetch() {
    setSyncing(true);
    try {
      // No remote name: fetch every configured remote. Passing none used to
      // mean "origin" in Rust, so a remote added through the Remotes dialog
      // was never fetched by anything and its branches never appeared.
      await gitApi.fetch(opts.repoPath());
      pushToast("Fetched all remotes", "success", 2000);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    } finally {
      setSyncing(false);
      emitGitRefsChanged();
    }
  }

  async function doPull(mode: "ff-only" | "merge" | "rebase" = "ff-only") {
    setSyncing(true);
    try {
      const res = await gitApi.pull(opts.repoPath(), mode);
      if (res.conflicted) {
        const conflicts = await gitApi.listConflicts(opts.repoPath());
        await Promise.all(
          conflicts.map((c) => openMerge(actions, opts.worktreeId(), `${opts.repoPath()}/${c}`)),
        );
        pushToast("Pull stopped on conflicts — resolve them, then continue.", "warning", 6000);
      } else if (res.ok) {
        pushToast("Pulled from origin", "success", 2000);
      } else {
        pushToast(res.message || "Pull failed", "error", 7000);
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    } finally {
      setSyncing(false);
      emitGitRefsChanged();
    }
  }

  const pullBlockedReason = (): string | null => {
    const current = opts.info();
    if (!current) return null;
    if (current.operation) return `Finish or abort the ${current.operation} first`;
    if (current.isDetached) return "HEAD is detached — check out a branch to pull";
    if (!current.headOid) return "This branch has no commits yet — nothing to pull into";
    if (!current.upstream) return "No upstream is set for this branch";
    return null;
  };

  return { syncing, doFetch, doPull, pullBlockedReason };
}

/// The three buttons. Kept separate from `createGitSync` because the sidebar
/// header lays them out among its own controls while the git window's title bar
/// puts them on their own.
export function GitSyncControls(props: {
  sync: GitSync;
  info: () => SyncInfo | null;
  onManageRemotes: () => void;
}) {
  const behind = () => props.info()?.behind ?? 0;
  return (
    <>
      <button
        onClick={() => void props.sync.doFetch()}
        disabled={props.sync.syncing()}
        aria-label="Fetch from origin"
        title="Fetch from origin"
        class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-40"
      >
        <DownloadCloud class={`w-3 h-3 ${props.sync.syncing() ? "animate-pulse" : ""}`} />
      </button>
      <button
        onClick={() => void props.sync.doPull()}
        disabled={props.sync.syncing() || props.sync.pullBlockedReason() !== null}
        aria-label="Pull from origin"
        title={
          props.sync.pullBlockedReason() ??
          (behind() > 0 ? `Pull ${behind()} commit(s) from upstream` : "Pull from origin")
        }
        class="flex items-center gap-0.5 px-1 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-40 tabular-nums"
      >
        <ArrowDownToLine class="w-3 h-3" />
        <Show when={behind() > 0}>
          <span class="text-[10px] text-destructive">{behind()}</span>
        </Show>
      </button>
      <button
        onClick={props.onManageRemotes}
        aria-label="Manage remotes"
        title="Manage remotes"
        class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
      >
        <Cloud class="w-3 h-3" />
      </button>
    </>
  );
}
