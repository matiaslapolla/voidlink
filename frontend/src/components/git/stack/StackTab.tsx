import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  GitBranchPlus,
  GitMerge,
  GitPullRequest,
  Link2Off,
  Loader2,
  Plus,
  RefreshCw,
  Send,
} from "lucide-solid";
import { stackApi } from "@/api/stack";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";
import type { StackTab as StackTabState } from "@/store/layout";
import type { RestackResult, StackBranch, SubmitResult } from "@/types/stack";

// Full stack workspace. Lists every branch in the chain top-down with the
// same conventions as the sidebar section, plus per-branch actions and a
// header row for stack-wide operations. Restack / Submit are scaffolded in
// Wave B as disabled buttons with tooltips pointing at the wave they land
// in — keeps the UI honest about what works today.

type Props = {
  repoPath: string;
  tab: StackTabState;
  workspaceId: string;
};

interface ConflictBanner {
  branch: string;
  commit: string;
  paths: string[];
}

export function StackTab(props: Props) {
  const { actions } = useAppStore();
  const [conflict, setConflict] = createSignal<ConflictBanner | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [submitResults, setSubmitResults] = createSignal<SubmitResult[] | null>(null);

  // Discover the stack each time the topBranch identifier (or repo) changes.
  // We don't rely on the stack the tab was created with — branches move,
  // parents get rewritten, and reading config on each render is cheap.
  const [stack, { refetch }] = createResource(
    () => ({
      repoPath: props.repoPath,
      trunk: props.tab.trunk,
      topBranch: props.tab.topBranch,
    }),
    async (k) => {
      const all = await stackApi.list(k.repoPath);
      return (
        all.find(
          (s) => s.trunk === k.trunk && s.branches.at(-1)?.name === k.topBranch,
        ) ?? null
      );
    },
  );

  // Refresh on the shared git-refresh signal so a checkout / commit elsewhere
  // immediately reflects in the stack tab.
  onMount(() => {
    const handler = () => refetch();
    window.addEventListener("voidlink:refresh-git", handler);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", handler));
  });

  function broadcastRefresh() {
    window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
  }

  async function onBranchOnTop(parent: string) {
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

  async function onUntrack(branch: string) {
    if (!window.confirm(`Stop tracking ${branch} as part of this stack?`)) return;
    try {
      await stackApi.untrack(props.repoPath, branch);
      pushToast(`Untracked ${branch}`, "info");
      broadcastRefresh();
    } catch (e) {
      pushToast(String(e), "error");
    }
  }

  async function onCopyBranch(branch: string) {
    try {
      await navigator.clipboard.writeText(branch);
      pushToast(`Copied ${branch}`, "success");
    } catch {
      pushToast("Copy failed", "error");
    }
  }

  function onOpenCompare(branch: StackBranch) {
    actions.openCompareTab(props.workspaceId, {
      baseRef: branch.parent,
      headRef: branch.name,
      useMergeBase: true,
    });
  }

  async function onCheckout(name: string) {
    try {
      await gitApi.checkoutBranch(props.repoPath, name);
      pushToast(`Switched to ${name}`, "success");
      broadcastRefresh();
    } catch (e) {
      pushToast(String(e), "error");
    }
  }

  /// Surface the per-result outcome as a toast. Returns true iff the result
  /// was a conflict (so callers can stop processing further branches).
  function reportResult(r: RestackResult): boolean {
    if (r.outcome.kind === "skipped") {
      pushToast(`${r.branch}: ${r.outcome.reason}`, "info");
      return false;
    }
    if (r.outcome.kind === "restacked") {
      pushToast(
        `Restacked ${r.branch} (${r.outcome.commitsReplayed} commit${r.outcome.commitsReplayed === 1 ? "" : "s"})`,
        "success",
      );
      return false;
    }
    setConflict({
      branch: r.branch,
      commit: r.outcome.conflictingCommit,
      paths: r.outcome.paths,
    });
    pushToast(`Restack conflict on ${r.branch}`, "error", 6000);
    return true;
  }

  async function onRestackOne(branch: string) {
    if (busy()) return;
    setBusy(true);
    setConflict(null);
    try {
      const result = await stackApi.restack(props.repoPath, branch);
      reportResult(result);
      broadcastRefresh();
    } catch (e) {
      pushToast(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    if (busy()) return;
    const s = stack();
    if (!s) return;
    setBusy(true);
    try {
      const branchNames = s.branches.map((b) => b.name);
      const results = await stackApi.submit(props.repoPath, branchNames);
      setSubmitResults(results);
      const failed = results.filter((r) => r.outcome.kind === "failed").length;
      if (failed === 0) {
        pushToast(`Submitted ${results.length} branch(es) to GitHub`, "success");
      } else {
        pushToast(
          `Submit finished with ${failed} failure${failed === 1 ? "" : "s"}`,
          "warning",
          6000,
        );
      }
      broadcastRefresh();
    } catch (e) {
      pushToast(String(e), "error", 6000);
    } finally {
      setBusy(false);
    }
  }

  async function onRestackAll() {
    if (busy()) return;
    const s = stack();
    if (!s) return;
    setBusy(true);
    setConflict(null);
    try {
      // Bottom-up order: closest-to-trunk first. The Rust side stops on the
      // first conflict, but we pass the order so the contract is explicit.
      const branchNames = s.branches.map((b) => b.name);
      const results = await stackApi.restackAll(props.repoPath, branchNames);
      let stopped = false;
      for (const r of results) {
        if (reportResult(r)) {
          stopped = true;
          break;
        }
      }
      if (!stopped) {
        pushToast("Stack restacked clean", "success");
      }
      broadcastRefresh();
    } catch (e) {
      pushToast(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const orderedTopDown = createMemo<StackBranch[]>(() => {
    const s = stack();
    return s ? [...s.branches].reverse() : [];
  });

  return (
    <div class="absolute inset-0 flex flex-col bg-background overflow-hidden">
      {/* Header / actions */}
      <div class="shrink-0 px-4 py-3 border-b border-border flex items-center gap-2">
        <h2 class="text-[13px] font-semibold flex items-center gap-1.5">
          <GitBranchPlus class="w-3.5 h-3.5 opacity-70" />
          Stack:
          <span class="font-mono text-foreground/90">{props.tab.topBranch}</span>
        </h2>
        <span class="text-[11px] text-muted-foreground">
          on <span class="font-mono">{props.tab.trunk}</span>
        </span>
        <Show when={stack()?.needsRestack}>
          <span class="flex items-center gap-1 text-[11px] text-warning bg-warning/10 px-2 py-0.5 rounded">
            <AlertTriangle class="w-3 h-3" />
            needs restack
          </span>
        </Show>
        <div class="flex-1" />
        <button
          onClick={() => refetch()}
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
          title="Refresh"
        >
          <RefreshCw class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void onRestackAll()}
          disabled={busy() || !stack()?.needsRestack}
          title={
            !stack()?.needsRestack
              ? "Stack is already in sync"
              : busy()
                ? "Working…"
                : "Replay each branch's commits onto its parent's current tip"
          }
          class="flex items-center gap-1 px-2 py-1 rounded text-[12px] border border-border text-foreground hover:bg-accent/40 disabled:text-muted-foreground/40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <RefreshCw class={`w-3 h-3 ${busy() ? "animate-spin" : ""}`} />
          Restack all
        </button>
        <button
          onClick={() => void onSubmit()}
          disabled={busy()}
          title="Create or update one PR per branch (requires GITHUB_TOKEN)"
          class="flex items-center gap-1 px-2 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send class={`w-3 h-3 ${busy() ? "animate-spin" : ""}`} />
          Submit stack
        </button>
      </div>

      <Show when={submitResults()}>
        {(results) => (
          <SubmitResultsModal
            results={results()}
            onClose={() => setSubmitResults(null)}
          />
        )}
      </Show>

      <Show when={conflict()}>
        {(c) => (
          <div class="mx-4 my-3 p-3 rounded border border-destructive/40 bg-destructive/5 text-[12px] space-y-2">
            <div class="flex items-center gap-2 text-destructive font-medium">
              <AlertTriangle class="w-3.5 h-3.5" />
              Conflict restacking {c().branch}
            </div>
            <div class="text-muted-foreground">
              Cherry-picking commit{" "}
              <span class="font-mono text-foreground/80">
                {c().commit.slice(0, 7)}
              </span>{" "}
              produced conflicts. The branch ref is unchanged, but the working
              tree now contains the partial cherry-pick with conflict markers.
            </div>
            <div class="text-muted-foreground">Conflicting paths — click to resolve:</div>
            <ul class="space-y-1">
              <For each={c().paths}>
                {(p) => (
                  <li>
                    <button
                      onClick={() =>
                        actions.openConflictTab(props.workspaceId, `${props.repoPath}/${p}`)
                      }
                      class="w-full flex items-center gap-2 px-2 py-1 rounded border border-warning/40 bg-warning/5 hover:bg-warning/10 text-warning text-[11px] text-left"
                    >
                      <GitMerge class="w-3 h-3 shrink-0" />
                      <span class="font-mono flex-1 truncate">{p}</span>
                      <span class="text-[10px] uppercase tracking-wide opacity-70">resolve</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <div class="flex items-center gap-2 pt-1">
              <button
                onClick={() => setConflict(null)}
                class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
              >
                Dismiss
              </button>
              <span class="text-[11px] text-muted-foreground/70">
                Or resolve in a terminal and re-run restack.
              </span>
            </div>
          </div>
        )}
      </Show>

      {/* Body */}
      <div class="flex-1 overflow-auto">
        <Show
          when={!stack.loading}
          fallback={
            <div class="flex items-center justify-center h-full text-muted-foreground text-[13px]">
              <Loader2 class="w-4 h-4 animate-spin mr-2" /> Discovering stack…
            </div>
          }
        >
          <Show
            when={stack()}
            fallback={
              <div class="flex flex-col items-center justify-center h-full text-muted-foreground text-[13px] gap-2 p-6 text-center">
                <p>This stack is no longer discoverable.</p>
                <p class="text-[12px] opacity-70">
                  Its top branch (<span class="font-mono">{props.tab.topBranch}</span>)
                  may have been deleted or untracked. Close this tab.
                </p>
              </div>
            }
          >
            {(s) => (
              <div class="p-4 max-w-2xl mx-auto">
                <For each={orderedTopDown()}>
                  {(branch, idx) => (
                    <StackTabRow
                      branch={branch}
                      position={
                        idx() === 0
                          ? orderedTopDown().length === 1 ? "only" : "top"
                          : "middle"
                      }
                      busy={busy()}
                      onOpenCompare={() => onOpenCompare(branch)}
                      onCheckout={() => void onCheckout(branch.name)}
                      onBranchOnTop={() => void onBranchOnTop(branch.name)}
                      onUntrack={() => void onUntrack(branch.name)}
                      onCopy={() => void onCopyBranch(branch.name)}
                      onRestack={() => void onRestackOne(branch.name)}
                    />
                  )}
                </For>
                <TrunkRow trunk={s().trunk} />
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function StackTabRow(props: {
  branch: StackBranch;
  /// Position in the rendered chain — used to draw the connecting SVG
  /// rail with the right top/bottom truncation. "only" means a single
  /// branch in the stack (no rail above or below the dot).
  position: "top" | "middle" | "only";
  busy: boolean;
  onOpenCompare: () => void;
  onCheckout: () => void;
  onBranchOnTop: () => void;
  onUntrack: () => void;
  onCopy: () => void;
  onRestack: () => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuBtn: HTMLButtonElement | undefined;

  onMount(() => {
    const onDoc = (e: MouseEvent) => {
      if (!menuOpen()) return;
      const t = e.target as Node;
      if (menuBtn?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    onCleanup(() => document.removeEventListener("mousedown", onDoc));
  });

  const drift = () => props.branch.behindParent > 0;
  return (
    <div class="flex items-stretch">
      <StackRail position={props.position} isHead={props.branch.isHead} drift={drift()} />
      <div
        class={`group flex-1 flex items-center gap-2 px-3 py-2 rounded border ${
          props.branch.isHead
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-card/50 hover:bg-accent/30"
        }`}
      >
      <button
        onClick={props.onOpenCompare}
        class="font-mono text-[13px] font-medium hover:underline truncate min-w-0 flex-1 text-left"
        title={`Compare ${props.branch.parent}..${props.branch.name}`}
      >
        {props.branch.name}
      </button>
      <Show when={props.branch.aheadOfParent > 0}>
        <span class="text-success text-[11px] tabular-nums">
          ↑{props.branch.aheadOfParent}
        </span>
      </Show>
      <Show when={drift()}>
        <span
          class="flex items-center gap-0.5 text-[11px] text-warning"
          title={`Parent ${props.branch.parent} has ${props.branch.behindParent} commit(s) you don't have`}
        >
          <AlertTriangle class="w-3 h-3" />
          needs restack
        </span>
      </Show>
      <Show when={props.branch.prNumber}>
        {(n) => (
          <span class="flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
            <GitPullRequest class="w-3 h-3" />
            #{n()}
          </span>
        )}
      </Show>
      <Show when={!props.branch.isHead}>
        <button
          onClick={props.onCheckout}
          class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title={`Check out ${props.branch.name}`}
        >
          Switch
        </button>
      </Show>
      <button
        onClick={props.onBranchOnTop}
        class="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
        title="Create a new branch on top"
      >
        <Plus class="w-3 h-3" />
        Branch
      </button>
      <button
        onClick={props.onRestack}
        disabled={props.busy || !drift()}
        title={
          !drift()
            ? "Already on parent — nothing to restack"
            : props.busy
              ? "Working…"
              : `Replay ${props.branch.name}'s commits onto ${props.branch.parent}`
        }
        class="text-[11px] px-2 py-0.5 rounded border border-border text-foreground hover:bg-accent/40 disabled:text-muted-foreground/40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        Restack
      </button>
      <div class="relative">
        <button
          ref={menuBtn}
          onClick={() => setMenuOpen((v) => !v)}
          class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40"
          aria-label="More actions"
        >
          <ChevronDown class="w-3.5 h-3.5" />
        </button>
        <Show when={menuOpen()}>
          <div class="absolute right-0 top-full mt-1 w-44 rounded-md border border-border bg-popover shadow-lg z-50 py-1 text-[12px]">
            <button
              onClick={() => {
                setMenuOpen(false);
                props.onCopy();
              }}
              class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/40"
            >
              <Copy class="w-3 h-3" />
              Copy branch name
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                props.onUntrack();
              }}
              class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-destructive hover:bg-destructive/10"
            >
              <Link2Off class="w-3 h-3" />
              Untrack from stack
            </button>
          </div>
        </Show>
      </div>
      </div>
    </div>
  );
}

/// Stack rail rendered as a 24px-wide SVG to the left of each branch
/// row. Draws a vertical line connecting consecutive branches plus a
/// circle marker at the row's vertical center; the marker is filled
/// primary when this row is HEAD, hollow otherwise, and shows a small
/// warning dot when the branch has drifted from its parent.
function StackRail(props: {
  position: "top" | "middle" | "only";
  isHead: boolean;
  drift: boolean;
}) {
  const W = 24;
  const H = 44;
  const mid = H / 2;
  const cx = W / 2;
  // Top half line: drawn unless this is the first row of the stack.
  // Bottom half line is always drawn — the trunk row at the bottom of
  // the stack also wants to connect upward visually.
  const showTop = () => props.position !== "top" && props.position !== "only";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="shrink-0 mr-1">
      <Show when={showTop()}>
        <line
          x1={cx}
          y1={0}
          x2={cx}
          y2={mid - 4}
          stroke="var(--primary)"
          stroke-width="1.5"
          opacity="0.6"
        />
      </Show>
      <line
        x1={cx}
        y1={mid + 4}
        x2={cx}
        y2={H}
        stroke="var(--primary)"
        stroke-width="1.5"
        opacity="0.6"
      />
      <circle
        cx={cx}
        cy={mid}
        r={4}
        fill={props.isHead ? "var(--primary)" : "var(--background)"}
        stroke="var(--primary)"
        stroke-width="1.5"
      />
      <Show when={props.drift}>
        <circle cx={cx + 6} cy={mid - 6} r={2.5} fill="var(--warning)" />
      </Show>
    </svg>
  );
}

function SubmitResultsModal(props: { results: SubmitResult[]; onClose: () => void }) {
  // Top-down order matches the server response; that's also the order users
  // see in the rest of the UI.
  return (
    <div
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
      onClick={props.onClose}
    >
      <div
        class="w-[480px] max-h-[70vh] overflow-auto rounded-md border border-border bg-popover shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-[13px] font-semibold mb-2 flex items-center gap-1.5">
          <Send class="w-3.5 h-3.5 opacity-70" />
          Submit results
        </h3>
        <ul class="space-y-1.5">
          <For each={props.results}>
            {(r) => (
              <li class="flex items-center gap-2 text-[12px] border border-border rounded px-2 py-1.5">
                <span class="font-mono text-foreground/85 truncate flex-1" title={r.branch}>
                  {r.branch}
                </span>
                <Show when={r.outcome.kind === "created"}>
                  <span class="text-success text-[11px]">created</span>
                </Show>
                <Show when={r.outcome.kind === "updated"}>
                  <span class="text-info text-[11px]">updated base</span>
                </Show>
                <Show when={r.outcome.kind === "noChange"}>
                  <span class="text-muted-foreground text-[11px]">no change</span>
                </Show>
                <Show when={r.outcome.kind === "failed"}>
                  {(() => {
                    const failed = r.outcome as Extract<typeof r.outcome, { kind: "failed" }>;
                    return (
                      <span class="text-destructive text-[11px]" title={failed.reason}>
                        failed
                      </span>
                    );
                  })()}
                </Show>
                <Show when={r.outcome.kind !== "failed"}>
                  {(() => {
                    const ok = r.outcome as Exclude<
                      typeof r.outcome,
                      { kind: "failed" }
                    >;
                    return (
                      <a
                        href={ok.url}
                        target="_blank"
                        rel="noreferrer"
                        class="text-primary text-[11px] tabular-nums hover:underline"
                      >
                        #{ok.number}
                      </a>
                    );
                  })()}
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.results.some((r) => r.outcome.kind === "failed")}>
          <div class="mt-3 text-[11px] text-muted-foreground">
            Failed branches commonly need a <span class="font-mono">git push</span>{" "}
            first, or a valid <span class="font-mono">GITHUB_TOKEN</span> with
            <span class="font-mono"> repo</span> scope.
          </div>
        </Show>
        <div class="mt-3 flex justify-end">
          <button
            onClick={props.onClose}
            class="text-[12px] px-3 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function TrunkRow(props: { trunk: string }) {
  return (
    <div class="flex items-center gap-2 px-3 py-2 text-muted-foreground text-[12px]">
      <span class="w-3 text-center shrink-0 font-mono">└</span>
      <span class="font-mono">{props.trunk}</span>
      <span class="text-[10px] uppercase tracking-wide opacity-70">trunk</span>
    </div>
  );
}

