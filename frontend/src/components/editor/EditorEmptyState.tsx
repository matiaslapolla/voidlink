/// "No file open", and the two keys that fix it.
///
/// MASTER §9.7 asks for a distinct icon and copy per reason so the states are
/// tellable apart: the *no repository* state in this window uses `FileCode` and
/// talks about the workbench; this one uses `FileSearch` and talks about files,
/// because the difference between "you have no repo" and "you have a repo and
/// nothing open" is the difference between two completely different next
/// actions.
///
/// The accelerators are rendered from the keymap (`primaryChordFor` →
/// `formatChord`), not typed as prose. That is the same derivation the command
/// palette and the cheat sheet use, so an empty state cannot end up advertising
/// a chord that was rebound out from under it — and a user reading `⌘P` in a
/// `<kbd>` learns a key, where "use the file finder" teaches nothing.

import { For, Show } from "solid-js";
import { FileSearch } from "lucide-solid";
import { isMac } from "@/api/platform";
import { formatChord } from "@/commands/keys";
import { primaryChordFor } from "@/commands/keymap";

interface Path {
  actionId: string;
  what: string;
}

const PATHS: Path[] = [
  { actionId: "file.open", what: "open a file" },
  { actionId: "file.new", what: "new file" },
];

export function EditorEmptyState() {
  const paths = () =>
    PATHS.map((p) => ({ ...p, chord: primaryChordFor(p.actionId) })).filter(
      // A path with no chord is not a keyboard path. Rendering it as one would
      // be the prose this state exists to avoid.
      (p): p is Path & { chord: NonNullable<ReturnType<typeof primaryChordFor>> } =>
        p.chord !== undefined,
    );

  return (
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground z-10">
      <FileSearch class="w-5 h-5 opacity-60" aria-hidden="true" />
      <p class="text-[13px]">No file open</p>
      <Show when={paths().length > 0}>
        <ul class="flex items-center gap-4 text-[11px]">
          <For each={paths()}>
            {(p) => (
              <li class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 rounded border border-border bg-accent/30 font-mono text-[11px] text-foreground">
                  {formatChord(p.chord, isMac())}
                </kbd>
                <span>{p.what}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
