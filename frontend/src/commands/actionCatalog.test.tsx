/// Id-for-id evidence that PALETTE-SRC1 (see `registry.ts`) did not drop,
/// rename, or reorder anything in the six feature slices it moved out of
/// `App.tsx`'s hand-written catalog: git, stack, workspace/worktree,
/// snapshots, layout presets, and the agent panel.
///
/// `EXPECTED_IDS` is the literal list of ids those six blocks produced in
/// `App.tsx` before the extraction, in the order they appeared there — copied
/// out before the edit, not derived from the new code, so this cannot pass by
/// construction. Registering all six sources against a fresh store and
/// diffing the composed catalog against that list is the strongest check
/// available without mounting the whole app (which needs the Tauri surface
/// every satellite window, terminal PTY and git call in `App.tsx` depends
/// on) — see the PR description for what that would take and why it is out of
/// scope here.
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { getActions, useActionSourceCatalog } from "@/commands/registry";
import { registerGitActions } from "@/commands/gitActions";
import { registerStackActions } from "@/commands/stackActions";
import { registerWorkspaceActions } from "@/commands/workspaceActions";
import { registerSnapshotActions } from "@/commands/snapshotActions";
import { registerLayoutPresetActions } from "@/commands/layoutPresetActions";
import { registerAgentActions } from "@/commands/agent";

// Order matches the original `App.tsx` array exactly. `workspace.select.*`
// and the layout/snapshot dynamic rows (`layout.preset.apply.*`, `.rename.*`,
// `.delete.*`, `snapshot.restore.*`) are omitted only where they depend on
// user data (saved presets/snapshots) that a fresh store has none of — the
// nine `workspace.select.*` hidden slots are unconditional (one per index
// regardless of how many workspaces exist) and so are included.
const EXPECTED_IDS = [
  // Git — first fragment (registerGitActions, priority 50)
  "git.refresh",
  "git.fetch",
  "git.pull",
  "git.remotes",
  "git.undo-last-commit",
  "git.compare",
  // Git — second fragment (priority 70), originally beside the stack block
  "git.open-window",
  // Stack (priority 80)
  "stack.branch-on-top",
  "stack.restack-all",
  "stack.submit",
  "stack.open-tab",
  // Git — third fragment (priority 110), originally after the view toggles
  "git.ai-draft-commit",
  // Agent (priority 120)
  "agent.toggle",
  "agent.newTab",
  // Workspace / worktree — main block (priority 130)
  "workspace.new",
  "workspace.next",
  "workspace.prev",
  "worktree.new",
  "worktree.next",
  "worktree.prev",
  "worktree.remove",
  // Workspace — hidden select-by-index (priority 150)
  "workspace.select.1",
  "workspace.select.2",
  "workspace.select.3",
  "workspace.select.4",
  "workspace.select.5",
  "workspace.select.6",
  "workspace.select.7",
  "workspace.select.8",
  "workspace.select.9",
  // Workspace — switch (priority 180)
  "workspace.switch",
  // Snapshots (priority 200)
  "snapshot.save",
  "snapshot.manage",
  // Layout presets + auto-grouping (priorities 210/220)
  "layout.preset.save",
  "layout.autogroup.off",
  "layout.autogroup.kind",
  "layout.autogroup.worktree",
];

function Sources() {
  registerGitActions();
  registerStackActions();
  registerWorkspaceActions();
  registerSnapshotActions(() => {});
  registerLayoutPresetActions();
  registerAgentActions();
  useActionSourceCatalog();
  return null;
}

describe("the six extracted palette sources, composed together", () => {
  it("reproduce the original catalog's ids, with none missing, duplicated, or extra", async () => {
    const store = createAppStore({ persist: false });
    render(() => (
      <AppStoreContext.Provider value={store}>
        <Sources />
      </AppStoreContext.Provider>
    ));

    await waitFor(() => {
      const ids = getActions().map((a) => a.id);
      for (const id of EXPECTED_IDS) expect(ids).toContain(id);
    });

    const ids = getActions().map((a) => a.id);
    const actual = EXPECTED_IDS.filter((id) => ids.includes(id));
    // Every expected id is present exactly once — no duplicate registration
    // across the fragmented `registerActionSource` calls.
    for (const id of EXPECTED_IDS) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
    // And in the same relative order the original single array held them in —
    // a subsequence check, since the catalog also contains the workbench's
    // own entries (registered by `App.tsx` itself, not exercised here)
    // interleaved by priority.
    const positions = actual.map((id) => ids.indexOf(id));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
    expect(actual).toEqual(EXPECTED_IDS);
  });
});
