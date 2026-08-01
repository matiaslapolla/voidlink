/// Environment mode: is voidlink one window or three?
///
/// **Detached** (the default) is the arrangement the windows were built for —
/// `main`, `git` and `editor` as separate OS windows, so they can sit on
/// separate displays or spaces. **Stacked** collapses all three into the main
/// window as three full-window views switched from the title bar, for a single
/// laptop screen where a second window is just something to hunt for.
///
/// The mode is a setting (`settings.ui.environmentMode`); the *current view* is
/// module state, kept here rather than in the layout store because it is neither
/// per-worktree nor worth persisting: a reload should land you back on the
/// workbench. Everything that used to say "open the editor window" now asks
/// `api/windows.ts`, which routes to the view switcher registered from here when
/// the mode is stacked. That is what keeps the call sites — the title bar, the
/// git sidebar, the file tree, the command palette — mode-agnostic.

import { createSignal } from "solid-js";
import { useSettings } from "@/store/settings";

export type StackedView = "workbench" | "editor" | "git";

const [stackedView, setStackedView] = createSignal<StackedView>("workbench");

export { stackedView, setStackedView };

/// Reactive: reads the settings store, so callers inside a tracking scope
/// re-run when the user flips the mode.
export function isStackedMode(): boolean {
  return useSettings().settings.ui.environmentMode === "stacked";
}

/// Which view is on screen. Always `workbench` in detached mode, where the
/// other two are windows rather than views — so a caller can ask "is the
/// workbench what the user is looking at?" without first asking which mode it
/// is in. Reactive on both the mode and the view.
export function currentStackedView(): StackedView {
  return isStackedMode() ? stackedView() : "workbench";
}

/// The view a given satellite surface belongs to, for the switcher's labels.
export const STACKED_VIEWS: { id: StackedView; label: string }[] = [
  { id: "workbench", label: "Workbench" },
  { id: "editor", label: "Editor" },
  { id: "git", label: "Git" },
];
