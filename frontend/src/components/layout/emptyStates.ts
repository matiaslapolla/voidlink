/// The one empty state, and the register of every use of it.
///
/// MASTER.md §9.7 fixes the *shape* — a Lucide icon at `w-5 h-5`, one line
/// naming why it is empty, and the action that fixes it as a real accelerator
/// rather than prose. What the shape alone does not give you is the property
/// that actually matters when there are ten of them: **no two may share an icon
/// or a sentence.** A user has to be able to tell "no worktrees in this
/// workspace" from "no tabs in this group" from "no changes" at a glance, and
/// three panels all saying "Nothing here yet" under a grey folder is exactly
/// the failure.
///
/// So the copy lives in `EMPTY_STATES` below rather than inline at ten call
/// sites, and `emptyStateCollisions()` — asserted in `EmptyState.test.ts` —
/// makes a collision a failing test instead of something you notice in a
/// screenshot review six months later.
///
/// The copy is a plain `.ts` module with no icon *components* in it, only their
/// names: `lucide-solid` cannot be imported outside a browser, and a rule this
/// easy to break silently is worth keeping testable in plain node.
/// `EmptyState.tsx` beside it maps the names to components.
export interface EmptyStateCopy {
  /// The *name* of the icon, so the collision check can compare icons without
  /// depending on component identity surviving a re-export.
  iconName: string;
  /// One line naming why it is empty. Not "No items" — why there are none.
  line: string;
}

/// Every empty state in the app, in one place so the collision rule is
/// checkable. Keys are stable ids, not display order.
export const EMPTY_STATES = {
  /// A workspace whose repo has no worktrees registered yet.
  workspaceNoWorktrees: {
    iconName: "FolderGit2",
    line: "This workspace has no worktrees yet.",
  },
  /// A worktree open with nothing in any group.
  worktreeNoTabs: {
    iconName: "PanelsTopLeft",
    line: "Nothing is open in this worktree.",
  },
  /// One group of a split, empty while its siblings hold tabs.
  groupNoTabs: {
    iconName: "LayoutGrid",
    line: "This pane is empty — drag a tab in, or open one here.",
  },
  /// `ChangesPane`, clean tree.
  changesClean: {
    iconName: "GitCommit",
    line: "The working tree matches HEAD.",
  },
  /// `ChangesPane` with a filter that matched nothing. Deliberately distinct
  /// from "clean": the tree is dirty, the *filter* is empty.
  changesNoMatch: {
    iconName: "SearchX",
    line: "No changed file matches this filter.",
  },
  /// `WorktreesPane` with only the main worktree.
  worktreesSingle: {
    iconName: "Boxes",
    line: "Only the main worktree exists for this repository.",
  },
  /// `StashesPane`.
  stashesEmpty: {
    iconName: "PackageOpen",
    line: "Nothing is stashed away for later.",
  },
  /// `TagsPane`.
  tagsEmpty: {
    iconName: "Tag",
    line: "This repository has no tags.",
  },
  /// `SnapshotManager`. Written in Wave 4 and registered here so the collision
  /// check covers it.
  snapshotsEmpty: {
    iconName: "Archive",
    line: "Nothing has been snapshotted in this worktree yet.",
  },
  /// `BoardSurface`, a repo whose `.voidlink/board/` holds no cards.
  boardEmpty: {
    iconName: "Columns3",
    line: "This project's board has no cards.",
  },
  /// The editor window with no file open. Owned by the editor branch and
  /// registered here for the same reason.
  editorNoFile: {
    iconName: "FileSearch",
    line: "No file open",
  },
} satisfies Record<string, EmptyStateCopy>;

export type EmptyStateId = keyof typeof EMPTY_STATES;

/// Every pair of empty states that share an icon or a sentence. Empty is the
/// only acceptable value; the test beside this file asserts it.
export function emptyStateCollisions(): string[] {
  const out: string[] = [];
  const entries = Object.entries(EMPTY_STATES) as [EmptyStateId, EmptyStateCopy][];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [aId, a] = entries[i];
      const [bId, b] = entries[j];
      if (a.iconName === b.iconName) out.push(`${aId} and ${bId} share the icon ${a.iconName}`);
      if (a.line.toLowerCase() === b.line.toLowerCase()) {
        out.push(`${aId} and ${bId} share the sentence "${a.line}"`);
      }
    }
  }
  return out;
}
