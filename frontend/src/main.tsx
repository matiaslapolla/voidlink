import { render } from "solid-js/web";
import App from "./App.tsx";
import { initPlatform } from "@/api/platform";
import "./index.css";

// Resolve the platform before the first render so the window chrome (native
// macOS title bar vs. our custom one) is right on frame one instead of
// flashing the wrong shell. initPlatform never rejects.
void initPlatform().then(() => {
  render(() => <App />, document.getElementById("root")!);
});
