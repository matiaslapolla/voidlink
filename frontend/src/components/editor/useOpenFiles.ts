import { createSignal, onCleanup, onMount } from "solid-js";
import { editorController, type GroupSnapshot } from "./editorController";

export function useOpenFiles() {
  const [openFiles, setOpenFiles] = createSignal(editorController.getOpenFiles());
  const [activePath, setActivePath] = createSignal<string | null>(editorController.getActivePath());
  /// What each live editor group is showing. One entry unless the view is
  /// split; the surface reads it to render the second pane's inline bar and
  /// focus ring without asking the controller imperatively on every frame.
  const [groups, setGroups] = createSignal<GroupSnapshot[]>(editorController.getGroups());

  onMount(() => {
    const unsub = editorController.subscribe((files, active, groupList) => {
      setOpenFiles([...files]);
      setActivePath(active);
      setGroups([...groupList]);
    });
    onCleanup(unsub);
  });

  return { openFiles, activePath, groups };
}
