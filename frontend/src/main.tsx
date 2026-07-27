import { render } from "solid-js/web";
import App from "./App.tsx";
import GitApp from "./GitApp.tsx";
import EditorApp from "./EditorApp.tsx";
import { initPlatform } from "@/api/platform";
import { isEditorWindow, isGitWindow } from "@/api/windows";
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
