import { createEffect, onCleanup, onMount } from "solid-js";
import { editorController } from "./editorController";
import { useTheme } from "@/store/theme";
import { useSettings } from "@/store/settings";

interface EditorHostProps {
  class?: string;
}

export function EditorHost(props: EditorHostProps) {
  const { mode, theme } = useTheme();
  const { settings } = useSettings();
  let containerRef!: HTMLDivElement;

  // The store's only route into the controller. Registered in the component
  // body rather than inside `onMount`'s async callback so it exists before the
  // first `init`, and so Solid still owns it — after the first `await` there is
  // no owner and the effect would never be disposed.
  createEffect(() => {
    editorController.applyEditorSettings({ ...settings.editor });
  });

  // Registered here, not inside `onMount`: that callback is async, and after the
  // first await Solid's owner is gone, so an `onCleanup` in there would never
  // run. Unmounting really happens — in stacked mode the editor is a view, and
  // turning the mode off removes it — and `init` early-returns while an editor
  // exists, so without handing the controller back its uninitialised state the
  // next mount would attach to a detached container and render blank forever.
  onCleanup(() => editorController.dispose());

  onMount(async () => {
    await editorController.init(containerRef, mode());

    // Keep Monaco's theme in sync with the app theme. init() already applied
    // the current value; this effect handles future changes. It tracks
    // `theme()` and not just `mode()` because the eight named themes swap every
    // token without changing mode — `monokai` → `dracula` is a colour change
    // Monaco has to follow, and reading `mode()` alone would miss it.
    createEffect(() => {
      theme();
      editorController.setThemeMode(mode());
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
