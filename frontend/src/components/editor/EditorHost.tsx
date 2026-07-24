import { createEffect, onMount } from "solid-js";
import { editorController } from "./editorController";
import { useTheme } from "@/store/theme";

interface EditorHostProps {
  class?: string;
}

export function EditorHost(props: EditorHostProps) {
  const { mode } = useTheme();
  let containerRef!: HTMLDivElement;

  onMount(async () => {
    const theme = mode() === "light" ? "vs" : "vs-dark";
    await editorController.init(containerRef, theme);

    // Keep Monaco's theme in sync with the app theme. init() already
    // applied the current value; this effect handles future toggles.
    createEffect(() => {
      editorController.setTheme(mode() === "light" ? "vs" : "vs-dark");
    });

    // Save is not handled here. ⌘S / Ctrl+S is a `file.save` entry in
    // `commands/keymap.ts` — feature components own no key handling, and
    // routing it through the keymap is what lets the binding be scoped away
    // from terminal panes, where Ctrl+S still has to mean XOFF.
  });

  return (
    <div
      ref={containerRef}
      class={`w-full h-full overflow-hidden ${props.class ?? ""}`}
    />
  );
}
