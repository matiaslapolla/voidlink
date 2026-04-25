import { createSignal, onCleanup, onMount } from "solid-js";
import { editorController } from "./editorController";

export function useOpenFiles() {
  const [openFiles, setOpenFiles] = createSignal(editorController.getOpenFiles());
  const [activePath, setActivePath] = createSignal<string | null>(editorController.getActivePath());

  onMount(() => {
    const unsub = editorController.subscribe((files, active) => {
      setOpenFiles([...files]);
      setActivePath(active);
    });
    onCleanup(unsub);
  });

  return { openFiles, activePath };
}
