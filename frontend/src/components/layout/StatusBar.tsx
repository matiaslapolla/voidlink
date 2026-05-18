import { Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { Eye, EyeOff, GitBranch, GitCommit, Layers, Loader2, Sparkles, FileWarning } from "lucide-solid";
import { gitApi } from "@/api/git";
import { stackApi } from "@/api/stack";
import { useAppStore } from "@/store/LayoutContext";
import { aiCommitState } from "@/commands/aiCommit";
import { blameEnabled, toggleBlame } from "@/components/editor/blameOverlay";

/// Thin always-visible bottom bar that consolidates "what's the state of
/// my repo *right now*" into one row: branch, ahead/behind, in-flight AI
/// draft, and stack position. Today these signals are scattered across
/// the sidebar and toasts; the bar surfaces them when the sidebar is
/// collapsed and makes the AI-draft moment visible from any view.
export function StatusBar() {
  const { state, activeWorkspace } = useAppStore();
  const repoPath = () => activeWorkspace()?.repoRoot ?? null;

  /// Tracks an external "refresh" event so the bar follows the same
  /// refetch cadence as the git sidebar.
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const onRefresh = () => setTick((t) => t + 1);
    window.addEventListener("voidlink:refresh-git", onRefresh);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", onRefresh));
  });

  const [info] = createResource(
    () => ({ path: repoPath(), tick: tick() }),
    async ({ path }) => (path ? await gitApi.repoInfo(path) : null),
  );

  /// Stack discovery is best-effort — many repos won't be on a stack.
  /// Errors silently degrade to no stack chip.
  const [stack] = createResource(
    () => ({ path: repoPath(), tick: tick(), branch: info()?.currentBranch ?? null }),
    async ({ path }) => {
      if (!path) return null;
      try {
        return await stackApi.current(path);
      } catch {
        return null;
      }
    },
  );

  const stackPosition = () => {
    const s = stack();
    const head = info()?.currentBranch;
    if (!s || !head) return null;
    const idx = s.branches.findIndex((b) => b.name === head);
    if (idx === -1) return null;
    return { position: idx + 1, total: s.branches.length, trunk: s.trunk };
  };

  const aiDraft = () => {
    const s = aiCommitState();
    if (s.kind === "drafting" && s.repoPath === repoPath()) {
      return { state: "drafting" as const };
    }
    if (s.kind === "error" && s.repoPath === repoPath()) {
      return { state: "error" as const, reason: s.reason };
    }
    return null;
  };

  return (
    <div
      class="flex items-center h-6 px-2 gap-3 text-[11px] text-muted-foreground border-t border-border bg-sidebar shrink-0 select-none"
      role="status"
      aria-label="Repository status"
    >
      <Show
        when={repoPath()}
        fallback={<span class="opacity-60">No repository</span>}
      >
        <Show when={info()}>
          {(repoInfo) => (
            <>
              <span class="flex items-center gap-1" title={repoInfo().upstream ?? "no upstream"}>
                <GitBranch class="w-3 h-3" />
                <span class="font-mono">
                  {repoInfo().isDetached
                    ? `(detached ${repoInfo().headOid?.slice(0, 7) ?? "?"})`
                    : repoInfo().currentBranch ?? "unknown"}
                </span>
              </span>
              <Show when={repoInfo().ahead > 0 || repoInfo().behind > 0}>
                <span class="flex items-center gap-0.5 font-mono tabular-nums">
                  <Show when={repoInfo().ahead > 0}>
                    <span class="text-success">↑{repoInfo().ahead}</span>
                  </Show>
                  <Show when={repoInfo().behind > 0}>
                    <span class="text-destructive">↓{repoInfo().behind}</span>
                  </Show>
                </span>
              </Show>
              <Show when={!repoInfo().isClean}>
                <span class="text-warning flex items-center gap-1" title="Working tree has uncommitted changes">
                  <GitCommit class="w-3 h-3" />
                  <span>dirty</span>
                </span>
              </Show>
            </>
          )}
        </Show>
      </Show>

      <Show when={stackPosition()}>
        {(pos) => (
          <span
            class="flex items-center gap-1"
            title={`Stack rooted at ${pos().trunk}`}
          >
            <Layers class="w-3 h-3" />
            <span class="font-mono tabular-nums">
              stack {pos().position}/{pos().total}
            </span>
          </span>
        )}
      </Show>

      <Show when={aiDraft()}>
        {(d) => (
          <Show
            when={d().state === "drafting"}
            fallback={
              <span class="flex items-center gap-1 text-destructive" title={(d() as { state: "error"; reason: string }).reason}>
                <FileWarning class="w-3 h-3" />
                AI draft failed
              </span>
            }
          >
            <span class="flex items-center gap-1 text-primary">
              <Loader2 class="w-3 h-3 animate-spin" />
              <Sparkles class="w-3 h-3" />
              Drafting commit…
            </span>
          </Show>
        )}
      </Show>

      <span class="flex-1" />

      <button
        onClick={toggleBlame}
        title={blameEnabled() ? "Inline blame: on (click to disable)" : "Inline blame: off (click to enable)"}
        aria-label="Toggle inline blame"
        class={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
          blameEnabled()
            ? "text-primary bg-primary/10 hover:bg-primary/15"
            : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
        }`}
      >
        <Show when={blameEnabled()} fallback={<EyeOff class="w-3 h-3" />}>
          <Eye class="w-3 h-3" />
        </Show>
        <span class="text-[10px] uppercase tracking-wide">Blame</span>
      </button>

      <span class="opacity-60 font-mono">
        {state.workspaces.length} workspace{state.workspaces.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}
