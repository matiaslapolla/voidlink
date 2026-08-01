import { pushToast } from "@/commands/toast";
import { textPrompt } from "@/commands/prompt";
import { useActionSource, type Action } from "@/commands/registry";
import { snapshotsFor, snapshotTabCount } from "@/commands/snapshots";
import { useAppStore } from "@/store/LayoutContext";

/// Workspace snapshot palette entries, moved out of `App.tsx`'s catalog
/// (PALETTE-SRC1, `commands/registry.ts`) to beside the feature they save
/// and restore.
///
/// `onOpenSnapshots` is the one thing this module cannot get from the store —
/// it opens `App.tsx`'s `SnapshotManager` overlay, whose open/close state is
/// owned at the app root (`App()`, not `AppInner`) because it has to survive
/// `AppInner` never remounting. Passed in rather than reached for, the same
/// way `AppInner` itself receives it as a prop.
///
/// Two `registerActionSource` calls: save/manage stayed together in the
/// original array, and the per-snapshot restore rows were generated much
/// further down, after layout presets — the priorities reproduce both
/// positions.
export function registerSnapshotActions(onOpenSnapshots: () => void): void {
  const { state, actions } = useAppStore();

  useActionSource(200, (): Action[] => [
    {
      id: "snapshot.save",
      label: "Snapshot: save current as…",
      description: "Save tabs + terminals + sidebar state under a name",
      group: "Workspace",
      run: async () => {
        const name = await textPrompt({
          title: "Save snapshot",
          label: "Name this snapshot of tabs, terminals, and sidebar state",
          placeholder: "before-refactor",
          confirmLabel: "Save",
        });
        if (!name) return;
        actions.saveWorkspaceSnapshot(state.activeWorktreeId, name);
        pushToast(`Snapshot "${name}" saved`, "success");
      },
    },
    {
      id: "snapshot.manage",
      label: "Snapshot: manage saved snapshots…",
      description: "Restore, rename or delete a saved session",
      group: "Workspace",
      run: () => onOpenSnapshots(),
    },
  ]);

  // Dynamic entries — one restore per saved snapshot for the active
  // worktree. Delete and rename live in the snapshot manager: they are
  // destructive and need to be seen next to what they act on, which a
  // palette row cannot show.
  useActionSource(230, (): Action[] =>
    snapshotsFor(state.activeWorktreeId).map<Action>((snap) => ({
      id: `snapshot.restore.${snap.name}`,
      label: `Snapshot: restore "${snap.name}"`,
      description: `${snapshotTabCount(snap)} tabs`,
      group: "Workspace",
      run: async () => {
        const ok = await actions.restoreWorkspaceSnapshot(state.activeWorktreeId, snap.name);
        if (!ok) pushToast(`Snapshot "${snap.name}" not found`, "error");
        else pushToast(`Restored "${snap.name}"`, "success");
      },
    })),
  );
}
