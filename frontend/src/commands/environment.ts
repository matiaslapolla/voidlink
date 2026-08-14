/// Environment mode: is voidlink one window or three?
///
/// **Detached** (the default) is the arrangement the windows were built for —
/// `main`, `git` and `editor` as separate OS windows, so they can sit on
/// separate displays or spaces. **Stacked** collapses all three into the main
/// window as three full-window views switched from the title bar, for a single
/// laptop screen where a second window is just something to hunt for.
/// **Docked** answers the same single-screen problem one layer in: the windows
/// stay windows, but the workbench's own five sidebars collapse into a floating
/// strip pinned to one edge (`components/layout/DockStrip.tsx`), with at most
/// one of them expanded at a time. Stacked reclaims *windows*; docked reclaims
/// the two or three columns of chrome that stand between you and the code.
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
///
/// **Read this as "stacked *specifically*", not as "not detached".** Every
/// caller was audited when `docked` landed as a third member, because a
/// two-valued union makes the two readings indistinguishable and one of them
/// was about to become wrong:
///
///   • `App.tsx`'s view router and its `<Show>` around the editor/git views,
///     `TitleBar`'s view switcher, and `sidebarDockMenuItems`'s "this
///     environment shows the other surfaces as views" `disabledReason` all mean
///     *stacked specifically*. Docked mode keeps the satellites as windows, so
///     it must not grow a switcher for views that do not exist — and detaching
///     a sidebar stays available there.
///   • `App.tsx`'s two sidebar-window shortcut predicates and the scope it
///     hands `validateKeymap` all meant *not stacked* — "are there windows to
///     bind against". They read `isWindowedMode()` below now, so a third mode
///     could not silently flip them by not being `"stacked"`.
export function isStackedMode(): boolean {
  return useSettings().settings.ui.environmentMode === "stacked";
}

/// The dock strip: one window, satellites still as windows, and the five
/// sidebars collapsed into a floating strip pinned to an edge.
///
/// A sibling of `isStackedMode` rather than a flag inside it. Stacked answers
/// "where do the git client and the editor live"; docked answers "how does the
/// workbench show its own five panels". They are orthogonal questions that
/// happen to share one setting today, and naming them separately is what keeps
/// a caller from asking one and getting the other.
export function isDockedMode(): boolean {
  return useSettings().settings.ui.environmentMode === "docked";
}

/// Whether the satellite surfaces are OS windows in this mode. True for
/// `detached` and for `docked`; false only for `stacked`, which hosts them as
/// views. This is the "not stacked" half of the audit above, stated as the
/// question the call sites actually ask.
export function isWindowedMode(): boolean {
  return !isStackedMode();
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
