import { render } from "solid-js/web";
import App from "./App.tsx";
import GitApp from "./GitApp.tsx";
import EditorApp from "./EditorApp.tsx";
import { initPlatform } from "@/api/platform";
import { isEditorWindow, isGitWindow } from "@/api/windows";
import { bridgeThemeAcrossWindows } from "@/store/theme";
import { bridgeUiVisualAcrossWindows } from "@/store/settings";
import "./index.css";

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
  } else {
    render(() => <App />, root);
  }
});
