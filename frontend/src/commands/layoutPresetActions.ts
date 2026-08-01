import { pushToast } from "@/commands/toast";
import { textPrompt } from "@/commands/prompt";
import { useActionSource, type Action } from "@/commands/registry";
import { AUTO_GROUP_MODES, removePreset, renamePreset } from "@/store/layout";
import { useAppStore } from "@/store/LayoutContext";

/// Layout preset and auto-grouping palette entries, moved out of `App.tsx`'s
/// catalog (PALETTE-SRC1, `commands/registry.ts`) to beside the store module
/// (`store/layout`) that already owns presets and tab-group derivation.
///
/// Two `registerActionSource` calls: the presets stayed contiguous in the
/// original array, but the auto-group rows were registered separately,
/// after `brain.open`/`browser.new` — the priorities reproduce both
/// positions.
export function registerLayoutPresetActions(): void {
  const { state, actions } = useAppStore();

  // An *arrangement*, recalled by name: the pane tree, the tab groups, each
  // pane's front tab and the three panel widths. Distinct from a snapshot,
  // which is a whole session — applying a preset opens and closes nothing, it
  // rearranges whatever is already there.
  useActionSource(210, (): Action[] => [
    {
      id: "layout.preset.save",
      label: "Layout: save arrangement as…",
      description: "Panes, tab groups and panel widths — no tab contents",
      group: "Workspace",
      run: async () => {
        const name = await textPrompt({
          title: "Save layout preset",
          label: "Name this arrangement of panes, tab groups and panel widths",
          placeholder: "review",
          confirmLabel: "Save",
        });
        if (!name) return;
        if (actions.saveLayoutPreset(state.activeWorktreeId, name)) {
          pushToast(`Layout "${name}" saved`, "success");
        }
      },
    },
    // Three rows per preset, generated from user data. Apply is the common
    // one; rename and delete sit beside it rather than in a manager of their
    // own, because a preset has nothing to show next to itself the way a
    // snapshot's tab list does.
    ...actions.layoutPresets().flatMap<Action>((preset) => [
      {
        id: `layout.preset.apply.${preset.name}`,
        label: `Layout: apply "${preset.name}"`,
        description: "Rearrange the open tabs into this arrangement",
        group: "Workspace",
        run: () => {
          if (actions.applyLayoutPreset(state.activeWorktreeId, preset.name)) {
            pushToast(`Applied "${preset.name}"`, "success");
          } else {
            pushToast(`Layout "${preset.name}" not found`, "error");
          }
        },
      },
      {
        id: `layout.preset.rename.${preset.name}`,
        label: `Layout: rename "${preset.name}"…`,
        group: "Workspace",
        run: async () => {
          const next = await textPrompt({
            title: "Rename layout preset",
            label: `New name for "${preset.name}"`,
            initialValue: preset.name,
            confirmLabel: "Rename",
          });
          if (!next) return;
          const result = renamePreset(state.activeWorkspaceId, preset.name, next);
          if (result === "ok") pushToast(`Renamed to "${next.trim()}"`, "success");
          else if (result === "duplicate") pushToast("A layout with that name exists", "error");
          else if (result === "empty-name") pushToast("A layout needs a name", "error");
          else pushToast(`Layout "${preset.name}" not found`, "error");
        },
      },
      {
        id: `layout.preset.delete.${preset.name}`,
        label: `Layout: delete "${preset.name}"`,
        group: "Workspace",
        run: () => {
          removePreset(state.activeWorkspaceId, preset.name);
          pushToast(`Deleted "${preset.name}"`, "info");
        },
      },
    ]),
  ]);

  // ── Auto-grouping ──────────────────────────────────────────────────
  // Derived tab groups. Read-only by construction: the first hand-edit of
  // one materialises the derivation and drops the worktree back to `off`,
  // so the rule never undoes the user.
  useActionSource(220, (): Action[] =>
    AUTO_GROUP_MODES.map<Action>((mode) => ({
      id: `layout.autogroup.${mode}`,
      label:
        mode === "off"
          ? "Tab groups: manual"
          : `Tab groups: group by ${mode === "kind" ? "kind" : "worktree"}`,
      description:
        mode === "off"
          ? "Group tabs by hand"
          : "Derive tab groups automatically; editing one switches back to manual",
      group: "View",
      enabled: () => actions.autoGroupMode(state.activeWorktreeId) !== mode,
      run: () => actions.setAutoGroupMode(state.activeWorktreeId, mode),
    })),
  );
}
