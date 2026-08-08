/// A pane's right-click menu (Stream D) — split right, split down, close
/// pane, reset the layout — as a pure row builder over already-resolved
/// action state, for the same reason `statusSegments.ts`'s `statusBarMenuItems`
/// is separate from `StatusBar.tsx`: whether a row is disabled, and why, is
/// data in, data out, and testable without mounting `MainSurface`'s pane tree
/// (the registry, the store, every nested tab kind) just to check a label.
import type { ContextMenuItem } from "@/components/git/ContextMenu";

export interface PaneMenuActions {
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClosePane: () => void;
  /// `false` when the store's own `ui.close-pane` action would refuse this
  /// (the last pane can't be closed).
  canClosePane: boolean;
  onResetLayout: () => void;
  /// `false` when there is only one pane, so nothing to reset.
  canResetLayout: boolean;
}

export function paneMenuItems(actions: PaneMenuActions): ContextMenuItem[] {
  return [
    { label: "Split right", onSelect: actions.onSplitRight },
    { label: "Split down", onSelect: actions.onSplitDown },
    {
      label: "Close pane",
      separatorBefore: true,
      disabledReason: actions.canClosePane ? undefined : "The last pane can't be closed",
      onSelect: actions.onClosePane,
    },
    {
      label: "Reset the pane layout",
      disabledReason: actions.canResetLayout ? undefined : "Only one pane is open",
      onSelect: actions.onResetLayout,
    },
  ];
}
