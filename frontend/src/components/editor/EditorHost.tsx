import { createEffect, onCleanup, onMount } from "solid-js";
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

    const onSave = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void editorController.saveActive();
      }
    };
    window.addEventListener("keydown", onSave);
    onCleanup(() => window.removeEventListener("keydown", onSave));
  });

  return (
    <div
      ref={containerRef}
      class={`w-full h-full overflow-hidden ${props.class ?? ""}`}
    />
  );
}
