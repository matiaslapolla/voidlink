/// ⌘⇧P — every worktree in every workspace, in one list.
///
/// The workspace rail already shows this, but only for the workspace you are
/// standing in: getting to a worktree of another repo is a click on the rail
/// then a click in its list, and the rail can be collapsed. This is the
/// keyboard path, and it is flat — repo and branch are two fields of one row
/// rather than two levels of navigation.
///
/// Reuses `QuickPick.tsx` and `fuzzy.ts`, like the file finder and the palette.
/// A third overlay implementation would be the thing to avoid here.
import { Show, createMemo, createSignal } from "solid-js";
import { GitBranch, FolderGit2, Lock } from "lucide-solid";
import { bestFuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPick, QuickPickEmpty, QuickPickRow } from "@/commands/QuickPick";
import { closeWorktreeSwitcher, isWorktreeSwitcherOpen } from "@/commands/registry";
import { useAppStore } from "@/store/LayoutContext";
import type { Workspace, Worktree } from "@/types/workspace";

interface Row {
  workspace: Workspace;
  worktree: Worktree;
  /// The searched text: "repo · branch-or-path".
  haystack: string;
  label: string;
  score: number;
  ranges: MatchRange[];
}

export function WorktreeSwitcher() {
  return (
    <Show when={isWorktreeSwitcherOpen()}>
      <SwitcherContent />
    </Show>
  );
}

function SwitcherContent() {
  const { state, actions } = useAppStore();
  const [query, setQuery] = createSignal("");

  const worktreeLabel = (wt: Worktree) =>
    wt.branch ?? (wt.path.split("/").filter(Boolean).pop() ?? wt.path);

  const rows = createMemo<Row[]>(() => {
    const q = query().trim();
    const out: Row[] = [];
    for (const workspace of state.workspaces) {
      for (const worktree of workspace.worktrees) {
        const label = worktreeLabel(worktree);
        const match = bestFuzzyMatch([label, workspace.name, worktree.path], q, {
          pathAware: true,
        });
        if (!match) continue;
        out.push({
          workspace,
          worktree,
          label,
          haystack: `${workspace.name} ${label}`,
          ranges: match.field === 0 ? match.match.ranges : [],
          score: match.match.score,
        });
      }
    }
    // The worktree you are standing in sorts to the top of the resting list —
    // it is the one whose state you are most likely checking.
    const here = (row: Row) => (row.worktree.id === state.activeWorktreeId ? 0 : 1);
    return q
      ? out.sort((a, b) => b.score - a.score)
      : out.sort((a, b) => here(a) - here(b));
  });

  function pick(row: Row) {
    closeWorktreeSwitcher();
    actions.selectWorktree(row.worktree.id);
  }

  return (
    <QuickPick
      items={rows()}
      itemKey={(row) => row.worktree.id}
      query={query()}
      onQuery={setQuery}
      onPick={pick}
      onClose={closeWorktreeSwitcher}
      label="Go to worktree"
      placeholder="Go to a worktree in any workspace…"
      empty={
        <QuickPickEmpty
          icon={<FolderGit2 class="w-5 h-5" />}
          message="No worktree matches that."
          hint="Search by repository name, branch or path."
        />
      }
      renderItem={(row, highlighted) => (
        <WorktreeRow
          row={row}
          current={row.worktree.id === state.activeWorktreeId}
          highlighted={highlighted()}
        />
      )}
    />
  );
}

function WorktreeRow(props: { row: Row; current: boolean; highlighted: boolean }) {
  const wt = () => props.row.worktree;
  return (
    <QuickPickRow highlighted={props.highlighted}>
      <span class="text-micro tracking-wide text-muted-foreground/70 w-24 shrink-0 truncate">
        {props.row.workspace.name}
      </span>
      <GitBranch class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <FuzzyText text={props.row.label} ranges={props.row.ranges} class="truncate font-mono" />
      <Show when={props.current}>
        <span class="shrink-0 text-micro px-1 rounded bg-primary/15 border border-primary/40 text-primary">
          here
        </span>
      </Show>
      {/* Badges the rail already shows, in the same vocabulary. Each carries a
          glyph or a letter as well as a colour — §10.12 forbids colour as the
          only channel. */}
      <span class="ml-auto shrink-0 flex items-center gap-1.5 text-micro font-mono">
        <Show when={wt().isDirty}>
          <span class="text-warning" title="Uncommitted changes">
            ●
          </span>
        </Show>
        <Show when={wt().ahead > 0}>
          <span class="text-success" title={`${wt().ahead} commit(s) ahead of upstream`}>
            ↑{wt().ahead}
          </span>
        </Show>
        <Show when={wt().behind > 0}>
          <span class="text-info" title={`${wt().behind} commit(s) behind upstream`}>
            ↓{wt().behind}
          </span>
        </Show>
        <Show when={wt().statusUnknown}>
          <span
            class="text-muted-foreground/70"
            title="Could not read this worktree's status — it may be missing or unreachable"
            aria-label="status unknown"
          >
            ?
          </span>
        </Show>
        <Show when={wt().isPrunable}>
          <span class="text-destructive" title="This worktree's directory is gone">
            missing
          </span>
        </Show>
        <Show when={wt().isLocked}>
          <Lock class="w-3 h-3 text-muted-foreground" aria-label="locked" />
        </Show>
      </span>
    </QuickPickRow>
  );
}
