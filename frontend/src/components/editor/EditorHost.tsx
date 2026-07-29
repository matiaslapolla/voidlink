import { createEffect, onCleanup, onMount } from "solid-js";
import { editorController } from "./editorController";
import type { GroupId } from "./editorGroups";
import { useTheme } from "@/store/theme";
import { useSettings } from "@/store/settings";

interface EditorHostProps {
  class?: string;
  /// Which editor group this host owns. One host per group; omitted means the
  /// single-group default, which is the only case that existed before splits.
  groupId?: GroupId;
  /// File to show once this group's editor exists. Only meaningful for a group
  /// created by a split — the primary group's content comes from `reconcile`.
  seedPath?: () => string | null;
}

export function EditorHost(props: EditorHostProps) {
  const { mode, theme } = useTheme();
  const { settings } = useSettings();
  const groupId = () => props.groupId ?? "primary";
  let containerRef!: HTMLDivElement;

  // The store's only route into the controller. Registered in the component
  // body rather than inside `onMount`'s async callback so it exists before the
  // first `init`, and so Solid still owns it — after the first `await` there is
  // no owner and the effect would never be disposed.
  //
  // Every host runs this; the call is idempotent and pushes to *all* groups, so
  // a second host costs one redundant `updateOptions` and buys not having to
  // decide which host is the privileged one.
  createEffect(() => {
    editorController.applyEditorSettings({ ...settings.editor });
  });

  // Vim mode is attached separately from the options above: it is not an
  // `updateOptions` key but a keydown adapter over the editor, and it has to
  // wait for the editor to exist. Toggling it off disposes the adapter — no
  // reload, and no `monaco-vim` chunk fetched for anyone who leaves it off.
  // The controller decides *which* editor it lands on, because that follows
  // group focus rather than the host that happened to ask.
  createEffect(() => {
    const on = settings.editor.vimMode;
    void editorController.setVimMode(on);
  });

  // Keep Monaco's theme in sync with the app theme.
  //
  // In the component body for the same reason as the two effects above, and it
  // matters more here: created inside `onMount`'s async callback (after `init`
  // and `showInGroup`) this had no owner, so it leaked one subscription per
  // mount cycle *and* — because `init` can reject — was sometimes never created
  // at all, leaving that window unable to follow a theme change for the rest of
  // the session. That is the "the editor keeps the old theme" report.
  //
  // It tracks `theme()` and not just `mode()` because the eight named themes
  // swap every token without changing mode — `monokai` → `dracula` is a colour
  // change Monaco has to follow, and reading `mode()` alone would miss it.
  //
  // Running before Monaco exists is fine: `setThemeMode` no-ops without it, and
  // `init` applies the current theme itself before the first `create`.
  createEffect(() => {
    theme();
    editorController.setThemeMode(mode());
  });

  // Registered here, not inside `onMount`: that callback is async, and after the
  // first await Solid's owner is gone, so an `onCleanup` in there would never
  // run. Unmounting really happens — in stacked mode the editor is a view, and
  // turning the mode off removes it — and `init` early-returns while that group
  // has an editor, so without handing the controller back its uninitialised
  // state the next mount would attach to a detached container and render blank
  // forever. Disposing the *last* group is also what detaches Vim and drops the
  // models; closing one pane of a split leaves both alone.
  onCleanup(() => editorController.disposeGroup(groupId()));

  onMount(async () => {
    // `mode` goes in as an accessor: `init` awaits the Monaco chunk before it
    // reads the theme, and a value snapshotted here would be stale by then.
    await editorController.init(containerRef, mode, groupId());

    const seed = props.seedPath?.() ?? null;
    if (seed) await editorController.showInGroup(groupId(), seed);

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
