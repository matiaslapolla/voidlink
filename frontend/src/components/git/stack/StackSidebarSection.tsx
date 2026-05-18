import { For, Show, createResource, onCleanup, onMount } from "solid-js";
import { AlertTriangle, Layers, GitPullRequest, Plus, ExternalLink } from "lucide-solid";
import { stackApi } from "@/api/stack";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";
import type { Stack, StackBranch } from "@/types/stack";

interface StackSidebarSectionProps {
  repoPath: string;
  workspaceId: string;
}

/// Read-only Wave-A view. Wave B adds the [+ Branch on top] / [Open tab]
/// buttons; Wave C wires per-branch [Restack]. For now this just *shows*
/// the chain so users can confirm voidlink picked it up correctly.
export function StackSidebarSection(props: StackSidebarSectionProps) {
  const { actions } = useAppStore();
  const [stack, { refetch }] = createResource(
    () => props.repoPath,
    (p) => stackApi.current(p),
  );

  // Refresh on the shared "voidlink:refresh-git" event so that branch
  // operations elsewhere keep the stack view in sync without us having to
  // thread a callback through every caller.
  onMount(() => {
    const handler = () => refetch();
    window.addEventListener("voidlink:refresh-git", handler);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", handler));
  });

  function broadcastRefresh() {
    window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
  }

  async function branchOnTop(parent: string) {
    const name = window.prompt(`New branch on top of ${parent}:`)?.trim();
    if (!name) return;
    try {
      await stackApi.createBranch(props.repoPath, name, parent);
      pushToast(`Created ${name} on top of ${parent}`, "success");
      broadcastRefresh();
    } catch (e) {
      pushToast(String(e), "error");
    }
  }

  function openStackTab(s: Stack) {
    const top = s.branches.at(-1)?.name;
    if (!top) return;
    actions.openStackTab(props.workspaceId, { trunk: s.trunk, topBranch: top });
  }

  async function startStackFromHead() {
    // The "empty state" path: HEAD is on a non-trunk branch with no parent
    // recorded. Treat the current branch as the *parent* (so we branch off
    // it and start a stack), since making the current branch a child of
    // some other branch is the rarer intent and easier to do via the
    // tracked-branch workflow once one exists.
    let head: string | null = null;
    try {
      const info = await gitApi.repoInfo(props.repoPath);
      head = info.currentBranch;
    } catch (e) {
      pushToast(String(e), "error");
      return;
    }
    if (!head) {
      pushToast("HEAD is detached — check out a branch first", "warning");
      return;
    }
    await branchOnTop(head);
  }

  return (
    <Show
      when={!stack.loading}
      fallback={
        <div class="px-2.5 py-2 text-[12px] text-muted-foreground">Loading stack…</div>
      }
    >
      <Show
        when={stack()}
        fallback={
          <div class="px-2.5 py-2.5 text-[12px] text-muted-foreground leading-snug space-y-2">
            <div>
              <Layers class="w-3.5 h-3.5 inline-block mr-1 opacity-60 align-[-2px]" />
              Not on a stack.
            </div>
            <button
              onClick={() => void startStackFromHead()}
              class="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Create a child branch off the current branch and start a stack"
            >
              <Plus class="w-3 h-3" />
              Start stack on top of current
            </button>
          </div>
        }
      >
        {(s) => (
          <StackChain
            stack={s()}
            onBranchOnTop={(parent) => void branchOnTop(parent)}
            onOpenTab={() => openStackTab(s())}
          />
        )}
      </Show>
    </Show>
  );
}

function StackChain(props: {
  stack: NonNullable<Awaited<ReturnType<typeof stackApi.current>>>;
  onBranchOnTop: (parent: string) => void;
  onOpenTab: () => void;
}) {
  // Render top-down (topmost branch first, trunk last) — matches how Graphite,
  // gt, and other stack tools present chains and matches how the user reads
  // the diff history (newest at top).
  const ordered = () => [...props.stack.branches].reverse();
  const topBranch = () => props.stack.branches.at(-1)?.name ?? "";
  return (
    <div class="px-1.5 py-1.5 space-y-0.5">
      <For each={ordered()}>
        {(branch, i) => (
          <StackRow
            branch={branch}
            // The last entry rendered is the bottom of the stack, just above
            // the trunk row.
            isBottom={i() === ordered().length - 1}
          />
        )}
      </For>
      <TrunkRow trunk={props.stack.trunk} />
      <Show when={props.stack.needsRestack}>
        <div class="mt-1.5 mx-1 px-2 py-1 rounded bg-warning/10 border border-warning/30 text-[11px] text-warning flex items-center gap-1">
          <AlertTriangle class="w-3 h-3" />
          Parent moved — needs restack.
        </div>
      </Show>
      <div class="mt-1.5 px-1 flex items-center gap-1.5">
        <button
          onClick={() => props.onBranchOnTop(topBranch())}
          class="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title={`Create a new branch on top of ${topBranch()}`}
        >
          <Plus class="w-3 h-3" />
          Branch on top
        </button>
        <button
          onClick={props.onOpenTab}
          class="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="Open the full stack workspace tab"
        >
          <ExternalLink class="w-3 h-3" />
          Open tab
        </button>
      </div>
    </div>
  );
}

function StackRow(props: { branch: StackBranch; isBottom: boolean }) {
  const driftAgainstParent = () => {
    // A branch "needs restack" when its recorded parentbase no longer matches
    // the parent's current tip. We don't have the parent tip in this struct;
    // proxy with behindParent > 0 which is a sufficient (not necessary)
    // condition — if parent advanced, behind > 0.
    return props.branch.behindParent > 0;
  };
  return (
    <div
      class={`group flex items-center gap-1 px-1.5 py-1 rounded text-[12px] ${
        props.branch.isHead
          ? "bg-primary/10 text-primary"
          : "text-foreground/85 hover:bg-accent/40"
      }`}
    >
      <span class="w-3 text-center shrink-0 font-mono">
        {props.branch.isHead ? "◉" : "│"}
      </span>
      <span class="flex-1 truncate font-medium" title={props.branch.name}>
        {props.branch.name}
      </span>
      <Show when={props.branch.aheadOfParent > 0}>
        <span class="text-success tabular-nums text-[11px]">
          ↑{props.branch.aheadOfParent}
        </span>
      </Show>
      <Show when={driftAgainstParent()}>
        <AlertTriangle class="w-3 h-3 text-warning shrink-0" />
      </Show>
      <Show when={props.branch.prNumber}>
        {(n) => (
          <span class="flex items-center gap-0.5 text-[10px] text-muted-foreground/80 tabular-nums">
            <GitPullRequest class="w-2.5 h-2.5" />
            {n()}
          </span>
        )}
      </Show>
    </div>
  );
}

function TrunkRow(props: { trunk: string }) {
  return (
    <div class="flex items-center gap-1 px-1.5 py-1 text-[12px] text-muted-foreground">
      <span class="w-3 text-center shrink-0 font-mono">└</span>
      <span class="truncate">{props.trunk}</span>
      <span class="text-[10px] text-muted-foreground/70 ml-1 uppercase tracking-wide">
        trunk
      </span>
    </div>
  );
}

