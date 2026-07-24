import { render } from "solid-js/web";
import App from "./App.tsx";
import { initPlatform } from "@/api/platform";
import "./index.css";

// Resolve the host OS before the first paint so accelerator labels render as
// ⌘K or Ctrl+K on the very first frame instead of flipping after hydration.
// One IPC round trip; it never rejects (see initPlatform).
void initPlatform().finally(() => {
  render(() => <App />, document.getElementById("root")!);
});
