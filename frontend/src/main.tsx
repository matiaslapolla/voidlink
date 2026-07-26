import { render } from "solid-js/web";
import App from "./App.tsx";
import GitApp from "./GitApp.tsx";
import { initPlatform } from "@/api/platform";
import { isGitWindow } from "@/api/gitWindow";
import "./index.css";

// One bundle serves both windows; the Tauri window label decides which root
// mounts. Branching here rather than adding a second HTML entry point keeps
// the Vite build single-page and lets both roots share every module in `src/`.
//
// Resolve the platform before the first render so the window chrome (native
// macOS title bar vs. our custom one) is right on frame one instead of
// flashing the wrong shell. initPlatform never rejects.
void initPlatform().then(() => {
  const root = document.getElementById("root")!;
  if (isGitWindow()) {
    document.title = "Voidlink Git";
    render(() => <GitApp />, root);
  } else {
    render(() => <App />, root);
  }
});
