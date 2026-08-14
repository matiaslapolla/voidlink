import { render } from "solid-js/web";
import App from "./App.tsx";
import GitApp from "./GitApp.tsx";
import EditorApp from "./EditorApp.tsx";
import PanelApp from "./PanelApp.tsx";
import { initPlatform } from "@/api/platform";
import { currentPanelSidebar, isEditorWindow, isGitWindow } from "@/api/windows";
import { SIDEBAR_LABEL } from "@/components/layout/SidebarDock";
import { isSidebarId } from "@/store/layout";
import { bridgeThemeAcrossWindows } from "@/store/theme";
import { bridgeUiVisualAcrossWindows } from "@/store/settings";
import { shouldSuppressContextMenu } from "@/commands/contextMenuSuppression";
import "./index.css";

// ── Right-click belongs to the app ──────────────────────────────────────────
//
// A webview answers right-click with the browser's own menu (Reload, Inspect
// Element, autofill) unless something stops it. Installed once, here, rather
// than once per root (`App`, `GitApp`, `EditorApp`, `PanelApp`): this file is
// the one place all four already funnel through before `render()`, so a
// second copy per root would be four places to keep in sync instead of one.
//
// **The convention every surface below follows.** This is the *only* handler
// that talks to the DOM `contextmenu` event directly at the document level —
// every feature surface (a pane, a terminal, a sidebar body, the board, the
// tab strip's empty space, …) keeps its own existing per-element
// `onContextMenu={e => { e.preventDefault(); ... }}` pattern, the one
// `FileTree`, `WorkspaceRail`, `GitSidebar` and `TabStrip` already used before
// this stream, extended to the new surfaces. A surface that opens its own menu
// additionally calls `e.stopPropagation()`, so a right-click over (say) a
// terminal inside a pane opens the terminal's menu and not the pane's. This
// listener needs no registry of surfaces and no `data-*` convention to look
// up — it only ever does one thing, unconditionally: stop the browser's menu
// from reaching the screen. Whatever app menu belongs there is each surface's
// own job, same as it always was.
//
// The target/text-input predicate lives in `commands/contextMenuSuppression.ts`,
// not inline, so it is unit-testable without bootstrapping a window root.
//
// Capture phase, so it runs before any app handler and before the default
// action — a `contextmenu` event has nothing else to capture on the way down.
window.addEventListener(
  "contextmenu",
  (e) => {
    // Inspect Element is how this app is developed on itself; only production
    // suppresses.
    if (import.meta.env.DEV) return;
    if (shouldSuppressContextMenu(e.target as Element | null)) e.preventDefault();
  },
  true,
);

// One bundle serves all three windows; the Tauri window label decides which
// root mounts. Branching here rather than adding more HTML entry points keeps
// the Vite build single-page and lets every root share every module in `src/`.
//
// Resolve the platform before the first render so the window chrome (native
// macOS title bar vs. our custom one) is right on frame one instead of
// flashing the wrong shell. initPlatform never rejects.
void initPlatform().then(() => {
  const root = document.getElementById("root")!;
  // Every root, not just the satellites: the theme picker lives in the
  // workbench today but nothing about the channel assumes that, and a workbench
  // that ignored the broadcast would be the next asymmetry to debug. Installed
  // here rather than in a component because it is per *window*, and the roots
  // are the only per-window scope there is.
  bridgeThemeAcrossWindows();
  // Same per-window scope as the theme bridge just above, for the background
  // image / opacity / fit settings (`store/settings.ts`).
  bridgeUiVisualAcrossWindows();
  if (isGitWindow()) {
    document.title = "Voidlink Git";
    render(() => <GitApp />, root);
  } else if (isEditorWindow()) {
    document.title = "Voidlink Editor";
    render(() => <EditorApp />, root);
  } else if (currentPanelSidebar()) {
    // A detached sidebar. Same branch-on-the-label arrangement as the two
    // above; the label also says *which* panel, so there is one root rather
    // than one per sidebar.
    const sidebarId = currentPanelSidebar()!;
    document.title = isSidebarId(sidebarId)
      ? `Voidlink ${SIDEBAR_LABEL[sidebarId]}`
      : "Voidlink";
    render(() => <PanelApp sidebarId={sidebarId} />, root);
  } else {
    render(() => <App />, root);
  }
});
